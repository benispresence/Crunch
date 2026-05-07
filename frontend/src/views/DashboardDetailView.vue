<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import DashboardWidget from "@/components/DashboardWidget.vue";
import { useDashboardsStore, type DashboardWidget as Widget } from "@/stores/dashboards";
import { useVisualizationsStore } from "@/stores/visualizations";

const route = useRoute();
const router = useRouter();
const dashboards = useDashboardsStore();
const vizStore = useVisualizationsStore();

const COLS = 12;
const ROW_HEIGHT = 80;
const GAP = 12;

const editing = ref(false);
const showAdder = ref(false);
const grid = ref<HTMLDivElement | null>(null);
const draftWidgets = ref<Widget[]>([]);
const dirty = ref(false);

const dashboardId = computed(() => Number(route.params.id));

const totalRows = computed(() => {
  const max = draftWidgets.value.reduce((m, w) => Math.max(m, w.position_y + w.height), 0);
  return Math.max(max + 1, 6);
});

const usedVizIds = computed(() => new Set(draftWidgets.value.map((w) => w.visualization_id)));

onMounted(async () => {
  await Promise.all([dashboards.open(dashboardId.value), vizStore.load()]);
  syncFromStore();
});

watch(
  () => dashboards.current?.widgets,
  () => syncFromStore(),
);

function syncFromStore() {
  draftWidgets.value = (dashboards.current?.widgets ?? []).map((w) => ({ ...w }));
  dirty.value = false;
}

function gridSize() {
  if (!grid.value) return { cellW: 100, cellH: ROW_HEIGHT };
  const totalGap = GAP * (COLS - 1);
  const cellW = (grid.value.clientWidth - totalGap) / COLS;
  return { cellW, cellH: ROW_HEIGHT };
}

function widgetStyle(w: Widget) {
  const { cellW, cellH } = gridSize();
  const left = w.position_x * (cellW + GAP);
  const top = w.position_y * (cellH + GAP);
  const width = w.width * cellW + (w.width - 1) * GAP;
  const height = w.height * cellH + (w.height - 1) * GAP;
  return {
    left: `${left}px`,
    top: `${top}px`,
    width: `${width}px`,
    height: `${height}px`,
  };
}

function clampLayout(w: Widget) {
  w.position_x = Math.max(0, Math.min(COLS - w.width, w.position_x));
  w.position_y = Math.max(0, w.position_y);
  w.width = Math.max(2, Math.min(COLS, w.width));
  w.height = Math.max(2, w.height);
  if (w.position_x + w.width > COLS) w.position_x = COLS - w.width;
}

