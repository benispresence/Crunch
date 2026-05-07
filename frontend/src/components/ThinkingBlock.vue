<script setup lang="ts">
import { ref, watch } from "vue";
import type { ChatTurn } from "@/stores/chat";

const props = defineProps<{ turn: ChatTurn }>();
const expanded = ref(false);

watch(
  () => props.turn.status,
  (s) => {
    if (s === "done") expanded.value = false;
  },
);
</script>

<template>
  <div v-if="turn.thinking" class="thinking" :class="{ 'thinking--live': turn.status === 'streaming' }">
    <button class="thinking__head" type="button" @click="expanded = !expanded">
      <span class="thinking__dot" />
      <span class="thinking__label">
        {{ turn.status === "streaming" ? "Thinking" : "Thought" }}
      </span>
      <span class="thinking__hint">{{ expanded ? "hide" : "show" }}</span>
    </button>
    <div v-if="expanded" class="thinking__body">{{ turn.thinking }}</div>
  </div>
</template>

<style scoped>
.thinking {
  border-left: 2px solid var(--border-strong);
  padding-left: 10px;
  margin: 4px 0 10px;
}
.thinking--live { border-left-color: var(--accent); }
.thinking__head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 0;
  color: var(--fg-muted);
  font-size: 12px;
}
.thinking__dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--border-strong);
}
.thinking--live .thinking__dot {
  background: var(--accent);
  animation: thinkingPulse 1.4s ease-in-out infinite;
}
.thinking__label { font-weight: 500; }
.thinking__hint { color: var(--fg-subtle); font-size: 11px; margin-left: 4px; }
.thinking__body {
  margin-top: 6px;
  font-family: var(--font-serif);
  font-style: italic;
  color: var(--fg-muted);
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  max-height: 240px;
  overflow: auto;
  padding-right: 6px;
}

@keyframes thinkingPulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.3; transform: scale(1.6); }
}
</style>
