/**
 * Per-lab AI configuration: how each provider is connected (API key vs
 * subscription) and which of its models are enabled in chat.
 *
 * Stored as one JSON blob in `settings.ai_providers`. Secrets inside it
 * (API keys, OAuth tokens) are encrypted at rest with the shared crypto
 * module. Legacy `anthropic_api_key` / `enabled_models` / `anthropic_model`
 * are migrated on first read so existing installs keep working.
 */

import { config } from "../config.js";
import { decryptString, encryptString, isEncrypted } from "./crypto.js";
import {
  DEFAULT_MODEL,
  MODEL_CATALOG,
  defaultEnabledIds,
  findModel,
  modelsForProvider,
  type EffortLevel,
  type ModelSpec,
  type ProviderId,
} from "./models.js";
import { getAnthropicApiKey, getSetting, maskApiKey, setSetting } from "./settings.js";
import {
  GROK_CLI_HEADERS,
  XAI_API_BASE,
  XAI_SUBSCRIPTION_BASE,
  accessTokenNeedsRefresh,
  refreshXaiTokens,
  type XaiTokens,
} from "./xaiOauth.js";

export type AuthMode = "api_key" | "subscription";

export interface ProviderLab {
  id: ProviderId;
  label: string;
  short: string;
  blurb: string;
  docs_url: string;
  console_url: string;
  api_key_placeholder: string;
  /** How this lab can actually be connected. */
  auth_modes: AuthMode[];
  subscription_label: string;
  subscription_help: string;
  /** Shown when subscription isn't a valid third-party path. */
  subscription_unavailable?: string;
}

export const PROVIDER_LABS: ProviderLab[] = [
  {
    id: "anthropic",
    label: "Anthropic",
    short: "Claude",
    blurb: "Claude models. Connect with a Console API key.",
    docs_url: "https://docs.anthropic.com",
    console_url: "https://console.anthropic.com/settings/keys",
    api_key_placeholder: "sk-ant-…",
    auth_modes: ["api_key"],
    subscription_label: "Claude Pro / Max",
    subscription_help: "",
    subscription_unavailable:
      "Anthropic does not offer Claude Pro/Max to third-party apps. Use an API key from console.anthropic.com.",
  },
  {
    id: "xai",
    label: "xAI",
    short: "Grok",
    blurb: "Grok models. API key from the xAI console, or SuperGrok / X Premium via sign-in.",
    docs_url: "https://docs.x.ai",
    console_url: "https://console.x.ai/team/default/api-keys",
    api_key_placeholder: "xai-…",
    auth_modes: ["api_key", "subscription"],
    subscription_label: "SuperGrok / X Premium",
    subscription_help:
      "Sign in with the xAI account that owns SuperGrok or an eligible X Premium plan. Usage counts against that subscription — no API key needed. If you bought the plan on X, link that X account under Grok → Settings → Account first.",
  },
  {
    id: "openai",
    label: "OpenAI",
    short: "GPT",
    blurb: "GPT models. Connect with an API key from platform.openai.com.",
    docs_url: "https://platform.openai.com/docs",
    console_url: "https://platform.openai.com/api-keys",
    api_key_placeholder: "sk-…",
    auth_modes: ["api_key"],
    subscription_label: "ChatGPT Plus / Pro",
    subscription_help: "",
    subscription_unavailable:
      "ChatGPT subscriptions are not a supported API for third-party apps. Use an API key from platform.openai.com.",
  },
  {
    id: "google",
    label: "Google",
    short: "Gemini",
    blurb: "Gemini models. Connect with an API key from Google AI Studio.",
    docs_url: "https://ai.google.dev/gemini-api/docs",
    console_url: "https://aistudio.google.com/apikey",
    api_key_placeholder: "AIza…",
    auth_modes: ["api_key"],
    subscription_label: "Google AI Pro / Ultra",
    subscription_help: "",
    subscription_unavailable:
      "Gemini consumer plans don't expose a third-party API. Use an API key from Google AI Studio (tied to your Google account).",
  },
];

export function findLab(id: string): ProviderLab | undefined {
  return PROVIDER_LABS.find((p) => p.id === id);
}

