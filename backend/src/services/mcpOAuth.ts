/**
 * OAuth 2.0 for the outbound MCP client.
 *
 * Implements the public-client (PKCE, ``token_endpoint_auth_method:
 * none``) authorization-code + refresh-token flow that Metabase's
 * built-in MCP server requires, with RFC 8707 resource indicators so the
 * issued token is bound to the specific MCP endpoint.
 *
 * Flow:
 *   1. discover() — protected-resource metadata (RFC 9728) → issuer →
 *      authorization-server metadata (RFC 8414) → endpoints + scopes.
 *   2. ensureClient() — dynamic client registration (RFC 7591) if we
 *      don't already have a client_id for this server.
 *   3. startAuthorization() — generate PKCE + state, persist them, return
 *      the /authorize URL the user approves in the browser.
 *   4. handleCallback() — exchange the code for tokens, store them
 *      (encrypted), kick a handshake so the tools list populates.
 *   5. getValidAccessToken() — hand the transport a live bearer token,
 *      transparently refreshing when it's near expiry.
 *
 * All tokens + the client secret + the registration access token are
 * encrypted at rest with the shared crypto module.
 */

import crypto from "node:crypto";
import { request } from "undici";
import { db } from "../db/index.js";
import { decryptString, encryptString, isEncrypted } from "./crypto.js";
import { getServer, refreshServer, type McpServerRow } from "./mcpClient.js";

/** Thrown when no usable token can be obtained without the user
 *  re-approving in the browser. The transport surfaces this as a
 *  "reconnect needed" state rather than a generic failure. */
export class ReauthRequiredError extends Error {
  constructor(public serverId: number, message = "reconnect needed") {
    super(message);
    this.name = "ReauthRequiredError";
  }
}

interface PendingRow {
  state: string;
  server_id: number;
  code_verifier: string;
  redirect_uri: string;
  created_at: number;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
  token_type?: string;
  scope?: string;
}

interface DiscoveryResult {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint: string;
  scopesSupported: string[];
}

const nowSec = () => Math.floor(Date.now() / 1000);

function dec(v: string | null): string | null {
  if (!v) return null;
  return isEncrypted(v) ? decryptString(v) : v;
}

function base64url(buf: Buffer): string {
  return buf.toString("base64url");
}

// ---------- tiny HTTP helpers -------------------------------------

async function getJson(url: string): Promise<Record<string, unknown>> {
  const { statusCode, body } = await request(url, {
    method: "GET",
    headers: { accept: "application/json" },
  });
  const text = await body.text();
  if (statusCode >= 400) {
    throw new Error(`GET ${url} → ${statusCode}: ${text.slice(0, 200)}`);
  }
  return JSON.parse(text) as Record<string, unknown>;
}

async function postJson(
  url: string,
  obj: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { statusCode, body } = await request(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(obj),
  });
  const text = await body.text();
  if (statusCode >= 400) {
    throw new Error(`POST ${url} → ${statusCode}: ${text.slice(0, 300)}`);
  }
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

async function postForm(
  url: string,
  params: URLSearchParams,
): Promise<TokenResponse> {
  const { statusCode, body } = await request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: params.toString(),
  });
  const text = await body.text();
  if (statusCode >= 400) {
    throw new Error(`token endpoint → ${statusCode}: ${text.slice(0, 300)}`);
  }
  return JSON.parse(text) as TokenResponse;
}

// ---------- discovery ---------------------------------------------

/**
 * Resolve the authorization server + its endpoints for an MCP URL.
 * Follows protected-resource metadata to the issuer, then reads the
 * auth-server metadata. Falls back to RFC 8414 path conventions if a
 * document is missing a field.
 */
