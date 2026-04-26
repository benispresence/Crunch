<script setup lang="ts">
import { ref } from "vue";
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
      <div class="login__logo">N</div>
      <h1 class="login__title">NiceMeta</h1>
      <p class="login__subtitle">Sign in to continue.</p>

      <form class="login__form" @submit.prevent="submit">
        <label>
          <span>Email</span>
          <input v-model="email" type="email" required autofocus />
        </label>
        <label>
          <span>Password</span>
          <input v-model="password" type="password" minlength="6" required />
        </label>

        <button class="btn btn-primary" type="submit" :disabled="busy">
          {{ busy ? "..." : mode === "login" ? "Sign in" : "Create account" }}
        </button>

        <p v-if="error" class="login__error">{{ error }}</p>

        <button
          class="btn-ghost login__toggle"
          type="button"
          @click="mode = mode === 'login' ? 'register' : 'login'"
        >
          {{ mode === "login" ? "Need an account? Register" : "Have an account? Sign in" }}
        </button>
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
  width: 44px;
  height: 44px;
  border-radius: 12px;
  background: var(--accent);
  color: #1a1815;
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 22px;
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
</style>
