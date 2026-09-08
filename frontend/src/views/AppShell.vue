<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { RouterView } from "vue-router";
import ChatPanel from "@/components/ChatPanel.vue";
import TopBar from "@/components/TopBar.vue";

const sidebarOpen = ref(true);
const chatOpen = ref(true);
// Workspace: hide chrome + collapse editor/results so the chart is full view.
const vizFullView = ref(false);

// Remember sidebar/chat before full view so we can restore them on exit.
const preFullViewChrome = ref<{ sidebar: boolean; chat: boolean } | null>(null);

const CHAT_W_KEY = "nm_chat_width";
const CHAT_MIN = 260;
const CHAT_DEFAULT = 360;

function maxChatWidth() {
  if (typeof window === "undefined") return 720;
  // Keep the main area usable; allow a wide chat when the window is large.
  return Math.max(CHAT_MIN, Math.min(720, Math.floor(window.innerWidth * 0.55)));
}

function readChatWidth(): number {
  try {
    const n = Number(localStorage.getItem(CHAT_W_KEY));
    if (Number.isFinite(n) && n >= CHAT_MIN) return Math.min(n, maxChatWidth());
  } catch {
    /* ignore */
  }
  return Math.min(CHAT_DEFAULT, maxChatWidth());
}

const chatWidth = ref(readChatWidth());
const chatResizing = ref(false);

watch(chatOpen, (open) => {
  if (open) {
    // Clamp when reopening after a window resize.
    chatWidth.value = Math.min(Math.max(chatWidth.value, CHAT_MIN), maxChatWidth());
  }
});

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

function persistChatWidth() {
  try {
    localStorage.setItem(CHAT_W_KEY, String(Math.round(chatWidth.value)));
  } catch {
    /* ignore */
  }
}

/** Notify Plotly / layout observers that the main column size changed. */
function notifyLayout() {
  window.dispatchEvent(new Event("resize"));
}

function onChatResizeStart(e: PointerEvent) {
  if (e.button !== 0) return;
  e.preventDefault();
  const handle = e.currentTarget as HTMLElement;
  const startX = e.clientX;
  const startW = chatWidth.value;
  chatResizing.value = true;
  handle.setPointerCapture(e.pointerId);

  const onMove = (ev: PointerEvent) => {
    // Drag handle left → wider chat; right → narrower.
    const next = startW + (startX - ev.clientX);
    chatWidth.value = Math.min(maxChatWidth(), Math.max(CHAT_MIN, next));
  };
  const onUp = () => {
    chatResizing.value = false;
    handle.releasePointerCapture(e.pointerId);
    handle.removeEventListener("pointermove", onMove);
    handle.removeEventListener("pointerup", onUp);
    handle.removeEventListener("pointercancel", onUp);
    persistChatWidth();
    notifyLayout();
  };
  handle.addEventListener("pointermove", onMove);
  handle.addEventListener("pointerup", onUp);
  handle.addEventListener("pointercancel", onUp);
}

function onWindowResize() {
  chatWidth.value = Math.min(Math.max(chatWidth.value, CHAT_MIN), maxChatWidth());
}

onMounted(() => {
  window.addEventListener("resize", onWindowResize);
});
onBeforeUnmount(() => {
  window.removeEventListener("resize", onWindowResize);
});
</script>

<template>
  <div class="shell" :class="{ 'shell--resizing': chatResizing }">
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

      <!-- Chat is shell-level so the headbar toggle works on every page/URL.
           Drag the splitter to resize; width persists in localStorage. -->
      <template v-if="chatOpen">
        <div
          class="shell__splitter"
          role="separator"
          aria-orientation="vertical"
          aria-label="Resize chat panel"
          title="Drag to resize chat"
          @pointerdown="onChatResizeStart"
        />
        <aside
          class="shell__chat"
          :style="{ width: `${chatWidth}px`, flexBasis: `${chatWidth}px` }"
        >
          <ChatPanel />
        </aside>
      </template>
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
.shell--resizing {
  cursor: col-resize;
  user-select: none;
}
.shell--resizing * {
  cursor: col-resize !important;
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
.shell__splitter {
  flex: 0 0 6px;
  margin-left: -3px;
  margin-right: -3px;
  position: relative;
  z-index: 4;
  cursor: col-resize;
  touch-action: none;
  background: transparent;
}
.shell__splitter::before {
  content: "";
  position: absolute;
  inset: 0 2px;
  background: var(--border);
  opacity: 0;
  transition: opacity 150ms, background 150ms;
  border-radius: 2px;
}
.shell__splitter:hover::before,
.shell--resizing .shell__splitter::before {
  opacity: 1;
  background: var(--accent);
}
.shell__chat {
  flex: 0 0 auto;
  width: 360px;
  min-width: 260px;
  max-width: none;
  min-height: 0;
  display: flex;
  flex-direction: column;
  border-left: 1px solid var(--border);
  /* Keep proposal/message formatting stable while dragging. */
  overflow: hidden;
}
.shell__chat > * {
  flex: 1 1 0%;
  min-height: 0;
  min-width: 0;
  width: 100%;
}
</style>
