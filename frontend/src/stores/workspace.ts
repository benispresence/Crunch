import { defineStore } from "pinia";
import { api } from "@/api/client";

export interface Connection {
  id: number;
  name: string;
  type: string;
  config: Record<string, unknown>;
}

export interface Folder {
  id: number;
  parent_id: number | null;
  name: string;
  sort_order: number;
  created_at: number;
}

export interface SavedQuery {
  id: number;
  connection_id: number | null;
  folder_id: number | null;
  name: string;
  sql: string;
  chart_type: string;
  chart_renderer: string;
  chart_config: Record<string, unknown>;
  chart_python_code: string | null;
  chart_mode: "picker" | "python";
  created_at: number;
  updated_at: number;
}

export interface ChartTypeMeta {
  id: string;
  name: string;
  description: string;
  category: string;
  supported_renderers: string[];
  required_fields: string[];
  optional_fields: string[];
  default_renderer: string;
  icon: string;
}

export interface SavedVisualization {
  id: number;
  connection_id: number | null;
  folder_id: number | null;
  name: string;
  sql: string;
  chart_type: string;
  renderer: string;
  config: Record<string, unknown>;
  python_code: string | null;
  created_at: number;
  updated_at: number;
}

export interface SavedDashboard {
  id: number;
  name: string;
  description: string | null;
  folder_id: number | null;
  updated_at: number;
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
    savedQueries: [] as SavedQuery[],
    visualizations: [] as SavedVisualization[],
    dashboards: [] as SavedDashboard[],
    folders: [] as Folder[],
    chartTypes: [] as ChartTypeMeta[],
    activeConnectionId: null as number | null,
    activeQueryId: null as number | null,
    activeVizId: null as number | null,
    activeFolderId: null as number | null, // null = "All" view
    sql: "SELECT 1 AS hello",
    chartType: "bar",
    chartConfig: {} as Record<string, string>,
    pythonCode: "" as string,
    chartMode: "picker" as "picker" | "python",
    pythonOutput: null as { spec?: Record<string, unknown>; stdout?: string; error?: string } | null,
    pythonRunning: false,
    result: null as SqlResult | null,
    chart: null as ChartSpec | null,
    chartError: "" as string,
    running: false,
    pendingProposal: null as { sql: string } | null,
    // Per-query result+chart cache. Cleared when the query's SQL or chart
    // config changes, so re-opening it is instant but staleness is bounded.
    resultCache: {} as Record<number, SqlResult>,
    chartCache: {} as Record<number, ChartSpec>,
  }),
  actions: {
    async loadConnections() {
      this.connections = await api.get<Connection[]>("/connections");
      if (!this.activeConnectionId && this.connections.length > 0) {
        this.activeConnectionId = this.connections[0]!.id;
      }
    },
    async loadSavedQueries() {
      this.savedQueries = await api.get<SavedQuery[]>("/queries");
    },
    async loadFolders() {
      this.folders = await api.get<Folder[]>("/folders");
    },
    async loadDashboards() {
      this.dashboards = await api.get<SavedDashboard[]>("/dashboards");
    },
    async createFolder(name: string, parentId: number | null = null) {
      const r = await api.post<{ id: number }>("/folders", { name, parent_id: parentId });
      await this.loadFolders();
      return r.id;
    },
    async renameFolder(id: number, name: string) {
      await api.put(`/folders/${id}`, { name });
      await this.loadFolders();
    },
    async deleteFolder(id: number) {
      await api.del(`/folders/${id}`);
      if (this.activeFolderId === id) this.activeFolderId = null;
      await Promise.all([
        this.loadFolders(),
        this.loadSavedQueries(),
        this.loadVisualizations(),
        this.loadDashboards(),
      ]);
    },
    async moveQueryToFolder(queryId: number, folderId: number | null) {
      await api.put(`/queries/${queryId}`, { folder_id: folderId });
      await this.loadSavedQueries();
    },
    async moveVisualizationToFolder(vizId: number, folderId: number | null) {
      await api.put(`/visualizations/${vizId}`, { folder_id: folderId });
      await this.loadVisualizations();
    },
    async moveDashboardToFolder(dashId: number, folderId: number | null) {
      await api.put(`/dashboards/${dashId}`, { folder_id: folderId });
      await this.loadDashboards();
    },
    async loadChartTypes() {
      if (this.chartTypes.length > 0) return;
      const res = await api.get<{ chart_types: ChartTypeMeta[] }>("/viz/chart-types");
      this.chartTypes = res.chart_types;
    },
    async loadVisualizations() {
      this.visualizations = await api.get<SavedVisualization[]>("/visualizations");
    },
    loadVisualization(v: SavedVisualization) {
      this.activeVizId = v.id;
      this.activeQueryId = null;
      if (v.connection_id != null) this.activeConnectionId = v.connection_id;
      this.sql = v.sql;
      this.chartType = v.chart_type;
      this.chartConfig = { ...(v.config as Record<string, string>) };
      this.pythonCode = v.python_code ?? "";
      this.chartMode = v.python_code ? "python" : "picker";
      this.chart = null;
      this.pythonOutput = null;
      this.chartError = "";
    },
    newVisualization() {
      this.activeVizId = null;
      this.chartType = "bar";
      this.chartConfig = {};
      this.pythonCode = "";
      this.chartMode = "picker";
      this.chart = null;
      this.pythonOutput = null;
      this.chartError = "";
    },
    async deleteVisualization(id: number) {
      await api.del(`/visualizations/${id}`);
      if (this.activeVizId === id) this.activeVizId = null;
      await this.loadVisualizations();
    },
    async renderChart() {
      if (!this.result?.success) {
        this.chartError = "Run a query first";
        return;
      }
      const data: Record<string, unknown[]> = {};
      this.result.columns.forEach((col, i) => {
        data[col] = this.result!.rows.map((r) => r[i]);
      });
      try {
        const r = await api.post<{
          success: boolean;
          spec?: { data: unknown[]; layout: Record<string, unknown> };
          error?: string;
        }>("/viz/render", {
          chart_type: this.chartType,
          data,
          config: this.chartConfig,
        });
        if (r.success && r.spec) {
          this.chart = r.spec;
          this.chartError = "";
          if (this.activeQueryId != null) this.chartCache[this.activeQueryId] = r.spec;
        } else {
          this.chartError = r.error ?? "Render failed";
        }
      } catch (e) {
        this.chartError = (e as Error).message;
      }
    },
    async runPython() {
      if (!this.result?.success) {
        this.pythonOutput = { error: "Run a query first" };
        return;
      }
      this.pythonRunning = true;
      const data: Record<string, unknown[]> = {};
      this.result.columns.forEach((col, i) => {
        data[col] = this.result!.rows.map((r) => r[i]);
      });
      try {
        const r = await api.post<{
          success: boolean;
          spec?: Record<string, unknown>;
          stdout?: string;
          error?: string;
        }>("/viz/python", { code: this.pythonCode, data });
        this.pythonOutput = r;
      } catch (e) {
        this.pythonOutput = { error: (e as Error).message };
      } finally {
        this.pythonRunning = false;
      }
    },
    loadQuery(q: SavedQuery) {
      this.sql = q.sql;
      this.activeQueryId = q.id;
      this.activeVizId = null;
      if (q.connection_id != null) this.activeConnectionId = q.connection_id;
      this.chartType = q.chart_type;
      this.chartConfig = { ...(q.chart_config as Record<string, string>) };
      this.pythonCode = q.chart_python_code ?? "";
      this.chartMode = q.chart_mode;
      this.chartError = "";
      this.pythonOutput = null;
      this.result = this.resultCache[q.id] ?? null;
      this.chart = this.chartCache[q.id] ?? null;
    },
    /**
     * Open a saved query and immediately run + render it. Re-opening a query
     * we've seen this session is instant — both the rows and the chart spec
     * come from cache. The cache is invalidated on edit/save.
     */
    async openQuery(q: SavedQuery) {
      this.loadQuery(q);
      if (this.resultCache[q.id] && this.chartCache[q.id]) return;
      if (this.activeConnectionId == null) {
        this.chartError = "This query has no connection — pick one and re-run.";
        return;
      }
      if (!this.resultCache[q.id]) {
        try {
          await this.runSql();
        } catch (e) {
          this.chartError = (e as Error).message;
          return;
        }
      }
      if (!this.result?.success) return;
      if (this.chartMode === "python" && this.pythonCode.trim()) {
        await this.runPython().catch(() => {});
      } else {
        await this.renderChart().catch(() => {});
      }
    },
    invalidateCache(queryId?: number | null) {
      const id = queryId ?? this.activeQueryId;
      if (id == null) return;
      delete this.resultCache[id];
      delete this.chartCache[id];
    },
    async saveCurrentQuery(name: string) {
      const trimmed = name.trim();
      if (!trimmed) throw new Error("Name is required");
      const body = {
        name: trimmed,
        sql: this.sql,
        chart_type: this.chartType,
        chart_config: this.chartConfig,
        chart_python_code: this.pythonCode || null,
        chart_mode: this.chartMode,
        connection_id: this.activeConnectionId,
      };
      if (this.activeQueryId != null) {
        await api.put(`/queries/${this.activeQueryId}`, body);
      } else {
        const folderId = this.activeFolderId && this.activeFolderId > 0 ? this.activeFolderId : null;
        const res = await api.post<{ id: number }>("/queries", { ...body, folder_id: folderId });
        this.activeQueryId = res.id;
      }
      this.invalidateCache();
      await this.loadSavedQueries();
    },
    /**
     * Update only the chart-side settings of the active saved query without
     * forcing a name prompt. No-op if no query is currently selected.
     */
    async saveChartSettings() {
      if (this.activeQueryId == null) return;
      await api.put(`/queries/${this.activeQueryId}`, {
        chart_type: this.chartType,
        chart_config: this.chartConfig,
        chart_python_code: this.pythonCode || null,
        chart_mode: this.chartMode,
      });
      // Result is still valid, only chart needs re-render.
      delete this.chartCache[this.activeQueryId];
      await this.loadSavedQueries();
    },
    async deleteSavedQuery(id: number) {
      await api.del(`/queries/${id}`);
      if (this.activeQueryId === id) this.activeQueryId = null;
      delete this.resultCache[id];
      delete this.chartCache[id];
      await this.loadSavedQueries();
    },
    newQuery() {
      this.activeQueryId = null;
      this.activeVizId = null;
      this.sql = "SELECT 1 AS hello";
      this.result = null;
      this.chart = null;
      this.chartType = "bar";
      this.chartConfig = {};
      this.pythonCode = "";
      this.chartMode = "picker";
    },
    async runSql() {
      if (!this.activeConnectionId) throw new Error("Pick a connection first");
      this.running = true;
      try {
        this.result = await api.post<SqlResult>("/queries/execute", {
          connection_id: this.activeConnectionId,
          sql: this.sql,
        });
        if (this.activeQueryId != null && this.result?.success) {
          this.resultCache[this.activeQueryId] = this.result;
        }
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
