import { db } from "../db/index.js";
import { config } from "../config.js";

export const KNOWN_MODELS = [
  { id: "claude-opus-4-7", label: "Claude Opus 4.7 (most capable)" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (balanced)" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fastest)" },
];

const DEFAULT_MODEL = "claude-opus-4-7";

export function getSetting(key: string): string {
  const row = db
    .prepare("SELECT value FROM settings WHERE key = ?")
    .get(key) as { value: string } | undefined;
  return row?.value ?? "";
}

export function setSetting(key: string, value: string): void {
  db.prepare(
    `INSERT INTO settings (key, value, updated_at)
     VALUES (?, ?, strftime('%s', 'now'))
     ON CONFLICT(key) DO UPDATE SET
       value = excluded.value,
       updated_at = excluded.updated_at`,
  ).run(key, value);
}

export function getAnthropicApiKey(): string {
  return getSetting("anthropic_api_key") || config.anthropicApiKey || "";
}

export function getAnthropicModel(): string {
  return getSetting("anthropic_model") || config.anthropicModel || DEFAULT_MODEL;
}

export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 12) return "•".repeat(key.length);
  return `${key.slice(0, 7)}…${key.slice(-4)}`;
}
