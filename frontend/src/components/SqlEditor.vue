<script setup lang="ts">
import * as monaco from "monaco-editor";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useTheme } from "@/composables/theme";
import { useChatStore } from "@/stores/chat";
import { useWorkspaceStore } from "@/stores/workspace";
import ParametersPanel from "./ParametersPanel.vue";
import ProposalCard from "./ProposalCard.vue";
import RevisionHistoryDialog from "./RevisionHistoryDialog.vue";

const props = defineProps<{ collapsed?: boolean }>();
const emit = defineEmits<{ (e: "toggle-collapse"): void }>();

const ws = useWorkspaceStore();
const sqlHost = ref<HTMLDivElement | null>(null);
const pyHost = ref<HTMLDivElement | null>(null);
let sqlEditor: monaco.editor.IStandaloneCodeEditor | null = null;
let pyEditor: monaco.editor.IStandaloneCodeEditor | null = null;

const showSaveAs = ref(false);
const saveAsName = ref("");
const saving = ref(false);
const saveError = ref("");
const showHistory = ref(false);

async function onReverted() {
  // Reload the saved query list and the active query so the editor
  // reflects the reverted state. The backend has already stamped the
  // revert as a new revision; we just pull the new shape.
  await ws.loadSavedQueries();
  const id = ws.activeQueryId;
  if (id != null) {
    const fresh = ws.savedQueries.find((q) => q.id === id);
    if (fresh) {
      ws.invalidateCache(id);
      await ws.openQuery(fresh);
    }
  }
}

// "sql" = edit the query; "python" = customize the chart in Python.
// Mirrors `ws.chartMode` ("picker" vs "python") so the chart panel and
// editor stay in lockstep.
const tab = computed<"sql" | "python">({
  get: () => (ws.chartMode === "python" ? "python" : "sql"),
  set: (v) => {
    if (v === "python") {
      if (!ws.pythonCode.trim()) {
        ws.pythonCode = generatePythonStub();
      }
      ws.chartMode = "python";
    } else {
      ws.chartMode = "picker";
    }
  },
});

const activeQuery = computed(() =>
  ws.activeQueryId == null
    ? null
    : ws.savedQueries.find((q) => q.id === ws.activeQueryId) ?? null,
);

// One title for the whole query+chart unit. SqlEditor sits on top of
// ChartPanel so showing the name once here serves both panes.
const headerName = computed(() => activeQuery.value?.name ?? "Untitled query");
const hasUnsavedChanges = computed(() => {
  const q = activeQuery.value;
  if (!q) return false;
  return (
    q.sql !== ws.sql ||
    q.chart_type !== ws.chartType ||
    q.chart_mode !== ws.chartMode ||
    (q.chart_python_code ?? "") !== (ws.pythonCode ?? "") ||
    JSON.stringify(q.chart_config ?? {}) !== JSON.stringify(ws.chartConfig ?? {}) ||
    JSON.stringify(q.parameters ?? []) !== JSON.stringify(ws.parameters ?? [])
  );
});

const PX_MAP: Record<string, string> = {
  line: "line",
  bar: "bar",
  scatter: "scatter",
  area: "area",
  pie: "pie",
  donut: "pie",
  histogram: "histogram",
  box: "box",
  violin: "violin",
  strip: "strip",
  treemap: "treemap",
  sunburst: "sunburst",
  funnel: "funnel",
  heatmap: "imshow",
  scatter_geo: "scatter_geo",
  choropleth: "choropleth",
  parallel_coordinates: "parallel_coordinates",
  density_contour: "density_contour",
  density_heatmap: "density_heatmap",
  scatter_3d: "scatter_3d",
};

function quote(s: string): string {
  return `"${s.replace(/"/g, '\\"')}"`;
}

