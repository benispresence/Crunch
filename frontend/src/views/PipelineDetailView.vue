<script setup lang="ts">
import * as monaco from "monaco-editor";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import PipelineLogViewer from "@/components/PipelineLogViewer.vue";
import { useTheme } from "@/composables/theme";
import { usePipelinesStore, type PipelineRun } from "@/stores/pipelines";
import { useWorkspaceStore, type SavedPipeline } from "@/stores/workspace";

/**
 * Pipeline detail = config form + Monaco Python editor + run history.
 *
 * The editor is the heart of the page; it mirrors what queries +
 * visualizations get — same Monaco theme, same Ctrl-Enter to run.
 * When the pipeline is in ``code_mode='template'`` and any of the
 * form fields that feed the template change, we regenerate the body
 * via the engine and replace the editor contents. Switching to
 * "custom" freezes the user's edits.
 */

const route = useRoute();
const router = useRouter();
const ws = useWorkspaceStore();
const pipelines = usePipelinesStore();
const { theme } = useTheme();
const monacoTheme = computed(() => (theme.value === "light" ? "nicemeta-light" : "nicemeta-dark"));

const editorHost = ref<HTMLDivElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;

const pipelineId = computed(() => Number(route.params.id));
const draft = ref<Partial<SavedPipeline> | null>(null);
const saving = ref(false);
const runError = ref("");
const selectedRunId = ref<number | null>(null);

const tab = ref<"config" | "code" | "history">("code");

const cronHint = ref("");

onMounted(async () => {
  await Promise.all([
    ws.loadConnections(),
    pipelines.open(pipelineId.value),
  ]);
  // Seed the draft with the current saved state.
  if (pipelines.current) {
    draft.value = { ...pipelines.current };
  }
  // Mount Monaco lazily so the panel grows into its container first.
  await new Promise((r) => requestAnimationFrame(r));
  mountEditor();
});

onBeforeUnmount(() => {
  editor?.dispose();
});

