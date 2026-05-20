import { defineStore } from "pinia";
import { api } from "@/api/client";
import type { ParameterSpec, ParameterValues } from "@/stores/workspace";

export interface DashboardSummary {
  id: number;
  name: string;
  description: string | null;
  updated_at: number;
}

/** A single dashboard-level filter (the chip in the top bar). */
export interface DashboardFilter {
  id: string;
  name: string;
  type: "text" | "number" | "date" | "boolean";
  default?: string | number | boolean | null;
  widget?: "input" | "dropdown" | "date" | "toggle";
  options?: string[];
}

export interface DashboardWidget {
  id: number;
  dashboard_id: number;
  query_id: number | null;
  visualization_id: number | null;
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  title_override: string | null;
  source_name: string;
  chart_type: string;
  /** Filter id → query variable name. Drives the per-widget render. */
  parameter_mappings: Record<string, string>;
  /** The widget's underlying query's declared parameters. */
  query_parameters: ParameterSpec[];
}

export interface Dashboard extends DashboardSummary {
  layout: Record<string, unknown>;
  filters: DashboardFilter[];
  widgets: DashboardWidget[];
}

export const useDashboardsStore = defineStore("dashboards", {
  state: () => ({
    list: [] as DashboardSummary[],
    current: null as Dashboard | null,
    /** Live per-filter values entered in the filter bar; resets per
     *  dashboard open so the user starts from each filter's default. */
    filterValues: {} as ParameterValues,
  }),
  actions: {
    async load() {
      this.list = await api.get<DashboardSummary[]>("/dashboards");
    },
    async open(id: number) {
      this.current = await api.get<Dashboard>(`/dashboards/${id}`);
      this.filterValues = {};
      for (const f of this.current.filters ?? []) {
        if (f.default !== undefined && f.default !== null && f.default !== "") {
          this.filterValues[f.id] = f.default;
        }
      }
    },
    async saveFilters(filters: DashboardFilter[]) {
      if (!this.current) return;
      await api.put(`/dashboards/${this.current.id}`, { filters });
      this.current.filters = filters;
      // Seed values for any newly-added filter defaults.
      for (const f of filters) {
        if (
          this.filterValues[f.id] === undefined
          && f.default !== undefined
          && f.default !== null
          && f.default !== ""
        ) {
          this.filterValues[f.id] = f.default;
        }
      }
    },
    async saveWidgetMapping(widgetId: number, mapping: Record<string, string>) {
      if (!this.current) return;
      await api.put(`/dashboards/${this.current.id}/widgets/${widgetId}`, {
        parameter_mappings: mapping,
      });
      const w = this.current.widgets.find((x) => x.id === widgetId);
      if (w) w.parameter_mappings = mapping;
    },
    setFilterValue(id: string, value: string | number | boolean | null) {
      this.filterValues = { ...this.filterValues, [id]: value };
    },
    /**
     * Resolve the parameter values to send when rendering a single
     * widget: walk its filter→param mapping, pick up the current value
     * (or the filter's default), and produce a name→value bag the API
     * forwards to the python engine.
     */
    parameterValuesForWidget(widget: DashboardWidget): ParameterValues {
      const out: ParameterValues = {};
      const filters = this.current?.filters ?? [];
      for (const f of filters) {
        const paramName = widget.parameter_mappings?.[f.id];
        if (!paramName) continue;
        const v = this.filterValues[f.id];
        if (v !== undefined && v !== null && v !== "") {
          out[paramName] = v;
        } else if (f.default !== undefined && f.default !== null && f.default !== "") {
          out[paramName] = f.default;
        }
      }
      return out;
    },
    async create(name: string, description?: string) {
      const r = await api.post<{ id: number }>("/dashboards", { name, description });
      await this.load();
      return r.id;
    },
    async remove(id: number) {
      await api.del(`/dashboards/${id}`);
      this.list = this.list.filter((d) => d.id !== id);
      if (this.current?.id === id) this.current = null;
    },
    async addQueryChart(dashboardId: number, queryId: number) {
      const widgets = this.current?.widgets ?? [];
      const yMax = widgets.reduce((m, w) => Math.max(m, w.position_y + w.height), 0);
      // Convention-over-config: auto-link every dashboard filter to a
      // query variable with the same name. The dashboard reload that
      // follows the POST will surface the real query parameters so the
      // mapping dialog can show which links are real vs phantom.
      const autoMapping: Record<string, string> = {};
      for (const f of this.current?.filters ?? []) {
        autoMapping[f.id] = f.name;
      }
      await api.post(`/dashboards/${dashboardId}/widgets`, {
        query_id: queryId,
        position_x: 0,
        position_y: yMax,
        width: 6,
        height: 4,
        parameter_mappings: autoMapping,
      });
      await this.open(dashboardId);
    },
    /** Legacy: attach an old-style standalone visualization. */
    async addVisualization(dashboardId: number, visualizationId: number) {
      const widgets = this.current?.widgets ?? [];
      const yMax = widgets.reduce((m, w) => Math.max(m, w.position_y + w.height), 0);
      await api.post(`/dashboards/${dashboardId}/widgets`, {
        visualization_id: visualizationId,
        position_x: 0,
        position_y: yMax,
        width: 6,
        height: 4,
      });
      await this.open(dashboardId);
    },
    async removeWidget(dashboardId: number, widgetId: number) {
      await api.del(`/dashboards/${dashboardId}/widgets/${widgetId}`);
      await this.open(dashboardId);
    },
    async savePositions(dashboardId: number, widgets: DashboardWidget[]) {
      await api.put(`/dashboards/${dashboardId}/widgets/positions`, {
        widgets: widgets.map((w) => ({
          id: w.id,
          position_x: w.position_x,
          position_y: w.position_y,
          width: w.width,
          height: w.height,
        })),
      });
    },
  },
});
