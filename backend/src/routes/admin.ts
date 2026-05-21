import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { createUser, findUserByEmail, updatePassword } from "../services/auth.js";
import {
  createApiKey,
  deleteProvider,
  getEmailDomainAllowlist,
  listAllApiKeys,
  listProviders,
  maskConfigForDisplay,
  revokeApiKey,
  setEmailDomainAllowlist,
  upsertProvider,
  type ProviderKind,
} from "../services/authProviders.js";
import {
  deleteServer,
  listServers,
  refreshServer,
  serverForDisplay,
  upsertServer,
} from "../services/mcpClient.js";
import {
  CAPABILITIES,
  createGroup,
  deleteGroup,
  getUserGroupIds,
  getUserPermissions,
  listGroupsWithPermissions,
  setUserGroups,
  updateGroupPermissions,
} from "../services/permissions.js";
import {
  getRunRetention,
  getSchedulerStatus,
  setSchedulerConcurrency,
} from "../services/pipelines.js";
import { pythonEngine } from "../services/pythonEngine.js";
import {
  KNOWN_MODELS,
  getAnthropicApiKey,
  getAnthropicModel,
  isPublicRegistrationEnabled,
  maskApiKey,
  setPublicRegistrationEnabled,
  setSetting,
} from "../services/settings.js";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireAdmin);

interface PackageRow {
  id: number;
  package_name: string;
  import_name: string | null;
  version_spec: string | null;
  installed_version: string | null;
  status: string;
  error_message: string | null;
  is_default: number;
  is_enabled: number;
  created_at: number;
  updated_at: number;
}

interface UserRow {
  id: number;
  email: string;
  role: string;
  created_at: number;
}

