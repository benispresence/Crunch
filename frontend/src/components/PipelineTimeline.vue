<script setup lang="ts">
import Plotly from "plotly.js-dist-min";
import { onMounted, ref, watch } from "vue";
import { api } from "@/api/client";

/**
 * Gantt-style timeline of recent pipeline runs across every pipeline
 * the user owns. Each run is a horizontal bar from started_at →
 * finished_at, coloured by status, grouped by pipeline name on the
 * y-axis. Hovering shows the duration, row count, and trigger.
 *
 * The backend caps the lookback + result count, so even a busy
 * scheduler can render in one chart call.
 */

interface RunRow {
  id: number;
  pipeline_id: number;
  pipeline_name: string;
  status: "success" | "failed" | "running" | "cancelled" | "pending";
  started_at: number;
  finished_at: number | null;
  rows_loaded: number | null;
  triggered_by: "manual" | "schedule" | "agent";
  error_message: string | null;
}

const host = ref<HTMLDivElement | null>(null);
const lookback = ref<number>(24);  // hours
const loading = ref(false);
const error = ref<string | null>(null);
const runs = ref<RunRow[]>([]);

const STATUS_COLOR: Record<string, string> = {
  success: "#7fb069",
  failed: "#e07a5f",
  running: "#7aa2c8",
  cancelled: "#a8a098",
  pending: "#d4a44e",
};

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const r = await api.get<{ runs: RunRow[] }>(
      `/pipelines/timeline?hours=${lookback.value}`,
    );
    runs.value = r.runs;
    await render();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

async function render() {
  if (!host.value) return;
  if (runs.value.length === 0) {
    await Plotly.purge(host.value);
    return;
  }

  // One trace per status so the legend doubles as a status filter.
  const byStatus = new Map<string, RunRow[]>();
  for (const r of runs.value) {
    if (!byStatus.has(r.status)) byStatus.set(r.status, []);
    byStatus.get(r.status)!.push(r);
  }

  const data: unknown[] = [];
  for (const [status, items] of byStatus.entries()) {
    data.push({
      type: "bar",
      orientation: "h",
      name: status,
      x: items.map((r) =>
        ((r.finished_at ?? Math.floor(Date.now() / 1000)) - r.started_at) * 1000,
      ),
      // Plotly stacks horizontal bars by the ``base`` value, which
      // we set to the run's start time. That gives us Gantt-shaped
      // bars without using figure_factory.
      base: items.map((r) => new Date(r.started_at * 1000).toISOString()),
      y: items.map((r) => r.pipeline_name),
      marker: { color: STATUS_COLOR[status] ?? "#888" },
      customdata: items.map((r) => [
        r.id,
        r.rows_loaded ?? "—",
        r.triggered_by,
        r.error_message ?? "",
        r.finished_at
          ? humanDuration((r.finished_at - r.started_at))
          : "running…",
      ]),
      hovertemplate:
        "<b>%{y}</b><br>"
        + "run #%{customdata[0]} · %{customdata[2]}<br>"
        + "duration: %{customdata[4]}<br>"
        + "rows: %{customdata[1]}<br>"
        + "%{customdata[3]}"
        + "<extra></extra>",
    });
  }

  await Plotly.react(
    host.value,
    data as Parameters<typeof Plotly.react>[1],
    {
      barmode: "overlay",
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: "Inter, sans-serif", color: "#a8a098", size: 11 },
      margin: { t: 28, r: 24, b: 36, l: 200 },
      xaxis: {
        type: "date",
        gridcolor: "#36312b",
        zerolinecolor: "#36312b",
        showgrid: true,
      },
      yaxis: {
        gridcolor: "#36312b",
        automargin: true,
        autorange: "reversed",
      },
      legend: { orientation: "h", y: 1.1, x: 0 },
      showlegend: true,
      height: Math.max(220, 32 * new Set(runs.value.map((r) => r.pipeline_name)).size + 80),
    },
    { displayModeBar: false, responsive: true },
  );
}

function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

onMounted(load);
watch(lookback, load);
</script>

<template>
  <div class="tl">
    <header class="tl__head">
      <h3>Pipeline timeline</h3>
      <div class="tl__controls">
        <label>
          <span>Lookback</span>
          <select v-model.number="lookback">
            <option :value="1">1 hour</option>
            <option :value="6">6 hours</option>
            <option :value="24">24 hours</option>
            <option :value="168">7 days</option>
            <option :value="720">30 days</option>
          </select>
        </label>
        <button class="btn btn-sm" :disabled="loading" @click="load">
          {{ loading ? "Loading…" : "Refresh" }}
        </button>
      </div>
    </header>
    <p v-if="error" class="tl__error">{{ error }}</p>
    <div v-if="runs.length === 0 && !loading && !error" class="tl__empty">
      No pipeline runs in the selected window.
    </div>
    <div ref="host" class="tl__plot"></div>
  </div>
</template>

<style scoped>
.tl {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  display: grid;
  gap: 8px;
}
.tl__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.tl__head h3 {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 14px;
  font-weight: 500;
}
.tl__controls {
  display: flex;
  gap: 8px;
  align-items: center;
}
.tl__controls label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--fg-muted);
}
.tl__controls select {
  font-size: 12px;
  padding: 4px 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
}
.tl__error {
  margin: 0;
  padding: 8px 12px;
  color: var(--error);
  font-size: 12px;
  background: rgba(220, 80, 80, 0.06);
  border-radius: var(--radius-sm);
}
.tl__empty {
  padding: 32px;
  text-align: center;
  font-size: 13px;
  color: var(--fg-subtle);
}
.tl__plot {
  min-height: 240px;
}
</style>
