import type {
  WebSearchTool20250305,
  WebSearchTool20260209,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import { getSetting, setSetting } from "./settings.js";

/**
 * Anthropic's server-side web search tool.
 *
 * Unlike every other tool in chatTools/, this one does not run here — Anthropic
 * executes the search and returns the results inline in the same response. So
 * there is no handler to write; the whole integration is a tool definition, plus
 * reading the result blocks back off the assistant message.
 *
 * Two things make it more than a one-liner: the tool `type` is version-gated by
 * model, and searches are billed per use, so the admin gets a switch and a cap.
 */

/** Newer variant — adds dynamic filtering (results are filtered before they hit
 *  the context window). Only these model families accept it. */
const DYNAMIC_FILTERING_MODELS = [
  /^claude-opus-5/,
  /^claude-opus-4-8/,
  /^claude-opus-4-7/,
  /^claude-opus-4-6/,
  /^claude-sonnet-5/,
  /^claude-sonnet-4-6/,
  /^claude-fable-5/,
  /^claude-mythos-5/,
];

const DEFAULT_MAX_USES = 5;

export function isWebSearchEnabled(): boolean {
  // Default on: an analytics copilot that can't look up a dialect quirk or a
  // current figure is noticeably worse. Admins can switch it off below.
  return getSetting("web_search_enabled") !== "0";
}

export function setWebSearchEnabled(on: boolean): void {
  setSetting("web_search_enabled", on ? "1" : "0");
}

/** Per-turn ceiling on searches. Each one is billed, so this bounds the cost
 *  of a single question — the model stops searching once it's hit. */
export function getWebSearchMaxUses(): number {
  const raw = Number(getSetting("web_search_max_uses"));
  if (!Number.isFinite(raw) || raw < 1) return DEFAULT_MAX_USES;
  return Math.min(Math.floor(raw), 20);
}

export function setWebSearchMaxUses(n: number): void {
  setSetting("web_search_max_uses", String(Math.min(Math.max(Math.floor(n), 1), 20)));
}

/**
 * The tool definition for a given model, or null when web search is off.
 *
 * The `_20260209` type is rejected by models that predate it, so the version has
 * to track the configured model — which is admin-editable and can be changed to
 * an older one at any time.
 */
export function webSearchTool(
  model: string,
): WebSearchTool20260209 | WebSearchTool20250305 | null {
  if (!isWebSearchEnabled()) return null;
  const max_uses = getWebSearchMaxUses();
  return DYNAMIC_FILTERING_MODELS.some((re) => re.test(model))
    ? { type: "web_search_20260209", name: "web_search", max_uses }
    : { type: "web_search_20250305", name: "web_search", max_uses };
}

export interface WebSearchResultItem {
  title: string;
  url: string;
  page_age?: string | null;
}

/** Shape we hand the UI for a completed search. */
export interface WebSearchOutcome {
  query?: string;
  results?: WebSearchResultItem[];
  error?: string;
}

/**
 * Normalise a `web_search_tool_result` block.
 *
 * The failure mode here is easy to miss: a failed search still comes back as a
 * successful HTTP 200 with the same block type, and `content` switches from an
 * *array* of results to a single error *object*. Indexing it as an array would
 * quietly yield nothing rather than surfacing the error.
 */
export function readWebSearchResult(content: unknown): WebSearchOutcome {
  if (Array.isArray(content)) {
    return {
      results: content
        .filter((r): r is Record<string, unknown> => !!r && typeof r === "object")
        .map((r) => ({
          title: String(r.title ?? r.url ?? "Untitled"),
          url: String(r.url ?? ""),
          page_age: (r.page_age as string | undefined) ?? null,
        })),
    };
  }
  if (content && typeof content === "object") {
    const code = (content as { error_code?: unknown }).error_code;
    return { error: code ? String(code) : "search failed" };
  }
  return { error: "search failed" };
}
