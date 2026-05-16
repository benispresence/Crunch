<script setup lang="ts">
import * as monaco from "monaco-editor";
import Plotly from "plotly.js-dist-min";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useWorkspaceStore } from "@/stores/workspace";
import SaveVisualizationDialog from "./SaveVisualizationDialog.vue";

const props = defineProps<{ collapsed?: boolean }>();
const emit = defineEmits<{ (e: "toggle-collapse"): void }>();

const ws = useWorkspaceStore();
const chartHost = ref<HTMLDivElement | null>(null);
const pythonOutHost = ref<HTMLDivElement | null>(null);
const editorRef = ref<HTMLDivElement | null>(null);
const typePopover = ref<HTMLDivElement | null>(null);
const typeButton = ref<HTMLButtonElement | null>(null);

const saveOpen = ref(false);
const typePickerOpen = ref(false);
const configOpen = ref(true);

let pyEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let renderTimer: number | null = null;
let resizeObserver: ResizeObserver | null = null;

const baseLayout = {
  paper_bgcolor: "rgba(0,0,0,0)",
  plot_bgcolor: "rgba(0,0,0,0)",
  font: { family: "Inter, sans-serif", color: "#a8a098", size: 11 },
  margin: { t: 24, r: 16, b: 36, l: 44 },
  xaxis: { gridcolor: "#36312b", zerolinecolor: "#36312b" },
  yaxis: { gridcolor: "#36312b", zerolinecolor: "#36312b" },
  colorway: ["#d97757", "#7aa2c8", "#7fb069", "#e8b04c", "#c8a2d4"],
};

const groupedChartTypes = computed(() => {
  const groups: Record<string, typeof ws.chartTypes> = {};
  for (const ct of ws.chartTypes) {
    (groups[ct.category] ||= []).push(ct);
  }
  return Object.entries(groups).sort(([a], [b]) => a.localeCompare(b));
});

const activeChartType = computed(() =>
  ws.chartTypes.find((c) => c.id === ws.chartType) ?? null,
);

const resultColumns = computed(() => ws.result?.columns ?? []);

const visualizationName = computed(
  () => ws.visualizations.find((v) => v.id === ws.activeVizId)?.name ?? "Untitled",
);

function autofillRequiredFields(typeId: string) {
  const def = ws.chartTypes.find((c) => c.id === typeId);
  if (!def) return;
  const cols = resultColumns.value;
  def.required_fields.forEach((f, i) => {
    if (!ws.chartConfig[f] && cols[i]) ws.chartConfig[f] = cols[i];
  });
}

function pickChartType(id: string) {
  ws.chartType = id;
  autofillRequiredFields(id);
  typePickerOpen.value = false;
  scheduleRender();
}

function scheduleRender() {
  if (renderTimer != null) window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => {
    renderTimer = null;
    if (ws.chartMode !== "picker") return;
    if (!ws.result?.success) return;
    const def = activeChartType.value;
    if (!def) return;
    if (!def.required_fields.every((f) => ws.chartConfig[f])) return;
    ws.renderChart();
  }, 120);
}

// Auto-fill required fields whenever a new query result arrives, the chart
// type changes, or the chart-types catalog loads — so the chart renders
// without the user touching dropdowns.
watch(
  () => [ws.chartType, ws.result, ws.chartTypes.length] as const,
  () => {
    if (ws.chartType) autofillRequiredFields(ws.chartType);
    scheduleRender();
  },
  { deep: true, immediate: true },
);

watch(() => ws.chartConfig, scheduleRender, { deep: true });

watch(
  () => ws.chart,
  (spec) => renderPlotly(chartHost.value, spec),
  { deep: true },
);

watch(
  () => ws.chartError,
  (err) => {
    if (err && chartHost.value) Plotly.purge(chartHost.value);
  },
);

watch(
  () => ws.pythonOutput,
  () => {
    const out = ws.pythonOutput;
    if (!out) return;
    if (out.spec) {
      renderPlotly(pythonOutHost.value, out.spec as { data: unknown[]; layout: Record<string, unknown> });
    } else if (pythonOutHost.value) {
      Plotly.purge(pythonOutHost.value);
    }
  },
  { deep: true },
);

