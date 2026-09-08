import { shallowRef, watch } from "vue";
import { useTheme } from "./theme";

/**
 * Plotly theming.
 *
 * Figures reach the canvas from three independent places — the picker
 * renderer, user Python, and the agent — so none of them can be trusted to
 * know which theme is active. Two mechanisms cover that:
 *
 * 1. A **template** built from the live CSS custom properties. Everything a
 *    figure leaves unset (tick labels, grid, legend text, hover cards) is
 *    filled in per theme, so it flips light↔dark on toggle.
 *
 * 2. **Theme tokens** — `"$fg"`, `"$series2"`, `"$(light: #b4552f, dark:
 *    #e08a63)"` — usable anywhere a colour goes. They resolve at paint time
 *    against the active theme, so a figure can hardcode a colour and still
 *    have it flip. A figure can also declare its own named pairs in
 *    `layout.meta.crunch_theme` and reference them by name.
 *
 * Precedence for a given colour: figure's explicit value → theme token
 * resolution → template default. Nothing here is a compromise shade that has
 * to survive both backgrounds; each theme gets its own value.
 */

export interface PlotlyTemplate {
  layout: Record<string, unknown>;
  data?: Record<string, unknown>;
}

export interface PlotlySpec {
  data: unknown[];
  layout: Record<string, unknown>;
}

type Mode = "dark" | "light";

const { theme } = useTheme();

/** Fallbacks match :root in styles.css — used if the stylesheet hasn't landed yet. */
const FALLBACK: Record<string, string> = {
  "--bg": "#1a1815",
  "--bg-elev": "#211e1a",
  "--bg-elev-2": "#2a2622",
  "--border": "#36312b",
  "--border-strong": "#4a443c",
  "--fg": "#f5f1ec",
  "--fg-muted": "#a8a098",
  "--fg-subtle": "#6b655e",
  "--accent": "#d97757",
  "--success": "#7fb069",
  "--warn": "#e8b04c",
  "--error": "#e07a5f",
  "--info": "#7aa2c8",
  "--font-sans": "Inter, sans-serif",
};

/**
 * Categorical series, tuned per theme rather than shared. Dark mode gets
 * lifted, brighter hues; light mode gets deeper ones. Same hue order in both
 * so a chart keeps its identity across the toggle.
 */
const COLORWAY: Record<Mode, string[]> = {
  dark: [
    "#e08a63", // clay
    "#8fb8dd", // blue
    "#90c47c", // green
    "#f0bd5e", // amber
    "#c8a2d4", // purple
    "#7cc6bd", // teal
    "#de92a8", // rose
    "#a3aec4", // slate
  ],
  light: [
    "#b4552f",
    "#3c6f9e",
    "#4e7c3a",
    "#9a6f16",
    "#7d5490",
    "#2f7f75",
    "#a34a63",
    "#5a6479",
  ],
};

/** Semantic colours with no CSS variable of their own, per theme. */
const SEMANTIC: Record<Mode, Record<string, string>> = {
  dark: {
    success: "#90c47c",
    warn: "#f0bd5e",
    error: "#ef8f74",
    info: "#8fb8dd",
    positive: "#90c47c",
    negative: "#ef8f74",
  },
  light: {
    success: "#4e7c3a",
    warn: "#9a6f16",
    error: "#b34a30",
    info: "#3c6f9e",
    positive: "#4e7c3a",
    negative: "#b34a30",
  },
};

/**
 * Sequential ramps run low-contrast-against-background → high, so a heatmap's
 * "empty" end recedes into the canvas in either theme.
 */
const SEQUENTIAL: Record<Mode, Array<[number, string]>> = {
  dark: [
    [0, "#2b2521"],
    [0.25, "#6b3f30"],
    [0.5, "#a85a41"],
    [0.75, "#d97757"],
    [1, "#f0a888"],
  ],
  light: [
    [0, "#f7ece6"],
    [0.25, "#eab79f"],
    [0.5, "#dd8f6d"],
    [0.75, "#c25f3f"],
    [1, "#8f4028"],
  ],
};

const DIVERGING: Record<Mode, Array<[number, string]>> = {
  dark: [
    [0, "#8fb8dd"],
    [0.5, "#2a2622"],
    [1, "#e08a63"],
  ],
  light: [
    [0, "#3c6f9e"],
    [0.5, "#f3f0eb"],
    [1, "#b4552f"],
  ],
};

function currentMode(): Mode {
  return theme.value === "light" ? "light" : "dark";
}

/** The token table for the active theme: `$name` → colour. */
function buildTokens(): Record<string, string> {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim() || FALLBACK[n] || "";
  const mode = currentMode();

  const tokens: Record<string, string> = {
    fg: v("--fg"),
    "fg-muted": v("--fg-muted"),
    "fg-subtle": v("--fg-subtle"),
    bg: v("--bg"),
    "bg-elev": v("--bg-elev"),
    "bg-elev-2": v("--bg-elev-2"),
    border: v("--border"),
    "border-strong": v("--border-strong"),
    grid: v("--border"),
    accent: v("--accent"),
    ...SEMANTIC[mode],
  };
  COLORWAY[mode].forEach((c, i) => {
    tokens[`series${i}`] = c;
  });
  return tokens;
}

