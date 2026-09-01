/**
 * SuperGrok / X Premium subscription OAuth (RFC 8628 device code).
 *
 * xAI documents this flow for third-party tools (OpenCode, Grok CLI).
 * A SuperGrok or eligible X Premium login yields a bearer that the Grok
 * CLI chat proxy honors — no metered API key required.
 *
 * Constants match the public Grok-CLI client (no secret; PKCE is not
 * used on the device grant). Refresh tokens rotate on every refresh
 * and must be persisted immediately.
 */

import { request } from "undici";

export const XAI_OAUTH = {
  issuer: "https://auth.x.ai",
  clientId: "b1a00492-073a-47ea-816f-4c329264a828",
  deviceUrl: "https://auth.x.ai/oauth2/device/code",
  tokenUrl: "https://auth.x.ai/oauth2/token",
  userinfoUrl: "https://auth.x.ai/oauth2/userinfo",
  scope:
    "openid profile email offline_access grok-cli:access api:access conversations:read conversations:write",
  deviceGrant: "urn:ietf:params:oauth:grant-type:device_code",
} as const;

/** Grok CLI identity headers required by cli-chat-proxy.grok.com. */
export const GROK_CLI_HEADERS: Record<string, string> = {
  "x-xai-token-auth": "xai-grok-cli",
  "x-grok-client-identifier": "grok-shell",
  "x-grok-client-version": "0.2.93",
};

export const XAI_API_BASE = "https://api.x.ai/v1";
export const XAI_SUBSCRIPTION_BASE = "https://cli-chat-proxy.grok.com/v1";

const DEVICE_DEFAULT_INTERVAL_MS = 5_000;
const DEVICE_MIN_INTERVAL_MS = 1_000;
const DEVICE_SLOW_DOWN_MS = 5_000;
const DEVICE_DEFAULT_EXPIRES_MS = 5 * 60 * 1000;
const ACCESS_REFRESH_SKEW_MS = 120_000;

export interface XaiTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type?: string;
  scope?: string;
  email?: string;
}

export interface DeviceStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

export type DevicePollResult =
  | { status: "pending" }
  | { status: "slow_down" }
  | { status: "denied"; error: string }
  | { status: "expired"; error: string }
  | { status: "complete"; tokens: XaiTokens };

interface PendingSession {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval_ms: number;
  expires_at_ms: number;
  status: "pending" | "complete" | "denied" | "expired";
  error?: string;
  tokens?: XaiTokens;
  timer?: ReturnType<typeof setTimeout>;
}

const sessions = new Map<string, PendingSession>();

function formBody(data: Record<string, string>): string {
  return new URLSearchParams(data).toString();
}

async function postForm(
  url: string,
  data: Record<string, string>,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const { statusCode, body } = await request(url, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: formBody(data),
  });
  const text = await body.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    json = { error: text.slice(0, 400) };
  }
  return { status: statusCode, json };
}

function jwtExpSeconds(token: string): number | null {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as {
      exp?: unknown;
    };
    return typeof payload.exp === "number" ? payload.exp : null;
  } catch {
    return null;
  }
}

function tokensFromResponse(json: Record<string, unknown>, email?: string): XaiTokens {
  const access = String(json.access_token ?? "");
  const refresh = String(json.refresh_token ?? "");
  if (!access || !refresh) {
    throw new Error("xAI token response was missing access_token or refresh_token");
  }
  const jwtExp = jwtExpSeconds(access);
  const expiresIn = Number(json.expires_in);
  const expires_at = jwtExp
    ?? (Number.isFinite(expiresIn) && expiresIn > 0
      ? Math.floor(Date.now() / 1000) + expiresIn
      : Math.floor(Date.now() / 1000) + 15 * 60);
  return {
    access_token: access,
    refresh_token: refresh,
    expires_at,
    token_type: typeof json.token_type === "string" ? json.token_type : "Bearer",
    scope: typeof json.scope === "string" ? json.scope : undefined,
    email,
  };
}

export async function fetchXaiUserEmail(accessToken: string): Promise<string | undefined> {
  try {
    const { statusCode, body } = await request(XAI_OAUTH.userinfoUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
    });
    if (statusCode >= 400) {
      await body.text();
      return undefined;
    }
    const json = (await body.json()) as { email?: unknown; preferred_username?: unknown };
    if (typeof json.email === "string" && json.email) return json.email;
    if (typeof json.preferred_username === "string" && json.preferred_username) {
      return json.preferred_username;
    }
  } catch {
    /* userinfo is best-effort */
  }
  return undefined;
}

export async function startDeviceAuthorization(): Promise<DeviceStart> {
  const { status, json } = await postForm(XAI_OAUTH.deviceUrl, {
    client_id: XAI_OAUTH.clientId,
    scope: XAI_OAUTH.scope,
  });
  if (status >= 400) {
    const msg = String(json.error_description ?? json.error ?? `HTTP ${status}`);
    throw new Error(`xAI device authorization failed: ${msg}`);
  }
  const device_code = String(json.device_code ?? "");
  const user_code = String(json.user_code ?? "");
  const verification_uri = String(json.verification_uri ?? "https://auth.x.ai/activate");
  const verification_uri_complete = String(
    json.verification_uri_complete ?? `${verification_uri}?user_code=${encodeURIComponent(user_code)}`,
  );
  const expires_in = Number(json.expires_in);
  const interval = Number(json.interval);
  if (!device_code || !user_code) {
    throw new Error("xAI device authorization returned an incomplete payload");
  }
  return {
    device_code,
    user_code,
    verification_uri,
    verification_uri_complete,
    expires_in: Number.isFinite(expires_in) && expires_in > 0 ? expires_in : 300,
    interval: Number.isFinite(interval) && interval > 0 ? interval : 5,
  };
}

