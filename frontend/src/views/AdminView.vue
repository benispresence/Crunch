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
const tab = ref<"packages" | "users">("packages");

const packages = ref<Pkg[]>([]);
const users = ref<AdminUser[]>([]);
const busy = ref<Record<number, boolean>>({});
const error = ref("");

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

    <!-- Users -->
    <section v-else class="admin__section">
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
</style>
