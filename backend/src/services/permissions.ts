/**
 * User permissions.
 *
 * Capability flags + groups, inspired by Metabase but flatter. Each
 * capability is a string like ``query.write`` that gates an action;
 * groups bundle capabilities; users belong to groups; the union of
 * their groups' capabilities is what they can do.
 *
 * Capability checking flows through one function — :func:`hasPermission`.
 * Routes call it via :func:`requirePermission` middleware.
 *
 * API keys add a second axis: each key carries a scope list that
 * narrows the owner's permissions. The bearer middleware applies
 * both gates: ``user has cap`` AND ``key includes cap``.
 */

import { db } from "../db/index.js";

/**
 * Canonical capability registry. Codifies *what* the app gates, in
 * one place. Anything not listed here is uncheckable, which keeps
 * us from accidentally relying on undeclared flags.
 */
export const CAPABILITIES = [
  // --- Data: queries + visualisations -------------------------------
  { name: "query.read",        category: "data",   description: "View saved queries and run them." },
  { name: "query.write",       category: "data",   description: "Create, edit, and delete saved queries." },
  { name: "viz.write",         category: "data",   description: "Edit chart settings on a saved query." },

  // --- Dashboards ---------------------------------------------------
  { name: "dashboard.read",    category: "data",   description: "View dashboards." },
  { name: "dashboard.write",   category: "data",   description: "Create, edit, and delete dashboards." },

  // --- Pipelines ----------------------------------------------------
  { name: "pipeline.read",     category: "data",   description: "View pipelines and run history." },
  { name: "pipeline.write",    category: "data",   description: "Create, edit, and delete pipelines." },
  { name: "pipeline.run",      category: "data",   description: "Manually trigger a pipeline run." },
  { name: "pipeline.schedule", category: "data",   description: "Enable / disable a pipeline's schedule." },

  // --- Connections --------------------------------------------------
  { name: "connection.read",   category: "data",   description: "List the user's data connections." },
  { name: "connection.write",  category: "data",   description: "Add, edit, and remove data connections." },

  // --- Chat / agent -------------------------------------------------
  { name: "chat.use",          category: "agent",  description: "Talk to the AI agent (queries, charts, pipelines)." },

  // --- API keys -----------------------------------------------------
  { name: "apikey.create",     category: "api",    description: "Issue API keys for programmatic / MCP access." },

  // --- MCP ----------------------------------------------------------
  { name: "mcp.use",           category: "mcp",    description: "Access Crunch's exposed MCP server (server-side gate)." },

  // --- Admin --------------------------------------------------------
  { name: "admin.users",       category: "admin",  description: "Create users, reset passwords, edit roles." },
  { name: "admin.groups",      category: "admin",  description: "Create / edit / delete permission groups." },
  { name: "admin.auth",        category: "admin",  description: "Configure SSO providers, LDAP, email allowlist." },
  { name: "admin.settings",    category: "admin",  description: "Edit application settings (API keys, model, etc.)." },
  { name: "admin.packages",    category: "admin",  description: "Manage the python sandbox's allowed packages." },
  { name: "admin.git",         category: "admin",  description: "Configure the workspace git mirror." },
  { name: "admin.pipelines",   category: "admin",  description: "Manage the scheduler + run retention." },
  { name: "admin.mcp",         category: "admin",  description: "Configure MCP servers (outbound) + exposed tools (inbound)." },
] as const;

export type CapabilityName = (typeof CAPABILITIES)[number]["name"];

const ALL_CAPS = new Set(CAPABILITIES.map((c) => c.name));

/** Default group bundles. Seeded on first boot; admin can edit but
 *  ``is_system`` rows are protected from deletion so the app never
 *  lands in a zero-groups state. */
