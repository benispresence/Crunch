import { defineStore } from "pinia";
import { api } from "@/api/client";
import { router } from "@/router";
import { useDashboardsStore } from "./dashboards";
import { usePipelinesStore } from "./pipelines";
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

export interface DashboardFilterSpec {
  id: string;
  name: string;
  type: string;
  default?: unknown;
}

export interface AddWidgetSpec {
  query_id: number;
  query_name: string;
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  title_override: string | null;
  parameter_mappings: Record<string, string>;
}

/** Connection-side of a query edit. Both the "before" and "after"
 *  sides carry the same shape: id can be null (an unbound query) and
 *  name comes along for the diff card so it can show
 *  "Postgres prod → Snowflake warehouse" without a second lookup. */
export interface QueryConnectionRef {
  id: number | null;
  name: string | null;
}

export interface BulkQueryEditChange {
  query_id: number;
  query_name: string;
  before: { name: string; sql: string; connection: QueryConnectionRef };
  after: { name: string; sql: string; connection: QueryConnectionRef };
  has_sql_change: boolean;
  has_name_change: boolean;
  has_connection_change: boolean;
}

export type Proposal =
  | {
      kind: "query_edit";
      query_id: number;
      rationale?: string;
      before: { name: string; sql: string; connection?: QueryConnectionRef };
      after: { name: string; sql: string; connection?: QueryConnectionRef };
    }
  | {
      kind: "bulk_query_edit";
      rationale?: string;
      changes: BulkQueryEditChange[];
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
    }
  | {
      kind: "new_dashboard";
      rationale?: string;
      dashboard: {
        name: string;
        description: string | null;
        folder_id: number | null;
        widgets: Array<{
          query_id: number;
          position_x: number;
          position_y: number;
          width: number;
          height: number;
          title_override: string | null;
        }>;
        filters: DashboardFilterSpec[];
      };
    }
  | {
      kind: "add_widget";
      dashboard_id: number;
      dashboard_name: string;
      rationale?: string;
      widget: AddWidgetSpec;
    }
  | {
      kind: "remove_widget";
      dashboard_id: number;
      dashboard_name: string;
      widget_id: number;
      widget_name: string;
      rationale?: string;
    }
  | {
      kind: "dashboard_filter_change";
      dashboard_id: number;
      dashboard_name: string;
      rationale?: string;
      before: DashboardFilterSpec[];
      after: DashboardFilterSpec[];
    }
  | {
      kind: "widget_mapping";
      dashboard_id: number;
      dashboard_name: string;
      widget_id: number;
      widget_name: string;
      rationale?: string;
      before: Record<string, string>;
      after: Record<string, string>;
    }
  | {
      kind: "navigate";
      to: "workspace" | "dashboard" | "pipeline" | "pipelines";
      query_id?: number;
      dashboard_id?: number;
      pipeline_id?: number;
      rationale?: string;
    }
  | {
      kind: "new_pipeline";
      rationale?: string;
      pipeline: {
        name: string;
        description: string | null;
        source_type: string;
        source_config: Record<string, unknown>;
        destination_connection_id: number | null;
        destination_dataset: string | null;
        load_mode: string;
        primary_key: string | null;
        cursor_field: string | null;
        schedule: string | null;
        schedule_enabled: boolean;
        python_code: string;
        code_mode: string;
      };
    }
  | {
      kind: "pipeline_edit";
      pipeline_id: number;
      pipeline_name: string;
      rationale?: string;
      before: Record<string, unknown>;
      after: Record<string, unknown>;
    }
  | {
      kind: "run_pipeline";
      pipeline_id: number;
      pipeline_name: string;
      rationale?: string;
    }
  | {
      kind: "delete_pipeline";
      pipeline_id: number;
      pipeline_name: string;
      rationale?: string;
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
  getters: {
    /**
     * The first not-yet-resolved proposal across the whole conversation.
     * Panels (SqlEditor / ChartPanel / WorkspaceView) read this so the UI
     * can collapse to the relevant editor, show a diff banner, and offer
     * inline Accept/Reject.
     */
    activeProposal(state): { turnId: string; record: ProposalRecord } | null {
      for (const turn of state.turns) {
        for (const rec of turn.proposals) {
          if (rec.status === "pending") return { turnId: turn.id, record: rec };
        }
      }
      return null;
    },
  },
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
      this.turns.push(this.makeTurn("assistant"));
      // Critical: re-fetch via index so we get the reactive Pinia proxy,
      // not the raw object reference. Mutations on the raw reference are
      // invisible to Vue's render tracking and the UI sits on 3 dots
      // forever.
      const assistantIdx = this.turns.length - 1;
      const assistant = this.turns[assistantIdx]!;

      const controller = new AbortController();
      activeController = controller;
      try {
        // Snapshot what the user is currently editing so the agent can
        // talk about "this query" without asking.
        const ws = useWorkspaceStore();
        const activeQuery = ws.activeQueryId == null
          ? null
          : ws.savedQueries.find((q) => q.id === ws.activeQueryId) ?? null;
        const activeConn = ws.activeConnectionId == null
          ? null
          : ws.connections.find((c) => c.id === ws.activeConnectionId) ?? null;
        const unsaved = !!activeQuery && (
          activeQuery.sql !== ws.sql ||
          activeQuery.chart_type !== ws.chartType ||
          activeQuery.chart_mode !== ws.chartMode ||
          (activeQuery.chart_python_code ?? "") !== (ws.pythonCode ?? "") ||
          JSON.stringify(activeQuery.chart_config ?? {}) !== JSON.stringify(ws.chartConfig ?? {})
        );
        const dashboards = useDashboardsStore();
        const route = router.currentRoute.value;
        const activeDashboard = dashboards.current;
        const workspace = {
          active_route: route.name as string | undefined,
          active_query_id: ws.activeQueryId,
          active_query_name: activeQuery?.name ?? null,
          active_connection_id: ws.activeConnectionId,
          active_connection_name: activeConn?.name ?? null,
          active_dashboard_id: activeDashboard?.id ?? null,
          active_dashboard_name: activeDashboard?.name ?? null,
          current_sql: ws.sql,
          current_chart_type: ws.chartType,
          current_chart_mode: ws.chartMode,
          current_chart_config: ws.chartConfig,
          current_python_code: ws.pythonCode || null,
          has_unsaved_changes: unsaved,
          last_result_columns: ws.result?.columns ?? undefined,
          last_result_row_count: ws.result?.row_count,
        };
        const stream = api.stream(
          "/chat/send",
          {
            conversation_id: this.conversationId,
            message,
            thinking: this.showThinking,
            workspace,
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
      const dashboards = useDashboardsStore();
      try {
        const p = rec.proposal;
        if (p.kind === "query_edit") {
          // Only send fields that actually changed. Connection
          // retarget can ride alone — the backend leaves SQL/name
          // untouched when we omit them, so a pure "repoint" doesn't
          // re-trigger a chart cache invalidation.
          const body: Record<string, unknown> = {};
          if (p.after.name !== p.before.name) body.name = p.after.name;
          if (p.after.sql !== p.before.sql) body.sql = p.after.sql;
          if (
            p.after.connection
            && p.before.connection
            && p.after.connection.id !== p.before.connection.id
          ) {
            body.connection_id = p.after.connection.id;
          }
          await api.put(`/queries/${p.query_id}`, body);
          rec.resultId = p.query_id;
        } else if (p.kind === "bulk_query_edit") {
          // Iterate. We could parallelise via Promise.all but per-row
          // sequencing keeps the error story simple — if row 7 fails
          // the user knows exactly which one and which weren't tried.
          const applied: number[] = [];
          for (const ch of p.changes) {
            const body: Record<string, unknown> = {};
            if (ch.has_name_change) body.name = ch.after.name;
            if (ch.has_sql_change) body.sql = ch.after.sql;
            if (ch.has_connection_change) body.connection_id = ch.after.connection.id;
            if (Object.keys(body).length === 0) continue;
            try {
              await api.put(`/queries/${ch.query_id}`, body);
              applied.push(ch.query_id);
            } catch (e) {
              throw new Error(
                `applied ${applied.length} of ${p.changes.length}; row #${ch.query_id} failed: ${(e as Error).message}`,
              );
            }
          }
          // Land the user on the first edited query so the change
          // is immediately visible — same pattern as single-query
          // accept below.
          rec.resultId = applied[0];
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
        } else if (p.kind === "new_dashboard") {
          // Two-step: create the dashboard, then bulk-add widgets and
          // attach filters. We pick up the new id from the POST and
          // expose it via resultId so a follow-up navigate proposal can
          // jump straight there.
          const created = await api.post<{ id: number }>("/dashboards", {
            name: p.dashboard.name,
            description: p.dashboard.description ?? undefined,
            folder_id: p.dashboard.folder_id ?? undefined,
          });
          rec.resultId = created.id;
          if (p.dashboard.filters.length > 0) {
            await api.put(`/dashboards/${created.id}`, { filters: p.dashboard.filters });
          }
          for (const w of p.dashboard.widgets) {
            await api.post(`/dashboards/${created.id}/widgets`, {
              query_id: w.query_id,
              position_x: w.position_x,
              position_y: w.position_y,
              width: w.width,
              height: w.height,
              title_override: w.title_override ?? undefined,
            });
          }
        } else if (p.kind === "add_widget") {
          await api.post(`/dashboards/${p.dashboard_id}/widgets`, {
            query_id: p.widget.query_id,
            position_x: p.widget.position_x,
            position_y: p.widget.position_y,
            width: p.widget.width,
            height: p.widget.height,
            title_override: p.widget.title_override ?? undefined,
            parameter_mappings: p.widget.parameter_mappings,
          });
          rec.resultId = p.dashboard_id;
        } else if (p.kind === "remove_widget") {
          await api.del(`/dashboards/${p.dashboard_id}/widgets/${p.widget_id}`);
          rec.resultId = p.dashboard_id;
        } else if (p.kind === "dashboard_filter_change") {
          await api.put(`/dashboards/${p.dashboard_id}`, { filters: p.after });
          rec.resultId = p.dashboard_id;
        } else if (p.kind === "widget_mapping") {
          await api.put(`/dashboards/${p.dashboard_id}/widgets/${p.widget_id}`, {
            parameter_mappings: p.after,
          });
          rec.resultId = p.dashboard_id;
        } else if (p.kind === "navigate") {
          // Navigation accept = vue-router push. No backend call. We
          // also pre-warm the destination's store so the page paints
          // without a flash.
          if (p.to === "workspace") {
            await router.push({ name: "workspace" });
            if (p.query_id != null) {
              if (ws.savedQueries.length === 0) await ws.loadSavedQueries();
              const q = ws.savedQueries.find((x) => x.id === p.query_id);
              if (q) await ws.openQuery(q);
              rec.resultId = p.query_id;
            }
          } else if (p.to === "dashboard" && p.dashboard_id != null) {
            await router.push({ name: "dashboard-detail", params: { id: p.dashboard_id } });
            rec.resultId = p.dashboard_id;
          } else if (p.to === "pipeline" && p.pipeline_id != null) {
            await router.push({ name: "pipeline-detail", params: { id: p.pipeline_id } });
            rec.resultId = p.pipeline_id;
          } else if (p.to === "pipelines") {
            await router.push({ name: "pipelines" });
          }
        } else if (p.kind === "new_pipeline") {
          const created = await api.post<{ id: number }>("/pipelines", p.pipeline);
          rec.resultId = created.id;
        } else if (p.kind === "pipeline_edit") {
          await api.put(`/pipelines/${p.pipeline_id}`, p.after);
          rec.resultId = p.pipeline_id;
        } else if (p.kind === "run_pipeline") {
          await api.post(`/pipelines/${p.pipeline_id}/run`, {});
          rec.resultId = p.pipeline_id;
        } else if (p.kind === "delete_pipeline") {
          await api.del(`/pipelines/${p.pipeline_id}`);
          rec.resultId = p.pipeline_id;
        }
        rec.status = auto ? "auto-accepted" : "accepted";

        // Refresh whichever store the change touched.
        if (
          rec.proposal.kind === "query_edit" || rec.proposal.kind === "chart_change"
          || rec.proposal.kind === "new_query" || rec.proposal.kind === "delete_query"
        ) {
          ws.invalidateCache(rec.resultId);
          await ws.loadSavedQueries();
        }
        if (rec.proposal.kind === "bulk_query_edit") {
          // Invalidate every edited query's cache so the row count
          // and chart re-fetch when the user opens one — otherwise
          // they'd see stale data against the new connection.
          for (const ch of rec.proposal.changes) ws.invalidateCache(ch.query_id);
          await ws.loadSavedQueries();
        }
        if (
          rec.proposal.kind === "new_dashboard" || rec.proposal.kind === "add_widget"
          || rec.proposal.kind === "remove_widget"
          || rec.proposal.kind === "dashboard_filter_change"
          || rec.proposal.kind === "widget_mapping"
        ) {
          await Promise.all([dashboards.load(), ws.loadDashboards()]);
          // Refresh the currently-open dashboard view if it's the one
          // we just mutated. Skipped silently when the user is on the
          // workspace page.
          if (dashboards.current && dashboards.current.id === rec.resultId) {
            await dashboards.open(rec.resultId);
          }
        }
        if (
          rec.proposal.kind === "new_pipeline"
          || rec.proposal.kind === "pipeline_edit"
          || rec.proposal.kind === "run_pipeline"
          || rec.proposal.kind === "delete_pipeline"
        ) {
          const pipelines = usePipelinesStore();
          await pipelines.load();
          if (
            pipelines.current
            && rec.resultId != null
            && pipelines.current.id === rec.resultId
          ) {
            await pipelines.open(rec.resultId);
          }
        }

        // Reflect the change in the editor immediately:
        //  - edited query → reload + auto-run
        //  - new query → switch to it + auto-run
        //  - deleted query → reset to a fresh editor
        const p2 = rec.proposal;
        if (p2.kind === "query_edit" || p2.kind === "chart_change") {
          if (ws.activeQueryId === p2.query_id) {
            const fresh = ws.savedQueries.find((q) => q.id === p2.query_id);
            if (fresh) await ws.openQuery(fresh);
          }
        } else if (p2.kind === "new_query" && rec.resultId != null) {
          const fresh = ws.savedQueries.find((q) => q.id === rec.resultId);
          if (fresh) await ws.openQuery(fresh);
        } else if (p2.kind === "delete_query") {
          if (ws.activeQueryId === p2.query_id) ws.newQuery();
        } else if (p2.kind === "bulk_query_edit" && rec.resultId != null) {
          // Bulk edit: send the user to the first changed query so
          // the result of the propose/accept loop is immediately
          // visible. If they're already on a query that got edited,
          // re-open it in place. Otherwise hop to the workspace and
          // open the first one — matches the "navigate after accept"
          // pattern the other proposal kinds use.
          const editedIds = new Set(p2.changes.map((c) => c.query_id));
          const target =
            ws.activeQueryId != null && editedIds.has(ws.activeQueryId)
              ? ws.activeQueryId
              : rec.resultId;
          const fresh = ws.savedQueries.find((q) => q.id === target);
          if (fresh) {
            if (router.currentRoute.value.name !== "workspace") {
              await router.push({ name: "workspace" });
            }
            await ws.openQuery(fresh);
          }
        }
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