interface StoredOauth {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  token_type?: string;
  scope?: string;
  email?: string;
}

interface StoredProvider {
  auth_mode: AuthMode;
  api_key: string;
  oauth: StoredOauth | null;
  enabled_models: string[];
}

type StoredMap = Record<ProviderId, StoredProvider>;

const SETTINGS_KEY = "ai_providers";
const DEFAULT_MODEL_KEY = "ai_default_model";

function emptyProvider(id: ProviderId): StoredProvider {
  return {
    auth_mode: "api_key",
    api_key: "",
    oauth: null,
    enabled_models: defaultEnabledIds(id),
  };
}

function decryptMaybe(value: string): string {
  if (!value) return "";
  return isEncrypted(value) ? decryptString(value) : value;
}

function encryptMaybe(value: string): string {
  if (!value) return "";
  return isEncrypted(value) ? value : encryptString(value);
}

function decryptOauth(raw: StoredOauth | null): StoredOauth | null {
  if (!raw) return null;
  return {
    ...raw,
    access_token: decryptMaybe(raw.access_token),
    refresh_token: decryptMaybe(raw.refresh_token),
  };
}

function encryptOauth(raw: StoredOauth | null): StoredOauth | null {
  if (!raw) return null;
  return {
    ...raw,
    access_token: encryptMaybe(raw.access_token),
    refresh_token: encryptMaybe(raw.refresh_token),
  };
}

function envApiKey(id: ProviderId): string {
  if (id === "anthropic") return config.anthropicApiKey;
  if (id === "xai") return config.xaiApiKey;
  if (id === "openai") return config.openaiApiKey;
  if (id === "google") return config.googleApiKey;
  return "";
}

function migrateFromLegacy(): StoredMap {
  const map = {
    anthropic: emptyProvider("anthropic"),
    xai: emptyProvider("xai"),
    openai: emptyProvider("openai"),
    google: emptyProvider("google"),
  } satisfies StoredMap;

  const legacyKey = getAnthropicApiKey();
  if (legacyKey) map.anthropic.api_key = legacyKey;

  const legacyEnabled = getSetting("enabled_models");
  if (legacyEnabled) {
    const wanted = new Set(legacyEnabled.split(",").map((s) => s.trim()).filter(Boolean));
    const ids = modelsForProvider("anthropic").filter((m) => wanted.has(m.id)).map((m) => m.id);
    if (ids.length > 0) map.anthropic.enabled_models = ids;
  }
  return map;
}

function readRaw(): StoredMap {
  const raw = getSetting(SETTINGS_KEY);
  if (!raw) {
    const migrated = migrateFromLegacy();
    writeRaw(migrated);
    return migrated;
  }
  try {
    const parsed = JSON.parse(raw) as Partial<Record<ProviderId, Partial<StoredProvider>>>;
    const out = {
      anthropic: emptyProvider("anthropic"),
      xai: emptyProvider("xai"),
      openai: emptyProvider("openai"),
      google: emptyProvider("google"),
    } satisfies StoredMap;
    for (const lab of PROVIDER_LABS) {
      const row = parsed[lab.id];
      if (!row || typeof row !== "object") continue;
      const auth_mode: AuthMode = row.auth_mode === "subscription" && lab.auth_modes.includes("subscription")
        ? "subscription"
        : "api_key";
      const enabled = Array.isArray(row.enabled_models)
        ? modelsForProvider(lab.id).filter((m) => row.enabled_models!.includes(m.id)).map((m) => m.id)
        : defaultEnabledIds(lab.id);
      out[lab.id] = {
        auth_mode,
        api_key: typeof row.api_key === "string" ? decryptMaybe(row.api_key) : "",
        oauth: decryptOauth((row.oauth as StoredOauth | null) ?? null),
        enabled_models: enabled.length > 0 ? enabled : defaultEnabledIds(lab.id),
      };
    }
    return out;
  } catch {
    return migrateFromLegacy();
  }
}

