<script setup lang="ts">
import { computed } from "vue";
import type { Folder, SavedQuery } from "@/stores/workspace";
import QueryRow from "./QueryRow.vue";

interface Node extends Folder {
  children: Node[];
  depth: number;
}

const props = defineProps<{
  node: Node;
  expanded: Set<number>;
  renaming: { id: number; name: string } | null;
  adding: { parent: number | null; name: string } | null;
  activeFolderId: number | null;
  queriesInFolder: (id: number) => SavedQuery[];
}>();

const emit = defineEmits<{
  (e: "toggle", id: number): void;
  (e: "select", id: number): void;
  (e: "start-add", id: number): void;
  (e: "commit-add"): void;
  (e: "start-rename", f: Folder): void;
  (e: "commit-rename"): void;
  (e: "cancel-rename"): void;
  (e: "cancel-add"): void;
  (e: "remove", f: Folder): void;
}>();

const directQueries = computed(() => props.queriesInFolder(props.node.id));
const isOpen = computed(() =>
  props.expanded.has(props.node.id)
  || (props.adding != null && props.adding.parent === props.node.id),
);

function totalCount(): number {
  let n = directQueries.value.length;
  for (const c of props.node.children) {
    n += props.queriesInFolder(c.id).length;
  }
  return n;
}
</script>

<template>
  <div
    :class="{ 'ftree__row--active': activeFolderId === node.id }"
    class="ftree__row"
    :style="{ paddingLeft: `${8 + node.depth * 12}px` }"
    @click="emit('toggle', node.id)"
  >
    <span class="ftree__caret">{{ isOpen ? "▾" : "▸" }}</span>
    <input
      v-if="renaming && renaming.id === node.id"
      :value="renaming.name"
      class="ftree__input"
      autofocus
      @click.stop
      @input="(e) => (renaming!.name = (e.target as HTMLInputElement).value)"
      @keyup.enter="emit('commit-rename')"
      @keyup.escape="emit('cancel-rename')"
      @blur="emit('commit-rename')"
    />
    <span v-else class="ftree__name">{{ node.name }}</span>
    <span class="ftree__count">{{ totalCount() }}</span>
    <button class="ftree__act" title="Sub-collection" @click.stop="emit('start-add', node.id)">+</button>
    <button class="ftree__act" title="Rename" @click.stop="emit('start-rename', node)">✎</button>
    <button class="ftree__act" title="Delete" @click.stop="emit('remove', node)">×</button>
  </div>

  <div
    v-if="isOpen && adding && adding.parent === node.id"
    class="ftree__row ftree__row--input"
    :style="{ paddingLeft: `${8 + node.depth * 12 + 16}px` }"
  >
    <input
      :value="adding.name"
      class="ftree__input"
      placeholder="New sub-collection…"
      autofocus
      @input="(e) => (adding!.name = (e.target as HTMLInputElement).value)"
      @keyup.enter="emit('commit-add')"
      @keyup.escape="emit('cancel-add')"
      @blur="emit('commit-add')"
    />
  </div>

  <template v-if="isOpen">
    <QueryRow
      v-for="q in directQueries"
      :key="q.id"
      :query="q"
      :depth="node.depth + 1"
    />
    <FolderRow
      v-for="child in node.children"
      :key="child.id"
      :node="child"
      :expanded="expanded"
      :renaming="renaming"
      :adding="adding"
      :active-folder-id="activeFolderId"
      :queries-in-folder="queriesInFolder"
      @toggle="(id) => emit('toggle', id)"
      @select="(id) => emit('select', id)"
      @start-add="(id) => emit('start-add', id)"
      @commit-add="emit('commit-add')"
      @start-rename="(f) => emit('start-rename', f)"
      @commit-rename="emit('commit-rename')"
      @cancel-rename="emit('cancel-rename')"
      @cancel-add="emit('cancel-add')"
      @remove="(f) => emit('remove', f)"
    />
  </template>
</template>

<style scoped>
.ftree__row {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
  color: var(--fg);
  min-width: 0;
}
.ftree__row:hover { background: var(--bg-hover); }
.ftree__row--active { background: var(--accent-subtle); color: var(--accent); }
.ftree__row--input { padding-top: 2px; padding-bottom: 2px; }
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
.ftree__act {
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
.ftree__row:hover .ftree__act { opacity: 1; }
.ftree__act:hover { background: var(--bg-hover); color: var(--fg); }
.ftree__input {
  flex: 1;
  font-size: 12px;
  padding: 2px 6px;
  min-width: 0;
}
</style>
