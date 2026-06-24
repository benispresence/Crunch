<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "@/api/client";

/**
 * Admin → Pipelines.
 *
 * Surfaces the in-process scheduler: when it last ticked, how many
 * runs are in flight, and the 24h success/failure tallies. Also lets
 * the admin throttle max-concurrent runs — handy when running this on
 * a small box where two heavy pipelines firing at once would tip the
 * machine over.
 */

interface SchedulerStatus {
  running: boolean;
  in_flight_pipeline_ids: number[];
  last_tick_at: number;
  max_concurrent: number;
  total: number;
  scheduled: number;
  success_24h: number;
  failed_24h: number;
}

const status = ref<SchedulerStatus | null>(null);
const error = ref("");
const toast = ref("");
const concurrencyInput = ref(4);

async function load() {
  try {
    const s = await api.get<SchedulerStatus>("/admin/pipelines/scheduler");
    status.value = s;
    concurrencyInput.value = s.max_concurrent;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function saveConcurrency() {
  try {
    const s = await api.put<SchedulerStatus>("/admin/pipelines/scheduler", {
      max_concurrent: concurrencyInput.value,
    });
    status.value = s;
    toast.value = "Concurrency updated.";
    setTimeout(() => (toast.value = ""), 2500);
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function fmtAge(ts: number): string {
  const secs = Math.floor(Date.now() / 1000) - ts;
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

onMounted(load);
</script>

<template>
  <div class="ps">
    <p v-if="error" class="ps__error">{{ error }}</p>
    <p v-if="toast" class="ps__toast">{{ toast }}</p>

    <p class="ps__hint">
      Pipelines run in the Express process — a 30-second tick scans
      <code>pipelines</code> for due cron expressions and launches them
      against the python engine. Concurrency below caps how many can
      run in parallel.
    </p>

    <div v-if="status" class="ps__grid">
      <div class="ps__stat">
        <span class="ps__stat-label">Scheduler</span>
        <span class="ps__stat-val" :class="{ 'ps__stat-val--ok': status.running }">
          {{ status.running ? "running" : "stopped" }}
        </span>
        <small>last tick {{ fmtAge(status.last_tick_at) }}</small>
      </div>
      <div class="ps__stat">
        <span class="ps__stat-label">In flight</span>
        <span class="ps__stat-val">{{ status.in_flight_pipeline_ids.length }}</span>
        <small v-if="status.in_flight_pipeline_ids.length > 0">
          ids: {{ status.in_flight_pipeline_ids.join(", ") }}
        </small>
      </div>
      <div class="ps__stat">
        <span class="ps__stat-label">Pipelines</span>
        <span class="ps__stat-val">{{ status.total }}</span>
        <small>{{ status.scheduled }} scheduled</small>
      </div>
      <div class="ps__stat">
        <span class="ps__stat-label">24h runs</span>
        <span class="ps__stat-val">
          <span class="ps__ok">{{ status.success_24h }} ok</span>
          ·
          <span class="ps__err">{{ status.failed_24h }} fail</span>
        </span>
      </div>
    </div>

    <div v-if="status" class="ps__concurrency">
      <label class="ps__field">
        <span>Max concurrent runs</span>
        <input v-model.number="concurrencyInput" type="number" min="1" max="16" />
      </label>
      <button class="btn btn-sm" @click="load">Refresh</button>
      <button class="btn btn-primary btn-sm" @click="saveConcurrency">Save</button>
    </div>
  </div>
</template>

<style scoped>
.ps { display: grid; gap: 14px; }
.ps__error {
  background: rgba(224, 122, 95, 0.08);
  border: 1px solid rgba(224, 122, 95, 0.3);
  color: var(--error);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  margin: 0;
}
.ps__toast {
  margin: 0;
  padding: 6px 12px;
  background: rgba(127, 176, 105, 0.12);
  color: var(--success);
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.ps__hint {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
  line-height: 1.5;
}
.ps__hint code {
  font-family: var(--font-mono);
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 3px;
}
.ps__grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}
.ps__stat {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  display: grid;
  gap: 4px;
}
.ps__stat-label {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-subtle);
}
.ps__stat-val {
  font-family: var(--font-mono);
  font-size: 18px;
  color: var(--fg);
}
.ps__stat-val--ok { color: var(--success); }
.ps__stat small {
  font-size: 11px;
  color: var(--fg-subtle);
}
.ps__ok { color: var(--success); }
.ps__err { color: var(--error); }
.ps__concurrency {
  display: flex;
  align-items: end;
  gap: 10px;
  padding: 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.ps__field {
  display: grid;
  gap: 4px;
  font-size: 11px;
  color: var(--fg-muted);
}
.ps__field input {
  font-size: 13px;
  padding: 6px 8px;
  width: 100px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
}
</style>
