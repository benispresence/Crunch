<script setup lang="ts">
import { computed, ref } from "vue";
import type { SavedQuery } from "@/stores/workspace";
import { useWorkspaceStore } from "@/stores/workspace";

const props = defineProps<{ query: SavedQuery; depth: number }>();
const ws = useWorkspaceStore();

const connectionName = computed(() => {
  if (props.query.connection_id == null) return null;
  return ws.connections.find((c) => c.id === props.query.connection_id)?.name ?? null;
});
const connectionType = computed(() => {
  if (props.query.connection_id == null) return null;
  return ws.connections.find((c) => c.id === props.query.connection_id)?.type ?? null;
});

const chartGlyph = computed(() => {
  if (props.query.chart_mode === "python") return "py";
  // Compact chart-type abbreviations.
  const t = props.query.chart_type;
  if (!t) return "—";
  if (t === "scatter") return "sc";
  if (t === "histogram") return "hi";
  if (t === "boxplot" || t === "box") return "bx";
  if (t === "heatmap") return "hm";
  if (t === "table") return "tb";
  return t.slice(0, 3);
});

const moveOpen = ref(false);

async function open() {
  await ws.openQuery(props.query);
}
async function remove() {
  if (!confirm(`Delete "${props.query.name}"?`)) return;
  await ws.deleteSavedQuery(props.query.id);
}
async function moveTo(folderId: number | null) {
  moveOpen.value = false;
  await ws.moveQueryToFolder(props.query.id, folderId);
}
</script>

<template>
  <div
    :class="{ 'qrow--active': ws.activeQueryId === query.id }"
    class="qrow"
    :style="{ paddingLeft: `${8 + depth * 12 + 14}px` }"
    @click="open"
  >
    <span
      v-if="connectionType"
      class="qrow__chip qrow__chip--conn"
      :title="connectionName ?? ''"
    >
      {{ connectionType }}
    </span>
    <span
      class="qrow__chip qrow__chip--chart"
      :title="query.chart_mode === 'python' ? 'Custom Python chart' : `Chart: ${query.chart_type}`"
    >
      {{ chartGlyph }}
    </span>
    <span class="qrow__name" :title="query.name">{{ query.name }}</span>
    <button
      class="qrow__act"
      title="Move to collection"
      @click.stop="moveOpen = !moveOpen"
    >⇄</button>
    <button class="qrow__act" title="Delete" @click.stop="remove">×</button>
  </div>
  <div v-if="moveOpen" class="qrow__menu" :style="{ marginLeft: `${8 + depth * 12 + 14}px` }">
    <button class="qrow__menu-item" @click="moveTo(null)">— Uncategorized</button>
    <button
      v-for="f in ws.folders"
      :key="f.id"
      class="qrow__menu-item"
      @click="moveTo(f.id)"
    >
      {{ f.name }}
    </button>
  </div>
</template>

<style scoped>
.qrow {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 4px 6px 4px 24px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
  color: var(--fg);
  min-width: 0;
}
.qrow:hover { background: var(--bg-hover); }
.qrow--active {
  background: var(--accent-subtle);
  box-shadow: inset 0 0 0 1px var(--accent-border);
}
.qrow__chip {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 5px;
  border-radius: 3px;
  background: var(--bg);
  color: var(--fg-subtle);
  flex-shrink: 0;
  font-family: var(--font-mono);
}
.qrow__chip--chart {
  background: var(--accent-subtle);
  color: var(--accent);
}
.qrow__name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.qrow__act {
  width: 18px;
  height: 18px;
  background: transparent;
  border: none;
  color: var(--fg-subtle);
  font-size: 11px;
  padding: 0;
  cursor: pointer;
  border-radius: 3px;
  opacity: 0;
  flex-shrink: 0;
}
.qrow:hover .qrow__act,
.qrow--active .qrow__act { opacity: 1; }
.qrow__act:hover { background: var(--bg-hover); color: var(--fg); }
.qrow__menu {
  display: grid;
  gap: 1px;
  margin-right: 8px;
  padding: 4px;
  background: var(--bg);
  border: 1px solid var(--accent-border);
  border-radius: var(--radius-sm);
  max-height: 180px;
  overflow-y: auto;
}
.qrow__menu-item {
  background: transparent;
  border: none;
  color: var(--fg-muted);
  text-align: left;
  font-size: 12px;
  padding: 4px 8px;
  border-radius: 3px;
  cursor: pointer;
}
.qrow__menu-item:hover { background: var(--bg-hover); color: var(--fg); }
</style>
