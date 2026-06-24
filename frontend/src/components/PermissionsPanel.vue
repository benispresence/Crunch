<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { api } from "@/api/client";

/**
 * Admin → Permissions.
 *
 * Two sub-views:
 *   - **Groups**: list permission bundles, edit which capabilities
 *     each carries, create new ones, delete non-system ones.
 *   - **User assignment**: per-user, which groups they're in. The
 *     resolved capability set is shown read-only so the admin can
 *     verify "what does this user actually see".
 *
 * Capabilities are static (registered in code) — we just render the
 * checklist + send the names back.
 */

interface Capability {
  name: string;
  description: string;
  category: string;
}
interface Group {
  id: number;
  name: string;
  description: string | null;
  is_system: number;
  permissions: string[];
  member_count: number;
}
interface User {
  id: number;
  email: string;
  role: string;
}

const sub = ref<"groups" | "users">("groups");
const caps = ref<Capability[]>([]);
const groups = ref<Group[]>([]);
const users = ref<User[]>([]);
const error = ref("");
const toast = ref("");

const editingGroupId = ref<number | null>(null);
const editingPerms = ref<Set<string>>(new Set());
const newGroup = ref({ name: "", description: "" });

const editingUserId = ref<number | null>(null);
const userGroups = ref<number[]>([]);
const userEffective = ref<string[]>([]);

function flash(msg: string) {
  toast.value = msg;
  setTimeout(() => (toast.value = ""), 2500);
}

