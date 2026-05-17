<script setup lang="ts">
import { computed, ref } from "vue";
import { useWorkspaceStore } from "@/stores/workspace";
import type { Folder, SavedQuery } from "@/stores/workspace";
import FolderRow from "./FolderRow.vue";
import QueryRow from "./QueryRow.vue";

const ws = useWorkspaceStore();

const expanded = ref<Set<number>>(new Set());
// Pseudo-IDs for the "All" and "Uncategorized" groups. We use negative numbers
// so they never collide with a real folder id.
const ALL_GROUP = -1;
const UNCATEGORIZED_GROUP = -2;
const groupExpanded = ref<Set<number>>(new Set([ALL_GROUP]));

interface FolderNode extends Folder {
  children: FolderNode[];
  depth: number;
}

const tree = computed<FolderNode[]>(() => {
  const byParent = new Map<number | null, Folder[]>();
  for (const f of ws.folders) {
    const list = byParent.get(f.parent_id) ?? [];
    list.push(f);
    byParent.set(f.parent_id, list);
  }
  const build = (parentId: number | null, depth: number): FolderNode[] => {
    const kids = (byParent.get(parentId) ?? []).slice().sort((a, b) =>
      a.sort_order - b.sort_order || a.name.localeCompare(b.name),
    );
    return kids.map((k) => ({ ...k, depth, children: build(k.id, depth + 1) }));
  };
  return build(null, 0);
});

function toggleFolder(id: number) {
  const next = new Set(expanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expanded.value = next;
}

function toggleGroup(id: number) {
  const next = new Set(groupExpanded.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  groupExpanded.value = next;
}

function select(id: number | null) {
  ws.activeFolderId = id;
}

const adding = ref<{ parent: number | null; name: string } | null>(null);
const renaming = ref<{ id: number; name: string } | null>(null);

function startAdd(parent: number | null) {
  adding.value = { parent, name: "" };
  if (parent != null) expanded.value.add(parent);
}

async function commitAdd() {
  if (!adding.value || !adding.value.name.trim()) {
    adding.value = null;
    return;
  }
  await ws.createFolder(adding.value.name.trim(), adding.value.parent);
  adding.value = null;
}

function startRename(f: Folder) {
  renaming.value = { id: f.id, name: f.name };
}

async function commitRename() {
  if (!renaming.value || !renaming.value.name.trim()) {
    renaming.value = null;
    return;
  }
  await ws.renameFolder(renaming.value.id, renaming.value.name.trim());
  renaming.value = null;
}

async function remove(f: Folder) {
  if (!confirm(`Delete folder "${f.name}"? Queries inside become uncategorized.`)) return;
  await ws.deleteFolder(f.id);
}

function queriesInFolder(folderId: number): SavedQuery[] {
  return ws.savedQueries.filter((q) => q.folder_id === folderId);
}

const uncategorized = computed<SavedQuery[]>(() =>
  ws.savedQueries.filter((q) => q.folder_id == null),
);
const allCount = computed(() => ws.savedQueries.length);
</script>

<template>
  <div class="ftree">
    <div class="ftree__heading">
      <span class="ftree__heading-title">Collections</span>
      <button
        class="btn btn-ghost btn-sm"
        title="Start a new empty query"
        @click="ws.newQuery()"
      >
        + Query
      </button>
      <button
        class="btn btn-ghost btn-sm"
        @click="startAdd(null)"
        title="New top-level collection"
      >
        + Folder
      </button>
    </div>

    <!-- All queries group -->
    <button
      class="ftree__row ftree__row--all"
      @click="toggleGroup(ALL_GROUP)"
    >
      <span class="ftree__caret">{{ groupExpanded.has(ALL_GROUP) ? "▾" : "▸" }}</span>
      <span class="ftree__name">All queries</span>
      <span class="ftree__count">{{ allCount }}</span>
    </button>
    <template v-if="groupExpanded.has(ALL_GROUP)">
      <QueryRow v-for="q in ws.savedQueries" :key="`a-${q.id}`" :query="q" :depth="0" />
      <div v-if="ws.savedQueries.length === 0" class="ftree__empty">
        No saved queries yet. Hit <strong>Save</strong> in the editor toolbar.
      </div>
    </template>

    <div
      v-if="adding && adding.parent === null"
      class="ftree__row ftree__row--input"
    >
      <input
        v-model="adding.name"
        placeholder="New collection…"
        autofocus
        class="ftree__input"
        @keyup.enter="commitAdd"
        @keyup.escape="adding = null"
        @blur="commitAdd"
      />
    </div>

    <!-- Folders + their queries -->
    <FolderRow
      v-for="node in tree"
      :key="node.id"
      :node="node"
      :expanded="expanded"
      :renaming="renaming"
      :adding="adding"
      :active-folder-id="ws.activeFolderId"
      :queries-in-folder="queriesInFolder"
      @toggle="toggleFolder"
      @select="select"
      @start-add="startAdd"
      @commit-add="commitAdd"
      @start-rename="startRename"
      @commit-rename="commitRename"
      @cancel-rename="renaming = null"
      @cancel-add="adding = null"
      @remove="remove"
    />

    <!-- Uncategorized group -->
    <button
      v-if="uncategorized.length > 0"
      class="ftree__row ftree__row--orphan"
      @click="toggleGroup(UNCATEGORIZED_GROUP)"
    >
      <span class="ftree__caret">
        {{ groupExpanded.has(UNCATEGORIZED_GROUP) ? "▾" : "▸" }}
      </span>
      <span class="ftree__name">Uncategorized</span>
      <span class="ftree__count">{{ uncategorized.length }}</span>
    </button>
    <template v-if="groupExpanded.has(UNCATEGORIZED_GROUP)">
      <QueryRow v-for="q in uncategorized" :key="`u-${q.id}`" :query="q" :depth="0" />
    </template>
  </div>
</template>

<style scoped>
.ftree {
  display: flex;
  flex-direction: column;
  margin-bottom: 8px;
}
.ftree__heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 4px;
  padding: 6px 4px;
  color: var(--fg-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.ftree__heading-title { font-weight: 600; flex: 1; }
.ftree__row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
  color: var(--fg);
  background: transparent;
  border: none;
  width: 100%;
  text-align: left;
  min-width: 0;
}
.ftree__row:hover { background: var(--bg-hover); }
.ftree__row--all { font-weight: 500; }
.ftree__row--orphan { color: var(--fg-muted); }
.ftree__row--input { padding: 2px 8px; }
.ftree__caret {
  width: 14px;
  color: var(--fg-subtle);
  font-size: 9px;
  flex-shrink: 0;
  text-align: center;
}
.ftree__name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ftree__count {
  font-size: 10px;
  color: var(--fg-subtle);
  background: var(--bg);
  padding: 0 5px;
  border-radius: 8px;
  min-width: 18px;
  text-align: center;
}
.ftree__input {
  flex: 1;
  font-size: 12px;
  padding: 2px 6px;
  min-width: 0;
}
.ftree__empty {
  font-size: 11px;
  color: var(--fg-subtle);
  padding: 8px 24px;
  line-height: 1.5;
}
.ftree__empty strong { color: var(--fg-muted); }
</style>
