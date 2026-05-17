import { defineStore } from "pinia";
import { api } from "@/api/client";
import { useWorkspaceStore } from "./workspace";

export interface ToolCall {
  id: string;
  name: string;
  input?: unknown;
  result?: unknown;
  status: "running" | "ok" | "error";
}

export type ChartSnapshot = {
  chart_type: string;
  chart_mode: string;
  chart_config: Record<string, unknown>;
  chart_python_code: string | null;
};

export type Proposal =
  | {
      kind: "query_edit";
      query_id: number;
      rationale?: string;
      before: { name: string; sql: string };
      after: { name: string; sql: string };
    }
  | {
      kind: "chart_change";
      query_id: number;
      query_name: string;
      rationale?: string;
      before: ChartSnapshot;
      after: ChartSnapshot;
    }
  | {
      kind: "new_query";
      rationale?: string;
      query: {
        name: string; sql: string; connection_id: number; folder_id: number | null;
        chart_type: string; chart_config: Record<string, unknown>;
        chart_mode: string; chart_python_code: string | null;
      };
    }
  | {
      kind: "delete_query";
      query_id: number;
      rationale?: string;
      target: { name: string; sql: string };
    };

export interface ProposalRecord {
  id: string;
  proposal: Proposal;
  status: "pending" | "accepted" | "rejected" | "auto-accepted" | "error";
  error?: string;
  // Filled in once the proposal has been applied:
  resultId?: number;
}

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking: string;
  thinkingExpanded: boolean;
  toolCalls: ToolCall[];
  toolsAggregated: boolean;
  toolsExpanded: boolean;
  status: "streaming" | "done" | "error" | "stopped";
  error?: string;
  proposals: ProposalRecord[];
}

const AUTO_ACCEPT_KEY = "nicemeta.chat.autoAccept";

interface ConversationSummary {
  id: number;
  title: string;
  updated_at: number;
}

let nextId = 1;
let activeController: AbortController | null = null;

