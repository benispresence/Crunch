<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { api } from "@/api/client";
import { useWorkspaceStore } from "@/stores/workspace";
import FolderTree from "./FolderTree.vue";

type ConnectionType =
  | "postgres"
  | "mysql"
  | "mariadb"
  | "sqlite"
  | "sqlserver"
  | "file"
  | "duckdb"
  | "snowflake"
  | "bigquery"
  | "redshift"
  | "databricks"
  | "clickhouse"
  | "trino"
  | "mongodb";

const TYPE_LABELS: Record<ConnectionType, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL",
  mariadb: "MariaDB",
  sqlite: "SQLite",
  sqlserver: "SQL Server",
  file: "Files (CSV / Parquet / JSON / Excel / Arrow / cloud URIs)",
  duckdb: "DuckDB (native)",
  snowflake: "Snowflake",
  bigquery: "BigQuery",
  redshift: "Amazon Redshift",
  databricks: "Databricks",
  clickhouse: "ClickHouse",
  trino: "Trino / Presto",
  mongodb: "MongoDB",
};

// Default port hint per type. 0 = no port field shown.
const DEFAULT_PORTS: Record<ConnectionType, number> = {
  postgres: 5432,
  mysql: 3306,
  mariadb: 3306,
  sqlserver: 1433,
  sqlite: 0,
  file: 0,
  duckdb: 0,
  snowflake: 0,
  bigquery: 0,
  redshift: 5439,
  databricks: 0,
  clickhouse: 8123,
  trino: 8080,
  mongodb: 27017,
};

// Connection types that don't ask for host/port/user/password (file
// paths, URIs, or bespoke auth that we handle via the extras box).
const FILE_LIKE: ConnectionType[] = ["sqlite", "file", "duckdb"];
const HAS_HOST_PORT: ConnectionType[] = [
  "postgres", "mysql", "mariadb", "sqlserver", "redshift",
  "clickhouse", "trino", "mongodb",
];

interface Extras {
  // Tag → human-facing label, placeholder, secret flag.
  // Built per-type below and rendered into the form.
  key: string;
  label: string;
  placeholder?: string;
  secret?: boolean;
  hint?: string;
}

const EXTRAS_BY_TYPE: Partial<Record<ConnectionType, Extras[]>> = {
  snowflake: [
    { key: "account", label: "Account", placeholder: "ab12345.us-east-1" },
    { key: "user", label: "User", placeholder: "username" },
    { key: "password", label: "Password", placeholder: "••••••••", secret: true },
    { key: "warehouse", label: "Warehouse", placeholder: "COMPUTE_WH" },
    { key: "database", label: "Database", placeholder: "ANALYTICS" },
    { key: "schema", label: "Schema", placeholder: "PUBLIC" },
    { key: "role", label: "Role (optional)", placeholder: "ANALYST" },
  ],
  bigquery: [
    { key: "database", label: "Project id", placeholder: "my-gcp-project" },
    { key: "dataset", label: "Default dataset (optional)", placeholder: "analytics" },
    {
      key: "credentials_path",
      label: "Service account JSON path",
      placeholder: "/etc/gcp/service-account.json",
      hint: "Leave blank to use Application Default Credentials.",
    },
    { key: "location", label: "Location (optional)", placeholder: "EU" },
  ],
  databricks: [
    { key: "host", label: "Server hostname", placeholder: "adb-xxx.azuredatabricks.net" },
    { key: "http_path", label: "HTTP path", placeholder: "/sql/1.0/warehouses/abc123" },
    { key: "access_token", label: "Personal access token", placeholder: "dapi…", secret: true },
    { key: "database", label: "Default catalog (optional)", placeholder: "main" },
    { key: "schema", label: "Default schema (optional)", placeholder: "default" },
  ],
  trino: [
    { key: "http_scheme", label: "Scheme", placeholder: "http or https" },
  ],
  clickhouse: [
    { key: "protocol", label: "Protocol", placeholder: "http (default) or native" },
    { key: "secure", label: "TLS (true/false)", placeholder: "false" },
  ],
  file: [
    {
      key: "files",
      label: "Files / URIs (one per line, optional)",
      placeholder:
        "s3://bucket/data.parquet\nhttps://example.com/data.csv\n/local/path/file.json",
      hint:
        "Leave blank to scan the folder. Cloud URIs use DuckDB httpfs — set credentials below.",
    },
    { key: "s3_region", label: "S3 region (optional)", placeholder: "us-east-1" },
    { key: "s3_access_key_id", label: "S3 access key id (optional)", placeholder: "AKIA…" },
    { key: "s3_secret_access_key", label: "S3 secret (optional)", placeholder: "••••••", secret: true },
    {
      key: "azure_storage_connection_string",
      label: "Azure connection string (optional)",
      placeholder: "DefaultEndpointsProtocol=…",
      secret: true,
    },
  ],
  mongodb: [
    {
      key: "uri",
      label: "Connection URI (optional)",
      placeholder: "mongodb+srv://user:pass@cluster.mongodb.net/db",
      hint: "If set, overrides host/port/user/password above.",
    },
  ],
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
    extras: {} as Record<string, string>,
  };
}

