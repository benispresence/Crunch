<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from "vue";
import { api } from "@/api/client";

export type AuthMode = "api_key" | "subscription";
export type ProviderId = "anthropic" | "xai" | "openai" | "google";

export interface LabModel {
  id: string;
  label: string;
  blurb: string;
  efforts: string[];
  thinking: string;
  default_enabled: boolean;
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
  models: LabModel[];
}

export interface AiSettingsState {
  default_model: string;
  providers: ProviderDisplay[];
  public_registration_enabled: boolean;
  web_search_enabled: boolean;
  web_search_max_uses: number;
}

const emit = defineEmits<{ error: [string] }>();

const settings = ref<AiSettingsState | null>(null);
const busy = ref(false);
const toast = ref("");
const keyDraft = ref<Record<string, string>>({});
const testing = ref<Record<string, boolean>>({});
const testNote = ref<Record<string, { ok: boolean; text: string }>>({});

interface OauthFlow {
  session_id: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  status: string;
  error?: string;
}
const oauth = ref<OauthFlow | null>(null);
let oauthTimer: ReturnType<typeof setInterval> | null = null;

const allEnabledModels = computed(() => {
  if (!settings.value) return [];
  const out: Array<{ id: string; label: string; lab: string }> = [];
  for (const p of settings.value.providers) {
    if (!p.connected) continue;
    for (const m of p.models) {
      if (p.enabled_models.includes(m.id)) {
        out.push({ id: m.id, label: `${p.short} · ${m.label}`, lab: p.label });
      }
    }
  }
  return out;
});

function flash(msg: string) {
  toast.value = msg;
  setTimeout(() => {
    if (toast.value === msg) toast.value = "";
  }, 3500);
}

async function load() {
  try {
    settings.value = await api.get<AiSettingsState>("/admin/settings");
  } catch (e) {
    emit("error", (e as Error).message);
  }
}

onMounted(load);
onUnmounted(stopOauthPoll);

async function patchSettings(body: Record<string, unknown>, note: string) {
  busy.value = true;
  try {
    settings.value = await api.put<AiSettingsState>("/admin/settings", body);
    flash(note);
  } catch (e) {
    emit("error", (e as Error).message);
  } finally {
    busy.value = false;
  }
}

async function patchProvider(id: string, body: Record<string, unknown>, note?: string) {
  busy.value = true;
  try {
    settings.value = await api.put<AiSettingsState>(`/admin/ai/providers/${id}`, body);
    if (note) flash(note);
  } catch (e) {
    emit("error", (e as Error).message);
  } finally {
    busy.value = false;
  }
}

async function saveApiKey(p: ProviderDisplay) {
  const value = (keyDraft.value[p.id] ?? "").trim();
  if (!value) {
    emit("error", "Paste an API key first.");
    return;
  }
  await patchProvider(p.id, { auth_mode: "api_key", api_key: value }, `${p.label} API key saved.`);
  keyDraft.value[p.id] = "";
}

async function clearCredentials(p: ProviderDisplay) {
  if (!confirm(`Remove stored credentials for ${p.label}? Chat will stop using this lab until you reconnect.`)) {
    return;
  }
  busy.value = true;
  try {
    settings.value = await api.del<AiSettingsState>(`/admin/ai/providers/${p.id}/credentials`);
    keyDraft.value[p.id] = "";
    flash(`${p.label} disconnected.`);
  } catch (e) {
    emit("error", (e as Error).message);
  } finally {
    busy.value = false;
  }
}

async function setAuthMode(p: ProviderDisplay, mode: AuthMode) {
  if (mode === "subscription" && !p.auth_modes.includes("subscription")) return;
  await patchProvider(p.id, { auth_mode: mode });
}

async function toggleModel(p: ProviderDisplay, id: string, on: boolean) {
  const next = on
    ? [...p.enabled_models, id]
    : p.enabled_models.filter((m) => m !== id);
  await patchProvider(p.id, { enabled_models: next });
}

