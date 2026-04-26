import { defineStore } from "pinia";
import { api } from "@/api/client";

export interface Connection {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
}

export interface SqlResult {
  success: boolean;
  columns: string[];
  rows: unknown[][];
  row_count: number;
  execution_time_ms: number;
  error?: string;
}

export interface ChartSpec {
  data: unknown[];
  layout: Record<string, unknown>;
}

export const useWorkspaceStore = defineStore("workspace", {
  state: () => ({
    connections: [] as Connection[],
    activeConnectionId: null as number | null,
    sql: "SELECT 1 AS hello",
    result: null as SqlResult | null,
    chart: null as ChartSpec | null,
    running: false,
    pendingProposal: null as { sql: string } | null,
  }),
  actions: {
    async loadConnections() {
      this.connections = await api.get<Connection[]>("/connections");
      if (!this.activeConnectionId && this.connections.length > 0) {
        this.activeConnectionId = this.connections[0]!.id;
      }
    },
    async runSql() {
      if (!this.activeConnectionId) throw new Error("Pick a connection first");
      this.running = true;
      try {
        this.result = await api.post<SqlResult>("/queries/execute", {
          connection_id: this.activeConnectionId,
          sql: this.sql,
        });
      } finally {
        this.running = false;
      }
    },
    proposeSql(sql: string) {
      this.pendingProposal = { sql };
    },
    acceptProposal() {
      if (this.pendingProposal) {
        this.sql = this.pendingProposal.sql;
        this.pendingProposal = null;
      }
    },
    rejectProposal() {
      this.pendingProposal = null;
    },
    setChart(spec: ChartSpec | null) {
      this.chart = spec;
    },
  },
});