function buildTemplate(): PlotlyTemplate {
  const cs = getComputedStyle(document.documentElement);
  const v = (n: string) => cs.getPropertyValue(n).trim() || FALLBACK[n] || "";
  const mode = currentMode();

  const bg = v("--bg");
  const bgElev = v("--bg-elev");
  const bgElev2 = v("--bg-elev-2");
  const border = v("--border");
  const borderStrong = v("--border-strong");
  const fg = v("--fg");
  const fgMuted = v("--fg-muted");

  // Tick labels get --fg-muted, not --fg-subtle: subtle is a UI-chrome shade
  // and sits near 3:1 against the canvas, which is too weak to read numbers off.
  const axis = {
    gridcolor: border,
    zerolinecolor: borderStrong,
    linecolor: border,
    tickcolor: border,
    tickfont: { color: fgMuted, size: 10 },
    title: { font: { color: fg, size: 11 } },
    automargin: true,
  };

  return {
    layout: {
      // Transparent so the panel's own --bg shows through and the chart
      // never seams against the surrounding UI.
      paper_bgcolor: "rgba(0,0,0,0)",
      plot_bgcolor: "rgba(0,0,0,0)",
      font: { family: v("--font-sans"), color: fgMuted, size: 11 },
      title: { font: { color: fg, size: 13 }, x: 0, xanchor: "left" },
      colorway: COLORWAY[mode],
      xaxis: axis,
      yaxis: axis,
      legend: {
        font: { color: fgMuted, size: 11 },
        bgcolor: "rgba(0,0,0,0)",
        bordercolor: border,
      },
      hoverlabel: {
        bgcolor: bgElev,
        bordercolor: border,
        font: { color: fg, family: v("--font-sans"), size: 11 },
      },
      colorscale: {
        sequential: SEQUENTIAL[mode],
        sequentialminus: SEQUENTIAL[mode],
        diverging: DIVERGING[mode],
      },
      coloraxis: {
        colorbar: {
          outlinewidth: 0,
          tickfont: { color: fgMuted, size: 10 },
          title: { font: { color: fg, size: 11 } },
          bgcolor: "rgba(0,0,0,0)",
        },
      },
      annotationdefaults: { font: { color: fgMuted, size: 11 }, arrowcolor: fgMuted },
      shapedefaults: { line: { color: borderStrong } },
      // 3D / polar / geo subplots don't inherit plot_bgcolor.
      scene: {
        xaxis: { ...axis, backgroundcolor: bg, showbackground: false },
        yaxis: { ...axis, backgroundcolor: bg, showbackground: false },
        zaxis: { ...axis, backgroundcolor: bg, showbackground: false },
      },
      polar: { bgcolor: "rgba(0,0,0,0)", angularaxis: axis, radialaxis: axis },
      ternary: { bgcolor: "rgba(0,0,0,0)", aaxis: axis, baxis: axis, caxis: axis },
      geo: {
        bgcolor: "rgba(0,0,0,0)",
        landcolor: bgElev2,
        lakecolor: bg,
        subunitcolor: border,
      },
      autosize: true,
    },
    data: {
      // Tables have no axes to inherit from, so they need explicit fills.
      table: [
        {
          header: {
            fill: { color: bgElev2 },
            line: { color: border },
            font: { color: fg, size: 11 },
            align: "left",
          },
          cells: {
            fill: { color: "rgba(0,0,0,0)" },
            line: { color: border },
            font: { color: fgMuted, size: 11 },
            align: "left",
          },
        },
      ],
    },
  };
}

export const chartTemplate = shallowRef<PlotlyTemplate>(buildTemplate());
const themeTokens = shallowRef<Record<string, string>>(buildTokens());

/** Rebuild from the DOM — call after the stylesheet or theme changes. */
export function refreshChartTheme(): void {
  chartTemplate.value = buildTemplate();
  themeTokens.value = buildTokens();
}

// `flush: "post"` so the data-theme attribute set by useTheme() is already on
// <html> when we read the resolved custom properties back out.
watch(theme, refreshChartTheme, { flush: "post" });

// The module can initialise before styles.css lands (Vite injects it async in
// dev), in which case the first build used FALLBACK. Re-read once painted.
if (typeof requestAnimationFrame === "function") {
  requestAnimationFrame(refreshChartTheme);
}

/** Resolve one theme token for TS callers building their own traces. */
export function themeColor(token: string, fallback = "#888888"): string {
  return themeTokens.value[token.replace(/^\$/, "").replace(/_/g, "-")] ?? fallback;
}

/* -------------------------------------------------------------------------
 * Theme tokens
 * ---------------------------------------------------------------------- */

/** `$name` / `$name-with-dashes` — the whole string must be the token. */
const NAMED_TOKEN = /^\$([a-zA-Z][\w-]*)$/;
/** `$(light: #b4552f, dark: #e08a63)` — order-independent, spaces optional. */
const PAIR_TOKEN = /^\$\(\s*(.+?)\s*\)$/;

