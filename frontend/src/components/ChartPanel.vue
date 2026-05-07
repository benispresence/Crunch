<script setup lang="ts">
import * as monaco from "monaco-editor";
import Plotly from "plotly.js-dist-min";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useWorkspaceStore } from "@/stores/workspace";
import SaveVisualizationDialog from "./SaveVisualizationDialog.vue";

const ws = useWorkspaceStore();
const chartHost = ref<HTMLDivElement | null>(null);
const pythonHost = ref<HTMLDivElement | null>(null);
const pythonOutHost = ref<HTMLDivElement | null>(null);
const editorRef = ref<HTMLDivElement | null>(null);
const saveOpen = ref(false);
const pickerOpen = ref(true);

let pyEditor: monaco.editor.IStandaloneCodeEditor | null = null;

const baseLayout = {
  paper_bgcolor: "rgba(0,0,0,0)",
  plot_bgcolor: "rgba(0,0,0,0)",
  font: { family: "Inter, sans-serif", color: "#a8a098", size: 11 },
  margin: { t: 24, r: 16, b: 36, l: 44 },
  xaxis: { gridcolor: "#36312b", zerolinecolor: "#36312b" },
  yaxis: { gridcolor: "#36312b", zerolinecolor: "#36312b" },
  colorway: ["#d97757", "#7aa2c8", "#7fb069", "#e8b04c", "#c8a2d4"],
};

// Group chart types by category for the picker.
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

function pickChartType(id: string) {
  ws.chartType = id;
  // Auto-fill required fields with the first columns if blank.
  const def = ws.chartTypes.find((c) => c.id === id);
  if (def) {
    const cols = resultColumns.value;
    def.required_fields.forEach((f, i) => {
      if (!ws.chartConfig[f] && cols[i]) ws.chartConfig[f] = cols[i];
    });
  }
  ws.renderChart();
}

watch(
  () => [ws.chartType, ws.chartConfig, ws.result],
  () => {
    if (ws.chartMode !== "picker") return;
    if (!ws.result?.success) return;
    const def = activeChartType.value;
    if (!def) return;
    const allRequiredSet = def.required_fields.every((f) => ws.chartConfig[f]);
    if (!allRequiredSet) return;
    ws.renderChart();
  },
  { deep: true },
);

watch(
  () => ws.chart,
  () => renderPlotly(chartHost.value, ws.chart),
  { deep: true },
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
  (mode) => {
    if (mode === "python" && !pyEditor && editorRef.value) {
      mountPyEditor();
    }
  },
);

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

onMounted(() => {
  if (ws.chartMode === "python") mountPyEditor();
  renderPlotly(chartHost.value, ws.chart);
});

onBeforeUnmount(() => {
  pyEditor?.dispose();
  pyEditor = null;
});

function categoryLabel(c: string) {
  return c.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}
</script>

