/**
 * MCP (Model Context Protocol) server endpoint.
 *
 * Lets external clients (Claude Desktop, headless agents) drive
 * Crunch over a JSON-RPC channel. We expose the same tool definitions
 * the chat agent uses internally, gated by:
 *
 *   1. **API-key auth** — Bearer token (`crunch_pk_…`) issued in
 *      Admin → Authentication. The token resolves to a user.
 *   2. **The key's scope list** — set at issue time, narrows the
 *      user's full permission set.
 *   3. **Admin-configured allowed tools** — a Settings entry holds
 *      the JSON list of tool names this Crunch instance is willing
 *      to expose over MCP. Empty = none (default; admin opts in).
 *   4. **The ``mcp.use`` capability** — the user (and key) must have
 *      it to call any MCP method.
 *
 * Method coverage today: initialize, tools/list, tools/call. Enough
 * to be a useful read+write surface; resources/prompts arrive later.
 */

import { Router } from "express";
import { z } from "zod";
import { requireAuth, requirePermission } from "../middleware/auth.js";
import { chatTools, runTool } from "../services/chatTools.js";
import { getSetting, setSetting } from "../services/settings.js";

export const mcpRouter = Router();

// Auth check first: must be a valid bearer token and the caller must
// carry mcp.use. We deliberately put requirePermission inside the
// router (not at mount-time) so the JSON-RPC error envelopes still
// come out cleanly when the gate fails.
mcpRouter.use(requireAuth, requirePermission("mcp.use"));

const MCP_PROTOCOL_VERSION = "2024-11-05";
const SERVER_INFO = { name: "crunch-mcp", version: "1.0.0" };

/** Admin-controlled allowlist of tool names exposed via MCP. Set
 *  via Admin → MCP. Stored as JSON in the settings table.  */
function allowedToolNames(): Set<string> {
  const raw = getSetting("mcp_exposed_tools") || "[]";
  try {
    const v = JSON.parse(raw);
    return new Set(Array.isArray(v) ? v.map((x) => String(x)) : []);
  } catch {
    return new Set();
  }
}

export function listAllowedToolNames(): string[] {
  return [...allowedToolNames()];
}

export function setAllowedToolNames(names: string[]): void {
  const validated = names.filter((n) => chatTools.some((t) => t.name === n));
  setSetting("mcp_exposed_tools", JSON.stringify(validated));
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

interface JsonRpcSuccess {
  jsonrpc: "2.0";
  id: string | number | null;
  result: unknown;
}

interface JsonRpcError {
  jsonrpc: "2.0";
  id: string | number | null;
  error: { code: number; message: string; data?: unknown };
}

type JsonRpcResponse = JsonRpcSuccess | JsonRpcError;

function err(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcError {
  return { jsonrpc: "2.0", id, error: { code, message, ...(data ? { data } : {}) } };
}

const rpcRequest = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string(), z.number(), z.null()]).optional(),
  method: z.string(),
  params: z.record(z.unknown()).optional(),
});

mcpRouter.post("/", async (req, res) => {
  const parsed = rpcRequest.safeParse(req.body);
  if (!parsed.success) {
    res.json(err(null, -32600, `invalid request: ${parsed.error.message}`));
    return;
  }
  const { id = null, method, params } = parsed.data as JsonRpcRequest;
  try {
    const result = await handleMethod(method, params ?? {}, req.user!.sub);
    const ok: JsonRpcSuccess = { jsonrpc: "2.0", id, result };
    res.json(ok satisfies JsonRpcResponse);
  } catch (e) {
    const message = (e as Error).message;
    // Normalise our own "method not found" / "tool not allowed"
    // errors to JSON-RPC canonical codes so MCP clients render them
    // correctly.
    const code =
      message.startsWith("METHOD_NOT_FOUND:") ? -32601
      : message.startsWith("INVALID_PARAMS:") ? -32602
      : -32000;  // generic application error
    res.json(err(id, code, message.replace(/^[A-Z_]+:\s*/, "")));
  }
});

async function handleMethod(
  method: string,
  params: Record<string, unknown>,
  userId: number,
): Promise<unknown> {
  switch (method) {
    case "initialize":
      return {
        protocolVersion: MCP_PROTOCOL_VERSION,
        serverInfo: SERVER_INFO,
        capabilities: { tools: {} },
      };

    case "tools/list": {
      const allowed = allowedToolNames();
      return {
        tools: chatTools
          .filter((t) => allowed.has(t.name))
          .map((t) => ({
            name: t.name,
            description: t.description,
            inputSchema: t.input_schema,
          })),
      };
    }

    case "tools/call": {
      const name = (params.name as string | undefined) ?? "";
      const args = (params.arguments as Record<string, unknown> | undefined) ?? {};
      const allowed = allowedToolNames();
      if (!allowed.has(name)) {
        throw new Error(
          `METHOD_NOT_FOUND: tool '${name}' is not exposed over MCP on this instance`,
        );
      }
      const result = await runTool({ userId }, name, args);
      // MCP tools/call returns content blocks. Wrap whatever the
      // tool returned in a text block — clients render it without
      // having to know our internal shape.
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
        isError:
          result && typeof result === "object"
          && (result as { success?: boolean }).success === false,
      };
    }

    case "ping":
      return {};

    default:
      throw new Error(`METHOD_NOT_FOUND: unknown method '${method}'`);
  }
}
