<script setup lang="ts">
import { onMounted, ref } from "vue";
import { api } from "@/api/client";
import { useAuthStore } from "@/stores/auth";

interface Pkg {
  id: number;
  package_name: string;
  import_name: string | null;
  version_spec: string | null;
  installed_version: string | null;
  status: string;
  error_message: string | null;
  is_default: boolean;
  is_enabled: boolean;
}

interface AdminUser {
  id: number;
  email: string;
  role: string;
  created_at: number;
}

const auth = useAuthStore();
const tab = ref<"settings" | "packages" | "users" | "git">("settings");

interface ModelOption { id: string; label: string }
interface SettingsState {
  anthropic_api_key_masked: string;
  anthropic_api_key_set: boolean;
  anthropic_model: string;
  known_models: ModelOption[];
}
const settings = ref<SettingsState | null>(null);
const apiKeyInput = ref("");
const modelInput = ref("");
const settingsBusy = ref(false);
const settingsToast = ref("");

async function loadSettings() {
  try {
    const s = await api.get<SettingsState>("/admin/settings");
    settings.value = s;
    modelInput.value = s.anthropic_model;
    apiKeyInput.value = "";
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function saveSettings() {
  settingsBusy.value = true;
  settingsToast.value = "";
  error.value = "";
  try {
    const body: Record<string, string> = { anthropic_model: modelInput.value };
    if (apiKeyInput.value.trim() !== "") body.anthropic_api_key = apiKeyInput.value.trim();
    const s = await api.put<SettingsState>("/admin/settings", body);
    settings.value = s;
    apiKeyInput.value = "";
    modelInput.value = s.anthropic_model;
    settingsToast.value = "Saved.";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    settingsBusy.value = false;
  }
}

async function clearApiKey() {
  if (!confirm("Remove the stored Anthropic API key?")) return;
  settingsBusy.value = true;
  error.value = "";
  try {
    const s = await api.put<SettingsState>("/admin/settings", { anthropic_api_key: "" });
    settings.value = s;
    apiKeyInput.value = "";
    settingsToast.value = "API key cleared.";
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    settingsBusy.value = false;
  }
}

const packages = ref<Pkg[]>([]);
const users = ref<AdminUser[]>([]);
const busy = ref<Record<number, boolean>>({});
const error = ref("");

interface GitStatus {
  initialized: boolean;
  branch: string | null;
  remote_url: string | null;
  ahead: number;
  behind: number;
  has_uncommitted: boolean;
  uncommitted_files: string[];
  last_commit: { sha: string; subject: string; author: string; date: string } | null;
  workspace_dir: string;
}
interface GitLogEntry {
  sha: string;
  subject: string;
  author: string;
  date: string;
}

const gitStatus = ref<GitStatus | null>(null);
const gitLog = ref<GitLogEntry[]>([]);
const gitMessage = ref("");
const gitRemote = ref("");
const gitBusy = ref(false);
const gitToast = ref("");

async function loadGit() {
  try {
    const s = await api.get<GitStatus>("/git/status");
    gitStatus.value = s;
    gitRemote.value = s.remote_url ?? "";
    if (s.initialized) {
      const log = await api.get<{ entries: GitLogEntry[] }>("/git/log");
      gitLog.value = log.entries;
    } else {
      gitLog.value = [];
    }
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function gitDo<T>(label: string, fn: () => Promise<T>): Promise<void> {
  gitBusy.value = true;
  gitToast.value = "";
  error.value = "";
  try {
    await fn();
    gitToast.value = label;
    await loadGit();
  } catch (e) {
    error.value = `${label}: ${(e as Error).message}`;
  } finally {
    gitBusy.value = false;
  }
}

async function gitInit() {
  await gitDo("Initialized git repo", () => api.post("/git/init", {}));
}
async function gitSyncExport() {
  await gitDo("Exported workspace", () => api.post("/git/sync-export", {}));
}
async function gitCommit() {
  if (!gitMessage.value.trim()) {
    error.value = "Commit message required";
    return;
  }
  const msg = gitMessage.value.trim();
  await gitDo(`Committed: "${msg}"`, async () => {
    const r = await api.post<{ committed: boolean; sha: string | null; stderr: string }>(
      "/git/commit",
      { message: msg, sync_first: true },
    );
    if (!r.committed) throw new Error(r.stderr || "nothing committed");
    gitMessage.value = "";
  });
}
async function gitPush() {
  await gitDo("Pushed to remote", () => api.post("/git/push", {}));
}
async function gitPull() {
  await gitDo("Pulled from remote", () => api.post("/git/pull", {}));
}
async function gitSetRemote() {
  if (!gitRemote.value.trim()) return;
  await gitDo("Remote set", () =>
    api.put("/git/remote", { url: gitRemote.value.trim() }),
  );
}
async function gitClone() {
  if (!gitRemote.value.trim()) {
    error.value = "Enter a clone URL first";
    return;
  }
  if (
    !confirm(
      "Clone will overwrite the workspace directory. The DB will then be augmented with anything new in the cloned repo. Continue?",
    )
  )
    return;
  await gitDo("Cloned", () => api.post("/git/clone", { url: gitRemote.value.trim() }));
}

const newPkg = ref({ package_name: "", version_spec: "", auto_install: true });
const adding = ref(false);

async function loadAll() {
  try {
    const [pkgs, us] = await Promise.all([
      api.get<Pkg[]>("/admin/packages"),
      api.get<AdminUser[]>("/admin/users"),
    ]);
    packages.value = pkgs;
    users.value = us;
  } catch (e) {
    error.value = (e as Error).message;
  }
  await Promise.all([loadGit(), loadSettings()]);
}

onMounted(loadAll);

async function add() {
  if (!newPkg.value.package_name.trim()) return;
  adding.value = true;
  error.value = "";
  try {
    await api.post("/admin/packages", {
      package_name: newPkg.value.package_name.trim(),
      version_spec: newPkg.value.version_spec.trim() || undefined,
      auto_install: newPkg.value.auto_install,
    });
    newPkg.value = { package_name: "", version_spec: "", auto_install: true };
    await loadAll();
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    adding.value = false;
  }
}

async function install(id: number) {
  busy.value[id] = true;
  try {
    await api.post(`/admin/packages/${id}/install`, {});
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value[id] = false;
    await loadAll();
  }
}

async function uninstall(id: number) {
  if (!confirm("Uninstall this package?")) return;
  busy.value[id] = true;
  try {
    await api.post(`/admin/packages/${id}/uninstall`, {});
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value[id] = false;
    await loadAll();
  }
}

async function toggle(p: Pkg) {
  await api.put(`/admin/packages/${p.id}`, { is_enabled: !p.is_enabled });
  await loadAll();
}

async function removePkg(p: Pkg) {
  if (!confirm(`Delete ${p.package_name}?`)) return;
  try {
    await api.del(`/admin/packages/${p.id}`);
  } catch (e) {
    error.value = (e as Error).message;
  }
  await loadAll();
}

async function setRole(u: AdminUser, role: string) {
  if (u.id === auth.user?.id && role !== "admin") return;
  try {
    await api.put(`/admin/users/${u.id}/role`, { role });
  } catch (e) {
    error.value = (e as Error).message;
  }
  await loadAll();
}
</script>

<template>
  <div class="admin">
    <header class="admin__head">
      <h1>Admin</h1>
      <p>Manage the visualization sandbox whitelist and user roles.</p>
    </header>

    <div class="admin__tabs">
      <button
        class="admin__tab"
        :class="{ 'admin__tab--active': tab === 'settings' }"
        @click="tab = 'settings'"
      >
        Settings
      </button>
      <button
        class="admin__tab"
        :class="{ 'admin__tab--active': tab === 'packages' }"
        @click="tab = 'packages'"
      >
        Allowed packages
      </button>
      <button
        class="admin__tab"
        :class="{ 'admin__tab--active': tab === 'users' }"
        @click="tab = 'users'"
      >
        Users
      </button>
      <button
        class="admin__tab"
        :class="{ 'admin__tab--active': tab === 'git' }"
        @click="tab = 'git'"
      >
        Git
      </button>
    </div>

    <p v-if="error" class="admin__error">{{ error }}</p>

    <!-- Packages -->
    <section v-if="tab === 'packages'" class="admin__section">
      <div class="admin__form">
        <input
          v-model="newPkg.package_name"
          placeholder="package name (e.g. duckdb)"
        />
        <input
          v-model="newPkg.version_spec"
          placeholder="version spec (optional, e.g. >=1.0)"
        />
        <label class="admin__check">
          <input v-model="newPkg.auto_install" type="checkbox" />
          Install now
        </label>
        <button class="btn btn-primary btn-sm" :disabled="adding" @click="add">
          {{ adding ? "Installing…" : "+ Add" }}
        </button>
      </div>

      <table class="admin__table">
        <thead>
          <tr>
            <th>Package</th>
            <th>Import</th>
            <th>Version</th>
            <th>Status</th>
            <th>Enabled</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in packages" :key="p.id">
            <td>
              <div class="admin__pkg">
                <strong>{{ p.package_name }}</strong>
                <span v-if="p.is_default" class="admin__badge">default</span>
              </div>
            </td>
            <td class="admin__mono">{{ p.import_name ?? "—" }}</td>
            <td class="admin__mono">{{ p.installed_version ?? p.version_spec ?? "—" }}</td>
            <td>
              <span class="admin__status" :class="`admin__status--${p.status}`">
                {{ p.status }}
              </span>
              <div v-if="p.error_message" class="admin__err">{{ p.error_message }}</div>
            </td>
            <td>
              <button
                class="admin__toggle"
                :class="{ 'admin__toggle--on': p.is_enabled }"
                @click="toggle(p)"
                :title="p.is_enabled ? 'Disable' : 'Enable'"
              >
                <span />
              </button>
            </td>
            <td class="admin__actions">
              <button
                v-if="p.status !== 'installed'"
                class="btn btn-sm"
                :disabled="busy[p.id]"
                @click="install(p.id)"
              >
                {{ busy[p.id] ? "..." : "Install" }}
              </button>
              <button
                v-if="!p.is_default && p.status === 'installed'"
                class="btn btn-sm"
                :disabled="busy[p.id]"
                @click="uninstall(p.id)"
              >
                Uninstall
              </button>
              <button
                v-if="!p.is_default"
                class="btn btn-ghost btn-icon"
                title="Delete"
                @click="removePkg(p)"
              >×</button>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- Settings -->
    <section v-if="tab === 'settings'" class="admin__section">
      <div v-if="settings" class="settings">
        <div class="settings__group">
          <h3>AI / Chat &amp; Agent</h3>
          <p class="settings__hint">
            Used by the Chat panel and agent tools. The key is stored locally in your
            NiceMeta database and never leaves this machine except to call api.anthropic.com.
          </p>

          <label class="settings__field">
            <span>Anthropic API key</span>
            <div class="settings__row">
              <input
                v-model="apiKeyInput"
                type="password"
                autocomplete="off"
                :placeholder="settings.anthropic_api_key_set ? settings.anthropic_api_key_masked : 'sk-ant-…'"
              />
              <button
                v-if="settings.anthropic_api_key_set"
                type="button"
                class="btn btn-sm"
                :disabled="settingsBusy"
                @click="clearApiKey"
              >
                Clear
              </button>
            </div>
            <small v-if="settings.anthropic_api_key_set">
              Currently set: <code>{{ settings.anthropic_api_key_masked }}</code>.
              Enter a new value to replace it.
            </small>
            <small v-else class="settings__warn">
              Not configured — Chat / Agent calls will fail until you set this.
            </small>
          </label>

          <label class="settings__field">
            <span>Model</span>
            <select v-model="modelInput">
              <option v-for="m in settings.known_models" :key="m.id" :value="m.id">
                {{ m.label }}
              </option>
            </select>
            <small>Applied to every Chat and Agent request from now on.</small>
          </label>

          <div class="settings__row settings__row--end">
            <span v-if="settingsToast" class="settings__toast">{{ settingsToast }}</span>
            <button
              class="btn btn-primary btn-sm"
              :disabled="settingsBusy"
              @click="saveSettings"
            >
              {{ settingsBusy ? "Saving…" : "Save settings" }}
            </button>
          </div>
        </div>
      </div>
    </section>

    <!-- Users -->
    <section v-if="tab === 'users'" class="admin__section">
      <table class="admin__table">
        <thead>
          <tr>
            <th>Email</th>
            <th>Role</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="u in users" :key="u.id">
            <td>
              {{ u.email }}
              <span v-if="u.id === auth.user?.id" class="admin__badge">you</span>
            </td>
            <td>
              <select
                :value="u.role"
                :disabled="u.id === auth.user?.id"
                @change="setRole(u, ($event.target as HTMLSelectElement).value)"
              >
                <option value="viewer">viewer</option>
                <option value="editor">editor</option>
                <option value="admin">admin</option>
              </select>
            </td>
            <td class="admin__mono admin__date">
              {{ new Date(u.created_at * 1000).toLocaleDateString() }}
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- Git -->
    <section v-if="tab === 'git'" class="admin__section">
      <p class="git__intro">
        Mirror your saved queries, visualizations and dashboards to a real git
        repo so you can back them up to GitHub, sync between machines, or load
        a colleague's collection. Files live in
        <code>{{ gitStatus?.workspace_dir ?? "the workspace directory" }}</code>.
      </p>

      <div v-if="gitStatus" class="git__status">
        <div class="git__status-row">
          <span class="git__status-key">Repo</span>
          <span class="git__status-val">
            {{ gitStatus.initialized ? `initialized · ${gitStatus.branch ?? "?"}` : "not a git repo" }}
          </span>
        </div>
        <div class="git__status-row">
          <span class="git__status-key">Remote</span>
          <span class="git__status-val">{{ gitStatus.remote_url ?? "—" }}</span>
        </div>
        <div v-if="gitStatus.initialized" class="git__status-row">
          <span class="git__status-key">Sync</span>
          <span class="git__status-val">
            {{ gitStatus.ahead }} ahead · {{ gitStatus.behind }} behind
            <span v-if="gitStatus.has_uncommitted" class="git__dirty">
              · {{ gitStatus.uncommitted_files.length }} uncommitted change(s)
            </span>
          </span>
        </div>
        <div v-if="gitStatus.last_commit" class="git__status-row">
          <span class="git__status-key">HEAD</span>
          <span class="git__status-val git__mono">
            {{ gitStatus.last_commit.sha.slice(0, 8) }} — {{ gitStatus.last_commit.subject }}
          </span>
        </div>
      </div>

      <p v-if="gitToast" class="git__toast">{{ gitToast }}</p>

      <div v-if="!gitStatus?.initialized" class="git__init">
        <p>This workspace isn't a git repo yet.</p>
        <div class="git__row">
          <button class="btn btn-primary btn-sm" :disabled="gitBusy" @click="gitInit">
            Initialize repo
          </button>
          <span class="git__or">or</span>
          <input
            v-model="gitRemote"
            placeholder="https://github.com/you/your-collection.git"
            class="git__input"
          />
          <button class="btn btn-sm" :disabled="gitBusy" @click="gitClone">
            Clone existing
          </button>
        </div>
      </div>

      <div v-else class="git__panels">
        <div class="git__panel">
          <h4>Remote</h4>
          <div class="git__row">
            <input v-model="gitRemote" placeholder="git@github.com:you/repo.git" class="git__input" />
            <button class="btn btn-sm" :disabled="gitBusy" @click="gitSetRemote">Set</button>
          </div>
        </div>

        <div class="git__panel">
          <h4>Sync &amp; commit</h4>
          <p class="git__hint">
            <strong>Export</strong> writes the current DB state to disk;
            <strong>commit</strong> stages and records it; <strong>push</strong>
            uploads to the remote.
          </p>
          <div class="git__row">
            <button class="btn btn-sm" :disabled="gitBusy" @click="gitSyncExport">
              Export workspace
            </button>
          </div>
          <div class="git__row">
            <input
              v-model="gitMessage"
              placeholder="Commit message…"
              class="git__input"
              @keyup.enter="gitCommit"
            />
            <button class="btn btn-primary btn-sm" :disabled="gitBusy" @click="gitCommit">
              Commit
            </button>
          </div>
          <div class="git__row">
            <button class="btn btn-sm" :disabled="gitBusy" @click="gitPush">Push</button>
            <button class="btn btn-sm" :disabled="gitBusy" @click="gitPull">Pull</button>
          </div>
        </div>

        <div v-if="gitLog.length > 0" class="git__panel">
          <h4>Recent commits</h4>
          <ul class="git__log">
            <li v-for="c in gitLog" :key="c.sha" class="git__log-row">
              <span class="git__mono git__sha">{{ c.sha.slice(0, 7) }}</span>
              <span class="git__log-subject">{{ c.subject }}</span>
              <span class="git__log-meta">
                {{ c.author }} · {{ new Date(c.date).toLocaleString() }}
              </span>
            </li>
          </ul>
        </div>

        <div v-if="gitStatus.uncommitted_files.length > 0" class="git__panel">
          <h4>Uncommitted</h4>
          <ul class="git__log">
            <li v-for="f in gitStatus.uncommitted_files" :key="f" class="git__mono git__log-row">
              {{ f }}
            </li>
          </ul>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.admin {
  padding: 32px 40px;
  max-width: 1100px;
  margin: 0 auto;
  height: 100%;
  overflow-y: auto;
}
.admin__head h1 {
  font-family: var(--font-serif);
  font-size: 28px;
  font-weight: 500;
  margin: 0;
  letter-spacing: -0.01em;
}
.admin__head p {
  color: var(--fg-muted);
  margin: 4px 0 24px;
  font-size: 13px;
}
.admin__tabs {
  display: flex;
  gap: 4px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 20px;
}
.admin__tab {
  padding: 8px 14px;
  font-size: 13px;
  color: var(--fg-muted);
  border-radius: 0;
  border-bottom: 2px solid transparent;
}
.admin__tab--active {
  color: var(--fg);
  border-bottom-color: var(--accent);
}
.admin__error {
  background: rgba(224, 122, 95, 0.08);
  border: 1px solid rgba(224, 122, 95, 0.3);
  color: var(--error);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.admin__section { margin-top: 16px; }

.admin__form {
  display: grid;
  grid-template-columns: 1.4fr 1fr auto auto;
  gap: 8px;
  align-items: center;
  margin-bottom: 18px;
  padding: 12px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}
.admin__check {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--fg-muted);
  white-space: nowrap;
}

.admin__table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.admin__table th {
  text-align: left;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-subtle);
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  font-weight: 500;
}
.admin__table td {
  padding: 10px 12px;
  border-bottom: 1px solid var(--border);
  vertical-align: middle;
}
.admin__pkg { display: flex; align-items: center; gap: 8px; }
.admin__badge {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg-elev-2);
  color: var(--fg-subtle);
  border: 1px solid var(--border);
}
.admin__mono { font-family: var(--font-mono); font-size: 12px; color: var(--fg-muted); }
.admin__date { color: var(--fg-subtle); }

.admin__status {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  background: var(--bg-elev-2);
  color: var(--fg-muted);
}
.admin__status--installed {
  background: rgba(127, 176, 105, 0.12);
  color: var(--success);
}
.admin__status--installing {
  background: var(--accent-subtle);
  color: var(--accent);
}
.admin__status--failed {
  background: rgba(224, 122, 95, 0.12);
  color: var(--error);
}
.admin__err {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--error);
  margin-top: 4px;
  max-width: 320px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.admin__toggle {
  width: 32px;
  height: 18px;
  border-radius: 999px;
  background: var(--border);
  position: relative;
  border: none;
  cursor: pointer;
  transition: background 150ms;
}
.admin__toggle span {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--bg);
  transition: transform 150ms;
}
.admin__toggle--on { background: var(--accent); }
.admin__toggle--on span { transform: translateX(14px); }

.admin__actions { display: flex; gap: 6px; justify-content: flex-end; }

.settings { display: grid; gap: 20px; max-width: 640px; }
.settings__group {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 18px 20px;
  display: grid;
  gap: 14px;
}
.settings__group h3 {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 16px;
  font-weight: 500;
}
.settings__hint { margin: 0; font-size: 12px; color: var(--fg-muted); line-height: 1.5; }
.settings__field { display: grid; gap: 6px; font-size: 12px; color: var(--fg-muted); }
.settings__field > span { color: var(--fg); font-weight: 500; font-size: 13px; }
.settings__field small { font-size: 11px; color: var(--fg-subtle); }
.settings__field small code {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--bg-elev-2);
  padding: 1px 5px;
  border-radius: 3px;
}
.settings__warn { color: var(--warn) !important; }
.settings__row { display: flex; gap: 8px; align-items: center; }
.settings__row--end { justify-content: flex-end; }
.settings__row input { flex: 1; }
.settings__toast {
  color: var(--success);
  font-size: 12px;
  margin-right: auto;
}