const ws = useWorkspaceStore();
const adding = ref(false);
const submitting = ref(false);
const error = ref("");
const draft = ref(blankDraft());

const isFileLike = computed(() => FILE_LIKE.includes(draft.value.type));
const hasHostPort = computed(() => HAS_HOST_PORT.includes(draft.value.type));
const extrasFields = computed<Extras[]>(() => EXTRAS_BY_TYPE[draft.value.type] ?? []);

const databasePlaceholder = computed(() => {
  switch (draft.value.type) {
    case "sqlite": return "/path/to/database.db";
    case "file": return "/path/to/folder or s3://bucket/prefix/";
    case "duckdb": return "/path/to/file.duckdb (or :memory:)";
    case "mongodb": return "database name";
    case "bigquery": return "GCP project id";
    default: return "Database name";
  }
});
const databaseLabel = computed(() => {
  switch (draft.value.type) {
    case "sqlite": return "Database file";
    case "file": return "Folder or root URI";
    case "duckdb": return "Database file";
    default: return "Database";
  }
});

// Some types have their own "database" via extras (BigQuery: project,
// Databricks: catalog, Snowflake: database). For those we hide the
// generic field to avoid two inputs for the same thing.
const showGenericDatabase = computed(() => {
  return !["snowflake", "bigquery", "databricks"].includes(draft.value.type);
});

