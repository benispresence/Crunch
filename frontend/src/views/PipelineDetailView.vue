<script setup lang="ts">
import * as monaco from "monaco-editor";
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import PipelineEnvironment from "@/components/PipelineEnvironment.vue";
import PipelineImportsBar, {
  type PipelineImport,
} from "@/components/PipelineImportsBar.vue";
import PipelineLogViewer from "@/components/PipelineLogViewer.vue";
import { useTheme } from "@/composables/theme";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";
import { usePipelinesStore, type PipelineRun } from "@/stores/pipelines";
import { useWorkspaceStore, type SavedPipeline } from "@/stores/workspace";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const ws = useWorkspaceStore();
const pipelines = usePipelinesStore();
const chat = useChatStore();
const { theme } = useTheme();
const monacoTheme = computed(() => (theme.value === "light" ? "nicemeta-light" : "nicemeta-dark"));

const editorHost = ref<HTMLDivElement | null>(null);
let editor: monaco.editor.IStandaloneCodeEditor | null = null;

const pipelineId = computed(() => Number(route.params.id));
const draft = ref<Partial<SavedPipeline> | null>(null);
const saving = ref(false);
const runError = ref("");
const selectedRunId = ref<number | null>(null);
const tab = ref<"overview" | "runs" | "definition" | "versions" | "settings">("overview");
const diffText = ref("");
const diffHost = ref<HTMLDivElement | null>(null);
let diffEditor: monaco.editor.IStandaloneDiffEditor | null = null;
const validationMessage = ref("");
const savedDefinition = ref("");
const definitionKeys = ["name", "description", "source_type", "source_config", "source_connection_id", "destination_connection_id", "destination_dataset", "extract_strategy", "write_behavior", "load_mode", "primary_key", "cursor_field", "python_code", "code_mode", "schedule", "schedule_enabled", "timezone", "quality_checks", "tags", "stream_max_seconds", "stream_max_messages", "scratch_destination_connection_id", "scratch_destination_dataset", "freshness_threshold_seconds"];
function definition(value: Partial<SavedPipeline> | null) { return JSON.stringify(definitionKeys.map(k => (value as Record<string, unknown> | null)?.[k])); }
const dirty = computed(() => definition(draft.value) !== savedDefinition.value);
const published = computed(() =>
  pipelines.versions.find((v) => v.id === pipelines.current?.published_version_id) ?? null,
);
/** True when the editor/draft script is not what "Run published version" will execute. */
const unpublishedCode = computed(() => {
  if (!draft.value || !published.value) return false;
  return (draft.value.python_code ?? "") !== published.value.python_code;
});
function savedPython(): string {
  try {
    const parsed = JSON.parse(savedDefinition.value) as unknown[];
    return String(parsed[definitionKeys.indexOf("python_code")] ?? "");
  } catch {
    return "";
  }
}
function adoptServerDraft(opts: { forceCode?: boolean } = {}) {
  const cur = pipelines.current;
  if (!cur || cur.id !== pipelineId.value) return;
  if (!dirty.value) {
    draft.value = clone(cur);
    savedDefinition.value = definition(draft.value);
    return;
  }
  // Chat Accept / restore can write python_code while this page still holds
  // a stale clone. If the user hasn't edited the script locally, take the
  // server copy so Save/Publish cannot write the old script back.
  if (
    (opts.forceCode || (draft.value?.python_code ?? "") === savedPython())
    && cur.python_code != null
    && cur.python_code !== draft.value?.python_code
  ) {
    draft.value = { ...draft.value, python_code: cur.python_code };
  }
}
let poll: ReturnType<typeof setInterval> | null = null;
let refreshing = false;
const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value));
async function refreshRuns() {
  if (refreshing) return;
  refreshing = true;
  try {
    await pipelines.loadRuns(pipelineId.value);
    if (selectedRunId.value) await pipelines.loadRun(pipelineId.value, selectedRunId.value);
    await pipelines.refreshCurrent(pipelineId.value);
  } catch (e) { runError.value = String(e); }
  finally { refreshing = false; }
}
async function validateDraft() {
  if (!await saveDraft()) return;
  try {
    const r = await pipelines.validate(pipelineId.value);
    validationMessage.value = r.ok ? r.connectivity.message : JSON.stringify(r.issues) + " " + r.connectivity.message;
  } catch(e) { runError.value = String(e); }
}
async function cancel() {
  if (!selectedRunId.value) return;
  try { await pipelines.cancelRun(pipelineId.value, selectedRunId.value); await refreshRuns(); }
  catch(e) { runError.value = String(e); }
}
const backfillStart = ref("");
const backfillEnd = ref("");
const backfillWarning = ref("");

onMounted(async () => {
  await Promise.all([ws.loadConnections(), pipelines.open(pipelineId.value)]);
  if (pipelines.current) { draft.value = clone(pipelines.current); savedDefinition.value = definition(draft.value); }
  const runId = route.params.runId ? Number(route.params.runId) : null;
  if (runId) {
    tab.value = "runs";
    selectedRunId.value = runId;
    await pipelines.loadRun(pipelineId.value, runId);
  }
  await new Promise((r) => requestAnimationFrame(r));
  mountEditor();
  poll = setInterval(() => { void refreshRuns(); }, 2000);
  await pipelines.loadActivity(pipelineId.value);
});

