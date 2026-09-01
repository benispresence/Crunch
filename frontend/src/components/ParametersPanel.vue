<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import {
  useWorkspaceStore,
  type ParameterSpec,
  type ParameterType,
  type ParameterValue,
  type ParameterWidget,
} from "@/stores/workspace";
import {
  DATE_POINT_PRESETS,
  DATE_RANGE_PRESETS,
  formatRangeSummary,
  isDateRangeValue,
  isPointPresetId,
  isRangePresetId,
  looksLikeDateColumn,
  stripRelativePrefix,
} from "@/utils/dateFilters";

/**
 * Filter bar that sits above the SQL editor.
 *
 * Type `{{name}}` in SQL (or click + Filter) and a chip appears here.
 * Changing a chip re-runs the query. Optional clauses use
 * `[[ AND col = {{name}} ]]` so an empty chip drops that predicate.
 * Field filters (`type=field` + mapped column) replace `{{name}}` with
 * a SQL clause the way Metabase does — `WHERE {{created_at}}` becomes
 * `created_at >= $1 AND created_at < $2`.
 */

const ws = useWorkspaceStore();

const params = computed(() => ws.parameters);
const adding = ref(false);
const addLabel = ref("");
const addName = ref("");
const addKind = ref<"text" | "number" | "date" | "date_range" | "category" | "boolean">("text");
const addMode = ref<"value" | "equals" | "like" | "clause">("equals");
const addColumn = ref("");
const addInput = ref<HTMLInputElement | null>(null);
const settingsFor = ref<string | null>(null);
const autoRun = ref(true);
const hintOpen = ref(false);

watch(
  () => ws.sql,
  () => ws.syncParametersFromSql(),
  { immediate: true },
);

let runTimer: ReturnType<typeof setTimeout> | null = null;
function isBlankValue(v: ParameterValue | undefined): boolean {
  if (v === undefined || v === null || v === "") return true;
  if (Array.isArray(v)) return v.length === 0;
  if (typeof v === "object") return !v.start && !v.end;
  return false;
}