export async function discover(mcpUrl: string): Promise<DiscoveryResult> {
  const u = new URL(mcpUrl);
  const origin = u.origin;
  let issuer = origin;
  let scopesSupported: string[] = [];

  // RFC 9728: /.well-known/oauth-protected-resource{resource-path}
  try {
    const pr = await getJson(
      `${origin}/.well-known/oauth-protected-resource${u.pathname}`,
    );
    const servers = pr.authorization_servers;
    if (Array.isArray(servers) && servers[0]) {
      issuer = String(servers[0]).replace(/\/+$/, "");
    }
    if (Array.isArray(pr.scopes_supported)) {
      scopesSupported = (pr.scopes_supported as unknown[]).map(String);
    } else if (typeof pr.scopes_supported === "string") {
      scopesSupported = pr.scopes_supported.split(/\s+/).filter(Boolean);
    }
  } catch {
    // No protected-resource doc — assume the resource origin is the issuer.
  }

  // RFC 8414 auth-server metadata; try the OAuth name then OIDC.
  let as: Record<string, unknown> | null = null;
  for (const candidate of [
    `${issuer}/.well-known/oauth-authorization-server`,
    `${issuer}/.well-known/openid-configuration`,
  ]) {
    try {
      as = await getJson(candidate);
      break;
    } catch {
      /* try next */
    }
  }

  const str = (k: string): string | undefined =>
    as && typeof as[k] === "string" ? (as[k] as string) : undefined;

  return {
    issuer,
    authorization_endpoint: str("authorization_endpoint") ?? `${issuer}/oauth/authorize`,
    token_endpoint: str("token_endpoint") ?? `${issuer}/oauth/token`,
    registration_endpoint: str("registration_endpoint") ?? `${issuer}/oauth/register`,
    scopesSupported,
  };
}

// ---------- dynamic client registration ---------------------------

async function ensureClient(
  row: McpServerRow,
  meta: DiscoveryResult,
  redirectUri: string,
): Promise<void> {
  if (row.oauth_client_id) return;
  const scope = (row.oauth_scope && row.oauth_scope.trim()) || meta.scopesSupported.join(" ");
  const reg = await postJson(meta.registration_endpoint, {
    client_name: "Crunch",
    redirect_uris: [redirectUri],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
    application_type: "native",
    ...(scope ? { scope } : {}),
  });
  const clientId = reg.client_id;
  if (typeof clientId !== "string" || !clientId) {
    throw new Error("client registration response did not include a client_id");
  }
  db.prepare(
    `UPDATE mcp_servers SET
       oauth_client_id = ?, oauth_client_secret = ?, oauth_registration_access_token = ?
     WHERE id = ?`,
  ).run(
    clientId,
    typeof reg.client_secret === "string" && reg.client_secret
      ? encryptString(reg.client_secret)
      : null,
    typeof reg.registration_access_token === "string" && reg.registration_access_token
      ? encryptString(reg.registration_access_token)
      : null,
    row.id,
  );
}

// ---------- authorize ---------------------------------------------

/**
 * Prepare an authorization request: discover endpoints, register a
 * client if needed, mint PKCE + state, and return the /authorize URL
 * for the browser to open.
 */
export async function startAuthorization(
  serverId: number,
  redirectUri: string,
): Promise<string> {
  const row = getServer(serverId);
  if (!row) throw new Error("server not found");
  if (row.auth_mode !== "oauth2") throw new Error("server is not in OAuth mode");

  const meta = await discover(row.url);
  const scope = (row.oauth_scope && row.oauth_scope.trim()) || meta.scopesSupported.join(" ");
  // Persist discovered endpoints + resolved scope; default the resource
  // indicator to the MCP URL when not already pinned.
  db.prepare(
    `UPDATE mcp_servers SET
       oauth_issuer = ?, oauth_authorization_endpoint = ?, oauth_token_endpoint = ?,
       oauth_scope = ?, oauth_resource = COALESCE(oauth_resource, ?)
     WHERE id = ?`,
  ).run(
    meta.issuer,
    meta.authorization_endpoint,
    meta.token_endpoint,
    scope || null,
    row.url,
    serverId,
  );

  const withEndpoints = getServer(serverId)!;
  await ensureClient(withEndpoints, meta, redirectUri);
  const ready = getServer(serverId)!;

  const codeVerifier = base64url(crypto.randomBytes(32)); // 43 chars
  const codeChallenge = base64url(
    crypto.createHash("sha256").update(codeVerifier).digest(),
  );
  const state = base64url(crypto.randomBytes(24));

  // Sweep stale pending rows (>10 min) before inserting this one.
  db.prepare("DELETE FROM mcp_oauth_pending WHERE created_at < ?").run(nowSec() - 600);
  db.prepare(
    "INSERT INTO mcp_oauth_pending (state, server_id, code_verifier, redirect_uri) VALUES (?, ?, ?, ?)",
  ).run(state, serverId, codeVerifier, redirectUri);

  const params = new URLSearchParams({
    response_type: "code",
    client_id: ready.oauth_client_id!,
    redirect_uri: redirectUri,
    state,
    code_challenge: codeChallenge,
    code_challenge_method: "S256",
  });
  if (scope) params.set("scope", scope);
  if (ready.oauth_resource) params.set("resource", ready.oauth_resource);
  return `${meta.authorization_endpoint}?${params.toString()}`;
}

