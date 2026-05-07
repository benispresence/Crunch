<script setup lang="ts">
import { computed } from "vue";
import { useWorkspaceStore } from "@/stores/workspace";

const ws = useWorkspaceStore();

const result = computed(() => ws.result);

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value.toLocaleString();
    return value.toLocaleString(undefined, { maximumFractionDigits: 6 });
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
</script>

<template>
  <section class="results">
    <header class="results__bar">
      <div class="results__title">Results</div>
      <div v-if="result" class="results__meta">
        <span>{{ result.row_count.toLocaleString() }} rows</span>
        <span class="results__sep">·</span>
        <span>{{ result.execution_time_ms.toFixed(0) }} ms</span>
      </div>
    </header>

    <div v-if="ws.running" class="results__state">Running query…</div>
    <div v-else-if="!result" class="results__state results__state--muted">
      Run a query to see results here.
    </div>
    <div v-else-if="!result.success" class="results__state results__state--error">
      {{ result.error || "Query failed" }}
    </div>
    <div v-else class="results__scroll">
      <table class="results__table">
        <thead>
          <tr>
            <th v-for="col in result.columns" :key="col">{{ col }}</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(row, i) in result.rows" :key="i">
            <td v-for="(val, j) in row" :key="j">{{ formatCell(val) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.results {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  border-top: 1px solid var(--border);
}
.results__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  flex-shrink: 0;
}
.results__title { font-size: 12px; color: var(--fg-muted); }
.results__meta {
  display: flex;
  gap: 6px;
  font-size: 11px;
  color: var(--fg-subtle);
  font-variant-numeric: tabular-nums;
}
.results__sep { opacity: 0.5; }
.results__state {
  padding: 24px;
  text-align: center;
  color: var(--fg-muted);
}
.results__state--muted { color: var(--fg-subtle); }
.results__state--error { color: var(--error); white-space: pre-wrap; text-align: left; }
.results__scroll { overflow: auto; flex: 1; }
.results__table {
  width: 100%;
  border-collapse: separate;
  border-spacing: 0;
  font-family: var(--font-mono);
  font-size: 12px;
}
.results__table th,
.results__table td {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  border-right: 1px solid var(--border);
  white-space: nowrap;
}
.results__table th {
  position: sticky;
  top: 0;
  background: var(--bg-elev);
  text-align: left;
  font-weight: 500;
  color: var(--fg-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.results__table tbody tr:hover { background: var(--bg-elev); }
</style>
