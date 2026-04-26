import { defineStore } from "pinia";
import { api } from "@/api/client";

export interface DashboardSummary {
  id: number;
  name: string;
  description: string | null;
  updated_at: number;
}

export interface DashboardWidget {
  id: number;
  dashboard_id: number;
  visualization_id: number;
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  title_override: string | null;
  viz_name: string;
  chart_type: string;
}

export interface Dashboard extends DashboardSummary {
  layout: Record<string, unknown>;
  widgets: DashboardWidget[];
}

export const useDashboardsStore = defineStore("dashboards", {
  state: () => ({
    list: [] as DashboardSummary[],
    current: null as Dashboard | null,
  }),
  actions: {
    async load() {
      this.list = await api.get<DashboardSummary[]>("/dashboards");
    },
    async open(id: number) {
      this.current = await api.get<Dashboard>(`/dashboards/${id}`);
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
    async addWidget(dashboardId: number, visualizationId: number) {
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