function scheduleRun() {
  if (!autoRun.value || !ws.activeConnectionId) return;
  const missing = ws.parameters.some(
    (p) => p.required && isBlankValue(ws.parameterValues[p.name]),
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
  if (p.display_name && p.display_name.trim()) return p.display_name.trim();
  return p.name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

function isFieldParam(p: ParameterSpec): boolean {
  return p.type === "field" || Boolean(p.target);
}

function isDateRangeParam(p: ParameterSpec): boolean {
  if (p.widget === "daterange") return true;
  if (p.widget) return false;
  return isFieldParam(p) && looksLikeDateColumn(p.target);
}

function isMonthParam(p: ParameterSpec): boolean {
  return p.widget === "month";
}

function isDatePointParam(p: ParameterSpec): boolean {
  const w = p.widget as ParameterWidget | undefined;
  if (w === "daterange" || w === "month") return false;
  return p.type === "date" || w === "date";
}

function widgetOf(p: ParameterSpec): ParameterWidget {
  if (p.widget) return p.widget;
  if (isFieldParam(p) && looksLikeDateColumn(p.target)) return "daterange";
  if (p.options && p.options.length > 0) return "dropdown";
  if (p.type === "date") return "date";
  if (p.type === "boolean") return "toggle";
  if (p.type === "field") return "dropdown";
  return "input";
}

function valueFor(name: string): string {
  const v = ws.parameterValues[name];
  if (v === undefined || v === null) return "";
  if (typeof v === "object") return "";
  return String(v);
}

function boolValueFor(name: string): boolean {
  return ws.parameterValues[name] === true || ws.parameterValues[name] === "true";
}

function rangeFor(name: string): { start: string; end: string } {
  const v = ws.parameterValues[name];
  if (isDateRangeValue(v)) {
    return { start: String(v.start ?? ""), end: String(v.end ?? "") };
  }
  if (typeof v === "string" && v.includes("~")) {
    const [s, e] = v.split("~", 2);
    return { start: s ?? "", end: e ?? "" };
  }
  return { start: "", end: "" };
}

function setValue(name: string, value: ParameterValue, run = true) {
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
  while (taken.has(name)) name = `${base}_${i++}`;
  return name;
}

function startAdd() {
  adding.value = true;
  settingsFor.value = null;
  addLabel.value = "";
  addName.value = "";
  addKind.value = "text";
  addMode.value = "equals";
  addColumn.value = "";
  nextTick(() => addInput.value?.focus());
}

function cancelAdd() {
  adding.value = false;
}

const addNeedsColumn = computed(() => {
  if (addKind.value === "date_range" || addKind.value === "category") return true;
  if (addKind.value === "boolean") return false;
  return addMode.value === "equals" || addMode.value === "like";
});

function snippetFor(name: string, column: string, kind: typeof addKind.value, mode: typeof addMode.value): string {
  if (kind === "date_range" || kind === "category") {
    return mode === "clause" || !column.trim()
      ? `{{${name}}}`
      : `AND {{${name}}}`;
  }
  if (mode === "value" || mode === "clause") return `{{${name}}}`;
  const col = column.trim() || "column";
  if (mode === "like") {
    return `[[ AND ${col} LIKE '%' || {{${name}}} || '%' ]]`;
  }
  return `[[ AND ${col} = {{${name}}} ]]`;
}

function confirmAdd() {
  const label = addLabel.value.trim() || addName.value.trim() || "filter";
  const name = slugify(addName.value.trim() || label);
  const snippet = snippetFor(name, addColumn.value, addKind.value, addKind.value === "date_range" || addKind.value === "category" ? "clause" : addMode.value);
  ws.insertSql(snippet);
  const isField = addKind.value === "date_range" || addKind.value === "category";
  const type: ParameterType = isField
    ? "field"
    : addKind.value === "date"
      ? "date"
      : addKind.value === "boolean"
        ? "boolean"
        : addKind.value === "number"
          ? "number"
          : "text";
  const widget: ParameterWidget = isField
    ? (addKind.value === "date_range" ? "daterange" : "dropdown")
    : addKind.value === "boolean"
      ? "toggle"
      : addKind.value === "date"
        ? "date"
        : "input";
  pendingMeta.value[name] = {
    display_name: label,
    type,
    widget,
    target: isField ? addColumn.value.trim() || undefined : undefined,
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

function dateSelectValue(name: string): string {
  const v = valueFor(name);
  if (!v) return "";
  const key = stripRelativePrefix(v);
  if (isPointPresetId(key)) return key;
  return "";
}

function rangePresetValue(name: string): string {
  const v = ws.parameterValues[name];
  if (typeof v === "string") {
    const key = stripRelativePrefix(v);
    if (isRangePresetId(key)) return key;
  }
  return "";
}

function setRangePart(name: string, side: "start" | "end", value: string) {
  const cur = rangeFor(name);
  const next = { ...cur, [side]: value };
  setValue(name, next);
}

function onTypeChange(p: ParameterSpec, next: ParameterType) {
  const patch: Partial<ParameterSpec> = { type: next };
  if (next === "field" && !p.widget) {
    patch.widget = looksLikeDateColumn(p.target) ? "daterange" : "dropdown";
  }
  if (next === "date") patch.widget = p.widget === "daterange" || p.widget === "month" ? p.widget : "date";
  if (next === "boolean") patch.widget = "toggle";
  patchParam(p.name, patch);
}

function hasChipValue(p: ParameterSpec): boolean {
  if (p.type === "boolean") return boolValueFor(p.name);
  return !isBlankValue(ws.parameterValues[p.name]);
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
          'filters__chip--on': hasChipValue(p),
          'filters__chip--open': settingsFor === p.name,
          'filters__chip--required': p.required && !hasChipValue(p),
          'filters__chip--range': isDateRangeParam(p) && !rangePresetValue(p.name),
        }"
      >
        <span class="filters__label" :title="p.target ? `${p.name} → ${p.target}` : p.name">
          {{ labelOf(p) }}
          <em v-if="isFieldParam(p)" class="filters__kind">field</em>
        </span>

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

        <template v-else-if="isMonthParam(p)">
          <input
            class="filters__input filters__input--month"
            type="month"
            :value="valueFor(p.name)"
            @change="(e) => setValue(p.name, (e.target as HTMLInputElement).value)"
          />
        </template>

        <template v-else-if="isDateRangeParam(p)">
          <select
            class="filters__preset"
            :value="rangePresetValue(p.name)"
            :title="formatRangeSummary(ws.parameterValues[p.name])"
            @change="(e) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v) setValue(p.name, v);
              else setValue(p.name, { start: rangeFor(p.name).start, end: rangeFor(p.name).end });
            }"
          >
            <option v-for="d in DATE_RANGE_PRESETS" :key="d.id || 'custom'" :value="d.id">{{ d.label }}</option>
          </select>
          <template v-if="!rangePresetValue(p.name)">
            <input
              class="filters__input filters__input--date"
              type="date"
              :value="rangeFor(p.name).start"
              @change="(e) => setRangePart(p.name, 'start', (e.target as HTMLInputElement).value)"
            />
            <span class="filters__dash">–</span>
            <input
              class="filters__input filters__input--date"
              type="date"
              :value="rangeFor(p.name).end"
              @change="(e) => setRangePart(p.name, 'end', (e.target as HTMLInputElement).value)"
            />
          </template>
          <span
            v-else
            class="filters__summary"
            :title="formatRangeSummary(ws.parameterValues[p.name])"
          >{{ formatRangeSummary(ws.parameterValues[p.name]) }}</span>
        </template>

        <template v-else-if="isDatePointParam(p)">
          <select
            class="filters__preset"
            :value="dateSelectValue(p.name)"
            @change="(e) => {
              const v = (e.target as HTMLSelectElement).value;
              if (v) setValue(p.name, v);
            }"
          >
            <option v-for="d in DATE_POINT_PRESETS" :key="d.id || 'custom'" :value="d.id">{{ d.label }}</option>
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
          v-if="hasChipValue(p)"
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
      <code v-pre>{{name}}</code> is a bind parameter (never concatenated) — use it in
      comparisons like <code v-pre>created_at &gt;= {{start_date}}</code>.
      Wrap a predicate in <code v-pre>[[ AND col = {{name}} ]]</code> to drop it when the
      chip is empty.
      A <strong>field filter</strong> maps <code v-pre>{{name}}</code> to a column and
      replaces the variable with a whole clause
      (<code v-pre>WHERE {{created_at}}</code> → <code>column &gt;= … AND column &lt; …</code>).
      Empty field filters become <code>1=1</code>. Date values are sent as real dates,
      not strings, so Postgres accepts them.
    </p>

    <form v-if="adding" class="filters__composer" @submit.prevent="confirmAdd">
      <label>
        <span>Label</span>
        <input ref="addInput" v-model="addLabel" placeholder="Created at" />
      </label>
      <label>
        <span>SQL name</span>
        <input v-model="addName" placeholder="auto from label" class="filters__mono" />
      </label>
      <label>
        <span>Type</span>
        <select v-model="addKind">
          <option value="text">text</option>
          <option value="number">number</option>
          <option value="date">date</option>
          <option value="date_range">date range (field)</option>
          <option value="category">category (field)</option>
          <option value="boolean">boolean</option>
        </select>
      </label>
      <label v-if="addKind !== 'date_range' && addKind !== 'category' && addKind !== 'boolean'">
        <span>Insert</span>
        <select v-model="addMode">
          <option value="equals">optional equals</option>
          <option value="like">optional contains</option>
          <option value="value">value only</option>
        </select>
      </label>
      <label v-if="addNeedsColumn">
        <span>{{ addKind === 'date_range' || addKind === 'category' ? 'Column (mapped field)' : 'Column' }}</span>
        <input
          v-model="addColumn"
          :placeholder="addKind === 'date_range' || addKind === 'category' ? 'hex.stakes.created_at' : 'status'"
          class="filters__mono"
          list="filter-cols"
        />
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
              @change="(e) => onTypeChange(p, (e.target as HTMLSelectElement).value as ParameterType)"
            >
              <option value="text">text (bind)</option>
              <option value="number">number (bind)</option>
              <option value="date">date (bind)</option>
              <option value="boolean">boolean</option>
              <option value="field">field filter</option>
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
              <option value="daterange">date range</option>
              <option value="month">month</option>
              <option value="toggle">toggle</option>
            </select>
          </label>
          <label v-if="isFieldParam(p) || p.type === 'field'">
            <span>Mapped column</span>
            <input
              class="filters__mono"
              :value="p.target ?? ''"
              placeholder="schema.table.column"
              list="filter-cols"
              @change="(e) => patchParam(p.name, { target: (e.target as HTMLInputElement).value.trim() || undefined, type: 'field' })"
            />
          </label>
          <label v-if="!isDateRangeParam(p) && p.type !== 'boolean' && p.widget !== 'daterange'">
            <span>Default</span>
            <input
              :type="p.type === 'date' || widgetOf(p) === 'date' ? 'date' : p.type === 'number' ? 'number' : widgetOf(p) === 'month' ? 'month' : 'text'"
              :value="p.default == null || typeof p.default === 'object' ? '' : String(p.default)"
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
          <p class="filters__sqlname">
            SQL name <code>{{ p.name }}</code>
            <template v-if="isFieldParam(p)">
              · field filter on <code>{{ p.target || "set a column" }}</code>
              — write <code v-pre>WHERE {{name}}</code>, not a comparison.
            </template>
          </p>
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
.filters__chip--range { border-radius: 10px; }
.filters__label {
  color: var(--fg-muted);
  font-weight: 500;
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 5px;
}
.filters__kind {
  font-style: normal;
  font-size: 9px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--accent);
  background: var(--accent-subtle);
  padding: 1px 5px;
  border-radius: 999px;
}
.filters__input,
.filters__preset {
  font-size: 12px;
  padding: 2px 6px;
  border: none;
  background: transparent;
  color: var(--fg);
  min-width: 88px;
  max-width: 170px;
}
.filters__input--date { min-width: 118px; }
.filters__input--month { min-width: 130px; }
.filters__input:focus,
.filters__preset:focus { outline: none; }
.filters__dash {
  color: var(--fg-subtle);
  padding: 0 2px;
}
.filters__summary {
  font-size: 11px;
  color: var(--fg-subtle);
  padding-right: 4px;
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
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