const DEFAULT_GROUPS: Array<{ name: string; description: string; perms: CapabilityName[] }> = [
  {
    name: "Administrators",
    description: "Full access to every surface in Crunch.",
    perms: [...ALL_CAPS] as CapabilityName[],
  },
  {
    name: "Editors",
    description: "Build queries, dashboards, and pipelines. Can talk to the agent.",
    perms: [
      "query.read", "query.write", "viz.write",
      "dashboard.read", "dashboard.write",
      "pipeline.read", "pipeline.write", "pipeline.run", "pipeline.schedule",
      "connection.read",
      "chat.use",
      "apikey.create",
    ],
  },
  {
    name: "Viewers",
    description: "Read-only access. Can run existing queries and view dashboards.",
    perms: [
      "query.read",
      "dashboard.read",
      "pipeline.read",
      "connection.read",
    ],
  },
  {
    name: "API consumers",
    description: "Headless / MCP consumers. No UI editing, can read + run.",
    perms: [
      "query.read",
      "dashboard.read",
      "pipeline.read",
      "connection.read",
      "mcp.use",
    ],
  },
];

/** Idempotent boot seeding — registers capability rows and the
 *  default groups, and migrates any legacy ``users.role`` value into
 *  group membership. Safe to call on every startup. */
export function seedPermissions(): void {
  const insertCap = db.prepare(
    "INSERT OR REPLACE INTO permissions (name, description, category) VALUES (?, ?, ?)",
  );
  for (const c of CAPABILITIES) insertCap.run(c.name, c.description, c.category);

  const insertGroup = db.prepare(
    "INSERT OR IGNORE INTO user_groups_def (name, description, is_system) VALUES (?, ?, 1)",
  );
  const getGroupId = db.prepare("SELECT id FROM user_groups_def WHERE name = ?");
  const insertGroupPerm = db.prepare(
    "INSERT OR IGNORE INTO group_permissions (group_id, permission) VALUES (?, ?)",
  );

  for (const g of DEFAULT_GROUPS) {
    insertGroup.run(g.name, g.description);
    const row = getGroupId.get(g.name) as { id: number } | undefined;
    if (!row) continue;
    for (const p of g.perms) insertGroupPerm.run(row.id, p);
  }

  // One-time migration: turn each user's legacy ``role`` into
  // membership in the matching default group. Only runs for users
  // that aren't in any group yet, so it doesn't fight admin edits.
  const unbound = db
    .prepare(
      `SELECT u.id, u.role FROM users u
       WHERE NOT EXISTS (SELECT 1 FROM user_group_membership m WHERE m.user_id = u.id)`,
    )
    .all() as Array<{ id: number; role: string }>;
  const grant = db.prepare(
    `INSERT OR IGNORE INTO user_group_membership (user_id, group_id)
     SELECT ?, id FROM user_groups_def WHERE name = ?`,
  );
  for (const u of unbound) {
    const target =
      u.role === "admin" ? "Administrators"
      : u.role === "editor" ? "Editors"
      : "Viewers";
    grant.run(u.id, target);
  }
}

// ---------- Resolution ----------------------------------------------

/** Permissions a user is granted via their group memberships. */
export function getUserPermissions(userId: number): Set<CapabilityName> {
  const rows = db
    .prepare(
      `SELECT DISTINCT gp.permission
       FROM user_group_membership m
       JOIN group_permissions gp ON gp.group_id = m.group_id
       WHERE m.user_id = ?`,
    )
    .all(userId) as Array<{ permission: string }>;
  return new Set(rows.map((r) => r.permission as CapabilityName));
}

/** True when the user has the capability via any of their groups. */
export function hasPermission(userId: number, cap: CapabilityName): boolean {
  // Admins via legacy role keep working without re-running migrations
  // — `seedPermissions` puts them in Administrators on boot, and that
  // group carries every capability.
  const row = db
    .prepare(
      `SELECT 1 FROM user_group_membership m
       JOIN group_permissions gp ON gp.group_id = m.group_id
       WHERE m.user_id = ? AND gp.permission = ?
       LIMIT 1`,
    )
    .get(userId, cap);
  return !!row;
}

