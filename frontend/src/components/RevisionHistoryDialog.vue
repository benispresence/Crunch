<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "@/api/client";

/**
 * Reused timeline for a single query or dashboard. The owner picks the
 * `kind` ("query" | "dashboard") and supplies `targetId`. We GET the
 * revision list, render it newest-first, and POST to the revert
 * endpoint on click. A successful revert closes the dialog and emits
 * `reverted` so the parent can reload its in-memory state.
 */

interface Revision {
  id: number;
  source: "save" | "revert" | "agent" | "import";
  source_revision_id: number | null;
  message: string | null;
  git_sha: string | null;
  created_at: number;
}

const props = defineProps<{
  kind: "query" | "dashboard";
  targetId: number;
  title?: string;
}>();
const emit = defineEmits<{
  (e: "close"): void;
  (e: "reverted", revisionId: number): void;
}>();

const revisions = ref<Revision[]>([]);
const loading = ref(true);
const error = ref<string | null>(null);
const busy = ref<number | null>(null);

const basePath = props.kind === "query"
  ? `/queries/${props.targetId}/revisions`
  : `/dashboards/${props.targetId}/revisions`;

async function load() {
  loading.value = true;
  error.value = null;
  try {
    const r = await api.get<{ revisions: Revision[] }>(basePath);
    revisions.value = r.revisions;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    loading.value = false;
  }
}

onMounted(load);

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}

function sourceLabel(s: Revision["source"]): string {
  switch (s) {
    case "revert": return "revert";
    case "agent": return "agent";
    case "import": return "import";
    default: return "save";
  }
}

async function revert(rev: Revision) {
  if (!confirm(
    `Revert to revision #${rev.id}? A new revision will be added on top so this is non-destructive.`,
  )) return;
  busy.value = rev.id;
  try {
    const r = await api.post<{ revision: Revision }>(`${basePath}/${rev.id}/revert`, {});
    emit("reverted", r.revision.id);
    emit("close");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = null;
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog">
      <header class="dialog__head">
        <div>
          <h3>Version history</h3>
          <p class="dialog__sub">{{ title ?? `${kind} #${targetId}` }}</p>
        </div>
        <button class="btn btn-ghost btn-icon" @click="emit('close')">×</button>
      </header>

      <div v-if="loading" class="dialog__state">Loading history…</div>
      <div v-else-if="error" class="dialog__state dialog__state--error">{{ error }}</div>
      <div v-else-if="revisions.length === 0" class="dialog__state">
        No revisions yet — they appear here every time you save.
      </div>
      <ul v-else class="dialog__list">
        <li v-for="(rev, i) in revisions" :key="rev.id" class="dialog__row">
          <div class="dialog__line">
            <span class="dialog__id">#{{ rev.id }}</span>
            <span class="dialog__src" :class="`dialog__src--${rev.source}`">
              {{ sourceLabel(rev.source) }}
            </span>
            <span v-if="i === 0" class="dialog__current">current</span>
            <span class="dialog__time">{{ fmtTime(rev.created_at) }}</span>
          </div>
          <div v-if="rev.message" class="dialog__msg">{{ rev.message }}</div>
          <div class="dialog__meta">
            <span v-if="rev.source === 'revert' && rev.source_revision_id != null">
              ← reverts #{{ rev.source_revision_id }}
            </span>
            <span v-if="rev.git_sha" class="dialog__sha" :title="rev.git_sha">
              git {{ rev.git_sha.slice(0, 7) }}
            </span>
          </div>
          <div class="dialog__actions">
            <button
              v-if="i > 0"
              class="btn btn-sm"
              :disabled="busy === rev.id"
              @click="revert(rev)"
            >
              {{ busy === rev.id ? "Reverting…" : "Revert to this" }}
            </button>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(10, 8, 6, 0.6);
  display: grid;
  place-items: center;
  z-index: 200;
}
.dialog {
  width: 560px;
  max-width: 92vw;
  max-height: 80vh;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  display: flex;
  flex-direction: column;
}
.dialog__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.dialog__head h3 {
  margin: 0 0 2px;
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: 15px;
}
.dialog__sub { margin: 0; font-size: 12px; color: var(--fg-subtle); }
.dialog__state {
  padding: 24px 18px;
  font-size: 13px;
  color: var(--fg-muted);
  text-align: center;
}
.dialog__state--error { color: var(--error); }
.dialog__list {
  list-style: none;
  margin: 0;
  padding: 8px 0;
  overflow-y: auto;
}
.dialog__row {
  display: grid;
  gap: 4px;
  padding: 10px 16px;
  border-bottom: 1px solid var(--border);
}
.dialog__row:last-child { border-bottom: none; }
.dialog__line {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.dialog__id {
  font-family: var(--font-mono);
  color: var(--fg-muted);
  min-width: 48px;
}
.dialog__src {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg);
  color: var(--fg-subtle);
}
.dialog__src--revert { background: rgba(217, 119, 87, 0.12); color: var(--accent); }
.dialog__src--agent { background: rgba(122, 162, 200, 0.14); color: #7aa2c8; }
.dialog__src--import { background: rgba(127, 176, 105, 0.12); color: var(--success); }
.dialog__current {
  font-size: 10px;
  font-weight: 600;
  letter-spacing: 0.05em;
  color: var(--success);
}
.dialog__time {
  margin-left: auto;
  font-size: 11px;
  color: var(--fg-subtle);
  font-variant-numeric: tabular-nums;
}
.dialog__msg {
  font-size: 12px;
  color: var(--fg);
}
.dialog__meta {
  display: flex;
  gap: 12px;
  font-size: 11px;
  color: var(--fg-subtle);
}
.dialog__sha {
  font-family: var(--font-mono);
}
.dialog__actions {
  display: flex;
  justify-content: flex-end;
}
</style>
