/**
 * LDAP / Active Directory sign-in.
 *
 * Two-step pattern that works against both standard LDAPv3 and AD:
 *
 *   1. Bind with the configured *service account* (or anonymously).
 *   2. Search ``search_base`` for the user, substituting the typed
 *      identifier into ``search_filter``. The first hit wins.
 *   3. Re-bind as the located user DN with the typed password. A
 *      successful bind proves the credential without us ever seeing
 *      the user's password again.
 *
 * The user row is upserted via the same SSO path so an LDAP user and
 * an OIDC user with the same email end up as the same Crunch account.
 */

import { signToken } from "./auth.js";
import {
  getDecryptedConfig,
  isEmailAllowed,
  type LDAPConfig,
  type ProviderRow,
} from "./authProviders.js";
import { upsertSsoUser } from "./oidc.js";

interface LDAPSearchEntry {
  dn: string;
  attributes: Record<string, unknown>;
}

interface LDAPClient {
  bind(dn: string, password: string): Promise<void>;
  unbind(): Promise<void>;
  startTLS?(opts?: Record<string, unknown>): Promise<void>;
  search(
    base: string,
    options: { filter: string; scope: string; attributes?: string[] },
  ): Promise<{ searchEntries: LDAPSearchEntry[] }>;
}

interface LDAPClientCtor {
  new (opts: { url: string }): LDAPClient;
}

let _ClientCtor: LDAPClientCtor | null = null;
async function loadLDAP(): Promise<LDAPClientCtor> {
  if (_ClientCtor) return _ClientCtor;
  const mod = (await import("ldapts")) as unknown as { Client: LDAPClientCtor };
  _ClientCtor = mod.Client;
  return _ClientCtor;
}

function readStringAttr(entry: LDAPSearchEntry, name: string): string | undefined {
  const v = entry.attributes[name];
  if (Array.isArray(v) && v.length > 0) {
    const first = v[0];
    return typeof first === "string" ? first : (first instanceof Buffer ? first.toString("utf8") : String(first));
  }
  if (typeof v === "string") return v;
  if (v instanceof Buffer) return v.toString("utf8");
  return undefined;
}

export async function login(
  provider: ProviderRow,
  identifier: string,
  password: string,
): Promise<{ ok: true; token: string; user: { id: number; email: string; role: string } } | { ok: false; error: string }> {
  if (!identifier || !password) return { ok: false, error: "missing credentials" };
  const cfg = getDecryptedConfig(provider) as LDAPConfig;
  const Ctor = await loadLDAP();
  const client = new Ctor({ url: cfg.url });

  try {
    if (cfg.start_tls && client.startTLS) await client.startTLS({});

    // Service bind first (anonymous if no bind_dn).
    if (cfg.bind_dn) {
      try {
        await client.bind(cfg.bind_dn, cfg.bind_password ?? "");
      } catch (e) {
        return { ok: false, error: `service bind failed: ${(e as Error).message}` };
      }
    }

    // Substitute {{username}} into the filter; lowercased to keep it
    // case-insensitive for typical AD/OpenLDAP setups.
    const safe = identifier.replace(/[()\\*\0]/g, "");
    const filter = cfg.search_filter.replace(/\{\{\s*username\s*\}\}/g, safe);
    const result = await client.search(cfg.search_base, {
      filter,
      scope: "sub",
      attributes: [cfg.email_attribute, cfg.name_attribute, "dn", "cn"],
    });
    if (result.searchEntries.length === 0) {
      return { ok: false, error: "user not found" };
    }
    const entry = result.searchEntries[0]!;

    // Re-bind as the user — this is the actual password check.
    const userClient = new Ctor({ url: cfg.url });
    try {
      if (cfg.start_tls && userClient.startTLS) await userClient.startTLS({});
      await userClient.bind(entry.dn, password);
    } catch (e) {
      return { ok: false, error: `invalid credentials: ${(e as Error).message}` };
    } finally {
      try {
        await userClient.unbind();
      } catch {
        /* ignore */
      }
    }

    const email =
      readStringAttr(entry, cfg.email_attribute)
      || (identifier.includes("@") ? identifier : "");
    if (!email) return { ok: false, error: "user has no email attribute" };
    const emailLower = email.toLowerCase();
    if (!isEmailAllowed(emailLower)) {
      return { ok: false, error: "email domain not on the allowlist" };
    }

    const user = upsertSsoUser({
      provider_id: provider.id,
      external_id: entry.dn,
      email: emailLower,
      default_role: provider.default_role,
    });
    return {
      ok: true,
      token: signToken(user),
      user: { id: user.id, email: user.email, role: user.role },
    };
  } finally {
    try {
      await client.unbind();
    } catch {
      /* ignore */
    }
  }
}