/** Effective permissions for an API-key-authenticated request.
 *  ``scopes`` is the key's stored scope list (empty/null = inherit
 *  all of the owner's permissions). The result is the *intersection*
 *  — keys never grant more than the owner has. */
export function effectivePermissions(
  userId: number,
  scopes: string[] | null,
): Set<CapabilityName> {
  const owner = getUserPermissions(userId);
  if (!scopes || scopes.length === 0) return owner;
  const out = new Set<CapabilityName>();
  for (const s of scopes) {
    if (owner.has(s as CapabilityName)) out.add(s as CapabilityName);
  }
  return out;
}

// ---------- Group CRUD ----------------------------------------------

export interface GroupRow {
  id: number;
  name: string;
  description: string | null;
  is_system: number;
  created_at: number;
}

export function listGroupsWithPermissions(): Array<
  GroupRow & { permissions: string[]; member_count: number }
> {
  const groups = db
    .prepare("SELECT * FROM user_groups_def ORDER BY is_system DESC, name ASC")
    .all() as GroupRow[];
  const perms = db
    .prepare("SELECT group_id, permission FROM group_permissions")
    .all() as Array<{ group_id: number; permission: string }>;
  const counts = db
    .prepare(
      "SELECT group_id, COUNT(*) AS n FROM user_group_membership GROUP BY group_id",
    )
    .all() as Array<{ group_id: number; n: number }>;
  const byGroup = new Map<number, string[]>();
  for (const p of perms) {
    if (!byGroup.has(p.group_id)) byGroup.set(p.group_id, []);
    byGroup.get(p.group_id)!.push(p.permission);
  }
  const countBy = new Map(counts.map((r) => [r.group_id, r.n]));
  return groups.map((g) => ({
    ...g,
    permissions: byGroup.get(g.id) ?? [],
    member_count: countBy.get(g.id) ?? 0,
  }));
}

export function createGroup(name: string, description: string | null): GroupRow {
  const info = db
    .prepare(
      "INSERT INTO user_groups_def (name, description, is_system) VALUES (?, ?, 0)",
    )
    .run(name.trim(), description ?? null);
  return db
    .prepare("SELECT * FROM user_groups_def WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as GroupRow;
}

export function updateGroupPermissions(groupId: number, perms: string[]): void {
  const valid = perms.filter((p) => ALL_CAPS.has(p as CapabilityName));
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM group_permissions WHERE group_id = ?").run(groupId);
    const ins = db.prepare(
      "INSERT INTO group_permissions (group_id, permission) VALUES (?, ?)",
    );
    for (const p of valid) ins.run(groupId, p);
  });
  tx();
}

export function deleteGroup(groupId: number): { ok: boolean; reason?: string } {
  const row = db
    .prepare("SELECT is_system FROM user_groups_def WHERE id = ?")
    .get(groupId) as { is_system: number } | undefined;
  if (!row) return { ok: false, reason: "not found" };
  if (row.is_system) return { ok: false, reason: "system group cannot be deleted" };
  db.prepare("DELETE FROM user_groups_def WHERE id = ?").run(groupId);
  return { ok: true };
}

export function getUserGroupIds(userId: number): number[] {
  const rows = db
    .prepare("SELECT group_id FROM user_group_membership WHERE user_id = ?")
    .all(userId) as Array<{ group_id: number }>;
  return rows.map((r) => r.group_id);
}

export function setUserGroups(userId: number, groupIds: number[]): void {
  const tx = db.transaction(() => {
    db.prepare("DELETE FROM user_group_membership WHERE user_id = ?").run(userId);
    const ins = db.prepare(
      "INSERT INTO user_group_membership (user_id, group_id) VALUES (?, ?)",
    );
    for (const gid of groupIds) ins.run(userId, gid);
  });
  tx();
}
