<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useChatStore } from "@/stores/chat";
import PipelineTimeline from "@/components/PipelineTimeline.vue";
import { usePipelinesStore } from "@/stores/pipelines";
import { useWorkspaceStore } from "@/stores/workspace";

const router = useRouter();
const ws = useWorkspaceStore();
const pipelines = usePipelinesStore();

onMounted(async () => {
  await Promise.all([
    pipelines.load(),
    ws.connections.length === 0 ? ws.loadConnections() : Promise.resolve(),
  ]);
  poll = window.setInterval(() => { void pipelines.load(); }, 4000);
});

let poll: number | null = null;
onUnmounted(() => { if (poll) window.clearInterval(poll); });

const creating = ref(false);
const viewMode = ref<"table" | "timeline">("table");
const search = ref("");
const filterSource = ref("");
const filterDest = ref("");
const filterStatus = ref("");
const filterTag = ref("");
const attentionFilter = ref<string | null>(null);

const newPrompt = ref("");
const creationError = ref("");
const proposing = ref(false);
async function proposeFromPrompt() {
  if (!newPrompt.value.trim()) return;
  proposing.value = true;
  creationError.value = "";
  window.dispatchEvent(new Event("crunch-open-chat"));
  try {
    await useChatStore().send(`Create a pipeline proposal from this request. Inspect saved connections and schemas, ask about missing requirements, and propose an editable draft. Do not run or publish it yet. Request: ${newPrompt.value}`);
  } catch(e) { creationError.value = String(e); }
  finally { proposing.value = false; }
}
const newName = ref("");
const newDestId = ref<number | null>(null);
const newSourceType = ref<"rest_api" | "sql" | "file" | "kafka" | "custom">("custom");
const newExtract = ref<"full" | "incremental" | "streaming">("full");
const newWrite = ref<"replace" | "append" | "merge">("replace");

async function createPipeline() {
  if (!newName.value.trim()) return;
  let code = "";
  try {
    code = await pipelines.previewTemplate({
      name: newName.value.trim(),
      source_type: newSourceType.value,
      extract_strategy: newExtract.value,
      write_behavior: newWrite.value,
      destination_connection_id: newDestId.value ?? null,
      code_mode: "template",
    });
  } catch { /* empty editor is fine */ }
  const p = await pipelines.create({
    name: newName.value.trim(),
    description: newPrompt.value.trim() || null,
    source_type: newSourceType.value,
    extract_strategy: newExtract.value,
    write_behavior: newWrite.value,
    destination_connection_id: newDestId.value ?? null,
    python_code: code,
    code_mode: "template",
  });
  creating.value = false;
  newName.value = "";
  newPrompt.value = "";
  newDestId.value = null;
  router.push({ name: "pipeline-detail", params: { id: p.id } });
}

const sources = computed(() => {
  const s = new Set(pipelines.list.map((p) => p.source?.type || p.source_type));
  return [...s];
});
const dests = computed(() => {
  const s = new Set(
    pipelines.list.map((p) => p.destination?.name || "").filter(Boolean),
  );
  return [...s];
});
const tags = computed(() => {
  const s = new Set<string>();
  for (const p of pipelines.list) for (const t of p.tags ?? []) s.add(t);
  return [...s];
});

