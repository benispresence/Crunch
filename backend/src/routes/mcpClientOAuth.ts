/**
 * OAuth endpoints for the outbound MCP client (Crunch as a client of an
 * external MCP server that requires OAuth 2.0).
 *
 *   POST /api/mcp-client/:id/oauth/start   — admin-only; returns the
 *        authorize URL the frontend opens in a popup.
 *   GET  /api/mcp-client/oauth/callback    — public (the browser is
 *        redirected here by the auth server); exchanges the code and
 *        returns a tiny self-closing HTML page.
 *
 * The callback is intentionally unauthenticated: it's a top-level
 * browser navigation that can't carry the SPA's bearer token. It's safe
 * because it proves nothing on its own — it only completes a flow keyed
 * by the single-use ``state`` we minted at start time.
 */

import { Router } from "express";
import { config } from "../config.js";
import { requireAdmin, requireAuth } from "../middleware/auth.js";
import { getServer } from "../services/mcpClient.js";
import { handleCallback, startAuthorization } from "../services/mcpOAuth.js";

export const mcpClientOAuthRouter = Router();

function redirectUri(): string {
  return `${config.publicBaseUrl}/api/mcp-client/oauth/callback`;
}

mcpClientOAuthRouter.post(
  "/:id/oauth/start",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    const id = Number(req.params.id);
    const server = getServer(id);
    if (!server) {
      res.status(404).json({ error: "server not found" });
      return;
    }
    if (server.auth_mode !== "oauth2") {
      res.status(400).json({ error: "server is not configured for OAuth" });
      return;
    }
    try {
      const authorize_url = await startAuthorization(id, redirectUri());
      res.json({ authorize_url });
    } catch (e) {
      res.status(502).json({ error: (e as Error).message });
    }
  },
);

function resultPage(ok: boolean, message: string): string {
  // Notify the opener (the MCP settings panel) and close the popup. If
  // there's no opener (user navigated directly), bounce to the app.
  const payload = JSON.stringify({ type: "mcp-oauth", ok, message });
  // Target the app's own origin rather than "*" so the result message
  // can only be delivered to our SPA, never a window the user was
  // tricked into opening this popup from (F8).
  const targetOrigin = JSON.stringify(config.publicBaseUrl);
  return `<!doctype html><html><head><meta charset="utf-8"><title>${
    ok ? "Connected" : "Connection failed"
  }</title><style>
    body{font-family:system-ui,sans-serif;background:#1a1815;color:#f5f1ec;
      display:grid;place-items:center;height:100vh;margin:0}
    .card{text-align:center;max-width:420px;padding:24px}
    .ok{color:#7fb069}.err{color:#e07a5f}
    code{font-family:ui-monospace,monospace;font-size:12px;color:#a8a098}
  </style></head><body><div class="card">
    <h2 class="${ok ? "ok" : "err"}">${ok ? "✓ Connected" : "✗ Connection failed"}</h2>
    <p>${ok ? "You can close this window and return to Crunch." : "<code>" + message.replace(/[<>&]/g, "") + "</code>"}</p>
  </div><script>
    try { if (window.opener) window.opener.postMessage(${payload}, ${targetOrigin}); } catch (e) {}
    if (${ok ? "true" : "false"}) { setTimeout(function(){ try{window.close();}catch(e){} }, 800); }
  </script></body></html>`;
}

mcpClientOAuthRouter.get("/oauth/callback", async (req, res) => {
  const error = typeof req.query.error === "string" ? req.query.error : "";
  const code = typeof req.query.code === "string" ? req.query.code : "";
  const state = typeof req.query.state === "string" ? req.query.state : "";

  if (error) {
    res.status(400).type("html").send(resultPage(false, `authorization denied: ${error}`));
    return;
  }
  if (!code || !state) {
    res.status(400).type("html").send(resultPage(false, "missing code or state"));
    return;
  }
  try {
    await handleCallback(code, state);
    res.type("html").send(resultPage(true, "connected"));
  } catch (e) {
    res.status(502).type("html").send(resultPage(false, (e as Error).message));
  }
});