onBeforeUnmount(() => {
  editor?.dispose();
  const models = diffEditor?.getModel(); diffEditor?.dispose(); models?.original.dispose(); models?.modified.dispose();
  if (poll) clearInterval(poll);
});

function mountEditor() {
  if (!editorHost.value || editor) return;
  editor = monaco.editor.create(editorHost.value, {
    value: draft.value?.python_code ?? "",
    language: "python",
    readOnly: draft.value?.code_mode === "template",
    theme: monacoTheme.value,
    fontFamily: "JetBrains Mono, SF Mono, monospace",
    fontSize: 13,
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    automaticLayout: true,
    glyphMargin: true,
    padding: { top: 12, bottom: 12 },
    tabSize: 4,
  });
  editor.onDidChangeModelContent(() => {
    if (!draft.value) return;
    draft.value.python_code = editor!.getValue();
  });
  applyImportDecorations(importIssues.value);
}
watch(() => draft.value?.code_mode, mode => editor?.updateOptions({readOnly: mode === "template"}));
watch(monacoTheme, (t) => monaco.editor.setTheme(t));
watch(
  () => draft.value?.python_code,
  (code) => {
    if (editor && code != null && editor.getValue() !== code) editor.setValue(code);
  },
);
watch(
  () => [pipelines.current?.id, pipelines.current?.updated_at, pipelines.current?.python_code] as const,
  () => adoptServerDraft(),
);

async function saveDraft() {
  if (!draft.value) return;
  saving.value = true;
  runError.value = "";
  try {
    await pipelines.update(pipelineId.value, draft.value);
    draft.value = clone(pipelines.current as SavedPipeline);
    savedDefinition.value = definition(draft.value);
    return true;
  } catch (e) {
    runError.value = (e as Error).message;
    return false;
  } finally {
    saving.value = false;
  }
}

async function publish() {
  if (!await saveDraft()) return;
  try {
    await pipelines.publish(pipelineId.value);
    draft.value = clone(pipelines.current!); savedDefinition.value = definition(draft.value);
    await pipelines.loadActivity(pipelineId.value);
  } catch (e) {
    runError.value = (e as Error).message;
  }
}

async function runPublished() {
  try {
    const r = await pipelines.run(pipelineId.value);
    selectedRunId.value = r.id;
    tab.value = "runs";
    await pipelines.loadRun(pipelineId.value, r.id);
  } catch (e) {
    runError.value = (e as Error).message;
  }
}

async function testDraft() {
  if (!await saveDraft()) return;
  try {
    const r = await pipelines.testDraft(pipelineId.value);
    await pipelines.loadRuns(pipelineId.value);
    await selectRun(r);
  } catch (e) {
    runError.value = (e as Error).message;
  }
}

async function convertToCustom() {
  if (!draft.value) return;
  draft.value.code_mode = "custom";
  await pipelines.update(pipelineId.value, { code_mode: "custom", convert_to_custom: true } as Partial<SavedPipeline>);
}

async function regenerateGenerated() {
  if (!draft.value || draft.value.code_mode === "custom") return;
  try {
    const code = await pipelines.previewTemplate(draft.value);
    draft.value.python_code = code;
    if (editor) editor.setValue(code);
  } catch (e) {
    runError.value = (e as Error).message;
  }
}

async function selectRun(run: PipelineRun) {
  selectedRunId.value = run.id;
  await pipelines.loadRun(pipelineId.value, run.id);
  router.replace({ name: "pipeline-run", params: { id: pipelineId.value, runId: run.id } });
}

async function retry() {
  if (!selectedRunId.value) return;
  try {
    const r = await pipelines.retryRun(pipelineId.value, selectedRunId.value);
    await pipelines.loadRuns(pipelineId.value); await selectRun(r);
  } catch(e) { runError.value = String(e); }
}
async function pauseSchedule() {
  await pipelines.pause(pipelineId.value, true);
}
function viewLogs() {
  document.querySelector(".run-detail")?.scrollIntoView({ behavior: "smooth" });
}
async function askAiInvestigate() {
  const run = selectedRunId.value;
  window.dispatchEvent(new Event("crunch-open-chat"));
  await chat.send(
    `Investigate pipeline ${pipelineId.value} run ${run ?? ""}. Use get_pipeline_run_logs and diagnose_pipeline_failure. Cite log evidence and say whether the cause is likely or confirmed.`,
  );
}
async function restore(versionId: number) {
  await pipelines.restoreVersion(pipelineId.value, versionId);
  if (pipelines.current) { draft.value = clone(pipelines.current); savedDefinition.value = definition(draft.value); }
  tab.value = "definition";
}
async function showDiff(fromId: number, toId: number) {
  const d = await pipelines.versionDiff(pipelineId.value, fromId, toId);
  diffText.value = [
    ...d.config_diff.map((c) => `${c.path}: ${JSON.stringify(c.before)} → ${JSON.stringify(c.after)}`),

  ].join("\n");
  await nextTick();
  if (diffHost.value) {
    const old = diffEditor?.getModel(); diffEditor?.dispose(); old?.original.dispose(); old?.modified.dispose();
    diffEditor = monaco.editor.createDiffEditor(diffHost.value, {readOnly: true, automaticLayout: true, theme: monacoTheme.value});
    diffEditor.setModel({original: monaco.editor.createModel(d.code_diff.before, "python"), modified: monaco.editor.createModel(d.code_diff.after, "python")});
  }
}

