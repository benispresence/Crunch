/**
 * Catalog of selectable chat models, grouped by lab.
 *
 * Anthropic request shape is not uniform across the family — sending the same
 * `thinking` / `effort` pair to every model returns a 400 on several of them:
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
 * valid request, so no caller has to remember any of the above. Non-Anthropic
 * labs reuse the same effort/thinking knobs; the OpenAI-compat runtime maps
 * them onto `reasoning_effort` / Responses `reasoning`.
 */

export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";
export type ProviderId = "anthropic" | "xai" | "openai" | "google";

export const ALL_EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh", "max"];
const NO_XHIGH: EffortLevel[] = ["low", "medium", "high", "max"];
const OPENAI_EFFORTS: EffortLevel[] = ["low", "medium", "high", "xhigh"];
const GEMINI_EFFORTS: EffortLevel[] = ["low", "medium", "high"];

type ThinkingMode =
  /** Always on; the API rejects any explicit `thinking` config. */
  | "always-on"
  /** `{type:"adaptive"}`, and can be switched off with `{type:"disabled"}`. */
  | "adaptive"
  /** Pre-adaptive: `{type:"enabled", budget_tokens}` or nothing at all. */
  | "budget";

export interface ModelSpec {
  id: string;
  provider: ProviderId;
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

export const ANTHROPIC_MODELS: ModelSpec[] = [
  {
    id: "claude-opus-5",
    provider: "anthropic",
    label: "Claude Opus 5",
    blurb: "Best for complex agentic and analytical work. The default.",
    efforts: ALL_EFFORTS,
    defaultEffort: "high",
    thinking: "adaptive",
    disableThinkingUpTo: "high",
    defaultEnabled: true,
  },
  {
    id: "claude-opus-4-8",
    provider: "anthropic",
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
    provider: "anthropic",
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
    provider: "anthropic",
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
    provider: "anthropic",
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
    provider: "anthropic",
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
    provider: "anthropic",
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

export const XAI_MODELS: ModelSpec[] = [
  {
    id: "grok-4.6",
    provider: "xai",
    label: "Grok 4.6",
    blurb: "xAI flagship. Best for chat, code, and agentic work.",
    efforts: ALL_EFFORTS,
    defaultEffort: "high",
    thinking: "adaptive",
    disableThinkingUpTo: "max",
    defaultEnabled: true,
  },
  {
    id: "grok-4.5",
    provider: "xai",
    label: "Grok 4.5",
    blurb: "Previous flagship. Strong reasoning at the same price band.",
    efforts: ALL_EFFORTS,
    defaultEffort: "high",
    thinking: "adaptive",
    disableThinkingUpTo: "max",
    defaultEnabled: true,
  },
  {
    id: "grok-4.3",
    provider: "xai",
    label: "Grok 4.3",
    blurb: "Long-context Grok. 1M window, lower cost than 4.6.",
    efforts: ALL_EFFORTS,
    defaultEffort: "high",
    thinking: "adaptive",
    disableThinkingUpTo: "max",
    defaultEnabled: true,
  },
  {
    id: "grok-build-0.1",
    provider: "xai",
    label: "Grok Build",
    blurb: "Coding specialist. The model behind xAI's terminal agent.",
    efforts: ALL_EFFORTS,
    defaultEffort: "high",
    thinking: "adaptive",
    disableThinkingUpTo: "max",
    defaultEnabled: true,
  },
  {
    id: "grok-4.20-0309-reasoning",
    provider: "xai",
    label: "Grok 4.20 Reasoning",
    blurb: "Reasoning-first Grok. Off by default.",
    efforts: ALL_EFFORTS,
    defaultEffort: "high",
    thinking: "adaptive",
    disableThinkingUpTo: "max",
    defaultEnabled: false,
  },
];

export const OPENAI_MODELS: ModelSpec[] = [
  {
    id: "gpt-5.2",
    provider: "openai",
    label: "GPT-5.2",
    blurb: "OpenAI flagship for coding and agentic professional work.",
    efforts: OPENAI_EFFORTS,
    defaultEffort: "medium",
    thinking: "adaptive",
    disableThinkingUpTo: "xhigh",
    defaultEnabled: true,
  },
  {
    id: "gpt-5-mini",
    provider: "openai",
    label: "GPT-5 mini",
    blurb: "Cheaper GPT-5-class model. Fast enough for routine analysis.",
    efforts: OPENAI_EFFORTS,
    defaultEffort: "medium",
    thinking: "adaptive",
    disableThinkingUpTo: "xhigh",
    defaultEnabled: true,
  },
  {
    id: "gpt-4.1",
    provider: "openai",
    label: "GPT-4.1",
    blurb: "Non-reasoning GPT-4.1. Good when you want a straight answer.",
    efforts: [],
    defaultEffort: null,
    thinking: "budget",
    disableThinkingUpTo: "max",
    defaultEnabled: true,
  },
];

export const GOOGLE_MODELS: ModelSpec[] = [
  {
    id: "gemini-3.1-pro-preview",
    provider: "google",
    label: "Gemini 3.1 Pro",
    blurb: "Google's most intelligent model. Thinking stays on.",
    efforts: GEMINI_EFFORTS,
    defaultEffort: "high",
    thinking: "always-on",
    disableThinkingUpTo: null,
    defaultEnabled: true,
  },
  {
    id: "gemini-3.7-flash",
    provider: "google",
    label: "Gemini 3.7 Flash",
    blurb: "Latest Flash. Fast, capable, good for agentic workflows.",
    efforts: GEMINI_EFFORTS,
    defaultEffort: "medium",
    thinking: "adaptive",
    disableThinkingUpTo: "high",
    defaultEnabled: true,
  },
  {
    id: "gemini-2.5-pro",
    provider: "google",
    label: "Gemini 2.5 Pro",
    blurb: "Previous Pro. Deep reasoning over large contexts.",
    efforts: GEMINI_EFFORTS,
    defaultEffort: "high",
    thinking: "always-on",
    disableThinkingUpTo: null,
    defaultEnabled: true,
  },
  {
    id: "gemini-2.5-flash",
    provider: "google",
    label: "Gemini 2.5 Flash",
    blurb: "Price-performance Flash. Thinking can be turned off.",
    efforts: GEMINI_EFFORTS,
    defaultEffort: "medium",
    thinking: "adaptive",
    disableThinkingUpTo: "high",
    defaultEnabled: true,
  },
];

export const MODEL_CATALOG: ModelSpec[] = [
  ...ANTHROPIC_MODELS,
  ...XAI_MODELS,
  ...OPENAI_MODELS,
  ...GOOGLE_MODELS,
];

export const DEFAULT_MODEL = "claude-opus-5";

export function findModel(id: string): ModelSpec | undefined {
  return MODEL_CATALOG.find((m) => m.id === id);
}

export function modelsForProvider(provider: ProviderId): ModelSpec[] {
  return MODEL_CATALOG.filter((m) => m.provider === provider);
}

export function defaultEnabledIds(provider: ProviderId): string[] {
  return modelsForProvider(provider).filter((m) => m.defaultEnabled).map((m) => m.id);
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
  /** Params to spread into Anthropic messages.stream(). Empty for other labs. */
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

  const params: Record<string, unknown> = {};

  if (spec.provider !== "anthropic") {
    if (spec.thinking === "always-on") {
      if (!wantThinking) {
        notes.push(`${spec.label} always thinks — thinking can't be turned off.`);
      }
      wantThinking = true;
    }
    return { model: spec.id, spec, effort, thinking: wantThinking, params, notes };
  }

  if (spec.thinking === "always-on") {
    if (!wantThinking) {
      notes.push(`${spec.label} always thinks — thinking can't be turned off.`);
    }
    wantThinking = true;
  } else if (spec.thinking === "budget") {
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

/**
 * Map our effort knob onto OpenAI-style `reasoning_effort`.
 * `max` is an Anthropic-only level; other labs get `xhigh` or `high`.
 */
export function openaiReasoningEffort(
  spec: ModelSpec,
  effort: EffortLevel | null,
  thinking: boolean,
): string | undefined {
  if (spec.efforts.length === 0) return undefined;
  if (!thinking) {
    if (spec.thinking === "always-on") return effort ?? spec.defaultEffort ?? undefined;
    return spec.provider === "google" ? "none" : "none";
  }
  if (!effort) return spec.defaultEffort ?? undefined;
  if (effort === "max") {
    return spec.efforts.includes("xhigh") ? "xhigh" : "high";
  }
  return effort;
}