export async function pollDeviceToken(deviceCode: string): Promise<DevicePollResult> {
  const { status, json } = await postForm(XAI_OAUTH.tokenUrl, {
    grant_type: XAI_OAUTH.deviceGrant,
    client_id: XAI_OAUTH.clientId,
    device_code: deviceCode,
  });
  const err = String(json.error ?? "");
  if (status < 400 && json.access_token) {
    const email = await fetchXaiUserEmail(String(json.access_token));
    return { status: "complete", tokens: tokensFromResponse(json, email) };
  }
  if (err === "authorization_pending") return { status: "pending" };
  if (err === "slow_down") return { status: "slow_down" };
  if (err === "access_denied" || err === "authorization_denied") {
    return { status: "denied", error: "You declined the SuperGrok sign-in." };
  }
  if (err === "expired_token") {
    return { status: "expired", error: "The sign-in code expired. Start again." };
  }
  const desc = String(json.error_description ?? err ?? `HTTP ${status}`);
  if (status >= 400) return { status: "denied", error: desc };
  return { status: "pending" };
}

export async function refreshXaiTokens(refreshToken: string, email?: string): Promise<XaiTokens> {
  const { status, json } = await postForm(XAI_OAUTH.tokenUrl, {
    grant_type: "refresh_token",
    client_id: XAI_OAUTH.clientId,
    refresh_token: refreshToken,
  });
  if (status === 403) {
    throw new Error(
      "This xAI account is signed in but is not entitled to API access on the current SuperGrok / X Premium tier. Use an API key from console.x.ai, or upgrade the subscription.",
    );
  }
  if (status >= 400) {
    const msg = String(json.error_description ?? json.error ?? `HTTP ${status}`);
    throw new Error(`SuperGrok session expired (${msg}). Reconnect in Admin → Settings.`);
  }
  return tokensFromResponse(json, email);
}

export function accessTokenNeedsRefresh(tokens: XaiTokens, nowMs = Date.now()): boolean {
  return tokens.expires_at * 1000 - ACCESS_REFRESH_SKEW_MS <= nowMs;
}

/* -------------------------------------------------------------------------
 * In-process device sessions (admin UI polls these)
 * ---------------------------------------------------------------------- */

function newSessionId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export interface DeviceSessionPublic {
  session_id: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  status: PendingSession["status"];
  error?: string;
  email?: string;
}

function publicSession(id: string, s: PendingSession): DeviceSessionPublic {
  return {
    session_id: id,
    user_code: s.user_code,
    verification_uri: s.verification_uri,
    verification_uri_complete: s.verification_uri_complete,
    expires_in: Math.max(0, Math.round((s.expires_at_ms - Date.now()) / 1000)),
    status: s.status,
    error: s.error,
    email: s.tokens?.email,
  };
}

function schedulePoll(id: string, delayMs: number) {
  const s = sessions.get(id);
  if (!s || s.status !== "pending") return;
  if (s.timer) clearTimeout(s.timer);
  s.timer = setTimeout(() => {
    void runPoll(id);
  }, delayMs);
}

async function runPoll(id: string) {
  const s = sessions.get(id);
  if (!s || s.status !== "pending") return;
  if (Date.now() >= s.expires_at_ms) {
    s.status = "expired";
    s.error = "The sign-in code expired. Start again.";
    return;
  }
  try {
    const result = await pollDeviceToken(s.device_code);
    if (result.status === "complete") {
      s.status = "complete";
      s.tokens = result.tokens;
      return;
    }
    if (result.status === "denied" || result.status === "expired") {
      s.status = result.status;
      s.error = result.error;
      return;
    }
    const next = result.status === "slow_down"
      ? s.interval_ms + DEVICE_SLOW_DOWN_MS
      : s.interval_ms;
    s.interval_ms = Math.max(DEVICE_MIN_INTERVAL_MS, next);
    schedulePoll(id, s.interval_ms);
  } catch (err) {
    s.status = "denied";
    s.error = (err as Error).message;
  }
}

export async function beginDeviceSession(): Promise<DeviceSessionPublic> {
  const start = await startDeviceAuthorization();
  const id = newSessionId();
  const interval_ms = Math.max(
    DEVICE_MIN_INTERVAL_MS,
    (start.interval || 5) * 1000 || DEVICE_DEFAULT_INTERVAL_MS,
  );
  const expires_at_ms = Date.now() + (start.expires_in * 1000 || DEVICE_DEFAULT_EXPIRES_MS);
  const session: PendingSession = {
    device_code: start.device_code,
    user_code: start.user_code,
    verification_uri: start.verification_uri,
    verification_uri_complete: start.verification_uri_complete,
    interval_ms,
    expires_at_ms,
    status: "pending",
  };
  sessions.set(id, session);
  schedulePoll(id, interval_ms);
  return publicSession(id, session);
}

export function getDeviceSession(id: string): DeviceSessionPublic | null {
  const s = sessions.get(id);
  return s ? publicSession(id, s) : null;
}

export function takeCompletedTokens(id: string): XaiTokens | null {
  const s = sessions.get(id);
  if (!s || s.status !== "complete" || !s.tokens) return null;
  const tokens = s.tokens;
  cancelDeviceSession(id);
  return tokens;
}

export function cancelDeviceSession(id: string): void {
  const s = sessions.get(id);
  if (!s) return;
  if (s.timer) clearTimeout(s.timer);
  sessions.delete(id);
}
