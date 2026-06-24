import { defineStore } from "pinia";
import { api } from "@/api/client";
import type { SavedPipeline } from "./workspace";

export interface PipelineRun {
  id: number;
  pipeline_id?: number;
  status: "pending" | "running" | "success" | "failed" | "cancelled";
  started_at: number;
  finished_at: number | null;
  rows_loaded: number | null;
  error_message: string | null;
  triggered_by: "manual" | "schedule" | "agent";
  log?: string;
}

export const usePipelinesStore = defineStore("pipelines", {
  state: () => ({
    list: [] as SavedPipeline[],
    current: null as SavedPipeline | null,
    runs: [] as PipelineRun[],
    nextRuns: [] as number[],
    runDetail: null as PipelineRun | null,
    running: false,
    lastError: "" as string,
  }),
  actions: {
    async load() {
      this.list = await api.get<SavedPipeline[]>("/pipelines");
    },
    async open(id: number) {
      this.current = await api.get<SavedPipeline>(`/pipelines/${id}`);
      await Promise.all([this.loadRuns(id), this.loadNextRuns(id)]);
    },
    async loadRuns(id: number) {
      const r = await api.get<{ runs: PipelineRun[] }>(`/pipelines/${id}/runs`);
      this.runs = r.runs;
    },
    async loadNextRuns(id: number) {
      try {
        const r = await api.get<{ next: number[] }>(`/pipelines/${id}/next-runs`);
        this.nextRuns = r.next;
      } catch {
        this.nextRuns = [];
      }
    },
    async loadRun(pipelineId: number, runId: number) {
      this.runDetail = await api.get<PipelineRun>(
        `/pipelines/${pipelineId}/runs/${runId}`,
      );
    },
    async create(payload: Partial<SavedPipeline>): Promise<SavedPipeline> {
      const r = await api.post<SavedPipeline>("/pipelines", payload);
      await this.load();
      return r;
    },
    async update(id: number, payload: Partial<SavedPipeline>): Promise<void> {
      await api.put(`/pipelines/${id}`, payload);
      await this.load();
      if (this.current?.id === id) await this.open(id);
    },
    async remove(id: number): Promise<void> {
      await api.del(`/pipelines/${id}`);
      this.list = this.list.filter((p) => p.id !== id);
      if (this.current?.id === id) this.current = null;
    },
    async run(id: number): Promise<PipelineRun> {
      this.running = true;
      this.lastError = "";
      try {
        const r = await api.post<PipelineRun>(`/pipelines/${id}/run`, {});
        // Reload runs + the pipeline so denormalised last_run fields update.
        await this.open(id);
        return r;
      } catch (e) {
        this.lastError = (e as Error).message;
        throw e;
      } finally {
        this.running = false;
      }
    },
    /** Ask the engine for the auto-generated dlt template. Used by
     *  the form whenever the user changes a field that feeds the
     *  template (load mode, source type, destination, ...). */
    async previewTemplate(payload: Partial<SavedPipeline>): Promise<string> {
      const r = await api.post<{ code: string }>("/pipelines/template", payload);
      return r.code;
    },
  },
});