function writeRaw(map: StoredMap): void {
  const stored: Record<string, StoredProvider> = {};
  for (const lab of PROVIDER_LABS) {
    const row = map[lab.id];
    stored[lab.id] = {
      auth_mode: row.auth_mode,
      api_key: encryptMaybe(row.api_key),
      oauth: encryptOauth(row.oauth),
      enabled_models: row.enabled_models,
    };
  }
  setSetting(SETTINGS_KEY, JSON.stringify(stored));
}

export function getProviderStore(): StoredMap {
  return readRaw();
}

export function isProviderConnected(id: ProviderId, map?: StoredMap): boolean {
  const row = (map ?? readRaw())[id];
  const lab = findLab(id)!;
  if (row.auth_mode === "subscription" && lab.auth_modes.includes("subscription")) {
    return !!(row.oauth?.access_token && row.oauth.refresh_token);
  }
  return !!(row.api_key || envApiKey(id));
}

export function getEnabledModelIds(): string[] {
  const map = readRaw();
  const ids: string[] = [];
  for (const lab of PROVIDER_LABS) {
    if (!isProviderConnected(lab.id, map)) continue;
    ids.push(...map[lab.id].enabled_models);
  }
  return ids;
}

export function isModelEnabled(id: string): boolean {
  return getEnabledModelIds().includes(id);
}

export function enabledModels(): ModelSpec[] {
  const ids = new Set(getEnabledModelIds());
  return MODEL_CATALOG.filter((m) => ids.has(m.id));
}

export function getDefaultModel(): string {
  const configured = getSetting(DEFAULT_MODEL_KEY) || getSetting("anthropic_model") || config.anthropicModel || DEFAULT_MODEL;
  const enabled = getEnabledModelIds();
  if (enabled.includes(configured)) return configured;
  return enabled[0] ?? DEFAULT_MODEL;
}

export function setDefaultModel(id: string): void {
  const spec = findModel(id);
  if (!spec) throw new Error(`unknown model: ${id}`);
  const map = readRaw();
  if (!isProviderConnected(spec.provider, map)) {
    throw new Error(`${spec.label} belongs to ${spec.provider}, which is not connected.`);
  }
  if (!map[spec.provider].enabled_models.includes(id)) {
    map[spec.provider].enabled_models = [...map[spec.provider].enabled_models, id];
    writeRaw(map);
  }
  setSetting(DEFAULT_MODEL_KEY, id);
  // Keep the legacy key in sync so older code paths still see a default.
  if (spec.provider === "anthropic") setSetting("anthropic_model", id);
}

export function setProviderEnabledModels(id: ProviderId, ids: string[]): void {
  const valid = modelsForProvider(id).filter((m) => ids.includes(m.id)).map((m) => m.id);
  const map = readRaw();
  const fallback = defaultEnabledIds(id)[0] ?? modelsForProvider(id)[0]?.id;
  map[id].enabled_models = valid.length > 0 ? valid : (fallback ? [fallback] : []);
  const currentDefault = getSetting(DEFAULT_MODEL_KEY) || getSetting("anthropic_model");
  writeRaw(map);
  if (currentDefault && findModel(currentDefault)?.provider === id && !map[id].enabled_models.includes(currentDefault)) {
    const next = getEnabledModelIds()[0];
    if (next) setSetting(DEFAULT_MODEL_KEY, next);
  }
}

export function setProviderAuthMode(id: ProviderId, mode: AuthMode): void {
  const lab = findLab(id);
  if (!lab) throw new Error(`unknown provider: ${id}`);
  if (!lab.auth_modes.includes(mode)) {
    throw new Error(`${lab.label} does not support ${mode} connections.`);
  }
  const map = readRaw();
  map[id].auth_mode = mode;
  writeRaw(map);
}

export function setProviderApiKey(id: ProviderId, key: string): void {
  const map = readRaw();
  map[id].api_key = key.trim();
  if (key.trim()) map[id].auth_mode = "api_key";
  writeRaw(map);
  if (id === "anthropic") setSetting("anthropic_api_key", key.trim());
}