// Produce starter Python code that reproduces the current picker
// selection — every standard chart has its own editable code.
function generatePythonStub(): string {
  const typeId = ws.chartType || "bar";
  const def = ws.chartTypes.find((c) => c.id === typeId);
  const cfg = ws.chartConfig;
  const pxFn = PX_MAP[typeId];
  const argParts: string[] = [];

  if (def) {
    for (const f of [...def.required_fields, ...def.optional_fields]) {
      const val = cfg[f];
      if (val) argParts.push(`${f}=${quote(val)}`);
    }
  }
  // Fallback args when the picker has nothing configured yet.
  if (argParts.length === 0) {
    argParts.push("x=df.columns[0]");
    if (typeId !== "histogram") {
      argParts.push("y=df.columns[1] if len(df.columns) > 1 else df.columns[0]");
    }
  }
  const argsStr = argParts.join(", ");
  if (typeId === "donut") {
    return `# Starter code for a Donut chart — edit freely.
# 'df' is your last query result; assign the figure to 'fig'.
import plotly.express as px

fig = px.pie(df, ${argsStr}, hole=0.4)
`;
  }
  if (pxFn) {
    return `# Starter code for ${def?.name ?? typeId} — edit freely.
# 'df' is your last query result; assign the figure to 'fig'.
import plotly.express as px

fig = px.${pxFn}(df, ${argsStr})
`;
  }
  return `# Starter code for ${def?.name ?? typeId}.
# This chart type doesn't have a 1:1 plotly.express function — feel free to
# rewrite using plotly.graph_objects. 'df' is your last query result; assign
# the figure to 'fig'.
import plotly.express as px

fig = px.bar(df, ${argsStr})
`;
}

function resetFromPicker() {
  ws.pythonCode = generatePythonStub();
}

async function save() {
  if (tab.value !== "sql") return;
  saveError.value = "";
  if (activeQuery.value) {
    saving.value = true;
    try {
      await ws.saveCurrentQuery(activeQuery.value.name);
    } catch (e) {
      saveError.value = (e as Error).message;
    } finally {
      saving.value = false;
    }
    return;
  }
  saveAsName.value = "";
  showSaveAs.value = true;
}

async function confirmSaveAs() {
  if (!saveAsName.value.trim()) {
    saveError.value = "Name is required";
    return;
  }
  saving.value = true;
  saveError.value = "";
  try {
    await ws.saveCurrentQuery(saveAsName.value);
    showSaveAs.value = false;
  } catch (e) {
    saveError.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

async function run() {
  if (tab.value === "sql") {
    await ws.runSql().catch(() => {});
  } else {
    await ws.runPython().catch(() => {});
  }
}

const running = computed(() => (tab.value === "sql" ? ws.running : ws.pythonRunning));

monaco.editor.defineTheme("nicemeta-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "keyword.sql", foreground: "d59c79", fontStyle: "bold" },
    { token: "string.sql", foreground: "a3c585" },
    { token: "number.sql", foreground: "c8a2d4" },
    { token: "comment.sql", foreground: "6b655e", fontStyle: "italic" },
  ],
  colors: {
    "editor.background": "#1a1815",
    "editor.foreground": "#f5f1ec",
    "editorLineNumber.foreground": "#4a443c",
    "editorLineNumber.activeForeground": "#a8a098",
    "editor.selectionBackground": "#d9775733",
    "editor.lineHighlightBackground": "#211e1a",
    "editorCursor.foreground": "#d97757",
    "editorBracketMatch.background": "#d9775722",
    "editorBracketMatch.border": "#d97757",
  },
});

monaco.editor.defineTheme("nicemeta-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "keyword.sql", foreground: "9b5a2c", fontStyle: "bold" },
    { token: "string.sql", foreground: "5c8a3a" },
    { token: "number.sql", foreground: "8b5fa3" },
    { token: "comment.sql", foreground: "8a8278", fontStyle: "italic" },
  ],
  colors: {
    "editor.background": "#faf9f7",
    "editor.foreground": "#1a1815",
    "editorLineNumber.foreground": "#c9c0b1",
    "editorLineNumber.activeForeground": "#5a544c",
    "editor.selectionBackground": "#d9775733",
    "editor.lineHighlightBackground": "#f3f0eb",
    "editorCursor.foreground": "#d97757",
    "editorBracketMatch.background": "#d9775722",
    "editorBracketMatch.border": "#d97757",
    "editorWidget.background": "#ffffff",
    "editorWidget.border": "#e3ddd2",
  },
});