// ---------- token persistence -------------------------------------

function persistTokens(serverId: number, tok: TokenResponse): void {
  const expiresAt = tok.expires_in ? nowSec() + Number(tok.expires_in) : null;
  db.prepare(
    `UPDATE mcp_servers SET
       oauth_access_token = ?,
       oauth_refresh_token = COALESCE(?, oauth_refresh_token),
       oauth_expires_at = ?,
       last_error = NULL
     WHERE id = ?`,
  ).run(
    encryptString(tok.access_token),
    // Refresh tokens may rotate; keep the prior one if the server didn't
    // return a new value.
    tok.refresh_token ? encryptString(tok.refresh_token) : null,
    expiresAt,
    serverId,
  );
}

function markReauth(serverId: number, message: string): void {
  db.prepare("UPDATE mcp_servers SET last_error = ? WHERE id = ?").run(
    `Reconnect needed: ${message}`,
    serverId,
  );
}

// ---------- callback ----------------------------------------------

export async function handleCallback(code: string, state: string): Promise<void> {
  const pending = db
    .prepare("SELECT * FROM mcp_oauth_pending WHERE state = ?")
    .get(state) as PendingRow | undefined;
  if (!pending) throw new Error("unknown or expired authorization state");

  const row = getServer(pending.server_id);
  if (!row) {
    db.prepare("DELETE FROM mcp_oauth_pending WHERE state = ?").run(state);
    throw new Error("server no longer exists");
  }

  const params = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: pending.redirect_uri,
    client_id: row.oauth_client_id ?? "",
    code_verifier: pending.code_verifier,
  });
  if (row.oauth_resource) params.set("resource", row.oauth_resource);
  // Confidential-client fallback — public clients won't have a secret.
  const secret = dec(row.oauth_client_secret);
  if (secret) params.set("client_secret", secret);

  const tok = await postForm(row.oauth_token_endpoint!, params);
  persistTokens(row.id, tok);
  db.prepare("DELETE FROM mcp_oauth_pending WHERE state = ?").run(state);

  // Populate the tools list now that we can authenticate.
  await refreshServer(row.id);
}

// ---------- access-token vending ----------------------------------

/**
 * Return a valid bearer token for an OAuth server, refreshing via the
 * refresh_token when the current access token is missing or within ~60s
 * of expiry. ``force`` skips the freshness check (used on a 401 retry).
 * Throws ReauthRequiredError when only the user can recover.
 */
export async function getValidAccessToken(
  row: McpServerRow,
  opts: { force?: boolean } = {},
): Promise<string> {
  if (row.auth_mode !== "oauth2") throw new Error("server is not in OAuth mode");
  const access = dec(row.oauth_access_token);
  const expiresAt = row.oauth_expires_at;
  const stale = !access || (expiresAt != null && nowSec() >= expiresAt - 60);

  if (!opts.force && !stale && access) return access;

  const refresh = dec(row.oauth_refresh_token);
  if (!refresh) {
    if (access && !opts.force) return access; // best effort, no way to refresh
    markReauth(row.id, "no refresh token");
    throw new ReauthRequiredError(row.id, "no refresh token");
  }

  const params = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refresh,
    client_id: row.oauth_client_id ?? "",
  });
  if (row.oauth_resource) params.set("resource", row.oauth_resource);
  if (row.oauth_scope) params.set("scope", row.oauth_scope);
  const secret = dec(row.oauth_client_secret);
  if (secret) params.set("client_secret", secret);

  let tok: TokenResponse;
  try {
    tok = await postForm(row.oauth_token_endpoint!, params);
  } catch (e) {
    const msg = (e as Error).message;
    markReauth(row.id, msg);
    throw new ReauthRequiredError(row.id, msg);
  }
  persistTokens(row.id, tok);
  return dec(getServer(row.id)!.oauth_access_token)!;
}