export function clearProviderCredentials(id: ProviderId): void {
  const map = readRaw();
  map[id].api_key = "";
  map[id].oauth = null;
  writeRaw(map);
  if (id === "anthropic") setSetting("anthropic_api_key", "");
}

export function setXaiOauthTokens(tokens: XaiTokens): void {
  const map = readRaw();
  map.xai.auth_mode = "subscription";
  map.xai.oauth = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: tokens.expires_at,
    token_type: tokens.token_type,
    scope: tokens.scope,
    email: tokens.email,
  };
  writeRaw(map);
}

export function clearXaiOauth(): void {
  const map = readRaw();
  map.xai.oauth = null;
  if (map.xai.auth_mode === "subscription") map.xai.auth_mode = "api_key";
  writeRaw(map);
}

let refreshLock: Promise<void> = Promise.resolve();

export async function getValidXaiAccessToken(): Promise<string> {
  const run = async (): Promise<string> => {
    const row = readRaw().xai;
    if (!row.oauth?.access_token || !row.oauth.refresh_token) {
      throw new Error("SuperGrok is not connected. Sign in under Admin → Settings.");
    }
    if (!accessTokenNeedsRefresh(row.oauth)) return row.oauth.access_token;
    const next = await refreshXaiTokens(row.oauth.refresh_token, row.oauth.email);
    setXaiOauthTokens(next);
    return next.access_token;
  };
  const queued = refreshLock.then(run, run);
  refreshLock = queued.then(() => undefined, () => undefined);
  return queued;
}

export interface ProviderCredentials {
  provider: ProviderId;
  auth_mode: AuthMode;
  api_key: string;
  extra_headers: Record<string, string>;
  base_url: string;
  protocol: "anthropic" | "chat_completions" | "responses";
}

export async function getProviderCredentials(id: ProviderId): Promise<ProviderCredentials> {
  const lab = findLab(id);
  if (!lab) throw new Error(`unknown provider: ${id}`);
  const row = readRaw()[id];

  if (id === "anthropic") {
    const api_key = row.api_key || envApiKey(id);
    if (!api_key) {
      throw new Error("Anthropic API key not configured. Set it in Admin → Settings.");
    }
    return {
      provider: id,
      auth_mode: "api_key",
      api_key,
      extra_headers: {},
      base_url: "https://api.anthropic.com",
      protocol: "anthropic",
    };
  }

  if (id === "xai") {
    if (row.auth_mode === "subscription" && row.oauth?.refresh_token) {
      const access = await getValidXaiAccessToken();
      return {
        provider: id,
        auth_mode: "subscription",
        api_key: access,
        extra_headers: { ...GROK_CLI_HEADERS },
        base_url: XAI_SUBSCRIPTION_BASE,
        protocol: "responses",
      };
    }
    const api_key = row.api_key || envApiKey(id);
    if (!api_key) {
      throw new Error("xAI is not connected. Add an API key or sign in with SuperGrok in Admin → Settings.");
    }
    return {
      provider: id,
      auth_mode: "api_key",
      api_key,
      extra_headers: {},
      base_url: XAI_API_BASE,
      protocol: "chat_completions",
    };
  }

  if (id === "openai") {
    const api_key = row.api_key || envApiKey(id);
    if (!api_key) {
      throw new Error("OpenAI API key not configured. Set it in Admin → Settings.");
    }
    return {
      provider: id,
      auth_mode: "api_key",
      api_key,
      extra_headers: {},
      base_url: "https://api.openai.com/v1",
      protocol: "chat_completions",
    };
  }

  const api_key = row.api_key || envApiKey(id);
  if (!api_key) {
    throw new Error("Google Gemini API key not configured. Set it in Admin → Settings.");
  }
  return {
    provider: "google",
    auth_mode: "api_key",
    api_key,
    extra_headers: {},
    base_url: "https://generativelanguage.googleapis.com/v1beta/openai",
    protocol: "chat_completions",
  };
}

