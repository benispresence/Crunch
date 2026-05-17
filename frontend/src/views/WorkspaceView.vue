<script setup lang="ts">
import { Pane, Splitpanes } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { computed, onMounted, ref } from "vue";
import { useRouter } from "vue-router";
import ChatPanel from "@/components/ChatPanel.vue";
import ChartPanel from "@/components/ChartPanel.vue";
import ConnectionsPanel from "@/components/ConnectionsPanel.vue";
import ResultsTable from "@/components/ResultsTable.vue";
import SqlEditor from "@/components/SqlEditor.vue";
import { useAuthStore } from "@/stores/auth";
import { useChatStore } from "@/stores/chat";
import { useWorkspaceStore } from "@/stores/workspace";

const props = defineProps<{ sidebarOpen?: boolean; chatOpen?: boolean }>();

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

// Flex ratios when open. Visualization gets the lion's share.
const editorFlex = computed(() => (editorCollapsed.value ? "0 0 auto" : "1 1 0"));
const chartFlex = computed(() => (chartCollapsed.value ? "0 0 auto" : "3 1 0"));
const resultsFlex = computed(() => (resultsCollapsed.value ? "0 0 auto" : "1 1 0"));

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
    <Pane v-if="props.sidebarOpen !== false" :size="compact ? 22 : 18" :min-size="14" :max-size="40">
      <ConnectionsPanel />
    </Pane>

    <Pane :size="props.chatOpen !== false ? (compact ? 56 : 60) : 82" :min-size="30">
      <div class="stack">
        <section class="stack__pane" :class="{ 'stack__pane--collapsed': editorCollapsed }" :style="{ flex: editorFlex }">
          <SqlEditor :collapsed="editorCollapsed" @toggle-collapse="editorCollapsed = !editorCollapsed" />
        </section>
        <section class="stack__pane stack__pane--chart" :class="{ 'stack__pane--collapsed': chartCollapsed }" :style="{ flex: chartFlex }">
          <ChartPanel :collapsed="chartCollapsed" @toggle-collapse="chartCollapsed = !chartCollapsed" />
        </section>
        <section class="stack__pane" :class="{ 'stack__pane--collapsed': resultsCollapsed }" :style="{ flex: resultsFlex }">
          <ResultsTable :collapsed="resultsCollapsed" @toggle-collapse="resultsCollapsed = !resultsCollapsed" />
        </section>
      </div>
    </Pane>

    <Pane v-if="props.chatOpen !== false" :size="compact ? 22 : 22" :min-size="18" :max-size="45">
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
  transition: flex 180ms ease;
}
.stack__pane:last-child {
  border-bottom: none;
}
.stack__pane--collapsed {
  flex: 0 0 auto !important;
}
</style>