function rowToPackage(row: PackageRow) {
  return {
    id: row.id,
    package_name: row.package_name,
    import_name: row.import_name,
    version_spec: row.version_spec,
    installed_version: row.installed_version,
    status: row.status,
    error_message: row.error_message,
    is_default: !!row.is_default,
    is_enabled: !!row.is_enabled,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

adminRouter.get("/packages", (_req, res) => {
  const rows = db
    .prepare("SELECT * FROM allowed_packages ORDER BY is_default DESC, package_name ASC")
    .all() as PackageRow[];
  res.json(rows.map(rowToPackage));
});

adminRouter.post("/packages", async (req, res) => {
  const parsed = z
    .object({
      package_name: z.string().min(1),
      import_name: z.string().optional(),
      version_spec: z.string().optional(),
      auto_install: z.boolean().default(true),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const info = db
    .prepare(
      "INSERT INTO allowed_packages (package_name, import_name, version_spec, status, is_enabled) VALUES (?, ?, ?, 'pending', 1)",
    )
    .run(
      parsed.data.package_name,
      parsed.data.import_name ?? parsed.data.package_name,
      parsed.data.version_spec ?? null,
    );
  const id = Number(info.lastInsertRowid);
  if (parsed.data.auto_install) {
    await installPackageById(id);
  }
  const row = db
    .prepare("SELECT * FROM allowed_packages WHERE id = ?")
    .get(id) as PackageRow;
  res.json(rowToPackage(row));
});

adminRouter.put("/packages/:id", (req, res) => {
  const parsed = z
    .object({ is_enabled: z.boolean().optional() })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.is_enabled !== undefined) {
    db.prepare(
      "UPDATE allowed_packages SET is_enabled = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
    ).run(parsed.data.is_enabled ? 1 : 0, req.params.id);
  }
  res.json({ ok: true });
});

adminRouter.post("/packages/:id/install", async (req, res) => {
  const result = await installPackageById(Number(req.params.id));
  res.json(result);
});

adminRouter.post("/packages/:id/uninstall", async (req, res) => {
  const row = db
    .prepare("SELECT * FROM allowed_packages WHERE id = ?")
    .get(req.params.id) as PackageRow | undefined;
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (row.is_default) {
    res.status(400).json({ error: "cannot uninstall default package" });
    return;
  }
  try {
    const r = await pythonEngine.uninstallPackage(row.package_name);
    db.prepare(
      "UPDATE allowed_packages SET status = ?, installed_version = NULL, error_message = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
    ).run(r.success ? "pending" : "failed", r.error ?? null, row.id);
    res.json(r);
  } catch (err) {
    res.status(502).json({ error: (err as Error).message });
  }
});

adminRouter.delete("/packages/:id", (req, res) => {
  const row = db
    .prepare("SELECT is_default FROM allowed_packages WHERE id = ?")
    .get(req.params.id) as { is_default: number } | undefined;
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  if (row.is_default) {
    res.status(400).json({ error: "cannot delete default package" });
    return;
  }
  db.prepare("DELETE FROM allowed_packages WHERE id = ?").run(req.params.id);
  res.json({ ok: true });
});

async function installPackageById(
  id: number,
): Promise<{ success: boolean; version?: string; error?: string }> {
  const row = db
    .prepare("SELECT * FROM allowed_packages WHERE id = ?")
    .get(id) as PackageRow | undefined;
  if (!row) return { success: false, error: "not found" };
  db.prepare(
    "UPDATE allowed_packages SET status = 'installing', error_message = NULL, updated_at = strftime('%s', 'now') WHERE id = ?",
  ).run(id);
  try {
    const r = await pythonEngine.installPackage(
      row.package_name,
      row.version_spec ?? undefined,
    );
    db.prepare(
      "UPDATE allowed_packages SET status = ?, installed_version = ?, error_message = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
    ).run(
      r.success ? "installed" : "failed",
      r.version ?? null,
      r.error ?? null,
      id,
    );
    return r;
  } catch (err) {
    const msg = (err as Error).message;
    db.prepare(
      "UPDATE allowed_packages SET status = 'failed', error_message = ?, updated_at = strftime('%s', 'now') WHERE id = ?",
    ).run(msg, id);
    return { success: false, error: msg };
  }
}

adminRouter.get("/users", (_req, res) => {
  const rows = db
    .prepare("SELECT id, email, role, created_at FROM users ORDER BY id ASC")
    .all() as UserRow[];
  res.json(rows);
});

function settingsPayload() {
  const key = getAnthropicApiKey();
  return {
    anthropic_api_key_masked: maskApiKey(key),
    anthropic_api_key_set: !!key,
    anthropic_model: getAnthropicModel(),
    known_models: KNOWN_MODELS,
    public_registration_enabled: isPublicRegistrationEnabled(),
  };
}

adminRouter.get("/settings", (_req, res) => {
  res.json(settingsPayload());
});

adminRouter.put("/settings", (req, res) => {
  const parsed = z
    .object({
      anthropic_api_key: z.string().optional(),
      anthropic_model: z.string().optional(),
      public_registration_enabled: z.boolean().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  // Empty string means "clear"; undefined means "leave alone".
  if (parsed.data.anthropic_api_key !== undefined) {
    setSetting("anthropic_api_key", parsed.data.anthropic_api_key.trim());
  }
  if (parsed.data.anthropic_model !== undefined) {
    const allowed = KNOWN_MODELS.some((m) => m.id === parsed.data.anthropic_model);
    if (!allowed) {
      res.status(400).json({ error: `unknown model: ${parsed.data.anthropic_model}` });
      return;
    }
    setSetting("anthropic_model", parsed.data.anthropic_model);
  }
  if (parsed.data.public_registration_enabled !== undefined) {
    setPublicRegistrationEnabled(parsed.data.public_registration_enabled);
  }
  res.json(settingsPayload());
});

adminRouter.post("/users", (req, res) => {
  const parsed = z
    .object({
      email: z.string().email(),
      password: z.string().min(6),
      role: z.enum(["admin", "editor", "viewer"]).default("viewer"),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (findUserByEmail(parsed.data.email)) {
    res.status(409).json({ error: "email already registered" });
    return;
  }
  const user = createUser(parsed.data.email, parsed.data.password);
  if (parsed.data.role !== user.role) {
    db.prepare("UPDATE users SET role = ? WHERE id = ?").run(parsed.data.role, user.id);
  }
  res.json({ id: user.id, email: user.email, role: parsed.data.role });
});

adminRouter.post("/users/:id/reset-password", (req, res) => {
  const parsed = z
    .object({ new_password: z.string().min(6) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const id = Number(req.params.id);
  const exists = db.prepare("SELECT id FROM users WHERE id = ?").get(id);
  if (!exists) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  updatePassword(id, parsed.data.new_password);
  res.json({ ok: true });
});

adminRouter.delete("/users/:id", (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user!.sub) {
    res.status(400).json({ error: "cannot delete yourself" });
    return;
  }
  const result = db.prepare("DELETE FROM users WHERE id = ?").run(id);
  if (result.changes === 0) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  res.json({ ok: true });
});

adminRouter.put("/users/:id/role", (req, res) => {
  const parsed = z
    .object({ role: z.enum(["admin", "editor", "viewer"]) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (Number(req.params.id) === req.user!.sub && parsed.data.role !== "admin") {
    res.status(400).json({ error: "cannot demote yourself" });
    return;
  }
  db.prepare("UPDATE users SET role = ? WHERE id = ?").run(parsed.data.role, req.params.id);
  res.json({ ok: true });
});

// ---------- Auth providers (OIDC / SAML / LDAP) ----------------------

function providerForDisplay(row: ReturnType<typeof listProviders>[number]) {
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    is_enabled: !!row.is_enabled,
    default_role: row.default_role,
    config: maskConfigForDisplay(row),
    updated_at: row.updated_at,
  };
}

adminRouter.get("/auth/providers", (_req, res) => {
  res.json({ providers: listProviders().map(providerForDisplay) });
});

const providerUpsertSchema = z.object({
  kind: z.enum(["oidc", "saml", "ldap"]),
  name: z.string().min(1).max(80),
  is_enabled: z.boolean().optional(),
  default_role: z.enum(["admin", "editor", "viewer"]).default("viewer"),
  config: z.record(z.unknown()),
});

adminRouter.post("/auth/providers", (req, res) => {
  const parsed = providerUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const row = upsertProvider({
      kind: parsed.data.kind as ProviderKind,
      name: parsed.data.name,
      is_enabled: parsed.data.is_enabled,
      default_role: parsed.data.default_role,
      config: parsed.data.config,
    });
    res.json(providerForDisplay(row));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

adminRouter.put("/auth/providers/:id", (req, res) => {
  const parsed = providerUpsertSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const row = upsertProvider({
      id: Number(req.params.id),
      kind: parsed.data.kind as ProviderKind,
      name: parsed.data.name,
      is_enabled: parsed.data.is_enabled,
      default_role: parsed.data.default_role,
      config: parsed.data.config,
    });
    res.json(providerForDisplay(row));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

adminRouter.delete("/auth/providers/:id", (req, res) => {
  const ok = deleteProvider(Number(req.params.id));
  if (!ok) {
    res.status(404).json({ error: "provider not found" });
    return;
  }
  res.json({ ok: true });
});

// ---------- Email domain allowlist ----------------------------------

adminRouter.get("/auth/allowlist", (_req, res) => {
  res.json({ domains: getEmailDomainAllowlist() });
});

adminRouter.put("/auth/allowlist", (req, res) => {
  const parsed = z
    .object({ domains: z.array(z.string()) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  setEmailDomainAllowlist(parsed.data.domains);
  res.json({ domains: getEmailDomainAllowlist() });
});

// ---------- API keys -------------------------------------------------
// Admin sees every user's keys; the plaintext is *only* returned once
// at creation time. Storing a hash means a DB leak can't be replayed.

adminRouter.get("/api-keys", (_req, res) => {
  const rows = listAllApiKeys().map((r) => ({
    id: r.id,
    user_id: r.user_id,
    user_email: r.email,
    name: r.name,
    prefix: r.prefix,
    last_used_at: r.last_used_at,
    expires_at: r.expires_at,
    revoked_at: r.revoked_at,
    created_at: r.created_at,
  }));
  res.json({ api_keys: rows });
});

adminRouter.post("/api-keys", (req, res) => {
  const parsed = z
    .object({
      name: z.string().min(1).max(80),
      user_id: z.number().int().optional(), // defaults to caller
      expires_in_days: z.number().int().positive().max(3650).optional(),
      // Optional scope narrowing — empty array (default) inherits
      // the full set of the owner's permissions. Non-empty restricts
      // the key to a subset; the bearer middleware enforces it.
      scopes: z.array(z.string()).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const userId = parsed.data.user_id ?? req.user!.sub;
  const exists = db
    .prepare("SELECT id FROM users WHERE id = ?")
    .get(userId);
  if (!exists) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  const expiresAt = parsed.data.expires_in_days
    ? Math.floor(Date.now() / 1000) + parsed.data.expires_in_days * 86400
    : null;
  const { row, plaintext } = createApiKey({
    user_id: userId,
    name: parsed.data.name,
    expires_at: expiresAt,
    scopes: parsed.data.scopes,
  });
  res.json({
    id: row.id,
    user_id: row.user_id,
    name: row.name,
    prefix: row.prefix,
    expires_at: row.expires_at,
    created_at: row.created_at,
    // The plaintext is shown to the user once — they must store it
    // immediately. The DB only keeps the hash.
    plaintext,
  });
});

adminRouter.delete("/api-keys/:id", (req, res) => {
  const ok = revokeApiKey(Number(req.params.id));
  if (!ok) {
    res.status(404).json({ error: "key not found or already revoked" });
    return;
  }
  res.json({ ok: true });
});

// ---------- Pipeline scheduler --------------------------------------
// The scheduler is process-local: one Express instance, one ticker.
// The admin gets visibility into what's running, plus a knob for max
// concurrent runs (e.g. throttle on a small box).

adminRouter.get("/pipelines/scheduler", (_req, res) => {
  const status = getSchedulerStatus();
  // Pair with quick aggregate counts so the admin sees the load
  // picture at a glance.
  const counts = db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM pipelines) AS total,
         (SELECT COUNT(*) FROM pipelines WHERE schedule_enabled = 1 AND schedule IS NOT NULL AND schedule != '') AS scheduled,
         (SELECT COUNT(*) FROM pipeline_runs WHERE status = 'success' AND started_at >= strftime('%s','now') - 86400) AS success_24h,
         (SELECT COUNT(*) FROM pipeline_runs WHERE status = 'failed' AND started_at >= strftime('%s','now') - 86400) AS failed_24h`,
    )
    .get() as {
      total: number; scheduled: number;
      success_24h: number; failed_24h: number;
    };
  res.json({ ...status, ...counts, run_retention: getRunRetention() });
});

adminRouter.put("/pipelines/scheduler", (req, res) => {
  const parsed = z
    .object({
      max_concurrent: z.number().int().min(1).max(16).optional(),
      run_retention: z.number().int().min(1).max(10_000).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (parsed.data.max_concurrent !== undefined) {
    setSchedulerConcurrency(parsed.data.max_concurrent);
  }
  if (parsed.data.run_retention !== undefined) {
    setSetting("pipeline_run_retention", String(parsed.data.run_retention));
  }
  res.json({
    ...getSchedulerStatus(),
    run_retention: getRunRetention(),
  });
});

// ---------- MCP server (inbound): which tools to expose -------------
// The MCP route reads ``mcp_exposed_tools`` from settings and only
// lets clients call tools in that list. Admin curates the list here.

adminRouter.get("/mcp/exposed-tools", async (_req, res) => {
  // Import lazily to avoid a circular dep between admin.ts <-> chatTools
  // <-> mcp.ts at module load.
  const { listAllowedToolNames } = await import("../routes/mcp.js");
  const { chatTools } = await import("../services/chatTools.js");
  res.json({
    exposed: listAllowedToolNames(),
    available: chatTools.map((t) => ({
      name: t.name,
      description: t.description,
    })),
  });
});

adminRouter.put("/mcp/exposed-tools", async (req, res) => {
  const parsed = z
    .object({ exposed: z.array(z.string()) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { setAllowedToolNames, listAllowedToolNames } = await import(
    "../routes/mcp.js"
  );
  setAllowedToolNames(parsed.data.exposed);
  res.json({ exposed: listAllowedToolNames() });
});

// ---------- MCP client (outbound): external servers -----------------
// Crunch can connect to other MCP servers and surface their tools to
// the chat agent. Admin manages the connection list here.

adminRouter.get("/mcp/servers", (_req, res) => {
  res.json({ servers: listServers().map(serverForDisplay) });
});

const mcpServerSchema = z.object({
  name: z.string().min(1).max(80).regex(/^[a-zA-Z0-9_-]+$/),
  url: z.string().url(),
  transport: z.string().optional(),
  auth_header_name: z.string().nullable().optional(),
  auth_header_value: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  allowed_tools: z.array(z.string()).optional(),
});

adminRouter.post("/mcp/servers", (req, res) => {
  const parsed = mcpServerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const row = upsertServer(parsed.data);
    res.json(serverForDisplay(row));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

adminRouter.put("/mcp/servers/:id", (req, res) => {
  const parsed = mcpServerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const row = upsertServer({ ...parsed.data, id: Number(req.params.id) });
    res.json(serverForDisplay(row));
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

adminRouter.delete("/mcp/servers/:id", (req, res) => {
  const ok = deleteServer(Number(req.params.id));
  if (!ok) {
    res.status(404).json({ error: "server not found" });
    return;
  }
  res.json({ ok: true });
});

/** Force a handshake + tools/list against an external server. The
 *  chat agent uses the cached result, so this is the admin's "make
 *  the new server's tools show up now" button. */
adminRouter.post("/mcp/servers/:id/refresh", async (req, res) => {
  const r = await refreshServer(Number(req.params.id));
  res.json(r);
});

// ---------- Permissions: capabilities + groups ----------------------
// Capabilities are the static registry — name + description + category.
// Groups bundle capabilities; users belong to groups. The UI surfaces
// the registry so the admin can pick which capabilities each group
// carries.

adminRouter.get("/permissions/capabilities", (_req, res) => {
  res.json({ capabilities: CAPABILITIES });
});

adminRouter.get("/permissions/groups", (_req, res) => {
  res.json({ groups: listGroupsWithPermissions() });
});

adminRouter.post("/permissions/groups", (req, res) => {
  const parsed = z
    .object({
      name: z.string().min(1).max(80),
      description: z.string().nullable().optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  try {
    const g = createGroup(parsed.data.name, parsed.data.description ?? null);
    res.json(g);
  } catch (e) {
    res.status(400).json({ error: (e as Error).message });
  }
});

adminRouter.put("/permissions/groups/:id", (req, res) => {
  const parsed = z
    .object({ permissions: z.array(z.string()) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  updateGroupPermissions(Number(req.params.id), parsed.data.permissions);
  res.json({ ok: true });
});

adminRouter.delete("/permissions/groups/:id", (req, res) => {
  const r = deleteGroup(Number(req.params.id));
  if (!r.ok) {
    res.status(400).json({ error: r.reason ?? "delete failed" });
    return;
  }
  res.json({ ok: true });
});

// Per-user view: which groups they're in + the resolved permission
// set. The UI uses this for the user editor.
adminRouter.get("/users/:id/groups", (req, res) => {
  const uid = Number(req.params.id);
  const exists = db.prepare("SELECT id FROM users WHERE id = ?").get(uid);
  if (!exists) {
    res.status(404).json({ error: "user not found" });
    return;
  }
  res.json({
    group_ids: getUserGroupIds(uid),
    effective_permissions: [...getUserPermissions(uid)],
  });
});

adminRouter.put("/users/:id/groups", (req, res) => {
  const parsed = z
    .object({ group_ids: z.array(z.number().int()) })
    .safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const uid = Number(req.params.id);
  // Don't let an admin demote themselves out of every admin-capable
  // group — same shape as the existing "can't demote yourself" guard.
  if (uid === req.user!.sub) {
    const wouldHave = new Set<string>();
    const sample = db
      .prepare(
        `SELECT permission FROM group_permissions
         WHERE group_id IN (${parsed.data.group_ids.map(() => "?").join(",") || "NULL"})`,
      )
      .all(...parsed.data.group_ids) as Array<{ permission: string }>;
    for (const s of sample) wouldHave.add(s.permission);
    if (!wouldHave.has("admin.users")) {
      res
        .status(400)
        .json({ error: "cannot remove your own admin.users capability" });
      return;
    }
  }
  setUserGroups(uid, parsed.data.group_ids);
  res.json({ ok: true });
});
