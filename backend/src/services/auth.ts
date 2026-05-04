import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { db } from "../db/index.js";
import { config } from "../config.js";

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
  role: string;
}

export interface JwtPayload {
  sub: number;
  email: string;
  role: string;
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
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(stored, userId);
}

export const DEFAULT_ADMIN_EMAIL = "admin@nicemeta.local";
export const DEFAULT_ADMIN_PASSWORD = "admin";

export function seedDefaultAdmin(): { created: boolean; email: string; password: string } {
  const existing = db.prepare("SELECT COUNT(*) as c FROM users").get() as { c: number };
  if (existing.c > 0) {
    return { created: false, email: DEFAULT_ADMIN_EMAIL, password: DEFAULT_ADMIN_PASSWORD };
  }
  createUser(DEFAULT_ADMIN_EMAIL, DEFAULT_ADMIN_PASSWORD);
  return { created: true, email: DEFAULT_ADMIN_EMAIL, password: DEFAULT_ADMIN_PASSWORD };
}

export function verifyPassword(user: UserRow, password: string): boolean {
  const [salt, hash] = user.password_hash.split(":");
  if (!salt || !hash) return false;
  const candidate = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(hash, "hex"));
}

export function signToken(user: UserRow): string {
  return jwt.sign(
    { sub: user.id, email: user.email, role: user.role } satisfies JwtPayload,
    config.jwtSecret,
    { expiresIn: "30d" },
  );
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as unknown as JwtPayload;
  } catch {
    return null;
  }
}
