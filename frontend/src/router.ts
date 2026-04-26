import { createRouter, createWebHistory } from "vue-router";
import { useAuthStore } from "@/stores/auth";

const Login = () => import("@/views/LoginView.vue");
const AppShell = () => import("@/views/AppShell.vue");
const Workspace = () => import("@/views/WorkspaceView.vue");
const Dashboards = () => import("@/views/DashboardsView.vue");
const DashboardDetail = () => import("@/views/DashboardDetailView.vue");
const Admin = () => import("@/views/AdminView.vue");

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: "/login", name: "login", component: Login },
    {
      path: "/",
      component: AppShell,
      meta: { requiresAuth: true },
      children: [
        { path: "", redirect: "/workspace" },
        { path: "workspace", name: "workspace", component: Workspace },
        { path: "dashboards", name: "dashboards", component: Dashboards },
        { path: "dashboards/:id", name: "dashboard-detail", component: DashboardDetail },
        { path: "admin", name: "admin", component: Admin, meta: { adminOnly: true } },
      ],
    },
  ],
});

router.beforeEach((to) => {
  const auth = useAuthStore();
  if (to.meta.requiresAuth && !auth.token) return { name: "login" };
  if (to.name === "login" && auth.token) return { name: "workspace" };
  if (to.meta.adminOnly && auth.user?.role !== "admin") return { name: "workspace" };
});
