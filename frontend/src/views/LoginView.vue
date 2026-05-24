<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { api } from "@/api/client";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();

interface SsoProvider {
  id: number;
  kind: "oidc" | "saml" | "ldap";
  name: string;
}

const mode = ref<"login" | "register">("login");
const email = ref("");
const password = ref("");
const busy = ref(false);
const error = ref("");
const registrationEnabled = ref(false);
const defaultAdminPending = ref(false);
const ssoProviders = ref<SsoProvider[]>([]);
const selectedLdap = ref<number | null>(null);
const defaultAdminEmail = ref<string | null>(null);
const defaultAdminPassword = ref<string | null>(null);
const copyToast = ref("");

const ssoButtons = computed(() =>
  ssoProviders.value.filter((p) => p.kind === "oidc" || p.kind === "saml"),
);
const ldapProviders = computed(() =>
  ssoProviders.value.filter((p) => p.kind === "ldap"),
);

onMounted(async () => {
  // The OIDC/SAML callback redirects back with the JWT in the URL
  // fragment (#token=…). Pluck it out, sign the user in, and clean the
  // fragment so a back-button doesn't re-trigger the flow.
  if (window.location.hash.startsWith("#token=")) {
    const token = window.location.hash.slice("#token=".length);
    history.replaceState(null, "", window.location.pathname);
    await consumeToken(token);
    return;
  }
  // The callback may also bounce here with an error in the query.
  const qError = route.query.error;
  if (typeof qError === "string" && qError.length > 0) {
    error.value = qError;
    history.replaceState(null, "", window.location.pathname);
  }

  try {
    const cfg = await api.get<{
      registration_enabled: boolean;
      default_admin_pending: boolean;
      default_admin_email: string | null;
      default_admin_password: string | null;
      sso_providers: SsoProvider[];
    }>("/auth/config");
    registrationEnabled.value = cfg.registration_enabled;
    defaultAdminPending.value = cfg.default_admin_pending;
    defaultAdminEmail.value = cfg.default_admin_email;
    defaultAdminPassword.value = cfg.default_admin_password;
    ssoProviders.value = cfg.sso_providers ?? [];
    if (ldapProviders.value.length > 0) {
      selectedLdap.value = ldapProviders.value[0]!.id;
    }
  } catch {
    registrationEnabled.value = false;
    defaultAdminPending.value = false;
  }
});

function decodeJwt(token: string): { sub?: number; email?: string; role?: string } {
  const parts = token.split(".");
  if (parts.length < 2) return {};
  try {
    // Browsers don't have a base64url decoder; convert to standard
    // base64 first. Padding is optional in base64url.
    const b64 = parts[1]!.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    return JSON.parse(atob(padded));
  } catch {
    return {};
  }
}

async function consumeToken(token: string) {
  // The IdP callback dropped us back at /login#token=…. Pull the
  // user identity out of the JWT payload so the rest of the SPA
  // (top bar, role gates) has something real to show, then push
  // straight into the workspace.
  try {
    const claims = decodeJwt(token);
    auth.setSession(token, {
      id: claims.sub ?? 0,
      email: claims.email ?? "",
      role: claims.role ?? "viewer",
    });
    await router.push({ name: "workspace" });
  } catch (e) {
    error.value = (e as Error).message;
  }
}

function autofillBootstrap() {
  if (defaultAdminEmail.value) email.value = defaultAdminEmail.value;
  if (defaultAdminPassword.value) password.value = defaultAdminPassword.value;
}
async function copyBootstrap() {
  if (!defaultAdminPassword.value) return;
  try {
    await navigator.clipboard.writeText(defaultAdminPassword.value);
    copyToast.value = "Copied";
    setTimeout(() => (copyToast.value = ""), 1500);
  } catch {
    copyToast.value = "Copy failed";
  }
}