async function requestBackfill() {
  try {
    const start = Math.floor(new Date(backfillStart.value).getTime() / 1000);
    const end = Math.floor(new Date(backfillEnd.value).getTime() / 1000);
    if (!Number.isFinite(start) || !Number.isFinite(end)) throw new Error("Choose a start and end date");
    const r = await pipelines.backfill(pipelineId.value, start, end, false) as {warning?: string};
    backfillWarning.value = r.warning || "";
    runError.value = "";
  } catch(e) { runError.value = String(e); }
}
async function confirmBackfill() {
  try {
    const start = Math.floor(new Date(backfillStart.value).getTime() / 1000);
    const end = Math.floor(new Date(backfillEnd.value).getTime() / 1000);
    const run = await pipelines.backfill(pipelineId.value, start, end, true) as PipelineRun;
    backfillWarning.value = "";
    await pipelines.loadRuns(pipelineId.value); await selectRun(run);
  } catch(e) { runError.value = String(e); }
}
watch([backfillStart, backfillEnd], () => { backfillWarning.value = ""; });

function fmtDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  const zone = tab.value === "runs" ? pipelines.runDetail?.timezone : draft.value?.timezone;
  try { return new Date(ts * 1000).toLocaleString(undefined, {timeZone: zone || "UTC", timeZoneName: "short"}); }
  catch { return new Date(ts * 1000).toLocaleString(undefined, {timeZone: "UTC", timeZoneName: "short"}); }
}
function fmtDuration(start: number, end: number | null): string {
  if (!end) return "—";
  const secs = end - start;
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}
function statusColor(s: string | null | undefined): string {
  switch (s) {
    case "success":
    case "healthy":
    case "fresh": return "ok";
    case "failed":
    case "stale": return "err";
    case "running":
    case "queued": return "running";
    default: return "muted";
  }
}

function versionLabel(id?: number | null) { return id ? `v${pipelines.versions.find(v => v.id === id)?.version_number ?? "?"}` : "Draft test"; }
watch(() => route.params.runId, async (id) => {
  if (id) { selectedRunId.value = Number(id); tab.value = "runs"; await pipelines.loadRun(pipelineId.value, Number(id)); }
});
const currentRun = computed(() => pipelines.runDetail ?? null);
const p = computed(() => pipelines.current);

function updateChecks(event: Event) {
  try {
    const parsed = JSON.parse((event.target as HTMLTextAreaElement).value || "[]");
    if (!Array.isArray(parsed)) throw new Error("Quality checks must be an array");
    if (draft.value) draft.value.quality_checks = parsed;
    runError.value = "";
  } catch(e) { runError.value = String(e); }
}
function ensureSourceConfig() {
  if (!draft.value) return {};
  if (!draft.value.source_config) draft.value.source_config = {};
  return draft.value.source_config as Record<string, unknown>;
}

const importIssues = ref<PipelineImport[]>([]);
let importDecos: monaco.editor.IEditorDecorationsCollection | null = null;

function onImports(list: PipelineImport[]) {
  importIssues.value = list;
  applyImportDecorations(list);
}

function applyImportDecorations(list: PipelineImport[]) {
  if (!editor) return;
  if (!importDecos) importDecos = editor.createDecorationsCollection();
  importDecos.set(
    list
      .filter((item) => item.status !== "ok")
      .map((item) => ({
        range: new monaco.Range(item.line, 1, item.line, 1),
        options: {
          isWholeLine: true,
          className:
            item.status === "not_installed"
              ? "pipe-import-missing"
              : "pipe-import-blocked",
          glyphMarginClassName: "pipe-import-glyph",
          hoverMessage: { value: item.detail },
        },
      })),
  );
}

function revealImportLine(line: number) {
  if (!editor) return;
  editor.revealLineInCenter(line);
  editor.setPosition({ lineNumber: line, column: 1 });
  editor.focus();
}

