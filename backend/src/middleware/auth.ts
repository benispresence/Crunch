import type { NextFunction, Request, Response } from "express";
import { userMustChangePassword, verifyToken, type JwtPayload } from "../services/auth.js";
import { findUserByApiKey } from "../services/authProviders.js";

declare module "express-serve-static-core" {
  interface Request {
    user?: JwtPayload;
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
    next();
    return;
  }
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: "invalid token" });
    return;
  }
  // Force password change before allowing access to anything besides the
  // change-password endpoint itself.
  if (
    userMustChangePassword(payload.sub)
    && req.path !== "/change-password"
  ) {
    res.status(403).json({ error: "password_change_required" });
    return;
  }
  req.user = payload;
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "admin only" });
    return;
  }
  next();
}
