/**
 * OIDC / OAuth2 sign-in flow.
 *
 * Generic enough that one provider definition can be Google,
 * Microsoft 365, Okta, Auth0, Authentik, Keycloak, or GitHub. The
 * admin pastes a discovery URL (`/.well-known/openid-configuration`)
 * or the individual endpoint URLs, plus a client id/secret, and
 * the rest is plumbing.
 *
 * Flow:
 *   1. `startLogin()` builds the authorization redirect, generates
 *      PKCE + state, and stashes them in two short-lived HTTP-only
 *      cookies for the callback to verify.
 *   2. `handleCallback()` exchanges the code, validates the id_token,
 *      and resolves the user via email (or by external_id on repeat
 *      sign-ins). New users are auto-provisioned with the provider's
 *      default role unless the email domain allowlist rejects them.
 */

import crypto from "node:crypto";
import type { Request, Response } from "express";
import { db } from "../db/index.js";
import type { UserRow } from "./auth.js";
import {
  getDecryptedConfig,
  getProvider,
  isEmailAllowed,
  type OIDCConfig,
  type ProviderRow,
} from "./authProviders.js";
import { signToken } from "./auth.js";

const STATE_COOKIE = "crunch_oidc_state";
const VERIFIER_COOKIE = "crunch_oidc_verifier";
const PROVIDER_COOKIE = "crunch_oidc_provider";
const COOKIE_OPTS = {
  httpOnly: true,
  sameSite: "lax" as const,
  path: "/",
  maxAge: 10 * 60 * 1000,
};

interface DiscoveryDocument {
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  issuer?: string;
}

const discoveryCache = new Map<string, { doc: DiscoveryDocument; ts: number }>();
const DISCOVERY_TTL_MS = 60 * 60 * 1000; // 1 hour

async function discover(cfg: OIDCConfig): Promise<DiscoveryDocument> {
  if (cfg.authorization_endpoint && cfg.token_endpoint) {
    return {
      authorization_endpoint: cfg.authorization_endpoint,
      token_endpoint: cfg.token_endpoint,
      userinfo_endpoint: cfg.userinfo_endpoint,
      jwks_uri: cfg.jwks_uri,
      issuer: cfg.issuer,
    };
  }
  if (!cfg.discovery_url) {
    throw new Error(
      "OIDC provider needs either a discovery_url or explicit endpoint URLs",
    );
  }
  const cached = discoveryCache.get(cfg.discovery_url);
  if (cached && Date.now() - cached.ts < DISCOVERY_TTL_MS) return cached.doc;
  const r = await fetch(cfg.discovery_url);
  if (!r.ok) throw new Error(`discovery fetch failed (${r.status})`);
  const doc = (await r.json()) as DiscoveryDocument;
  discoveryCache.set(cfg.discovery_url, { doc, ts: Date.now() });
  return doc;
}

function pkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto
    .createHash("sha256").update(verifier).digest()
    .toString("base64url");
  return { verifier, challenge };
}

function publicCallbackUrl(req: Request, providerId: number): string {
  // The callback URL must match what the admin pre-registered with the
  // IdP. We synthesize it from the inbound request's headers; admins
  // can pin this via the `public_base_url` setting (TODO) if the
  // backend sits behind a non-standard proxy.
  const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
  const host = (req.headers["x-forwarded-host"] as string) || req.get("host");
  return `${proto}://${host}/api/auth/oidc/${providerId}/callback`;
}

export async function startLogin(
  req: Request,
  res: Response,
  provider: ProviderRow,
): Promise<void> {
  const cfg = getDecryptedConfig(provider) as OIDCConfig;
  const doc = await discover(cfg);
  const state = crypto.randomBytes(24).toString("base64url");
  const { verifier, challenge } = pkce();

  const params = new URLSearchParams({
    response_type: "code",
    client_id: cfg.client_id,
    redirect_uri: publicCallbackUrl(req, provider.id),
    scope: cfg.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });

  res.cookie(STATE_COOKIE, state, COOKIE_OPTS);
  res.cookie(VERIFIER_COOKIE, verifier, COOKIE_OPTS);
  res.cookie(PROVIDER_COOKIE, String(provider.id), COOKIE_OPTS);
  res.redirect(`${doc.authorization_endpoint}?${params.toString()}`);
}

interface TokenResponse {
  access_token: string;
  id_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
}

interface Claims {
  sub?: string;
  email?: string;
  email_verified?: boolean;
  name?: string;
  preferred_username?: string;
  [key: string]: unknown;
}

/** Decode (without signature verification) the payload of a JWT.
 *  We pair this with a fresh token-endpoint exchange + a userinfo
 *  call where available, so a forged id_token alone can't sign anyone
 *  in. (Full JWKS verification is on the follow-up list.) */
function decodeJwtPayload(jwt: string): Claims {
  const parts = jwt.split(".");
  if (parts.length < 2) return {};
  try {
    const payload = Buffer.from(parts[1]!, "base64url").toString("utf8");
    return JSON.parse(payload) as Claims;
  } catch {
    return {};
  }
}

