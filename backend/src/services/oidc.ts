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
import { createRemoteJWKSet, jwtVerify } from "jose";
import { db } from "../db/index.js";
import { config } from "../config.js";
import type { UserRow } from "./auth.js";
import {
  getDecryptedConfig,
  getProvider,
  isEmailAllowed,
  type OIDCConfig,
  type ProviderRow,
} from "./authProviders.js";
import { signToken } from "./auth.js";
import { assertSafeUrl, safeFetch } from "./ssrfGuard.js";

/** Privilege ordering for SSO role-capping. A higher number means more
 *  privilege; an SSO sign-in may never *bind to* an existing account
 *  whose role outranks the provider's configured default_role. */
const ROLE_RANK: Record<string, number> = { viewer: 0, editor: 1, admin: 2 };
function roleRank(role: string): number {
  return ROLE_RANK[role] ?? 0;
}

/**
 * Single source of truth for the externally-reachable origin, used to
 * build OAuth redirect / SAML ACS URLs that must match what the admin
 * registered with the IdP.
 *
 * Security: we do NOT trust ``X-Forwarded-Host`` / ``X-Forwarded-Proto``
 * in production — those are attacker-controllable and a poisoned value
 * would steer the OAuth round-trip. In production the operator must pin
 * ``NICEMETA_PUBLIC_BASE_URL``. Only in dev do we fall back to the
 * request's own host so the native 3691/5173 split keeps working.
 */
export function resolvePublicBaseUrl(req: Request): string {
  const envBase = (process.env.NICEMETA_PUBLIC_BASE_URL || "").trim();
  if (envBase) return envBase.replace(/\/+$/, "");
  if (config.isDev) {
    const proto = (req.headers["x-forwarded-proto"] as string) || req.protocol;
    const host = (req.headers["x-forwarded-host"] as string) || req.get("host");
    return `${proto}://${host}`;
  }
  throw new Error(
    "NICEMETA_PUBLIC_BASE_URL must be set to the public origin (e.g. "
    + "https://crunch.example.com) for SSO to build a trusted callback URL.",
  );
}

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
  const r = await safeFetch(cfg.discovery_url);
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
  // IdP. Built from the trusted public base (see resolvePublicBaseUrl)
  // rather than attacker-controllable forwarded headers.
  return `${resolvePublicBaseUrl(req)}/api/auth/oidc/${providerId}/callback`;
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

// Cache JWKS handles per jwks_uri so we don't refetch the keyset on
// every sign-in. `createRemoteJWKSet` itself caches signing keys with
// rotation handling, so the cache is just "one factory per IdP".
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function jwksFor(uri: string): ReturnType<typeof createRemoteJWKSet> {
  let h = jwksCache.get(uri);
  if (!h) {
    h = createRemoteJWKSet(new URL(uri));
    jwksCache.set(uri, h);
  }
  return h;
}

/** Verify an id_token against the IdP's JWKS and return its claims.
 *  Falls back to throwing on any failure — callers treat that as
 *  "abandon the sign-in".
 *
 *  This *replaces* the previous unsafe decode. Even when paired with
 *  a token-endpoint call, a signed id_token is the standard contract
 *  for OIDC sign-in and skipping verification creates a class of
 *  attacks (TLS interception, IdP bugs, public-client flows) that
 *  defence-in-depth should cover.
 */