const filtered = computed(() => {
  return pipelines.list.filter((p) => {
    if (attentionFilter.value && p.attention !== attentionFilter.value) return false;
    if (search.value) {
      const q = search.value.toLowerCase();
      const hay = `${p.name} ${p.description ?? ""} ${p.source?.name ?? ""} ${p.destination?.name ?? ""}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    if (filterSource.value && (p.source?.type || p.source_type) !== filterSource.value) return false;
    if (filterDest.value && p.destination?.name !== filterDest.value) return false;
    if (filterStatus.value && p.execution_health !== filterStatus.value && p.attention !== filterStatus.value) return false;
    if (filterTag.value && !(p.tags ?? []).includes(filterTag.value)) return false;
    return true;
  });
});

function openPipeline(id: number) {
  router.push({ name: "pipeline-detail", params: { id } });
}
function openRun(pipelineId: number, runId: number) {
  router.push({ name: "pipeline-run", params: { id: pipelineId, runId } });
}

function fmtDate(ts: number | null | undefined): string {
  if (!ts) return "never";
  return new Date(ts * 1000).toLocaleString();
}
function fmtDur(secs: number | null | undefined): string {
  if (secs == null) return "—";
  if (secs < 60) return `${secs}s`;
  return `${Math.floor(secs / 60)}m ${secs % 60}s`;
}

const empty = computed(() => pipelines.list.length === 0);
const counts = computed(() => pipelines.counts);
</script>

<template>
  <div class="pipes">
    <header class="pipes__head">
      <div>
        <h1>Pipelines</h1>
        <p>Does anything need my attention?</p>
      </div>
      <button class="btn btn-primary btn-sm" @click="creating = !creating">
        {{ creating ? "Cancel" : "+ New pipeline" }}
      </button>
    </header>

    <form v-if="creating" class="pipes__create" @submit.prevent="createPipeline">
      <h2>What data would you like to bring into Crunch?</h2>
      <p class="pipes__hint">
        Example: “Copy orders from our production Postgres into analytics every hour.
        Use updated_at to pick up changes, deduplicate by order ID, and tell me if it fails.”
      </p>
      <textarea
        v-model="newPrompt"
        rows="3"
        placeholder="Copy orders from our production Postgres into analytics every hour…"
      />
      <button type="button" class="btn btn-primary" :disabled="proposing || !newPrompt.trim()" @click="proposeFromPrompt">{{ proposing ? 'Preparing proposal…' : 'Create with AI' }}</button>
      <p v-if="creationError" role="alert">{{ creationError }}</p>
      <h3>Or configure manually</h3>
      <div class="pipes__create-grid">
        <label>
          <span>Name</span>
          <input v-model="newName" placeholder="orders-hourly" required />
        </label>
        <label>
          <span>Source</span>
          <select v-model="newSourceType">
            <option value="custom">Custom</option>
            <option value="rest_api">REST API</option>
            <option value="sql">SQL</option>
            <option value="file">File</option>
            <option value="kafka">Kafka</option>
          </select>
        </label>
        <label>
          <span>Extract</span>
          <select v-model="newExtract">
            <option value="full">full</option>
            <option value="incremental">incremental</option>
            <option value="streaming">streaming</option>
          </select>
        </label>
        <label>
          <span>Write</span>
          <select v-model="newWrite">
            <option value="replace">replace</option>
            <option value="append">append</option>
            <option value="merge">merge</option>
          </select>
        </label>
        <label>
          <span>Destination</span>
          <select v-model="newDestId">
            <option :value="null">(pick later)</option>
            <option v-for="c in ws.connections" :key="c.id" :value="c.id">
              {{ c.name }} — {{ c.type }}
            </option>
          </select>
        </label>
      </div>
      <button class="btn btn-primary btn-sm" type="submit">Create draft</button>
    </form>

    <div v-if="empty && !creating" class="pipes__empty">
      <h2>What data would you like to bring into Crunch?</h2>
      <p>
        Describe a flow in chat or create a draft. Pipelines move data from a source
        into one of your connections — then publish a version to run it.
      </p>
      <button class="btn btn-primary btn-sm" @click="creating = true">+ Create your first pipeline</button>
    </div>

    <template v-if="!empty">
      <div class="pipes__counts">
        <button
          class="count count--attn"
          :class="{ 'count--on': attentionFilter === 'needs_attention' }"
          @click="attentionFilter = attentionFilter === 'needs_attention' ? null : 'needs_attention'"
        >
          Needs attention <strong>{{ counts.needs_attention }}</strong>
        </button>
        <button
          class="count count--run"
          :class="{ 'count--on': attentionFilter === 'running' }"
          @click="attentionFilter = attentionFilter === 'running' ? null : 'running'"
        >
          Running <strong>{{ counts.running }}</strong>
        </button>
        <button
          class="count count--queue"
          :class="{ 'count--on': attentionFilter === 'queued' }"
          @click="attentionFilter = attentionFilter === 'queued' ? null : 'queued'"
        >
          Queued <strong>{{ counts.queued }}</strong>
        </button>
        <button
          class="count count--ok"
          :class="{ 'count--on': attentionFilter === 'healthy' }"
          @click="attentionFilter = attentionFilter === 'healthy' ? null : 'healthy'"
        >
          Healthy <strong>{{ counts.healthy }}</strong>
        </button>
        <button
          class="count count--pause"
          :class="{ 'count--on': attentionFilter === 'paused' }"
          @click="attentionFilter = attentionFilter === 'paused' ? null : 'paused'"
        >
          Paused <strong>{{ counts.paused }}</strong>
        </button>
      </div>

      <div class="pipes__toolbar">
        <input v-model="search" class="pipes__search" placeholder="Search pipelines…" />
        <select v-model="filterSource">
          <option value="">Source</option>
          <option v-for="s in sources" :key="s" :value="s">{{ s }}</option>
        </select>
        <select v-model="filterDest">
          <option value="">Destination</option>
          <option v-for="d in dests" :key="d" :value="d">{{ d }}</option>
        </select>
        <select v-model="filterStatus">
          <option value="">Status</option>
          <option value="failed">failed</option>
          <option value="healthy">healthy</option>
          <option value="running">running</option>
          <option value="queued">queued</option>
          <option value="paused">paused</option>
        </select>
        <select v-model="filterTag">
          <option value="">Tags</option>
          <option v-for="t in tags" :key="t" :value="t">{{ t }}</option>
        </select>
        <div class="pipes__views">
          <button :class="{ on: viewMode === 'table' }" @click="viewMode = 'table'">Table</button>
          <button :class="{ on: viewMode === 'timeline' }" @click="viewMode = 'timeline'">Timeline</button>
        </div>
      </div>

      <PipelineTimeline v-show="viewMode === 'timeline'" />

      <div v-show="viewMode === 'table'" class="pipes__table-wrap">
        <table class="pipes__table">
          <thead>
            <tr>
              <th>Name and source → destination</th>
              <th>Health and freshness</th>
              <th>Recent runs</th>
              <th>Last successful update</th>
              <th>Schedule and next run</th>
              <th>Duration and rows</th>
              <th>Published version</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="p in filtered"
              :key="p.id"
              class="pipes__row"
              @click="openPipeline(p.id)"
            >
              <td>
                <div class="pipes__name">{{ p.name }}</div>
                <div class="pipes__flow">
                  {{ p.source?.type || p.source_type }}
                  <span v-if="p.source?.name"> ({{ p.source.name }})</span>
                  →
                  {{ p.destination?.name || "—" }}
                  <span v-if="p.destination?.dataset"> / {{ p.destination.dataset }}</span>
                </div>
              </td>
              <td>
                <span class="pill" :class="`pill--${p.execution_health}`">{{ p.execution_health }}</span>
                <span class="pill" :class="`pill--${p.freshness}`">{{ p.freshness }}</span>
              </td>
              <td>
                <div class="strip">
                  <button
                    v-for="r in (p.recent_runs || []).slice(0, 10)"
                    :key="r.id"
                    class="dot"
                    :class="`dot--${r.status}`"
                    :title="`Run ${r.id} ${r.status}`"
                    @click.stop="openRun(p.id, r.id)"
                  />
                </div>
              </td>
              <td>{{ fmtDate(p.last_successful_update) }}</td>
              <td>
                <code v-if="p.schedule">{{ p.schedule }}</code>
                <span v-else>—</span>
                <div class="muted">{{ p.timezone || "UTC" }} · next {{ fmtDate(p.next_run) }}</div>
              </td>
              <td>
                {{ fmtDur(p.duration_seconds) }}
                · {{ p.rows_loaded ?? "—" }} rows
              </td>
              <td>
                <span v-if="p.published_version">v{{ p.published_version.version_number }}</span>
                <span v-else class="muted">draft</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </div>
</template>

<style scoped>
.pipes {
  padding: 28px 36px;
  max-width: 1280px;
  margin: 0 auto;
  height: 100%;
  overflow-y: auto;
}
.pipes__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 18px;
}
.pipes__head h1 {
  font-family: var(--font-serif);
  font-size: 26px;
  font-weight: 500;
  margin: 0;
}
.pipes__head p { color: var(--fg-muted); margin: 4px 0 0; font-size: 13px; }
.pipes__create {
  display: grid;
  gap: 10px;
  padding: 16px;
  background: var(--bg-elev);
  border: 1px solid var(--accent-border);
  border-radius: var(--radius);
  margin-bottom: 18px;
}
.pipes__create h2 { margin: 0; font-family: var(--font-serif); font-weight: 500; font-size: 18px; }
.pipes__hint { color: var(--fg-muted); font-size: 13px; margin: 0; }
.pipes__create textarea,
.pipes__create input,
.pipes__create select {
  font-size: 13px;
  padding: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
  font-family: inherit;
}
.pipes__create-grid {
  display: grid;
  grid-template-columns: repeat(5, 1fr);
  gap: 10px;
}
.pipes__create-grid label { display: grid; gap: 4px; font-size: 11px; color: var(--fg-muted); }
.pipes__empty {
  display: grid;
  place-items: center;
  text-align: center;
  padding: 60px 20px;
  color: var(--fg-muted);
  gap: 10px;
}
.pipes__empty h2 { font-family: var(--font-serif); font-weight: 500; margin: 0; }
.pipes__counts {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 14px;
}
.count {
  border: 1px solid var(--border);
  background: var(--bg-elev);
  color: var(--fg);
  border-radius: 999px;
  padding: 6px 12px;
  font-size: 12.5px;
  cursor: pointer;
  display: flex;
  gap: 8px;
  align-items: center;
}
.count strong { font-variant-numeric: tabular-nums; }
.count--on { border-color: var(--accent); background: var(--accent-subtle); }
.count--attn { color: var(--error); }
.count--ok { color: var(--success); }
.count--run { color: var(--accent); }
.count--queue { color: var(--warn); }
.pipes__toolbar {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 12px;
  align-items: center;
}
.pipes__search {
  flex: 1;
  min-width: 180px;
  padding: 6px 10px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
}
.pipes__toolbar select {
  padding: 6px 8px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--fg);
  border-radius: var(--radius-sm);
}
.pipes__views { display: flex; gap: 4px; margin-left: auto; }
.pipes__views button {
  padding: 5px 10px;
  font-size: 12px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--fg-muted);
  cursor: pointer;
  border-radius: var(--radius-sm);
}
.pipes__views button.on { color: var(--fg); border-color: var(--accent); }
.pipes__table-wrap { overflow-x: auto; border: 1px solid var(--border); border-radius: var(--radius); }
.pipes__table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.pipes__table th {
  text-align: left;
  font-weight: 500;
  color: var(--fg-muted);
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  white-space: nowrap;
}
.pipes__row { cursor: pointer; }
.pipes__row:hover { background: var(--bg-hover); }
.pipes__table td { padding: 10px; border-bottom: 1px solid var(--border); vertical-align: top; }
.pipes__name { font-weight: 500; }
.pipes__flow { color: var(--fg-subtle); font-size: 11.5px; margin-top: 2px; }
.pill {
  display: inline-block;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 7px;
  border-radius: 999px;
  margin-right: 4px;
  background: var(--bg);
  color: var(--fg-muted);
}
.pill--healthy, .pill--fresh { background: rgba(127, 176, 105, 0.14); color: var(--success); }
.pill--failed, .pill--stale { background: rgba(224, 122, 95, 0.14); color: var(--error); }
.pill--running { background: var(--accent-subtle); color: var(--accent); }
.strip { display: flex; gap: 3px; flex-wrap: wrap; }
.dot {
  width: 10px;
  height: 10px;
  border-radius: 2px;
  border: none;
  padding: 0;
  cursor: pointer;
  background: var(--fg-subtle);
}
.dot--success { background: var(--success); }
.dot--failed { background: var(--error); }
.dot--running { background: var(--accent); }
.dot--queued, .dot--retrying { background: var(--warn); }
.dot--cancelled { background: var(--fg-subtle); }
.muted { color: var(--fg-subtle); font-size: 11px; }
code { font-family: var(--font-mono); font-size: 11px; }
</style>