async function submit() {
  busy.value = true;
  error.value = "";
  try {
    const path = mode.value === "login" ? "/auth/login" : "/auth/register";
    const res = await api.post<{ token: string; user: { id: number; email: string; role: string } }>(
      path,
      { email: email.value, password: password.value },
    );
    auth.setSession(res.token, res.user);
    await router.push({ name: "workspace" });
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

function startSso(p: SsoProvider) {
  // OIDC/SAML need a full-page navigation to hit the IdP; the
  // SPA's fetch path won't carry redirects through.
  const path = p.kind === "oidc"
    ? `/api/auth/oidc/${p.id}/start`
    : `/api/auth/saml/${p.id}/start`;
  window.location.href = path;
}

async function submitLdap() {
  if (selectedLdap.value == null) return;
  busy.value = true;
  error.value = "";
  try {
    const res = await api.post<{ token: string; user: { id: number; email: string; role: string } }>(
      `/auth/ldap/${selectedLdap.value}/login`,
      { username: email.value, password: password.value },
    );
    auth.setSession(res.token, res.user);
    await router.push({ name: "workspace" });
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value = false;
  }
}

const useLdap = ref(false);
</script>

<template>
  <div class="login">
    <div class="login__card">
      <img src="/logo.png" alt="Crunch" class="login__logo" />
      <h1 class="login__title">Crunch</h1>
      <p class="login__subtitle">Sign in to continue.</p>

      <div
        v-if="mode === 'login' && defaultAdminPending && defaultAdminPassword"
        class="login__bootstrap"
      >
        <div class="login__bootstrap-title">First launch — default admin</div>
        <div class="login__bootstrap-row">
          <span class="login__bootstrap-label">Email</span>
          <code class="login__bootstrap-value">{{ defaultAdminEmail }}</code>
        </div>
        <div class="login__bootstrap-row">
          <span class="login__bootstrap-label">Password</span>
          <code class="login__bootstrap-value login__bootstrap-pw">{{ defaultAdminPassword }}</code>
          <button type="button" class="login__bootstrap-copy" @click="copyBootstrap">
            {{ copyToast || "Copy" }}
          </button>
        </div>
        <button
          type="button"
          class="login__bootstrap-fill"
          @click="autofillBootstrap"
        >
          Use these credentials →
        </button>
        <p class="login__bootstrap-note">
          Hidden from this page after your first sign-in. You can change the
          password then — or keep it.
        </p>
      </div>

      <!-- SSO buttons. One full-width button per OIDC/SAML provider so
           the user can hop straight into their IdP. -->
      <div v-if="ssoButtons.length > 0 && mode === 'login' && !useLdap" class="login__sso">
        <button
          v-for="p in ssoButtons"
          :key="p.id"
          type="button"
          class="btn login__sso-btn"
          :disabled="busy"
          @click="startSso(p)"
        >
          <span class="login__sso-kind">{{ p.kind }}</span>
          Sign in with {{ p.name }}
        </button>
        <div class="login__divider"><span>or with email + password</span></div>
      </div>

      <!-- LDAP toggle: surface a switch when LDAP is configured. -->
      <div v-if="ldapProviders.length > 0 && mode === 'login'" class="login__ldap-toggle">
        <label>
          <input v-model="useLdap" type="checkbox" />
          <span>Sign in with directory / LDAP</span>
        </label>
        <select v-if="useLdap && ldapProviders.length > 1" v-model="selectedLdap">
          <option v-for="p in ldapProviders" :key="p.id" :value="p.id">
            {{ p.name }}
          </option>
        </select>
      </div>

      <form class="login__form" @submit.prevent="useLdap ? submitLdap() : submit()">
        <label>
          <span>{{ useLdap ? "Username or email" : "Email" }}</span>
          <input
            v-model="email"
            :type="useLdap ? 'text' : 'email'"
            required
            autofocus
          />
        </label>
        <label>
          <span>Password</span>
          <input
            v-model="password"
            type="password"
            :minlength="mode === 'register' && !useLdap ? 6 : 1"
            required
          />
        </label>

        <button class="btn btn-primary" type="submit" :disabled="busy">
          {{ busy ? "..." : useLdap ? "Sign in via LDAP" : (mode === "login" ? "Sign in" : "Create account") }}
        </button>

        <p v-if="error" class="login__error">{{ error }}</p>

        <button
          v-if="(registrationEnabled || mode === 'register') && !useLdap"
          class="btn-ghost login__toggle"
          type="button"
          @click="mode = mode === 'login' ? 'register' : 'login'"
        >
          {{ mode === "login" ? "Need an account? Register" : "Have an account? Sign in" }}
        </button>
        <p v-else-if="!registrationEnabled && !useLdap" class="login__locked">
          Public registration is disabled. Ask an admin to create your account.
        </p>
      </form>
    </div>
  </div>
</template>

<style scoped>
.login {
  min-height: 100%;
  display: grid;
  place-items: center;
  background: radial-gradient(circle at 20% 0%, var(--accent-subtle), transparent 60%), var(--bg);
}
.login__card {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 36px 32px;
  width: 380px;
  box-shadow: var(--shadow);
}
.login__logo {
  width: 56px;
  height: 56px;
  object-fit: contain;
  display: block;
  margin-bottom: 16px;
}
.login__title {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 28px;
  font-weight: 500;
}
.login__subtitle {
  color: var(--fg-muted);
  margin: 4px 0 24px;
}
.login__sso {
  display: grid;
  gap: 8px;
  margin-bottom: 18px;
}
.login__sso-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--fg);
  font-weight: 500;
  font-size: 13px;
  padding: 9px 12px;
}
.login__sso-btn:hover { background: var(--bg-hover); }
.login__sso-kind {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  background: var(--accent-subtle);
  color: var(--accent);
  padding: 2px 6px;
  border-radius: 999px;
}
.login__divider {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--fg-subtle);
  font-size: 11px;
  margin: 6px 0;
}
.login__divider::before,
.login__divider::after {
  content: "";
  flex: 1;
  height: 1px;
  background: var(--border);
}
.login__divider span { white-space: nowrap; }
.login__ldap-toggle {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
  font-size: 12px;
  color: var(--fg-muted);
}
.login__ldap-toggle label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.login__form {
  display: grid;
  gap: 14px;
}
.login__form label {
  display: grid;
  gap: 6px;
  font-size: 12px;
  color: var(--fg-muted);
}
.login__error {
  color: var(--error);
  font-size: 12px;
  margin: 4px 0 0;
}
.login__toggle {
  margin-top: 4px;
  color: var(--fg-muted);
  text-align: center;
  font-size: 12px;
}
.login__locked {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--fg-subtle);
  text-align: center;
}
.login__hint {
  background: var(--accent-subtle);
  border: 1px solid var(--accent-border);
  color: var(--fg-muted);
  font-size: 11px;
  line-height: 1.5;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  margin-bottom: 16px;
}
.login__hint code {
  font-family: var(--font-mono, ui-monospace, monospace);
  background: var(--bg);
  padding: 1px 4px;
  border-radius: 3px;
  color: var(--fg);
}
.login__bootstrap {
  background: var(--accent-subtle);
  border: 1px solid var(--accent-border);
  border-radius: var(--radius);
  padding: 12px 14px;
  margin-bottom: 16px;
  display: grid;
  gap: 8px;
}
.login__bootstrap-title {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--accent);
  font-weight: 600;
}
.login__bootstrap-row {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
}
.login__bootstrap-label {
  width: 60px;
  color: var(--fg-subtle);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.login__bootstrap-value {
  flex: 1;
  font-family: var(--font-mono, ui-monospace, monospace);
  background: var(--bg);
  padding: 3px 8px;
  border-radius: 4px;
  color: var(--fg);
  overflow: hidden;
  text-overflow: ellipsis;
}
.login__bootstrap-pw { user-select: all; }
.login__bootstrap-copy {
  font-size: 11px;
  padding: 3px 9px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 4px;
  color: var(--fg-muted);
  cursor: pointer;
}
.login__bootstrap-copy:hover {
  color: var(--fg);
  border-color: var(--accent-border);
}
.login__bootstrap-fill {
  font-size: 12px;
  padding: 6px 0;
  background: transparent;
  border: none;
  color: var(--accent);
  text-align: left;
  cursor: pointer;
  font-weight: 500;
}
.login__bootstrap-fill:hover { text-decoration: underline; }
.login__bootstrap-note {
  margin: 0;
  font-size: 10.5px;
  color: var(--fg-subtle);
  line-height: 1.5;
}
</style>
