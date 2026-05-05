<script setup lang="ts">
import { ref, watch } from "vue";
import { api } from "@/api/client";
import { useWorkspaceStore } from "@/stores/workspace";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "close"): void; (e: "saved", id: number): void }>();

const ws = useWorkspaceStore();

const name = ref("");
const saving = ref(false);
const error = ref("");

watch(
  () => props.open,
  (v) => {
    if (!v) return;
    error.value = "";
    // Pre-fill from the active viz, or leave blank for a new one.
    const active = ws.visualizations.find((vv) => vv.id === ws.activeVizId);
    name.value = active?.name ?? "";
  },
);

async function save() {
  if (!ws.activeConnectionId) {
    error.value = "Pick a connection first";
    return;
  }
  if (!name.value.trim()) {
    error.value = "Name required";
    return;
  }
  saving.value = true;
  error.value = "";
  try {
    const payload: Record<string, unknown> = {
      name: name.value.trim(),
      connection_id: ws.activeConnectionId,
      sql: ws.sql,
      chart_type: ws.chartMode === "python" ? "python" : ws.chartType,
      renderer: ws.chartMode === "python" ? "python" : "plotly",
      config: ws.chartMode === "python" ? {} : ws.chartConfig,
      python_code: ws.chartMode === "python" ? ws.pythonCode : null,
    };
    if (!ws.activeVizId) {
      payload.folder_id = ws.activeFolderId && ws.activeFolderId > 0 ? ws.activeFolderId : null;
    }
    let id: number;
    if (ws.activeVizId) {
      await api.put(`/visualizations/${ws.activeVizId}`, payload);
      id = ws.activeVizId;
    } else {
      const r = await api.post<{ id: number }>("/visualizations", payload);
      id = r.id;
      ws.activeVizId = id;
    }
    await ws.loadVisualizations();
    emit("saved", id);
    emit("close");
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <div v-if="open" class="modal" @click.self="emit('close')">
    <div class="modal__panel">
      <header class="modal__head">
        <h3>{{ ws.activeVizId ? "Update visualization" : "Save visualization" }}</h3>
        <button class="btn btn-ghost btn-icon" @click="emit('close')">×</button>
      </header>

      <div class="modal__body">
        <label>
          <span>Name</span>
          <input v-model="name" placeholder="e.g. Daily revenue" autofocus />
        </label>

        <div class="modal__meta">
          <div class="modal__meta-row">
            <span class="modal__meta-key">Mode</span>
            <span class="modal__meta-val">
              {{ ws.chartMode === "python" ? "Python" : "Chart picker" }}
            </span>
          </div>
          <div v-if="ws.chartMode !== 'python'" class="modal__meta-row">
            <span class="modal__meta-key">Chart type</span>
            <span class="modal__meta-val">{{ ws.chartType }}</span>
          </div>
          <div class="modal__meta-row">
            <span class="modal__meta-key">Connection</span>
            <span class="modal__meta-val">
              {{ ws.connections.find((c) => c.id === ws.activeConnectionId)?.name ?? "—" }}
            </span>
          </div>
        </div>

        <p v-if="error" class="modal__error">{{ error }}</p>
      </div>

      <footer class="modal__foot">
        <button class="btn btn-sm" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="saving" @click="save">
          {{ saving ? "Saving…" : ws.activeVizId ? "Update" : "Save" }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  background: rgba(10, 8, 6, 0.6);
  backdrop-filter: blur(2px);
  display: grid;
  place-items: center;
  z-index: 100;
}
.modal__panel {
  width: 380px;
  max-width: 90vw;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  overflow: hidden;
}
.modal__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.modal__head h3 {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 16px;
  font-weight: 500;
}
.modal__body {
  padding: 16px;
  display: grid;
  gap: 14px;
}
.modal__body label {
  display: grid;
  gap: 5px;
  font-size: 12px;
  color: var(--fg-muted);
}
.modal__meta {
  display: grid;
  gap: 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
}
.modal__meta-row {
  display: flex;
  justify-content: space-between;
  font-size: 12px;
}
.modal__meta-key { color: var(--fg-subtle); }
.modal__meta-val { color: var(--fg); font-weight: 500; }
.modal__error {
  margin: 4px 0 0;
  color: var(--error);
  font-size: 12px;
}
.modal__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
  background: var(--bg);
}
</style>