export async function handleCallback(
  req: Request,
  res: Response,
): Promise<{ ok: true; token: string; user: { id: number; email: string; role: string } } | { ok: false; error: string }> {
  const code = req.query.code as string | undefined;
  const state = req.query.state as string | undefined;
  if (!code || !state) return { ok: false, error: "missing code or state" };

  const cookieState = (req.cookies as Record<string, string>)?.[STATE_COOKIE];
  const verifier = (req.cookies as Record<string, string>)?.[VERIFIER_COOKIE];
  const providerIdRaw = (req.cookies as Record<string, string>)?.[PROVIDER_COOKIE];
  // Clear the cookies regardless of whether we succeed — they're
  // single-use and lingering ones are noise.
  res.clearCookie(STATE_COOKIE, { path: "/" });
  res.clearCookie(VERIFIER_COOKIE, { path: "/" });
  res.clearCookie(PROVIDER_COOKIE, { path: "/" });

  if (!cookieState || cookieState !== state) {
    return { ok: false, error: "state mismatch — replay or stale cookie" };
  }
  if (!verifier || !providerIdRaw) {
    return { ok: false, error: "missing PKCE verifier or provider id" };
  }
  const provider = getProvider(Number(providerIdRaw));
  if (!provider || !provider.is_enabled) {
    return { ok: false, error: "unknown or disabled provider" };
  }

  const cfg = getDecryptedConfig(provider) as OIDCConfig;
  const doc = await discover(cfg);

  const tokenBody = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: cfg.client_id,
    code_verifier: verifier,
    redirect_uri: publicCallbackUrl(req, provider.id),
  });
  if (cfg.client_secret) tokenBody.set("client_secret", cfg.client_secret);

  const tokenRes = await fetch(doc.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });
  if (!tokenRes.ok) {
    const txt = await tokenRes.text();
    return { ok: false, error: `token exchange failed: ${txt.slice(0, 200)}` };
  }
  const tokens = (await tokenRes.json()) as TokenResponse;

  // Prefer userinfo since some IdPs (notably GitHub) don't issue an
  // OIDC id_token. We fall back to id_token claims for vanilla OIDC.
  let claims: Claims = tokens.id_token ? decodeJwtPayload(tokens.id_token) : {};
  if (doc.userinfo_endpoint && tokens.access_token) {
    try {
      const r = await fetch(doc.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      if (r.ok) {
        const userinfo = (await r.json()) as Claims;
        claims = { ...claims, ...userinfo };
      }
    } catch {
      /* keep claims from id_token */
    }
  }

  const externalId = claims.sub ? String(claims.sub) : undefined;
  const email = (claims[cfg.email_claim] as string | undefined) || claims.email;
  if (!email) {
    return { ok: false, error: "IdP did not return an email claim" };
  }
  const emailLower = email.toLowerCase();

  // Domain checks: provider-scoped, then global allowlist.
  if (cfg.allowed_domains.length > 0) {
    const dom = emailLower.split("@").pop() ?? "";
    if (!cfg.allowed_domains.map((d) => d.toLowerCase()).includes(dom)) {
      return { ok: false, error: `email domain not permitted by this IdP` };
    }
  }
  if (!isEmailAllowed(emailLower)) {
    return { ok: false, error: "email domain not on the allowlist" };
  }

  const user = upsertSsoUser({
    provider_id: provider.id,
    external_id: externalId,
    email: emailLower,
    default_role: provider.default_role,
  });
  return {
    ok: true,
    token: signToken(user),
    user: { id: user.id, email: user.email, role: user.role },
  };
}

interface MinimalUser {
  id: number;
  email: string;
  password_hash: string;
  role: string;
  token_version: number;
}

/** Look up (or auto-provision) the local user backing this SSO sign-in.
 *
 * Match priority:
 *   1. ``(auth_provider_id, external_id)`` — stable across email
 *      changes at the IdP.
 *   2. ``email`` — first-time login binds an existing local account
 *      to the IdP.
 *
 * New accounts get the provider's ``default_role`` and a random local
 * password they'll never use (the admin can clear it via reset). */
export function upsertSsoUser(opts: {
  provider_id: number;
  external_id?: string;
  email: string;
  default_role: string;
}): MinimalUser {
  if (opts.external_id) {
    const byExt = db
      .prepare(
        `SELECT id, email, password_hash, role, token_version
         FROM users WHERE auth_provider_id = ? AND external_id = ?`,
      )
      .get(opts.provider_id, opts.external_id) as MinimalUser | undefined;
    if (byExt) {
      // Re-sync the email in case the IdP renamed the user.
      if (byExt.email !== opts.email) {
        db.prepare("UPDATE users SET email = ? WHERE id = ?").run(
          opts.email, byExt.id,
        );
        byExt.email = opts.email;
      }
      return byExt;
    }
  }

  const byEmail = db
    .prepare(
      `SELECT id, email, password_hash, role, token_version
       FROM users WHERE email = ?`,
    )
    .get(opts.email) as MinimalUser | undefined;
  if (byEmail) {
    db.prepare(
      `UPDATE users SET auth_provider_id = ?, external_id = ?
       WHERE id = ?`,
    ).run(opts.provider_id, opts.external_id ?? null, byEmail.id);
    return byEmail;
  }

  // First-time SSO sign-in for this email — provision a local row.
  const placeholderHash = `sso:${crypto.randomBytes(16).toString("hex")}`;
  const info = db
    .prepare(
      `INSERT INTO users (email, password_hash, role, auth_provider_id, external_id)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .run(
      opts.email, placeholderHash,
      opts.default_role || "viewer",
      opts.provider_id, opts.external_id ?? null,
    );
  return {
    id: Number(info.lastInsertRowid),
    email: opts.email,
    password_hash: placeholderHash,
    role: opts.default_role || "viewer",
    token_version: 0,
  };
}

// Shim so callers that already have UserRow can pass it back to
// signToken without us re-fetching.
export type { UserRow };
