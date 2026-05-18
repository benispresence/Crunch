<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { bindCopyButtons, renderMarkdown } from "@/composables/markdown";
import type { ChatTurn } from "@/stores/chat";
import { useWorkspaceStore } from "@/stores/workspace";
import ProposalCard from "./ProposalCard.vue";
import ThinkingBlock from "./ThinkingBlock.vue";
import ToolCallList from "./ToolCallList.vue";

const props = defineProps<{ turn: ChatTurn }>();
const ws = useWorkspaceStore();
const bodyEl = ref<HTMLDivElement | null>(null);

const html = computed(() => renderMarkdown(props.turn.text || ""));

const proposal = computed(() => {
  const m = props.turn.text.match(/```sql[^\n]*\n([\s\S]*?)```/);
  if (m && /-- proposed/i.test(m[0])) return m[1]!.trim();
  return null;
});

/**
 * Show every resolved proposal plus the first pending one. Future pending
 * proposals stay hidden until the user clicks through the current one.
 */
const visibleProposals = computed(() => {
  const out: typeof props.turn.proposals = [];
  for (const rec of props.turn.proposals) {
    out.push(rec);
    if (rec.status === "pending") break;
  }
  return out;
});

const hiddenPendingCount = computed(
  () => props.turn.proposals.length - visibleProposals.value.length,
);

const errorKind = computed(() => {
  const e = props.turn.error ?? "";
  if (/invalid x-api-key|authentication_error|unauthor/i.test(e)) return "api_key";
  if (/quota|insufficient|rate_limit/i.test(e)) return "rate";
  if (/not configured/i.test(e)) return "not_configured";
  return "generic";
});
const errorHeadline = computed(() => {
  switch (errorKind.value) {
    case "api_key":
      return "Anthropic rejected the API key";
    case "not_configured":
      return "No Anthropic API key configured";
    case "rate":
      return "Anthropic rate/quota limit hit";
    default:
      return "Request failed";
  }
});

watch(
  html,
  () => {
    nextTick(() => {
      if (bodyEl.value) bindCopyButtons(bodyEl.value);
    });
  },
  { immediate: true },
);
</script>

<template>
  <article class="msg" :class="`msg--${turn.role}`">
    <div class="msg__avatar" :title="turn.role">
      <span v-if="turn.role === 'assistant'">N</span>
      <span v-else>·</span>
    </div>

    <div class="msg__body">
      <ThinkingBlock v-if="turn.role === 'assistant'" :turn="turn" />
      <ToolCallList v-if="turn.role === 'assistant'" :turn="turn" />

      <!--
        Sequential gating: show every resolved proposal plus the first
        pending one. The next pending proposal only reveals after the
        current one has been accepted, rejected, or errored — so the
        user clicks through one decision at a time.
      -->
      <ProposalCard
        v-for="rec in visibleProposals"
        :key="rec.id"
        :record="rec"
        :turn-id="turn.id"
      />
      <div
        v-if="hiddenPendingCount > 0"
        class="msg__queue"
        :title="`${hiddenPendingCount} more proposal(s) waiting`"
      >
        + {{ hiddenPendingCount }} more proposal{{ hiddenPendingCount === 1 ? "" : "s" }} after this one
      </div>

      <div
        v-if="turn.text"
        ref="bodyEl"
        class="msg__prose"
        v-html="html"
      />

      <div v-else-if="turn.role === 'assistant' && turn.status === 'streaming'" class="msg__cursor">
        <span /><span /><span />
      </div>

      <div v-if="turn.status === 'stopped'" class="msg__stopped">
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" fill="currentColor" />
        </svg>
        <span>Stopped by you.</span>
      </div>

      <div v-if="turn.error" class="msg__error" role="alert">
        <div class="msg__error-head">
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" />
            <path d="M8 4.5v4M8 11v.5" stroke="currentColor" stroke-linecap="round" />
          </svg>
          <strong>{{ errorHeadline }}</strong>
        </div>
        <div class="msg__error-body">{{ turn.error }}</div>
        <div v-if="errorKind === 'api_key' || errorKind === 'not_configured'" class="msg__error-action">
          Fix it in
          <RouterLink to="/admin" class="msg__error-link">Admin → Settings</RouterLink>.
        </div>
      </div>

      <div v-if="proposal && turn.role === 'assistant' && turn.status === 'done'" class="msg__accept">
        <button class="btn btn-sm" @click="ws.proposeSql(proposal)">Open in editor for review</button>
      </div>
    </div>
  </article>
</template>