export const useChatStore = defineStore("chat", {
  state: () => ({
    conversationId: null as number | null,
    conversations: [] as ConversationSummary[],
    turns: [] as ChatTurn[],
    sending: false,
    showThinking: true,
    // When on, every proposal is applied automatically as soon as the agent
    // emits it (no Accept click). Persisted per-browser.
    autoAccept: localStorage.getItem(AUTO_ACCEPT_KEY) === "1",
  }),
  actions: {
    async loadConversations() {
      this.conversations = await api.get<ConversationSummary[]>("/chat/conversations");
    },
    async openConversation(id: number) {
      const data = await api.get<{ id: number; title: string; messages: unknown[] }>(
        `/chat/conversations/${id}`,
      );
      this.conversationId = data.id;
      this.turns = [];
      // Replay history minimally — we only show the textual exchange.
      for (const m of data.messages as Array<{ role: string; content: unknown }>) {
        if (m.role === "user" && typeof m.content === "string") {
          this.turns.push(this.makeTurn("user", m.content));
        } else if (m.role === "assistant" && Array.isArray(m.content)) {
          const text = (m.content as Array<{ type: string; text?: string }>)
            .filter((b) => b.type === "text")
            .map((b) => b.text ?? "")
            .join("\n");
          const turn = this.makeTurn("assistant", text);
          turn.status = "done";
          this.turns.push(turn);
        }
      }
    },
    newConversation() {
      this.conversationId = null;
      this.turns = [];
    },
    makeTurn(role: "user" | "assistant", text = ""): ChatTurn {
      return {
        id: String(nextId++),
        role,
        text,
        thinking: "",
        thinkingExpanded: false,
        toolCalls: [],
        toolsAggregated: false,
        toolsExpanded: false,
        status: role === "assistant" ? "streaming" : "done",
        proposals: [],
      };
    },
    setAutoAccept(on: boolean) {
      this.autoAccept = on;
      localStorage.setItem(AUTO_ACCEPT_KEY, on ? "1" : "0");
    },
    async send(message: string) {
      if (!message.trim() || this.sending) return;
      this.sending = true;
      this.turns.push(this.makeTurn("user", message));
      const assistant = this.makeTurn("assistant");
      this.turns.push(assistant);

      const controller = new AbortController();
      activeController = controller;
      try {
        const stream = api.stream(
          "/chat/send",
          {
            conversation_id: this.conversationId,
            message,
            thinking: this.showThinking,
          },
          { signal: controller.signal },
        );
        for await (const evt of stream) {
          this.handleEvent(assistant, evt);
        }
        if (assistant.status === "streaming") assistant.status = "done";
        this.detectProposal(assistant);
      } catch (err) {
        const e = err as Error;
        if (e.name === "AbortError" || controller.signal.aborted) {
          assistant.status = "stopped";
          if (!assistant.text) assistant.text = "_(stopped)_";
        } else {
          assistant.status = "error";
          assistant.error = e.message;
        }
      } finally {
        this.sending = false;
        if (activeController === controller) activeController = null;
        // Drip continues after the network closes so the user sees the tail
        // of the text type out; we only force-stop the timer when it's empty
        // or the turn moved into a terminal status.
        await this.loadConversations();
      }
    },
    stop() {
      activeController?.abort();
    },
    handleEvent(turn: ChatTurn, evt: { event: string; data: unknown }) {
      const d = evt.data as Record<string, unknown>;
      switch (evt.event) {
        case "user_saved":
          if (typeof d.conversation_id === "number") this.conversationId = d.conversation_id;
          break;
        case "thinking_delta":
          turn.thinking += String(d.text ?? "");
          break;
        case "text_delta":
          turn.text += String(d.text ?? "");
          break;
        case "tools_running":
          turn.toolsAggregated = Boolean(d.aggregated);
          break;
        case "tool_call":
          turn.toolCalls.push({
            id: String(d.id),
            name: String(d.name),
            input: d.input,
            status: "running",
          });
          break;
        case "tool_result": {
          const id = String(d.id);
          const call = turn.toolCalls.find((c) => c.id === id);
          if (call) {
            call.result = d.result;
            const r = d.result as { error?: unknown; success?: unknown; proposal?: Proposal } | undefined;
            call.status = r?.error || r?.success === false ? "error" : "ok";
            this.applyToolSideEffects(call);
            if (r?.proposal) {
              const record: ProposalRecord = {
                id: `${turn.id}-${id}`,
                proposal: r.proposal,
                status: "pending",
              };
              turn.proposals.push(record);
              if (this.autoAccept) {
                // fire and forget — UI still shows result/error
                this.acceptProposal(turn.id, record.id).catch(() => {});
              }
            }
          }
          break;
        }
        case "done":
          if (typeof d.conversation_id === "number") this.conversationId = d.conversation_id;
          break;
        case "error":
          turn.status = "error";
          turn.error = String(d.error ?? "unknown error");
          break;
      }
    },
    async acceptProposal(turnId: string, proposalId: string) {
      const turn = this.turns.find((t) => t.id === turnId);
      const rec = turn?.proposals.find((p) => p.id === proposalId);
      if (!turn || !rec || rec.status !== "pending") return;
      const auto = this.autoAccept;
      const ws = useWorkspaceStore();
      try {
        const p = rec.proposal;
        if (p.kind === "query_edit") {
          await api.put(`/queries/${p.query_id}`, { name: p.after.name, sql: p.after.sql });
          rec.resultId = p.query_id;
        } else if (p.kind === "chart_change") {
          await api.put(`/queries/${p.query_id}`, {
            chart_type: p.after.chart_type,
            chart_mode: p.after.chart_mode,
            chart_config: p.after.chart_config,
            chart_python_code: p.after.chart_python_code,
          });
          rec.resultId = p.query_id;
        } else if (p.kind === "new_query") {
          const created = await api.post<{ id: number }>("/queries", p.query);
          rec.resultId = created.id;
        } else if (p.kind === "delete_query") {
          await api.del(`/queries/${p.query_id}`);
          rec.resultId = p.query_id;
        }
        rec.status = auto ? "auto-accepted" : "accepted";
        ws.invalidateCache(rec.resultId);
        await ws.loadSavedQueries();
      } catch (err) {
        rec.status = "error";
        rec.error = (err as Error).message;
      }
    },
    rejectProposal(turnId: string, proposalId: string) {
      const turn = this.turns.find((t) => t.id === turnId);
      const rec = turn?.proposals.find((p) => p.id === proposalId);
      if (!rec || rec.status !== "pending") return;
      rec.status = "rejected";
    },
    applyToolSideEffects(call: ToolCall) {
      const ws = useWorkspaceStore();
      const result = call.result as Record<string, unknown> | undefined;
      if (!result) return;
      if (call.name === "execute_sql" && result.success) {
        ws.result = {
          success: true,
          columns: (result.columns as string[]) ?? [],
          rows: (result.rows as unknown[][]) ?? [],
          row_count: (result.row_count as number) ?? 0,
          execution_time_ms: (result.execution_time_ms as number) ?? 0,
        };
      } else if ((call.name === "render_chart" || call.name === "run_python") && result.success) {
        const spec = result.spec as { data?: unknown[]; layout?: Record<string, unknown> } | undefined;
        if (spec && spec.data) {
          ws.setChart({ data: spec.data, layout: spec.layout ?? {} });
        }
      }
    },
    detectProposal(turn: ChatTurn) {
      const match = turn.text.match(/```sql[^\n]*\n([\s\S]*?)```/);
      if (match && /-- proposed/i.test(match[0])) {
        const ws = useWorkspaceStore();
        ws.proposeSql(match[1]!.trim());
      }
    },
  },
});
