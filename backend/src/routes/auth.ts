import { Router } from "express";
import { z } from "zod";
import { createUser, findUserByEmail, signToken, verifyPassword } from "../services/auth.js";

export const authRouter = Router();

const credSchema = z.object({
  email: z.string().email(),
  password: z.string().min(6),
});

authRouter.post("/register", (req, res) => {
  const parsed = credSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  if (findUserByEmail(parsed.data.email)) {
    res.status(409).json({ error: "email already registered" });
    return;
  }
  const user = createUser(parsed.data.email, parsed.data.password);
  res.json({ token: signToken(user), user: { id: user.id, email: user.email } });
});

authRouter.post("/login", (req, res) => {
  const parsed = credSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const user = findUserByEmail(parsed.data.email);
  if (!user || !verifyPassword(user, parsed.data.password)) {
    res.status(401).json({ error: "invalid credentials" });
    return;
  }
  res.json({ token: signToken(user), user: { id: user.id, email: user.email } });
});
