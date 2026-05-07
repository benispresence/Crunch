import { defineStore } from "pinia";

interface User {
  id: number;
  email: string;
  role: string;
}

export const useAuthStore = defineStore("auth", {
  state: () => ({
    token: (localStorage.getItem("nm_token") as string | null) ?? null,
    user: JSON.parse(localStorage.getItem("nm_user") ?? "null") as User | null,
  }),
  actions: {
    setSession(token: string, user: User) {
      this.token = token;
      this.user = user;
      localStorage.setItem("nm_token", token);
      localStorage.setItem("nm_user", JSON.stringify(user));
    },
    logout() {
      this.token = null;
      this.user = null;
      localStorage.removeItem("nm_token");
      localStorage.removeItem("nm_user");
    },
  },
});