const { theme } = useTheme();
const monacoTheme = computed(() => (theme.value === "light" ? "nicemeta-light" : "nicemeta-dark"));
watch(monacoTheme, (t) => monaco.editor.setTheme(t));

function mountSqlEditor() {
  if (!sqlHost.value || sqlEditor) return;
  sqlEditor = monaco.editor.create(sqlHost.value, {
    value: ws.sql,
    language: "sql",
    theme: monacoTheme.value,
    fontFamily: "JetBrains Mono, SF Mono, monospace",
    fontSize: 13,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    padding: { top: 12, bottom: 12 },
    renderLineHighlight: "all",
    smoothScrolling: true,
    cursorBlinking: "smooth",
    tabSize: 2,
  });
  sqlEditor.onDidChangeModelContent(() => {
    ws.sql = sqlEditor!.getValue();
  });
  sqlEditor.addAction({
    id: "run-sql",
    label: "Run query",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    run: () => ws.runSql().catch(() => {}),
  });
}

function mountPyEditor() {
  if (!pyHost.value || pyEditor) return;
  pyEditor = monaco.editor.create(pyHost.value, {
    value: ws.pythonCode,
    language: "python",
    theme: monacoTheme.value,
    fontFamily: "JetBrains Mono, SF Mono, monospace",
    fontSize: 13,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    padding: { top: 12, bottom: 12 },
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
}

onMounted(() => {
  mountSqlEditor();
  mountPyEditor();
});

// Re-mount whichever editor host appears later (e.g. after a collapse toggle).
watch(
  [sqlHost, pyHost],
  () => {
    if (sqlHost.value && !sqlEditor) mountSqlEditor();
    if (pyHost.value && !pyEditor) mountPyEditor();
  },
);

watch(
  () => ws.sql,
  (value) => {
    if (sqlEditor && sqlEditor.getValue() !== value) sqlEditor.setValue(value);
  },
);

watch(
  () => ws.pythonCode,
  (value) => {
    if (pyEditor && pyEditor.getValue() !== value) pyEditor.setValue(value);
  },
);

watch(
  () => props.collapsed,
  async (collapsed) => {
    if (!collapsed) {
      await new Promise((r) => requestAnimationFrame(r));
      sqlEditor?.layout();
      pyEditor?.layout();
    }
  },
);

watch(
  () => tab.value,
  async () => {
    await new Promise((r) => requestAnimationFrame(r));
    sqlEditor?.layout();
    pyEditor?.layout();
  },
);

onBeforeUnmount(() => {
  sqlEditor?.dispose();
  pyEditor?.dispose();
});

function acceptProposal() {
  ws.acceptProposal();
}
function rejectProposal() {
  ws.rejectProposal();
}

// New agent-driven proposal flow: when the agent emits a query-side change,
// surface the diff card as an overlay on this panel so the user can decide
// without leaving the editor context.
const chat = useChatStore();
const activeQueryProposal = computed(() => {
  const a = chat.activeProposal;
  if (!a) return null;
  const k = a.record.proposal.kind;
  // Surface single-query proposals in the overlay. The bulk variant
  // also touches the active query when it's in the changes list —
  // we float the card here so the user sees the connection retarget
  // without context-switching to the chat panel.
  if (k === "query_edit" || k === "new_query" || k === "delete_query") return a;
  if (k === "bulk_query_edit") {
    const inBatch = a.record.proposal.changes.some(
      (c) => c.query_id === ws.activeQueryId,
    );
    return inBatch ? a : null;
  }
  return null;
});
</script>

<template>
  <div class="editor" :class="{ 'editor--collapsed': props.collapsed }">
    <div class="editor__bar">
      <button
        class="pane-toggle"
        :title="props.collapsed ? 'Expand editor' : 'Collapse editor'"
        @click="emit('toggle-collapse')"
      >
        <svg width="10" height="10" viewBox="0 0 10 10" :class="{ 'pane-toggle--collapsed': props.collapsed }">
          <path d="M2 3.5 L5 6.5 L8 3.5" stroke="currentColor" fill="none" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>

      <div class="editor__tabs">
        <button
          class="editor__tab"
          :class="{ 'editor__tab--active': tab === 'sql' }"
          @click="tab = 'sql'"
          title="Edit the SQL query"
        >
          <span class="editor__tab-badge">SQL</span>
          <span>Query</span>
        </button>
        <button
          class="editor__tab"
          :class="{ 'editor__tab--active': tab === 'python' }"
          @click="tab = 'python'"
          title="Customize the chart with Python"
        >
          <span class="editor__tab-badge editor__tab-badge--py">PY</span>
          <span>Visualization</span>
        </button>
      </div>

      <div class="editor__title">
        <span class="editor__name" :title="headerName">{{ headerName }}</span>
        <span
          v-if="hasUnsavedChanges"
          class="editor__dirty"
          title="Unsaved changes (SQL or chart settings)"
        >•</span>
        <span v-if="!props.collapsed" class="editor__hint">⌘ + Enter to run</span>
      </div>

      <div class="editor__actions">
        <button
          v-if="tab === 'python' && !props.collapsed"
          class="btn btn-ghost btn-sm"
          title="Regenerate code from the current chart type and field selections"
          @click="resetFromPicker"
        >
          Sync from picker
        </button>
        <button
          v-if="activeQuery"
          class="btn btn-ghost btn-sm"
          title="Show this query's revision history"
          @click="showHistory = true"
        >
          History
        </button>
        <button
          v-if="tab === 'sql'"
          class="btn btn-ghost btn-sm"
          :disabled="saving"
          :title="activeQuery ? 'Save changes to this query' : 'Save as a new query'"
          @click="save"
        >
          {{ saving ? "Saving..." : activeQuery ? "Save" : "Save as..." }}
        </button>
        <button class="btn btn-primary btn-sm" :disabled="running" @click="run">
          <svg width="10" height="10" viewBox="0 0 10 10"><polygon points="2,1 9,5 2,9" fill="currentColor" /></svg>
          {{ running ? "Running..." : "Run" }}
        </button>
      </div>
    </div>

    <div v-if="showSaveAs && !props.collapsed && tab === 'sql'" class="save-as">
      <input
        v-model="saveAsName"
        class="save-as__input"
        placeholder="Query name"
        autofocus
        @keyup.enter="confirmSaveAs"
        @keyup.escape="showSaveAs = false"
      />
      <button class="btn btn-ghost btn-sm" @click="showSaveAs = false">Cancel</button>
      <button class="btn btn-primary btn-sm" :disabled="saving" @click="confirmSaveAs">
        {{ saving ? "Saving..." : "Save" }}
      </button>
    </div>
    <p v-if="saveError && !props.collapsed" class="save-as__error">{{ saveError }}</p>

    <div v-if="!props.collapsed && tab === 'python'" class="editor__pyhint">
      <code>df</code> = last query result · assign <code>fig</code> · use Plotly express or graph_objects
    </div>

    <ParametersPanel v-if="!props.collapsed" />

    <div v-show="!props.collapsed && tab === 'sql'" ref="sqlHost" class="editor__host" />
    <div v-show="!props.collapsed && tab === 'python'" ref="pyHost" class="editor__host" />

    <div v-if="tab === 'python' && ws.pythonOutput?.error && !props.collapsed" class="editor__pyerr">
      {{ ws.pythonOutput.error }}
    </div>

    <div v-if="ws.pendingProposal && tab === 'sql' && !props.collapsed" class="proposal">
      <div class="proposal__head">
        <span class="proposal__dot" />
        <span>Crunch proposed a SQL change</span>
      </div>
      <pre class="proposal__diff">{{ ws.pendingProposal.sql }}</pre>
      <div class="proposal__actions">
        <button class="btn btn-sm" @click="rejectProposal">Reject</button>
        <button class="btn btn-primary btn-sm" @click="acceptProposal">Accept &amp; replace</button>
      </div>
    </div>

    <!-- Agent-driven proposal overlay (Cursor-style). The same record is
         shown in the chat panel, but mounting it here lets the user click
         Accept/Reject without leaving the editor. -->
    <div v-if="activeQueryProposal && !props.collapsed" class="overlay-prop">
      <div class="overlay-prop__bar">
        <span class="overlay-prop__dot" />
        <span class="overlay-prop__title">Agent proposed a change to your query</span>
      </div>
      <ProposalCard
        :record="activeQueryProposal.record"
        :turn-id="activeQueryProposal.turnId"
      />
    </div>

    <RevisionHistoryDialog
      v-if="showHistory && activeQuery"
      kind="query"
      :target-id="activeQuery.id"
      :title="activeQuery.name"
      @close="showHistory = false"
      @reverted="onReverted"
    />
  </div>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg);
  position: relative;
}
.editor--collapsed { height: auto; }
.editor__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  flex-shrink: 0;
}
.editor--collapsed .editor__bar { border-bottom: none; }
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