function renderPlotly(host: HTMLDivElement | null, spec: { data: unknown[]; layout: Record<string, unknown> } | null | undefined) {
  if (!host) return;
  if (!spec) {
    Plotly.purge(host);
    return;
  }
  Plotly.react(
    host,
    spec.data as Parameters<typeof Plotly.react>[1],
    { ...baseLayout, ...(spec.layout || {}) },
    { displayModeBar: false, responsive: true },
  );
}

watch(
  () => ws.chartMode,
  () => {
    nextTick(() => resizeChart());
  },
);

// Re-mount the python editor whenever its host element re-appears.
watch(
  editorRef,
  (host) => {
    if (host && ws.chartMode === "python") {
      pyEditor?.dispose();
      pyEditor = null;
      mountPyEditor();
    }
  },
);

// Re-render python output plot when its host element re-appears.
watch(
  pythonOutHost,
  (host) => {
    const out = ws.pythonOutput;
    if (host && out?.spec) {
      renderPlotly(host, out.spec as { data: unknown[]; layout: Record<string, unknown> });
    }
  },
);

watch(
  () => props.collapsed,
  async (collapsed) => {
    if (collapsed) {
      typePickerOpen.value = false;
      return;
    }
    await nextTick();
    await new Promise((r) => requestAnimationFrame(r));
    resizeChart();
    pyEditor?.layout();
  },
);

function resizeChart() {
  if (chartHost.value && ws.chart) {
    try {
      (Plotly as unknown as { Plots: { resize: (n: HTMLElement) => void } }).Plots.resize(chartHost.value);
    } catch {
      /* host not yet sized */
    }
  }
  if (pythonOutHost.value && ws.pythonOutput?.spec) {
    try {
      (Plotly as unknown as { Plots: { resize: (n: HTMLElement) => void } }).Plots.resize(pythonOutHost.value);
    } catch {
      /* idem */
    }
  }
}

function mountPyEditor() {
  if (!editorRef.value || pyEditor) return;
  pyEditor = monaco.editor.create(editorRef.value, {
    value: ws.pythonCode || defaultPythonStub(),
    language: "python",
    theme: "nicemeta-dark",
    fontFamily: "JetBrains Mono, SF Mono, monospace",
    fontSize: 13,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    padding: { top: 8, bottom: 8 },
    tabSize: 4,
  });
  pyEditor.onDidChangeModelContent(() => {
    ws.pythonCode = pyEditor!.getValue();
  });
  pyEditor.addAction({
    id: "run-python",
    label: "Run Python",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    run: () => ws.runPython().catch(() => {}),
  });
  if (!ws.pythonCode) ws.pythonCode = pyEditor.getValue();
}

function defaultPythonStub() {
  return `# 'df' is a pandas DataFrame of your last query result.
# Assign your figure to 'fig' — Plotly figures render natively.
import plotly.express as px

fig = px.bar(df, x=df.columns[0], y=df.columns[1] if len(df.columns) > 1 else df.columns[0])
`;
}

watch(
  () => ws.pythonCode,
  (code) => {
    if (pyEditor && pyEditor.getValue() !== code) {
      pyEditor.setValue(code || defaultPythonStub());
    }
  },
);

function onDocumentClick(e: MouseEvent) {
  if (!typePickerOpen.value) return;
  const target = e.target as Node;
  if (typePopover.value?.contains(target)) return;
  if (typeButton.value?.contains(target)) return;
  typePickerOpen.value = false;
}

// Re-attach the ResizeObserver and re-render plotly when the host element
// gets re-mounted (it lives inside a v-if that removes/restores it on
// collapse and on mode change).
watch(
  chartHost,
  (host, prev) => {
    if (prev && resizeObserver) resizeObserver.unobserve(prev);
    if (host) {
      if (!resizeObserver) resizeObserver = new ResizeObserver(() => resizeChart());
      resizeObserver.observe(host);
      renderPlotly(host, ws.chart);
    }
  },
);

onMounted(() => {
  if (ws.chartMode === "python") mountPyEditor();
  if (chartHost.value) {
    resizeObserver = new ResizeObserver(() => resizeChart());
    resizeObserver.observe(chartHost.value);
    renderPlotly(chartHost.value, ws.chart);
  }
  document.addEventListener("mousedown", onDocumentClick);
});

