/**
 * Outbound MCP client: Crunch talks to external MCP servers and the
 * chat agent can call their tools alongside the built-ins.
 *
 * Each row in ``mcp_servers`` is one connection. Auth headers are
 * encrypted at rest using the same crypto module as connection
 * passwords. The chat route fetches enabled servers, lists their
 * tools (with a per-server name prefix so they don't collide with
 * our own), and dispatches `tools/call` to whichever server owns the
 * call.
 */

import { request } from "undici";
import { db } from "../db/index.js";
import {
  decryptString,
  encryptString,
  isEncrypted,
} from "./crypto.js";

export interface McpServerRow {
  id: number;
  name: string;
  url: string;
  transport: string;
  auth_header_name: string | null;
  auth_header_value: string | null; // encrypted
  enabled: number;
  allowed_tools: string;             // JSON array (empty = all)
  last_handshake_at: number | null;
  last_error: string | null;
  cached_tools_json: string;
  created_at: number;
  updated_at: number;
  // OAuth 2.0 mode (auth_mode='oauth2'). All nullable; absent on
  // static-header rows. Token/secret columns are encrypted at rest.
  auth_mode: string;                          // 'header' | 'oauth2'
  oauth_issuer: string | null;
  oauth_client_id: string | null;
  oauth_client_secret: string | null;         // encrypted
  oauth_scope: string | null;
  oauth_token_endpoint: string | null;
  oauth_authorization_endpoint: string | null;
  oauth_registration_access_token: string | null; // encrypted
  oauth_access_token: string | null;          // encrypted
  oauth_refresh_token: string | null;         // encrypted
  oauth_expires_at: number | null;            // epoch seconds
  oauth_resource: string | null;
}

// The MCP protocol revision we negotiate. Sent on initialize and echoed
// as the MCP-Protocol-Version header on every subsequent HTTP request
// per the streamable-HTTP transport spec.
const MCP_PROTOCOL_VERSION = "2024-11-05";

// Streamable-HTTP servers (Metabase included) hand back an
// ``Mcp-Session-Id`` on initialize and expect it echoed on later calls.
// Kept in memory, keyed by server id — a fresh handshake re-establishes
// it, so losing it on restart is harmless.
const sessionByServer = new Map<number, string>();

export interface McpToolMeta {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

const PREFIX_DELIM = "__mcp__";

/** Tool names crossing the trust boundary get a per-server prefix
 *  (``mcp__<server>__<tool>``) so multiple remote MCP servers can
 *  expose tools called ``query`` without clashing with each other
 *  or with our built-ins. */
export function prefixedToolName(serverName: string, toolName: string): string {
  return `mcp${PREFIX_DELIM}${serverName}${PREFIX_DELIM}${toolName}`;
}

export function splitPrefixedTool(name: string): { server: string; tool: string } | null {
  if (!name.startsWith(`mcp${PREFIX_DELIM}`)) return null;
  const rest = name.slice(`mcp${PREFIX_DELIM}`.length);
  const idx = rest.indexOf(PREFIX_DELIM);
  if (idx < 0) return null;
  return { server: rest.slice(0, idx), tool: rest.slice(idx + PREFIX_DELIM.length) };
}

function decryptHeaderValue(row: McpServerRow): string | null {
  if (!row.auth_header_value) return null;
  return isEncrypted(row.auth_header_value)
    ? decryptString(row.auth_header_value)
    : row.auth_header_value;
}

/**
 * Build request headers for a server. Static-header servers get their
 * single configured header; OAuth servers get a fresh Bearer token
 * (auto-refreshed when near expiry). Either way we advertise that we
 * accept both JSON and SSE responses and pin the negotiated protocol
 * version, as the streamable-HTTP transport requires.
 *
 * ``forceRefresh`` is set on the 401 retry path so a revoked/expired
 * access token is replaced before the second attempt.
 */
async function requestHeaders(
  row: McpServerRow,
  forceRefresh = false,
): Promise<Record<string, string>> {
  const out: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "MCP-Protocol-Version": MCP_PROTOCOL_VERSION,
  };
  if (row.auth_mode === "oauth2") {
    // Dynamic import breaks the mcpClient <-> mcpOAuth import cycle.
    const { getValidAccessToken } = await import("./mcpOAuth.js");
    const token = await getValidAccessToken(row, { force: forceRefresh });
    out["authorization"] = `Bearer ${token}`;
  } else {
    const value = decryptHeaderValue(row);
    if (row.auth_header_name && value) out[row.auth_header_name] = value;
  }
  return out;
}