function mountEditor() {
  if (!editorHost.value || editor) return;
  editor = monaco.editor.create(editorHost.value, {
    value: draft.value?.python_code ?? "",
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
  editor.onDidChangeModelContent(() => {
    if (!draft.value) return;
    draft.value.python_code = editor!.getValue();
  });
  editor.addAction({
    id: "run-pipeline",
    label: "Run pipeline",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter],
    run: () => void runPipeline(),
  });
}

watch(monacoTheme, (t) => monaco.editor.setTheme(t));

/** Re-derive the auto-generated template when any field that feeds it
 *  changes — but only while the user is in template mode. Otherwise
 *  we'd clobber custom edits on every keystroke. */
const templateInputs = computed(() => {
  if (!draft.value) return "";
  return JSON.stringify({
    name: draft.value.name,
    source_type: draft.value.source_type,
    source_config: draft.value.source_config,
    destination_connection_id: draft.value.destination_connection_id,
    destination_dataset: draft.value.destination_dataset,
    load_mode: draft.value.load_mode,
    primary_key: draft.value.primary_key,
    cursor_field: draft.value.cursor_field,
  });
});

const templateRegenTimer = ref<number | null>(null);

watch(
  templateInputs,
  () => {
    if (!draft.value || draft.value.code_mode !== "template") return;
    if (templateRegenTimer.value != null) {
      window.clearTimeout(templateRegenTimer.value);
    }
    // Debounce so typing the destination_dataset isn't a regen storm.
    templateRegenTimer.value = window.setTimeout(() => {
      void regenerateTemplate();
    }, 400);
  },
);

async function regenerateTemplate() {
  if (!draft.value) return;
  try {
    const code = await pipelines.previewTemplate(draft.value);
    draft.value.python_code = code;
    if (editor) editor.setValue(code);
  } catch (e) {
    runError.value = (e as Error).message;
  }
}

async function save() {
  if (!draft.value) return;
  saving.value = true;
  runError.value = "";
  try {
    await pipelines.update(pipelineId.value, draft.value);
    draft.value = { ...(pipelines.current as SavedPipeline) };
  } catch (e) {
    runError.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}

async function runPipeline() {
  if (!draft.value) return;
  // Always save first so the run uses the latest code/config — silent
  // surprises ("I changed the code but it ran the old one") are the
  // worst part of these editors otherwise.
  await save();
  try {
    await pipelines.run(pipelineId.value);
    selectedRunId.value = pipelines.runs[0]?.id ?? null;
    tab.value = "history";
  } catch (e) {
    runError.value = (e as Error).message;
  }
}

async function selectRun(run: PipelineRun) {
  selectedRunId.value = run.id;
  await pipelines.loadRun(pipelineId.value, run.id);
}

function fmtDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

function fmtDuration(start: number, end: number | null): string {
  if (!end) return "running…";
  const secs = end - start;
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

function statusColor(s: string | null): string {
  switch (s) {
    case "success": return "ok";
    case "failed": return "err";
    case "running": return "running";
    default: return "muted";
  }
}

const currentRun = computed(() => pipelines.runDetail ?? null);

function setLoadMode(m: "replace" | "append" | "merge" | "incremental" | "streaming") {
  if (!draft.value) return;
  draft.value.load_mode = m;
}

function setSchedulePreset(preset: string) {
  if (!draft.value) return;
  draft.value.schedule = preset;
  draft.value.schedule_enabled = true;
}

const dirty = computed(() => {
  if (!draft.value || !pipelines.current) return false;
  return JSON.stringify(draft.value) !== JSON.stringify(pipelines.current);
});
</script>

<template>
  <div v-if="draft" class="detail">
    <header class="detail__head">
      <div class="detail__head-left">
        <button class="btn btn-ghost btn-sm" @click="router.push({ name: 'pipelines' })">
          ← Pipelines
        </button>
        <input v-model="draft.name" class="detail__name" />
        <span
          v-if="draft.last_run_status"
          class="detail__status"
          :class="`detail__status--${statusColor(draft.last_run_status)}`"
        >{{ draft.last_run_status }}</span>
        <span v-if="dirty" class="detail__dirty">•</span>
      </div>
      <div class="detail__head-right">
        <button class="btn btn-ghost btn-sm" :disabled="saving" @click="save">
          {{ saving ? "Saving…" : "Save" }}
        </button>
        <button
          class="btn btn-primary btn-sm"
          :disabled="pipelines.running || !draft.destination_connection_id"
          @click="runPipeline"
        >
          {{ pipelines.running ? "Running…" : "Run pipeline" }}
        </button>
      </div>
    </header>

    <p v-if="runError" class="detail__error">{{ runError }}</p>

    <div class="detail__tabs">
      <button class="detail__tab" :class="{ 'detail__tab--active': tab === 'config' }" @click="tab = 'config'">Configuration</button>
      <button class="detail__tab" :class="{ 'detail__tab--active': tab === 'code' }" @click="tab = 'code'">Python script</button>
      <button class="detail__tab" :class="{ 'detail__tab--active': tab === 'history' }" @click="tab = 'history'">Run history</button>
    </div>

    <!-- Config form -->
    <section v-show="tab === 'config'" class="detail__panel detail__panel--scroll">
      <div class="grid">
        <label class="field field--full">
          <span>Description</span>
          <textarea v-model="draft.description" rows="2" placeholder="What does this pipeline load?"></textarea>
        </label>
      </div>

      <h3>Source</h3>
      <div class="grid">
        <label class="field">
          <span>Source type</span>
          <select v-model="draft.source_type">
            <option value="custom">Custom</option>
            <option value="rest_api">REST API</option>
            <option value="sql">SQL replication</option>
            <option value="file">File</option>
            <option value="kafka">Kafka (streaming)</option>
          </select>
        </label>
        <label v-if="draft.source_type === 'rest_api'" class="field field--full">
          <span>Base URL</span>
          <input v-model="(draft.source_config as any).base_url" placeholder="https://api.stripe.com/v1" />
        </label>
        <label v-if="draft.source_type === 'rest_api'" class="field">
          <span>Path</span>
          <input v-model="(draft.source_config as any).path" placeholder="/customers" />
        </label>
        <label v-if="draft.source_type === 'rest_api'" class="field">
          <span>Auth header</span>
          <input v-model="(draft.source_config as any).auth_header" placeholder="Bearer sk_…" type="password" />
        </label>

        <label v-if="draft.source_type === 'sql'" class="field field--full">
          <span>Source connection URL</span>
          <input v-model="(draft.source_config as any).connection_url" placeholder="postgresql://…" />
        </label>
        <label v-if="draft.source_type === 'sql'" class="field field--full">
          <span>Query</span>
          <textarea v-model="(draft.source_config as any).query" rows="3" placeholder="SELECT * FROM source.orders" />
        </label>

        <label v-if="draft.source_type === 'file'" class="field field--full">
          <span>File path or glob</span>
          <input v-model="(draft.source_config as any).path" placeholder="/data/orders/*.parquet" />
        </label>

        <label v-if="draft.source_type === 'kafka'" class="field">
          <span>Brokers</span>
          <input v-model="(draft.source_config as any).brokers" placeholder="kafka1:9092,kafka2:9092" />
        </label>
        <label v-if="draft.source_type === 'kafka'" class="field">
          <span>Topic</span>
          <input v-model="(draft.source_config as any).topic" placeholder="events" />
        </label>
        <label v-if="draft.source_type === 'kafka'" class="field">
          <span>Consumer group</span>
          <input v-model="(draft.source_config as any).group_id" placeholder="crunch-consumer" />
        </label>
      </div>

      <h3>Destination</h3>
      <div class="grid">
        <label class="field">
          <span>Connection</span>
          <select v-model="draft.destination_connection_id">
            <option :value="null">(pick a connection)</option>
            <option v-for="c in ws.connections" :key="c.id" :value="c.id">
              {{ c.name }} — {{ c.type }}
            </option>
          </select>
        </label>
        <label class="field">
          <span>Dataset / schema</span>
          <input v-model="draft.destination_dataset" placeholder="raw" />
        </label>
      </div>

      <h3>Load mode</h3>
      <div class="modes">
        <button
          v-for="m in (['replace','append','merge','incremental','streaming'] as const)"
          :key="m"
          class="mode"
          :class="{ 'mode--on': draft.load_mode === m }"
          @click="setLoadMode(m)"
        >
          <strong>{{ m }}</strong>
          <small>{{ ({
            replace: 'Full load — truncate and re-ingest every run.',
            append: 'Batch append — adds rows on each run.',
            merge: 'Delta — upserts by primary key.',
            incremental: 'Only new rows since the last cursor value.',
            streaming: 'Bounded streaming — consume for N seconds / messages.',
          } as Record<string, string>)[m] }}</small>
        </button>
      </div>
      <div v-if="draft.load_mode === 'merge'" class="grid">
        <label class="field field--full">
          <span>Primary key(s) — comma-separated</span>
          <input v-model="draft.primary_key" placeholder="id" />
        </label>
      </div>
      <div v-if="draft.load_mode === 'incremental'" class="grid">
        <label class="field field--full">
          <span>Cursor field</span>
          <input v-model="draft.cursor_field" placeholder="updated_at" />
        </label>
      </div>
      <div v-if="draft.load_mode === 'streaming'" class="grid">
        <label class="field">
          <span>Max wall-clock (seconds)</span>
          <input v-model.number="draft.stream_max_seconds" type="number" min="1" />
        </label>
        <label class="field">
          <span>Max messages</span>
          <input v-model.number="draft.stream_max_messages" type="number" min="1" />
        </label>
      </div>

      <h3>Schedule</h3>
      <div class="grid">
        <label class="field field--full">
          <span>Cron expression (5 fields)</span>
          <input v-model="draft.schedule" placeholder="0 */6 * * *  (every 6 hours)" />
          <small>
            Presets:
            <button class="preset" type="button" @click="setSchedulePreset('*/10 * * * *')">every 10m</button>
            <button class="preset" type="button" @click="setSchedulePreset('0 * * * *')">hourly</button>
            <button class="preset" type="button" @click="setSchedulePreset('0 */6 * * *')">every 6h</button>
            <button class="preset" type="button" @click="setSchedulePreset('0 2 * * *')">daily 02:00</button>
            <button class="preset" type="button" @click="setSchedulePreset('0 2 * * 1')">Mondays</button>
          </small>
        </label>
        <label class="field">
          <span>Enabled</span>
          <label class="toggle">
            <input v-model="draft.schedule_enabled" type="checkbox" />
            <span>{{ draft.schedule_enabled ? "scheduler will fire" : "paused" }}</span>
          </label>
        </label>
      </div>
      <div v-if="pipelines.nextRuns.length > 0 && draft.schedule_enabled" class="schedule-preview">
        <strong>Next runs:</strong>
        <span v-for="(ts, i) in pipelines.nextRuns" :key="i">{{ fmtDate(ts) }}</span>
      </div>

      <h3>Code mode</h3>
      <p class="hint">
        <strong>Template</strong>: Crunch re-derives the Python from this form on every save.
        <strong>Custom</strong>: your edits are preserved verbatim — switch here once you've
        tailored the starter script.
      </p>
      <div class="modes modes--narrow">
        <button class="mode" :class="{ 'mode--on': draft.code_mode === 'template' }" @click="draft.code_mode = 'template'">
          <strong>template</strong>
          <small>regenerate from form fields</small>
        </button>
        <button class="mode" :class="{ 'mode--on': draft.code_mode === 'custom' }" @click="draft.code_mode = 'custom'">
          <strong>custom</strong>
          <small>freeze edits</small>
        </button>
      </div>
    </section>

    <!-- Python script -->
    <section v-show="tab === 'code'" class="detail__panel detail__panel--code">
      <div class="detail__code-bar">
        <span class="detail__hint">
          <code>ctx</code> = destination + bounds · ⌘+Enter to run.
          <span v-if="draft.code_mode === 'template'">Template mode — edits are overwritten on save.</span>
        </span>
      </div>
      <div ref="editorHost" class="detail__editor"></div>
    </section>

    <!-- Run history -->
    <section v-show="tab === 'history'" class="detail__panel detail__panel--scroll">
      <ul class="runs">
        <li v-if="pipelines.runs.length === 0" class="runs__empty">
          No runs yet — hit <strong>Run pipeline</strong> to do the first one.
        </li>
        <li
          v-for="run in pipelines.runs"
          :key="run.id"
          class="runs__row"
          :class="{ 'runs__row--active': selectedRunId === run.id }"
          @click="selectRun(run)"
        >
          <span class="runs__status" :class="`runs__status--${statusColor(run.status)}`">{{ run.status }}</span>
          <span class="runs__time">{{ fmtDate(run.started_at) }}</span>
          <span class="runs__duration">{{ fmtDuration(run.started_at, run.finished_at) }}</span>
          <span class="runs__rows">{{ run.rows_loaded ?? "—" }} rows</span>
          <span class="runs__trigger">{{ run.triggered_by }}</span>
        </li>
      </ul>

      <div v-if="currentRun" class="run-detail">
        <h4>Run #{{ currentRun.id }} — {{ currentRun.status }}</h4>
        <PipelineLogViewer
          :log="currentRun.log || ''"
          :status="currentRun.status"
          :error-message="currentRun.error_message"
        />
      </div>
    </section>
  </div>
</template>

<style scoped>
.detail {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--bg);
}
.detail__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 24px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}
.detail__head-left {
  display: flex;
  align-items: center;
  gap: 12px;
}
.detail__name {
  font-family: var(--font-serif);
  font-size: 17px;
  font-weight: 500;
  background: transparent;
  border: none;
  color: var(--fg);
  outline: none;
  min-width: 280px;
  padding: 4px 6px;
}
.detail__name:focus { background: var(--bg); border-radius: var(--radius-sm); }
.detail__status {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 999px;
}
.detail__status--ok { background: rgba(127, 176, 105, 0.14); color: var(--success); }
.detail__status--err { background: rgba(224, 122, 95, 0.14); color: var(--error); }
.detail__status--running { background: var(--accent-subtle); color: var(--accent); }
.detail__status--muted { background: var(--bg); color: var(--fg-subtle); }
.detail__dirty { color: var(--accent); font-size: 18px; }
.detail__head-right { display: flex; gap: 6px; }
.detail__error {
  margin: 0;
  padding: 8px 24px;
  background: rgba(220, 80, 80, 0.08);
  color: var(--error);
  font-size: 12px;
  border-bottom: 1px solid var(--border);
}

.detail__tabs {
  display: flex;
  gap: 4px;
  padding: 8px 24px 0;
  border-bottom: 1px solid var(--border);
}
.detail__tab {
  padding: 7px 14px;
  font-size: 12.5px;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  color: var(--fg-muted);
  cursor: pointer;
}
.detail__tab--active {
  color: var(--fg);
  border-bottom-color: var(--accent);
}

.detail__panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.detail__panel--scroll {
  overflow-y: auto;
  padding: 16px 24px 32px;
}
.detail__panel--code {
  display: flex;
}
.detail__code-bar {
  padding: 6px 16px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  font-size: 11.5px;
  color: var(--fg-subtle);
}
.detail__hint code { font-family: var(--font-mono); }
.detail__editor { flex: 1; min-height: 0; }

h3 {
  font-family: var(--font-serif);
  font-size: 14px;
  font-weight: 500;
  margin: 24px 0 10px;
}
h3:first-of-type { margin-top: 8px; }

.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  margin-bottom: 8px;
}
.field {
  display: grid;
  gap: 4px;
  font-size: 11px;
  color: var(--fg-muted);
}
.field--full { grid-column: 1 / -1; }
.field input,
.field select,
.field textarea {
  font-size: 13px;
  padding: 6px 8px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
  font-family: inherit;
}
.field small {
  font-size: 11px;
  color: var(--fg-subtle);
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  align-items: center;
}
.preset {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 8px;
  font-size: 10px;
  cursor: pointer;
  color: var(--fg-muted);
}
.preset:hover { color: var(--fg); border-color: var(--accent-border); }
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fg-muted);
  padding: 6px 0;
}

