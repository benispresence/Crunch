<script setup lang="ts">
import { ref, watch } from "vue";
import { useVisualizationsStore } from "@/stores/visualizations";
import { useWorkspaceStore } from "@/stores/workspace";

const props = defineProps<{ open: boolean }>();
const emit = defineEmits<{ (e: "close"): void; (e: "saved", id: number): void }>();

const ws = useWorkspaceStore();
const vizStore = useVisualizationsStore();

const name = ref("");
const chartType = ref("bar");
const xField = ref("");
const yField = ref("");
const saving = ref(false);
const error = ref("");

watch(
  () => props.open,
  (v) => {
    if (v) {
      name.value = "";
      error.value = "";
      const cols = ws.result?.columns ?? [];
      xField.value = cols[0] ?? "";
      yField.value = cols[1] ?? cols[0] ?? "";
    }
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
    const id = await vizStore.save({
      name: name.value.trim(),
      connection_id: ws.activeConnectionId,
      sql: ws.sql,
      chart_type: chartType.value,
      config: { x: xField.value, y: yField.value },
    });
    await vizStore.load();
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
        <h3>Save visualization</h3>
        <button class="btn btn-ghost btn-icon" @click="emit('close')">×</button>
      </header>

      <div class="modal__body">
        <label>
          <span>Name</span>
          <input v-model="name" placeholder="e.g. Daily revenue" autofocus />
        </label>

        <label>
          <span>Chart type</span>
          <select v-model="chartType">
            <option value="bar">Bar</option>
            <option value="line">Line</option>
            <option value="scatter">Scatter</option>
            <option value="area">Area</option>
            <option value="pie">Pie</option>
            <option value="histogram">Histogram</option>
            <option value="heatmap">Heatmap</option>
          </select>
        </label>

        <div class="modal__row">
          <label>
            <span>X column</span>
            <select v-model="xField">
              <option v-for="c in ws.result?.columns ?? []" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
          <label>
            <span>Y column</span>
            <select v-model="yField">
              <option v-for="c in ws.result?.columns ?? []" :key="c" :value="c">{{ c }}</option>
            </select>
          </label>
        </div>

        <p v-if="error" class="modal__error">{{ error }}</p>
      </div>

      <footer class="modal__foot">
        <button class="btn btn-sm" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary btn-sm" :disabled="saving" @click="save">
          {{ saving ? "Saving…" : "Save" }}
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
  gap: 12px;
}
.modal__body label {
  display: grid;
  gap: 5px;
  font-size: 12px;
  color: var(--fg-muted);
}
.modal__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}
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
