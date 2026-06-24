import type { NextFunction, Request, Response } from "express";
import { userMustChangePassword, verifyToken, type JwtPayload } from "../services/auth.js";
import { findUserByApiKey } from "../services/authProviders.js";
import {
  effectivePermissions,
  hasPermission,
  type CapabilityName,
} from "../services/permissions.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: JwtPayload;
    /** Scopes the bearer token allows. ``null`` for JWT (use full
     *  user permissions); a Set for API keys (intersection of the
     *  key's stored scopes + the owner's permissions). */
    bearerScopes?: Set<CapabilityName> | null;
  }
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) {
    res.status(401).json({ error: "missing token" });
    return;
  }
  // Bearer tokens come in two flavours:
  //  - JWTs from a normal login/SSO sign-in.
  //  - API keys (`crunch_pk_…`) issued via Admin → Authentication.
  // We try the API-key path first so we never accidentally validate
  // an api-key string against the JWT verifier (different shape, same
  // header).
  if (token.startsWith("crunch_pk_")) {
    const apiUser = findUserByApiKey(token);
    if (!apiUser) {
      res.status(401).json({ error: "invalid api key" });
      return;
    }
    req.user = {
      sub: apiUser.id, email: apiUser.email,
      role: apiUser.role, tv: apiUser.token_version,
    };
    // API keys carry a (possibly empty) scope list. Empty = inherit
    // all of the owner's permissions; non-empty = intersection with
    // owner's. Never wider than the owner — see permissions.ts.
    req.bearerScopes = effectivePermissions(apiUser.id, apiUser.scopes);
    next();
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: "invalid token" });
    return;
  }
  // Force the bootstrap-password decision: the user must either change
  // it or explicitly keep it. Both endpoints clear the must-change flag.
  if (
    userMustChangePassword(payload.sub)
    && req.path !== "/change-password"
    && req.path !== "/keep-default-password"
  ) {
    res.status(403).json({ error: "password_change_required" });
    return;
  }
  req.user = payload;
  // JWT bearers get the full user permission set — no scope narrowing.
  req.bearerScopes = null;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "admin only" });
    return;
  }
  next();
}

/**
 * Gate a route on a capability flag. Combines the user's effective
 * permissions (from groups) with the bearer token's scopes (from the
 * API key, if any). A capability passes only when *both* sides say
 * yes — keys never grant more than the owner has.
 *
 * Stack this *after* `requireAuth`. Returns 403 + the missing
 * capability name in the response body so the UI can render a
 * useful message.
 */
export function requirePermission(cap: CapabilityName) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const uid = req.user?.sub;
    if (uid == null) {
      res.status(401).json({ error: "not authenticated" });
      return;
    }
    if (!hasPermission(uid, cap)) {
      res.status(403).json({ error: "permission_denied", capability: cap });
      return;
    }
    if (req.bearerScopes && !req.bearerScopes.has(cap)) {
      res
        .status(403)
        .json({ error: "permission_denied_by_token", capability: cap });
      return;
    }
    next();
  };
}