async function verifyIdToken(
  jwt: string,
  doc: DiscoveryDocument,
  cfg: OIDCConfig,
): Promise<Claims> {
  if (!doc.jwks_uri) {
    // No JWKS endpoint advertised — we *can't* verify. Refuse to
    // accept the id_token's claims rather than silently trust them.
    throw new Error(
      "IdP did not advertise a jwks_uri — id_token cannot be verified. "
      + "Pin one explicitly in the provider config.",
    );
  }
  // SSRF guard the JWKS URI before jose fetches it.
  await assertSafeUrl(doc.jwks_uri);
  const jwks = jwksFor(doc.jwks_uri);
  const { payload } = await jwtVerify(jwt, jwks, {
    issuer: doc.issuer ?? cfg.issuer,
    audience: cfg.client_id,
  });
  return payload as Claims;
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

  const tokenRes = await safeFetch(doc.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: tokenBody.toString(),
  });
  if (!tokenRes.ok) {
    const txt = await tokenRes.text();
    return { ok: false, error: `token exchange failed: ${txt.slice(0, 200)}` };
  }
  const tokens = (await tokenRes.json()) as TokenResponse;

  // Two independent identity sources, tracked separately so the
  // signature-verified one always wins for identity-critical fields:
  //   - verifiedClaims: from a JWKS-verified id_token (trusted).
  //   - userinfoClaims: from the userinfo endpoint, fetched with the
  //     access_token (trusted transport, but not signed identity).
  // We never trust an *unsigned* id_token: if the IdP advertises no
  // JWKS we drop the id_token entirely and rely on userinfo.
  let verifiedClaims: Claims = {};
  let idTokenVerified = false;
  if (tokens.id_token) {
    try {
      verifiedClaims = await verifyIdToken(tokens.id_token, doc, cfg);
      idTokenVerified = true;
    } catch (e) {
      const msg = (e as Error).message;
      // "no jwks_uri" → degrade to userinfo-only (handled below).
      // Any real verification failure (bad signature, wrong issuer /
      // audience) is fatal — never fall back to unsigned claims.
      if (!/did not advertise a jwks_uri/.test(msg)) {
        return { ok: false, error: `id_token verification failed: ${msg}` };
      }
    }
  }

  let userinfoClaims: Claims = {};
  if (doc.userinfo_endpoint && tokens.access_token) {
    try {
      const r = await safeFetch(doc.userinfo_endpoint, {
        headers: { authorization: `Bearer ${tokens.access_token}` },
      });
      if (r.ok) userinfoClaims = (await r.json()) as Claims;
    } catch {
      /* keep verified claims */
    }
  }

  // Merge: userinfo as the base, verified id_token overlaid on top so a
  // signed claim can never be overridden by the unsigned userinfo body.
  const claims: Claims = idTokenVerified
    ? { ...userinfoClaims, ...verifiedClaims }
    : userinfoClaims;

  if (!idTokenVerified && Object.keys(userinfoClaims).length === 0) {
    // No verified id_token AND no userinfo — we have no trustworthy
    // identity. Refuse rather than trust an unsigned token.
    return {
      ok: false,
      error:
        "no verifiable identity from IdP (no JWKS signature and no userinfo endpoint)",
    };
  }

  const externalId = claims.sub ? String(claims.sub) : undefined;
  const email = (claims[cfg.email_claim] as string | undefined) || claims.email;
  if (!email) {
    return { ok: false, error: "IdP did not return an email claim" };
  }
  const emailLower = email.toLowerCase();

  // Email-verification gate (F1). ``email_verified`` is only meaningful
  // when it rode in on a signed id_token or a same-origin userinfo
  // response; we treat a literal ``true``/``"true"`` as verified.
  if (cfg.require_verified_email) {
    // Some IdPs send a boolean, others a "true"/"false" string.
    const ev = claims.email_verified as unknown;
    const verified = ev === true || ev === "true";
    if (!verified) {
      return {
        ok: false,
        error:
          "IdP did not assert email_verified for this account. Verify the "
          + "address at the IdP, or disable require_verified_email for this provider.",
      };
    }
  }

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

  try {
    const user = upsertSsoUser({
      provider_id: provider.id,
      external_id: externalId,
      email: emailLower,
      default_role: provider.default_role,
      allow_email_link: cfg.link_existing_by_email,
    });
    return {
      ok: true,
      token: signToken(user),
      user: { id: user.id, email: user.email, role: user.role },
    };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

interface MinimalUser {
  id: number;
  email: string;
  password_hash: string;
  role: string;
  token_version: number;
  auth_provider_id?: number | null;
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
  /** Whether the provider permits attaching this identity to a
   *  pre-existing local account matched only by email. Defaults to the
   *  safe ``false`` — without it a colliding email is refused. */
  allow_email_link?: boolean;
}): MinimalUser {
  if (opts.external_id) {
    const byExt = db
      .prepare(
        `SELECT id, email, password_hash, role, token_version, auth_provider_id
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
      `SELECT id, email, password_hash, role, token_version, auth_provider_id
       FROM users WHERE email = ?`,
    )
    .get(opts.email) as MinimalUser | undefined;
  if (byEmail) {
    const alreadyLinked = byEmail.auth_provider_id === opts.provider_id;
    if (!alreadyLinked) {
      // First time this provider sees an email that already belongs to a
      // local (or other-provider) account. This is the account-takeover
      // surface: an attacker who can make the IdP assert a victim's email
      // would otherwise log straight into the victim's account.
      if (!opts.allow_email_link) {
        throw new Error(
          "an account with this email already exists; ask an admin to link "
          + "it to this identity provider (link_existing_by_email is off)",
        );
      }
      // Even when linking is allowed, never let SSO climb privilege:
      // refuse to bind onto an account that outranks default_role.
      if (roleRank(byEmail.role) > roleRank(opts.default_role)) {
        throw new Error(
          "refusing to bind SSO sign-in to a more-privileged existing "
          + `account (${byEmail.role}); an admin must link it explicitly`,
        );
      }
    }
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
