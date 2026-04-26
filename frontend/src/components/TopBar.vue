<script setup lang="ts">
import { useRouter } from "vue-router";
import { useAuthStore } from "@/stores/auth";

defineProps<{ sidebarOpen: boolean; chatOpen: boolean }>();
const emit = defineEmits<{
  (e: "update:sidebarOpen", v: boolean): void;
  (e: "update:chatOpen", v: boolean): void;
}>();

const auth = useAuthStore();
const router = useRouter();

function logout() {
  auth.logout();
  router.push({ name: "login" });
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
      <div class="topbar__brand">
        <div class="topbar__logo">N</div>
        <span class="topbar__name">NiceMeta</span>
      </div>
      <span class="topbar__sep" />
      <span class="topbar__crumb">Workspace</span>
    </div>

    <div class="topbar__right">
      <button
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
      <span class="topbar__user">{{ auth.user?.email ?? "" }}</span>
      <button class="btn btn-ghost btn-sm" @click="logout">Sign out</button>
    </div>
  </header>
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
}
.topbar__logo {
  width: 22px;
  height: 22px;
  border-radius: 6px;
  background: var(--accent);
  color: #1a1815;
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 13px;
}
.topbar__name {
  font-family: var(--font-serif);
  font-weight: 500;
  font-size: 15px;
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
</style>