/**
 * Keys whose values are user-facing copy or format strings, never colours.
 * Skipped so a hovertemplate or a label that happens to start with `$` is
 * left alone.
 */
const TEXT_KEYS = new Set([
  "text",
  "texttemplate",
  "hovertemplate",
  "hovertext",
  "hoverinfo",
  "hoverformat",
  "customdata",
  "name",
  "legendgroup",
  "tickformat",
  "tickprefix",
  "ticksuffix",
  "ids",
  "labels",
  "meta",
]);

function resolveToken(
  value: string,
  mode: Mode,
  figurePalette: Record<string, string>,
): string {
  // Fast path. Traces carry tens of thousands of category/date strings; a
  // single charCode check keeps the walk off the regex engine for all of them.
  if (value.charCodeAt(0) !== 36 /* $ */) return value;

  const pair = PAIR_TOKEN.exec(value);
  if (pair) {
    // "light: #aaa, dark: #333" → pick the active side.
    for (const part of pair[1].split(",")) {
      const [k, ...rest] = part.split(":");
      if (k.trim().toLowerCase() === mode) return rest.join(":").trim();
    }
    return value;
  }
  const named = NAMED_TOKEN.exec(value);
  if (!named) return value;
  const key = named[1].replace(/_/g, "-");
  // Figure-declared names win over the built-ins, so a chart can rebind
  // "$accent" to its own brand colour without touching the app theme.
  return figurePalette[key] ?? themeTokens.value[key] ?? value;
}

/**
 * Deep-resolve tokens. Nodes containing none are returned by identity rather
 * than copied — that keeps the big x/y arrays reference-stable so Plotly.react
 * can skip redrawing them, and costs one comparison per element.
 */
function walk(node: unknown, mode: Mode, palette: Record<string, string>): unknown {
  if (typeof node === "string") return resolveToken(node, mode, palette);
  if (Array.isArray(node)) {
    let changed = false;
    const out = node.map((n) => {
      const r = walk(n, mode, palette);
      if (r !== n) changed = true;
      return r;
    });
    return changed ? out : node;
  }
  if (node && typeof node === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(node as Record<string, unknown>)) {
      const r = TEXT_KEYS.has(k) ? val : walk(val, mode, palette);
      if (r !== val) changed = true;
      out[k] = r;
    }
    return changed ? out : node;
  }
  return node;
}

/**
 * Read a figure's own two-theme palette.
 *
 * ```python
 * fig.layout.meta = {"crunch_theme": {
 *     "light": {"ehex": "#b4552f", "phex": "#6b4fa0"},
 *     "dark":  {"ehex": "#e08a63", "phex": "#c8a2d4"},
 * }}
 * # then reference it anywhere: line=dict(color="$ehex")
 * ```
 */
function figurePalette(layout: Record<string, unknown> | undefined, mode: Mode) {
  const meta = layout?.meta as Record<string, unknown> | undefined;
  const declared = meta?.crunch_theme as
    | Record<string, Record<string, string>>
    | undefined;
  if (!declared) return {};
  const out: Record<string, string> = {};
  // A "both" block holds names that don't vary; the active mode overrides it.
  for (const src of [declared.both, declared[mode]]) {
    if (src) for (const [k, v] of Object.entries(src)) out[k.replace(/_/g, "-")] = v;
  }
  return out;
}

/**
 * Merge a figure's layout with the active theme template.
 *
 * Precedence, lowest to highest: theme template → `base` (per-panel chrome
 * like margins) → the figure's own explicit layout.
 *
 * A figure that arrives carrying its own template (every `plotly.io.to_json`
 * output does) keeps that template's trace defaults, but its layout half is
 * overridden by ours — that's what neutralises a baked-in `plotly_white` or
 * `plotly_dark` without discarding the rest of the figure.
 */
export function themedLayout(
  specLayout?: Record<string, unknown> | null,
  base?: Record<string, unknown>,
): Record<string, unknown> {
  const mode = currentMode();
  const palette = figurePalette(specLayout ?? undefined, mode);
  const spec = walk({ ...(specLayout ?? {}) }, mode, palette) as Record<string, unknown>;
  const specTemplate = spec.template as PlotlyTemplate | undefined;
  delete spec.template;

  const themed = chartTemplate.value;
  const template: PlotlyTemplate = specTemplate
    ? {
        layout: { ...(specTemplate.layout ?? {}), ...themed.layout },
        data: { ...(specTemplate.data ?? {}), ...(themed.data ?? {}) },
      }
    : themed;

  return { ...(base ?? {}), ...spec, template };
}

/**
 * Theme a whole figure — tokens live in traces too, not just the layout.
 * Returns fresh objects, so the cached spec stays token-bearing and can be
 * re-resolved against the other theme on toggle.
 */
export function themedSpec(
  spec: PlotlySpec,
  base?: Record<string, unknown>,
): PlotlySpec {
  const mode = currentMode();
  const palette = figurePalette(spec.layout, mode);
  return {
    data: walk(spec.data ?? [], mode, palette) as unknown[],
    layout: themedLayout(spec.layout, base),
  };
}