onBeforeUnmount(() => {
  pyEditor?.dispose();
  pyEditor = null;
  resizeObserver?.disconnect();
  resizeObserver = null;
  if (renderTimer != null) window.clearTimeout(renderTimer);
  document.removeEventListener("mousedown", onDocumentClick);
});

function categoryLabel(c: string) {
  return c.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}
</script>

<template>
  <section class="chart" :class="{ 'chart--collapsed': props.collapsed }">
    <header class="chart__bar">
      <button
        class="pane-toggle"
        :title="props.collapsed ? 'Expand visualization' : 'Collapse visualization'"
        @click="emit('toggle-collapse')"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" :class="{ 'pane-toggle--collapsed': props.collapsed }">
          <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <div class="chart__tabs">
        <button
          :class="{ 'chart__tab--active': ws.chartMode === 'picker' }"
          class="chart__tab"
          @click="ws.chartMode = 'picker'"
        >
          Chart
        </button>
        <button
          :class="{ 'chart__tab--active': ws.chartMode === 'python' }"
          class="chart__tab"
          @click="ws.chartMode = 'python'"
        >
          Python
        </button>
      </div>

      <button
        v-if="ws.chartMode === 'picker' && !props.collapsed"
        ref="typeButton"
        class="chart__type-btn"
        @click="typePickerOpen = !typePickerOpen"
        :title="activeChartType?.description"
      >
        <span class="chart__type-icon">{{ activeChartType?.icon ?? "•" }}</span>
        <span>{{ activeChartType?.name ?? "Pick chart type" }}</span>
        <svg width="9" height="9" viewBox="0 0 10 10">
          <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <button
        v-if="ws.chartMode === 'picker' && !props.collapsed && activeChartType"
        class="chart__config-btn"
        :class="{ 'chart__config-btn--on': configOpen }"
        @click="configOpen = !configOpen"
        title="Toggle field configuration"
      >
        Configure
      </button>

      <div class="chart__name" :title="ws.activeVizId ? `Editing visualization #${ws.activeVizId}` : 'Unsaved visualization'">
        {{ visualizationName }}
      </div>

      <div class="chart__actions">
        <button
          class="btn btn-ghost btn-sm"
          @click="ws.newVisualization()"
          title="Start a fresh visualization"
        >
          + New
        </button>
        <button
          class="btn btn-primary btn-sm"
          :disabled="!ws.result?.success"
          @click="saveOpen = true"
          title="Save the current visualization"
        >
          Save
        </button>
      </div>
    </header>

    <div v-if="!props.collapsed" class="chart__body" :class="{ 'chart__body--python': ws.chartMode === 'python' }">
      <!-- Chart type popover -->
      <div
        v-if="typePickerOpen && ws.chartMode === 'picker'"
        ref="typePopover"
        class="chart__type-popover"
        role="menu"
      >
        <div v-for="[cat, list] in groupedChartTypes" :key="cat" class="chart__picker-group">
          <div class="chart__picker-cat">{{ categoryLabel(cat) }}</div>
          <div class="chart__picker-grid">
            <button
              v-for="ct in list"
              :key="ct.id"
              :class="{ 'chart__picker-item--active': ct.id === ws.chartType }"
              class="chart__picker-item"
              :title="ct.description"
              @click="pickChartType(ct.id)"
            >
              <span class="chart__picker-icon">{{ ct.icon }}</span>
              <span class="chart__picker-name">{{ ct.name }}</span>
            </button>
          </div>
        </div>
      </div>

      <!-- PICKER MODE -->
      <template v-if="ws.chartMode === 'picker'">
        <div
          v-if="configOpen && activeChartType"
          class="chart__config"
        >
          <div class="chart__config-head">
            <strong>{{ activeChartType.name }}</strong>
            <span>{{ activeChartType.description }}</span>
          </div>
          <div class="chart__fields">
            <label v-for="f in activeChartType.required_fields" :key="`r-${f}`" class="chart__field">
              <span>{{ f }} <em>required</em></span>
              <select v-model="ws.chartConfig[f]">
                <option value="">— pick a column —</option>
                <option v-for="c in resultColumns" :key="c" :value="c">{{ c }}</option>
              </select>
            </label>
            <label v-for="f in activeChartType.optional_fields" :key="`o-${f}`" class="chart__field">
              <span>{{ f }}</span>
              <select v-model="ws.chartConfig[f]">
                <option value="">—</option>
                <option v-for="c in resultColumns" :key="c" :value="c">{{ c }}</option>
              </select>
            </label>
          </div>
        </div>

        <div v-if="ws.chartError" class="chart__error">{{ ws.chartError }}</div>

        <div class="chart__host-wrap">
          <div ref="chartHost" class="chart__host"></div>
          <div v-if="!ws.chart && !ws.chartError" class="chart__empty">
            <div class="chart__empty-icon">
              <svg width="36" height="36" viewBox="0 0 36 36" fill="none">
                <rect x="6" y="20" width="5" height="10" rx="1" fill="currentColor" opacity="0.4" />
                <rect x="14" y="14" width="5" height="16" rx="1" fill="currentColor" opacity="0.6" />
                <rect x="22" y="8" width="5" height="22" rx="1" fill="currentColor" opacity="0.8" />
              </svg>
            </div>
            <div class="chart__empty-msg">
              {{ ws.result?.success
                ? "Pick a chart type and we’ll render it here."
                : "Run a query, then pick a chart type." }}
            </div>
          </div>
        </div>
      </template>

      <!-- PYTHON MODE -->
      <template v-else>
        <div class="chart__pysplit">
          <div ref="editorRef" class="chart__pyeditor"></div>
          <div class="chart__pybar">
            <span class="chart__pyhint">⌘ + Enter to run · <code>df</code> is your last query · assign <code>fig</code></span>
            <button class="btn btn-primary btn-sm" :disabled="ws.pythonRunning" @click="ws.runPython()">
              {{ ws.pythonRunning ? "Running…" : "Run" }}
            </button>
          </div>
        </div>
        <div class="chart__pyout-wrap">
          <div ref="pythonOutHost" class="chart__pyout"></div>
          <pre v-if="ws.pythonOutput?.error" class="chart__pyerr">{{ ws.pythonOutput.error }}</pre>
          <pre v-else-if="ws.pythonOutput?.stdout && !ws.pythonOutput.spec" class="chart__pystdout">{{ ws.pythonOutput.stdout }}</pre>
          <div v-else-if="!ws.pythonOutput" class="chart__empty">
            <div class="chart__empty-msg">Edit the code, then ⌘ + Enter to render.</div>
          </div>
        </div>
      </template>
    </div>

    <SaveVisualizationDialog :open="saveOpen" @close="saveOpen = false" @saved="saveOpen = false" />
  </section>
