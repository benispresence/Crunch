<script setup lang="ts">
import { ref, watch } from "vue";
import { RouterView } from "vue-router";
import ChatPanel from "@/components/ChatPanel.vue";
import TopBar from "@/components/TopBar.vue";

const sidebarOpen = ref(true);
const chatOpen = ref(true);
// Workspace: hide chrome + collapse editor/results so the chart is full view.
const vizFullView = ref(false);

// Remember sidebar/chat before full view so we can restore them on exit.
const preFullViewChrome = ref<{ sidebar: boolean; chat: boolean } | null>(null);

watch(vizFullView, (full) => {
  if (full) {
    if (preFullViewChrome.value == null) {
      preFullViewChrome.value = {
        sidebar: sidebarOpen.value,
        chat: chatOpen.value,
      };
    }
    sidebarOpen.value = false;
    chatOpen.value = false;
  } else if (preFullViewChrome.value != null) {
    sidebarOpen.value = preFullViewChrome.value.sidebar;
    chatOpen.value = preFullViewChrome.value.chat;
    preFullViewChrome.value = null;
  }
});
</script>

<template>
  <div class="shell">
    <TopBar
      v-model:sidebar-open="sidebarOpen"
      v-model:chat-open="chatOpen"
      v-model:viz-full-view="vizFullView"
    />
    <div class="shell__body">
      <div class="shell__main">
        <RouterView v-slot="{ Component }">
          <component
            :is="Component"
            v-model:sidebarOpen="sidebarOpen"
            v-model:chatOpen="chatOpen"
            v-model:vizFullView="vizFullView"
          />
        </RouterView>
      </div>
      <!-- Chat is shell-level so the headbar toggle works on every page/URL. -->
      <aside v-if="chatOpen" class="shell__chat">
        <ChatPanel />
      </aside>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
}
.shell__body {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: row;
}
.shell__main {
  flex: 1 1 0%;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.shell__main > * {
  flex: 1 1 0%;
  min-height: 0;
  min-width: 0;
}
.shell__chat {
  flex: 0 0 clamp(280px, 26vw, 520px);
  min-width: 260px;
  max-width: min(560px, 42vw);
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
}
.shell__chat > * {
  flex: 1 1 0%;
  min-height: 0;
}
@media (max-width: 1100px) {
  .shell__chat {
    flex-basis: 28%;
    min-width: 220px;
  }
}
</style>