/** Pull the JSON-RPC payload out of an SSE body — one or more
 *  ``data:`` lines, the last of which carries the response object. */
function parseSsePayload(text: string): unknown {
  const datas: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) datas.push(line.slice(5).trim());
  }
  const joined = datas.join("\n").trim();
  if (!joined) throw new Error("empty SSE response");
  return JSON.parse(joined);
}

/** True when a JSON-RPC error (or its data) indicates the bearer token
 *  is missing/expired and we should re-auth before retrying. */
function isAuthError(err: { code?: number; message?: string } | undefined): boolean {
  if (!err) return false;
  const msg = (err.message ?? "").toLowerCase();
  return (
    err.code === -32603 &&
    (msg.includes("auth") || msg.includes("unauthor") || msg.includes("token"))
  );
}

function parseJsonArr(s: string): string[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v.map((x) => String(x)) : [];
  } catch {
    return [];
  }
}

// ---------- CRUD ---------------------------------------------------

export function listServers(): McpServerRow[] {
  return db
    .prepare("SELECT * FROM mcp_servers ORDER BY enabled DESC, name ASC")
    .all() as McpServerRow[];
}

export function getServer(id: number): McpServerRow | null {
  return (
    (db.prepare("SELECT * FROM mcp_servers WHERE id = ?").get(id) as
      | McpServerRow
      | undefined) ?? null
  );
}

export interface UpsertServerInput {
  id?: number;
  name: string;
  url: string;
  transport?: string;
  auth_header_name?: string | null;
  auth_header_value?: string | null;
  enabled?: boolean;
  allowed_tools?: string[];
  // OAuth config (set by the user). Tokens / client_id / endpoints are
  // managed by mcpOAuth and never written through this path.
  auth_mode?: "header" | "oauth2";
  oauth_issuer?: string | null;
  oauth_scope?: string | null;
  oauth_resource?: string | null;
}

