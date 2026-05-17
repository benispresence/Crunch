<script setup lang="ts">
import { computed, ref } from "vue";
import type { ChatTurn, ToolCall } from "@/stores/chat";

const props = defineProps<{ turn: ChatTurn }>();

const expandedIds = ref<Set<string>>(new Set());

// When >5 tool calls are present, collapse them into a single bar so the
// chat doesn't drown in scaffolding. The user expands the bar to see all.
const aggregated = computed(() => props.turn.toolCalls.length > 5);
const barExpanded = ref(false);

const grouped = computed(() => {
  const counts: Record<string, number> = {};
  for (const c of props.turn.toolCalls) counts[c.name] = (counts[c.name] ?? 0) + 1;
  return Object.entries(counts).sort((a, b) => b[1] - a[1]);
});

const successCount = computed(() => props.turn.toolCalls.filter((c) => c.status === "ok").length);
const errorCount = computed(() => props.turn.toolCalls.filter((c) => c.status === "error").length);
const runningCount = computed(() => props.turn.toolCalls.filter((c) => c.status === "running").length);

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
    <template v-if="aggregated">
      <button
        class="tools__bar"
        :class="{ 'tools__bar--open': barExpanded }"
        type="button"
        @click="barExpanded = !barExpanded"
      >
        <span class="tools__bar-chev">{{ barExpanded ? "▾" : "▸" }}</span>
        <span class="tools__bar-icon">⚙</span>
        <span class="tools__bar-text">
          <strong>{{ turn.toolCalls.length }}</strong> tool calls
        </span>
        <span class="tools__bar-stats">
          <span v-if="runningCount" class="tools__pill tools__pill--running">{{ runningCount }} running</span>
          <span v-if="successCount" class="tools__pill tools__pill--ok">{{ successCount }} ok</span>
          <span v-if="errorCount" class="tools__pill tools__pill--err">{{ errorCount }} failed</span>
        </span>
        <span class="tools__bar-chips">
          <span v-for="[name, count] in grouped.slice(0, 4)" :key="name" class="tools__chip">
            {{ name }}<span class="tools__chip-count">×{{ count }}</span>
          </span>
          <span v-if="grouped.length > 4" class="tools__chip-more">+{{ grouped.length - 4 }}</span>
        </span>
      </button>
      <div v-if="barExpanded" class="tools__bar-body">
        <div v-for="call in turn.toolCalls" :key="call.id" class="tool" :class="`tool--${call.status}`">
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
      </div>
    </template>

    <template v-else>
      <div v-for="call in turn.toolCalls" :key="call.id" class="tool" :class="`tool--${call.status}`">
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
    </template>
  </div>
</template>

<style scoped>
.tools {
  display: grid;
  gap: 6px;
  margin: 8px 0 6px;
}
.tools__bar {
  width: 100%;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--fg-muted);
  cursor: pointer;
  text-align: left;
}
.tools__bar:hover { background: var(--bg-hover); }
.tools__bar--open { border-bottom-left-radius: 0; border-bottom-right-radius: 0; }
.tools__bar-chev {
  font-size: 10px;
  color: var(--fg-subtle);
  width: 12px;
  text-align: center;
}
.tools__bar-icon { color: var(--accent); }
.tools__bar-text strong { color: var(--fg); font-weight: 600; }
.tools__bar-stats {
  display: flex;
  gap: 4px;
  margin-left: auto;
  flex-shrink: 0;
}
.tools__pill {
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--bg);
  border: 1px solid var(--border);
}
.tools__pill--ok { color: var(--success); border-color: rgba(127, 176, 105, 0.4); }
.tools__pill--err { color: var(--error); border-color: rgba(224, 122, 95, 0.4); }
.tools__pill--running { color: var(--accent); border-color: var(--accent-border); }
.tools__bar-chips {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}
.tools__chip {
  font-size: 11px;
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg-muted);
  font-family: var(--font-mono);
}
.tools__chip-count { color: var(--fg-subtle); margin-left: 3px; }
.tools__chip-more { font-size: 10px; color: var(--fg-subtle); }
.tools__bar-body {
  display: grid;
  gap: 4px;
  padding: 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-top: 0;
  border-bottom-left-radius: var(--radius-sm);
  border-bottom-right-radius: var(--radius-sm);
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
