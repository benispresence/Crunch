<script setup lang="ts">
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { useQueryLabels } from "@/composables/queryLabels";
import { absoluteUrl, copyText, queryPath } from "@/utils/links";
import type { SavedQuery } from "@/stores/workspace";
import { useWorkspaceStore } from "@/stores/workspace";

const props = defineProps<{ query: SavedQuery; depth: number }>();
const ws = useWorkspaceStore();
const router = useRouter();
const { showQueryLabels } = useQueryLabels();

const connectionName = computed(() => {
  if (props.query.connection_id == null) return null;
  return ws.connections.find((c) => c.id === props.query.connection_id)?.name ?? null;
});
const connectionType = computed(() => {
  if (props.query.connection_id == null) return null;
  return ws.connections.find((c) => c.id === props.query.connection_id)?.type ?? null;
});

const chartLabel = computed(() => {
  if (props.query.chart_mode === "python") return "Python";
  const t = props.query.chart_type;
  if (!t) return null;
  // Human-readable chart type
  return t.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
});

const moveOpen = ref(false);
const linkToast = ref("");

async function open() {
  // Navigate so the address bar is shareable. WorkspaceView's route watcher
  // opens the query and runs its visualization.
  const path = queryPath(props.query.id, props.query.name);
  if (router.currentRoute.value.path === path || router.currentRoute.value.fullPath.startsWith(path)) {
    await ws.openQuery(props.query);
    return;
  }
  await router.push(path);
}
async function remove() {
  if (!confirm(`Delete "${props.query.name}"?`)) return;
  await ws.deleteSavedQuery(props.query.id);
}
async function moveTo(folderId: number | null) {
  moveOpen.value = false;
  await ws.moveQueryToFolder(props.query.id, folderId);
}
async function copyLink() {
  const url = absoluteUrl(queryPath(props.query.id, props.query.name));
  const ok = await copyText(url);
  linkToast.value = ok ? "Link copied" : "Copy failed";
  setTimeout(() => (linkToast.value = ""), 1500);
}
</script>

<template>
  <div
    :class="{
      'qrow--active': ws.activeQueryId === query.id,
      'qrow--meta': showQueryLabels,
    }"
    class="qrow"
    :style="{ paddingLeft: `${8 + depth * 12 + 14}px` }"
    :title="query.name"
    @click="open"
  >
    <div class="qrow__main">
      <div class="qrow__top">
        <span class="qrow__name">{{ query.name }}</span>
        <span v-if="linkToast" class="qrow__toast">{{ linkToast }}</span>
        <div class="qrow__acts" @click.stop>
          <button class="qrow__act" title="Copy link to this query" @click="copyLink">↗</button>
          <button class="qrow__act" title="Move to collection" @click="moveOpen = !moveOpen">⇄</button>
          <button class="qrow__act" title="Delete" @click="remove">×</button>
        </div>
      </div>
      <div v-if="showQueryLabels" class="qrow__meta">
        <span
          v-if="connectionType"
          class="qrow__tag qrow__tag--conn"
          :title="connectionName ? `${connectionName} (${connectionType})` : connectionType"
        >
          {{ connectionType }}
        </span>
        <span
          v-if="chartLabel"
          class="qrow__tag qrow__tag--chart"
          :title="query.chart_mode === 'python' ? 'Custom Python chart' : `Chart: ${query.chart_type}`"
        >
          {{ chartLabel }}
        </span>
      </div>
    </div>
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
  align-items: flex-start;
  gap: 4px;
  padding: 5px 6px 5px 8px;
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
.qrow--meta {
  padding-top: 5px;
  padding-bottom: 6px;
}
.qrow__main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.qrow__top {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.qrow__name {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.3;
  color: var(--fg);
  /* Allow up to 2 lines so names stay readable in a narrow sidebar */
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  overflow: hidden;
  word-break: break-word;
}
.qrow--active .qrow__name {
  color: var(--accent);
}
.qrow__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  min-width: 0;
}
.qrow__tag {
  font-size: 9.5px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 5px;
  border-radius: 3px;
  background: var(--bg);
  color: var(--fg-subtle);
  font-family: var(--font-mono);
  line-height: 1.4;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.qrow__tag--chart {
  background: var(--accent-subtle);
  color: var(--accent);
  text-transform: none;
  letter-spacing: 0.01em;
  font-family: var(--font-sans);
  font-weight: 500;
}
.qrow__toast {
  font-size: 10px;
  color: var(--accent);
  flex-shrink: 0;
}
.qrow__acts {
  display: flex;
  align-items: center;
  gap: 1px;
  flex-shrink: 0;
  margin-left: 2px;
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
