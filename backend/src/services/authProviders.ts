/**
 * Storage + helpers for the configurable auth backends (OIDC, SAML,
 * LDAP, API keys, email domain allowlist).
 *
 * Provider rows live in the ``auth_providers`` table; each row has a
 * ``kind`` and a free-form JSON config so we don't migrate the schema
 * every time an IdP needs a new knob. The narrow zod schemas in this
 * file enforce per-kind config shape, and `getDecryptedConfig` peels
 * back the secrets (client secrets, bind passwords) only on read.
 */

import crypto from "node:crypto";
import { z } from "zod";
import { db } from "../db/index.js";
import { decryptString, encryptString, isEncrypted } from "./crypto.js";
import { getSetting, setSetting } from "./settings.js";

export type ProviderKind = "oidc" | "saml" | "ldap";

export interface ProviderRow {
  id: number;
  kind: ProviderKind;
  name: string;
  is_enabled: number;
  default_role: string;
  config_json: string;
  created_at: number;
  updated_at: number;
}

// ---------- Per-kind config schemas --------------------------------

/** OIDC / OAuth2 — works for Google, Microsoft, Okta, Auth0, Authentik, GitHub.
 *  ``discovery_url`` is the IdP's /.well-known/openid-configuration so
 *  endpoints/keys come for free; clients without discovery can fill the
 *  individual URLs instead. */
export const oidcConfigSchema = z.object({
  issuer: z.string().url().optional(),
  discovery_url: z.string().url().optional(),
  authorization_endpoint: z.string().url().optional(),
  token_endpoint: z.string().url().optional(),
  userinfo_endpoint: z.string().url().optional(),
  jwks_uri: z.string().url().optional(),
  client_id: z.string().min(1),
  client_secret: z.string().optional(),       // empty for public/PKCE clients
  scopes: z.string().default("openid email profile"),
  email_claim: z.string().default("email"),
  // Optional: pin to a specific HD claim (Google Workspace) or a set
  // of email domains. Empty means "accept anyone the IdP accepts".
  allowed_domains: z.array(z.string()).default([]),
});
export type OIDCConfig = z.infer<typeof oidcConfigSchema>;

/** SAML 2.0 SP config. ``cert`` is the IdP's signing certificate
 *  (PEM); ``entry_point`` is the IdP SSO URL. */
export const samlConfigSchema = z.object({
  entry_point: z.string().url(),
  issuer: z.string().min(1),         // SP entity id
  cert: z.string().min(1),
  // optional SP private key for signing AuthnRequests
  private_key: z.string().optional(),
  // attribute to use as the user's email
  email_attribute: z.string().default("email"),
  name_attribute: z.string().default("displayName"),
  allowed_domains: z.array(z.string()).default([]),
});
export type SAMLConfig = z.infer<typeof samlConfigSchema>;

/** LDAP / Active Directory config. Bind-then-search pattern. */
export const ldapConfigSchema = z.object({
  url: z.string().min(1),              // e.g. ldaps://ldap.acme.com:636
  bind_dn: z.string().optional(),      // service account DN; empty = anonymous bind
  bind_password: z.string().optional(),
  search_base: z.string().min(1),      // base DN to search
  search_filter: z.string().default("(mail={{username}})"),
  email_attribute: z.string().default("mail"),
  name_attribute: z.string().default("displayName"),
  start_tls: z.boolean().default(false),
});
export type LDAPConfig = z.infer<typeof ldapConfigSchema>;

const SECRET_FIELDS: Record<ProviderKind, string[]> = {
  oidc: ["client_secret"],
  saml: ["private_key"],
  ldap: ["bind_password"],
};

// ---------- CRUD ----------------------------------------------------

export function listProviders(): ProviderRow[] {
  return db
    .prepare(
      "SELECT * FROM auth_providers ORDER BY is_enabled DESC, name ASC",
    )
    .all() as ProviderRow[];
}

export function getProvider(id: number): ProviderRow | null {
  const row = db
    .prepare("SELECT * FROM auth_providers WHERE id = ?")
    .get(id) as ProviderRow | undefined;
  return row ?? null;
}

/** Decrypt all secret fields and return the parsed config object for
 *  use by the provider code at sign-in time. */
export function getDecryptedConfig(
  row: ProviderRow,
): OIDCConfig | SAMLConfig | LDAPConfig {
  const raw = JSON.parse(row.config_json) as Record<string, unknown>;
  for (const field of SECRET_FIELDS[row.kind as ProviderKind] ?? []) {
    const v = raw[field];
    if (typeof v === "string" && isEncrypted(v)) {
      raw[field] = decryptString(v);
    }
  }
  if (row.kind === "oidc") return oidcConfigSchema.parse(raw);
  if (row.kind === "saml") return samlConfigSchema.parse(raw);
  return ldapConfigSchema.parse(raw);
}

