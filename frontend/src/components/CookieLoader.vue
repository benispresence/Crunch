<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";

/**
 * ASCII chocolate-cookie loader: bites disappear in a loop (no avatar).
 * Use for chart/query loads and any other waiting state.
 */
const props = withDefaults(
  defineProps<{
    label?: string;
    /** sm = inline/toolbar; md = panel state; lg = chart canvas */
    size?: "sm" | "md" | "lg";
  }>(),
  {
    label: "Crunching…",
    size: "md",
  },
);

// Fixed-width frames so the layout doesn't jump. `@` = dough, `o`/`*` = chips,
// spaces = bitten-away. Each full frame is 12×6 characters.
const FRAMES = [
  [
    "  .@@@@@@@. ",
    " @o@@*@@@@@ ",
    "@@@@o@@@@@@@",
    "@@@@@@o@@@@@",
    " @@*@@@@o@@ ",
    "  .@@@@@@@. ",
  ],
  [
    "  .@@@@@    ",
    " @o@@*@@    ",
    "@@@@o@@@@@@ ",
    "@@@@@@o@@@@@",
    " @@*@@@@o@@ ",
    "  .@@@@@@@. ",
  ],
  [
    "  .@@@      ",
    " @o@@       ",
    "@@@@o@@@    ",
    "@@@@@@o@@@@ ",
    " @@*@@@@o@@ ",
    "  .@@@@@@@. ",
  ],
  [
    "            ",
    " @o         ",
    "@@@@        ",
    "@@@@@@o@@   ",
    " @@*@@@@o@  ",
    "  .@@@@@@@. ",
  ],
  [
    "            ",
    "            ",
    "  o         ",
    "@@@  o      ",
    " @@*@@@     ",
    "  .@@@@@.   ",
  ],
  [
    "            ",
    "            ",
    "            ",
    " o   .      ",
    "  . *  o    ",
    "   .  .     ",
  ],
  [
    "            ",
    "            ",
    "            ",
    "            ",
    "   .  .     ",
    "    .       ",
  ],
  [
    "            ",
    "            ",
    "            ",
    "            ",
    "            ",
    "            ",
  ],
] as const;

// One-line bite cycle for toolbar / button contexts.
const SM_FRAMES = [
  "(o@@*)",
  "(o@@ )",
  "(o@  )",
  "(o   )",
  "( .  )",
  "(  . )",
  "(    )",
  "( *  )",
] as const;

const frame = ref(0);
let timer: number | null = null;

onMounted(() => {
  timer = window.setInterval(() => {
    const len = props.size === "sm" ? SM_FRAMES.length : FRAMES.length;
    frame.value = (frame.value + 1) % len;
  }, 160);
});

onUnmounted(() => {
  if (timer != null) window.clearInterval(timer);
});
</script>

<template>
  <div
    class="cookie-loader"
    :class="`cookie-loader--${size}`"
    role="status"
    aria-live="polite"
    :aria-label="label || 'Loading'"
  >
    <pre v-if="size === 'sm'" class="cookie-loader__art" aria-hidden="true">{{ SM_FRAMES[frame % SM_FRAMES.length] }}</pre>
    <pre v-else class="cookie-loader__art" aria-hidden="true">{{ FRAMES[frame % FRAMES.length].join("\n") }}</pre>
    <span v-if="label" class="cookie-loader__label">{{ label }}</span>
  </div>
</template>

<style scoped>
.cookie-loader {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  user-select: none;
  pointer-events: none;
}
.cookie-loader__art {
  margin: 0;
  font-family: var(--font-mono);
  line-height: 1.05;
  letter-spacing: 0.02em;
  white-space: pre;
  color: var(--accent);
  text-shadow: 0 0 14px color-mix(in srgb, var(--accent) 35%, transparent);
}
.cookie-loader__label {
  font-size: 12px;
  color: var(--fg-muted);
  letter-spacing: 0.02em;
}

.cookie-loader--sm {
  flex-direction: row;
  gap: 6px;
}
.cookie-loader--sm .cookie-loader__art {
  font-size: 11px;
  line-height: 1;
  letter-spacing: 0.04em;
}
.cookie-loader--sm .cookie-loader__label {
  font-size: 11px;
}

.cookie-loader--md .cookie-loader__art {
  font-size: 11px;
}
.cookie-loader--md .cookie-loader__label {
  font-size: 12px;
}

.cookie-loader--lg .cookie-loader__art {
  font-size: 14px;
  line-height: 1.08;
}
.cookie-loader--lg .cookie-loader__label {
  font-size: 13px;
  color: var(--fg-subtle);
}

</style>