async function load() {
  try {
    const [c, g, u] = await Promise.all([
      api.get<{ capabilities: Capability[] }>("/admin/permissions/capabilities"),
      api.get<{ groups: Group[] }>("/admin/permissions/groups"),
      api.get<User[]>("/admin/users"),
    ]);
    caps.value = c.capabilities;
    groups.value = g.groups;
    users.value = u;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

onMounted(load);

const capsByCategory = computed(() => {
  const out = new Map<string, Capability[]>();
  for (const c of caps.value) {
    if (!out.has(c.category)) out.set(c.category, []);
    out.get(c.category)!.push(c);
  }
  return out;
});

function startEditingGroup(g: Group) {
  editingGroupId.value = g.id;
  editingPerms.value = new Set(g.permissions);
}

function cancelEdit() {
  editingGroupId.value = null;
  editingPerms.value = new Set();
}

function togglePerm(name: string) {
  const s = new Set(editingPerms.value);
  if (s.has(name)) s.delete(name); else s.add(name);
  editingPerms.value = s;
}

async function saveGroupPerms() {
  if (editingGroupId.value == null) return;
  try {
    await api.put(`/admin/permissions/groups/${editingGroupId.value}`, {
      permissions: [...editingPerms.value],
    });
    flash("Group permissions saved.");
    cancelEdit();
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function createGroup() {
  if (!newGroup.value.name.trim()) return;
  try {
    await api.post("/admin/permissions/groups", {
      name: newGroup.value.name.trim(),
      description: newGroup.value.description || null,
    });
    newGroup.value = { name: "", description: "" };
    flash("Group created.");
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function deleteGroup(g: Group) {
  if (g.is_system) return;
  if (!confirm(`Delete group "${g.name}"? Members lose its capabilities but keep their accounts.`)) return;
  try {
    await api.del(`/admin/permissions/groups/${g.id}`);
    flash("Group deleted.");
    await load();
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function startEditingUser(u: User) {
  editingUserId.value = u.id;
  try {
    const r = await api.get<{ group_ids: number[]; effective_permissions: string[] }>(
      `/admin/users/${u.id}/groups`,
    );
    userGroups.value = r.group_ids;
    userEffective.value = r.effective_permissions;
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function toggleUserGroup(gid: number) {
  if (userGroups.value.includes(gid)) {
    userGroups.value = userGroups.value.filter((g) => g !== gid);
  } else {
    userGroups.value = [...userGroups.value, gid];
  }
}

async function saveUserGroups() {
  if (editingUserId.value == null) return;
  try {
    await api.put(`/admin/users/${editingUserId.value}/groups`, {
      group_ids: userGroups.value,
    });
    flash("Group membership saved.");
    // Re-fetch to update the effective set.
    const u = users.value.find((x) => x.id === editingUserId.value);
    if (u) await startEditingUser(u);
  } catch (e) {
    error.value = (e as Error).message;
  }
}
</script>

<template>
  <div class="perms">
    <p v-if="error" class="perms__error">{{ error }}</p>
    <p v-if="toast" class="perms__toast">{{ toast }}</p>

    <div class="perms__subtabs">
      <button class="perms__sub" :class="{ 'perms__sub--on': sub === 'groups' }" @click="sub = 'groups'">Groups</button>
      <button class="perms__sub" :class="{ 'perms__sub--on': sub === 'users' }" @click="sub = 'users'">User assignment</button>
    </div>

    <!-- Groups -->
    <section v-if="sub === 'groups'" class="perms__section">
      <form class="perms__newg" @submit.prevent="createGroup">
        <input v-model="newGroup.name" placeholder="New group name (e.g. Analytics team)" required />
        <input v-model="newGroup.description" placeholder="Description (optional)" />
        <button type="submit" class="btn btn-primary btn-sm">+ Add group</button>
      </form>

      <ul class="perms__groups">
        <li v-for="g in groups" :key="g.id" class="perms__group">
          <header class="perms__group-head">
            <div class="perms__group-name">
              {{ g.name }}
              <span v-if="g.is_system" class="perms__chip">system</span>
              <span class="perms__chip">{{ g.member_count }} member{{ g.member_count === 1 ? '' : 's' }}</span>
            </div>
            <div class="perms__group-actions">
              <button
                v-if="editingGroupId !== g.id"
                class="btn btn-sm"
                @click="startEditingGroup(g)"
              >Edit permissions</button>
              <template v-else>
                <button class="btn btn-ghost btn-sm" @click="cancelEdit">Cancel</button>
                <button class="btn btn-primary btn-sm" @click="saveGroupPerms">Save</button>
              </template>
              <button
                v-if="!g.is_system && editingGroupId !== g.id"
                class="btn btn-ghost btn-sm"
                @click="deleteGroup(g)"
              >Delete</button>
            </div>
          </header>
          <p v-if="g.description" class="perms__group-desc">{{ g.description }}</p>

          <div v-if="editingGroupId === g.id" class="perms__caps">
            <div v-for="[cat, items] in capsByCategory.entries()" :key="cat" class="perms__cat">
              <h5>{{ cat }}</h5>
              <label v-for="c in items" :key="c.name" class="perms__cap">
                <input
                  type="checkbox"
                  :checked="editingPerms.has(c.name)"
                  @change="togglePerm(c.name)"
                />
                <span class="perms__cap-name">{{ c.name }}</span>
                <span class="perms__cap-desc">{{ c.description }}</span>
              </label>
            </div>
          </div>
          <div v-else class="perms__cap-summary">
            <span v-for="p in g.permissions.slice(0, 8)" :key="p" class="perms__chip-cap">{{ p }}</span>
            <span v-if="g.permissions.length > 8" class="perms__chip-cap perms__chip-cap--more">
              +{{ g.permissions.length - 8 }} more
            </span>
            <span v-if="g.permissions.length === 0" class="perms__chip-cap perms__chip-cap--empty">no permissions</span>
          </div>
        </li>
      </ul>
    </section>

    <!-- User assignment -->
    <section v-if="sub === 'users'" class="perms__section">
      <p class="perms__hint">
        Pick a user to see which groups they belong to and what
        capabilities those groups give them. Users not in any group
        have no access — assign at least one.
      </p>
      <ul class="perms__user-list">
        <li
          v-for="u in users"
          :key="u.id"
          class="perms__user-row"
          :class="{ 'perms__user-row--on': editingUserId === u.id }"
          @click="startEditingUser(u)"
        >
          <span class="perms__user-email">{{ u.email }}</span>
          <span class="perms__chip">{{ u.role }}</span>
        </li>
      </ul>

      <div v-if="editingUserId != null" class="perms__user-edit">
        <h4>Groups for {{ users.find((x) => x.id === editingUserId)?.email }}</h4>
        <div class="perms__user-groups">
          <label v-for="g in groups" :key="g.id" class="perms__user-group">
            <input
              type="checkbox"
              :checked="userGroups.includes(g.id)"
              @change="toggleUserGroup(g.id)"
            />
            <span>{{ g.name }}</span>
            <small>{{ g.description }}</small>
          </label>
        </div>
        <div class="perms__user-effective">
          <h5>Resolved capabilities ({{ userEffective.length }})</h5>
          <div>
            <span v-for="p in userEffective" :key="p" class="perms__chip-cap">{{ p }}</span>
            <span v-if="userEffective.length === 0" class="perms__chip-cap perms__chip-cap--empty">
              No capabilities — user has no effective access.
            </span>
          </div>
        </div>
        <div class="perms__user-actions">
          <button class="btn btn-primary btn-sm" @click="saveUserGroups">Save groups</button>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.perms { display: grid; gap: 12px; }
.perms__error {
  background: rgba(224, 122, 95, 0.08);
  border: 1px solid rgba(224, 122, 95, 0.3);
  color: var(--error);
  padding: 8px 12px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  margin: 0;
}
.perms__toast {
  margin: 0;
  padding: 6px 12px;
  background: rgba(127, 176, 105, 0.12);
  color: var(--success);
  border-radius: var(--radius-sm);
  font-size: 12px;
}
.perms__hint { margin: 0; font-size: 12px; color: var(--fg-muted); line-height: 1.5; }
.perms__subtabs {
  display: flex; gap: 4px;
  border-bottom: 1px solid var(--border); margin-bottom: 4px;
}
.perms__sub {
  padding: 6px 12px;
  background: transparent; border: none; cursor: pointer;
  border-bottom: 2px solid transparent;
  color: var(--fg-muted); font-size: 12px;
}
.perms__sub--on { color: var(--fg); border-bottom-color: var(--accent); }

.perms__section { display: grid; gap: 12px; }

.perms__newg {
  display: grid;
  grid-template-columns: 1fr 1.5fr auto;
  gap: 8px;
  align-items: center;
  padding: 10px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
}
.perms__newg input {
  font-size: 13px;
  padding: 6px 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
}

.perms__groups { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.perms__group {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
}
.perms__group-head { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.perms__group-name {
  display: flex; align-items: center; gap: 8px;
  font-family: var(--font-serif); font-weight: 500; font-size: 14px;
  color: var(--fg);
}
.perms__group-desc { margin: 4px 0 0; font-size: 12px; color: var(--fg-subtle); }
.perms__group-actions { display: flex; gap: 6px; }
.perms__chip {
  font-size: 10px; font-weight: 600; text-transform: uppercase;
  letter-spacing: 0.05em; padding: 1px 7px; border-radius: 999px;
  background: var(--bg-elev); color: var(--fg-subtle);
  border: 1px solid var(--border);
}

.perms__cap-summary {
  display: flex; flex-wrap: wrap; gap: 4px;
  margin-top: 8px;
}
.perms__chip-cap {
  font-family: var(--font-mono);
  font-size: 10.5px;
  background: var(--accent-subtle); color: var(--accent);
  padding: 2px 6px; border-radius: 3px;
}
.perms__chip-cap--more { background: var(--bg-elev); color: var(--fg-subtle); }
.perms__chip-cap--empty { background: rgba(220, 80, 80, 0.08); color: var(--error); }

.perms__caps { display: grid; gap: 12px; margin-top: 12px; }
.perms__cat h5 {
  margin: 0 0 6px;
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--fg-subtle); font-weight: 600;
}
.perms__cap {
  display: grid;
  grid-template-columns: 18px 180px 1fr;
  gap: 8px;
  align-items: center;
  padding: 3px 4px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}
.perms__cap:hover { background: var(--bg-hover); }
.perms__cap-name { font-family: var(--font-mono); color: var(--fg); }
.perms__cap-desc { color: var(--fg-muted); font-size: 11.5px; }

.perms__user-list {
  list-style: none; margin: 0; padding: 0;
  display: grid; gap: 2px;
  max-height: 240px; overflow-y: auto;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
}
.perms__user-row {
  display: flex; justify-content: space-between; align-items: center;
  padding: 8px 12px; cursor: pointer;
  font-size: 13px;
}
.perms__user-row:hover { background: var(--bg-hover); }
.perms__user-row--on { background: var(--accent-subtle); }
.perms__user-email { color: var(--fg); }

.perms__user-edit {
  background: var(--bg);
  border: 1px solid var(--accent-border);
  border-radius: var(--radius-sm);
  padding: 14px;
  display: grid; gap: 12px;
}
.perms__user-edit h4 {
  margin: 0; font-family: var(--font-serif); font-weight: 500; font-size: 14px;
}
.perms__user-groups { display: grid; gap: 6px; }
.perms__user-group {
  display: grid;
  grid-template-columns: 18px 160px 1fr;
  gap: 8px; align-items: center;
  font-size: 13px; cursor: pointer;
  padding: 4px;
  border-radius: 4px;
}
.perms__user-group:hover { background: var(--bg-hover); }
.perms__user-group small { color: var(--fg-subtle); font-size: 11px; }
.perms__user-effective h5 {
  margin: 0 0 6px;
  font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em;
  color: var(--fg-subtle); font-weight: 600;
}
.perms__user-effective > div {
  display: flex; flex-wrap: wrap; gap: 4px;
}
.perms__user-actions { display: flex; justify-content: flex-end; }
</style>
