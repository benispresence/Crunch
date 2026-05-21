<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "@/api/client";

/**
 * Admin → MCP.
 *
 * Two surfaces, mirroring the two directions of the protocol:
 *
 *   - **Outbound**: connections to external MCP servers. Each row
 *     stores URL + optional auth header. The chat agent fetches
 *     their tools and offers them alongside the built-ins.
 *   - **Inbound**: which of *our* tools to expose at /api/mcp. The
 *     admin opts in per tool; nothing is exposed by default. API-key
 *     callers with the ``mcp.use`` capability can call the allowed
 *     tools — the key's stored scopes narrow further on each request.
 */

interface ExposedTools {
  exposed: string[];
  available: Array<{ name: string; description: string }>;
}

interface McpServer {
  id: number;
  name: string;
  url: string;
  transport: string;
  auth_header_name: string | null;
  auth_header_value: string | null;
  enabled: boolean;
  allowed_tools: string[];
  last_handshake_at: number | null;
  last_error: string | null;
  cached_tools: Array<{ name: string; description?: string }>;
  updated_at: number;
}

const sub = ref<"outbound" | "inbound">("outbound");
const exposed = ref<ExposedTools | null>(null);
const servers = ref<McpServer[]>([]);
const error = ref("");
const toast = ref("");

const draft = ref<{
  id?: number;
  name: string;
  url: string;
  auth_header_name: string;
  auth_header_value: string;
  enabled: boolean;
} | null>(null);

function flash(msg: string) {
  toast.value = msg;
  setTimeout(() => (toast.value = ""), 2500);
}

