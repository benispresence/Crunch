<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  useWorkspaceStore,
  type ParameterSpec,
  type ParameterType,
  type ParameterWidget,
} from "@/stores/workspace";

/**
 * Filter bar that sits above the SQL editor.
 *
 * Type `{{name}}` in SQL (or click + Filter) and a chip appears here.
 * Changing a chip re-runs the query. Optional clauses use
 * `[[ AND col = {{name}} ]]` so an empty chip drops that predicate.
 */

const ws = useWorkspaceStore();

const params = computed(() => ws.parameters);
const adding = ref(false);
const addName = ref("");
const addLabel = ref("");
const addType = ref<ParameterType>("text");
const addMode = ref<"value" | "equals" | "like">("equals");
const addColumn = ref("");
const addInput = ref<HTMLInputElement | null>(null);
const settingsFor = ref<string | null>(null);
const autoRun = ref(true);
const hintOpen = ref(false);

const DATE_PRESETS: Array<{ id: string; label: string }> = [
  { id: "", label: "Custom date" },
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "7d", label: "Last 7 days" },
  { id: "30d", label: "Last 30 days" },
  { id: "90d", label: "Last 90 days" },
  { id: "this_month", label: "This month" },
  { id: "this_year", label: "This year" },
];

watch(
  () => ws.sql,
  () => ws.syncParametersFromSql(),
  { immediate: true },
);

let runTimer: ReturnType<typeof setTimeout> | null = null;
function scheduleRun() {
  if (!autoRun.value || !ws.activeConnectionId) return;
  const missing = ws.parameters.some(
    (p) => p.required && (ws.parameterValues[p.name] === undefined || ws.parameterValues[p.name] === null || ws.parameterValues[p.name] === ""),
  );
  if (missing) return;
  if (runTimer) clearTimeout(runTimer);
  runTimer = setTimeout(() => {
    void ws.runSql().catch(() => {});
  }, 380);
}
onBeforeUnmount(() => {
  if (runTimer) clearTimeout(runTimer);
});

function labelOf(p: ParameterSpec): string {
  return (p.display_name && p.display_name.trim()) || p.name;
}

function widgetOf(p: ParameterSpec): ParameterWidget {
  if (p.widget) return p.widget;
  if (p.options && p.options.length > 0) return "dropdown";
  if (p.type === "date") return "date";
  if (p.type === "boolean") return "toggle";
  return "input";
}

function valueFor(name: string): string {
  const v = ws.parameterValues[name];
  if (v === undefined || v === null) return "";
  return String(v);
}

function boolValueFor(name: string): boolean {
  return ws.parameterValues[name] === true || ws.parameterValues[name] === "true";
}

function setValue(name: string, value: string | boolean, run = true) {
  ws.parameterValues = { ...ws.parameterValues, [name]: value };
  if (run) scheduleRun();
}

function clearValue(name: string) {
  const next = { ...ws.parameterValues };
  delete next[name];
  ws.parameterValues = next;
  scheduleRun();
}

function patchParam(name: string, patch: Partial<ParameterSpec>) {
  ws.parameters = ws.parameters.map((p) => (p.name === name ? { ...p, ...patch } : p));
}

function slugify(raw: string): string {
  let base = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  if (!base) base = "filter";
  if (!/^[a-z_]/.test(base)) base = `f_${base}`;
  let name = base;
  let i = 2;
  const taken = new Set(ws.parameters.map((p) => p.name));
  // Also avoid names already in SQL that we haven't synced yet.
  while (taken.has(name)) name = `${base}_${i++}`;
  return name;
}

function startAdd() {
  adding.value = true;
  settingsFor.value = null;
  addLabel.value = "";
  addName.value = "";
  addType.value = "text";
  addMode.value = "equals";
  addColumn.value = "";
  nextTick(() => addInput.value?.focus());
}

function cancelAdd() {
  adding.value = false;
}

function snippetFor(name: string, column: string, mode: "value" | "equals" | "like"): string {
  if (mode === "value") return `{{${name}}}`;
  const col = column.trim() || "column";
  if (mode === "like") {
    return `[[ AND ${col} LIKE '%' || {{${name}}} || '%' ]]`;
  }
  return `[[ AND ${col} = {{${name}}} ]]`;
}

