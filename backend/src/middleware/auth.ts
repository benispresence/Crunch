import type { NextFunction, Request, Response } from "express";
import { userMustChangePassword, verifyToken, type JwtPayload } from "../services/auth.js";

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
  next();
}

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (req.user?.role !== "admin") {
    res.status(403).json({ error: "admin only" });
    return;
  }
  next();
}
