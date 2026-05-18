<script setup lang="ts">
import { ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { api } from "@/api/client";
import { useTheme } from "@/composables/theme";
import { useAuthStore } from "@/stores/auth";

defineProps<{ sidebarOpen?: boolean; chatOpen?: boolean }>();
const emit = defineEmits<{
  (e: "update:sidebarOpen", v: boolean): void;
  (e: "update:chatOpen", v: boolean): void;
}>();

const auth = useAuthStore();
const router = useRouter();
const route = useRoute();
const { theme, toggle: toggleTheme } = useTheme();

function logout() {
  auth.logout();
  router.push({ name: "login" });
}

const showChangePassword = ref(false);
const pwCurrent = ref("");
const pwNew = ref("");
const pwBusy = ref(false);
const pwError = ref("");
const pwSuccess = ref(false);

function openChangePassword() {
  showChangePassword.value = true;
  pwCurrent.value = "";
  pwNew.value = "";
  pwError.value = "";
  pwSuccess.value = false;
}

async function submitChangePassword() {
  pwBusy.value = true;
  pwError.value = "";
  pwSuccess.value = false;
  try {
    await api.post<{ ok: true }>("/auth/change-password", {
      current_password: pwCurrent.value,
      new_password: pwNew.value,
    });
    pwSuccess.value = true;
    pwCurrent.value = "";
    pwNew.value = "";
  } catch (e) {
    pwError.value = (e as Error).message;
  } finally {
    pwBusy.value = false;
  }
}
</script>

<template>
  <header class="topbar">
    <div class="topbar__left">
      <button
        class="btn btn-ghost btn-icon"
        :title="sidebarOpen ? 'Hide sidebar' : 'Show sidebar'"
        @click="emit('update:sidebarOpen', !sidebarOpen)"
      >
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" stroke="currentColor" />
          <line x1="6" y1="3" x2="6" y2="13" stroke="currentColor" />
        </svg>
      </button>
      <RouterLink to="/workspace" class="topbar__brand">
        <img src="/logo.png" alt="Crunch" class="topbar__logo" />
        <span class="topbar__name">Crunch</span>
      </RouterLink>
      <nav class="topbar__nav">
        <RouterLink to="/workspace" class="topbar__link">Workspace</RouterLink>
        <RouterLink to="/dashboards" class="topbar__link">Dashboards</RouterLink>
        <RouterLink v-if="auth.user?.role === 'admin'" to="/admin" class="topbar__link">
          Admin
        </RouterLink>
      </nav>
    </div>

    <div class="topbar__right">
      <button
        v-if="route.name === 'workspace'"
        class="btn btn-ghost btn-sm"
        :title="chatOpen ? 'Hide chat' : 'Show chat'"
        @click="emit('update:chatOpen', !chatOpen)"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
          <path
            d="M2 4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H6l-3 3v-3H4a2 2 0 0 1-2-2z"
            stroke="currentColor"
          />
        </svg>
        <span>Chat</span>
      </button>
      <button
        class="btn btn-ghost btn-icon"
        :title="theme === 'dark' ? 'Switch to light theme' : 'Switch to dark theme'"
        @click="toggleTheme"
      >
        <svg v-if="theme === 'dark'" width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path
            d="M13.5 9.5A5.5 5.5 0 0 1 6.5 2.5a5.5 5.5 0 1 0 7 7z"
            stroke="currentColor"
            stroke-linejoin="round"
          />
        </svg>
        <svg v-else width="14" height="14" viewBox="0 0 16 16" fill="none">
          <circle cx="8" cy="8" r="3" stroke="currentColor" />
          <path
            d="M8 1v2M8 13v2M1 8h2M13 8h2M3.05 3.05l1.4 1.4M11.55 11.55l1.4 1.4M3.05 12.95l1.4-1.4M11.55 4.45l1.4-1.4"
            stroke="currentColor"
            stroke-linecap="round"
          />
        </svg>
      </button>
      <span class="topbar__user">{{ auth.user?.email ?? "" }}</span>
      <span v-if="auth.user?.role === 'admin'" class="topbar__role">admin</span>
      <button class="btn btn-ghost btn-sm" @click="openChangePassword">Change password</button>
      <button class="btn btn-ghost btn-sm" @click="logout">Sign out</button>
    </div>
  </header>

  <div v-if="showChangePassword" class="pw-overlay" @click.self="showChangePassword = false">
    <div class="pw-modal">
      <h3 class="pw-modal__title">Change password</h3>
      <form class="pw-modal__form" @submit.prevent="submitChangePassword">
        <label>
          <span>Current password</span>
          <input v-model="pwCurrent" type="password" autocomplete="current-password" required />
        </label>
        <label>
          <span>New password (min 6 chars)</span>
          <input v-model="pwNew" type="password" minlength="6" autocomplete="new-password" required />
        </label>
        <p v-if="pwError" class="pw-modal__error">{{ pwError }}</p>
        <p v-if="pwSuccess" class="pw-modal__success">Password updated.</p>
        <div class="pw-modal__actions">
          <button type="button" class="btn btn-ghost btn-sm" @click="showChangePassword = false">
            Close
          </button>
          <button type="submit" class="btn btn-primary btn-sm" :disabled="pwBusy">
            {{ pwBusy ? "..." : "Update" }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 12px;
  height: 44px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  flex-shrink: 0;
  /* Let the oversized brand mark overflow vertically — it's transparent. */
  overflow: visible;
  position: relative;
  z-index: 5;
}
.topbar__left,
.topbar__right {
  display: flex;
  align-items: center;
  gap: 10px;
}
.topbar__brand {
  display: flex;
  align-items: center;
  gap: 8px;
  text-decoration: none;
  color: inherit;
  overflow: visible;
}
.topbar__nav {
  display: flex;
  gap: 2px;
  margin-left: 8px;
}
.topbar__link {
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  color: var(--fg-muted);
  font-size: 13px;
  text-decoration: none;
  transition: background 120ms, color 120ms;
}
.topbar__link:hover { background: var(--bg-hover); color: var(--fg); }
.topbar__link.router-link-active {
  background: var(--accent-subtle);
  color: var(--accent);
}
.topbar__role {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 2px 6px;
  border-radius: 999px;
  background: var(--accent-subtle);
  color: var(--accent);
  border: 1px solid var(--accent-border);
}
.topbar__logo {
  width: 76px;
  height: 76px;
  object-fit: contain;
  display: block;
}
.topbar__name {
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: 22px;
  letter-spacing: -0.01em;
}
.topbar__sep {
  width: 1px;
  height: 18px;
  background: var(--border);
}
.topbar__crumb {
  color: var(--fg-muted);
  font-size: 13px;
}
.topbar__user {
  color: var(--fg-subtle);
  font-size: 12px;
}
.pw-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: grid;
  place-items: center;
  z-index: 1000;
}
.pw-modal {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 24px;
  width: 360px;
  box-shadow: var(--shadow);
}
.pw-modal__title {
  margin: 0 0 16px;
  font-family: var(--font-serif);
  font-size: 18px;
  font-weight: 500;
}
.pw-modal__form {
  display: grid;
  gap: 12px;
}
.pw-modal__form label {
  display: grid;
  gap: 6px;
  font-size: 12px;
  color: var(--fg-muted);
}
.pw-modal__error { color: var(--error); font-size: 12px; margin: 0; }
.pw-modal__success { color: var(--accent); font-size: 12px; margin: 0; }
.pw-modal__actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  margin-top: 4px;
}
</style>