function startDrag(w: Widget, e: PointerEvent) {
  if (!editing.value) return;
  const { cellW, cellH } = gridSize();
  const startX = e.clientX;
  const startY = e.clientY;
  const startPosX = w.position_x;
  const startPosY = w.position_y;
  (e.target as Element).setPointerCapture(e.pointerId);

  const onMove = (ev: PointerEvent) => {
    const dxCells = Math.round((ev.clientX - startX) / (cellW + GAP));
    const dyCells = Math.round((ev.clientY - startY) / (cellH + GAP));
    w.position_x = startPosX + dxCells;
    w.position_y = startPosY + dyCells;
    clampLayout(w);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    dirty.value = true;
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

function startResize(w: Widget, e: PointerEvent) {
  if (!editing.value) return;
  e.stopPropagation();
  const { cellW, cellH } = gridSize();
  const startX = e.clientX;
  const startY = e.clientY;
  const startW = w.width;
  const startH = w.height;
  (e.target as Element).setPointerCapture(e.pointerId);

  const onMove = (ev: PointerEvent) => {
    const dxCells = Math.round((ev.clientX - startX) / (cellW + GAP));
    const dyCells = Math.round((ev.clientY - startY) / (cellH + GAP));
    w.width = startW + dxCells;
    w.height = startH + dyCells;
    clampLayout(w);
  };
  const onUp = () => {
    window.removeEventListener("pointermove", onMove);
    window.removeEventListener("pointerup", onUp);
    dirty.value = true;
  };
  window.addEventListener("pointermove", onMove);
  window.addEventListener("pointerup", onUp);
}

async function savePositions() {
  await dashboards.savePositions(dashboardId.value, draftWidgets.value);
  dirty.value = false;
}

async function add(visualizationId: number) {
  await dashboards.addWidget(dashboardId.value, visualizationId);
  showAdder.value = false;
}

async function remove(widgetId: number) {
  if (!confirm("Remove this widget from the dashboard?")) return;
  await dashboards.removeWidget(dashboardId.value, widgetId);
}

function cancelEdits() {
  syncFromStore();
  editing.value = false;
}

async function commitAndExit() {
  if (dirty.value) await savePositions();
  editing.value = false;
}
</script>

<template>
  <div class="detail">
    <header class="detail__head">
      <div class="detail__head-left">
        <button class="btn btn-ghost btn-sm" @click="router.push({ name: 'dashboards' })">
          ← Dashboards
        </button>
        <h1>{{ dashboards.current?.name ?? "Dashboard" }}</h1>
      </div>
      <div class="detail__head-right">
        <button class="btn btn-sm" @click="showAdder = true">+ Add widget</button>
        <button v-if="!editing" class="btn btn-sm" @click="editing = true">Edit layout</button>
        <template v-else>
          <button v-if="dirty" class="btn btn-sm" @click="cancelEdits">Discard</button>
          <button class="btn btn-primary btn-sm" @click="commitAndExit">
            {{ dirty ? "Save layout" : "Done" }}
          </button>
        </template>
      </div>
    </header>

    <div
      ref="grid"
      class="detail__grid"
      :class="{ 'detail__grid--editing': editing }"
      :style="{ height: `${totalRows * (ROW_HEIGHT + GAP)}px` }"
    >
      <div v-if="editing" class="detail__overlay">
        <div
          v-for="r in totalRows"
          :key="`row-${r}`"
          class="detail__row-line"
          :style="{ top: `${(r - 1) * (ROW_HEIGHT + GAP)}px` }"
        />
      </div>

      <DashboardWidget
        v-for="w in draftWidgets"
        :key="w.id"
        :widget="w"
        :editing="editing"
        :style="widgetStyle(w)"
        @drag-start="(e) => startDrag(w, e)"
        @resize-start="(e) => startResize(w, e)"
        @remove="remove(w.id)"
      />

      <div
        v-if="draftWidgets.length === 0 && !showAdder"
        class="detail__empty"
      >
        <h3>No widgets yet</h3>
        <p>Add a saved visualization to start building your dashboard.</p>
        <button class="btn btn-primary btn-sm" @click="showAdder = true">+ Add widget</button>
      </div>
    </div>

    <div v-if="showAdder" class="picker" @click.self="showAdder = false">
      <div class="picker__panel">
        <header class="picker__head">
          <h3>Add a widget</h3>
          <button class="btn btn-ghost btn-icon" @click="showAdder = false">×</button>
        </header>
        <div v-if="vizStore.list.length === 0" class="picker__empty">
          You haven't saved any visualizations yet. Run a query in the workspace and click Save on
          the chart panel.
        </div>
        <ul v-else class="picker__list">
          <li
            v-for="v in vizStore.list"
            :key="v.id"
            class="picker__item"
            :class="{ 'picker__item--used': usedVizIds.has(v.id) }"
            @click="add(v.id)"
          >
            <div class="picker__name">{{ v.name }}</div>
            <div class="picker__meta">{{ v.chart_type }}</div>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.detail {
  height: 100%;
  display: flex;
  flex-direction: column;
}
.detail__head {
  padding: 12px 24px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}
.detail__head-left {
  display: flex;
  align-items: center;
  gap: 14px;
}
.detail__head h1 {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 18px;
  font-weight: 500;
}
.detail__head-right {
  display: flex;
  gap: 6px;
}

.detail__grid {
  position: relative;
  flex: 1;
  margin: 24px;
  overflow: auto;
}
.detail__grid--editing {
  background-image: linear-gradient(to right, var(--border) 1px, transparent 1px);
  background-size: calc((100% - 11 * 12px) / 12 + 12px) 100%;
  background-position: 0 0;
}
.detail__overlay {
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.detail__row-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 1px;
  background: var(--border);
  opacity: 0.4;
}

.detail__empty {
  position: absolute;
  inset: 0;
  display: grid;
  place-content: center;
  text-align: center;
  color: var(--fg-muted);
  gap: 8px;
}
.detail__empty h3 {
  font-family: var(--font-serif);
  font-weight: 500;
  margin: 0;
}
.detail__empty p { margin: 0; font-size: 13px; }

.picker {
  position: fixed;
  inset: 0;
  background: rgba(10, 8, 6, 0.6);
  display: grid;
  place-items: center;
  z-index: 100;
}
.picker__panel {
  width: 460px;
  max-width: 90vw;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow);
  overflow: hidden;
}
.picker__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
.picker__head h3 {
  margin: 0;
  font-family: var(--font-serif);
  font-size: 16px;
  font-weight: 500;
}
.picker__empty {
  padding: 28px 20px;
  text-align: center;
  color: var(--fg-muted);
  font-size: 13px;
}
.picker__list {
  list-style: none;
  margin: 0;
  padding: 6px;
  overflow-y: auto;
}
.picker__item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 13px;
}
.picker__item:hover { background: var(--bg-hover); }
.picker__item--used { opacity: 0.6; }
.picker__name { color: var(--fg); }
.picker__meta {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-subtle);
}
</style>
