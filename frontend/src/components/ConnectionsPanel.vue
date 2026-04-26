<script setup lang="ts">
import { ref } from "vue";
import { api } from "@/api/client";
import { useWorkspaceStore } from "@/stores/workspace";

const ws = useWorkspaceStore();
const adding = ref(false);
const draft = ref({
  name: "",
  type: "postgres" as "postgres" | "mysql" | "sqlite" | "sqlserver" | "file",
  host: "",
  port: 5432,
  database: "",
  user: "",
  password: "",
});

async function add() {
  await api.post("/connections", {
    name: draft.value.name,
    type: draft.value.type,
    config: {
      host: draft.value.host,
      port: Number(draft.value.port),
      database: draft.value.database,
      user: draft.value.user,
      password: draft.value.password,
    },
  });
  adding.value = false;
  draft.value.name = "";
  await ws.loadConnections();
}

async function remove(id: number) {
  if (!confirm("Delete this connection?")) return;
  await api.del(`/connections/${id}`);
  if (ws.activeConnectionId === id) ws.activeConnectionId = null;
  await ws.loadConnections();
}
</script>

<template>
  <aside class="sidebar">
    <div class="sidebar__section">
      <div class="sidebar__heading">
        <span>Connections</span>
        <button class="btn btn-ghost btn-sm" @click="adding = !adding">
          {{ adding ? "Cancel" : "+ New" }}
        </button>
      </div>

      <div v-if="adding" class="sidebar__form">
        <input v-model="draft.name" placeholder="Display name" />
        <select v-model="draft.type">
          <option value="postgres">PostgreSQL</option>
          <option value="mysql">MySQL</option>
          <option value="sqlite">SQLite</option>
          <option value="sqlserver">SQL Server</option>
          <option value="file">File (CSV/Excel)</option>
        </select>
        <input v-model="draft.host" placeholder="Host" />
        <div class="sidebar__row">
          <input v-model.number="draft.port" placeholder="Port" type="number" />
          <input v-model="draft.database" placeholder="Database" />
        </div>
        <input v-model="draft.user" placeholder="User" />
        <input v-model="draft.password" placeholder="Password" type="password" />
        <button class="btn btn-primary btn-sm" @click="add">Add</button>
      </div>

      <ul class="sidebar__list">
        <li
          v-for="c in ws.connections"
          :key="c.id"
          :class="{ 'sidebar__item--active': ws.activeConnectionId === c.id }"
          class="sidebar__item"
          @click="ws.activeConnectionId = c.id"
        >
          <div class="sidebar__item-main">
            <span class="sidebar__type">{{ c.type }}</span>
            <span class="sidebar__name">{{ c.name }}</span>
          </div>
          <button class="btn btn-ghost btn-icon" @click.stop="remove(c.id)" title="Delete">×</button>
        </li>
        <li v-if="ws.connections.length === 0" class="sidebar__empty">
          No connections. Add one to start.
        </li>
      </ul>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  height: 100%;
  background: var(--bg-elev);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  overflow-y: auto;
}
.sidebar__section { padding: 10px 8px; }
.sidebar__heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 4px 6px 8px;
  color: var(--fg-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.sidebar__form {
  display: grid;
  gap: 6px;
  padding: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  margin-bottom: 8px;
}
.sidebar__form input,
.sidebar__form select {
  font-size: 12px;
  padding: 6px 8px;
}
.sidebar__row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 6px;
}
.sidebar__list { list-style: none; padding: 0; margin: 0; display: grid; gap: 2px; }
.sidebar__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.sidebar__item:hover { background: var(--bg-hover); }
.sidebar__item--active { background: var(--accent-subtle); border: 1px solid var(--accent-border); }
.sidebar__item-main { display: flex; align-items: center; gap: 8px; min-width: 0; }
.sidebar__type {
  font-size: 10px;
  text-transform: uppercase;
  color: var(--fg-subtle);
  background: var(--bg);
  padding: 2px 5px;
  border-radius: 3px;
}
.sidebar__name {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sidebar__empty {
  color: var(--fg-subtle);
  font-size: 12px;
  padding: 12px 6px;
  text-align: center;
}
</style>
