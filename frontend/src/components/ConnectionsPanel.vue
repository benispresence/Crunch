<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "@/api/client";
import { useWorkspaceStore } from "@/stores/workspace";

type ConnectionType = "postgres" | "mysql" | "sqlite" | "sqlserver" | "file";

const TYPE_LABELS: Record<ConnectionType, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  sqlite: "SQLite",
  sqlserver: "SQL Server",
  file: "File (CSV/Excel)",
};

const DEFAULT_PORTS: Record<ConnectionType, number> = {
  postgres: 5432,
  mysql: 3306,
  sqlserver: 1433,
  sqlite: 0,
  file: 0,
};

function blankDraft() {
  return {
    name: "",
    type: "postgres" as ConnectionType,
    host: "localhost",
    port: 5432,
    database: "",
    user: "",
    password: "",
  };
}

const ws = useWorkspaceStore();
const adding = ref(false);
const submitting = ref(false);
const error = ref("");
const draft = ref(blankDraft());

const isFileLike = computed(() => draft.value.type === "sqlite" || draft.value.type === "file");
const databasePlaceholder = computed(() => {
  if (draft.value.type === "sqlite") return "/path/to/database.db";
  if (draft.value.type === "file") return "/path/to/folder";
  return "Database name";
});
const databaseLabel = computed(() => {
  if (draft.value.type === "sqlite") return "Database file";
  if (draft.value.type === "file") return "Folder path";
  return "Database";
});

watch(
  () => draft.value.type,
  (t) => {
    draft.value.port = DEFAULT_PORTS[t];
  },
);

function openForm() {
  draft.value = blankDraft();
  error.value = "";
  adding.value = true;
}

function closeForm() {
  adding.value = false;
  error.value = "";
}

async function add() {
  if (!draft.value.name.trim()) {
    error.value = "Name is required";
    return;
  }
  submitting.value = true;
  error.value = "";
  try {
    const config: Record<string, unknown> = { database: draft.value.database };
    if (!isFileLike.value) {
      config.host = draft.value.host;
      config.port = Number(draft.value.port);
      config.user = draft.value.user;
      config.password = draft.value.password;
    }
    await api.post("/connections", {
      name: draft.value.name.trim(),
      type: draft.value.type,
      config,
    });
    closeForm();
    await ws.loadConnections();
  } catch (e) {
    error.value = (e as Error).message || "Could not save connection";
  } finally {
    submitting.value = false;
  }
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
    <div class="sidebar__heading">
      <span class="sidebar__heading-title">Connections</span>
      <button
        v-if="!adding"
        class="btn btn-ghost btn-sm"
        @click="openForm"
        title="Add a new connection"
      >
        + New
      </button>
      <button
        v-else
        class="btn btn-ghost btn-sm"
        @click="closeForm"
      >
        Close
      </button>
    </div>

    <div class="sidebar__scroll">
      <form v-if="adding" class="conn-form" @submit.prevent="add">
        <label class="conn-form__field">
          <span>Name</span>
          <input
            v-model="draft.name"
            placeholder="e.g. Production DB"
            autofocus
            required
          />
        </label>

        <label class="conn-form__field">
          <span>Type</span>
          <select v-model="draft.type">
            <option v-for="(label, value) in TYPE_LABELS" :key="value" :value="value">
              {{ label }}
            </option>
          </select>
        </label>

        <label class="conn-form__field">
          <span>{{ databaseLabel }}</span>
          <input v-model="draft.database" :placeholder="databasePlaceholder" />
        </label>

        <template v-if="!isFileLike">
          <div class="conn-form__row">
            <label class="conn-form__field">
              <span>Host</span>
              <input v-model="draft.host" placeholder="localhost" />
            </label>
            <label class="conn-form__field conn-form__field--port">
              <span>Port</span>
              <input v-model.number="draft.port" type="number" placeholder="5432" />
            </label>
          </div>

          <label class="conn-form__field">
            <span>User</span>
            <input v-model="draft.user" placeholder="username" autocomplete="off" />
          </label>

          <label class="conn-form__field">
            <span>Password</span>
            <input
              v-model="draft.password"
              type="password"
              placeholder="••••••••"
              autocomplete="new-password"
            />
          </label>
        </template>

        <p v-if="error" class="conn-form__error">{{ error }}</p>

        <div class="conn-form__actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="closeForm">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="submitting">
            {{ submitting ? "Adding..." : "Add connection" }}
          </button>
        </div>
      </form>

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
            <span class="sidebar__name" :title="c.name">{{ c.name }}</span>
          </div>
          <button
            class="btn btn-ghost btn-icon sidebar__delete"
            @click.stop="remove(c.id)"
            title="Delete"
          >
            ×
          </button>
        </li>
        <li v-if="ws.connections.length === 0 && !adding" class="sidebar__empty">
          No connections yet. Click <strong>+ New</strong> to add one.
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
  min-width: 0;
}
.sidebar__heading {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 10px 12px 8px;
  color: var(--fg-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  flex-shrink: 0;
  border-bottom: 1px solid var(--border);
}
.sidebar__heading-title { font-weight: 600; }
.sidebar__scroll {
  flex: 1;
  overflow-y: auto;
  padding: 8px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.conn-form {
  display: grid;
  gap: 10px;
  padding: 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.conn-form__field {
  display: grid;
  gap: 4px;
  font-size: 11px;
  color: var(--fg-muted);
  min-width: 0;
}
.conn-form__field input,
.conn-form__field select {
  font-size: 13px;
  padding: 6px 8px;
  width: 100%;
  box-sizing: border-box;
  min-width: 0;
}
.conn-form__row {
  display: grid;
  grid-template-columns: 1fr 90px;
  gap: 8px;
}
.conn-form__field--port input {
  text-align: right;
}
.conn-form__error {
  color: var(--error);
  font-size: 12px;
  margin: 0;
  padding: 6px 8px;
  background: rgba(220, 80, 80, 0.08);
  border-radius: var(--radius-sm);
}
.conn-form__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 2px;
}

.sidebar__list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 2px;
}
.sidebar__item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  min-width: 0;
  gap: 6px;
}
.sidebar__item:hover { background: var(--bg-hover); }
.sidebar__item--active {
  background: var(--accent-subtle);
  box-shadow: inset 0 0 0 1px var(--accent-border);
}
.sidebar__item-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.sidebar__type {
  font-size: 9px;
  text-transform: uppercase;
  color: var(--fg-subtle);
  background: var(--bg);
  padding: 2px 5px;
  border-radius: 3px;
  letter-spacing: 0.04em;
  flex-shrink: 0;
}
.sidebar__name {
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.sidebar__delete {
  opacity: 0;
  transition: opacity 120ms;
  flex-shrink: 0;
}
.sidebar__item:hover .sidebar__delete,
.sidebar__item--active .sidebar__delete { opacity: 1; }
.sidebar__empty {
  color: var(--fg-subtle);
  font-size: 12px;
  padding: 16px 12px;
  text-align: center;
  line-height: 1.5;
}
.sidebar__empty strong { color: var(--fg-muted); }
</style>
