<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { api } from "@/api/client";
import { useAuthStore } from "@/stores/auth";

const auth = useAuthStore();
const router = useRouter();

const mode = ref<"login" | "register">("login");
const email = ref("");
const password = ref("");
const busy = ref(false);
const error = ref("");
const registrationEnabled = ref(false);

onMounted(async () => {
  try {
    const cfg = await api.get<{ registration_enabled: boolean }>("/auth/config");
    registrationEnabled.value = cfg.registration_enabled;
  } catch {
    registrationEnabled.value = false;
  }
});

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
</script>

<template>
  <div class="login">
    <div class="login__card">
      <img src="/logo.png" alt="Crunch" class="login__logo" />
      <h1 class="login__title">Crunch</h1>
      <p class="login__subtitle">Sign in to continue.</p>

      <div v-if="mode === 'login'" class="login__hint">
        First launch? Default admin:
        <code>admin@nicemeta.local</code> / <code>admin</code>
        — change it after signing in.
      </div>

      <form class="login__form" @submit.prevent="submit">
        <label>
          <span>Email</span>
          <input v-model="email" type="email" required autofocus />
        </label>
        <label>
          <span>Password</span>
          <input
            v-model="password"
            type="password"
            :minlength="mode === 'register' ? 6 : 1"
            required
          />
        </label>

        <button class="btn btn-primary" type="submit" :disabled="busy">
          {{ busy ? "..." : mode === "login" ? "Sign in" : "Create account" }}
        </button>

        <p v-if="error" class="login__error">{{ error }}</p>

        <button
          v-if="registrationEnabled || mode === 'register'"
          class="btn-ghost login__toggle"
          type="button"
          @click="mode = mode === 'login' ? 'register' : 'login'"
        >
          {{ mode === "login" ? "Need an account? Register" : "Have an account? Sign in" }}
        </button>
        <p v-else class="login__locked">
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
  width: 360px;
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
</style>
