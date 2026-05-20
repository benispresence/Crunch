<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { usePipelinesStore } from "@/stores/pipelines";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * Pipelines list. One card per saved pipeline showing last-run
 * status, schedule, and quick "Run now". Detail view lives at
 * /pipelines/:id (PipelineDetailView.vue) and gets the full Monaco
 * editor + run-history panel.
 */

const router = useRouter();
const ws = useWorkspaceStore();
const pipelines = usePipelinesStore();

onMounted(async () => {
  await Promise.all([
    pipelines.load(),
    ws.connections.length === 0 ? ws.loadConnections() : Promise.resolve(),
  ]);
});

const creating = ref(false);
const newName = ref("");
const newDestId = ref<number | null>(null);
const newSourceType = ref<"rest_api" | "sql" | "file" | "kafka" | "custom">("custom");
const newLoadMode = ref<"replace" | "append" | "merge" | "incremental" | "streaming">("replace");

async function createPipeline() {
  if (!newName.value.trim()) return;
  // Ask the engine for a starter template so the new pipeline doesn't
  // open with an empty editor — common ergonomic miss otherwise.
  let code = "";
  try {
    code = await pipelines.previewTemplate({
      name: newName.value.trim(),
      source_type: newSourceType.value,
      load_mode: newLoadMode.value,
      destination_connection_id: newDestId.value ?? null,
      code_mode: "template",
    });
  } catch {
    /* fall through with empty code; the form lets the user edit it */
  }
  const p = await pipelines.create({
    name: newName.value.trim(),
    source_type: newSourceType.value,
    load_mode: newLoadMode.value,
    destination_connection_id: newDestId.value ?? null,
    python_code: code,
    code_mode: "template",
  });
  creating.value = false;
  newName.value = "";
  newDestId.value = null;
  router.push({ name: "pipeline-detail", params: { id: p.id } });
}

function statusColor(s: string | null): string {
  switch (s) {
    case "success": return "ok";
    case "failed": return "err";
    case "running": return "running";
    case "cancelled": return "muted";
    default: return "muted";
  }
}

function fmtDate(ts: number | null): string {
  if (!ts) return "never";
  return new Date(ts * 1000).toLocaleString();
}

function connectionName(id: number | null): string | null {
  if (id == null) return null;
  return ws.connections.find((c) => c.id === id)?.name ?? null;
}

async function runNow(id: number) {
  try {
    await pipelines.run(id);
  } catch (e) {
    alert(`Run failed: ${(e as Error).message}`);
  }
}

async function remove(id: number) {
  if (!confirm("Delete this pipeline? Run history is removed too.")) return;
  await pipelines.remove(id);
}

const empty = computed(() => pipelines.list.length === 0);
</script>