/** Mask secrets in the config that the admin UI receives. We never
 *  echo back the plaintext of any secret field. */
export function maskConfigForDisplay(row: ProviderRow): Record<string, unknown> {
  const raw = JSON.parse(row.config_json) as Record<string, unknown>;
  for (const field of SECRET_FIELDS[row.kind as ProviderKind] ?? []) {
    if (raw[field]) raw[field] = "********";
  }
  return raw;
}

export function upsertProvider(opts: {
  id?: number;
  kind: ProviderKind;
  name: string;
  is_enabled?: boolean;
  default_role?: string;
  config: Record<string, unknown>;
}): ProviderRow {
  // Validate + normalise the config against the per-kind schema. We
  // *don't* require new secret values on update — if the admin leaves
  // the secret blank, we preserve whatever was already stored.
  const schema =
    opts.kind === "oidc" ? oidcConfigSchema
    : opts.kind === "saml" ? samlConfigSchema
    : ldapConfigSchema;

  let prior: Record<string, unknown> = {};
  if (opts.id != null) {
    const existing = getProvider(opts.id);
    if (existing) {
      prior = JSON.parse(existing.config_json) as Record<string, unknown>;
    }
  }
  const incoming = { ...opts.config };
  for (const field of SECRET_FIELDS[opts.kind] ?? []) {
    if (!incoming[field] || incoming[field] === "********") {
      if (prior[field] != null) incoming[field] = prior[field];
    }
  }
  const parsed = schema.parse(incoming) as Record<string, unknown>;
  // Encrypt secrets at rest.
  for (const field of SECRET_FIELDS[opts.kind] ?? []) {
    const v = parsed[field];
    if (typeof v === "string" && v && !isEncrypted(v)) {
      parsed[field] = encryptString(v);
    }
  }

  const configJson = JSON.stringify(parsed);
  if (opts.id != null) {
    db.prepare(
      `UPDATE auth_providers SET
         kind = ?, name = ?, is_enabled = ?, default_role = ?,
         config_json = ?, updated_at = strftime('%s', 'now')
       WHERE id = ?`,
    ).run(
      opts.kind, opts.name, opts.is_enabled === false ? 0 : 1,
      opts.default_role ?? "viewer", configJson, opts.id,
    );
    return getProvider(opts.id)!;
  }
  const info = db
    .prepare(
      `INSERT INTO auth_providers (kind, name, is_enabled, default_role, config_json)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      opts.kind, opts.name, opts.is_enabled === false ? 0 : 1,
      opts.default_role ?? "viewer", configJson,
    );
  return getProvider(Number(info.lastInsertRowid))!;
}

export function deleteProvider(id: number): boolean {
  // Detach SSO-provisioned users so deleting an IdP doesn't cascade
  // their accounts. They keep working as local users (admin can
  // reset their password) instead of vanishing silently.
  db.prepare(
    "UPDATE users SET auth_provider_id = NULL, external_id = NULL WHERE auth_provider_id = ?",
  ).run(id);
  const r = db.prepare("DELETE FROM auth_providers WHERE id = ?").run(id);
  return r.changes > 0;
}

// ---------- Email domain allowlist ---------------------------------

const ALLOWLIST_KEY = "auth_email_domain_allowlist";

export function getEmailDomainAllowlist(): string[] {
  const raw = getSetting(ALLOWLIST_KEY) || "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

export function setEmailDomainAllowlist(domains: string[]): void {
  const cleaned = Array.from(
    new Set(
      domains
        .map((s) => s.trim().toLowerCase())
        .filter(Boolean)
        .map((s) => (s.startsWith("@") ? s.slice(1) : s)),
    ),
  );
  setSetting(ALLOWLIST_KEY, cleaned.join(","));
}

/** Return true when an email is allowed under the current allowlist.
 *  Empty allowlist → permissive. Per-provider overrides are checked
 *  separately by the OIDC/SAML callbacks. */
export function isEmailAllowed(email: string): boolean {
  const list = getEmailDomainAllowlist();
  if (list.length === 0) return true;
  const at = email.lastIndexOf("@");
  if (at < 0) return false;
  const domain = email.slice(at + 1).toLowerCase();
  return list.includes(domain);
}

// ---------- API keys ----------------------------------------------

export interface ApiKeyRow {
  id: number;
  user_id: number;
  name: string;
  prefix: string;
  key_hash: string;
  last_used_at: number | null;
  expires_at: number | null;
  revoked_at: number | null;
  created_at: number;
}

/** Crunch API keys are URL-safe random tokens prefixed with
 *  ``crunch_pk_`` so they're easy to grep out of logs. */
const API_KEY_PREFIX = "crunch_pk_";

export function hashApiKey(secret: string): string {
  return crypto.createHash("sha256").update(secret).digest("hex");
}

export function generateApiKey(): string {
  // ~256 bits of entropy. Enough that brute-force is hopeless and
  // a single secret can be revoked without coordinating siblings.
  const body = crypto.randomBytes(32).toString("base64url");
  return `${API_KEY_PREFIX}${body}`;
}

export function createApiKey(opts: {
  user_id: number;
  name: string;
  expires_at?: number | null;
  /** Capability names this key is allowed to use. Empty = inherit
   *  the owner's full permission set. Non-empty narrows access —
   *  the bearer middleware intersects with the owner's effective
   *  permissions, so a key can never widen what the owner has. */
  scopes?: string[];
}): { row: ApiKeyRow; plaintext: string } {
  const plaintext = generateApiKey();
  const prefix = plaintext.slice(0, 16);
  const keyHash = hashApiKey(plaintext);
  const scopesJson = JSON.stringify(opts.scopes ?? []);
  const info = db
    .prepare(
      `INSERT INTO api_keys (user_id, name, prefix, key_hash, expires_at, scopes_json)
       VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.user_id, opts.name, prefix, keyHash,
      opts.expires_at ?? null, scopesJson,
    );
  const row = db
    .prepare("SELECT * FROM api_keys WHERE id = ?")
    .get(Number(info.lastInsertRowid)) as ApiKeyRow;
  return { row, plaintext };
}

