<script setup lang="ts">
import Plotly from "plotly.js-dist-min";
import { onMounted, ref, watch } from "vue";
import { useWorkspaceStore } from "@/stores/workspace";
import SaveVisualizationDialog from "./SaveVisualizationDialog.vue";

const ws = useWorkspaceStore();
const host = ref<HTMLDivElement | null>(null);
const saveOpen = ref(false);

const baseLayout = {
  paper_bgcolor: "rgba(0,0,0,0)",
  plot_bgcolor: "rgba(0,0,0,0)",
  font: {
    family: "Inter, sans-serif",
    color: "#a8a098",
    size: 11,
  },
  margin: { t: 24, r: 16, b: 36, l: 44 },
  xaxis: { gridcolor: "#36312b", zerolinecolor: "#36312b" },
  yaxis: { gridcolor: "#36312b", zerolinecolor: "#36312b" },
  colorway: ["#d97757", "#7aa2c8", "#7fb069", "#e8b04c", "#c8a2d4"],
};

async function render() {
  if (!host.value) return;
  if (!ws.chart) {
    Plotly.purge(host.value);
    return;
  }
  await Plotly.react(
    host.value,
    ws.chart.data,
    { ...baseLayout, ...ws.chart.layout },
    { displayModeBar: false, responsive: true },
  );
}

onMounted(render);
watch(() => ws.chart, render, { deep: true });
</script>

<template>
  <section class="chart">
    <header class="chart__bar">
      <span class="chart__title">Visualization</span>
      <button
        class="btn btn-ghost btn-sm"
        :disabled="!ws.result?.success"
        @click="saveOpen = true"
        title="Save as visualization"
      >
        Save
      </button>
    </header>
    <div ref="host" class="chart__host">
      <div v-if="!ws.chart" class="chart__empty">Ask the assistant to chart your results.</div>
    </div>
    <SaveVisualizationDialog :open="saveOpen" @close="saveOpen = false" @saved="saveOpen = false" />
  </section>
</template>

<style scoped>
.chart {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  border-top: 1px solid var(--border);
  border-left: 1px solid var(--border);
}
.chart__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 6px 4px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  font-size: 12px;
  color: var(--fg-muted);
}
.chart__host { flex: 1; min-height: 0; position: relative; }
.chart__empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--fg-subtle);
  font-size: 12px;
}
</style>
