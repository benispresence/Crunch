<script setup lang="ts">
import { computed, ref } from "vue";
import { useDashboardsStore, type DashboardFilter } from "@/stores/dashboards";

/**
 * Top-of-dashboard filter strip plus an inline editor (gear icon) for
 * adding/removing the filters themselves. Mirrors Metabase's dashboard
 * filter bar: each chip is a small typed input and edits propagate
 * straight into per-widget renders via the parameter mapping.
 */

const props = defineProps<{ editing: boolean }>();

const dashboards = useDashboardsStore();
const editingFilters = ref(false);

const filters = computed<DashboardFilter[]>(() => dashboards.current?.filters ?? []);

function valueFor(id: string): string {
  const v = dashboards.filterValues[id];
  if (v === undefined || v === null) return "";
  return String(v);
}

function boolValueFor(id: string): boolean {
  const v = dashboards.filterValues[id];
  return v === true || v === "true";
}

function clear(id: string) {
  dashboards.setFilterValue(id, "");
}

function setValue(id: string, v: string | boolean) {
  dashboards.setFilterValue(id, v as string | number | boolean | null);
}

function freshId(): string {
  // ids never need to be globally unique — just unique inside this
  // dashboard. Time-based is fine and human-readable in JSON.
  return `f_${Date.now().toString(36)}`;
}

function addFilter() {
  const next: DashboardFilter[] = [
    ...filters.value,
    { id: freshId(), name: `filter_${filters.value.length + 1}`, type: "text" },
  ];
  void dashboards.saveFilters(next);
}

function removeFilter(id: string) {
  if (!confirm("Remove this filter from the dashboard?")) return;
  void dashboards.saveFilters(filters.value.filter((f) => f.id !== id));
}

function updateFilter(id: string, patch: Partial<DashboardFilter>) {
  void dashboards.saveFilters(
    filters.value.map((f) => (f.id === id ? { ...f, ...patch } : f)),
  );
}
</script>

<template>
  <div v-if="filters.length > 0 || props.editing" class="bar">
    <div class="bar__chips">
      <template v-if="filters.length === 0 && props.editing">
        <span class="bar__empty">No filters yet — add one to the right.</span>
      </template>
      <div v-for="f in filters" :key="f.id" class="bar__chip">
        <span class="bar__label">{{ f.name }}</span>

        <template v-if="f.type === 'boolean'">
          <label class="bar__bool">
            <input
              type="checkbox"
              :checked="boolValueFor(f.id)"
              @change="(e) => setValue(f.id, (e.target as HTMLInputElement).checked)"
            />
            <span>on</span>
          </label>
        </template>
        <template v-else>
          <input
            class="bar__input"
            :type="f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'"
            :value="valueFor(f.id)"
            :placeholder="f.default == null ? 'any' : String(f.default)"
            @input="(e) => setValue(f.id, (e.target as HTMLInputElement).value)"
          />
        </template>

        <button
          v-if="valueFor(f.id) !== ''"
          class="bar__clear"
          title="Clear"
          @click="clear(f.id)"
        >×</button>
      </div>

      <button
        v-if="props.editing"
        class="bar__edit-toggle"
        :class="{ 'bar__edit-toggle--on': editingFilters }"
        @click="editingFilters = !editingFilters"
      >
        {{ editingFilters ? "Done" : "Edit filters" }}
      </button>
      <button
        v-if="props.editing && editingFilters"
        class="btn btn-sm"
        @click="addFilter"
      >+ Filter</button>
    </div>

    <ul v-if="props.editing && editingFilters && filters.length > 0" class="bar__edit-list">
      <li v-for="f in filters" :key="`edit-${f.id}`" class="bar__edit-row">
        <input
          class="bar__edit-name"
          :value="f.name"
          placeholder="filter_name"
          @change="(e) => updateFilter(f.id, { name: (e.target as HTMLInputElement).value })"
        />
        <select
          :value="f.type"
          class="bar__edit-type"
          @change="(e) => updateFilter(f.id, { type: (e.target as HTMLSelectElement).value as DashboardFilter['type'] })"
        >
          <option value="text">text</option>
          <option value="number">number</option>
          <option value="date">date</option>
          <option value="boolean">boolean</option>
        </select>
        <input
          v-if="f.type !== 'boolean'"
          class="bar__edit-default"
          :type="f.type === 'date' ? 'date' : f.type === 'number' ? 'number' : 'text'"
          :value="f.default == null ? '' : String(f.default)"
          placeholder="default (optional)"
          @change="(e) => updateFilter(f.id, { default: (e.target as HTMLInputElement).value || null })"
        />
        <label v-else class="bar__edit-default-bool">
          <input
            type="checkbox"
            :checked="f.default === true"
            @change="(e) => updateFilter(f.id, { default: (e.target as HTMLInputElement).checked })"
          />
          default
        </label>
        <button class="btn btn-ghost btn-sm" @click="removeFilter(f.id)">Remove</button>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.bar {
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  padding: 8px 24px;
  display: grid;
  gap: 8px;
}
.bar__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}
.bar__empty { color: var(--fg-subtle); font-size: 12px; }
.bar__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 4px 2px 10px;
  font-size: 12px;
}
.bar__label {
  color: var(--fg-muted);
  font-family: var(--font-mono);
}
.bar__input {
  font-size: 12px;
  padding: 3px 6px;
  border: none;
  background: transparent;
  color: var(--fg);
  width: 130px;
}
.bar__input:focus { outline: none; }
.bar__bool {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  font-size: 12px;
  color: var(--fg-muted);
}
.bar__clear {
  background: transparent;
  border: none;
  color: var(--fg-subtle);
  width: 18px;
  height: 18px;
  border-radius: 50%;
  cursor: pointer;
}
.bar__clear:hover { background: var(--bg-hover); color: var(--fg); }
.bar__edit-toggle {
  margin-left: auto;
  background: transparent;
  border: 1px dashed var(--border-strong);
  color: var(--fg-muted);
  padding: 3px 10px;
  border-radius: 999px;
  font-size: 12px;
  cursor: pointer;
}
.bar__edit-toggle--on {
  border-style: solid;
  border-color: var(--accent-border);
  color: var(--accent);
  background: var(--accent-subtle);
}
.bar__edit-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
.bar__edit-row {
  display: grid;
  grid-template-columns: 1fr 110px 160px auto;
  gap: 6px;
  align-items: center;
}
.bar__edit-name,
.bar__edit-type,
.bar__edit-default {
  font-size: 12px;
  padding: 4px 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
}
.bar__edit-name { font-family: var(--font-mono); }
.bar__edit-default-bool {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--fg-muted);
}
</style>