watch(
  () => draft.value.type,
  (t) => {
    draft.value.port = DEFAULT_PORTS[t];
    draft.value.extras = {};
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
    const config: Record<string, unknown> = {};
    if (showGenericDatabase.value) config.database = draft.value.database;
    if (hasHostPort.value) {
      config.host = draft.value.host;
      config.port = Number(draft.value.port);
      config.user = draft.value.user;
      config.password = draft.value.password;
    }
    // Map extras into the config. Two keys get special treatment:
    //  - "database" promotes the extra into the top-level field used
    //    by warehouse adapters that label their database differently
    //    (project, catalog, ...).
    //  - "files" is a newline-separated list — split into an array so
    //    the FileAdapter sees ``options.files``.
    const options: Record<string, unknown> = {};
    for (const f of extrasFields.value) {
      const v = (draft.value.extras[f.key] ?? "").trim();
      if (!v) continue;
      if (f.key === "database") {
        config.database = v;
      } else if (f.key === "host") {
        config.host = v;
      } else if (f.key === "files") {
        options.files = v.split(/\r?\n+/).map((s) => s.trim()).filter(Boolean);
      } else if (f.key === "secure") {
        options.secure = v.toLowerCase() === "true";
      } else {
        options[f.key] = v;
      }
    }
    if (Object.keys(options).length > 0) config.options = options;
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
    <div class="sidebar__scroll">
      <FolderTree />

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
            <optgroup label="OLTP">
              <option value="postgres">PostgreSQL</option>
              <option value="mysql">MySQL</option>
              <option value="mariadb">MariaDB</option>
              <option value="sqlite">SQLite</option>
              <option value="sqlserver">SQL Server</option>
            </optgroup>
            <optgroup label="Warehouses">
              <option value="snowflake">Snowflake</option>
              <option value="bigquery">BigQuery</option>
              <option value="redshift">Amazon Redshift</option>
              <option value="databricks">Databricks</option>
              <option value="clickhouse">ClickHouse</option>
              <option value="trino">Trino / Presto</option>
            </optgroup>
            <optgroup label="Files & embedded">
              <option value="file">Files (CSV / Parquet / JSON / Excel / Arrow)</option>
              <option value="duckdb">DuckDB (native)</option>
            </optgroup>
            <optgroup label="Document">
              <option value="mongodb">MongoDB</option>
            </optgroup>
          </select>
        </label>

        <label v-if="showGenericDatabase" class="conn-form__field">
          <span>{{ databaseLabel }}</span>
          <input v-model="draft.database" :placeholder="databasePlaceholder" />
        </label>

        <template v-if="hasHostPort">
          <div class="conn-form__row">
            <label class="conn-form__field">
              <span>Host</span>
              <input v-model="draft.host" placeholder="localhost" />
            </label>
            <label class="conn-form__field conn-form__field--port">
              <span>Port</span>
              <input v-model.number="draft.port" type="number" :placeholder="String(DEFAULT_PORTS[draft.type])" />
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

        <!-- Type-specific extras (warehouse account/dataset, S3 creds, etc.) -->
        <template v-for="f in extrasFields" :key="f.key">
          <label class="conn-form__field">
            <span>{{ f.label }}</span>
            <textarea
              v-if="f.key === 'files'"
              v-model="draft.extras[f.key]"
              :placeholder="f.placeholder"
              rows="3"
              class="conn-form__textarea"
            />
            <input
              v-else
              v-model="draft.extras[f.key]"
              :type="f.secret ? 'password' : 'text'"
              :placeholder="f.placeholder ?? ''"
              :autocomplete="f.secret ? 'new-password' : 'off'"
            />
            <small v-if="f.hint" class="conn-form__hint">{{ f.hint }}</small>
          </label>
        </template>

        <p v-if="draft.type === 'mongodb'" class="conn-form__hint">
          MongoDB queries are JSON, not SQL. Example:
          <code>{"collection": "users", "find": {"status": "active"}, "limit": 100}</code>
        </p>

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
  padding: 6px 4px;
  margin-top: 12px;
  padding-top: 10px;
  border-top: 1px solid var(--border);
  color: var(--fg-muted);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  flex-shrink: 0;
}
.sidebar__heading-title { font-weight: 600; }
.sidebar__scroll {
  flex: 1;
  overflow-y: auto;
  padding: 8px 8px 12px;
  display: flex;
  flex-direction: column;
  gap: 4px;
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
.conn-form__field select,
.conn-form__field textarea {
  font-size: 13px;
  padding: 6px 8px;
  width: 100%;
  box-sizing: border-box;
  min-width: 0;
  font-family: inherit;
}
.conn-form__textarea {
  font-family: var(--font-mono);
  font-size: 12px;
  resize: vertical;
  min-height: 64px;
}
.conn-form__row {
  display: grid;
  grid-template-columns: 1fr 90px;
  gap: 8px;
}
.conn-form__field--port input { text-align: right; }
.conn-form__hint {
  font-size: 11px;
  color: var(--fg-subtle);
  line-height: 1.4;
}
.conn-form__hint code {
  font-family: var(--font-mono);
  background: var(--bg-elev);
  padding: 1px 4px;
  border-radius: 3px;
  font-size: 10.5px;
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