<template>
  <section class="chart">
    <header class="chart__bar">
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
      <div class="chart__name" :title="ws.activeVizId ? `Editing visualization #${ws.activeVizId}` : 'Unsaved visualization'">
        {{ ws.visualizations.find((v) => v.id === ws.activeVizId)?.name ?? "Untitled" }}
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

    <!-- CHART PICKER MODE -->
    <div v-if="ws.chartMode === 'picker'" class="chart__body">
      <aside :class="{ 'chart__picker--collapsed': !pickerOpen }" class="chart__picker">
        <button class="chart__picker-toggle" @click="pickerOpen = !pickerOpen" :title="pickerOpen ? 'Collapse' : 'Expand'">
          <span v-if="pickerOpen">&laquo; Chart types</span>
          <span v-else>&raquo;</span>
        </button>
        <div v-if="pickerOpen" class="chart__picker-list">
          <div v-for="[cat, list] in groupedChartTypes" :key="cat" class="chart__picker-group">
            <div class="chart__picker-cat">{{ categoryLabel(cat) }}</div>
            <button
              v-for="ct in list"
              :key="ct.id"
              :class="{ 'chart__picker-item--active': ct.id === ws.chartType }"
              class="chart__picker-item"
              :title="ct.description"
              @click="pickChartType(ct.id)"
            >
              <span class="material-icons-name">{{ ct.icon }}</span>
              <span>{{ ct.name }}</span>
            </button>
          </div>
        </div>
      </aside>

      <div class="chart__main">
        <div v-if="activeChartType" class="chart__config">
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

        <div ref="chartHost" class="chart__host">
          <div v-if="!ws.chart && !ws.chartError" class="chart__empty">
            {{ ws.result?.success ? "Pick a chart type to render." : "Run a query, then pick a chart type." }}
          </div>
        </div>
      </div>
    </div>

    <!-- PYTHON EDITOR MODE -->
    <div v-else class="chart__body chart__body--python">
      <div ref="editorRef" class="chart__pyeditor"></div>
      <div class="chart__pybar">
        <span class="chart__pyhint">⌘ + Enter to run · <code>df</code> is your last query as a DataFrame · assign <code>fig</code></span>
        <button class="btn btn-primary btn-sm" :disabled="ws.pythonRunning" @click="ws.runPython()">
          {{ ws.pythonRunning ? "Running…" : "Run" }}
        </button>
      </div>
      <div ref="pythonOutHost" class="chart__pyout">
        <pre v-if="ws.pythonOutput?.error" class="chart__pyerr">{{ ws.pythonOutput.error }}</pre>
        <pre v-else-if="ws.pythonOutput?.stdout && !ws.pythonOutput.spec" class="chart__pystdout">{{ ws.pythonOutput.stdout }}</pre>
        <div v-else-if="!ws.pythonOutput" class="chart__empty">
          Edit the code, then ⌘ + Enter (or click Run) to render.
        </div>
      </div>
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
  min-height: 0;
}
.chart__bar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 4px 8px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  flex-shrink: 0;
}
.chart__tabs { display: flex; gap: 2px; }
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
.chart__name {
  flex: 1;
  font-size: 12px;
  color: var(--fg-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chart__actions { display: flex; gap: 6px; flex-shrink: 0; }

.chart__body {
  flex: 1;
  display: flex;
  min-height: 0;
}
.chart__body--python { flex-direction: column; }

.chart__picker {
  width: 180px;
  border-right: 1px solid var(--border);
  background: var(--bg-elev);
  overflow-y: auto;
  flex-shrink: 0;
  transition: width 150ms;
}
.chart__picker--collapsed { width: 28px; }
.chart__picker-toggle {
  width: 100%;
  background: transparent;
  border: none;
  color: var(--fg-subtle);
  font-size: 11px;
  padding: 6px 8px;
  text-align: left;
  cursor: pointer;
  border-bottom: 1px solid var(--border);
}
.chart__picker-toggle:hover { color: var(--fg); }
.chart__picker-list { padding: 4px 0; }
.chart__picker-group { margin-bottom: 6px; }
.chart__picker-cat {
  font-size: 10px;
  color: var(--fg-subtle);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 6px 12px 3px;
  font-weight: 600;
}
.chart__picker-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  background: transparent;
  border: none;
  color: var(--fg-muted);
  font-size: 12px;
  padding: 5px 12px;
  text-align: left;
  cursor: pointer;
}
.chart__picker-item:hover { background: var(--bg-hover); color: var(--fg); }
.chart__picker-item--active { background: var(--accent-subtle); color: var(--accent); }
.material-icons-name {
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

.chart__main {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.chart__config {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}
.chart__config-head {
  display: flex;
  align-items: baseline;
  gap: 10px;
  margin-bottom: 10px;
}
.chart__config-head strong { font-size: 13px; color: var(--fg); }
.chart__config-head span {
  font-size: 11px;
  color: var(--fg-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chart__fields {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px;
}
.chart__field {
  display: grid;
  gap: 3px;
  font-size: 11px;
  color: var(--fg-muted);
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
}
.chart__error {
  padding: 8px 12px;
  background: rgba(220, 80, 80, 0.08);
  color: var(--error);
  font-size: 12px;
  border-bottom: 1px solid var(--border);
}
.chart__host { flex: 1; min-height: 0; position: relative; }
.chart__empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  color: var(--fg-subtle);
  font-size: 12px;
  text-align: center;
  padding: 20px;
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
.chart__pyout {
  flex: 1;
  min-height: 220px;
  position: relative;
  background: var(--bg);
}
.chart__pyerr {
  margin: 0;
  padding: 12px;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--error);
  background: rgba(220, 80, 80, 0.05);
  white-space: pre-wrap;
  word-break: break-word;
}
.chart__pystdout {
  margin: 0;
  padding: 12px;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  color: var(--fg-muted);
  white-space: pre-wrap;
}
</style>
