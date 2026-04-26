<script setup lang="ts">
import Plotly from "plotly.js-dist-min";
import { onMounted, ref, watch } from "vue";
import type { DashboardWidget } from "@/stores/dashboards";
import { useVisualizationsStore } from "@/stores/visualizations";

const props = defineProps<{
  widget: DashboardWidget;
  editing: boolean;
}>();
const emit = defineEmits<{
  (e: "remove"): void;
  (e: "drag-start", event: PointerEvent): void;
  (e: "resize-start", event: PointerEvent): void;
}>();

const vizStore = useVisualizationsStore();
const host = ref<HTMLDivElement | null>(null);
const loading = ref(true);
const error = ref<string | null>(null);
const rowCount = ref<number | null>(null);

const baseLayout = {
  paper_bgcolor: "rgba(0,0,0,0)",
  plot_bgcolor: "rgba(0,0,0,0)",
  font: { family: "Inter, sans-serif", color: "#a8a098", size: 11 },
  margin: { t: 12, r: 12, b: 32, l: 40 },
  xaxis: { gridcolor: "#36312b", zerolinecolor: "#36312b" },
  yaxis: { gridcolor: "#36312b", zerolinecolor: "#36312b" },
  colorway: ["#d97757", "#7aa2c8", "#7fb069", "#e8b04c", "#c8a2d4"],
};

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const r = await vizStore.render(props.widget.visualization_id);
    if (r.success && r.spec && host.value) {
      rowCount.value = r.row_count ?? null;
      await Plotly.react(
        host.value,
        r.spec.data as unknown[],
        { ...baseLayout, ...r.spec.layout },
        { displayModeBar: false, responsive: true },
      );
    } else {
      error.value = r.error ?? "render failed";
    }
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

function relayout() {
  if (!host.value) return;
  const fn = (Plotly as unknown as { Plots?: { resize?: (el: HTMLElement) => void } }).Plots?.resize;
  if (fn) fn(host.value);
}

onMounted(load);
watch(() => `${props.widget.width}x${props.widget.height}`, () => requestAnimationFrame(relayout));
</script>

<template>
  <div class="widget" :class="{ 'widget--editing': editing }">
    <div class="widget__head" @pointerdown="editing && emit('drag-start', $event)">
      <div class="widget__title">
        {{ widget.title_override ?? widget.viz_name }}
      </div>
      <div class="widget__meta">
        <span v-if="rowCount !== null">{{ rowCount.toLocaleString() }} rows</span>
        <button
          v-if="editing"
          class="btn btn-ghost btn-icon"
          title="Remove from dashboard"
          @click.stop="emit('remove')"
        >×</button>
        <button
          v-else
          class="btn btn-ghost btn-icon"
          title="Refresh"
          @click="load"
        >↻</button>
      </div>
    </div>
    <div ref="host" class="widget__chart">
      <div v-if="loading" class="widget__state">Loading…</div>
      <div v-else-if="error" class="widget__state widget__state--error">{{ error }}</div>
    </div>
    <div
      v-if="editing"
      class="widget__resize"
      title="Resize"
      @pointerdown="emit('resize-start', $event)"
    >
      <svg width="10" height="10" viewBox="0 0 10 10">
        <path d="M1 9 L9 1 M5 9 L9 5" stroke="currentColor" stroke-width="1.5" />
      </svg>
    </div>
  </div>
</template>

<style scoped>
.widget {
  position: absolute;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  transition: border-color 120ms, box-shadow 120ms;
}
.widget--editing { border-color: var(--accent-border); }
.widget--editing .widget__head { cursor: move; user-select: none; }

.widget__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
  flex-shrink: 0;
}
.widget__title {
  font-size: 12px;
  font-weight: 500;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.widget__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--fg-subtle);
  font-variant-numeric: tabular-nums;
}
.widget__chart { flex: 1; position: relative; min-height: 0; }
.widget__state {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  font-size: 12px;
  color: var(--fg-muted);
}
.widget__state--error { color: var(--error); padding: 16px; text-align: center; }
.widget__resize {
  position: absolute;
  right: 0;
  bottom: 0;
  width: 14px;
  height: 14px;
  display: grid;
  place-items: center;
  color: var(--fg-subtle);
  cursor: se-resize;
}
.widget__resize:hover { color: var(--accent); }
</style>