function confirmAdd() {
  const label = addLabel.value.trim() || addName.value.trim() || "filter";
  const name = slugify(addName.value.trim() || label);
  const snippet = snippetFor(name, addColumn.value, addMode.value);
  ws.insertSql(snippet);
  // Spec lands after SQL sync; stash display metadata to merge in.
  pendingMeta.value[name] = {
    display_name: label,
    type: addType.value,
    widget: addType.value === "boolean" ? "toggle" : addType.value === "date" ? "date" : "input",
  };
  adding.value = false;
  settingsFor.value = name;
}

const pendingMeta = ref<Record<string, Partial<ParameterSpec>>>({});
watch(
  () => ws.parameters.map((p) => p.name).join(","),
  () => {
    const meta = pendingMeta.value;
    if (Object.keys(meta).length === 0) return;
    ws.parameters = ws.parameters.map((p) => {
      const extra = meta[p.name];
      if (!extra) return p;
      return { ...p, ...extra };
    });
    pendingMeta.value = {};
  },
);

const resultColumns = computed(() => ws.result?.columns ?? []);

function fillOptionsFromColumn(name: string, column: string) {
  if (!ws.result?.success) return;
  const idx = ws.result.columns.indexOf(column);
  if (idx < 0) return;
  const seen = new Set<string>();
  const options: string[] = [];
  for (const row of ws.result.rows) {
    const v = row[idx];
    if (v == null) continue;
    const s = String(v);
    if (!seen.has(s)) {
      seen.add(s);
      options.push(s);
    }
    if (options.length >= 200) break;
  }
  options.sort((a, b) => a.localeCompare(b));
  patchParam(name, { widget: "dropdown", options });
}

function isDatePreset(v: string): boolean {
  return DATE_PRESETS.some((p) => p.id && p.id === v);
}

function dateSelectValue(name: string): string {
  const v = valueFor(name);
  if (isDatePreset(v) || v.startsWith("relative:")) {
    return v.replace(/^relative:/, "");
  }
  return "";
}
</script>