export interface ProviderDisplay {
  id: ProviderId;
  label: string;
  short: string;
  blurb: string;
  docs_url: string;
  console_url: string;
  api_key_placeholder: string;
  auth_modes: AuthMode[];
  subscription_label: string;
  subscription_help: string;
  subscription_unavailable?: string;
  auth_mode: AuthMode;
  connected: boolean;
  api_key_set: boolean;
  api_key_masked: string;
  oauth_connected: boolean;
  oauth_email: string | null;
  oauth_expires_at: number | null;
  enabled_models: string[];
  models: Array<{
    id: string;
    label: string;
    blurb: string;
    efforts: EffortLevel[];
    thinking: string;
    default_enabled: boolean;
  }>;
}

export function providerDisplay(id: ProviderId, map?: StoredMap): ProviderDisplay {
  const lab = findLab(id)!;
  const row = (map ?? readRaw())[id];
  const key = row.api_key || envApiKey(id);
  return {
    ...lab,
    auth_mode: row.auth_mode,
    connected: isProviderConnected(id, map),
    api_key_set: !!key,
    api_key_masked: maskApiKey(key),
    oauth_connected: !!(row.oauth?.access_token && row.oauth.refresh_token),
    oauth_email: row.oauth?.email ?? null,
    oauth_expires_at: row.oauth?.expires_at ?? null,
    enabled_models: row.enabled_models,
    models: modelsForProvider(id).map((m) => ({
      id: m.id,
      label: m.label,
      blurb: m.blurb,
      efforts: m.efforts,
      thinking: m.thinking,
      default_enabled: m.defaultEnabled,
    })),
  };
}

export function aiSettingsPayload() {
  const map = readRaw();
  return {
    default_model: getDefaultModel(),
    providers: PROVIDER_LABS.map((lab) => providerDisplay(lab.id, map)),
  };
}

export function modelPickerPayload() {
  const default_model = getDefaultModel();
  return {
    default_model,
    models: enabledModels().map((m) => {
      const lab = findLab(m.provider)!;
      return {
        id: m.id,
        label: m.label,
        blurb: m.blurb,
        efforts: m.efforts,
        default_effort: m.defaultEffort,
        supports_thinking_off: m.thinking !== "always-on",
        provider: m.provider,
        provider_label: lab.label,
        provider_short: lab.short,
      };
    }),
  };
}

/** Tiny non-streaming probe used by Admin → Test connection. */
export async function probeProvider(id: ProviderId): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const creds = await getProviderCredentials(id);
    const model = (readRaw()[id].enabled_models[0]
      ?? defaultEnabledIds(id)[0]
      ?? modelsForProvider(id)[0]?.id);
    if (!model) return { ok: false, error: "no models configured" };

    if (creds.protocol === "anthropic") {
      const { statusCode, body } = await (await import("undici")).request(
        "https://api.anthropic.com/v1/messages",
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": creds.api_key,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify({
            model,
            max_tokens: 8,
            messages: [{ role: "user", content: "Reply with the single word pong." }],
          }),
        },
      );
      const text = await body.text();
      if (statusCode >= 400) {
        return { ok: false, error: probeError(text, statusCode) };
      }
      return { ok: true };
    }

    const url = creds.protocol === "responses"
      ? `${creds.base_url.replace(/\/+$/, "")}/responses`
      : `${creds.base_url.replace(/\/+$/, "")}/chat/completions`;
    const payload = creds.protocol === "responses"
      ? { model, input: "Reply with the single word pong.", max_output_tokens: 16, store: false }
      : {
          model,
          max_tokens: 16,
          messages: [{ role: "user", content: "Reply with the single word pong." }],
        };
    const { statusCode, body } = await (await import("undici")).request(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${creds.api_key}`,
        ...creds.extra_headers,
      },
      body: JSON.stringify(payload),
    });
    const text = await body.text();
    if (statusCode >= 400) return { ok: false, error: probeError(text, statusCode) };
    return { ok: true };
  } catch (err) {
    return { ok: false, error: (err as Error).message };
  }
}

function probeError(text: string, status: number): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string } | string };
    if (typeof j.error === "string") return j.error;
    if (j.error && typeof j.error === "object" && j.error.message) return j.error.message;
  } catch {
    /* fall through */
  }
  return text.slice(0, 280) || `HTTP ${status}`;
}