function missingModuleFromText(text: string | null | undefined): string | null {
  if (!text) return null;
  const missing = text.match(/No module named ['\"]([^'\"]+)['\"]/);
  if (missing) return missing[1]!.split(".")[0]!;
  const allowed = text.match(/Module '([^']+)' is not in the allowed package list/);
  if (allowed) return allowed[1]!.split(".")[0]!;
  return null;
}

const runImportHint = computed(() => {
  const run = currentRun.value;
  if (!run || run.status !== "failed") return null;
  const name = missingModuleFromText(run.error_message) || missingModuleFromText(run.log);
  if (!name) return null;
  return name;
});

function openAdminPackages(mod: string) {
  void router.push({ name: "admin", query: { tab: "packages", pkg: mod } });
}
</script>

<template>
  <div v-if="draft" class="detail">
    <header class="detail__head">
      <div class="detail__head-left">
        <button class="btn btn-ghost btn-sm" @click="router.push({ name: 'pipelines' })">← Pipelines</button>
        <input v-model="draft.name" class="detail__name" /><span v-if="dirty" class="muted">Unsaved changes</span>
        <span v-if="p?.execution_health" class="detail__status" :class="`detail__status--${statusColor(p.execution_health)}`">
          {{ p.execution_health }}
        </span>
        <span v-if="p?.freshness" class="detail__status" :class="`detail__status--${statusColor(p.freshness)}`">
          {{ p.freshness }}
        </span>
      </div>
      <div class="detail__head-right">
        <button class="btn btn-ghost btn-sm" :disabled="saving" @click="saveDraft">
          {{ saving ? "Saving…" : "Save draft" }}
        </button>
        <button class="btn btn-sm" :disabled="saving" @click="validateDraft">Validate</button>
        <button class="btn btn-sm" :disabled="saving" @click="testDraft">Test draft</button>
        <button class="btn btn-sm" :disabled="saving" @click="publish">Publish</button>
        <button
          class="btn btn-primary btn-sm"
          :disabled="pipelines.running || !p?.published_version_id"
          @click="runPublished"
        >
          {{ pipelines.running ? "Queuing…" : (published ? `Run published v${published.version_number}` : "Run published version") }}
        </button>
      </div>
    </header>

    <p v-if="unpublishedCode" class="detail__warn" role="status">
      Draft code is not what runs in production.
      <strong>Run published v{{ published?.version_number }}</strong> still executes the last published script.
      Publish to run this draft, or use Test draft. Retry on a failed run also replays that run’s original snapshot, not the editor.
    </p>
    <p v-if="validationMessage" role="status">{{ validationMessage }}</p>
    <p v-if="runError" role="alert" class="detail__error">{{ runError }}</p>

    <div class="detail__tabs">
      <button class="detail__tab" :class="{ 'detail__tab--active': tab === 'overview' }" @click="tab = 'overview'">Overview</button>
      <button class="detail__tab" :class="{ 'detail__tab--active': tab === 'runs' }" @click="tab = 'runs'">Runs</button>
      <button class="detail__tab" :class="{ 'detail__tab--active': tab === 'definition' }" @click="tab = 'definition'">Definition</button>
      <button class="detail__tab" :class="{ 'detail__tab--active': tab === 'versions' }" @click="tab = 'versions'">Versions</button>
      <button class="detail__tab" :class="{ 'detail__tab--active': tab === 'settings' }" @click="tab = 'settings'">Settings</button>
    </div>

    <!-- Overview -->
    <section v-show="tab === 'overview'" class="detail__panel detail__panel--scroll">
      <p class="lede">
        {{ draft.description || "No description yet — this pipeline moves data from source to destination." }}
      </p>
      <div class="flow">
        <div class="flow__step">
          <strong>Source</strong>
          <span>{{ draft.source_type }}{{ p?.source?.name ? ` · ${p.source.name}` : "" }}</span>
        </div>
        <span class="flow__arrow">→</span>
        <div class="flow__step">
          <strong>Processing</strong>
          <span>{{ draft.extract_strategy || "full" }} extract · {{ draft.write_behavior || draft.load_mode }} write</span>
        </div>
        <span class="flow__arrow">→</span>
        <div class="flow__step">
          <strong>Destination</strong>
          <span>{{ p?.destination?.name || "—" }} / {{ draft.destination_dataset || "—" }}</span>
        </div>
      </div>
      <dl class="meta">
        <div><dt>Last successful update</dt><dd>{{ fmtDate(p?.last_successful_update ?? null) }}</dd></div>
        <div><dt>Next run</dt><dd>{{ fmtDate(pipelines.nextRuns[0] ?? p?.next_run ?? null) }}</dd></div>
        <div><dt>Current activity</dt><dd>{{ p?.attention || p?.last_run_status || "idle" }}</dd></div>
        <div><dt>Published version</dt><dd>{{ p?.published_version ? `v${p.published_version.version_number}` : "none" }}</dd></div>
      </dl>
      <h3>Recent runs</h3>
      <div class="strip">
        <button
          v-for="r in (p?.recent_runs || [])"
          :key="r.id"
          class="dot"
          :class="`dot--${r.status}`"
          @click="selectedRunId = r.id; tab = 'runs'; pipelines.loadRun(pipelineId, r.id)"
        >{{ r.status }}</button>
      </div>
      <div v-if="p?.last_failed_run_id" class="failbox">
        Unresolved failure on run #{{ p.last_failed_run_id }}.
        <button class="btn btn-sm" @click="selectedRunId = p.last_failed_run_id!; tab = 'runs'; pipelines.loadRun(pipelineId, p.last_failed_run_id!)">Open run</button>
      </div>
      <h3>Output tables and quality checks</h3>
      <ul class="checks">
        <li v-for="(c, i) in (draft.quality_checks || [])" :key="i">
          {{ (c as any).type }} {{ (c as any).column || "" }}
        </li>
        <li v-if="!(draft.quality_checks || []).length" class="muted">No checks configured yet.</li>
      </ul>
      <h3>Affected dashboards</h3>
      <ul class="checks">
        <li v-for="d in (p?.feeds?.dashboards || [])" :key="d.id">{{ d.name }}</li>
        <li v-for="q in (p?.feeds?.queries || [])" :key="'q'+q.id">Query: {{ q.name }}</li>
        <li v-if="!(p?.feeds?.dashboards || []).length && !(p?.feeds?.queries || []).length" class="muted">
          No queries or dashboards currently reference this pipeline's dataset.
        </li>
      </ul>
    </section>

    <!-- Runs -->
    <section v-show="tab === 'runs'" class="detail__panel detail__panel--scroll">
      <ul class="runs">
        <li v-if="pipelines.runs.length === 0" class="runs__empty">No runs yet.</li>
        <li
          v-for="run in pipelines.runs"
          :key="run.id"
          class="runs__row"
          :class="{ 'runs__row--active': selectedRunId === run.id }"
          @click="selectRun(run)"
        >
          <span class="runs__status" :class="`runs__status--${statusColor(run.status)}`">{{ run.status }}</span>
          <span>{{ fmtDate(run.started_at) }}</span>
          <span>{{ fmtDuration(run.started_at, run.finished_at) }}</span>
          <span>{{ run.rows_loaded ?? "—" }} rows</span>
          <span>{{ run.triggered_by }}{{ run.is_test ? " · test" : "" }}</span>
          <span v-if="run.version_id">{{ versionLabel(run.version_id) }}</span>
        </li>
      </ul>

      <div v-if="currentRun" class="run-detail">
        <div v-if="currentRun.status === 'failed' && currentRun.explanation" class="fail-explain">
          <h4>{{ currentRun.explanation.headline }}</h4>
          <p>{{ currentRun.explanation.explanation }}</p>
          <p class="muted">Cause is <strong>{{ currentRun.explanation.confidence }}</strong>.</p>
          <ul v-if="currentRun.explanation.evidence?.length" class="evidence">
            <li v-for="(e, i) in currentRun.explanation.evidence" :key="i">
              <code>{{ e.line }}</code>
            </li>
          </ul>
          <div class="fail-actions">
            <button v-if="currentRun && ['failed', 'cancelled'].includes(currentRun.status)" class="btn btn-sm" @click="retry">Retry original version</button>
            <button class="btn btn-sm" @click="askAiInvestigate">Ask AI to investigate</button>
            <button class="btn btn-sm" @click="viewLogs">View logs</button>
            <button class="btn btn-sm" @click="pauseSchedule">Pause schedule</button>
          </div>
        </div>
        <div v-else class="fail-actions">
          <button v-if="currentRun && ['failed', 'cancelled'].includes(currentRun.status)" class="btn btn-sm" @click="retry">Retry original version</button>
          <button class="btn btn-sm" @click="askAiInvestigate">Ask AI to investigate</button>
          <button class="btn btn-sm" @click="viewLogs">View logs</button>
          <button class="btn btn-sm" @click="pauseSchedule">Pause schedule</button>
        </div>
        <div v-if="runImportHint" class="import-cta">
          This run failed because <code>{{ runImportHint }}</code> is missing or not allowed in the pipeline worker.
          <button
            v-if="auth.user?.role === 'admin'"
            class="btn btn-primary btn-sm"
            type="button"
            @click="openAdminPackages(runImportHint)"
          >
            Install in Allowed packages
          </button>
          <span v-else class="muted">Ask an admin to install it from Admin → Allowed packages.</span>
        </div>
        <button v-if="['queued', 'running', 'retrying'].includes(currentRun.status)" class="btn btn-sm" @click="cancel">Cancel run</button>
        <h4>Run #{{ currentRun.id }} — {{ currentRun.status }}</h4>
        <dl class="meta">
          <div><dt>Version</dt><dd>{{ versionLabel(currentRun.version_id) }}</dd></div>
          <div><dt>Trigger</dt><dd>{{ currentRun.triggered_by }}</dd></div>
          <div><dt>Attempts</dt><dd>{{ currentRun.attempt_number ?? 1 }}</dd></div>
          <div><dt>Queued</dt><dd>{{ fmtDate((currentRun.timestamps as any)?.queued_at) }}</dd></div>
          <div><dt>Started</dt><dd>{{ fmtDate(currentRun.started_at) }}</dd></div>
          <div><dt>Finished</dt><dd>{{ fmtDate(currentRun.finished_at) }}</dd></div>
          <div v-if="currentRun.processing_interval">
            <dt>Processing interval</dt>
            <dd>{{ fmtDate(currentRun.processing_interval.start) }} → {{ fmtDate(currentRun.processing_interval.end) }}</dd>
          </div>
          <div><dt>Rows</dt><dd>{{ currentRun.output_metrics?.rows_loaded ?? currentRun.rows_loaded ?? "—" }}</dd></div>
        </dl>
        <div v-if="currentRun.attempts?.length">
          <h4>Attempts</h4>
          <ul class="attempts">
            <li v-for="a in currentRun.attempts" :key="String(a.id)"><details><summary>#{{ a.attempt_number }} {{ a.status }} — {{ a.error_message || a.status }}</summary><pre>{{ a.log || "No log output" }}</pre></details></li>
          </ul>
        </div>
        <ul v-if="currentRun.check_results?.length" class="checks">
          <li v-for="(c,i) in currentRun.check_results" :key="i">{{ c.passed === null ? 'Not evaluated' : c.passed ? 'Passed' : 'Failed' }} — {{ c.message }}</li>
        </ul>
        <PipelineLogViewer
          :log="currentRun.log || ''"
          :status="currentRun.status"
          :error-message="currentRun.error_message"
        />
      </div>
    </section>

    <!-- Definition -->
    <section v-show="tab === 'definition'" class="detail__panel detail__panel--code">
      <div class="detail__code-bar">
        <span v-if="draft.code_mode === 'template'" class="generated">
          Generated code — configuration changes do not overwrite custom Python.
          <button class="btn btn-ghost btn-sm" @click="regenerateGenerated">Regenerate from configuration</button>
          <button class="btn btn-sm" @click="convertToCustom">Convert to custom code</button>
        </span>
        <span v-else>
          Custom code — frozen. Configuration changes will not overwrite these edits.
        </span>
      </div>
      <PipelineImportsBar
        :code="draft.python_code || ''"
        @imports="onImports"
        @select-line="revealImportLine"
      />
      <div ref="editorHost" class="detail__editor"></div>
    </section>

    <!-- Versions -->
    <section v-show="tab === 'versions'" class="detail__panel detail__panel--scroll">
      <ul class="versions">
        <li v-for="v in pipelines.versions" :key="v.id" class="versions__row">
          <strong>v{{ v.version_number }}</strong>
          <span>{{ v.change_summary }}</span>
          <span>{{ fmtDate(v.created_at) }}</span>
          <span>{{ v.extract_strategy }} / {{ v.write_behavior }}</span>
          <button
            v-if="pipelines.versions[0] && v.id !== pipelines.versions[0].id"
            class="btn btn-ghost btn-sm"
            @click="showDiff(v.id, pipelines.versions[0]!.id)"
          >Diff vs latest</button>
          <button class="btn btn-sm" @click="restore(v.id)">Restore as new draft</button>
        </li>
        <li v-if="pipelines.versions.length === 0" class="muted">No published versions yet.</li>
      </ul>
      <pre v-if="diffText" class="diff">{{ diffText }}</pre><div ref="diffHost" style="height: 360px; flex-shrink: 0" aria-label="Version code comparison"></div>
      <h3>Activity</h3>
      <button class="btn btn-ghost btn-sm" @click="pipelines.loadActivity(pipelineId)">Refresh activity</button>
      <ul class="activity">
        <li v-for="a in pipelines.activity" :key="String(a.id)">
          {{ a.action }} · {{ fmtDate(a.created_at as number) }}
        </li>
      </ul>
    </section>

    <!-- Settings -->
    <section v-show="tab === 'settings'" class="detail__panel detail__panel--scroll">
      <h3>What data would you like to bring into Crunch?</h3>
      <label class="field field--full">
        <span>Description</span>
        <textarea v-model="draft.description" rows="2"></textarea>
      </label>
      <PipelineEnvironment :pipeline-id="pipelineId" />
      <h3>Source</h3>
      <div class="grid">
        <label class="field">
          <span>Source type</span>
          <select v-model="draft.source_type">
            <option value="custom">Custom</option>
            <option value="rest_api">REST API</option>
            <option value="sql">SQL replication</option>
            <option value="file">File</option>
            <option value="kafka">Kafka</option>
          </select>
        </label>
        <label class="field">
          <span>Source connection</span>
          <select v-model="draft.source_connection_id">
            <option :value="null">(none — use config)</option>
            <option v-for="c in ws.connections" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </label>
        <label v-if="draft.source_type === 'rest_api'" class="field field--full">
          <span>Base URL</span>
          <input :value="String(ensureSourceConfig().base_url ?? '')" @input="ensureSourceConfig().base_url = ($event.target as HTMLInputElement).value" />
        </label>
        <label v-if="draft.source_type === 'sql'" class="field field--full">
          <span>Query</span>
          <textarea :value="String(ensureSourceConfig().query ?? '')" rows="3" @input="ensureSourceConfig().query = ($event.target as HTMLTextAreaElement).value" />
        </label>
      </div>
      <h3>Destination</h3>
      <div class="grid">
        <label class="field">
          <span>Connection</span>
          <select v-model="draft.destination_connection_id">
            <option :value="null">(pick a connection)</option>
            <option v-for="c in ws.connections" :key="'d'+c.id" :value="c.id">{{ c.name }} — {{ c.type }}</option>
          </select>
        </label>
        <label class="field">
          <span>Dataset / schema</span>
          <input v-model="draft.destination_dataset" />
        </label>
        <label class="field">
          <span>Scratch destination (for Test draft)</span>
          <select v-model="draft.scratch_destination_connection_id">
            <option :value="null">(required for Test draft)</option>
            <option v-for="c in ws.connections" :key="'s'+c.id" :value="c.id">{{ c.name }}</option>
          </select>
        </label>
        <label class="field">
          <span>Scratch dataset</span>
          <input v-model="draft.scratch_destination_dataset" placeholder="scratch" />
        </label>
      </div>
      <h3>Extract strategy</h3>
      <div class="modes">
        <button v-for="m in (['full','incremental','streaming'] as const)" :key="m"
          class="mode" :class="{ 'mode--on': draft.extract_strategy === m }"
          @click="draft.extract_strategy = m">{{ m }}</button>
      </div>
      <h3>Write behavior</h3>
      <div class="modes">
        <button v-for="m in (['replace','append','merge'] as const)" :key="m"
          class="mode" :class="{ 'mode--on': draft.write_behavior === m }"
          @click="draft.write_behavior = m">{{ m }}</button>
      </div>
      <div class="grid">
        <label class="field">
          <span>Primary key (merge)</span>
          <input v-model="draft.primary_key" />
        </label>
        <label class="field">
          <span>Cursor field (incremental)</span>
          <input v-model="draft.cursor_field" />
        </label>
      </div>
      <h3>Schedule</h3><p class="muted">Runs execute one at a time per pipeline. Missed schedule windows are coalesced into one run after downtime. Publish to apply schedule changes.</p>
      <div class="grid">
        <label class="field">
          <span>Cron</span>
          <input v-model="draft.schedule" placeholder="0 * * * *" />
        </label>
        <label class="field">
          <span>Timezone</span>
          <input v-model="draft.timezone" placeholder="UTC" />
        </label>
        <label class="field">
          <span>Enabled</span>
          <label class="toggle">
            <input v-model="draft.schedule_enabled" type="checkbox" />
            <span>{{ draft.schedule_enabled ? "scheduler will fire" : "paused" }}</span>
          </label>
        </label>
        <label class="field">
          <span>Freshness threshold (seconds)</span>
          <input v-model.number="draft.freshness_threshold_seconds" type="number" />
        </label>
      </div>
      <h3>Quality checks</h3>
      <p class="muted">unique / not_null / accepted_values / freshness / row_count — stored as JSON.</p>
      <textarea
        class="json"
        :value="JSON.stringify(draft.quality_checks || [], null, 2)"
        rows="6"
        @change="updateChecks"
      />
      <h3>Backfill</h3><p class="muted">Dates use your browser timezone ({{ Intl.DateTimeFormat().resolvedOptions().timeZone }}). The end is exclusive.</p>
      <div class="grid">
        <label class="field"><span>From</span><input v-model="backfillStart" type="datetime-local" /></label>
        <label class="field"><span>To</span><input v-model="backfillEnd" type="datetime-local" /></label>
      </div>
      <button class="btn btn-sm" type="button" @click="requestBackfill">Preview overwrite/duplicate implications</button>
      <p v-if="backfillWarning" class="warn">{{ backfillWarning }}</p>
      <button v-if="backfillWarning" class="btn btn-primary btn-sm" type="button" @click="confirmBackfill">Confirm backfill</button>
      <div class="save-row">
        <button class="btn btn-primary btn-sm" @click="saveDraft">Save draft</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.detail { height: 100%; display: flex; flex-direction: column; background: var(--bg); }
.detail__head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 10px 24px; border-bottom: 1px solid var(--border); background: var(--bg-elev);
}
.detail__head-left, .detail__head-right { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.detail__name {
  font-family: var(--font-serif); font-size: 17px; font-weight: 500;
  background: transparent; border: none; color: var(--fg); outline: none; min-width: 220px;
}
.detail__status {
  font-size: 10px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em;
  padding: 2px 8px; border-radius: 999px;
}
.detail__status--ok { background: rgba(127, 176, 105, 0.14); color: var(--success); }
.detail__status--err { background: rgba(224, 122, 95, 0.14); color: var(--error); }
.detail__status--running { background: var(--accent-subtle); color: var(--accent); }
.detail__status--muted { background: var(--bg); color: var(--fg-subtle); }
.detail__error { margin: 0; padding: 8px 24px; background: rgba(220, 80, 80, 0.08); color: var(--error); font-size: 12px; }
.detail__warn {
  margin: 0;
  padding: 8px 24px;
  background: rgba(200, 160, 60, 0.12);
  color: var(--fg);
  font-size: 12.5px;
  line-height: 1.45;
}
.detail__tabs { display: flex; gap: 4px; padding: 8px 24px 0; border-bottom: 1px solid var(--border); }
.detail__tab {
  padding: 7px 14px; font-size: 12.5px; background: transparent; border: none;
  border-bottom: 2px solid transparent; color: var(--fg-muted); cursor: pointer;
}
.detail__tab--active { color: var(--fg); border-bottom-color: var(--accent); }
.detail__panel { flex: 1; min-height: 0; display: flex; flex-direction: column; }
.detail__panel--scroll { overflow-y: auto; padding: 16px 24px 32px; }
.detail__panel--code { display: flex; flex-direction: column; }
.detail__code-bar { padding: 6px 16px; background: var(--bg-elev); border-bottom: 1px solid var(--border); font-size: 11.5px; color: var(--fg-subtle); display: flex; gap: 8px; align-items: center; }
.detail__editor { flex: 1; min-height: 0; }
.import-cta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin: 10px 0;
  padding: 10px 12px;
  background: rgba(224, 122, 95, 0.08);
  border: 1px solid rgba(224, 122, 95, 0.3);
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.import-cta code { font-family: var(--font-mono); }
:deep(.pipe-import-missing) { background: rgba(224, 122, 95, 0.09); }
:deep(.pipe-import-blocked) { background: rgba(200, 160, 60, 0.12); }
:deep(.pipe-import-glyph) {
  background: var(--error);
  width: 4px !important;
  margin-left: 3px;
  border-radius: 2px;
}
.lede { font-size: 14px; color: var(--fg-muted); }
.flow { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 12px 0; }
.flow__step { background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 10px 12px; display: grid; gap: 4px; }
.flow__step strong { font-size: 11px; text-transform: uppercase; color: var(--fg-subtle); }
.meta { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 10px; }
.meta dt { font-size: 11px; color: var(--fg-subtle); }
.meta dd { margin: 2px 0 0; }
.strip { display: flex; gap: 6px; flex-wrap: wrap; }
.dot { border: none; padding: 4px 8px; border-radius: 4px; font-size: 10px; cursor: pointer; text-transform: uppercase; }
.dot--success { background: rgba(127, 176, 105, 0.14); color: var(--success); }
.dot--failed { background: rgba(224, 122, 95, 0.14); color: var(--error); }
.dot--running { background: var(--accent-subtle); color: var(--accent); }
.failbox, .fail-explain {
  background: rgba(224, 122, 95, 0.08); border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 12px; margin: 12px 0;
}
.fail-actions { display: flex; gap: 6px; flex-wrap: wrap; margin: 8px 0; }
.evidence { font-size: 12px; }
.runs { list-style: none; padding: 0; margin: 0 0 12px; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.runs__empty { padding: 24px; text-align: center; color: var(--fg-muted); }
.runs__row {
  display: grid; grid-template-columns: 90px 1fr 80px 90px 80px 60px; gap: 8px;
  padding: 8px 12px; border-bottom: 1px solid var(--border); cursor: pointer; font-size: 12.5px;
}
.runs__row--active { background: var(--accent-subtle); }
.runs__status { font-size: 10px; font-weight: 600; text-transform: uppercase; padding: 2px 8px; border-radius: 999px; text-align: center; }
.runs__status--ok { background: rgba(127, 176, 105, 0.14); color: var(--success); }
.runs__status--err { background: rgba(224, 122, 95, 0.14); color: var(--error); }
.runs__status--running { background: var(--accent-subtle); color: var(--accent); }
.run-detail { background: var(--bg-elev); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 14px; }
.versions, .activity, .checks, .attempts { list-style: none; padding: 0; }
.versions__row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; padding: 8px 0; border-bottom: 1px solid var(--border); }
.diff { background: var(--code-bg); padding: 10px; font-size: 12px; overflow: auto; }
.grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.field { display: grid; gap: 4px; font-size: 11px; color: var(--fg-muted); }
.field--full { grid-column: 1 / -1; }
.field input, .field select, .field textarea, .json {
  font-size: 13px; padding: 6px 8px; background: var(--bg-elev); border: 1px solid var(--border);
  border-radius: var(--radius-sm); color: var(--fg); font-family: inherit;
}
.json { width: 100%; font-family: var(--font-mono); }
.modes { display: flex; gap: 8px; margin-bottom: 10px; }
.mode { padding: 8px 12px; border: 1px solid var(--border); background: var(--bg-elev); color: var(--fg); cursor: pointer; border-radius: var(--radius-sm); }
.mode--on { border-color: var(--accent); background: var(--accent-subtle); }
.toggle { display: flex; gap: 6px; align-items: center; }
.muted { color: var(--fg-muted); font-size: 12px; }
.warn { color: var(--warn); font-size: 13px; }
.save-row { margin-top: 16px; }
h3 { font-family: var(--font-serif); font-size: 14px; font-weight: 500; margin: 20px 0 8px; }
</style>
