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

export interface ChatTurn {
  id: string;
  role: "user" | "assistant";
  text: string;
  thinking: string;
  thinkingExpanded: boolean;
  toolCalls: ToolCall[];
  toolsAggregated: boolean;
  toolsExpanded: boolean;
  status: "streaming" | "done" | "error";
  error?: string;
}

interface ConversationSummary {
  id: number;
  title: string;
  updated_at: number;
}

let nextId = 1;

export const useChatStore = defineStore("chat", {
  state: () => ({
    conversationId: null as number | null,
    conversations: [] as ConversationSummary[],
    turns: [] as ChatTurn[],
    sending: false,
    showThinking: true,
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
      };
    },
    async send(message: string) {
      if (!message.trim() || this.sending) return;
      this.sending = true;
      this.turns.push(this.makeTurn("user", message));
      const assistant = this.makeTurn("assistant");
      this.turns.push(assistant);

      try {
        const stream = api.stream("/chat/send", {
          conversation_id: this.conversationId,
          message,
          thinking: this.showThinking,
        });
        for await (const evt of stream) {
          this.handleEvent(assistant, evt);
        }
        if (assistant.status !== "error") assistant.status = "done";
        this.detectProposal(assistant);
      } catch (err) {
        assistant.status = "error";
        assistant.error = (err as Error).message;
      } finally {
        this.sending = false;
        if (this.conversationId) await this.loadConversations();
      }
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
            const r = d.result as { error?: unknown; success?: unknown } | undefined;
            call.status = r?.error || r?.success === false ? "error" : "ok";
            this.applyToolSideEffects(call);
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
