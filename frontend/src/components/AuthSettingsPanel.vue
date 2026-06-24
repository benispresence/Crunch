<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "@/api/client";

/**
 * Admin → Authentication. Three sub-tabs:
 *   - Providers: OIDC / SAML / LDAP definitions, each with an
 *     edit/delete row and a contextual add form.
 *   - API keys: per-user bearer tokens for embedding queries from
 *     scripts. Plaintext shown only once at creation time.
 *   - Allowlist: email-domain gate that applies across every sign-in
 *     mechanism (register, OIDC, SAML, LDAP).
 *
 * Provider configs are stored as opaque JSON server-side, but here we
 * render structured forms per kind so the admin doesn't have to know
 * the schema by heart.
 */

type ProviderKind = "oidc" | "saml" | "ldap";

interface Provider {
  id: number;
  kind: ProviderKind;
  name: string;
  is_enabled: boolean;
  default_role: string;
  config: Record<string, unknown>;
  updated_at: number;
}

interface ApiKey {
  id: number;
  user_id: number;
  user_email: string;
  name: string;
  prefix: string;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

interface User {
  id: number;
  email: string;
  role: string;
}

const subtab = ref<"providers" | "api_keys" | "allowlist">("providers");

const providers = ref<Provider[]>([]);
const apiKeys = ref<ApiKey[]>([]);
const users = ref<User[]>([]);
const allowlist = ref<string[]>([]);
const allowlistInput = ref("");
const error = ref("");
const toast = ref("");

function flash(msg: string) {
  toast.value = msg;
  setTimeout(() => (toast.value = ""), 3000);
}

async function load() {
  try {
    const [p, k, u, a] = await Promise.all([
      api.get<{ providers: Provider[] }>("/admin/auth/providers"),
      api.get<{ api_keys: ApiKey[] }>("/admin/api-keys"),
      api.get<User[]>("/admin/users"),
      api.get<{ domains: string[] }>("/admin/auth/allowlist"),
    ]);
    providers.value = p.providers;
    apiKeys.value = k.api_keys;
    users.value = u;
    allowlist.value = a.domains;
    allowlistInput.value = a.domains.join(", ");
  } catch (e) {
    error.value = (e as Error).message;
  }
}

onMounted(load);

// ---- Provider form -------------------------------------------------

interface ProviderDraft {
  id?: number;
  kind: ProviderKind;
  name: string;
  is_enabled: boolean;
  default_role: "admin" | "editor" | "viewer";
  // Per-kind config; we union all the fields the various forms touch.
  // The backend ignores fields the per-kind schema doesn't accept.
  config: Record<string, unknown>;
}

const draft = ref<ProviderDraft | null>(null);

function blankDraft(kind: ProviderKind): ProviderDraft {
  if (kind === "oidc") {
    return {
      kind, name: "", is_enabled: true, default_role: "viewer",
      config: {
        discovery_url: "", client_id: "", client_secret: "",
        scopes: "openid email profile", email_claim: "email",
        allowed_domains: [],
      },
    };
  }
  if (kind === "saml") {
    return {
      kind, name: "", is_enabled: true, default_role: "viewer",
      config: {
        entry_point: "", issuer: "", cert: "", private_key: "",
        email_attribute: "email", name_attribute: "displayName",
        allowed_domains: [],
      },
    };
  }
  return {
    kind, name: "", is_enabled: true, default_role: "viewer",
    config: {
      url: "", bind_dn: "", bind_password: "", search_base: "",
      search_filter: "(mail={{username}})",
      email_attribute: "mail", name_attribute: "displayName",
      start_tls: false,
    },
  };
}

function startAdd(kind: ProviderKind) {
  draft.value = blankDraft(kind);
}

function startEdit(p: Provider) {
  // Editing keeps the displayed mask in place — the server preserves
  // the existing secret when we POST the masked value back.
  draft.value = {
    id: p.id,
    kind: p.kind,
    name: p.name,
    is_enabled: p.is_enabled,
    default_role: p.default_role as "admin" | "editor" | "viewer",
    config: { ...p.config },
  };
}

async function saveProvider() {
  if (!draft.value) return;
  if (!draft.value.name.trim()) {
    error.value = "Name is required";
    return;
  }
  // allowed_domains is captured as a comma-separated string by the
  // form's input — split here so the backend gets an array.
  const cfg = { ...draft.value.config };
  if (typeof cfg.allowed_domains === "string") {
    cfg.allowed_domains = (cfg.allowed_domains as string)
      .split(",").map((s) => s.trim()).filter(Boolean);
  }
  const body = {
    kind: draft.value.kind,
    name: draft.value.name.trim(),
    is_enabled: draft.value.is_enabled,
    default_role: draft.value.default_role,
    config: cfg,
  };
  try {
    if (draft.value.id != null) {
      await api.put(`/admin/auth/providers/${draft.value.id}`, body);
    } else {
      await api.post("/admin/auth/providers", body);
    }
    draft.value = null;
    flash("Provider saved.");
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function deleteProvider(p: Provider) {
  if (!confirm(`Delete provider "${p.name}"? Existing users that signed in via this IdP keep their accounts.`)) return;
  try {
    await api.del(`/admin/auth/providers/${p.id}`);
    flash("Provider deleted.");
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function configString(p: Provider, key: string): string {
  const v = p.config[key];
  if (Array.isArray(v)) return v.join(", ");
  return v == null ? "" : String(v);
}

// ---- API keys ------------------------------------------------------

const newKey = ref({ name: "", user_id: null as number | null, expires_in_days: 365 });
const lastIssued = ref<{ name: string; plaintext: string } | null>(null);

async function createKey() {
  if (!newKey.value.name.trim()) {
    error.value = "Name is required";
    return;
  }
  try {
    const r = await api.post<{ plaintext: string; name: string }>("/admin/api-keys", {
      name: newKey.value.name.trim(),
      user_id: newKey.value.user_id ?? undefined,
      expires_in_days: newKey.value.expires_in_days || undefined,
    });
    lastIssued.value = { name: r.name, plaintext: r.plaintext };
    newKey.value.name = "";
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function revokeKey(k: ApiKey) {
  if (!confirm(`Revoke "${k.name}"? Anything using this key will start getting 401.`)) return;
  try {
    await api.del(`/admin/api-keys/${k.id}`);
    flash("Key revoked.");
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function copyPlaintext() {
  if (!lastIssued.value) return;
  navigator.clipboard.writeText(lastIssued.value.plaintext).catch(() => {});
  flash("Copied.");
}

const activeApiKeys = computed(() => apiKeys.value.filter((k) => !k.revoked_at));
const revokedApiKeys = computed(() => apiKeys.value.filter((k) => !!k.revoked_at));

// ---- Allowlist -----------------------------------------------------

async function saveAllowlist() {
  const domains = allowlistInput.value
    .split(/[,\n]+/).map((s) => s.trim()).filter(Boolean);
  try {
    await api.put("/admin/auth/allowlist", { domains });
    flash("Allowlist saved.");
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function fmtDate(ts: number | null): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString();
}

// Vue templates can't reference `window` directly — expose a computed
// so the callback / ACS URL hints can show "<origin>/api/auth/…".
const origin = computed(() => window.location.origin);
</script>

<template>
  <div class="auth-settings">
    <p v-if="error" class="auth__error">{{ error }}</p>
    <p v-if="toast" class="auth__toast">{{ toast }}</p>

    <div class="auth__subtabs">
      <button
        class="auth__subtab"
        :class="{ 'auth__subtab--active': subtab === 'providers' }"
        @click="subtab = 'providers'"
      >SSO providers</button>
      <button
        class="auth__subtab"
        :class="{ 'auth__subtab--active': subtab === 'api_keys' }"
        @click="subtab = 'api_keys'"
      >API keys</button>
      <button
        class="auth__subtab"
        :class="{ 'auth__subtab--active': subtab === 'allowlist' }"
        @click="subtab = 'allowlist'"
      >Email allowlist</button>
    </div>

    <!-- ============== Providers ============== -->
    <section v-if="subtab === 'providers'" class="auth__section">
      <div v-if="!draft" class="auth__add-row">
        <span class="auth__add-label">Add a provider:</span>
        <button class="btn btn-sm" @click="startAdd('oidc')">+ OIDC / OAuth2</button>
        <button class="btn btn-sm" @click="startAdd('saml')">+ SAML 2.0</button>
        <button class="btn btn-sm" @click="startAdd('ldap')">+ LDAP / AD</button>
      </div>

      <form v-if="draft" class="auth__form" @submit.prevent="saveProvider">
        <header class="auth__form-head">
          <h4>
            {{ draft.id ? "Edit" : "New" }}
            {{ draft.kind === "oidc" ? "OIDC / OAuth2" : draft.kind === "saml" ? "SAML 2.0" : "LDAP" }}
            provider
          </h4>
          <button type="button" class="btn btn-ghost btn-sm" @click="draft = null">Cancel</button>
        </header>

        <div class="auth__form-row">
          <label class="auth__field">
            <span>Display name</span>
            <input v-model="draft.name" placeholder="e.g. Google Workspace" required />
          </label>
          <label class="auth__field auth__field--narrow">
            <span>Default role</span>
            <select v-model="draft.default_role">
              <option value="viewer">viewer</option>
              <option value="editor">editor</option>
              <option value="admin">admin</option>
            </select>
          </label>
          <label class="auth__checkbox">
            <input v-model="draft.is_enabled" type="checkbox" />
            <span>Enabled</span>
          </label>
        </div>

        <!-- OIDC fields -->
        <template v-if="draft.kind === 'oidc'">
          <label class="auth__field">
            <span>Discovery URL <small>(/.well-known/openid-configuration)</small></span>
            <input v-model="(draft.config as any).discovery_url" placeholder="https://accounts.google.com/.well-known/openid-configuration" />
          </label>
          <div class="auth__form-row">
            <label class="auth__field">
              <span>Client ID</span>
              <input v-model="(draft.config as any).client_id" required />
            </label>
            <label class="auth__field">
              <span>Client secret</span>
              <input v-model="(draft.config as any).client_secret" type="password" placeholder="(leave blank to keep existing)" />
            </label>
          </div>
          <div class="auth__form-row">
            <label class="auth__field">
              <span>Scopes</span>
              <input v-model="(draft.config as any).scopes" placeholder="openid email profile" />
            </label>
            <label class="auth__field">
              <span>Email claim</span>
              <input v-model="(draft.config as any).email_claim" placeholder="email" />
            </label>
          </div>
          <label class="auth__field">
            <span>Restrict to email domains <small>(comma-separated, optional)</small></span>
            <input v-model="(draft.config as any).allowed_domains" placeholder="acme.com, example.org" />
          </label>
          <p class="auth__hint">
            Callback URL (register this with your IdP):
            <code>{{ origin }}/api/auth/oidc/{{ draft.id ?? "<NEW>" }}/callback</code>
          </p>
        </template>

        <!-- SAML fields -->
        <template v-if="draft.kind === 'saml'">
          <label class="auth__field">
            <span>IdP SSO URL <small>(entry point)</small></span>
            <input v-model="(draft.config as any).entry_point" placeholder="https://idp.example.com/sso" required />
          </label>
          <label class="auth__field">
            <span>SP entity ID <small>(issuer)</small></span>
            <input v-model="(draft.config as any).issuer" placeholder="crunch:sp" required />
          </label>
          <label class="auth__field">
            <span>IdP X.509 certificate (PEM)</span>
            <textarea v-model="(draft.config as any).cert" rows="6" required placeholder="-----BEGIN CERTIFICATE-----..." />
          </label>
          <label class="auth__field">
            <span>SP private key (optional, PEM — for signed AuthnRequests)</span>
            <textarea v-model="(draft.config as any).private_key" rows="4" placeholder="(leave blank to keep existing or skip signing)" />
          </label>
          <div class="auth__form-row">
            <label class="auth__field">
              <span>Email attribute</span>
              <input v-model="(draft.config as any).email_attribute" placeholder="email" />
            </label>
            <label class="auth__field">
              <span>Name attribute</span>
              <input v-model="(draft.config as any).name_attribute" placeholder="displayName" />
            </label>
          </div>
          <label class="auth__field">
            <span>Restrict to email domains</span>
            <input v-model="(draft.config as any).allowed_domains" placeholder="acme.com, example.org" />
          </label>
          <p class="auth__hint">
            ACS URL (register with your IdP):
            <code>{{ origin }}/api/auth/saml/{{ draft.id ?? "<NEW>" }}/acs</code>
          </p>
        </template>

        <!-- LDAP fields -->
        <template v-if="draft.kind === 'ldap'">
          <label class="auth__field">
            <span>LDAP URL</span>
            <input v-model="(draft.config as any).url" placeholder="ldaps://ldap.acme.com:636" required />
          </label>
          <div class="auth__form-row">
            <label class="auth__field">
              <span>Bind DN <small>(service account)</small></span>
              <input v-model="(draft.config as any).bind_dn" placeholder="cn=svc-crunch,ou=Users,dc=acme,dc=com" />
            </label>
            <label class="auth__field">
              <span>Bind password</span>
              <input v-model="(draft.config as any).bind_password" type="password" placeholder="(leave blank to keep existing)" />
            </label>
          </div>
          <label class="auth__field">
            <span>Search base</span>
            <input v-model="(draft.config as any).search_base" placeholder="ou=Users,dc=acme,dc=com" required />
          </label>
          <label class="auth__field">
            <span>Search filter <small>(use <code v-pre>{{username}}</code> as placeholder)</small></span>
            <input v-model="(draft.config as any).search_filter" placeholder="(mail={{username}})" />
          </label>
          <div class="auth__form-row">
            <label class="auth__field">
              <span>Email attribute</span>
              <input v-model="(draft.config as any).email_attribute" placeholder="mail" />
            </label>
            <label class="auth__field">
              <span>Name attribute</span>
              <input v-model="(draft.config as any).name_attribute" placeholder="displayName" />
            </label>
            <label class="auth__checkbox">
              <input v-model="(draft.config as any).start_tls" type="checkbox" />
              <span>StartTLS</span>
            </label>
          </div>
        </template>

        <footer class="auth__form-foot">
          <button type="submit" class="btn btn-primary btn-sm">Save provider</button>
        </footer>
      </form>

      <div v-if="providers.length === 0 && !draft" class="auth__empty">
        No SSO providers configured. Add one above to enable single sign-on.
      </div>

      <ul v-if="providers.length > 0" class="auth__list">
        <li v-for="p in providers" :key="p.id" class="auth__item">
          <div class="auth__item-main">
            <span class="auth__kind">{{ p.kind }}</span>
            <span class="auth__item-name">{{ p.name }}</span>
            <span v-if="!p.is_enabled" class="auth__pill auth__pill--off">disabled</span>
            <span class="auth__role">default role: {{ p.default_role }}</span>
          </div>
          <div class="auth__item-meta">
            <span v-if="p.kind === 'oidc'">{{ configString(p, "discovery_url") || configString(p, "issuer") }}</span>
            <span v-else-if="p.kind === 'saml'">{{ configString(p, "entry_point") }}</span>
            <span v-else>{{ configString(p, "url") }} · base: {{ configString(p, "search_base") }}</span>
          </div>
          <div class="auth__item-actions">
            <button class="btn btn-sm" @click="startEdit(p)">Edit</button>
            <button class="btn btn-ghost btn-sm" @click="deleteProvider(p)">Delete</button>
          </div>
        </li>
      </ul>
    </section>

    <!-- ============== API keys ============== -->
    <section v-if="subtab === 'api_keys'" class="auth__section">
      <p class="auth__hint">
        Long-lived bearer tokens for embedding or script access. The plaintext is shown
        once at creation — copy it then. Storage is hash-only, so a leaked DB can't
        replay the key.
      </p>

      <div v-if="lastIssued" class="auth__issued">
        <strong>Save this — it's shown once:</strong>
        <code>{{ lastIssued.plaintext }}</code>
        <button class="btn btn-sm" @click="copyPlaintext">Copy</button>
        <button class="btn btn-ghost btn-sm" @click="lastIssued = null">Dismiss</button>
      </div>

      <form class="auth__form auth__form--inline" @submit.prevent="createKey">
        <input
          v-model="newKey.name"
          placeholder="key name (e.g. dashboards-cron)"
          required
        />
        <select v-model="newKey.user_id">
          <option :value="null">(my account)</option>
          <option v-for="u in users" :key="u.id" :value="u.id">{{ u.email }} ({{ u.role }})</option>
        </select>
        <label class="auth__inline-field">
          <span>Expires in</span>
          <input v-model.number="newKey.expires_in_days" type="number" min="1" max="3650" />
          <small>days (blank = never)</small>
        </label>
        <button type="submit" class="btn btn-primary btn-sm">+ Issue key</button>
      </form>

      <table class="auth__table">
        <thead>
          <tr>
            <th>Name</th>
            <th>User</th>
            <th>Prefix</th>
            <th>Last used</th>
            <th>Expires</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="k in activeApiKeys" :key="k.id">
            <td>{{ k.name }}</td>
            <td>{{ k.user_email }}</td>
            <td class="auth__mono">{{ k.prefix }}…</td>
            <td>{{ fmtDate(k.last_used_at) }}</td>
            <td>{{ fmtDate(k.expires_at) }}</td>
            <td><button class="btn btn-sm" @click="revokeKey(k)">Revoke</button></td>
          </tr>
          <tr v-if="activeApiKeys.length === 0">
            <td colspan="6" class="auth__empty-row">No active API keys.</td>
          </tr>
        </tbody>
      </table>

      <details v-if="revokedApiKeys.length > 0" class="auth__revoked-details">
        <summary>{{ revokedApiKeys.length }} revoked key(s)</summary>
        <ul class="auth__revoked-list">
          <li v-for="k in revokedApiKeys" :key="k.id">
            <span class="auth__mono">{{ k.prefix }}…</span>
            "{{ k.name }}" — {{ k.user_email }} — revoked {{ fmtDate(k.revoked_at) }}
          </li>
        </ul>
      </details>
    </section>

    <!-- ============== Allowlist ============== -->
    <section v-if="subtab === 'allowlist'" class="auth__section">
      <p class="auth__hint">
        Restrict new accounts to specific email domains. Applies to public registration
        <em>and</em> SSO sign-ins, so a leaked OIDC link can't enroll outsiders. Leave
        blank to allow any domain.
      </p>
      <label class="auth__field">
        <span>Allowed domains (comma- or newline-separated)</span>
        <textarea v-model="allowlistInput" rows="3" placeholder="acme.com, example.org" />
      </label>
      <div class="auth__row">
        <span v-if="allowlist.length === 0" class="auth__pill auth__pill--off">unrestricted</span>
        <span v-else class="auth__pill auth__pill--on">{{ allowlist.length }} domain(s) restricted</span>
        <button class="btn btn-primary btn-sm" @click="saveAllowlist">Save allowlist</button>
      </div>
    </section>
  </div>
</template>

<style scoped>
.auth-settings { display: grid; gap: 14px; }
.auth__error {
  background: rgba(224, 122, 95, 0.08);
  border: 1px solid rgba(224, 122, 95, 0.3);
  color: var(--error);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  margin: 0;
}
.auth__toast {
  margin: 0;
  padding: 6px 12px;
  background: rgba(127, 176, 105, 0.12);
  color: var(--success);
  border-radius: var(--radius-sm);
  font-size: 12px;
}

.auth__subtabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 8px;
}
.auth__subtab {
  padding: 6px 12px;
  font-size: 12px;
  color: var(--fg-muted);
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  cursor: pointer;
}
.auth__subtab--active {
  color: var(--fg);
  border-bottom-color: var(--accent);
}

.auth__section { display: grid; gap: 12px; }
.auth__hint {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
  line-height: 1.5;
}
.auth__hint code {
  font-family: var(--font-mono);
  background: var(--bg);
  padding: 1px 5px;
  border-radius: 3px;
}
.auth__empty {
  padding: 20px 16px;
  background: var(--bg);
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--fg-subtle);
  text-align: center;
}

.auth__add-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.auth__add-label { font-size: 12px; color: var(--fg-muted); }

.auth__form {
  display: grid;
  gap: 12px;
  padding: 16px;
  background: var(--bg);
  border: 1px solid var(--accent-border);
  border-radius: var(--radius);
}
.auth__form--inline {
  display: grid;
  grid-template-columns: 1.4fr 1.2fr 130px auto;
  gap: 8px;
  align-items: center;
  padding: 12px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
}
.auth__form-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.auth__form-head h4 {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 14px;
  font-weight: 500;
}
.auth__form-row {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 10px;
  align-items: end;
}
.auth__field {
  display: grid;
  gap: 4px;
  font-size: 12px;
  color: var(--fg-muted);
}
.auth__field--narrow { max-width: 130px; }
.auth__field small {
  color: var(--fg-subtle);
  font-size: 10px;
  font-weight: 400;
  margin-left: 6px;
}
.auth__field input,
.auth__field select,
.auth__field textarea {
  font-size: 13px;
  padding: 6px 8px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
  font-family: inherit;
}
.auth__field textarea {
  font-family: var(--font-mono);
  font-size: 11.5px;
  resize: vertical;
}
.auth__checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fg-muted);
  white-space: nowrap;
}
.auth__form-foot { display: flex; justify-content: flex-end; }
.auth__inline-field {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 11px;
  color: var(--fg-subtle);
}
.auth__inline-field input { width: 60px; padding: 4px 6px; }

.auth__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  gap: 4px;
}
.auth__item {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px;
  padding: 10px 14px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.auth__item-main {
  display: flex;
  align-items: center;
  gap: 10px;
}
.auth__kind {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: var(--accent-subtle);
  color: var(--accent);
  padding: 2px 8px;
  border-radius: 999px;
  font-family: var(--font-mono);
}
.auth__item-name { color: var(--fg); font-weight: 500; }
.auth__role { font-size: 11px; color: var(--fg-subtle); }
.auth__item-meta {
  grid-column: 1 / -1;
  font-size: 11.5px;
  color: var(--fg-muted);
  font-family: var(--font-mono);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.auth__item-actions {
  display: flex;
  gap: 6px;
  align-self: start;
}
.auth__pill {
  font-size: 10px;
  font-family: var(--font-mono);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 1px 6px;
  border-radius: 999px;
}
.auth__pill--off { background: var(--bg-elev); color: var(--fg-subtle); border: 1px solid var(--border); }
.auth__pill--on { background: rgba(127, 176, 105, 0.14); color: var(--success); }

.auth__issued {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  background: var(--accent-subtle);
  border: 1px solid var(--accent-border);
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.auth__issued code {
  font-family: var(--font-mono);
  background: var(--bg);
  padding: 4px 8px;
  border-radius: 3px;
  flex: 1;
  overflow: auto;
  word-break: break-all;
}

.auth__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.auth__table th {
  text-align: left;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-subtle);
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-weight: 500;
}
.auth__table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
}
.auth__mono { font-family: var(--font-mono); font-size: 12px; color: var(--fg-muted); }
.auth__empty-row {
  text-align: center;
  color: var(--fg-subtle);
  font-size: 12px;
  padding: 20px;
}
.auth__revoked-details {
  margin-top: 12px;
  font-size: 12px;
  color: var(--fg-subtle);
}
.auth__revoked-list {
  list-style: none;
  padding: 8px 0;
  margin: 0;
  display: grid;
  gap: 4px;
}

.auth__row {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
</style>
