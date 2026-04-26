import crypto from "node:crypto";
import jwt from "jsonwebtoken";
import { db } from "../db/index.js";
import { config } from "../config.js";

export interface UserRow {
  id: number;
  email: string;
  password_hash: string;
}

export interface JwtPayload {
  sub: number;
  email: string;
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString("hex");
}

export function createUser(email: string, password: string): UserRow {
  const salt = crypto.randomBytes(16).toString("hex");
  const stored = `${salt}:${hashPassword(password, salt)}`;
  const info = db
    .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
    .run(email, stored);
  return { id: Number(info.lastInsertRowid), email, password_hash: stored };
}

export function findUserByEmail(email: string): UserRow | undefined {
  return db.prepare("SELECT * FROM users WHERE email = ?").get(email) as UserRow | undefined;
}

export function verifyPassword(user: UserRow, password: string): boolean {
  const [salt, hash] = user.password_hash.split(":");
  if (!salt || !hash) return false;
  const candidate = hashPassword(password, salt);
  return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(hash, "hex"));
}

export function signToken(user: UserRow): string {
  return jwt.sign({ sub: user.id, email: user.email } satisfies JwtPayload, config.jwtSecret, {
    expiresIn: "30d",
  });
}

export function verifyToken(token: string): JwtPayload | null {
  try {
    return jwt.verify(token, config.jwtSecret) as unknown as JwtPayload;
  } catch {
    return null;
  }
}