.git__intro { color: var(--fg-muted); font-size: 13px; margin: 0 0 16px; line-height: 1.5; }
.git__intro code {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 1px 5px;
  font-size: 12px;
}
.git__status {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 16px;
  margin-bottom: 12px;
  display: grid;
  gap: 6px;
}
.git__status-row {
  display: flex;
  gap: 12px;
  font-size: 13px;
}
.git__status-key {
  color: var(--fg-subtle);
  width: 70px;
  flex-shrink: 0;
}
.git__status-val { color: var(--fg); }
.git__dirty { color: var(--accent); }
.git__mono { font-family: var(--font-mono, ui-monospace, monospace); font-size: 12px; }
.git__toast {
  margin: 0 0 12px;
  padding: 8px 12px;
  background: var(--accent-subtle);
  color: var(--accent);
  border: 1px solid var(--accent-border);
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.git__init {
  background: var(--bg);
  border: 1px dashed var(--border);
  padding: 16px;
  border-radius: var(--radius-sm);
  display: grid;
  gap: 12px;
}
.git__init p { margin: 0; color: var(--fg-muted); font-size: 13px; }
.git__or { color: var(--fg-subtle); font-size: 12px; }
.git__row {
  display: flex;
  gap: 8px;
  align-items: center;
}
.git__input {
  flex: 1;
  font-size: 13px;
  padding: 6px 10px;
}
.git__panels {
  display: grid;
  gap: 16px;
}
.git__panel {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 14px 16px;
  display: grid;
  gap: 10px;
}
.git__panel h4 {
  margin: 0;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-muted);
  font-weight: 600;
}
.git__hint {
  margin: 0;
  font-size: 12px;
  color: var(--fg-subtle);
}
.git__log {
  list-style: none;
  padding: 0;
  margin: 0;
  display: grid;
  gap: 4px;
  max-height: 280px;
  overflow-y: auto;
}
.git__log-row {
  display: grid;
  grid-template-columns: 80px 1fr auto;
  gap: 10px;
  font-size: 12px;
  color: var(--fg-muted);
  padding: 4px 6px;
  border-radius: 3px;
}
.git__log-row:hover { background: var(--bg-hover); }
.git__sha { color: var(--accent); }
.git__log-subject { color: var(--fg); }
.git__log-meta { color: var(--fg-subtle); white-space: nowrap; }
</style>
