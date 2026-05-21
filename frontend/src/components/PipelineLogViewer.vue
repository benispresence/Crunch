<script setup lang="ts">
import { computed, ref, watch } from "vue";

/**
 * Pretty log viewer for a single pipeline run.
 *
 * Renders captured stdout/stderr with line numbers, a copy-all
 * button, a substring filter, and auto-scroll-to-bottom when new
 * lines arrive. Lines containing ERROR/WARN/Traceback are highlighted
 * so the eye finds the failure point fast.
 */

const props = defineProps<{
  log: string;
  status?: string | null;
  errorMessage?: string | null;
}>();

const filter = ref("");
const wrap = ref(true);
const autoscroll = ref(true);
const host = ref<HTMLDivElement | null>(null);

const lines = computed(() => {
  if (!props.log) return [] as { n: number; text: string; cls: string }[];
  const f = filter.value.trim().toLowerCase();
  const out: { n: number; text: string; cls: string }[] = [];
  const raw = props.log.split("\n");
  for (let i = 0; i < raw.length; i++) {
    const text = raw[i] ?? "";
    if (f && !text.toLowerCase().includes(f)) continue;
    out.push({ n: i + 1, text, cls: classify(text) });
  }
  return out;
});

function classify(text: string): string {
  // Lightweight log-level detection — enough to colour the eye-catching
  // lines without the cost of a real tokenizer.
  if (/\b(error|exception|failed|fatal|traceback)\b/i.test(text)) return "err";
  if (/\b(warn|warning|deprecated)\b/i.test(text)) return "warn";
  if (/\b(info|loaded|ok|success|started|finished)\b/i.test(text)) return "info";
  return "";
}

watch(
  () => props.log,
  () => {
    if (!autoscroll.value || !host.value) return;
    requestAnimationFrame(() => {
      host.value!.scrollTop = host.value!.scrollHeight;
    });
  },
);

function copy() {
  navigator.clipboard.writeText(props.log).catch(() => {});
}
</script>

<template>
  <div class="lv">
    <header class="lv__head">
      <div class="lv__meta">
        <span v-if="status" class="lv__status" :class="`lv__status--${status}`">{{ status }}</span>
        <span class="lv__count">{{ log.split("\n").length }} lines</span>
      </div>
      <div class="lv__tools">
        <input
          v-model="filter"
          class="lv__filter"
          placeholder="Filter… (substring)"
        />
        <label class="lv__opt">
          <input v-model="wrap" type="checkbox" />
          <span>Wrap</span>
        </label>
        <label class="lv__opt">
          <input v-model="autoscroll" type="checkbox" />
          <span>Follow</span>
        </label>
        <button class="btn btn-sm" @click="copy">Copy</button>
      </div>
    </header>

    <p v-if="errorMessage" class="lv__error">{{ errorMessage }}</p>

    <div ref="host" class="lv__body" :class="{ 'lv__body--wrap': wrap }">
      <table v-if="lines.length > 0" class="lv__table">
        <tbody>
          <tr v-for="line in lines" :key="line.n" class="lv__row" :class="`lv__row--${line.cls}`">
            <td class="lv__num">{{ line.n }}</td>
            <td class="lv__text">{{ line.text || " " }}</td>
          </tr>
        </tbody>
      </table>
      <p v-else class="lv__empty">No log output{{ filter ? " matches your filter" : "" }}.</p>
    </div>
  </div>
</template>

<style scoped>
.lv {
  display: flex;
  flex-direction: column;
  min-height: 240px;
  max-height: 540px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  overflow: hidden;
}
.lv__head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
  gap: 8px;
  flex-shrink: 0;
}
.lv__meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--fg-subtle);
}
.lv__status {
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg);
  border: 1px solid var(--border);
}
.lv__status--success { background: rgba(127, 176, 105, 0.14); color: var(--success); border-color: transparent; }
.lv__status--failed { background: rgba(224, 122, 95, 0.14); color: var(--error); border-color: transparent; }
.lv__status--running { background: var(--accent-subtle); color: var(--accent); border-color: transparent; }
.lv__tools { display: flex; gap: 6px; align-items: center; }
.lv__filter {
  font-size: 12px;
  padding: 4px 8px;
  width: 180px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--fg);
  font-family: inherit;
}
.lv__opt { display: inline-flex; align-items: center; gap: 4px; font-size: 11px; color: var(--fg-muted); }
.lv__error {
  margin: 0;
  padding: 8px 12px;
  background: rgba(220, 80, 80, 0.08);
  color: var(--error);
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: pre-wrap;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.lv__body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  background: var(--code-bg);
  font-family: var(--font-mono);
  font-size: 12px;
}
.lv__body:not(.lv__body--wrap) .lv__text { white-space: pre; }
.lv__body--wrap .lv__text { white-space: pre-wrap; word-break: break-word; }
.lv__table { width: 100%; border-collapse: collapse; }
.lv__row { vertical-align: top; }
.lv__row--err { background: rgba(224, 122, 95, 0.07); }
.lv__row--warn { background: rgba(232, 176, 76, 0.07); }
.lv__row--info {}
.lv__num {
  width: 50px;
  text-align: right;
  padding: 1px 10px 1px 8px;
  color: var(--fg-subtle);
  user-select: none;
  font-variant-numeric: tabular-nums;
  border-right: 1px solid var(--border);
}
.lv__text {
  padding: 1px 10px;
  color: var(--code-fg);
}
.lv__row--err .lv__text { color: #e89b85; }
.lv__row--warn .lv__text { color: #d4a44e; }
.lv__empty {
  padding: 24px;
  text-align: center;
  color: var(--fg-subtle);
  font-size: 12px;
}
</style>