async function load() {
  try {
    const [a, b] = await Promise.all([
      api.get<ExposedTools>("/admin/mcp/exposed-tools"),
      api.get<{ servers: McpServer[] }>("/admin/mcp/servers"),
    ]);
    exposed.value = a;
    servers.value = b.servers;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

onMounted(load);

const exposedSet = computed(() => new Set(exposed.value?.exposed ?? []));

async function toggleExposed(name: string) {
  if (!exposed.value) return;
  const next = exposedSet.value.has(name)
    ? exposed.value.exposed.filter((n) => n !== name)
    : [...exposed.value.exposed, name];
  try {
    const r = await api.put<ExposedTools>("/admin/mcp/exposed-tools", { exposed: next });
    exposed.value = { ...exposed.value, exposed: r.exposed };
    flash("Exposed tools updated.");
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function startAdd() {
  draft.value = {
    name: "", url: "", auth_header_name: "Authorization", auth_header_value: "", enabled: true,
  };
}

function startEdit(s: McpServer) {
  draft.value = {
    id: s.id,
    name: s.name,
    url: s.url,
    auth_header_name: s.auth_header_name ?? "",
    auth_header_value: "",  // placeholder triggers "keep existing"
    enabled: s.enabled,
  };
}

async function saveServer() {
  if (!draft.value) return;
  if (!draft.value.name.trim() || !draft.value.url.trim()) {
    error.value = "Name and URL are required";
    return;
  }
  const body = {
    name: draft.value.name.trim(),
    url: draft.value.url.trim(),
    auth_header_name: draft.value.auth_header_name.trim() || null,
    auth_header_value: draft.value.auth_header_value || null,
    enabled: draft.value.enabled,
  };
  try {
    if (draft.value.id != null) {
      await api.put(`/admin/mcp/servers/${draft.value.id}`, body);
    } else {
      await api.post("/admin/mcp/servers", body);
    }
    draft.value = null;
    flash("Server saved.");
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function deleteServer(s: McpServer) {
  if (!confirm(`Delete MCP connection "${s.name}"?`)) return;
  try {
    await api.del(`/admin/mcp/servers/${s.id}`);
    flash("Deleted.");
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function refreshServer(s: McpServer) {
  try {
    const r = await api.post<{ ok: boolean; tools?: unknown[]; error?: string }>(
      `/admin/mcp/servers/${s.id}/refresh`, {},
    );
    if (r.ok) {
      flash(`Discovered ${r.tools?.length ?? 0} tools.`);
    } else {
      error.value = r.error ?? "handshake failed";
    }
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function fmtTime(ts: number | null): string {
  return ts ? new Date(ts * 1000).toLocaleString() : "—";
}
</script>

<template>
  <div class="mcp">
    <p v-if="error" class="mcp__error">{{ error }}</p>
    <p v-if="toast" class="mcp__toast">{{ toast }}</p>

    <div class="mcp__subtabs">
      <button class="mcp__sub" :class="{ 'mcp__sub--on': sub === 'outbound' }" @click="sub = 'outbound'">
        Outbound (Crunch as client)
      </button>
      <button class="mcp__sub" :class="{ 'mcp__sub--on': sub === 'inbound' }" @click="sub = 'inbound'">
        Inbound (other apps controlling Crunch)
      </button>
    </div>

    <!-- ============ Outbound: external MCP servers ============ -->
    <section v-if="sub === 'outbound'" class="mcp__section">
      <p class="mcp__hint">
        Connect to other MCP servers so the chat agent can call their tools alongside
        Crunch's own. Tool names are prefixed with <code>mcp__&lt;server&gt;__</code>
        to keep them separate from the built-ins. Auth header values are encrypted at rest.
      </p>

      <div v-if="!draft" class="mcp__addrow">
        <button class="btn btn-sm" @click="startAdd">+ Add MCP server</button>
      </div>

      <form v-if="draft" class="mcp__form" @submit.prevent="saveServer">
        <header><h4>{{ draft.id ? "Edit MCP server" : "New MCP server" }}</h4></header>
        <label>
          <span>Name (URL-safe identifier)</span>
          <input v-model="draft.name" placeholder="github" required />
        </label>
        <label>
          <span>URL</span>
          <input v-model="draft.url" placeholder="https://mcp.example.com/jsonrpc" required />
        </label>
        <div class="mcp__row">
          <label>
            <span>Auth header name (optional)</span>
            <input v-model="draft.auth_header_name" placeholder="Authorization" />
          </label>
          <label>
            <span>Auth header value</span>
            <input
              v-model="draft.auth_header_value"
              type="password"
              :placeholder="draft.id ? '(unchanged)' : 'Bearer …'"
            />
          </label>
        </div>
        <label class="mcp__checkbox">
          <input v-model="draft.enabled" type="checkbox" />
          <span>Enabled — chat agent can call this server</span>
        </label>
        <footer>
          <button type="button" class="btn btn-ghost btn-sm" @click="draft = null">Cancel</button>
          <button type="submit" class="btn btn-primary btn-sm">Save</button>
        </footer>
      </form>

      <ul v-if="servers.length > 0" class="mcp__list">
        <li v-for="s in servers" :key="s.id" class="mcp__item">
          <div class="mcp__item-head">
            <span class="mcp__name">{{ s.name }}</span>
            <span v-if="!s.enabled" class="mcp__pill mcp__pill--off">disabled</span>
            <span class="mcp__url">{{ s.url }}</span>
          </div>
          <div class="mcp__item-meta">
            <span>{{ s.cached_tools.length }} tool{{ s.cached_tools.length === 1 ? '' : 's' }}</span>
            <span>· last handshake: {{ fmtTime(s.last_handshake_at) }}</span>
            <span v-if="s.last_error" class="mcp__err">⚠ {{ s.last_error }}</span>
          </div>
          <div v-if="s.cached_tools.length > 0" class="mcp__tools">
            <span v-for="t in s.cached_tools" :key="t.name" class="mcp__tool-chip">{{ t.name }}</span>
          </div>
          <div class="mcp__item-actions">
            <button class="btn btn-sm" @click="refreshServer(s)">Discover tools</button>
            <button class="btn btn-sm" @click="startEdit(s)">Edit</button>
            <button class="btn btn-ghost btn-sm" @click="deleteServer(s)">Delete</button>
          </div>
        </li>
      </ul>
      <div v-else-if="!draft" class="mcp__empty">
        No external MCP servers configured.
      </div>
    </section>

    <!-- ============ Inbound: which tools we expose ============ -->
    <section v-if="sub === 'inbound'" class="mcp__section">
      <p class="mcp__hint">
        Pick which of Crunch's tools external MCP clients can call at
        <code>POST /api/mcp</code>. Callers authenticate with an API key
        (Admin → Authentication) that carries the <code>mcp.use</code> capability;
        the key's scope list narrows further at request time. Nothing is exposed by default.
      </p>

      <div v-if="exposed" class="mcp__tool-list">
        <label
          v-for="t in exposed.available"
          :key="t.name"
          class="mcp__tool-row"
        >
          <input
            type="checkbox"
            :checked="exposedSet.has(t.name)"
            @change="toggleExposed(t.name)"
          />
          <span class="mcp__tool-name">{{ t.name }}</span>
          <span class="mcp__tool-desc">{{ t.description }}</span>
        </label>
      </div>
    </section>
  </div>
</template>

<style scoped>
.mcp { display: grid; gap: 12px; }
.mcp__error {
  background: rgba(224, 122, 95, 0.08);
  border: 1px solid rgba(224, 122, 95, 0.3);
  color: var(--error);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  margin: 0;
}
.mcp__toast {
  margin: 0;
  padding: 6px 12px;
  background: rgba(127, 176, 105, 0.12);
  color: var(--success);
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.mcp__hint {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
  line-height: 1.5;
}
.mcp__hint code {
  font-family: var(--font-mono);
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 3px;
}
.mcp__subtabs {
  display: flex; gap: 4px;
  border-bottom: 1px solid var(--border); margin-bottom: 4px;
}
.mcp__sub {
  padding: 6px 12px;
  background: transparent; border: none; cursor: pointer;
  border-bottom: 2px solid transparent;
  color: var(--fg-muted); font-size: 12px;
}
.mcp__sub--on { color: var(--fg); border-bottom-color: var(--accent); }

.mcp__section { display: grid; gap: 12px; }

.mcp__addrow { display: flex; }

.mcp__form {
  background: var(--bg);
  border: 1px solid var(--accent-border);
  border-radius: var(--radius);
  padding: 14px;
  display: grid; gap: 10px;
}
.mcp__form header h4 {
  margin: 0;
  font-family: var(--font-serif); font-weight: 500; font-size: 14px;
}
.mcp__form label {
  display: grid;
  gap: 4px;
  font-size: 11px; color: var(--fg-muted);
}
.mcp__form input {
  font-size: 13px;
  padding: 6px 8px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
}
.mcp__row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.mcp__checkbox { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--fg-muted); }
.mcp__form footer { display: flex; justify-content: flex-end; gap: 6px; }

.mcp__list { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.mcp__item {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px;
  display: grid; gap: 6px;
}
.mcp__item-head { display: flex; align-items: center; gap: 8px; }
.mcp__name {
  font-family: var(--font-serif); font-weight: 500; font-size: 14px; color: var(--fg);
}
.mcp__url {
  font-family: var(--font-mono); font-size: 11.5px; color: var(--fg-subtle);
  margin-left: auto;
}
.mcp__pill {
  font-size: 10px; font-weight: 600; text-transform: uppercase;
  padding: 1px 6px; border-radius: 999px;
}
.mcp__pill--off { background: var(--bg-elev); color: var(--fg-subtle); border: 1px solid var(--border); }
.mcp__item-meta {
  display: flex; gap: 8px; flex-wrap: wrap;
  font-size: 11px; color: var(--fg-subtle);
}
.mcp__err { color: var(--error); }
.mcp__tools { display: flex; flex-wrap: wrap; gap: 4px; }
.mcp__tool-chip {
  font-family: var(--font-mono); font-size: 10.5px;
  background: var(--accent-subtle); color: var(--accent);
  padding: 2px 6px; border-radius: 3px;
}
.mcp__item-actions { display: flex; gap: 6px; justify-content: flex-end; }

.mcp__empty {
  padding: 20px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  text-align: center;
  color: var(--fg-subtle);
  font-size: 12px;
}

.mcp__tool-list { display: grid; gap: 4px; }
.mcp__tool-row {
  display: grid;
  grid-template-columns: 18px 200px 1fr;
  gap: 8px;
  align-items: center;
  padding: 4px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.mcp__tool-row:hover { background: var(--bg-hover); }
.mcp__tool-name { font-family: var(--font-mono); color: var(--fg); }
.mcp__tool-desc { color: var(--fg-muted); font-size: 11.5px; }
</style>