<template>
  <div class="pipes">
    <header class="pipes__head">
      <div>
        <h1>Pipelines</h1>
        <p>Ingest data into your connections — full / incremental / merge / streaming.</p>
      </div>
      <button class="btn btn-primary btn-sm" @click="creating = !creating">
        {{ creating ? "Cancel" : "+ New pipeline" }}
      </button>
    </header>

    <form v-if="creating" class="pipes__new" @submit.prevent="createPipeline">
      <label>
        <span>Name</span>
        <input v-model="newName" placeholder="e.g. stripe-customers-daily" autofocus required />
      </label>
      <label>
        <span>Destination connection</span>
        <select v-model="newDestId">
          <option :value="null">(pick later)</option>
          <option v-for="c in ws.connections" :key="c.id" :value="c.id">
            {{ c.name }} — {{ c.type }}
          </option>
        </select>
      </label>
      <label>
        <span>Source type</span>
        <select v-model="newSourceType">
          <option value="custom">Custom</option>
          <option value="rest_api">REST API</option>
          <option value="sql">SQL (replicate another DB)</option>
          <option value="file">File</option>
          <option value="kafka">Kafka (streaming)</option>
        </select>
      </label>
      <label>
        <span>Load mode</span>
        <select v-model="newLoadMode">
          <option value="replace">Replace (full load)</option>
          <option value="append">Append (batch)</option>
          <option value="merge">Merge (delta, requires primary key)</option>
          <option value="incremental">Incremental (cursor field)</option>
          <option value="streaming">Streaming (bounded)</option>
        </select>
      </label>
      <button class="btn btn-primary btn-sm" type="submit">Create</button>
    </form>

    <div v-if="empty && !creating" class="pipes__empty">
      <h2>No pipelines yet</h2>
      <p>
        Pipelines move data from a source — REST API, another database, files, a Kafka
        topic — into one of your existing connections. Each pipeline is a Python script
        you can edit; we generate a dlt starter automatically.
      </p>
      <button class="btn btn-primary btn-sm" @click="creating = true">+ Create your first pipeline</button>
    </div>

    <ul v-else class="pipes__list">
      <li
        v-for="p in pipelines.list"
        :key="p.id"
        class="pipes__card"
        @click="router.push({ name: 'pipeline-detail', params: { id: p.id } })"
      >
        <div class="pipes__card-head">
          <span class="pipes__source">{{ p.source_type }}</span>
          <span class="pipes__name">{{ p.name }}</span>
          <span class="pipes__mode pipes__mode--{{ p.load_mode }}">{{ p.load_mode }}</span>
          <span
            v-if="p.last_run_status"
            class="pipes__status"
            :class="`pipes__status--${statusColor(p.last_run_status)}`"
          >{{ p.last_run_status }}</span>
        </div>
        <div class="pipes__card-meta">
          <span v-if="connectionName(p.destination_connection_id)">
            → {{ connectionName(p.destination_connection_id) }}
            <span v-if="p.destination_dataset">/{{ p.destination_dataset }}</span>
          </span>
          <span v-else class="pipes__warn">⚠ no destination</span>
          <span v-if="p.schedule">
            · {{ p.schedule_enabled ? "" : "[paused] " }}<code>{{ p.schedule }}</code>
          </span>
          <span v-if="p.last_run_at">
            · last run {{ fmtDate(p.last_run_at) }}
          </span>
        </div>
        <div v-if="p.description" class="pipes__desc">{{ p.description }}</div>
        <div class="pipes__card-actions" @click.stop>
          <button
            class="btn btn-sm"
            :disabled="!p.destination_connection_id || pipelines.running"
            @click="runNow(p.id)"
          >
            Run now
          </button>
          <button class="btn btn-ghost btn-sm" @click="remove(p.id)">Delete</button>
        </div>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.pipes {
  padding: 28px 36px;
  max-width: 1100px;
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
.pipes__head p {
  color: var(--fg-muted);
  margin: 4px 0 0;
  font-size: 13px;
}
.pipes__new {
  display: grid;
  gap: 10px;
  grid-template-columns: 1fr 1fr 1fr 1fr auto;
  align-items: end;
  padding: 14px;
  background: var(--bg-elev);
  border: 1px solid var(--accent-border);
  border-radius: var(--radius);
  margin-bottom: 18px;
}
.pipes__new label {
  display: grid;
  gap: 4px;
  font-size: 11px;
  color: var(--fg-muted);
}
.pipes__new input,
.pipes__new select {
  font-size: 13px;
  padding: 6px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
}
.pipes__empty {
  display: grid;
  place-items: center;
  text-align: center;
  padding: 60px 20px;
  color: var(--fg-muted);
  gap: 10px;
}
.pipes__empty h2 {
  font-family: var(--font-serif);
  font-weight: 500;
  margin: 0;
}
.pipes__empty p { max-width: 460px; line-height: 1.5; font-size: 13px; }
.pipes__list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 10px;
}
.pipes__card {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
  cursor: pointer;
  display: grid;
  gap: 6px;
  transition: border-color 120ms;
}
.pipes__card:hover { border-color: var(--accent-border); }
.pipes__card-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.pipes__source {
  font-size: 10px;
  font-family: var(--font-mono);
  font-weight: 600;
  letter-spacing: 0.05em;
  text-transform: uppercase;
  background: var(--accent-subtle);
  color: var(--accent);
  padding: 2px 7px;
  border-radius: 999px;
}
.pipes__name { font-weight: 500; color: var(--fg); flex: 1; }
.pipes__mode {
  font-size: 10px;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 3px;
  background: var(--bg);
  color: var(--fg-muted);
  border: 1px solid var(--border);
}
.pipes__status {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 999px;
}
.pipes__status--ok { background: rgba(127, 176, 105, 0.14); color: var(--success); }
.pipes__status--err { background: rgba(224, 122, 95, 0.14); color: var(--error); }
.pipes__status--running { background: var(--accent-subtle); color: var(--accent); }
.pipes__status--muted { background: var(--bg); color: var(--fg-subtle); }
.pipes__card-meta {
  font-size: 11.5px;
  color: var(--fg-subtle);
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
  align-items: center;
}
.pipes__card-meta code {
  font-family: var(--font-mono);
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 3px;
}
.pipes__warn { color: var(--error); }
.pipes__desc { font-size: 12px; color: var(--fg-muted); }
.pipes__card-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}
</style>
