import { getAnthropicModel, getSetting, setSetting } from "./settings.js";

/**
 * Catalog of selectable Claude models.
 *
 * This is a capability table, not a list of ids, because the request shape is
 * not uniform across the family — sending the same `thinking` / `effort` pair to
 * every model returns a 400 on several of them:
 *
 *   - `output_config.effort` is rejected outright by Haiku 4.5.
 *   - `xhigh` exists on Opus 4.7+ and Sonnet 5, but not on the 4.6 models.
 *   - Fable 5 has thinking permanently on and rejects *any* explicit `thinking`
 *     config, including `disabled`.
 *   - Opus 4.8/4.7 need `{type:"adaptive"}` spelled out (omitting it means no
 *     thinking), while Opus 5 and Sonnet 5 think by default.
 *   - Opus 5 accepts `{type:"disabled"}` only at effort `high` or below.
 *   - Haiku 4.5 predates adaptive thinking and uses the old token budget.
 *
 * `resolveRun()` below is the single place that turns a user's choice into a
 * valid request, so no caller has to remember any of the above.
 */

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

const ALL_EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const NO_XHIGH: EffortLevel[] = ["low", "medium", "high", "max"];

type ThinkingMode =
  /** Always on; the API rejects any explicit `thinking` config. */
  | "always-on"
  /** `{type:"adaptive"}`, and can be switched off with `{type:"disabled"}`. */
  | "adaptive"
  /** Pre-adaptive: `{type:"enabled", budget_tokens}` or nothing at all. */
  | "budget";

export interface ModelSpec {
  id: string;
  label: string;
  blurb: string;
  /** Empty means the model rejects `output_config.effort` entirely. */
  efforts: EffortLevel[];
  defaultEffort: EffortLevel | null;
  thinking: ThinkingMode;
  /** Highest effort at which thinking may be turned off. null = never. */
  disableThinkingUpTo: EffortLevel | null;
  /** Whether this appears for users before an admin touches anything. */
  defaultEnabled: boolean;
}

export const MODEL_CATALOG: ModelSpec[] = [
  {
    id: "claude-opus-5",
    label: "Claude Opus 5",
    blurb: "Best for complex agentic and analytical work. The default.",
    efforts: ALL_EFFORTS,
    defaultEffort: "high",
    thinking: "adaptive",
    // Opus 5 rejects disabled thinking above `high`.
    disableThinkingUpTo: "high",
    defaultEnabled: true,
  },
  {
    id: "claude-opus-4-8",
    label: "Claude Opus 4.8",
    blurb: "Previous Opus. Strong long-horizon agentic work.",
    efforts: ALL_EFFORTS,
    defaultEffort: "high",
    thinking: "adaptive",
    disableThinkingUpTo: "max",
    defaultEnabled: true,
  },
  {
    id: "claude-opus-4-7",
    label: "Claude Opus 4.7",
    blurb: "Older Opus. Kept for reproducing earlier results.",
    efforts: ALL_EFFORTS,
    defaultEffort: "high",
    thinking: "adaptive",
    disableThinkingUpTo: "max",
    defaultEnabled: true,
  },
  {
    id: "claude-sonnet-5",
    label: "Claude Sonnet 5",
    blurb: "Near-Opus quality on coding and agentic work, at lower cost.",
    efforts: ALL_EFFORTS,
    defaultEffort: "high",
    thinking: "adaptive",
    disableThinkingUpTo: "max",
    defaultEnabled: true,
  },
  {
    id: "claude-sonnet-4-6",
    label: "Claude Sonnet 4.6",
    blurb: "Previous Sonnet. No xhigh effort level.",
    efforts: NO_XHIGH,
    defaultEffort: "high",
    thinking: "adaptive",
    disableThinkingUpTo: "max",
    defaultEnabled: true,
  },
  {
    id: "claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    blurb: "Fastest and cheapest. No effort control.",
    efforts: [],
    defaultEffort: null,
    thinking: "budget",
    disableThinkingUpTo: "max",
    defaultEnabled: true,
  },
  {
    id: "claude-fable-5",
    label: "Claude Fable 5",
    blurb:
      "Most capable, for the hardest reasoning. Premium pricing, thinking always on, "
      + "and your org must allow 30-day data retention — off by default.",
    efforts: ALL_EFFORTS,
    defaultEffort: "high",
    thinking: "always-on",
    disableThinkingUpTo: null,
    defaultEnabled: false,
  },
];

export const DEFAULT_MODEL = "claude-opus-5";

export function findModel(id: string): ModelSpec | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

/* -------------------------------------------------------------------------
 * Admin enablement
 * ---------------------------------------------------------------------- */

/** Ids an admin has turned on. Unset = the catalog's own defaults. */
export function getEnabledModelIds(): string[] {
  const raw = getSetting("enabled_models");
  if (!raw) return MODEL_CATALOG.filter((m) => m.defaultEnabled).map((m) => m.id);
  const wanted = new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
  return MODEL_CATALOG.filter((m) => wanted.has(m.id)).map((m) => m.id);
}

