<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useDashboardsStore, type DashboardWidget } from "@/stores/dashboards";

const props = defineProps<{ widget: DashboardWidget }>();
const emit = defineEmits<{ (e: "close"): void }>();

const dashboards = useDashboardsStore();
const filters = computed(() => dashboards.current?.filters ?? []);

// Work on a local copy until the user hits Save — otherwise every
// click would round-trip to the backend.
const draft = ref<Record<string, string>>({ ...(props.widget.parameter_mappings ?? {}) });
watch(
  () => props.widget.id,
  () => { draft.value = { ...(props.widget.parameter_mappings ?? {}) }; },
);

const paramOptions = computed(() => props.widget.query_parameters ?? []);

const noParams = computed(() => paramOptions.value.length === 0);

function set(id: string, paramName: string) {
  if (!paramName) {
    const next = { ...draft.value };
    delete next[id];
    draft.value = next;
  } else {
    draft.value = { ...draft.value, [id]: paramName };
  }
}

async function save() {
  await dashboards.saveWidgetMapping(props.widget.id, draft.value);
  emit("close");
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog">
      <header class="dialog__head">
        <div>
          <h3>Connect filters to "{{ widget.title_override ?? widget.source_name }}"</h3>
          <p class="dialog__sub">
            Pick which query variable each dashboard filter feeds. Leave a filter unset to
            ignore it on this chart.
          </p>
        </div>
        <button class="btn btn-ghost btn-icon" @click="emit('close')">×</button>
      </header>

      <div v-if="filters.length === 0" class="dialog__empty">
        This dashboard has no filters yet. Use the "Edit filters" button in the top bar to add one.
      </div>
      <div v-else-if="noParams" class="dialog__empty">
        This chart's underlying query doesn't declare any
        <code v-pre>{{variables}}</code> yet. Open the query in the
        workspace and add a <code v-pre>{{var}}</code> reference first.
      </div>
      <ul v-else class="dialog__list">
        <li v-for="f in filters" :key="f.id" class="dialog__row">
          <span class="dialog__filter">{{ f.name }}<span class="dialog__type">{{ f.type }}</span></span>
          <span class="dialog__arrow">→</span>
          <select
            class="dialog__select"
            :value="draft[f.id] ?? ''"
            @change="(e) => set(f.id, (e.target as HTMLSelectElement).value)"
          >
            <option value="">— not connected —</option>
            <option v-for="p in paramOptions" :key="p.name" :value="p.name">
              {{ p.name }} ({{ p.type }})
            </option>
          </select>
        </li>
      </ul>

      <footer class="dialog__foot">
        <button class="btn btn-sm" @click="emit('close')">Cancel</button>
        <button class="btn btn-primary btn-sm" @click="save">Save mapping</button>
      </footer>
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
  width: 520px;
  max-width: 92vw;
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
  margin: 0 0 4px;
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: 15px;
}
.dialog__sub { margin: 0; font-size: 12px; color: var(--fg-subtle); }
.dialog__empty {
  padding: 24px 18px;
  font-size: 13px;
  color: var(--fg-muted);
  text-align: center;
}
.dialog__empty code {
  font-family: var(--font-mono);
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 3px;
}
.dialog__list {
  list-style: none;
  margin: 0;
  padding: 14px 16px;
  display: grid;
  gap: 8px;
}
.dialog__row {
  display: grid;
  grid-template-columns: 1fr auto 1fr;
  gap: 10px;
  align-items: center;
  font-size: 13px;
}
.dialog__filter {
  font-family: var(--font-mono);
  color: var(--fg);
  display: flex;
  align-items: center;
  gap: 6px;
}
.dialog__type {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--fg-subtle);
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 3px;
}
.dialog__arrow { color: var(--fg-subtle); }
.dialog__select {
  font-size: 12px;
  padding: 5px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
}
.dialog__foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border);
}
</style>