.modes {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 8px;
  margin-bottom: 8px;
}
.modes--narrow { grid-template-columns: repeat(2, 200px); }
.mode {
  display: grid;
  gap: 4px;
  text-align: left;
  padding: 10px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--fg);
  transition: border-color 120ms, background 120ms;
}
.mode strong {
  font-family: var(--font-mono);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-muted);
}
.mode small { font-size: 11px; color: var(--fg-subtle); line-height: 1.4; }
.mode:hover { border-color: var(--accent-border); }
.mode--on {
  background: var(--accent-subtle);
  border-color: var(--accent);
}
.mode--on strong { color: var(--accent); }

.schedule-preview {
  display: flex;
  gap: 10px;
  flex-wrap: wrap;
  align-items: center;
  font-size: 11.5px;
  color: var(--fg-muted);
  margin: 6px 0 12px;
}
.schedule-preview strong { color: var(--fg-subtle); font-weight: 500; }

.hint {
  font-size: 12px;
  color: var(--fg-muted);
  margin: 0 0 8px;
}

.runs {
  list-style: none;
  padding: 0;
  margin: 0 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.runs__empty {
  padding: 24px;
  text-align: center;
  color: var(--fg-muted);
  font-size: 13px;
}
.runs__row {
  display: grid;
  grid-template-columns: 80px 1fr 80px 100px 80px;
  gap: 10px;
  align-items: center;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  font-size: 12.5px;
}
.runs__row:last-child { border-bottom: none; }
.runs__row:hover { background: var(--bg-hover); }
.runs__row--active { background: var(--accent-subtle); }
.runs__status {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 8px;
  border-radius: 999px;
  text-align: center;
}
.runs__status--ok { background: rgba(127, 176, 105, 0.14); color: var(--success); }
.runs__status--err { background: rgba(224, 122, 95, 0.14); color: var(--error); }
.runs__status--running { background: var(--accent-subtle); color: var(--accent); }
.runs__status--muted { background: var(--bg); color: var(--fg-subtle); }
.runs__time { font-variant-numeric: tabular-nums; }
.runs__duration { font-family: var(--font-mono); color: var(--fg-muted); }
.runs__rows { color: var(--fg-muted); font-variant-numeric: tabular-nums; }
.runs__trigger {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--fg-subtle);
  letter-spacing: 0.04em;
}

.run-detail {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 14px;
}
.run-detail h4 {
  margin: 0 0 8px;
  font-size: 13px;
  font-weight: 500;
}
.run-detail__err {
  margin: 0 0 8px;
  padding: 8px 12px;
  background: rgba(220, 80, 80, 0.08);
  color: var(--error);
  font-family: var(--font-mono);
  font-size: 12px;
  border-radius: var(--radius-sm);
  white-space: pre-wrap;
}
.run-detail__log {
  margin: 0;
  max-height: 360px;
  overflow: auto;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--code-fg);
  white-space: pre-wrap;
  word-break: break-word;
}
</style>
