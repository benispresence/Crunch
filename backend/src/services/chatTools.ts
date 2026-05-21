/**
 * Chat tools aggregator.
 *
 * Each per-domain module under ./chatTools exports a {tools, handlers}
 * bundle. This file flattens them into the two exports the chat route
 * actually uses — ``chatTools`` (Tool[]) and ``runTool`` (dispatch).
 *
 * Adding a new tool = drop another module in ./chatTools and append
 * it to MODULES below. No giant switch to keep in sync.
 */

import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { dataTools } from "./chatTools/data.js";
import { dashboardTools } from "./chatTools/dashboards.js";
import { navigateTools } from "./chatTools/navigate.js";
import { pipelineTools } from "./chatTools/pipelines.js";
import { queryTools } from "./chatTools/queries.js";
import type { ToolContext, ToolHandler, ToolModule } from "./chatTools/types.js";

const MODULES: ToolModule[] = [
  dataTools,
  queryTools,
  dashboardTools,
  navigateTools,
  pipelineTools,
];

// Build the public tool list + dispatch map at module load. Dev sanity
// check: catch accidental name collisions between modules so the
// dispatch table doesn't silently shadow a real handler.
const dispatch: Record<string, ToolHandler> = {};
const tools: Tool[] = [];
const seen = new Set<string>();
for (const m of MODULES) {
  for (const t of m.tools) {
    if (seen.has(t.name)) {
      throw new Error(`duplicate chat tool name: ${t.name}`);
    }
    seen.add(t.name);
    tools.push(t);
  }
  for (const [name, handler] of Object.entries(m.handlers)) {
    if (dispatch[name]) {
      throw new Error(`duplicate chat tool handler: ${name}`);
    }
    dispatch[name] = handler;
  }
}

export const chatTools: Tool[] = tools;

export type { ToolContext };

/**
 * Dispatch a tool call. Normalises every error path to the same
 * `{success: false, error: string}` shape so the agent (and the chat
 * route) only has to handle one failure envelope. Handlers can still
 * return `{error}` or throw — both get converted here.
 */
export async function runTool(
  ctx: ToolContext,
  name: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const fn = dispatch[name];
  if (!fn) return { success: false, error: `unknown tool ${name}` };
  try {
    const result = await fn(ctx, input);
    // Handlers that returned the legacy `{error: "..."}` shape get
    // upgraded to the unified one so the SDK always sees a consistent
    // failure envelope.
    if (
      result
      && typeof result === "object"
      && !Array.isArray(result)
      && "error" in (result as Record<string, unknown>)
      && !("success" in (result as Record<string, unknown>))
    ) {
      return {
        success: false,
        error: String((result as { error: unknown }).error),
      };
    }
    return result;
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}
