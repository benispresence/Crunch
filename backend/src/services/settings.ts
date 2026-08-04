import { db } from "../db/index.js";
import { config } from "../config.js";
import { decryptString, encryptString, isEncrypted } from "./crypto.js";

const ENCRYPTED_KEYS = new Set(["anthropic_api_key"]);

// The selectable model list lives in services/models.ts, which carries
// per-model capabilities rather than just ids. It reads settings from here, so
// this module deliberately does *not* import it back — the fallback id is
// duplicated instead of creating an import cycle.
const DEFAULT_MODEL = "claude-opus-5";

export function getSetting(key: string): string {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  const raw = row?.value ?? "";
  if (!raw) return "";
  if (ENCRYPTED_KEYS.has(key) && isEncrypted(raw)) {
    return decryptString(raw);
  }
  return raw;
}

export function setSetting(key: string, value: string): void {
  const stored = ENCRYPTED_KEYS.has(key) && value ? encryptString(value) : value;
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, strftime('%s', 'now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  ).run(key, stored);
}

export function getAnthropicApiKey(): string {
  return getSetting("anthropic_api_key") || config.anthropicApiKey || "";
}

export function getAnthropicModel(): string {
  return getSetting("anthropic_model") || config.anthropicModel || DEFAULT_MODEL;
}

/**
 * Public self-registration on /auth/register. Off by default — admin
 * opts in via Admin → Settings if they want anyone with the URL to be
 * able to create their own account.
 */
export function isPublicRegistrationEnabled(): boolean {
  return getSetting("public_registration_enabled") === "1";
}
export function setPublicRegistrationEnabled(on: boolean): void {
  setSetting("public_registration_enabled", on ? "1" : "0");
}

export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "•".repeat(key.length);
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}
