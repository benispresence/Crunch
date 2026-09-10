<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { api } from "@/api/client";
import { useAuthStore } from "@/stores/auth";

export interface PipelineImport {
  module: string;
  line: number;
  status: "ok" | "not_installed" | "not_allowed";
  detail: string;
  pip_name?: string;
  action?: string;
}

const props = defineProps<{ code: string }>();
const emit = defineEmits<{
  (e: "imports", value: PipelineImport[]): void;
  (e: "select-line", line: number): void;
}>();

const auth = useAuthStore();
const router = useRouter();
const isAdmin = computed(() => auth.user?.role === "admin");
const items = ref<PipelineImport[]>([]);
const busy = ref<Record<string, boolean>>({});
const error = ref("");
const toast = ref("");

const flagged = computed(() => items.value.filter((i) => i.status !== "ok"));

let timer: ReturnType<typeof setTimeout> | null = null;
let seq = 0;

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
});

watch(
  () => props.code,
  (code) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      void analyze(code);
    }, 400);
  },
  { immediate: true },
);

async function analyze(code: string) {
  const id = ++seq;
  try {
    const r = await api.post<{ imports: PipelineImport[] }>("/pipelines/imports", {
      code,
    });
    if (id !== seq) return;
    items.value = r.imports ?? [];
    emit("imports", items.value);
    error.value = "";
  } catch (e) {
    if (id !== seq) return;
    error.value = (e as Error).message;
  }
}

function adminLink(mod: string) {
  return { name: "admin" as const, query: { tab: "packages", pkg: mod } };
}

function openAdmin(mod: string) {
  void router.push(adminLink(mod));
}

async function install(item: PipelineImport) {
  busy.value[item.module] = true;
  error.value = "";
  try {
    const row = await api.post<{ status: string; error_message: string | null }>(
      "/admin/packages",
      {
        package_name: item.pip_name || item.module,
        import_name: item.module,
        auto_install: true,
      },
    );
    if (row.status !== "installed") {
      error.value = row.error_message || `Could not install ${item.module}`;
    } else {
      toast.value = `Installed ${item.module}`;
      setTimeout(() => {
        toast.value = "";
      }, 2500);
    }
    await analyze(props.code);
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    busy.value[item.module] = false;
  }
}
</script>

<template>
  <div v-if="flagged.length || error || toast" class="imports">
    <div v-if="flagged.length" class="imports__list">
      <button
        v-for="item in flagged"
        :key="item.module + item.line"
        type="button"
        class="imports__chip"
        :class="`imports__chip--${item.status}`"
        :title="item.detail"
        @click="emit('select-line', item.line)"
      >
        <code>{{ item.module }}</code>
        <span>{{ item.status === "not_installed" ? "not installed" : "not allowed" }}</span>
        <span class="imports__line">L{{ item.line }}</span>
      </button>
    </div>
    <p v-if="flagged.length" class="imports__hint">
      <template v-if="isAdmin">
        Install the package into the Python engine, or open
        Admin → Allowed packages to manage it.
      </template>
      <template v-else>
        Ask an admin to install these from Admin → Allowed packages.
      </template>
    </p>
    <div v-if="isAdmin && flagged.length" class="imports__actions">
      <button
        v-for="item in flagged"
        :key="'act-' + item.module"
        type="button"
        class="btn btn-sm btn-primary"
        :disabled="busy[item.module]"
        @click="install(item)"
      >
        {{ busy[item.module] ? "Installing…" : (item.action === "allow_and_install" ? "Allow & install" : "Install") }}
        {{ item.module }}
      </button>
      <button
        type="button"
        class="btn btn-sm"
        @click="openAdmin(flagged[0]!.module)"
      >
        Open Allowed packages
      </button>
    </div>
    <p v-if="toast" class="imports__toast">{{ toast }}</p>
    <p v-if="error" class="imports__error">{{ error }}</p>
  </div>
</template>

<style scoped>
.imports {
  padding: 8px 16px 10px;
  background: rgba(224, 122, 95, 0.06);
  border-bottom: 1px solid rgba(224, 122, 95, 0.25);
  display: grid;
  gap: 8px;
}
.imports__list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.imports__chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  border-radius: 999px;
  border: 1px solid rgba(224, 122, 95, 0.35);
  background: var(--bg);
  color: var(--fg);
  font-size: 11.5px;
  cursor: pointer;
}
.imports__chip code {
  font-family: var(--font-mono);
  font-size: 11.5px;
}
.imports__chip--not_installed {
  border-color: rgba(224, 122, 95, 0.45);
}
.imports__chip--not_allowed {
  border-color: rgba(200, 160, 60, 0.55);
  background: rgba(200, 160, 60, 0.08);
}
.imports__line {
  color: var(--fg-subtle);
  font-size: 10px;
}
.imports__hint {
  margin: 0;
  font-size: 12px;
  color: var(--fg-muted);
  line-height: 1.4;
}
.imports__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.imports__toast {
  margin: 0;
  font-size: 12px;
  color: var(--success);
}
.imports__error {
  margin: 0;
  font-size: 12px;
  color: var(--error);
}
</style>
