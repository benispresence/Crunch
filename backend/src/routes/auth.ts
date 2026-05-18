import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { db } from "../db/index.js";
import {
  createUser,
  findUserByEmail,
  findUserById,
  signToken,
  updatePassword,
  userMustChangePassword,
  verifyPassword,
} from "../services/auth.js";
import { isPublicRegistrationEnabled } from "../services/settings.js";
import { requireAuth } from "../middleware/auth.js";

export const authRouter = Router();

// 10 attempts per 15-minute window per IP. login + register share the
// same bucket so credential stuffing can't sidestep by alternating.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { error: "Too many auth attempts, try again later." },
  // Successful logins don't count toward the limit — only failures do.
  skipSuccessfulRequests: true,
});

const registerSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const changePasswordSchema = z.object({
  current_password: z.string().min(1),
  new_password: z.string().min(6),
});

// Public bootstrap info — the login page reads this to decide whether
// to show the Register tab and the first-run hint, with no auth needed.
authRouter.get("/config", (_req, res) => {
  // Has the default admin account already changed its password? If yes
  // we hide the "First launch?" hint so we don't display stale advice.
  const row = db
    .prepare(
      "SELECT must_change_password FROM users WHERE email = ?",
    )
    .get("admin@nicemeta.local") as { must_change_password: number } | undefined;
  res.json({
    registration_enabled: isPublicRegistrationEnabled(),
    default_admin_pending: !!row && row.must_change_password === 1,
  });
});

authRouter.post("/register", authLimiter, (req, res) => {
  if (!isPublicRegistrationEnabled()) {
    res.status(403).json({
      error: "Self-registration is disabled. Ask an admin to provision an account.",
    });
    return;
  }
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (findUserByEmail(parsed.data.email)) {
    res.status(409).json({ error: "email already registered" });
    return;
  }
  const user = createUser(parsed.data.email, parsed.data.password);
  res.json({
    token: signToken(user),
    user: { id: user.id, email: user.email, role: user.role },
  });
});

authRouter.post("/login", authLimiter, (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const user = findUserByEmail(parsed.data.email);
  if (!user || !verifyPassword(user, parsed.data.password)) {
    // Log failures so the operator can spot brute force attempts in
    // the request log. Never log the password itself.
    console.warn(
      `[auth] failed login for "${parsed.data.email}" from ${req.ip ?? "?"}`,
    );
    res.status(401).json({ error: "invalid credentials" });
    return;
  }
  res.json({
    token: signToken(user),
    user: {
      id: user.id, email: user.email, role: user.role,
      must_change_password: userMustChangePassword(user.id),
    },
  });
});

authRouter.post("/change-password", requireAuth, authLimiter, (req, res) => {
  const parsed = changePasswordSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const user = findUserById(req.user!.sub);
  if (!user || !verifyPassword(user, parsed.data.current_password)) {
    res.status(401).json({ error: "current password incorrect" });
    return;
  }
  updatePassword(user.id, parsed.data.new_password);
  res.json({ ok: true });
});
