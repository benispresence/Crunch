<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import { useChatStore } from "@/stores/chat";
import ChatMessage from "./ChatMessage.vue";

const chat = useChatStore();
const input = ref("");
const scroller = ref<HTMLDivElement | null>(null);
const textarea = ref<HTMLTextAreaElement | null>(null);

onMounted(() => textarea.value?.focus());

watch(
  () => chat.turns.map((t) => t.text.length + t.thinking.length + t.toolCalls.length).join("|"),
  () => {
    nextTick(() => {
      if (scroller.value) scroller.value.scrollTop = scroller.value.scrollHeight;
    });
  },
);

async function send() {
  const text = input.value.trim();
  if (!text) return;
  input.value = "";
  resize();
  await chat.send(text);
}

function onKey(e: KeyboardEvent) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

function resize() {
  const el = textarea.value;
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
}
</script>

<template>
  <section class="chat">
    <header class="chat__head">
      <div class="chat__title">
        <span class="chat__dot" />
        <span>Assistant</span>
      </div>
      <div class="chat__head-actions">
        <button
          class="btn btn-ghost btn-sm"
          :class="{ 'chat__toggle--on': chat.showThinking }"
          @click="chat.showThinking = !chat.showThinking"
          :title="chat.showThinking ? 'Hide thinking' : 'Show thinking'"
        >
          {{ chat.showThinking ? "Thinking on" : "Thinking off" }}
        </button>
        <button class="btn btn-ghost btn-sm" @click="chat.newConversation">New</button>
      </div>
    </header>

    <div ref="scroller" class="chat__scroll">
      <div v-if="chat.turns.length === 0" class="chat__empty">
        <div class="chat__empty-logo">N</div>
        <h2 class="chat__empty-title">How can I help with your data?</h2>
        <p class="chat__empty-sub">
          I can read your schema, write SQL, run queries, and chart the results.
        </p>
        <div class="chat__suggestions">
          <button
            v-for="s in [
              'Show me the tables in my main connection',
              'Top 10 customers by revenue this month',
              'Plot daily signups over the last 90 days',
            ]"
            :key="s"
            class="chat__suggestion"
            @click="input = s; send()"
          >
            {{ s }}
          </button>
        </div>
      </div>

      <ChatMessage v-for="turn in chat.turns" :key="turn.id" :turn="turn" />
    </div>

    <footer class="chat__compose">
      <div class="chat__input-wrap">
        <textarea
          ref="textarea"
          v-model="input"
          rows="1"
          placeholder="Ask anything…"
          @input="resize"
          @keydown="onKey"
        />
        <button
          v-if="chat.sending"
          class="btn btn-primary chat__send chat__send--stop"
          title="Stop"
          @click="chat.stop"
        >
          <svg width="12" height="12" viewBox="0 0 12 12">
            <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" />
          </svg>
        </button>
        <button
          v-else
          class="btn btn-primary chat__send"
          :disabled="!input.trim()"
          title="Send"
          @click="send"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
            <path d="M2 8 L14 8 M9 3 L14 8 L9 13" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
        </button>
      </div>
      <div class="chat__hint">
        <span v-if="chat.sending">Streaming… click ▪ to stop</span>
        <span v-else>Enter to send · Shift+Enter for newline</span>
      </div>
    </footer>
  </section>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
}
.chat__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  flex-shrink: 0;
}
.chat__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-serif);
  font-size: 14px;
  font-weight: 500;
}
.chat__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
}
.chat__head-actions { display: flex; gap: 4px; }
.chat__toggle--on { color: var(--accent); }

.chat__scroll {
  flex: 1;
  overflow-y: auto;
  scroll-behavior: smooth;
}

.chat__empty {
  padding: 48px 24px;
  text-align: center;
  color: var(--fg-muted);
}
.chat__empty-logo {
  width: 40px;
  height: 40px;
  border-radius: 12px;
  background: var(--accent);
  color: #1a1815;
  display: grid;
  place-items: center;
  margin: 0 auto 16px;
  font-weight: 700;
  font-family: var(--font-serif);
  font-size: 20px;
}
.chat__empty-title {
  font-family: var(--font-serif);
  font-size: 22px;
  font-weight: 500;
  margin: 0 0 6px;
  color: var(--fg);
  letter-spacing: -0.01em;
}
.chat__empty-sub { font-size: 13px; margin: 0 0 24px; }
.chat__suggestions {
  display: grid;
  gap: 8px;
  max-width: 320px;
  margin: 0 auto;
}
.chat__suggestion {
  text-align: left;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  color: var(--fg-muted);
  font-size: 13px;
  cursor: pointer;
  transition: border-color 150ms, color 150ms, background 150ms;
}
.chat__suggestion:hover {
  border-color: var(--accent-border);
  color: var(--fg);
  background: var(--accent-subtle);
}

.chat__compose {
  padding: 10px 12px 12px;
  border-top: 1px solid var(--border);
  background: var(--bg-elev);
  flex-shrink: 0;
}
.chat__input-wrap {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 8px;
  align-items: end;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg);
  padding: 6px 6px 6px 12px;
  transition: border-color 120ms;
}
.chat__input-wrap:focus-within { border-color: var(--accent-border); }
.chat__input-wrap textarea {
  border: 0;
  background: transparent;
  resize: none;
  padding: 6px 0;
  min-height: 22px;
  max-height: 180px;
  font-size: 14px;
  line-height: 1.45;
}
.chat__input-wrap textarea:focus { border: 0; }
.chat__send {
  height: 32px;
  width: 32px;
  padding: 0;
  display: grid;
  place-items: center;
  border-radius: 8px;
}
.chat__send:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.chat__send--stop {
  background: var(--error);
  border-color: var(--error);
  color: #1a1815;
}
.chat__send--stop:hover {
  background: var(--error);
  border-color: var(--error);
  filter: brightness(1.08);
}
.chat__spin {
  width: 12px;
  height: 12px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.chat__hint {
  margin-top: 6px;
  text-align: center;
  font-size: 11px;
  color: var(--fg-subtle);
}
</style>