.editor__tabs {
  display: flex;
  gap: 2px;
  flex-shrink: 0;
}
.editor__tab {
  display: flex;
  align-items: center;
  gap: 6px;
  background: transparent;
  border: none;
  color: var(--fg-muted);
  font-size: 12px;
  padding: 5px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.editor__tab:hover { background: var(--bg-hover); color: var(--fg); }
.editor__tab--active { background: var(--accent-subtle); color: var(--accent); }
.editor__tab-badge {
  font-size: 9px;
  font-weight: 700;
  letter-spacing: 0.04em;
  background: var(--bg);
  color: var(--fg-subtle);
  padding: 1px 5px;
  border-radius: 3px;
  border: 1px solid var(--border);
}
.editor__tab--active .editor__tab-badge {
  background: var(--accent-subtle);
  color: var(--accent);
  border-color: var(--accent-border);
}
.editor__tab-badge--py { font-family: var(--font-mono); }

.editor__title {
  display: flex;
  align-items: center;
  gap: 10px;
  font-size: 12px;
  color: var(--fg-muted);
  min-width: 0;
  flex: 1;
}
.editor__name {
  color: var(--fg);
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 360px;
}
.editor__dirty {
  color: var(--accent);
  font-size: 18px;
  line-height: 0;
  margin-left: -4px;
}
.editor__hint { color: var(--fg-subtle); font-size: 11px; }
.editor__actions { display: flex; gap: 6px; flex-shrink: 0; }
.editor__host { flex: 1; min-height: 0; }
.editor__pyhint {
  padding: 4px 12px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  color: var(--fg-subtle);
  font-size: 11px;
  flex-shrink: 0;
}
.editor__pyhint code {
  font-family: var(--font-mono);
  background: var(--bg);
  padding: 0 4px;
  border-radius: 3px;
  color: var(--fg-muted);
}
.editor__pyerr {
  margin: 0;
  padding: 8px 12px;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--error);
  background: rgba(220, 80, 80, 0.06);
  border-top: 1px solid var(--border);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow: auto;
  flex-shrink: 0;
}
.save-as {
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}
.save-as__input {
  flex: 1;
  font-size: 13px;
  padding: 5px 8px;
}
.save-as__error {
  margin: 0;
  padding: 4px 10px;
  font-size: 12px;
  color: var(--error);
  background: rgba(220, 80, 80, 0.08);
  border-bottom: 1px solid var(--border);
}
.overlay-prop {
  position: absolute;
  inset: 38px 12px auto 12px;
  background: var(--bg);
  border: 1px solid var(--accent-border);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 8px 10px 4px;
  max-height: calc(100% - 50px);
  overflow: auto;
  z-index: 30;
}
.overlay-prop__bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding-bottom: 4px;
  font-size: 11px;
  color: var(--accent);
}
.overlay-prop__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 6px var(--accent);
}
.overlay-prop__title { font-weight: 600; }

.proposal {
  border-top: 1px solid var(--accent-border);
  background: var(--accent-subtle);
  padding: 10px 12px;
  display: grid;
  gap: 8px;
}
.proposal__head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--accent);
}
.proposal__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
}
.proposal__diff {
  margin: 0;
  padding: 8px 10px;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--code-fg);
  max-height: 160px;
  overflow: auto;
  white-space: pre;
}
.proposal__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
