<script setup lang="ts">
import { computed, watch } from "vue";
import { useWorkspaceStore } from "@/stores/workspace";

/**
 * The variables strip that sits above the SQL editor. It mirrors the
 * Metabase "Variables" sidebar: every {{name}} you type in the editor
 * appears here with a type + default selector, and an inline input the
 * user can fill in to run the query.
 *
 * The panel doesn't own state — it reads/writes ``ws.parameters`` and
 * ``ws.parameterValues``. The SqlEditor calls ``syncParametersFromSql``
 * on each keystroke so this stays current.
 */

const ws = useWorkspaceStore();

const params = computed(() => ws.parameters);

watch(
  () => ws.sql,
  () => ws.syncParametersFromSql(),
  { immediate: true },
);

function setValue(name: string, value: string) {
  // Empty string = "unset" → engine drops optional clauses.
  ws.parameterValues = { ...ws.parameterValues, [name]: value };
}

function setBoolValue(name: string, value: boolean) {
  ws.parameterValues = { ...ws.parameterValues, [name]: value };
}

function setType(name: string, type: "text" | "number" | "date" | "boolean") {
  ws.parameters = ws.parameters.map((p) => (p.name === name ? { ...p, type } : p));
}

function setRequired(name: string, required: boolean) {
  ws.parameters = ws.parameters.map((p) => (p.name === name ? { ...p, required } : p));
}

function setDefault(name: string, raw: string) {
  ws.parameters = ws.parameters.map((p) => {
    if (p.name !== name) return p;
    if (raw === "") return { ...p, default: null };
    if (p.type === "number") {
      const n = Number(raw);
      return { ...p, default: Number.isFinite(n) ? n : null };
    }
    if (p.type === "boolean") {
      return { ...p, default: raw === "true" };
    }
    return { ...p, default: raw };
  });
}

function valueFor(name: string): string {
  const v = ws.parameterValues[name];
  if (v === undefined || v === null) return "";
  return String(v);
}

function boolValueFor(name: string): boolean {
  return ws.parameterValues[name] === true || ws.parameterValues[name] === "true";
}
</script>

<template>
  <div v-if="params.length > 0" class="vars">
    <div class="vars__header">
      <span class="vars__title">Variables</span>
      <span class="vars__hint">
        <code v-pre>{{name}}</code> for substitution ·
        <code v-pre>[[ AND col = {{name}} ]]</code> for optional clauses
      </span>
    </div>
    <ul class="vars__list">
      <li v-for="p in params" :key="p.name" class="vars__row">
        <span class="vars__name">{{ p.name }}</span>

        <select
          :value="p.type"
          class="vars__type"
          title="Variable type"
          @change="(e) => setType(p.name, (e.target as HTMLSelectElement).value as 'text' | 'number' | 'date' | 'boolean')"
        >
          <option value="text">text</option>
          <option value="number">number</option>
          <option value="date">date</option>
          <option value="boolean">boolean</option>
        </select>

        <template v-if="p.type === 'boolean'">
          <label class="vars__bool">
            <input
              type="checkbox"
              :checked="boolValueFor(p.name)"
              @change="(e) => setBoolValue(p.name, (e.target as HTMLInputElement).checked)"
            />
            value
          </label>
        </template>
        <template v-else>
          <input
            class="vars__value"
            :type="p.type === 'date' ? 'date' : p.type === 'number' ? 'number' : 'text'"
            :value="valueFor(p.name)"
            :placeholder="`value (default: ${p.default ?? '—'})`"
            @input="(e) => setValue(p.name, (e.target as HTMLInputElement).value)"
          />
        </template>

        <input
          class="vars__default"
          :type="p.type === 'date' ? 'date' : p.type === 'number' ? 'number' : 'text'"
          :value="p.default == null ? '' : String(p.default)"
          placeholder="default"
          title="Default used when the variable is left blank"
          @input="(e) => setDefault(p.name, (e.target as HTMLInputElement).value)"
        />

        <label class="vars__req" title="If checked, the query won't run unless a value is provided">
          <input
            type="checkbox"
            :checked="p.required === true"
            @change="(e) => setRequired(p.name, (e.target as HTMLInputElement).checked)"
          />
          required
        </label>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.vars {
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  padding: 8px 12px;
  flex-shrink: 0;
}
.vars__header {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  margin-bottom: 6px;
  gap: 8px;
}
.vars__title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-muted);
}
.vars__hint {
  font-size: 11px;
  color: var(--fg-subtle);
}
.vars__hint code {
  font-family: var(--font-mono);
  background: var(--bg);
  padding: 0 4px;
  border-radius: 3px;
  color: var(--fg-muted);
}
.vars__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
.vars__row {
  display: grid;
  grid-template-columns: 120px 80px 1fr 140px auto;
  gap: 6px;
  align-items: center;
  font-size: 12px;
}
.vars__name {
  font-family: var(--font-mono);
  color: var(--accent);
  font-weight: 500;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.vars__type,
.vars__value,
.vars__default {
  font-size: 12px;
  padding: 3px 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
}
.vars__bool {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--fg-muted);
}
.vars__req {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--fg-subtle);
  font-size: 11px;
  white-space: nowrap;
}
</style>
