<script setup lang="ts">
import { computed, ref } from "vue";
import type { ChatTurn, ToolCall } from "@/stores/chat";

const props = defineProps<{ turn: ChatTurn }>();

const expandedIds = ref<Set<string>>(new Set());

const aggregated = computed(() => props.turn.toolCalls.length > 5);
const showAll = ref(!aggregated.value);

const visible = computed<ToolCall[]>(() =>
  showAll.value ? props.turn.toolCalls : props.turn.toolCalls.slice(0, 3),
);
const hiddenCount = computed(() => props.turn.toolCalls.length - visible.value.length);

const grouped = computed(() => {
  const counts: Record<string, number> = {};
  for (const c of props.turn.toolCalls) counts[c.name] = (counts[c.name] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
});

function toggle(id: string) {
  if (expandedIds.value.has(id)) expandedIds.value.delete(id);
  else expandedIds.value.add(id);
}

function previewInput(input: unknown): string {
  if (input === undefined) return "";
  if (typeof input === "string") return input.slice(0, 80);
  try {
    return JSON.stringify(input).slice(0, 120);
  } catch {
    return "";
  }
}

function formatResult(result: unknown): string {
  if (result === undefined) return "(running...)";
  try {
    return JSON.stringify(result, null, 2);
  } catch {
    return String(result);
  }
}
</script>

<template>
  <div v-if="turn.toolCalls.length > 0" class="tools">
    <div v-if="aggregated && !showAll" class="tools__summary">
      <div class="tools__summary-head">
        <span class="tools__icon">⚙</span>
        <span class="tools__summary-text">
          Used <strong>{{ turn.toolCalls.length }}</strong> tools
        </span>
      </div>
      <div class="tools__chips">
        <span v-for="[name, count] in grouped" :key="name" class="tools__chip">
          {{ name }} <span class="tools__chip-count">×{{ count }}</span>
        </span>
      </div>
      <button class="btn-ghost tools__expand" type="button" @click="showAll = true">
        Show all calls
      </button>
    </div>

    <div v-for="call in visible" :key="call.id" class="tool" :class="`tool--${call.status}`">
      <button class="tool__head" type="button" @click="toggle(call.id)">
        <span class="tool__status" />
        <span class="tool__name">{{ call.name }}</span>
        <span class="tool__preview">{{ previewInput(call.input) }}</span>
        <span class="tool__chev" :class="{ 'tool__chev--open': expandedIds.has(call.id) }">›</span>
      </button>
      <div v-if="expandedIds.has(call.id)" class="tool__body">
        <div class="tool__section">
          <div class="tool__label">Input</div>
          <pre class="tool__code">{{ formatResult(call.input) }}</pre>
        </div>
        <div class="tool__section">
          <div class="tool__label">Result</div>
          <pre class="tool__code">{{ formatResult(call.result) }}</pre>
        </div>
      </div>
    </div>

    <button
      v-if="aggregated && !showAll && hiddenCount > 0"
      class="btn-ghost tools__more"
      type="button"
      @click="showAll = true"
    >
      + {{ hiddenCount }} more
    </button>
  </div>
</template>

<style scoped>
.tools {
  display: grid;
  gap: 6px;
  margin: 8px 0 6px;
}
.tools__summary {
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  display: grid;
  gap: 8px;
}
.tools__summary-head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--fg-muted);
  font-size: 12px;
}
.tools__icon { color: var(--accent); }
.tools__summary-text strong { color: var(--fg); font-weight: 600; }
.tools__chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.tools__chip {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg-muted);
  font-family: var(--font-mono);
}
.tools__chip-count { color: var(--fg-subtle); }
.tools__expand,
.tools__more {
  font-size: 11px;
  color: var(--accent);
  padding: 4px 0;
  text-align: left;
}
.tool {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
  overflow: hidden;
}
.tool--ok { border-left: 2px solid var(--success); }
.tool--error { border-left: 2px solid var(--error); }
.tool--running { border-left: 2px solid var(--accent); }
.tool__head {
  width: 100%;
  display: grid;
  grid-template-columns: auto auto 1fr auto;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  font-size: 12px;
  text-align: left;
}
.tool__head:hover { background: var(--bg-hover); }
.tool__status {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--fg-subtle);
}
.tool--running .tool__status {
  background: var(--accent);
  animation: pulse 1.2s ease-in-out infinite;
}
.tool--ok .tool__status { background: var(--success); }
.tool--error .tool__status { background: var(--error); }
.tool__name { font-family: var(--font-mono); color: var(--fg); }
.tool__preview {
  color: var(--fg-subtle);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-family: var(--font-mono);
  font-size: 11px;
}
.tool__chev {
  transition: transform 150ms;
  color: var(--fg-subtle);
  font-size: 14px;
  width: 12px;
  text-align: center;
}
.tool__chev--open { transform: rotate(90deg); }
.tool__body {
  padding: 8px 10px 10px;
  border-top: 1px solid var(--border);
  background: var(--bg);
  display: grid;
  gap: 8px;
}
.tool__section { display: grid; gap: 4px; }
.tool__label {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-subtle);
}
.tool__code {
  margin: 0;
  padding: 8px 10px;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--code-fg);
  max-height: 220px;
  overflow: auto;
  white-space: pre;
}

@keyframes pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.4; transform: scale(1.4); }
}
</style>
