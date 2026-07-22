<script setup lang="ts">
import { Pane, Splitpanes } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { computed, onMounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import ChatPanel from "@/components/ChatPanel.vue";
import ChartPanel from "@/components/ChartPanel.vue";
import ConnectionsPanel from "@/components/ConnectionsPanel.vue";
import ResultsTable from "@/components/ResultsTable.vue";
import SqlEditor from "@/components/SqlEditor.vue";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";
import { useWorkspaceStore } from "@/stores/workspace";

const props = defineProps<{
  sidebarOpen?: boolean;
  chatOpen?: boolean;
  vizFullView?: boolean;
}>();

const auth = useAuthStore();
const router = useRouter();
const ws = useWorkspaceStore();
const chat = useChatStore();

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

// Horizontal Splitpanes sizes: recompute so the center column always fills
// whatever sidebar/chat leave open (100% when both are hidden).
const sidebarSize = computed(() => (compact.value ? 22 : 18));
const chatSize = computed(() => 22);
const centerSize = computed(() => {
  let size = 100;
  if (props.sidebarOpen !== false) size -= sidebarSize.value;
  if (props.chatOpen !== false) size -= chatSize.value;
  return Math.max(size, 30);
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

onMounted(async () => {
  if (!auth.token) {
    await router.push({ name: "login" });
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

    <Pane
      v-if="props.chatOpen !== false"
      :size="chatSize"
      :min-size="18"
      :max-size="45"
    >
      <ChatPanel />
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