async function testConnection(p: ProviderDisplay) {
  testing.value[p.id] = true;
  testNote.value[p.id] = { ok: true, text: "Testing…" };
  try {
    const r = await api.post<{ ok: boolean; error?: string }>(`/admin/ai/providers/${p.id}/test`, {});
    testNote.value[p.id] = r.ok
      ? { ok: true, text: "Connection works." }
      : { ok: false, text: r.error || "Test failed." };
  } catch (e) {
    testNote.value[p.id] = { ok: false, text: (e as Error).message };
  } finally {
    testing.value[p.id] = false;
  }
}

function stopOauthPoll() {
  if (oauthTimer) {
    clearInterval(oauthTimer);
    oauthTimer = null;
  }
}

async function startGrokOauth() {
  busy.value = true;
  try {
    oauth.value = await api.post<OauthFlow>("/admin/ai/xai/oauth/start", {});
    stopOauthPoll();
    oauthTimer = setInterval(pollGrokOauth, 2000);
  } catch (e) {
    emit("error", (e as Error).message);
  } finally {
    busy.value = false;
  }
}

async function pollGrokOauth() {
  if (!oauth.value) return;
  try {
    const r = await api.get<OauthFlow & { settings?: AiSettingsState }>(
      `/admin/ai/xai/oauth/status?session=${encodeURIComponent(oauth.value.session_id)}`,
    );
    oauth.value = r;
    if (r.status === "complete") {
      stopOauthPoll();
      if (r.settings) settings.value = r.settings;
      else await load();
      oauth.value = null;
      flash("SuperGrok connected. Grok models are now in the chat picker.");
    } else if (r.status === "denied" || r.status === "expired") {
      stopOauthPoll();
    }
  } catch (e) {
    const msg = (e as Error).message || "";
    if (/unknown or finished session|not found/i.test(msg)) {
      stopOauthPoll();
      oauth.value = oauth.value
        ? { ...oauth.value, status: "expired", error: "Sign-in session ended. Start again." }
        : null;
    }
  }
}

async function cancelGrokOauth() {
  if (oauth.value) {
    try {
      await api.post("/admin/ai/xai/oauth/cancel", { session: oauth.value.session_id });
    } catch {
      /* ignore */
    }
  }
  stopOauthPoll();
  oauth.value = null;
}

async function disconnectGrokOauth() {
  if (!confirm("Disconnect SuperGrok? Grok models drop out of chat until you reconnect or add an API key.")) {
    return;
  }
  busy.value = true;
  try {
    settings.value = await api.del<AiSettingsState>("/admin/ai/xai/oauth");
    flash("SuperGrok disconnected.");
  } catch (e) {
    emit("error", (e as Error).message);
  } finally {
    busy.value = false;
  }
}

function oauthExpiry(p: ProviderDisplay): string {
  if (!p.oauth_expires_at) return "";
  const ms = p.oauth_expires_at * 1000 - Date.now();
  if (ms <= 0) return "refreshing…";
  const min = Math.round(ms / 60000);
  if (min < 60) return `token refreshes in ${min}m`;
  return `token refreshes in ${Math.round(min / 60)}h`;
}
</script>

