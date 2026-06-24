import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.js";

/** Per-call context all tool handlers receive. Currently just the
 *  user id; future additions (request id, trace span) live here. */
export interface ToolContext {
  userId: number;
}

/** Tool handler signature. Each domain module defines a `handlers`
 *  map keyed by tool name; the aggregator dispatches by name. */
export type ToolHandler = (
  ctx: ToolContext,
  input: Record<string, unknown>,
) => Promise<unknown> | unknown;

/** A domain bundle: the public Tool list + a per-name dispatch map.
 *  The aggregator in ../chatTools.ts flattens these. */
export interface ToolModule {
  tools: Tool[];
  handlers: Record<string, ToolHandler>;
}

export function safeParse(s: string): Record<string, unknown> {
  try { return JSON.parse(s) as Record<string, unknown>; }
  catch { return {}; }
}

export function safeParseArr(s: string): unknown[] {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}
