import { Router } from "express";
import { z } from "zod";
import {
  createUser,
  findUserByEmail,
  findUserById,
  signToken,
  updatePassword,
  verifyPassword,
} from "../services/auth.js";
import { isPublicRegistrationEnabled } from "../services/settings.js";
import { requireAuth } from "../middleware/auth.js";

export const authRouter = Router();

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
// to show the Register tab, with no auth needed.
authRouter.get("/config", (_req, res) => {
  res.json({ registration_enabled: isPublicRegistrationEnabled() });
});

authRouter.post("/register", (req, res) => {
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

authRouter.post("/login", (req, res) => {
  const parsed = loginSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const user = findUserByEmail(parsed.data.email);
  if (!user || !verifyPassword(user, parsed.data.password)) {
    res.status(401).json({ error: "invalid credentials" });
    return;
  }
  res.json({
    token: signToken(user),
    user: { id: user.id, email: user.email, role: user.role },
  });
});

authRouter.post("/change-password", requireAuth, (req, res) => {
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