<style scoped>
.msg {
  display: grid;
  grid-template-columns: 28px 1fr;
  gap: 12px;
  padding: 14px 16px;
}
.msg--user { background: var(--bg-elev); }
.msg__avatar {
  width: 28px;
  height: 28px;
  border-radius: 8px;
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 13px;
  font-family: var(--font-serif);
  background: var(--bg-elev-2);
  color: var(--fg-muted);
}
.msg--assistant .msg__avatar {
  background: var(--accent);
  color: #1a1815;
}
.msg__body { min-width: 0; }

.msg__prose {
  font-size: 14px;
  line-height: 1.65;
  color: var(--fg);
  word-wrap: break-word;
}
.msg__prose :deep(p) { margin: 0 0 10px; }
.msg__prose :deep(p:last-child) { margin-bottom: 0; }
.msg__prose :deep(strong) { font-weight: 600; color: var(--fg); }
.msg__prose :deep(ul),
.msg__prose :deep(ol) { margin: 6px 0 10px; padding-left: 22px; }
.msg__prose :deep(li) { margin: 4px 0; }
.msg__prose :deep(h1),
.msg__prose :deep(h2),
.msg__prose :deep(h3) {
  font-family: var(--font-serif);
  font-weight: 500;
  margin: 16px 0 8px;
  letter-spacing: -0.01em;
}
.msg__prose :deep(h1) { font-size: 20px; }
.msg__prose :deep(h2) { font-size: 17px; }
.msg__prose :deep(h3) { font-size: 15px; }
.msg__prose :deep(blockquote) {
  margin: 8px 0;
  padding: 6px 12px;
  border-left: 3px solid var(--accent);
  color: var(--fg-muted);
  font-style: italic;
}
.msg__prose :deep(.inline-code) {
  font-family: var(--font-mono);
  font-size: 0.88em;
  background: var(--code-bg);
  border: 1px solid var(--code-border);
  padding: 1px 5px;
  border-radius: 4px;
  color: var(--code-fg);
}
.msg__prose :deep(a) { color: var(--accent); text-decoration: none; }
.msg__prose :deep(a:hover) { text-decoration: underline; }
.msg__prose :deep(table) {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
  margin: 8px 0;
}
.msg__prose :deep(th),
.msg__prose :deep(td) {
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  text-align: left;
}

/* Code blocks (Anthropic style) */
.msg__prose :deep(.code-block) {
  margin: 12px 0;
  border: 1px solid var(--code-border);
  border-radius: var(--radius);
  background: var(--code-bg);
  overflow: hidden;
}
.msg__prose :deep(.code-block__header) {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 12px;
  background: var(--bg-elev-2);
  border-bottom: 1px solid var(--code-border);
}
.msg__prose :deep(.code-block__lang) {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--fg-muted);
  text-transform: lowercase;
}
.msg__prose :deep(.code-block__copy) {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  color: var(--fg-muted);
  background: transparent;
  border: 1px solid transparent;
  cursor: pointer;
}
.msg__prose :deep(.code-block__copy:hover) {
  color: var(--fg);
  border-color: var(--border);
}
.msg__prose :deep(.code-block__pre) {
  margin: 0;
  padding: 12px 14px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--code-fg);
  background: var(--code-bg);
}

.msg__cursor {
  display: inline-flex;
  gap: 3px;
  padding: 6px 0;
}
.msg__cursor span {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--fg-subtle);
  animation: dot 1.2s ease-in-out infinite;
}
.msg__cursor span:nth-child(2) { animation-delay: 0.2s; }
.msg__cursor span:nth-child(3) { animation-delay: 0.4s; }
@keyframes dot {
  0%, 100% { opacity: 0.2; transform: translateY(0); }
  50% { opacity: 1; transform: translateY(-2px); }
}
.msg__queue {
  margin: 4px 0;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  background: var(--bg-elev-2);
  border: 1px dashed var(--border);
  color: var(--fg-subtle);
  font-size: 11px;
  text-align: center;
}
.msg__error {
  margin-top: 10px;
  padding: 10px 12px;
  border-radius: var(--radius-sm);
  background: rgba(224, 122, 95, 0.1);
  border: 1px solid rgba(224, 122, 95, 0.45);
  border-left-width: 3px;
  color: var(--error);
  font-size: 13px;
  display: grid;
  gap: 6px;
}
.msg__error-head {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}
.msg__error-head svg { flex-shrink: 0; }
.msg__error-body {
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--fg-muted);
  white-space: pre-wrap;
  word-break: break-word;
}
.msg__error-action { font-size: 12px; color: var(--fg-muted); }
.msg__error-link {
  color: var(--accent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.msg__stopped {
  margin-top: 8px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 999px;
  background: var(--bg-elev-2);
  color: var(--fg-muted);
  font-size: 11px;
}
.msg__accept {
  margin-top: 10px;
  display: flex;
  gap: 8px;
}
</style>