<template>
  <div class="filters">
    <div class="filters__bar">
      <span class="filters__title">Filters</span>

      <div v-if="params.length === 0 && !adding" class="filters__empty">
        Type <code v-pre>{{name}}</code> in SQL, or add one.
      </div>

      <div
        v-for="p in params"
        :key="p.name"
        class="filters__chip"
        :class="{
          'filters__chip--on': valueFor(p.name) !== '' || boolValueFor(p.name),
          'filters__chip--open': settingsFor === p.name,
          'filters__chip--required': p.required && valueFor(p.name) === '' && !boolValueFor(p.name),
        }"
      >
        <span class="filters__label" :title="p.name">{{ labelOf(p) }}</span>

        <template v-if="widgetOf(p) === 'toggle' || p.type === 'boolean'">
          <label class="filters__bool">
            <input
              type="checkbox"
              :checked="boolValueFor(p.name)"
              @change="(e) => setValue(p.name, (e.target as HTMLInputElement).checked)"
            />
          </label>
        </template>

        <template v-else-if="widgetOf(p) === 'dropdown'">
          <select
            class="filters__input"
            :value="valueFor(p.name)"
            @change="(e) => setValue(p.name, (e.target as HTMLSelectElement).value)"
          >
            <option value="">any</option>
            <option v-for="o in (p.options ?? [])" :key="o" :value="o">{{ o }}</option>
          </select>
        </template>

        <template v-else-if="p.type === 'date' || widgetOf(p) === 'date'">
          <select
            class="filters__preset"
            :value="dateSelectValue(p.name)"
            @change="(e) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v) setValue(p.name, v);
            }"
          >
            <option v-for="d in DATE_PRESETS" :key="d.id || 'custom'" :value="d.id">{{ d.label }}</option>
          </select>
          <input
            v-if="!dateSelectValue(p.name)"
            class="filters__input filters__input--date"
            type="date"
            :value="valueFor(p.name)"
            @change="(e) => setValue(p.name, (e.target as HTMLInputElement).value)"
          />
        </template>

        <input
          v-else
          class="filters__input"
          :type="p.type === 'number' ? 'number' : 'text'"
          :value="valueFor(p.name)"
          :placeholder="p.default == null || p.default === '' ? 'any' : String(p.default)"
          @input="(e) => setValue(p.name, (e.target as HTMLInputElement).value)"
        />

        <button
          v-if="valueFor(p.name) !== '' || (p.type === 'boolean' && boolValueFor(p.name))"
          class="filters__icon"
          title="Clear"
          @click="clearValue(p.name)"
        >×</button>
        <button
          class="filters__icon"
          :class="{ 'filters__icon--on': settingsFor === p.name }"
          title="Filter settings"
          @click="settingsFor = settingsFor === p.name ? null : p.name; adding = false"
        >⚙</button>
      </div>

      <button class="filters__add" :class="{ 'filters__add--on': adding }" @click="adding ? cancelAdd() : startAdd()">
        {{ adding ? "Cancel" : "+ Filter" }}
      </button>

      <label class="filters__autorun" title="Re-run the query when a filter changes">
        <input v-model="autoRun" type="checkbox" />
        Run on change
      </label>

      <button class="filters__help" :class="{ 'filters__help--on': hintOpen }" @click="hintOpen = !hintOpen">
        ?
      </button>
    </div>

    <p v-if="hintOpen" class="filters__hint">
      In SQL, <code v-pre>{{name}}</code> becomes a bind parameter (never concatenated).
      Wrap a predicate in <code v-pre>[[ AND col = {{name}} ]]</code> to drop it when the
      chip is empty. Required filters block the run until they're filled.
    </p>

    <form v-if="adding" class="filters__composer" @submit.prevent="confirmAdd">
      <label>
        <span>Label</span>
        <input ref="addInput" v-model="addLabel" placeholder="Status" />
      </label>
      <label>
        <span>SQL name</span>
        <input v-model="addName" placeholder="auto from label" class="filters__mono" />
      </label>
      <label>
        <span>Type</span>
        <select v-model="addType">
          <option value="text">text</option>
          <option value="number">number</option>
          <option value="date">date</option>
          <option value="boolean">boolean</option>
        </select>
      </label>
      <label>
        <span>Insert</span>
        <select v-model="addMode">
          <option value="equals">optional equals</option>
          <option value="like">optional contains</option>
          <option value="value">value only</option>
        </select>
      </label>
      <label v-if="addMode !== 'value'">
        <span>Column</span>
        <input v-model="addColumn" placeholder="status" class="filters__mono" list="filter-cols" />
      </label>
      <button class="btn btn-primary btn-sm" type="submit">Add</button>
    </form>
    <datalist id="filter-cols">
      <option v-for="c in resultColumns" :key="c" :value="c" />
    </datalist>

    <div v-if="settingsFor" class="filters__settings">
      <template v-for="p in params" :key="`s-${p.name}`">
        <div v-if="p.name === settingsFor" class="filters__settings-grid">
          <label>
            <span>Label</span>
            <input
              :value="p.display_name ?? ''"
              :placeholder="p.name"
              @change="(e) => patchParam(p.name, { display_name: (e.target as HTMLInputElement).value || undefined })"
            />
          </label>
          <label>
            <span>Type</span>
            <select
              :value="p.type"
              @change="(e) => patchParam(p.name, { type: (e.target as HTMLSelectElement).value as ParameterType })"
            >
              <option value="text">text</option>
              <option value="number">number</option>
              <option value="date">date</option>
              <option value="boolean">boolean</option>
            </select>
          </label>
          <label>
            <span>Widget</span>
            <select
              :value="widgetOf(p)"
              @change="(e) => patchParam(p.name, { widget: (e.target as HTMLSelectElement).value as ParameterWidget })"
            >
              <option value="input">input</option>
              <option value="dropdown">dropdown</option>
              <option value="date">date</option>
              <option value="toggle">toggle</option>
            </select>
          </label>
          <label>
            <span>Default</span>
            <input
              :type="p.type === 'date' ? 'date' : p.type === 'number' ? 'number' : 'text'"
              :value="p.default == null ? '' : String(p.default)"
              placeholder="none"
              @change="(e) => {
                const raw = (e.target as HTMLInputElement).value;
                patchParam(p.name, { default: raw === '' ? null : (p.type === 'number' ? Number(raw) : raw) });
              }"
            />
          </label>
          <label class="filters__check">
            <input
              type="checkbox"
              :checked="p.required === true"
              @change="(e) => patchParam(p.name, { required: (e.target as HTMLInputElement).checked })"
            />
            Required to run
          </label>
          <div v-if="widgetOf(p) === 'dropdown'" class="filters__options">
            <label>
              <span>Dropdown choices <em>(one per line)</em></span>
              <textarea
                :value="(p.options ?? []).join('\n')"
                rows="4"
                placeholder="active&#10;pending&#10;closed"
                @change="(e) => patchParam(p.name, {
                  options: (e.target as HTMLTextAreaElement).value.split('\n').map((s) => s.trim()).filter(Boolean),
                })"
              />
            </label>
            <label v-if="resultColumns.length > 0">
              <span>Fill from last result</span>
              <select @change="(e) => {
                const col = (e.target as HTMLSelectElement).value;
                if (col) fillOptionsFromColumn(p.name, col);
                (e.target as HTMLSelectElement).value = '';
              }">
                <option value="">column…</option>
                <option v-for="c in resultColumns" :key="c" :value="c">{{ c }}</option>
              </select>
            </label>
          </div>
          <p class="filters__sqlname">SQL name <code>{{ p.name }}</code></p>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.filters {
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  padding: 8px 12px 10px;
  flex-shrink: 0;
  display: grid;
  gap: 8px;
}
.filters__bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.filters__title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-subtle);
  margin-right: 4px;
}
.filters__empty {
  font-size: 12px;
  color: var(--fg-subtle);
}
.filters__empty code {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 3px;
}
.filters__chip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 2px 4px 2px 10px;
  font-size: 12px;
  min-height: 28px;
}
.filters__chip--on { border-color: var(--accent-border); background: var(--accent-subtle); }
.filters__chip--open { border-color: var(--accent); }
.filters__chip--required { border-color: var(--warn); }
.filters__label {
  color: var(--fg-muted);
  font-weight: 500;
  max-width: 120px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.filters__input,
.filters__preset {
  font-size: 12px;
  padding: 2px 6px;
  border: none;
  background: transparent;
  color: var(--fg);
  min-width: 88px;
  max-width: 160px;
}
.filters__input--date { min-width: 118px; }
.filters__input:focus,
.filters__preset:focus { outline: none; }
.filters__bool {
  display: inline-flex;
  align-items: center;
  padding: 0 6px;
}
.filters__icon {
  background: transparent;
  border: none;
  color: var(--fg-subtle);
  width: 20px;
  height: 20px;
  border-radius: 50%;
  cursor: pointer;
  font-size: 13px;
  line-height: 1;
}
.filters__icon:hover { background: var(--bg-hover); color: var(--fg); }
.filters__icon--on { color: var(--accent); background: var(--accent-subtle); }
.filters__add {
  background: transparent;
  border: 1px dashed var(--border-strong);
  color: var(--fg-muted);
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 12px;
  cursor: pointer;
}
.filters__add:hover,
.filters__add--on {
  border-style: solid;
  border-color: var(--accent-border);
  color: var(--accent);
  background: var(--accent-subtle);
}
.filters__autorun {
  margin-left: auto;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--fg-subtle);
  cursor: pointer;
}
.filters__help {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  border: 1px solid var(--border);
  background: transparent;
  color: var(--fg-subtle);
  cursor: pointer;
  font-size: 12px;
}
.filters__help--on { border-color: var(--accent-border); color: var(--accent); }
.filters__hint {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
  line-height: 1.5;
}
.filters__hint code {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 3px;
}
.filters__composer {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: end;
  padding: 8px 10px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.filters__composer label {
  display: grid;
  gap: 3px;
  font-size: 11px;
  color: var(--fg-subtle);
}
.filters__composer input,
.filters__composer select,
.filters__settings input,
.filters__settings select,
.filters__settings textarea {
  font-size: 12px;
  padding: 4px 7px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
  min-width: 110px;
}
.filters__mono { font-family: var(--font-mono); }
.filters__settings {
  padding: 10px 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.filters__settings-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 8px 12px;
  align-items: end;
}
.filters__settings-grid label {
  display: grid;
  gap: 3px;
  font-size: 11px;
  color: var(--fg-subtle);
}
.filters__check {
  display: inline-flex !important;
  flex-direction: row !important;
  align-items: center;
  gap: 6px;
  font-size: 12px !important;
  color: var(--fg-muted) !important;
  padding-bottom: 4px;
}
.filters__options {
  grid-column: 1 / -1;
  display: grid;
  grid-template-columns: 1fr 180px;
  gap: 10px;
}
.filters__options textarea { width: 100%; min-width: 0; font-family: var(--font-mono); }
.filters__sqlname {
  grid-column: 1 / -1;
  margin: 0;
  font-size: 11px;
  color: var(--fg-subtle);
}
.filters__sqlname code {
  font-family: var(--font-mono);
  color: var(--accent);
}
</style>
