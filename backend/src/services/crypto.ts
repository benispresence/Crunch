/**
 * AES-256-GCM at-rest encryption for sensitive strings (connection
 * passwords, third-party API keys). The key comes from the DATA_KEY
 * env var; in dev, if DATA_KEY is not provided, we derive a stable
 * fallback so existing local installs keep working.
 *
 * Wire format: `enc:v1:<base64(iv|tag|ciphertext)>`. The `enc:v1:`
 * prefix lets us detect already-encrypted values and migrate old
 * plaintext values on first read.
 */

import crypto from "node:crypto";
import { config } from "../config.js";

const PREFIX = "enc:v1:";
const ALG = "aes-256-gcm";

function getKey(): Buffer {
  if (config.dataKey) {
    // Operator-provided. Accept hex (64 chars) or base64.
    const k = config.dataKey;
    if (/^[0-9a-fA-F]{64}$/.test(k)) return Buffer.from(k, "hex");
    const b = Buffer.from(k, "base64");
    if (b.length === 32) return b;
    // Last-resort: scrypt-derive 32 bytes from whatever was given.
    return crypto.scryptSync(k, "crunch-data-key", 32);
  }
  if (!config.isDev) {
    throw new Error("DATA_KEY required in production");
  }
  // Dev fallback: derive from the JWT secret so the same dev DB keeps
  // working across restarts. NEVER do this in prod (and we don't —
  // the production boot check above forbids it).
  return crypto.scryptSync(config.jwtSecret, "crunch-dev-data-key", 32);
}

let cachedKey: Buffer | null = null;
function key(): Buffer {
  if (!cachedKey) cachedKey = getKey();
  return cachedKey;
}

export function isEncrypted(value: string | null | undefined): boolean {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function encryptString(plaintext: string): string {
  if (!plaintext) return "";
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALG, key(), iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([iv, tag, ct]).toString("base64");
}

export function decryptString(value: string): string {
  if (!isEncrypted(value)) return value; // treat as plaintext (legacy)
  const raw = Buffer.from(value.slice(PREFIX.length), "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const ct = raw.subarray(28);
  const decipher = crypto.createDecipheriv(ALG, key(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}

/**
 * Walk a connection-config object and encrypt sensitive fields in place.
 * Other fields (host, port, database, user, options) stay plaintext.
 */
const SENSITIVE_CONFIG_KEYS = new Set(["password", "passphrase", "secret"]);

// Sentinel returned by maskConnectionConfig for a secret that is set.
// The edit form sends it back unchanged when the user didn't retype the
// secret, which is our cue to keep the stored value.
export const SECRET_MASK = "••••••";

/**
 * Merge an incoming (edit-form) config with the stored, still-encrypted
 * config: any sensitive field whose incoming value is the mask sentinel
 * is replaced by the stored ciphertext so untouched secrets survive an
 * edit. Fields the user actually retyped pass through as plaintext and
 * get re-encrypted later by encryptConnectionConfig.
 */
export function restoreMaskedSecrets(
  incoming: Record<string, unknown>,
  stored: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...incoming };
  for (const k of Object.keys(out)) {
    if (SENSITIVE_CONFIG_KEYS.has(k) && out[k] === SECRET_MASK) {
      out[k] = stored[k] ?? "";
    }
  }
  if (out.options && typeof out.options === "object") {
    const opt = out.options as Record<string, unknown>;
    const storedOpt = (stored.options as Record<string, unknown>) ?? {};
    const newOpt: Record<string, unknown> = { ...opt };
    for (const k of Object.keys(newOpt)) {
      if (SENSITIVE_CONFIG_KEYS.has(k) && newOpt[k] === SECRET_MASK) {
        newOpt[k] = storedOpt[k] ?? "";
      }
    }
    out.options = newOpt;
  }
  return out;
}

export function encryptConnectionConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const k of Object.keys(out)) {
    // Skip values that are already ciphertext — on an edit, unchanged
    // secrets are carried over still-encrypted and must not be wrapped twice.
    if (
      SENSITIVE_CONFIG_KEYS.has(k) &&
      typeof out[k] === "string" &&
      out[k] &&
      !isEncrypted(out[k] as string)
    ) {
      out[k] = encryptString(out[k] as string);
    }
  }
  if (out.options && typeof out.options === "object") {
    const opt = out.options as Record<string, unknown>;
    const newOpt: Record<string, unknown> = { ...opt };
    for (const k of Object.keys(newOpt)) {
      if (
        SENSITIVE_CONFIG_KEYS.has(k) &&
        typeof newOpt[k] === "string" &&
        newOpt[k] &&
        !isEncrypted(newOpt[k] as string)
      ) {
        newOpt[k] = encryptString(newOpt[k] as string);
      }
    }
    out.options = newOpt;
  }
  return out;
}

export function decryptConnectionConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const k of Object.keys(out)) {
    if (typeof out[k] === "string" && isEncrypted(out[k] as string)) {
      out[k] = decryptString(out[k] as string);
    }
  }
  if (out.options && typeof out.options === "object") {
    const opt = out.options as Record<string, unknown>;
    const newOpt: Record<string, unknown> = { ...opt };
    for (const k of Object.keys(newOpt)) {
      if (typeof newOpt[k] === "string" && isEncrypted(newOpt[k] as string)) {
        newOpt[k] = decryptString(newOpt[k] as string);
      }
    }
    out.options = newOpt;
  }
  return out;
}

/**
 * Mask sensitive fields for API responses. Returns the config minus
 * actual secret values, with a sentinel showing whether one was set.
 */
export function maskConnectionConfig(
  config: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...config };
  for (const k of Object.keys(out)) {
    if (SENSITIVE_CONFIG_KEYS.has(k)) {
      out[k] = typeof out[k] === "string" && out[k] ? "••••••" : "";
    }
  }
  if (out.options && typeof out.options === "object") {
    const opt = out.options as Record<string, unknown>;
    const newOpt: Record<string, unknown> = { ...opt };
    for (const k of Object.keys(newOpt)) {
      if (SENSITIVE_CONFIG_KEYS.has(k)) {
        newOpt[k] = typeof newOpt[k] === "string" && newOpt[k] ? "••••••" : "";
      }
    }
    out.options = newOpt;
  }
  return out;
}
