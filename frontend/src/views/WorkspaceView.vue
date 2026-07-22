<script setup lang="ts">
import { Pane, Splitpanes } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import ChartPanel from "@/components/ChartPanel.vue";
import ConnectionsPanel from "@/components/ConnectionsPanel.vue";
import ResultsTable from "@/components/ResultsTable.vue";
import SqlEditor from "@/components/SqlEditor.vue";
import { queryPath } from "@/utils/links";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";
import { useWorkspaceStore } from "@/stores/workspace";

const props = defineProps<{
  sidebarOpen?: boolean;
  chatOpen?: boolean;
  vizFullView?: boolean;
}>();

const auth = useAuthStore();
const route = useRoute();
const router = useRouter();
const ws = useWorkspaceStore();
const chat = useChatStore();

/** When true, URL → store sync is in progress (avoid push loops). */
let syncingFromRoute = false;
/** Last query id we opened from the route (or pushed into it). */
let lastRoutedQueryId: number | null = null;

const compact = ref(window.innerWidth < 1100);
window.addEventListener("resize", () => {
  compact.value = window.innerWidth < 1100;
});

// Per-pane collapse state. Visualization is dominant by default.
const editorCollapsed = ref(false);
const chartCollapsed = ref(false);
const resultsCollapsed = ref(false);

// Vertical stack: collapsed panes shrink to their header; open panes share
// free space. Chart is always the flex sponge so collapsing editor/results
// grows the visualization instead of leaving empty gaps.
const editorFlex = computed(() =>
  editorCollapsed.value ? "0 0 auto" : "1 1 0%",
);
const chartFlex = computed(() => {
  if (chartCollapsed.value) return "0 0 auto";
  // Alone (or nearly): claim every free pixel in the stack.
  if (editorCollapsed.value && resultsCollapsed.value) return "1 1 0%";
  return "3 1 0%";
});
const resultsFlex = computed(() =>
  resultsCollapsed.value ? "0 0 auto" : "1 1 0%",
);

// Horizontal Splitpanes sizes. Chat lives in AppShell now, so only the
// collections sidebar competes with the center stack for width.
const sidebarSize = computed(() => (compact.value ? 22 : 18));
const centerSize = computed(() => {
  if (props.sidebarOpen === false) return 100;
  return Math.max(100 - sidebarSize.value, 30);
});

// Bumped whenever the workspace chrome/stack changes so ChartPanel refits Plotly.
const layoutTick = ref(0);
function bumpLayout() {
  layoutTick.value += 1;
}
watch(
  [
    () => props.sidebarOpen,
    () => props.chatOpen,
    () => props.vizFullView,
    editorCollapsed,
    chartCollapsed,
    resultsCollapsed,
    centerSize,
    compact,
  ],
  () => {
    bumpLayout();
  },
);

// Agent-driven pane focus: when a proposal becomes active, auto-collapse
// panes that aren't relevant to the change. Restored on resolve.
const savedPaneState = ref<{ editor: boolean; chart: boolean; results: boolean } | null>(null);

// Top-bar "full visualization" mode: collapse editor + results, keep chart open.
// Sidebar/chat are toggled in AppShell. Separate from agent-driven pane focus.
const preFullViewState = ref<{ editor: boolean; chart: boolean; results: boolean } | null>(null);

watch(
  () => props.vizFullView,
  (full) => {
    if (full) {
      if (preFullViewState.value == null) {
        preFullViewState.value = {
          editor: editorCollapsed.value,
          chart: chartCollapsed.value,
          results: resultsCollapsed.value,
        };
      }
      editorCollapsed.value = true;
      chartCollapsed.value = false;
      resultsCollapsed.value = true;
    } else if (preFullViewState.value != null) {
      editorCollapsed.value = preFullViewState.value.editor;
      chartCollapsed.value = preFullViewState.value.chart;
      resultsCollapsed.value = preFullViewState.value.results;
      preFullViewState.value = null;
    }
  },
);

watch(
  () => chat.activeProposal,
  (active) => {
    if (active) {
      if (savedPaneState.value == null) {
        savedPaneState.value = {
          editor: editorCollapsed.value,
          chart: chartCollapsed.value,
          results: resultsCollapsed.value,
        };
      }
      const kind = active.record.proposal.kind;
      if (
        kind === "query_edit" || kind === "new_query" || kind === "delete_query"
        || kind === "bulk_query_edit"
      ) {
        editorCollapsed.value = false;
        chartCollapsed.value = true;
        resultsCollapsed.value = true;
      } else if (kind === "chart_change") {
        editorCollapsed.value = true;
        chartCollapsed.value = false;
        resultsCollapsed.value = true;
      }
    } else if (savedPaneState.value != null) {
      editorCollapsed.value = savedPaneState.value.editor;
      chartCollapsed.value = savedPaneState.value.chart;
      resultsCollapsed.value = savedPaneState.value.results;
      savedPaneState.value = null;
    }
  },
);

