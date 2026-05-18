import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { db } from "../db/index.js";
import { config } from "../config.js";

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  role: string;
  token_version?: number;
  must_change_password?: number;
}

export interface JwtPayload {
  sub: number;
  email: string;
  role: string;
  tv: number; // token version — bumped on password change for revocation
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

export function createUser(email: string, password: string): UserRow {
  const salt = crypto.randomBytes(16).toString("hex");
  const stored = `${salt}:${hashPassword(password, salt)}`;
  const existing = db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
  const role = existing.c === 0 ? "admin" : "viewer";
  const info = db
    .prepare("INSERT INTO users (email, password_hash, role) VALUES (?, ?, ?)")
    .run(email, stored, role);
  return { id: Number(info.lastInsertRowid), email, password_hash: stored, role };
}

export function findUserByEmail(email: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
}

export function findUserById(id: number): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE id = ?").get(id) as UserRow | undefined;
}

export function updatePassword(userId: number, newPassword: string): void {
  const salt = crypto.randomBytes(16).toString("hex");
  const stored = `${salt}:${hashPassword(newPassword, salt)}`;
  db.prepare(
    `UPDATE users SET
       password_hash = ?,
       must_change_password = 0,
       token_version = token_version + 1
     WHERE id = ?`,
  ).run(stored, userId);
}

export const DEFAULT_ADMIN_EMAIL = "admin@nicemeta.local";

function generateRandomPassword(): string {
  // 18 chars URL-safe base64 → ~108 bits of entropy. Easy to copy from
  // the terminal once, then immediately changed by the user.
  return crypto.randomBytes(14).toString("base64").replace(/[+/=]/g, "").slice(0, 18);
}

export function seedDefaultAdmin(): { created: boolean; email: string; password: string | null } {
  const existing = db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
  if (existing.c > 0) {
    return { created: false, email: DEFAULT_ADMIN_EMAIL, password: null };
  }
  const password = generateRandomPassword();
  const user = createUser(DEFAULT_ADMIN_EMAIL, password);
  // Flag the user so the API can require a password change before any
  // other action. Cleared by updatePassword().
  db.prepare("UPDATE users SET must_change_password = 1 WHERE id = ?").run(user.id);
  return { created: true, email: DEFAULT_ADMIN_EMAIL, password };
}

export function userMustChangePassword(userId: number): boolean {
  const row = db
    .prepare("SELECT must_change_password FROM users WHERE id = ?")
    .get(userId) as { must_change_password: number } | undefined;
  return row?.must_change_password === 1;
}

export function verifyPassword(user: UserRow, password: string): boolean {
  const [salt, hash] = user.password_hash.split(":");
  if (!salt || !hash) return false;
  const candidate = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(hash, "hex"));
}

export function signToken(user: UserRow): string {
  return jwt.sign(
    {
      sub: user.id,
      email: user.email,
      role: user.role,
      tv: user.token_version ?? 0,
    } satisfies JwtPayload,
    config.jwtSecret,
    { expiresIn: "30d" },
  );
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    const payload = jwt.verify(token, config.jwtSecret) as unknown as JwtPayload;
    // Revocation check: if the user's token_version has been bumped
    // (password change, admin reset) any older token is invalidated.
    const row = db
      .prepare("SELECT token_version FROM users WHERE id = ?")
      .get(payload.sub) as { token_version: number } | undefined;
    if (!row) return null;
    if ((payload.tv ?? 0) !== (row.token_version ?? 0)) return null;
    return payload;
  } catch {
    return null;
  }
}
