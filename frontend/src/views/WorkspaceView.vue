<script setup lang="ts">
import { Pane, Splitpanes } from "splitpanes";
import "splitpanes/dist/splitpanes.css";
import { onMounted, ref } from "vue";
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

onMounted(async () => {
  if (!auth.token) {
    await router.push({ name: "login" });
    return;
  }
  try {
    await Promise.all([ws.loadConnections(), chat.loadConversations()]);
  } catch (err) {
    console.warn(err);
  }
});
</script>

<template>
  <Splitpanes class="workspace" :horizontal="false">
    <Pane v-if="props.sidebarOpen !== false" :size="compact ? 22 : 18" :min-size="14" :max-size="32">
      <ConnectionsPanel />
    </Pane>

    <Pane :size="props.chatOpen !== false ? (compact ? 48 : 52) : 80">
      <Splitpanes horizontal>
        <Pane :size="55" :min-size="20">
          <SqlEditor />
        </Pane>
        <Pane :size="45" :min-size="20">
          <Splitpanes>
            <Pane :size="60" :min-size="30">
              <ResultsTable />
            </Pane>
            <Pane :size="40" :min-size="20">
              <ChartPanel />
            </Pane>
          </Splitpanes>
        </Pane>
      </Splitpanes>
    </Pane>

    <Pane v-if="props.chatOpen !== false" :size="compact ? 30 : 30" :min-size="20" :max-size="50">
      <ChatPanel />
    </Pane>
  </Splitpanes>
</template>

<style scoped>
.workspace {
  height: 100%;
}
</style>
