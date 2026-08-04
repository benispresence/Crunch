<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useChatStore } from "@/stores/chat";
import ChatMessage from "./ChatMessage.vue";
import CookieLoader from "./CookieLoader.vue";

const chat = useChatStore();
const input = ref("");
const scroller = ref<HTMLDivElement | null>(null);
const textarea = ref<HTMLTextAreaElement | null>(null);
const showHistory = ref(false);

const modelMenuOpen = ref(false);

onMounted(async () => {
  textarea.value?.focus();
  await Promise.all([chat.loadConversations(), chat.loadModels()]);
});

const EFFORT_HINT: Record<string, string> = {
  low: "Fastest and cheapest. Short, scoped tasks.",
  medium: "Balanced. Good for routine analysis.",
  high: "Default. Best for most real work.",
  xhigh: "Deeper reasoning. Complex or agentic tasks.",
  max: "Maximum depth. Slow and expensive.",
};

function pickModel(id: string) {
  chat.setModel(id);
  modelMenuOpen.value = false;
}

function formatWhen(ts: number): string {
  const d = new Date(ts * 1000);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

async function pickConversation(id: number) {
  showHistory.value = false;
  await chat.openConversation(id);
}

const currentConversation = computed(() =>
  chat.conversations.find((c) => c.id === chat.conversationId) ?? null,
);

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
        <span class="chat__title-name">
          {{ currentConversation?.title || "Assistant" }}
        </span>
      </div>
      <div class="chat__head-actions">
        <button
          class="btn btn-ghost btn-sm"
          :class="{ 'chat__toggle--on': showHistory }"
          @click="showHistory = !showHistory"
          :title="`${chat.conversations.length} past conversations`"
        >
          History
          <span v-if="chat.conversations.length" class="chat__count">{{ chat.conversations.length }}</span>
        </button>
        <button
          class="btn btn-ghost btn-sm"
          :class="{ 'chat__toggle--on': chat.showThinking }"
          @click="chat.showThinking = !chat.showThinking"
          :title="chat.showThinking ? 'Hide thinking' : 'Show thinking'"
        >
          Thinking
        </button>
        <button
          class="btn btn-ghost btn-sm"
          :class="{ 'chat__auto--on': chat.autoAccept }"
          :title="chat.autoAccept ? 'Auto-accept ON — proposals apply immediately' : 'Auto-accept OFF — review every proposal'"
          @click="chat.setAutoAccept(!chat.autoAccept)"
        >
          <span class="chat__auto-dot" :class="{ 'chat__auto-dot--on': chat.autoAccept }" />
          {{ chat.autoAccept ? "Auto" : "Review" }}
        </button>
        <button class="btn btn-ghost btn-sm" @click="chat.newConversation">+ New</button>
      </div>
    </header>

    <aside v-if="showHistory" class="chat__history">
      <div class="chat__history-head">
        <span>Past conversations</span>
        <button class="btn btn-ghost btn-sm" @click="showHistory = false">Close</button>
      </div>
      <ul v-if="chat.conversations.length > 0" class="chat__history-list">
        <li
          v-for="c in chat.conversations"
          :key="c.id"
          :class="{ 'chat__history-item--active': chat.conversationId === c.id }"
          class="chat__history-item"
          @click="pickConversation(c.id)"
        >
          <span class="chat__history-title" :title="c.title || `Conversation #${c.id}`">
            {{ c.title || `Conversation #${c.id}` }}
          </span>
          <span class="chat__history-when">{{ formatWhen(c.updated_at) }}</span>
        </li>
      </ul>
      <p v-else class="chat__history-empty">No conversations yet. Send a message to start one.</p>
    </aside>

    <div ref="scroller" class="chat__scroll">
      <div v-if="chat.turns.length === 0" class="chat__empty">
        <img src="/logo.png" alt="Crunch" class="chat__empty-logo" />
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
      <div
        v-if="chat.sending && chat.turns.length > 0 && chat.turns[chat.turns.length - 1]?.role === 'user'"
        class="chat__crunch"
      >
        <CookieLoader label="Crunching…" size="sm" />
      </div>
    </div>

    <footer class="chat__compose">
      <p v-for="(n, i) in chat.notices" :key="`n-${i}`" class="chat__notice">{{ n }}</p>

      <div v-if="chat.models.length > 0" class="chat__run">
        <div class="chat__model">
          <button
            class="chat__run-btn"
            :title="chat.activeModel?.blurb"
            @click="modelMenuOpen = !modelMenuOpen"
          >
            {{ chat.activeModel?.label ?? "Model" }}
            <span class="chat__run-chev" :class="{ 'chat__run-chev--open': modelMenuOpen }">▾</span>
          </button>
          <div v-if="modelMenuOpen" class="chat__model-menu">
            <button
              v-for="m in chat.models"
              :key="m.id"
              class="chat__model-item"
              :class="{ 'chat__model-item--active': m.id === chat.model }"
              @click="pickModel(m.id)"
            >
              <span class="chat__model-name">{{ m.label }}</span>
              <span class="chat__model-blurb">{{ m.blurb }}</span>
            </button>
          </div>
        </div>

        <!-- Effort levels differ per model, and some models have none at all. -->
        <label v-if="(chat.activeModel?.efforts.length ?? 0) > 0" class="chat__effort">
          <span>Effort</span>
          <select
            :value="chat.effort ?? chat.activeModel?.default_effort ?? ''"
            :title="EFFORT_HINT[chat.effort ?? chat.activeModel?.default_effort ?? 'high']"
            @change="chat.setEffort(($event.target as HTMLSelectElement).value as any)"
          >
            <option v-for="e in chat.activeModel!.efforts" :key="e" :value="e">{{ e }}</option>
          </select>
        </label>
        <span v-else class="chat__effort-none" title="This model has no effort control">
          no effort control
        </span>
      </div>

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
        <span v-if="chat.sending" class="chat__hint-crunch">
          <CookieLoader label="" size="sm" />
          Streaming… click ▪ to stop
        </span>
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
  min-height: 0;
  min-width: 0;
  width: 100%;
  background: var(--bg);
  /* Border comes from AppShell.shell__chat when mounted globally. */
  container-type: inline-size;
  container-name: chat;
}
.chat__head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 8px;
  padding: 8px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  flex-shrink: 0;
  min-width: 0;
}
.chat__title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-family: var(--font-serif);
  font-size: 14px;
  font-weight: 500;
  min-width: 0;
  flex: 1 1 auto;
}
.chat__dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
}
.chat__head-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 2px;
  align-items: center;
  justify-content: flex-end;
  flex: 0 1 auto;
  min-width: 0;
}
.chat__head-actions .btn {
  font-size: 11px;
  padding: 3px 7px;
}
.chat__toggle--on { color: var(--accent); }
.chat__auto--on { color: var(--error); }
.chat__auto-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--fg-subtle);
  display: inline-block;
  margin-right: 2px;
}
.chat__auto-dot--on { background: var(--error); box-shadow: 0 0 6px var(--error); }
.chat__title-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
  max-width: min(220px, 40vw);
}
.chat__count {
  font-size: 10px;
  background: var(--bg);
  color: var(--fg-subtle);
  padding: 0 5px;
  border-radius: 999px;
  margin-left: 4px;
}
.chat__history {
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  max-height: 280px;
  overflow-y: auto;
  flex-shrink: 0;
}
.chat__history-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  border-bottom: 1px solid var(--border);
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--fg-subtle);
}
.chat__history-list {
  list-style: none;
  padding: 4px;
  margin: 0;
  display: grid;
  gap: 1px;
}
.chat__history-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--fg);
  cursor: pointer;
}
.chat__history-item:hover { background: var(--bg-hover); }
.chat__history-item--active {
  background: var(--accent-subtle);
  color: var(--accent);
}
.chat__history-title {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chat__history-when { color: var(--fg-subtle); font-size: 11px; flex-shrink: 0; }
.chat__history-empty {
  margin: 0;
  padding: 14px 16px;
  color: var(--fg-subtle);
  font-size: 12px;
  text-align: center;
}

.chat__scroll {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  scroll-behavior: smooth;
  min-width: 0;
}

.chat__empty {
  padding: clamp(24px, 8vh, 48px) clamp(14px, 4vw, 24px);
  text-align: center;
  color: var(--fg-muted);
  max-width: 420px;
  margin: 0 auto;
}
.chat__empty-logo {
  width: clamp(64px, 22vw, 100px);
  height: clamp(64px, 22vw, 100px);
  object-fit: contain;
  display: block;
  margin: 0 auto 16px;
  opacity: 0.95;
}
.chat__empty-title {
  font-family: var(--font-serif);
  font-size: clamp(18px, 4.2vw, 22px);
  font-weight: 500;
  margin: 0 0 8px;
  color: var(--fg);
  letter-spacing: -0.01em;
  line-height: 1.25;
}
.chat__empty-sub {
  font-size: 13px;
  line-height: 1.5;
  margin: 0 0 20px;
}
.chat__suggestions {
  display: grid;
  gap: 8px;
  width: 100%;
  max-width: 340px;
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
.chat__notice {
  margin: 0 0 6px;
  font-size: 11px;
  color: var(--warn);
  line-height: 1.4;
}
.chat__run {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  flex-wrap: wrap;
}
.chat__model { position: relative; }
.chat__run-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  color: var(--fg-muted);
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 999px;
  cursor: pointer;
}
.chat__run-btn:hover { color: var(--fg); border-color: var(--accent-border); }
.chat__run-chev { font-size: 9px; transition: transform 150ms; }
.chat__run-chev--open { transform: rotate(180deg); }
.chat__model-menu {
  position: absolute;
  bottom: calc(100% + 4px);
  left: 0;
  z-index: 40;
  min-width: 280px;
  max-height: 320px;
  overflow-y: auto;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
  padding: 4px;
  display: grid;
  gap: 1px;
}
.chat__model-item {
  display: grid;
  gap: 2px;
  text-align: left;
  background: transparent;
  border: none;
  padding: 7px 9px;
  border-radius: 4px;
  cursor: pointer;
  color: var(--fg);
}
.chat__model-item:hover { background: var(--bg-hover); }
.chat__model-item--active { background: var(--accent-subtle); }
.chat__model-item--active .chat__model-name { color: var(--accent); }
.chat__model-name { font-size: 12px; }
.chat__model-blurb { font-size: 10.5px; color: var(--fg-subtle); line-height: 1.35; }
.chat__effort {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--fg-subtle);
}
.chat__effort select {
  font-size: 11px;
  padding: 2px 5px;
  border-radius: var(--radius-sm);
}
.chat__effort-none {
  font-size: 10.5px;
  color: var(--fg-subtle);
  font-style: italic;
}
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
.chat__hint-crunch {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.chat__crunch {
  padding: 8px 14px 12px;
  display: flex;
  justify-content: flex-start;
}
</style>