export function setEnabledModelIds(ids: string[]): void {
  const valid = MODEL_CATALOG.filter((m) => ids.includes(m.id)).map((m) => m.id);
  // Never let the list empty out — that would leave the assistant unusable with
  // no way back except editing the DB. Fall back to the *configured* default
  // rather than the catalog's, so the workspace's own model stays selectable.
  const configured = getAnthropicModel();
  const fallback = findModel(configured) ? configured : DEFAULT_MODEL;
  const safe = valid.length > 0 ? valid : [fallback];
  setSetting("enabled_models", safe.join(","));
}

export function enabledModels(): ModelSpec[] {
  const ids = new Set(getEnabledModelIds());
  return MODEL_CATALOG.filter((m) => ids.has(m.id));
}

export function isModelEnabled(id: string): boolean {
  return getEnabledModelIds().includes(id);
}

/* -------------------------------------------------------------------------
 * Request shaping
 * ---------------------------------------------------------------------- */

export interface ResolvedRun {
  model: string;
  spec: ModelSpec;
  /** Effort actually applied, after clamping. null = not sent. */
  effort: EffortLevel | null;
  /** Whether thinking is on for this run, after the model's constraints. */
  thinking: boolean;
  /** Params to spread into messages.stream(). */
  params: Record<string, unknown>;
  /** Non-fatal adjustments worth telling the user about. */
  notes: string[];
}

/**
 * Turn a (model, effort, thinking) choice into a request that the chosen model
 * will actually accept, clamping rather than erroring so a mismatched choice
 * degrades instead of failing the message.
 */
export function resolveRun(opts: {
  model: string;
  effort?: EffortLevel | null;
  thinking?: boolean;
  /** Cap for the pre-adaptive budget mode; must stay under max_tokens. */
  maxTokens: number;
}): ResolvedRun {
  const spec = findModel(opts.model) ?? findModel(DEFAULT_MODEL)!;
  const notes: string[] = [];
  let wantThinking = opts.thinking ?? true;

  // --- effort -------------------------------------------------------------
  let effort: EffortLevel | null = null;
  if (spec.efforts.length > 0) {
    const requested = opts.effort ?? spec.defaultEffort;
    if (requested && spec.efforts.includes(requested)) {
      effort = requested;
    } else {
      effort = spec.defaultEffort;
      if (requested) {
        notes.push(
          `${spec.label} doesn't support "${requested}" effort — used "${effort}".`,
        );
      }
    }
  } else if (opts.effort) {
    notes.push(`${spec.label} has no effort control — ignored.`);
  }

  // --- thinking -----------------------------------------------------------
  const params: Record<string, unknown> = {};

  if (spec.thinking === "always-on") {
    // Any explicit thinking config is a 400 here, including "disabled".
    if (!wantThinking) {
      notes.push(`${spec.label} always thinks — thinking can't be turned off.`);
    }
    wantThinking = true;
  } else if (spec.thinking === "budget") {
    // Pre-adaptive models take a token budget with two hard rules: at least
    // 1024, and *strictly* less than max_tokens — equal to it is a 400.
    if (wantThinking) {
      const budget = Math.min(Math.floor(opts.maxTokens / 2), opts.maxTokens - 1);
      if (budget >= 1024) {
        params.thinking = { type: "enabled", budget_tokens: budget };
      } else {
        wantThinking = false;
        notes.push(
          `${spec.label} needs at least 1024 thinking tokens and the output cap is `
          + `too small — ran without thinking.`,
        );
      }
    }
  } else if (wantThinking) {
    params.thinking = { type: "adaptive", display: "summarized" };
  } else {
    // Opus 5 rejects disabled thinking above `high`, so drop effort to the
    // ceiling rather than failing the request. Asking for max effort *and* no
    // thinking is contradictory anyway.
    const ceiling = spec.disableThinkingUpTo;
    if (ceiling && effort && ALL_EFFORTS.indexOf(effort) > ALL_EFFORTS.indexOf(ceiling)) {
      notes.push(
        `${spec.label} can't disable thinking above "${ceiling}" effort — lowered from "${effort}".`,
      );
      effort = ceiling;
    }
    params.thinking = { type: "disabled" };
  }

  if (effort) params.output_config = { effort };

  return { model: spec.id, spec, effort, thinking: wantThinking, params, notes };
}

/** Shape sent to the client so the picker only offers valid combinations. */
export function modelPickerPayload() {
  return {
    default_model: DEFAULT_MODEL,
    models: enabledModels().map((m) => ({
      id: m.id,
      label: m.label,
      blurb: m.blurb,
      efforts: m.efforts,
      default_effort: m.defaultEffort,
      supports_thinking_off: m.thinking !== "always-on",
    })),
  };
}
