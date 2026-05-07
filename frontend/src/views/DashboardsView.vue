<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import { useDashboardsStore } from "@/stores/dashboards";

const dashboards = useDashboardsStore();
const router = useRouter();

const creating = ref(false);
const newName = ref("");
const newDesc = ref("");
const error = ref("");

onMounted(async () => {
  await dashboards.load();
});

async function create() {
  if (!newName.value.trim()) return;
  try {
    const id = await dashboards.create(newName.value.trim(), newDesc.value.trim() || undefined);
    creating.value = false;
    newName.value = "";
    newDesc.value = "";
    error.value = "";
    router.push({ name: "dashboard-detail", params: { id } });
  } catch (e) {
    error.value = (e as Error).message;
  }
}

async function remove(id: number) {
  if (!confirm("Delete this dashboard?")) return;
  await dashboards.remove(id);
}

function fmt(ts: number): string {
  return new Date(ts * 1000).toLocaleString();
}
</script>

<template>
  <div class="dashboards">
    <header class="dashboards__head">
      <div>
        <h1>Dashboards</h1>
        <p>Pin saved visualizations into a shareable layout.</p>
      </div>
      <button class="btn btn-primary btn-sm" @click="creating = true">+ New dashboard</button>
    </header>

    <div v-if="creating" class="dashboards__form">
      <input v-model="newName" placeholder="Dashboard name" autofocus />
      <input v-model="newDesc" placeholder="Description (optional)" />
      <div class="dashboards__form-actions">
        <button class="btn btn-sm" @click="creating = false">Cancel</button>
        <button class="btn btn-primary btn-sm" @click="create">Create</button>
      </div>
      <p v-if="error" class="dashboards__error">{{ error }}</p>
    </div>

    <div v-if="dashboards.list.length === 0" class="dashboards__empty">
      <div class="dashboards__empty-illustration">▦</div>
      <h2>No dashboards yet</h2>
      <p>Save a visualization in the workspace, then create a dashboard and add it.</p>
    </div>

    <div v-else class="dashboards__grid">
      <article
        v-for="d in dashboards.list"
        :key="d.id"
        class="dashboards__card"
        @click="router.push({ name: 'dashboard-detail', params: { id: d.id } })"
      >
        <div class="dashboards__card-head">
          <h3>{{ d.name }}</h3>
          <button class="btn btn-ghost btn-icon" @click.stop="remove(d.id)" title="Delete">×</button>
        </div>
        <p v-if="d.description" class="dashboards__card-desc">{{ d.description }}</p>
        <div class="dashboards__card-meta">Updated {{ fmt(d.updated_at) }}</div>
      </article>
    </div>
  </div>
</template>

<style scoped>
.dashboards {
  padding: 32px 40px;
  max-width: 1100px;
  margin: 0 auto;
  height: 100%;
  overflow-y: auto;
}
.dashboards__head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  margin-bottom: 24px;
}
.dashboards__head h1 {
  font-family: var(--font-serif);
  font-size: 28px;
  font-weight: 500;
  margin: 0;
  letter-spacing: -0.01em;
}
.dashboards__head p {
  color: var(--fg-muted);
  margin: 4px 0 0;
  font-size: 13px;
}
.dashboards__form {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  display: grid;
  gap: 10px;
  margin-bottom: 24px;
  max-width: 480px;
}
.dashboards__form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.dashboards__error {
  margin: 0;
  color: var(--error);
  font-size: 12px;
}
.dashboards__empty {
  text-align: center;
  padding: 60px 20px;
  color: var(--fg-muted);
}
.dashboards__empty-illustration {
  font-size: 48px;
  color: var(--border-strong);
  margin-bottom: 16px;
}
.dashboards__empty h2 {
  font-family: var(--font-serif);
  font-weight: 500;
  margin: 0 0 6px;
}
.dashboards__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 16px;
}
.dashboards__card {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 16px;
  cursor: pointer;
  transition: border-color 120ms, transform 120ms;
}
.dashboards__card:hover {
  border-color: var(--accent-border);
  transform: translateY(-1px);
}
.dashboards__card-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.dashboards__card-head h3 {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 16px;
  font-weight: 500;
}
.dashboards__card-desc {
  color: var(--fg-muted);
  margin: 6px 0 12px;
  font-size: 13px;
}
.dashboards__card-meta {
  font-size: 11px;
  color: var(--fg-subtle);
}
</style>