<template>
  <div v-if="settings" class="ai">
    <div class="ai__intro">
      <div>
        <h3>AI labs</h3>
        <p>
          Each lab has its own connection — an API key from the developer console,
          or a consumer subscription where the lab actually supports that.
          Enabled models from connected labs show up in the chat picker.
        </p>
      </div>
      <span v-if="toast" class="ai__toast">{{ toast }}</span>
    </div>

    <label class="ai__default">
      <span>Default model</span>
      <select
        :value="settings.default_model"
        :disabled="busy || allEnabledModels.length === 0"
        @change="patchSettings(
          { default_model: ($event.target as HTMLSelectElement).value },
          'Default model updated.',
        )"
      >
        <option v-if="allEnabledModels.length === 0" value="">Connect a lab first</option>
        <option v-for="m in allEnabledModels" :key="m.id" :value="m.id">{{ m.label }}</option>
      </select>
      <small>Used when a user hasn't picked a model in the composer.</small>
    </label>

    <article v-for="p in settings.providers" :key="p.id" class="lab">
      <header class="lab__head">
        <div>
          <h4>{{ p.label }} <span class="lab__short">{{ p.short }}</span></h4>
          <p>{{ p.blurb }}</p>
        </div>
        <span
          class="lab__pill"
          :class="p.connected ? 'lab__pill--on' : 'lab__pill--off'"
        >
          {{ p.connected ? "CONNECTED" : "NOT CONNECTED" }}
        </span>
      </header>

      <div class="lab__modes">
        <span class="lab__modes-label">Connection</span>
        <label class="lab__mode">
          <input
            type="radio"
            :name="`mode-${p.id}`"
            :checked="p.auth_mode === 'api_key'"
            :disabled="busy"
            @change="setAuthMode(p, 'api_key')"
          />
          <span>API key</span>
        </label>
        <label
          class="lab__mode"
          :class="{ 'lab__mode--disabled': !p.auth_modes.includes('subscription') }"
        >
          <input
            type="radio"
            :name="`mode-${p.id}`"
            :checked="p.auth_mode === 'subscription'"
            :disabled="busy || !p.auth_modes.includes('subscription')"
            @change="setAuthMode(p, 'subscription')"
          />
          <span>{{ p.subscription_label }}</span>
        </label>
      </div>

      <p v-if="p.auth_mode === 'subscription' && p.subscription_unavailable" class="lab__warn">
        {{ p.subscription_unavailable }}
      </p>

      <div v-if="p.auth_mode === 'api_key' || !p.auth_modes.includes('subscription')" class="lab__key">
        <label class="lab__field">
          <span>API key</span>
          <div class="lab__row">
            <input
              v-model="keyDraft[p.id]"
              type="password"
              autocomplete="off"
              :placeholder="p.api_key_set ? p.api_key_masked : p.api_key_placeholder"
            />
            <button class="btn btn-primary btn-sm" :disabled="busy" @click="saveApiKey(p)">
              Save key
            </button>
            <button
              v-if="p.api_key_set"
              class="btn btn-sm"
              :disabled="busy"
              @click="clearCredentials(p)"
            >
              Clear
            </button>
          </div>
          <small v-if="p.api_key_set">
            Currently set: <code>{{ p.api_key_masked }}</code>.
            Get a new one at
            <a :href="p.console_url" target="_blank" rel="noreferrer">the {{ p.label }} console</a>.
          </small>
          <small v-else>
            Paste a key from
            <a :href="p.console_url" target="_blank" rel="noreferrer">{{ p.console_url.replace(/^https:\/\//, "") }}</a>.
          </small>
        </label>
      </div>

      <div v-else-if="p.id === 'xai'" class="lab__sub">
        <p class="lab__help">{{ p.subscription_help }}</p>

        <div v-if="oauth" class="lab__device">
          <p>Open the verification page and enter this code, or click the button — it fills the code in for you.</p>
          <div class="lab__code">{{ oauth.user_code }}</div>
          <div class="lab__row">
            <a
              class="btn btn-primary btn-sm"
              :href="oauth.verification_uri_complete"
              target="_blank"
              rel="noreferrer"
            >
              Open xAI sign-in
            </a>
            <button class="btn btn-sm" @click="cancelGrokOauth">Cancel</button>
          </div>
          <p v-if="oauth.status === 'pending'" class="lab__wait">Waiting for approval… {{ oauth.expires_in }}s left</p>
          <p v-else-if="oauth.error" class="lab__err">{{ oauth.error }}</p>
        </div>

        <div v-else-if="p.oauth_connected" class="lab__connected">
          <div>
            Signed in{{ p.oauth_email ? ` as ${p.oauth_email}` : "" }}.
            <span class="lab__muted">{{ oauthExpiry(p) }}</span>
          </div>
          <button class="btn btn-sm" :disabled="busy" @click="disconnectGrokOauth">Disconnect</button>
        </div>

        <button
          v-else
          class="btn btn-primary btn-sm"
          :disabled="busy"
          @click="startGrokOauth"
        >
          Connect SuperGrok
        </button>
      </div>

      <div class="lab__actions">
        <button
          class="btn btn-sm"
          :disabled="busy || testing[p.id] || !p.connected"
          @click="testConnection(p)"
        >
          {{ testing[p.id] ? "Testing…" : "Test connection" }}
        </button>
        <span
          v-if="testNote[p.id]"
          class="lab__test"
          :class="testNote[p.id]!.ok ? 'lab__test--ok' : 'lab__test--err'"
        >
          {{ testNote[p.id]!.text }}
        </span>
      </div>

      <div class="lab__models">
        <h5>Models in chat</h5>
        <p v-if="!p.connected" class="lab__muted">Connect this lab to offer its models in the picker.</p>
        <ul>
          <li v-for="m in p.models" :key="m.id">
            <label class="lab__model">
              <input
                type="checkbox"
                :checked="p.enabled_models.includes(m.id)"
                :disabled="busy || (!p.connected && !p.enabled_models.includes(m.id))"
                @change="toggleModel(p, m.id, ($event.target as HTMLInputElement).checked)"
              />
              <span class="lab__model-main">
                <span class="lab__model-name">
                  {{ m.label }}
                  <span v-if="m.id === settings.default_model" class="admin-badge">default</span>
                </span>
                <span class="lab__model-blurb">{{ m.blurb }}</span>
              </span>
              <span class="lab__model-caps">
                {{ m.efforts.length ? m.efforts.join(" / ") : "no effort control" }}
              </span>
            </label>
          </li>
        </ul>
      </div>
    </article>

    <div class="ai__group">
      <h3>Web search</h3>
      <p>
        Lets the assistant look things up on the web via Anthropic's server-side search
        when a Claude model is selected. It never sees your warehouse data. Other labs
        answer from the tools and their own knowledge.
      </p>
      <label class="ai__toggle">
        <input
          type="checkbox"
          :checked="settings.web_search_enabled"
          :disabled="busy"
          @change="patchSettings(
            { web_search_enabled: ($event.target as HTMLInputElement).checked },
            ($event.target as HTMLInputElement).checked
              ? 'Web search enabled for Claude.'
              : 'Web search disabled.',
          )"
        />
        <span>Allow Claude to search the web</span>
        <span
          class="ai__pill"
          :class="settings.web_search_enabled ? 'ai__pill--on' : 'ai__pill--off'"
        >
          {{ settings.web_search_enabled ? "ENABLED" : "DISABLED" }}
        </span>
      </label>
      <label v-if="settings.web_search_enabled" class="ai__field">
        <span>Max searches per message</span>
        <input
          type="number"
          min="1"
          max="20"
          :value="settings.web_search_max_uses"
          :disabled="busy"
          @change="patchSettings(
            { web_search_max_uses: Number(($event.target as HTMLInputElement).value) },
            'Search cap updated.',
          )"
        />
      </label>
    </div>
  </div>
</template>

<style scoped>
.ai { display: grid; gap: 16px; max-width: 760px; }
.ai__intro {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.ai__intro h3,
.ai__group h3 {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 16px;
  font-weight: 500;
}
.ai__intro p,
.ai__group p {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--fg-muted);
  line-height: 1.5;
}
.ai__toast {
  color: var(--success);
  font-size: 12px;
  white-space: nowrap;
}
.ai__default,
.ai__field {
  display: grid;
  gap: 6px;
  font-size: 12px;
  color: var(--fg-muted);
}
.ai__default > span,
.ai__field > span,
.lab__field > span {
  color: var(--fg);
  font-weight: 500;
  font-size: 13px;
}
.ai__default small,
.lab__field small {
  font-size: 11px;
  color: var(--fg-subtle);
}
.ai__default small a,
.lab__field small a { color: var(--accent); }
.ai__group {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 18px 20px;
  display: grid;
  gap: 12px;
}
.ai__toggle {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}
.ai__pill {
  margin-left: auto;
  font-size: 10px;
  font-family: var(--font-mono);
  letter-spacing: 0.05em;
  padding: 2px 8px;
  border-radius: 999px;
}
.ai__pill--on { background: rgba(127, 176, 105, 0.12); color: var(--success); }
.ai__pill--off { background: var(--bg-elev-2); color: var(--fg-subtle); }

.lab {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 16px 18px;
  display: grid;
  gap: 12px;
}
.lab__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.lab__head h4 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
}
.lab__short {
  font-weight: 500;
  color: var(--fg-subtle);
  font-size: 12px;
  margin-left: 6px;
}
.lab__head p {
  margin: 3px 0 0;
  font-size: 12px;
  color: var(--fg-muted);
  line-height: 1.45;
}
.lab__pill {
  flex-shrink: 0;
  font-size: 10px;
  font-family: var(--font-mono);
  letter-spacing: 0.05em;
  padding: 3px 8px;
  border-radius: 999px;
}
.lab__pill--on { background: rgba(127, 176, 105, 0.12); color: var(--success); }
.lab__pill--off { background: var(--bg-elev-2); color: var(--fg-subtle); }
.lab__modes {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px 16px;
  font-size: 13px;
}
.lab__modes-label { color: var(--fg-subtle); font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; }
.lab__mode { display: inline-flex; align-items: center; gap: 6px; cursor: pointer; }
.lab__mode--disabled { color: var(--fg-subtle); cursor: not-allowed; }
.lab__warn { margin: 0; font-size: 12px; color: var(--warn); line-height: 1.45; }
.lab__help { margin: 0; font-size: 12px; color: var(--fg-muted); line-height: 1.5; }
.lab__row { display: flex; gap: 8px; align-items: center; }
.lab__row input { flex: 1; }
.lab__field { display: grid; gap: 6px; }
.lab__field code {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--bg-elev-2);
  padding: 1px 5px;
  border-radius: 3px;
}
.lab__device {
  border: 1px dashed var(--accent-border);
  background: var(--accent-subtle);
  border-radius: var(--radius-sm);
  padding: 12px 14px;
  display: grid;
  gap: 8px;
}
.lab__device p { margin: 0; font-size: 12px; color: var(--fg-muted); }
.lab__code {
  font-family: var(--font-mono);
  font-size: 22px;
  letter-spacing: 0.18em;
  font-weight: 600;
  color: var(--fg);
}
.lab__wait { color: var(--accent) !important; }
.lab__err { color: var(--error) !important; }
.lab__connected {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  font-size: 13px;
}
.lab__muted { color: var(--fg-subtle); font-size: 12px; }
.lab__actions { display: flex; align-items: center; gap: 10px; }
.lab__test { font-size: 12px; }
.lab__test--ok { color: var(--success); }
.lab__test--err { color: var(--error); }
.lab__models h5 {
  margin: 0 0 6px;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--fg-subtle);
}
.lab__models ul {
  margin: 0;
  padding: 0;
  list-style: none;
  display: grid;
  gap: 2px;
}
.lab__model {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 7px 9px;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.lab__model:hover { background: var(--bg-hover); }
.lab__model-main { display: grid; gap: 2px; flex: 1; min-width: 0; }
.lab__model-name {
  font-size: 12.5px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.lab__model-blurb { font-size: 11px; color: var(--fg-subtle); line-height: 1.4; }
.lab__model-caps {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--fg-subtle);
  flex-shrink: 0;
  padding-top: 2px;
}
.admin-badge {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg-elev-2);
  color: var(--fg-subtle);
  border: 1px solid var(--border);
}
</style>
