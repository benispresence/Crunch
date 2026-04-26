import { defineStore } from "pinia";
import { api } from "@/api/client";

export interface Visualization {
  id: number;
  connection_id: number | null;
  name: string;
  sql: string;
  chart_type: string;
  renderer: string;
  config: Record<string, unknown>;
  python_code: string | null;
  created_at: number;
  updated_at: number;
}

export const useVisualizationsStore = defineStore("visualizations", {
  state: () => ({
    list: [] as Visualization[],
  }),
  actions: {
    async load() {
      this.list = await api.get<Visualization[]>("/visualizations");
    },
    async save(input: {
      id?: number;
      name: string;
      connection_id: number | null;
      sql: string;
      chart_type: string;
      renderer?: string;
      config?: Record<string, unknown>;
    }) {
      if (input.id) {
        await api.put(`/visualizations/${input.id}`, input);
        return input.id;
      }
      const res = await api.post<{ id: number }>("/visualizations", input);
      return res.id;
    },
    async remove(id: number) {
      await api.del(`/visualizations/${id}`);
      this.list = this.list.filter((v) => v.id !== id);
    },
    async render(id: number) {
      return await api.post<{
        success: boolean;
        spec?: { data: unknown[]; layout: Record<string, unknown> };
        error?: string;
        row_count?: number;
      }>(`/visualizations/${id}/render`, {});
    },
  },
});