function routeQueryId(): number | null {
  const raw = route.params.queryId;
  if (raw == null || raw === "") return null;
  const id = Number(Array.isArray(raw) ? raw[0] : raw);
  return Number.isFinite(id) && id > 0 ? id : null;
}

/**
 * Deep link: /workspace/q/:queryId[/:slug] opens that saved query and runs
 * its visualization (openQuery = load + execute + chart).
 */
async function openQueryFromRoute() {
  const id = routeQueryId();
  if (id == null) return;
  if (ws.savedQueries.length === 0) return;
  const q = ws.savedQueries.find((x) => x.id === id);
  if (!q) {
    console.warn(`Deep link: query #${id} not found`);
    return;
  }
  // Already showing this query with results/chart — just normalize the URL.
  if (ws.activeQueryId === id && lastRoutedQueryId === id) {
    ensureQueryUrl(q.id, q.name);
    return;
  }
  syncingFromRoute = true;
  lastRoutedQueryId = id;
  try {
    await ws.openQuery(q);
    ensureQueryUrl(q.id, q.name);
  } catch (err) {
    console.warn(err);
  } finally {
    syncingFromRoute = false;
  }
}

function ensureQueryUrl(id: number, name: string) {
  const target = queryPath(id, name);
  if (route.fullPath !== target && route.path !== target) {
    // Prefer replace so browsing queries doesn't flood history.
    void router.replace(target);
  }
}

// Keep the address bar in sync when the user opens a query from the sidebar.
watch(
  () => ws.activeQueryId,
  (id) => {
    if (syncingFromRoute) return;
    if (id == null) {
      lastRoutedQueryId = null;
      if (route.name === "workspace-query") {
        void router.replace({ name: "workspace" });
      }
      return;
    }
    if (id === lastRoutedQueryId && route.name === "workspace-query") return;
    const q = ws.savedQueries.find((x) => x.id === id);
    lastRoutedQueryId = id;
    void router.replace(queryPath(id, q?.name));
  },
);

watch(
  () => [route.params.queryId, ws.savedQueries.length] as const,
  () => {
    void openQueryFromRoute();
  },
);

onMounted(async () => {
  if (!auth.token) {
    await router.push({ name: "login", query: { redirect: route.fullPath } });
    return;
  }
  try {
    await Promise.all([
      ws.loadConnections(),
      ws.loadSavedQueries(),
      ws.loadVisualizations(),
      ws.loadDashboards(),
      ws.loadFolders(),
      ws.loadChartTypes(),
      chat.loadConversations(),
    ]);
    await openQueryFromRoute();
  } catch (err) {
    console.warn(err);
  }
});
</script>

<template>
  <Splitpanes class="workspace" :horizontal="false">
    <Pane
      v-if="props.sidebarOpen !== false"
      :size="sidebarSize"
      :min-size="14"
      :max-size="40"
    >
      <ConnectionsPanel />
    </Pane>

    <Pane :size="centerSize" :min-size="30">
      <div class="stack">
        <section
          class="stack__pane"
          :class="{ 'stack__pane--collapsed': editorCollapsed }"
          :style="{ flex: editorFlex }"
        >
          <SqlEditor
            :collapsed="editorCollapsed"
            @toggle-collapse="editorCollapsed = !editorCollapsed"
          />
        </section>
        <section
          class="stack__pane stack__pane--chart"
          :class="{
            'stack__pane--collapsed': chartCollapsed,
            'stack__pane--fill': !chartCollapsed,
          }"
          :style="{ flex: chartFlex }"
        >
          <ChartPanel
            :collapsed="chartCollapsed"
            :layout-tick="layoutTick"
            @toggle-collapse="chartCollapsed = !chartCollapsed"
          />
        </section>
        <section
          class="stack__pane"
          :class="{ 'stack__pane--collapsed': resultsCollapsed }"
          :style="{ flex: resultsFlex }"
        >
          <ResultsTable
            :collapsed="resultsCollapsed"
            @toggle-collapse="resultsCollapsed = !resultsCollapsed"
          />
        </section>
      </div>
    </Pane>
  </Splitpanes>
</template>

<style scoped>
.workspace {
  height: 100%;
}
.stack {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg);
}
.stack__pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  border-bottom: 1px solid var(--border);
}
.stack__pane:last-child {
  border-bottom: none;
}
.stack__pane > * {
  flex: 1 1 0%;
  min-height: 0;
  min-width: 0;
}
.stack__pane--collapsed {
  flex: 0 0 auto !important;
  min-height: auto;
}
.stack__pane--collapsed > * {
  flex: 0 0 auto;
}
/* Chart is the primary grow target in the stack — claim free space. */
.stack__pane--fill {
  flex: 1 1 0% !important;
  min-height: 0;
}
</style>