export function listApiKeysForUser(userId: number): ApiKeyRow[] {
  return db
    .prepare("SELECT * FROM api_keys WHERE user_id = ? ORDER BY id DESC")
    .all(userId) as ApiKeyRow[];
}

export function listAllApiKeys(): Array<ApiKeyRow & { email: string }> {
  return db
    .prepare(
      `SELECT k.*, u.email FROM api_keys k
       JOIN users u ON u.id = k.user_id
       ORDER BY k.id DESC`,
    )
    .all() as Array<ApiKeyRow & { email: string }>;
}

export function revokeApiKey(id: number): boolean {
  const r = db
    .prepare(
      "UPDATE api_keys SET revoked_at = strftime('%s', 'now') WHERE id = ? AND revoked_at IS NULL",
    )
    .run(id);
  return r.changes > 0;
}

/** Look up an API key by its plaintext secret. Returns the owning
 *  user + the key's stored scope list when the key is valid (matched
 *  hash, not revoked, not expired); ``null`` otherwise. Updates
 *  ``last_used_at`` on hit so the admin UI can show "last used …". */
export function findUserByApiKey(secret: string):
  | {
      id: number; email: string; role: string; token_version: number;
      api_key_id: number;
      /** The key's stored scope list. Empty = inherit all of the
       *  owner's permissions. The middleware intersects with the
       *  owner's effective perms so keys can never widen access. */
      scopes: string[];
    }
  | null {
  if (!secret.startsWith(API_KEY_PREFIX)) return null;
  const hash = hashApiKey(secret);
  const row = db
    .prepare(
      `SELECT k.id AS api_key_id, k.revoked_at, k.expires_at, k.scopes_json,
              u.id, u.email, u.role, u.token_version
       FROM api_keys k JOIN users u ON u.id = k.user_id
       WHERE k.key_hash = ?`,
    )
    .get(hash) as
    | {
        api_key_id: number; revoked_at: number | null; expires_at: number | null;
        scopes_json: string;
        id: number; email: string; role: string; token_version: number;
      }
    | undefined;
  if (!row) return null;
  if (row.revoked_at != null) return null;
  const now = Math.floor(Date.now() / 1000);
  if (row.expires_at != null && row.expires_at < now) return null;
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(
    now, row.api_key_id,
  );
  let scopes: string[] = [];
  try {
    const parsed = JSON.parse(row.scopes_json || "[]");
    if (Array.isArray(parsed)) scopes = parsed.map((s) => String(s));
  } catch {
    /* leave empty */
  }
  return {
    id: row.id, email: row.email, role: row.role,
    token_version: row.token_version, api_key_id: row.api_key_id,
    scopes,
  };
}
