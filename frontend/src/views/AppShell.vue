<script setup lang="ts">
import { ref } from "vue";
import { RouterView } from "vue-router";
import TopBar from "@/components/TopBar.vue";

const sidebarOpen = ref(true);
const chatOpen = ref(true);
</script>

<template>
  <div class="shell">
    <TopBar v-model:sidebar-open="sidebarOpen" v-model:chat-open="chatOpen" />
    <div class="shell__body">
      <RouterView v-slot="{ Component }">
        <component
          :is="Component"
          v-model:sidebarOpen="sidebarOpen"
          v-model:chatOpen="chatOpen"
        />
      </RouterView>
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
}
</style>