</template>

<style scoped>
.chart {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg);
  position: relative;
}
.chart--collapsed { height: auto; }
.chart__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  flex-shrink: 0;
  z-index: 2;
}
.chart--collapsed .chart__bar { border-bottom: none; }
.pane-toggle {
  background: transparent;
  border: none;
  color: var(--fg-subtle);
  width: 22px;
  height: 22px;
  display: grid;
  place-items: center;
  cursor: pointer;
  border-radius: var(--radius-sm);
  flex-shrink: 0;
}
.pane-toggle:hover { background: var(--bg-hover); color: var(--fg); }
.pane-toggle svg { transition: transform 150ms; }
.pane-toggle--collapsed { transform: rotate(-90deg); }
.chart__tabs { display: flex; gap: 2px; flex-shrink: 0; }
.chart__tab {
  background: transparent;
  border: none;
  color: var(--fg-muted);
  font-size: 12px;
  padding: 5px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.chart__tab:hover { background: var(--bg-hover); color: var(--fg); }
.chart__tab--active { background: var(--accent-subtle); color: var(--accent); }
.chart__type-btn {
  display: flex;
  align-items: center;
  gap: 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg);
  font-size: 12px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  flex-shrink: 0;
}
.chart__type-btn:hover { background: var(--bg-hover); border-color: var(--accent-border); }
.chart__type-icon {
  font-size: 9px;
  color: var(--fg-subtle);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--bg-elev);
  padding: 1px 4px;
  border-radius: 3px;
  min-width: 22px;
  text-align: center;
}
.chart__config-btn {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--fg-muted);
  font-size: 11px;
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  flex-shrink: 0;
}
.chart__config-btn:hover { background: var(--bg-hover); color: var(--fg); }
.chart__config-btn--on {
  background: var(--accent-subtle);
  color: var(--accent);
  border-color: var(--accent-border);
}
.chart__name {
  flex: 1;
  font-size: 12px;
  color: var(--fg-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  text-align: right;
}
.chart__actions { display: flex; gap: 6px; flex-shrink: 0; }

.chart__body {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  position: relative;
}

/* Chart-type popover */
.chart__type-popover {
  position: absolute;
  top: 6px;
  left: 8px;
  width: min(680px, calc(100% - 16px));
  max-height: calc(100% - 16px);
  background: var(--bg-elev);
  border: 1px solid var(--accent-border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
  z-index: 10;
  overflow-y: auto;
  padding: 8px;
}
.chart__picker-group { margin-bottom: 8px; }
.chart__picker-cat {
  font-size: 10px;
  color: var(--fg-subtle);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 4px 6px;
  font-weight: 600;
}
.chart__picker-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 4px;
}
.chart__picker-item {
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: 1px solid transparent;
  color: var(--fg-muted);
  font-size: 12px;
  padding: 5px 8px;
  text-align: left;
  cursor: pointer;
  border-radius: var(--radius-sm);
  min-width: 0;
}
.chart__picker-item:hover {
  background: var(--bg-hover);
  border-color: var(--border);
  color: var(--fg);
}
.chart__picker-item--active {
  background: var(--accent-subtle);
  color: var(--accent);
  border-color: var(--accent-border);
}
.chart__picker-icon {
  font-size: 9px;
  color: var(--fg-subtle);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--bg);
  padding: 1px 4px;
  border-radius: 3px;
  min-width: 22px;
  text-align: center;
  flex-shrink: 0;
}
.chart__picker-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Field config row */
.chart__config {
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  flex-shrink: 0;
}
.chart__config-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 8px;
}
.chart__config-head strong { font-size: 12px; color: var(--fg); }
.chart__config-head span {
  font-size: 11px;
  color: var(--fg-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chart__fields {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
  gap: 8px;
}
.chart__field {
  display: grid;
  gap: 3px;
  font-size: 11px;
  color: var(--fg-muted);
  min-width: 0;
}
.chart__field em {
  color: var(--accent);
  font-style: normal;
  font-size: 10px;
  margin-left: 4px;
}
.chart__field select {
  font-size: 12px;
  padding: 4px 6px;
  min-width: 0;
}
.chart__error {
  padding: 8px 12px;
  background: rgba(220, 80, 80, 0.08);
  color: var(--error);
  font-size: 12px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

/* Chart host — the big central canvas */
.chart__host-wrap {
  flex: 1;
  min-height: 0;
  position: relative;
  background: var(--bg);
}
.chart__host {
  position: absolute;
  inset: 0;
}
.chart__empty {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  color: var(--fg-subtle);
  font-size: 13px;
  text-align: center;
  padding: 20px;
  pointer-events: none;
}
.chart__empty-icon { color: var(--accent); opacity: 0.7; }
.chart__empty-msg { max-width: 280px; line-height: 1.5; }

/* Python mode */
.chart__body--python { flex-direction: column; }
.chart__pysplit {
  display: flex;
  flex-direction: column;
  flex: 1 1 0;
  min-height: 0;
}
.chart__pyeditor { flex: 1; min-height: 0; border-bottom: 1px solid var(--border); }
.chart__pybar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.chart__pyhint { color: var(--fg-subtle); font-size: 11px; }
.chart__pyout-wrap {
  flex: 2 1 0;
  min-height: 220px;
  position: relative;
  background: var(--bg);
}
.chart__pyout { position: absolute; inset: 0; }
.chart__pyerr {
  margin: 0;
  padding: 12px;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--error);
  background: rgba(220, 80, 80, 0.05);
  white-space: pre-wrap;
  word-break: break-word;
  position: absolute;
  inset: 0;
  overflow: auto;
}
.chart__pystdout {
  margin: 0;
  padding: 12px;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--fg-muted);
  white-space: pre-wrap;
  position: absolute;
  inset: 0;
  overflow: auto;
}
</style>
