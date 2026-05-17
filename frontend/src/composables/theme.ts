import { ref, watchEffect } from "vue";

export type Theme = "dark" | "light";
const KEY = "nicemeta.theme";

function detectInitial(): Theme {
  const stored = localStorage.getItem(KEY);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

const theme = ref<Theme>(detectInitial());

watchEffect(() => {
  document.documentElement.setAttribute("data-theme", theme.value);
  localStorage.setItem(KEY, theme.value);
});

export function useTheme() {
  return {
    theme,
    toggle() {
      theme.value = theme.value === "dark" ? "light" : "dark";
    },
    set(t: Theme) {
      theme.value = t;
    },
  };
}

export function applyThemeOnBoot() {
  document.documentElement.setAttribute("data-theme", theme.value);
}