export function upsertServer(input: UpsertServerInput): McpServerRow {
  // Don't force the admin to re-paste the secret on every edit.
  // Empty / "********" leaves the previous value alone; anything
  // else is freshly encrypted.
  let storedHeader: string | null = null;
  if (input.id != null) {
    const prior = getServer(input.id);
    if (prior) storedHeader = prior.auth_header_value;
  }
  const incoming = input.auth_header_value;
  if (incoming != null && incoming !== "" && incoming !== "********") {
    storedHeader = isEncrypted(incoming) ? incoming : encryptString(incoming);
  }

  const authMode = input.auth_mode ?? "header";
  // For OAuth servers the resource indicator (RFC 8707) defaults to the
  // MCP URL itself when the caller doesn't pin one explicitly.
  const oauthResource =
    authMode === "oauth2"
      ? (input.oauth_resource?.trim() || input.url.trim())
      : null;

  if (input.id != null) {
    db.prepare(
      `UPDATE mcp_servers SET
         name = ?, url = ?, transport = ?,
         auth_header_name = ?, auth_header_value = ?,
         enabled = ?, allowed_tools = ?,
         auth_mode = ?, oauth_issuer = ?, oauth_scope = ?, oauth_resource = ?,
         updated_at = strftime('%s', 'now')
       WHERE id = ?`,
    ).run(
      input.name.trim(),
      input.url.trim(),
      input.transport ?? "http",
      input.auth_header_name ?? null,
      storedHeader,
      input.enabled === false ? 0 : 1,
      JSON.stringify(input.allowed_tools ?? []),
      authMode,
      input.oauth_issuer?.trim() || null,
      input.oauth_scope?.trim() || null,
      oauthResource,
      input.id,
    );
    return getServer(input.id)!;
  }
  const info = db
    .prepare(
      `INSERT INTO mcp_servers (
         name, url, transport, auth_header_name, auth_header_value,
         enabled, allowed_tools,
         auth_mode, oauth_issuer, oauth_scope, oauth_resource
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.name.trim(),
      input.url.trim(),
      input.transport ?? "http",
      input.auth_header_name ?? null,
      storedHeader,
      input.enabled === false ? 0 : 1,
      JSON.stringify(input.allowed_tools ?? []),
      authMode,
      input.oauth_issuer?.trim() || null,
      input.oauth_scope?.trim() || null,
      oauthResource,
    );
  return getServer(Number(info.lastInsertRowid))!;
}

export function deleteServer(id: number): boolean {
  const r = db.prepare("DELETE FROM mcp_servers WHERE id = ?").run(id);
  return r.changes > 0;
}

/** Strip the encrypted auth value for display + replace with the
 *  ``********`` placeholder the upsert path treats as "keep prior". */
export function serverForDisplay(row: McpServerRow) {
  return {
    id: row.id,
    name: row.name,
    url: row.url,
    transport: row.transport,
    auth_header_name: row.auth_header_name,
    auth_header_value: row.auth_header_value ? "********" : null,
    enabled: !!row.enabled,
    allowed_tools: parseJsonArr(row.allowed_tools),
    last_handshake_at: row.last_handshake_at,
    last_error: row.last_error,
    cached_tools: (() => {
      try { return JSON.parse(row.cached_tools_json) as McpToolMeta[]; }
      catch { return []; }
    })(),
    updated_at: row.updated_at,
    // OAuth status — config + connection state only. Tokens, client
    // secret and the registration token are NEVER returned.
    auth_mode: row.auth_mode ?? "header",
    oauth_issuer: row.oauth_issuer,
    oauth_scope: row.oauth_scope,
    oauth_resource: row.oauth_resource,
    oauth_client_id: row.oauth_client_id,
    oauth_connected: !!row.oauth_access_token,
    oauth_expires_at: row.oauth_expires_at,
  };
}

// ---------- Wire calls --------------------------------------------

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: unknown;
  result?: unknown;
  error?: { code: number; message: string };
}

async function callRemote(
  row: McpServerRow,
  method: string,
  params: Record<string, unknown> = {},
  attempt = 0,
): Promise<unknown> {
  const headers = await requestHeaders(row, attempt > 0);
  const sid = sessionByServer.get(row.id);
  if (sid) headers["mcp-session-id"] = sid;

  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: `crunch-${Date.now()}`,
    method,
    params,
  });
  const { statusCode, headers: respHeaders, body: respBody } = await request(row.url, {
    method: "POST",
    headers,
    body,
  });
  // Capture (or refresh) the session id the server hands us.
  const newSid = respHeaders["mcp-session-id"];
  if (typeof newSid === "string" && newSid) sessionByServer.set(row.id, newSid);

  const text = await respBody.text();

  // Token revoked/expired: drop the session and retry once with a
  // force-refreshed bearer (OAuth servers only).
  if (statusCode === 401 && row.auth_mode === "oauth2" && attempt === 0) {
    sessionByServer.delete(row.id);
    return callRemote(getServer(row.id) ?? row, method, params, attempt + 1);
  }
  if (statusCode >= 400) {
    throw new Error(
      `MCP server '${row.name}' returned ${statusCode}: ${text.slice(0, 200)}`,
    );
  }

  const ct = String(respHeaders["content-type"] ?? "");
  let parsed: JsonRpcResponse;
  try {
    parsed = (
      ct.includes("text/event-stream") ? parseSsePayload(text) : JSON.parse(text)
    ) as JsonRpcResponse;
  } catch {
    throw new Error(
      `MCP server '${row.name}' returned non-JSON: ${text.slice(0, 200)}`,
    );
  }
  if (parsed.error) {
    if (row.auth_mode === "oauth2" && attempt === 0 && isAuthError(parsed.error)) {
      sessionByServer.delete(row.id);
      return callRemote(getServer(row.id) ?? row, method, params, attempt + 1);
    }
    throw new Error(`MCP server '${row.name}' error: ${parsed.error.message}`);
  }
  return parsed.result;
}

/** Fire-and-forget JSON-RPC notification (no id, no result expected).
 *  Used to send ``notifications/initialized`` after the handshake. */
async function notifyRemote(
  row: McpServerRow,
  method: string,
  params: Record<string, unknown> = {},
): Promise<void> {
  const headers = await requestHeaders(row);
  const sid = sessionByServer.get(row.id);
  if (sid) headers["mcp-session-id"] = sid;
  try {
    const { body: respBody } = await request(row.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", method, params }),
    });
    // Drain the (typically empty / 202) body so the socket is released.
    await respBody.text();
  } catch {
    // A server that rejects the notification still completed initialize;
    // tool discovery below will surface any real problem.
  }
}

/** Handshake + tool discovery. Caches the result on the row so the
 *  chat agent doesn't pay this latency on every send. */
export async function refreshServer(id: number): Promise<{ ok: true; tools: McpToolMeta[] } | { ok: false; error: string }> {
  const row = getServer(id);
  if (!row) return { ok: false, error: "server not found" };
  try {
    // Start a clean handshake — discard any stale session id first so the
    // server issues a fresh one on this initialize.
    sessionByServer.delete(id);
    await callRemote(row, "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      clientInfo: { name: "crunch", version: "1.0.0" },
      capabilities: {},
    });
    // Per the MCP lifecycle, the client must confirm the handshake with a
    // notifications/initialized before issuing requests.
    await notifyRemote(row, "notifications/initialized");
    const tools = (await callRemote(row, "tools/list")) as { tools?: McpToolMeta[] };
    const list = tools.tools ?? [];
    db.prepare(
      `UPDATE mcp_servers SET
         cached_tools_json = ?, last_handshake_at = strftime('%s','now'),
         last_error = NULL
       WHERE id = ?`,
    ).run(JSON.stringify(list), id);
    return { ok: true, tools: list };
  } catch (e) {
    const msg = (e as Error).message;
    db.prepare(
      "UPDATE mcp_servers SET last_error = ? WHERE id = ?",
    ).run(msg, id);
    return { ok: false, error: msg };
  }
}

/** Aggregated tool list across every enabled outbound server. Each
 *  tool name is prefixed; the descriptions include the server name
 *  so the chat agent can pick. */
export interface ExternalTool {
  prefixed_name: string;
  description: string;
  input_schema: Record<string, unknown>;
  server_id: number;
  server_name: string;
  original_name: string;
}

export function listExternalTools(): ExternalTool[] {
  const out: ExternalTool[] = [];
  for (const row of listServers()) {
    if (!row.enabled) continue;
    const allowed = new Set(parseJsonArr(row.allowed_tools));
    let cached: McpToolMeta[] = [];
    try {
      cached = JSON.parse(row.cached_tools_json) as McpToolMeta[];
    } catch {
      /* skip */
    }
    for (const t of cached) {
      if (allowed.size > 0 && !allowed.has(t.name)) continue;
      out.push({
        prefixed_name: prefixedToolName(row.name, t.name),
        description: `[${row.name}] ${t.description ?? ""}`.trim(),
        input_schema: t.inputSchema ?? { type: "object", properties: {} },
        server_id: row.id,
        server_name: row.name,
        original_name: t.name,
      });
    }
  }
  return out;
}

/** Invoke an external MCP tool by its prefixed name. Used by the
 *  chat route's tool dispatcher. */
export async function callExternalTool(
  prefixedName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const split = splitPrefixedTool(prefixedName);
  if (!split) throw new Error(`not an MCP-prefixed tool name: ${prefixedName}`);
  const row = db
    .prepare("SELECT * FROM mcp_servers WHERE name = ?")
    .get(split.server) as McpServerRow | undefined;
  if (!row) throw new Error(`MCP server '${split.server}' not found`);
  if (!row.enabled) throw new Error(`MCP server '${split.server}' is disabled`);
  // Streamable-HTTP servers track a session established at initialize.
  // If we don't hold one for this server (e.g. the backend restarted
  // since the last "Discover tools"), handshake first so the tool call
  // lands on a live session. Scoped to OAuth servers to leave the
  // existing static-header path byte-for-byte unchanged.
  if (row.auth_mode === "oauth2" && !sessionByServer.has(row.id)) {
    await callRemote(row, "initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      clientInfo: { name: "crunch", version: "1.0.0" },
      capabilities: {},
    });
    await notifyRemote(row, "notifications/initialized");
  }
  return await callRemote(row, "tools/call", {
    name: split.tool, arguments: args,
  });
}
