import { defineStore } from "pinia";
import { api } from "@/api/client";
import type { SavedPipeline } from "./workspace";

export interface PipelineRun {
  id: number;
  pipeline_id?: number;
  status: "pending" | "queued" | "running" | "success" | "failed" | "cancelled" | "retrying";
  started_at: number;
  finished_at: number | null;
  rows_loaded: number | null;
  error_message: string | null;
  triggered_by: "manual" | "schedule" | "agent" | "retry" | "backfill" | "test";
  log?: string;
  version_id?: number | null;
  is_test?: boolean;
  timezone?: string;
  attempt_number?: number;
  attempts?: Array<Record<string, unknown>>;
  timestamps?: Record<string, unknown>;
  processing_interval?: { start: number; end: number } | null;
  explanation?: {
    headline: string;
    explanation: string;
    confidence: "likely" | "confirmed";
    evidence: Array<{ line: string; source: string }>;
    actions: string[];
  } | null;
  check_results?: Array<{ type: string; passed: boolean | null; message: string }>;
  output_metrics?: { rows_loaded: number | null; output_tables: unknown[] };
}

export interface OverviewCounts {
  needs_attention: number;
  running: number;
  queued: number;
  healthy: number;
  paused: number;
}

export interface PipelineVersion {
  id: number;
  version_number: number;
  change_summary: string | null;
  created_at: number;
  python_code: string;
  config_json: string;
  extract_strategy: string;
  write_behavior: string;
  schedule: string | null;
  timezone: string;
}

export const usePipelinesStore = defineStore("pipelines", {
  state: () => ({
    list: [] as SavedPipeline[],
    counts: {
      needs_attention: 0,
      running: 0,
      queued: 0,
      healthy: 0,
      paused: 0,
    } as OverviewCounts,
    current: null as SavedPipeline | null,
    runs: [] as PipelineRun[],
    nextRuns: [] as number[],
    runDetail: null as PipelineRun | null,
    versions: [] as PipelineVersion[],
    activity: [] as Array<Record<string, unknown>>,
    running: false,
    lastError: "" as string,
  }),
  actions: {
    async load() {
      const r = await api.get<{ counts: OverviewCounts; pipelines: SavedPipeline[] }>(
        "/pipelines/overview",
      );
      this.counts = r.counts;
      this.list = r.pipelines;
    },
    async refreshCurrent(id: number) {
      this.current = await api.get<SavedPipeline>(`/pipelines/${id}`);
    },
    async open(id: number) {
      if (this.current?.id !== id) { this.runDetail = null; this.activity = []; }
      this.current = await api.get<SavedPipeline>(`/pipelines/${id}`);
      await Promise.all([this.loadRuns(id), this.loadNextRuns(id), this.loadVersions(id)]);
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
    async loadVersions(id: number) {
      try {
        const r = await api.get<{ versions: PipelineVersion[] }>(`/pipelines/${id}/versions`);
        this.versions = r.versions;
      } catch {
        this.versions = [];
      }
    },
    async loadActivity(id: number) {
      const r = await api.get<{ activity: Array<Record<string, unknown>> }>(
        `/pipelines/${id}/activity`,
      );
      this.activity = r.activity;
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
        await this.open(id);
        return r;
      } catch (e) {
        this.lastError = (e as Error).message;
        throw e;
      } finally {
        this.running = false;
      }
    },
    async testDraft(id: number): Promise<PipelineRun> {
      return api.post<PipelineRun>(`/pipelines/${id}/test`, {});
    },
    async publish(id: number, changeSummary?: string) {
      const r = await api.post<{ version_id: number; version_number: number }>(
        `/pipelines/${id}/publish`,
        { change_summary: changeSummary },
      );
      await this.open(id);
      return r;
    },
    async cancelRun(pipelineId: number, runId: number) {
      return api.post(`/pipelines/${pipelineId}/runs/${runId}/cancel`, {});
    },
    async retryRun(pipelineId: number, runId: number) {
      return api.post<PipelineRun>(`/pipelines/${pipelineId}/runs/${runId}/retry`, {});
    },
    async pause(id: number, paused = true) {
      await api.post(`/pipelines/${id}/pause`, { paused });
      await this.open(id);
    },
    async restoreVersion(pipelineId: number, versionId: number) {
      await api.post(`/pipelines/${pipelineId}/versions/${versionId}/restore`, {});
      await this.open(pipelineId);
    },
    async versionDiff(pipelineId: number, fromId: number, toId: number) {
      return api.get<{
        config_diff: Array<{ path: string; before: unknown; after: unknown }>;
        code_diff: { before: string; after: string; changed: boolean };
      }>(`/pipelines/${pipelineId}/versions/${fromId}/diff/${toId}`);
    },
    async previewTemplate(payload: Partial<SavedPipeline>): Promise<string> {
      const r = await api.post<{ code: string }>("/pipelines/template", payload);
      return r.code;
    },
    async validate(id: number) {
      return api.post<{ ok: boolean; issues: unknown[]; connectivity: { ok: boolean; message: string } }>(
        `/pipelines/${id}/validate`,
        {},
      );
    },
    async backfill(id: number, start: number, end: number, confirm: boolean) {
      return api.post(`/pipelines/${id}/backfill`, { start, end, confirm });
    },
  },
});
