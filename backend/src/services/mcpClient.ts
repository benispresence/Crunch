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
}

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

function authHeaders(row: McpServerRow): Record<string, string> {
  const out: Record<string, string> = { "content-type": "application/json" };
  const value = decryptHeaderValue(row);
  if (row.auth_header_name && value) out[row.auth_header_name] = value;
  return out;
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

  if (input.id != null) {
    db.prepare(
      `UPDATE mcp_servers SET
         name = ?, url = ?, transport = ?,
         auth_header_name = ?, auth_header_value = ?,
         enabled = ?, allowed_tools = ?,
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
      input.id,
    );
    return getServer(input.id)!;
  }
  const info = db
    .prepare(
      `INSERT INTO mcp_servers (
         name, url, transport, auth_header_name, auth_header_value,
         enabled, allowed_tools
       ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.name.trim(),
      input.url.trim(),
      input.transport ?? "http",
      input.auth_header_name ?? null,
      storedHeader,
      input.enabled === false ? 0 : 1,
      JSON.stringify(input.allowed_tools ?? []),
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
): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: `crunch-${Date.now()}`,
    method,
    params,
  });
  const { statusCode, body: respBody } = await request(row.url, {
    method: "POST",
    headers: authHeaders(row),
    body,
  });
  const text = await respBody.text();
  if (statusCode >= 400) {
    throw new Error(
      `MCP server '${row.name}' returned ${statusCode}: ${text.slice(0, 200)}`,
    );
  }
  let parsed: JsonRpcResponse;
  try {
    parsed = JSON.parse(text) as JsonRpcResponse;
  } catch {
    throw new Error(
      `MCP server '${row.name}' returned non-JSON: ${text.slice(0, 200)}`,
    );
  }
  if (parsed.error) {
    throw new Error(
      `MCP server '${row.name}' error: ${parsed.error.message}`,
    );
  }
  return parsed.result;
}

/** Handshake + tool discovery. Caches the result on the row so the
 *  chat agent doesn't pay this latency on every send. */
export async function refreshServer(id: number): Promise<{ ok: true; tools: McpToolMeta[] } | { ok: false; error: string }> {
  const row = getServer(id);
  if (!row) return { ok: false, error: "server not found" };
  try {
    await callRemote(row, "initialize", {
      protocolVersion: "2024-11-05",
      clientInfo: { name: "crunch", version: "1.0.0" },
      capabilities: {},
    });
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
  return await callRemote(row, "tools/call", {
    name: split.tool, arguments: args,
  });
}
