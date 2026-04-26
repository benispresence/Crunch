import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";

const Login = () => import("@/views/LoginView.vue");
const Workspace = () => import("@/views/WorkspaceView.vue");

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/", redirect: "/workspace" },
    { path: "/login", name: "login", component: Login },
    { path: "/workspace", name: "workspace", component: Workspace, meta: { requiresAuth: true } },
  ],
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (to.meta.requiresAuth && !auth.token) return { name: "login" };
  if (to.name === "login" && auth.token) return { name: "workspace" };
});
