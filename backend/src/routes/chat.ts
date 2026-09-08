import Anthropic from "@anthropic-ai/sdk";
import type {
  ContentBlockParam,
  MessageParam,
  TextBlock,
  ThinkingBlock,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import { Router } from "express";
import { z } from "zod";
import { db } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import {
  getDefaultModel,
  getProviderCredentials,
  isModelEnabled,
  modelPickerPayload,
  type ProviderCredentials,
} from "../services/aiProviders.js";
import { chatToolsForRequest, runTool } from "../services/chatTools.js";
import { findModel, resolveRun, type ResolvedRun } from "../services/models.js";
import { runOpenAiCompatTurn } from "../services/openaiCompatChat.js";
import { readWebSearchResult, webSearchTool } from "../services/webSearch.js";

export const chatRouter = Router();
chatRouter.use(requireAuth);

/** What the composer's model picker offers — enabled models plus, per model,
 *  the effort levels it actually accepts. */
chatRouter.get("/models", (_req, res) => {
  res.json(modelPickerPayload());
});

const SYSTEM_PROMPT = `You are Crunch, an analytics copilot embedded in a BI tool.

Behavior rules:
- Be concise. Prefer short, direct sentences over preambles.
- When the user asks a data question, plan briefly, call the tools, then summarize.
- Always inspect the schema (\`list_connections\` then a small \`SELECT\` against information_schema-style tables) before writing larger queries.
- For numeric results, format them readably (commas, units).
- Wrap any SQL or Python you produce in fenced code blocks with the language tag.

Web search:
- \`web_search\` runs on Anthropic's servers and returns results directly — you do not need a proposal for it, and it never touches the user's data.
- Search when the answer depends on information you can't get from the user's warehouse or your own knowledge: current figures or events, a data source's API/schema documentation, or dialect-specific SQL and library behaviour you are unsure about. Prefer searching over guessing at a syntax you half-remember.
- Do NOT search for anything answerable from the user's own data — query it instead. \`execute_sql\` and \`list_saved_queries\` are the sources of truth for their warehouse; the web is not.
- Searches are billed per use and capped per turn, so keep them targeted: one or two precise queries beat a broad sweep.
- Cite what you used. When a claim rests on a search result, name the source inline so the user can check it.

Writing chart code (theme-aware charts):
- Crunch has a light and a dark theme and the user flips between them at will. One saved figure must serve both. Never pick a single "compromise" shade that is merely survivable on both backgrounds — that produces washed-out charts. Colours should genuinely flip: dark text on the light canvas, light text on the dark one.
- **Leave it unset and it is themed for you.** Do NOT set \`template=\` (no "plotly_white" / "plotly_dark"), \`paper_bgcolor\`, \`plot_bgcolor\`, \`font_color\`, \`gridcolor\`, \`zerolinecolor\`, \`linecolor\`, tick/legend/colorbar/annotation text colours, or table \`fill_color\`. The client fills each of these from the active theme. Likewise skip \`width\`/\`height\` — the panel sizes the figure.
- **To pin a colour that must still flip, use a theme token.** A token is a plain string in any Plotly colour slot; the client resolves it at paint time.
  - \`"$fg"\`, \`"$fg-muted"\`, \`"$accent"\`, \`"$success"\`, \`"$error"\`, \`"$warn"\`, \`"$info"\`, \`"$grid"\`, \`"$border"\`, \`"$bg-elev"\`, and \`"$series0"\`…\`"$series7"\` (the categorical palette, in order) are built in.
  - \`theme_color(light_hex, dark_hex)\` — a one-off pair, e.g. \`fig.add_annotation(font_color=theme_color("#b4552f", "#e08a63"))\`.
  - \`theme_palette(light={...}, dark={...}, both={...})\` — declare named colours on the figure, then reference them anywhere as \`$name\`:
    \`fig.update_layout(**theme_palette(light={"ehex": "#b4552f"}, dark={"ehex": "#e08a63"}))\` then \`line=dict(color="$ehex")\`. Names declared here shadow the built-ins, so a chart can rebind \`$accent\` to its own brand colour.
  - Both helpers are pre-injected into the sandbox — no import needed.
- When you do write an explicit light/dark pair, choose each side for its own background: the light value should be a deep, saturated hue (roughly #b4552f, #3c6f9e, #4e7c3a) and the dark value a lifted, brighter one (#e08a63, #8fb8dd, #90c47c). Same hue, different lightness.
- Series colours: prefer leaving them unset entirely so the figure inherits the theme's colorway, which is already tuned per theme. Reach for \`$series0\`…\`$series7\` only when you need a specific slot (e.g. to keep two charts' series aligned).
- Continuous scales: leave \`color_continuous_scale\` unset to inherit the theme's ramp, or pick a perceptually uniform one (Viridis, Cividis).
- Raw hexes and named CSS colours are a last resort — they do not flip. If the user explicitly asks for one fixed colour, honour it, and say in your summary that it will not follow the theme.

Modifying the user's saved queries / charts:
- NEVER mutate state silently in prose. If the user asks you to edit, create, or delete a saved query or its chart settings, you MUST call the corresponding \`propose_*\` tool. The UI renders a Cursor-style diff and lets the user Accept/Reject.
- Discovery order: \`list_saved_queries\` (find ids) → \`get_saved_queries\` if you need the actual SQL or chart python → call the relevant propose tool with a one-line \`rationale\`.
- \`list_saved_queries\` returns summaries only, and takes \`folder_id\` / \`connection_id\` / \`name_contains\` filters — use them rather than listing everything. If a result comes back with a \`_truncated\` field, it was too big: narrow the filters and call again instead of guessing at what you didn't see.
- To duplicate queries onto a different connection, use \`copy_from_query_id\` in \`propose_new_folder\` and override only \`connection_id\` (plus a new name if wanted). Never paste the original SQL back out — cloning by id is exact and avoids running out of output space. To repoint the existing queries in place instead, use \`propose_bulk_query_edit\`.
- Keep tool inputs small. If a batch is large, split it across several proposals rather than emitting one huge call.
- For editing existing query SQL/name/connection: \`propose_query_edit\` (set \`new_connection_id\` to repoint a query at another data source without rewriting SQL).
- For repointing many queries at once: \`propose_bulk_query_edit\` with a list of \`{query_id, new_connection_id}\` edits. The user gets one Accept/Reject card listing every change.
- For changing chart_type / chart_config / python code on a saved query: \`propose_chart_change\`.
- For creating a new saved query: \`propose_new_query\` (requires connection_id from \`list_connections\`).
- For deleting a saved query: \`propose_delete_query\`.

Folders (collections):
- \`list_folders\` gives every folder's id, nesting \`path\`, and query count. Call it before anything folder-related.
- \`propose_new_folder\` creates a folder AND, optionally, the queries that go in it — pass them in \`queries\`. Accepting creates the folder first, then each query inside it. **You never need the folder id in advance**, so never ask the user to create a folder in the UI and report its id back.
- Nest a folder by passing \`parent_id\` (e.g. an "August" subfolder under the existing "Whoop" folder).
- \`propose_move_queries\` moves existing queries into a folder; \`folder_id: null\` moves them to the root.

Modifying dashboards:
- Discovery: \`list_dashboards\` → \`get_dashboard\` for the full state (filters, widgets, mappings).
- Create a new dashboard: \`propose_new_dashboard\`. May seed initial widgets (each referencing an existing saved query) and filters.
- Add a chart to an existing dashboard: \`propose_add_widget\`. If the dashboard has filters, pre-wire \`parameter_mappings\` (filter id → variable name on the query).
- Remove a chart: \`propose_remove_widget\`.
- Edit dashboard filters: \`propose_dashboard_filter_change\` — pass the full replacement filter array.
- Edit per-widget filter wiring: \`propose_widget_mapping\`.

Cross-surface navigation:
- After creating or editing something the user will want to inspect, call \`propose_navigate\`. \`to=workspace\` (optionally with \`query_id\`) opens the SQL editor; \`to=dashboard\` (with \`dashboard_id\`) opens that dashboard.
- The user can toggle auto-accept; when on, the navigation happens immediately. Either way, surface it as a proposal — never assume the user has switched pages.

Data pipelines:
- Pipelines ingest data into one of the user's connections — REST APIs, SQL replication, files, Kafka, or fully custom Python. Each pipeline has a Python script (typically using the dlt library) that we can auto-generate from a structured form.
- Discovery: \`list_pipelines\` → \`get_pipeline\` for the full state (config + python_code + recent runs).
- Create: \`propose_new_pipeline\`. Provide source_type + load_mode + destination_connection_id at minimum. Leave python_code unset to let the engine generate a dlt template that matches the form fields; set code_mode='custom' if you want to hand-author the script.
- Edit: \`propose_pipeline_edit\`. Same field set, all optional. Editing the form fields with code_mode='template' regenerates the script automatically.
- Run: \`propose_run_pipeline\` fires it once now. Schedule-based runs use the cron expression stored on the pipeline.
- Load modes: replace (truncate + reingest), append (batch), merge (delta, needs primary_key), incremental (cursor_field), streaming (bounded micro-batch with stream_max_seconds/messages).
- After a successful new_pipeline accept, prefer chaining \`propose_navigate\` with to='pipeline' so the user lands in the editor and can run/edit it.

For \`propose_navigate\`: \`to='pipeline'\` (with \`pipeline_id\`) opens the pipeline detail view; \`to='pipelines'\` opens the list.

All \`propose_*\` tools DO NOT execute the change — they only produce a proposal. After calling one, briefly summarize what you proposed and stop; do not duplicate the diff in prose.`;

const workspaceContextSchema = z.object({
  active_route: z.string().optional(),
  active_query_id: z.number().int().nullable().optional(),
  active_query_name: z.string().nullable().optional(),
  active_connection_id: z.number().int().nullable().optional(),
  active_connection_name: z.string().nullable().optional(),
  active_dashboard_id: z.number().int().nullable().optional(),
  active_dashboard_name: z.string().nullable().optional(),
  current_sql: z.string().optional(),
  current_chart_type: z.string().optional(),
  current_chart_mode: z.string().optional(),
  current_chart_config: z.record(z.unknown()).optional(),
  current_python_code: z.string().nullable().optional(),
  has_unsaved_changes: z.boolean().optional(),
  last_result_columns: z.array(z.string()).optional(),
  last_result_row_count: z.number().int().optional(),
});

const sendSchema = z.object({
  conversation_id: z.number().int().nullable().optional(),
  message: z.string().min(1),
  thinking: z.boolean().optional(),
  model: z.string().optional(),
  effort: z.enum(["low", "medium", "high", "xhigh", "max"]).optional(),
  workspace: workspaceContextSchema.optional(),
});

/**
 * Render the workspace context as a compact markdown block so the model
 * can see what the user is currently working on. Lives in a separate
 * (uncached) system block so the cache key on the prompt stays stable.
 */
function formatWorkspaceContext(ctx: z.infer<typeof workspaceContextSchema>): string {
  const lines: string[] = ["<workspace_context>"];
  if (ctx.active_route) {
    lines.push(`current_page: ${ctx.active_route}`);
  }
  if (ctx.active_dashboard_id != null) {
    lines.push(
      `active_dashboard: #${ctx.active_dashboard_id} "${ctx.active_dashboard_name ?? "?"}"`,
    );
  }
  if (ctx.active_query_id != null) {
    lines.push(
      `active_saved_query: #${ctx.active_query_id} "${ctx.active_query_name ?? "?"}"`,
    );
  } else {
    lines.push("active_saved_query: (none — user is on an unsaved scratch query)");
  }
  if (ctx.active_connection_id != null) {
    lines.push(
      `active_connection: #${ctx.active_connection_id} "${ctx.active_connection_name ?? "?"}"`,
    );
  }
  if (ctx.has_unsaved_changes) {
    lines.push("unsaved_changes: true (the SQL or chart settings differ from the saved version)");
  }
  if (ctx.current_chart_mode || ctx.current_chart_type) {
    lines.push(
      `current_chart: mode=${ctx.current_chart_mode ?? "picker"} type=${ctx.current_chart_type ?? "bar"}`,
    );
  }
  if (ctx.current_chart_config && Object.keys(ctx.current_chart_config).length > 0) {
    lines.push(`current_chart_config: ${JSON.stringify(ctx.current_chart_config)}`);
  }
  if (ctx.current_sql) {
    lines.push("current_sql: |");
    for (const ln of ctx.current_sql.split("\n")) lines.push("  " + ln);
  }
  if (ctx.current_python_code) {
    lines.push("current_python_code: |");
    for (const ln of ctx.current_python_code.split("\n")) lines.push("  " + ln);
  }
  if (ctx.last_result_columns && ctx.last_result_columns.length > 0) {
    lines.push(
      `last_result: ${ctx.last_result_row_count ?? "?"} rows, columns: ${ctx.last_result_columns.join(", ")}`,
    );
  }
  lines.push("</workspace_context>");
  lines.push(
    "When the user says \"this query\", \"current chart\", \"add a limit\", etc., assume they mean the active_saved_query above. Use propose_query_edit / propose_chart_change with that query_id rather than asking which one. When they say \"this dashboard\", target active_dashboard_id. If a task spans both surfaces (e.g. \"add a query and put it on the dashboard\"), chain the propose_* tools and finish with propose_navigate to take the user where they need to go.",
  );
  return lines.join("\n");
}

/**
 * Replay server-side tool activity onto the SSE stream.
 *
 * Anthropic runs web search itself and hands back the finished blocks, so there
 * is no request/response pair for the UI to observe the way there is for our own
 * tools. This synthesises the same `tool_call` / `tool_result` events off the
 * completed message, letting the existing tool list render searches with no
 * special-casing on the client.
 */
function emitServerToolActivity(
  blocks: ContentBlockParam[] | Array<{ type: string; [k: string]: unknown }>,
  send: (event: string, data: unknown) => void,
): void {
  // The dynamic-filtering search variant runs code execution internally, so a
  // single search produces extra `server_tool_use` blocks (the filtering script)
  // answered by `code_execution_tool_result` rather than a search result.
  // Surfacing those would strand tool calls in "running" forever — and they're
  // plumbing the user has no use for. Track the real searches and skip the rest.
  const searchIds = new Set<string>();
  for (const raw of blocks as Array<Record<string, unknown>>) {
    if (raw.type === "server_tool_use" && raw.name === "web_search") {
      searchIds.add(String(raw.id));
      send("tool_call", { id: raw.id, name: "web_search", input: raw.input });
    }
  }
  for (const raw of blocks as Array<Record<string, unknown>>) {
    if (raw.type !== "web_search_tool_result") continue;
    const id = String(raw.tool_use_id);
    if (!searchIds.has(id)) continue;
    send("tool_result", { id, name: "web_search", result: readWebSearchResult(raw.content) });
  }
}

/** Output cap per turn. Thinking counts against this too. */
const MAX_TOKENS = 16_384;

const TOOL_RESULT_LIMIT = 60_000;

/**
 * Serialise a tool result, keeping it under the size cap **and valid JSON**.
 *
 * This used to be a flat `.slice(0, 60_000)`, which cut the payload
 * mid-object. The model received unparseable text ending partway through a
 * record and — worse — had no way to tell that anything was missing, so it
 * would reason confidently about a list whose tail it never saw. Now an
 * oversized array is trimmed record by record and labelled with what was
 * dropped, so the model knows to narrow its filters and ask again.
 */
function clampToolResult(result: unknown): string {
  const full = JSON.stringify(result) ?? "null";
  if (full.length <= TOOL_RESULT_LIMIT) return full;

  // Find the longest array in the payload; that's what blew the budget.
  const holder = result as Record<string, unknown> | unknown[];
  const key = Array.isArray(holder)
    ? null
    : Object.keys(holder ?? {}).find((k) => Array.isArray((holder as Record<string, unknown>)[k]));
  const items: unknown[] | null = Array.isArray(holder)
    ? holder
    : key
      ? ((holder as Record<string, unknown>)[key] as unknown[])
      : null;

  if (items && items.length > 0) {
    let kept = items.length;
    let out = full;
    while (kept > 0 && out.length > TOOL_RESULT_LIMIT) {
      kept = Math.floor(kept / 2);
      const trimmed = items.slice(0, kept);
      out = JSON.stringify({
        ...(key ? { ...(holder as Record<string, unknown>), [key]: trimmed } : { items: trimmed }),
        _truncated: {
          shown: kept,
          total: items.length,
          hint:
            "Result too large. Re-run with narrower filters (folder_id, connection_id, "
            + "name_contains, limit) or fetch bodies by id instead of listing everything.",
        },
      });
    }
    if (out.length <= TOOL_RESULT_LIMIT) return out;
  }

  return JSON.stringify({
    _error: "tool result too large to return",
    _hint: "Re-run with narrower filters or fetch fewer records at a time.",
  });
}

/**
 * Drop `tool_use` blocks that never got a `tool_result`, and vice versa.
 *
 * The API rejects the whole conversation if an assistant `tool_use` isn't
 * answered in the very next message ("tool_use ids were found without
 * tool_result blocks"). A turn that ends between those two messages — the
 * model running out of output tokens mid-tool-call, or the request being
 * aborted — leaves exactly that shape, and because the history is persisted,
 * every later message in the conversation fails too. One bad turn used to
 * brick the thread permanently.
 *
 * Running this on load repairs conversations already in that state; running
 * it before save stops new ones being written.
 */
export function sanitizeHistory(history: MessageParam[]): MessageParam[] {
  const out: MessageParam[] = [];

  for (let i = 0; i < history.length; i++) {
    const msg = history[i];
    if (!msg) continue;
    const content = msg.content;
    if (typeof content === "string" || !Array.isArray(content)) {
      out.push(msg);
      continue;
    }

    if (msg.role === "assistant") {
      const toolUseIds = content
        .filter((b): b is ToolUseBlock => (b as { type?: string }).type === "tool_use")
        .map((b) => b.id);
      if (toolUseIds.length === 0) {
        out.push(msg);
        continue;
      }
      // Answers must live in the immediately following message.
      const next = history[i + 1];
      const answered = new Set<string>();
      if (next && next.role === "user" && Array.isArray(next.content)) {
        for (const b of next.content) {
          const blk = b as { type?: string; tool_use_id?: string };
          if (blk.type === "tool_result" && blk.tool_use_id) answered.add(blk.tool_use_id);
        }
      }
      const kept = content.filter((b) => {
        const blk = b as { type?: string; id?: string };
        return blk.type !== "tool_use" || (blk.id != null && answered.has(blk.id));
      });
      // An assistant turn that was *only* an unanswered tool call carries no
      // information worth replaying — and a lone thinking block isn't a valid
      // message on its own.
      const hasSubstance = kept.some((b) => {
        const t = (b as { type?: string }).type;
        return t === "text" || t === "tool_use";
      });
      if (hasSubstance) out.push({ role: msg.role, content: kept });
      continue;
    }

    // User side: strip tool_results whose tool_use didn't survive above.
    const prev = out[out.length - 1];
    const prevIds = new Set<string>();
    if (prev && prev.role === "assistant" && Array.isArray(prev.content)) {
      for (const b of prev.content) {
        const blk = b as { type?: string; id?: string };
        if (blk.type === "tool_use" && blk.id) prevIds.add(blk.id);
      }
    }
    const kept = content.filter((b) => {
      const blk = b as { type?: string; tool_use_id?: string };
      return blk.type !== "tool_result"
        || (blk.tool_use_id != null && prevIds.has(blk.tool_use_id));
    });
    if (kept.length > 0) out.push({ role: msg.role, content: kept });
  }

  return mergeConsecutive(out);
}

/**
 * Fold consecutive same-role messages together.
 *
 * Dropping a trailing assistant turn (above) can leave the history ending on
 * the user's tool_result message, and the next send appends another user
 * message right after it. Merging keeps the transcript strictly alternating
 * rather than relying on the API to combine them for us.
 */
function mergeConsecutive(msgs: MessageParam[]): MessageParam[] {
  const asBlocks = (c: MessageParam["content"]): ContentBlockParam[] =>
    typeof c === "string" ? [{ type: "text", text: c }] : [...c];

  const out: MessageParam[] = [];
  for (const msg of msgs) {
    const prev = out[out.length - 1];
    if (prev && prev.role === msg.role) {
      out[out.length - 1] = {
        role: msg.role,
        content: [...asBlocks(prev.content), ...asBlocks(msg.content)],
      };
    } else {
      out.push(msg);
    }
  }
  return out;
}

interface ConversationRow {
  id: number;
  title: string;
  messages_json: string;
}

function loadConversation(userId: number, id: number | null | undefined): {
  id: number | null;
  history: MessageParam[];
} {
  if (!id) return { id: null, history: [] };
  const row = db
    .prepare("SELECT id, title, messages_json FROM conversations WHERE id = ? AND user_id = ?")
    .get(id, userId) as ConversationRow | undefined;
  if (!row) return { id: null, history: [] };
  // Repair on the way in, so a thread bricked by an earlier interrupted turn
  // becomes usable again instead of 400-ing on every subsequent message.
  return {
    id: row.id,
    history: sanitizeHistory(JSON.parse(row.messages_json) as MessageParam[]),
  };
}

function saveConversation(
  userId: number,
  id: number | null,
  title: string,
  rawHistory: MessageParam[],
): number {
  // Never persist an unanswered tool_use — that's what makes a thread
  // permanently unusable on the next send.
  const history = sanitizeHistory(rawHistory);
  if (id) {
    db.prepare(
      "UPDATE conversations SET messages_json = ?, updated_at = strftime('%s', 'now') WHERE id = ? AND user_id = ?",
    ).run(JSON.stringify(history), id, userId);
    return id;
  }
  const info = db
    .prepare("INSERT INTO conversations (user_id, title, messages_json) VALUES (?, ?, ?)")
    .run(userId, title, JSON.stringify(history));
  return Number(info.lastInsertRowid);
}

chatRouter.get("/conversations", (req, res) => {
  const rows = db
    .prepare("SELECT id, title, updated_at FROM conversations WHERE user_id = ? ORDER BY updated_at DESC")
    .all(req.user!.sub);
  res.json(rows);
});

chatRouter.get("/conversations/:id", (req, res) => {
  const row = db
    .prepare("SELECT id, title, messages_json, updated_at FROM conversations WHERE id = ? AND user_id = ?")
    .get(req.params.id, req.user!.sub) as ConversationRow | undefined;
  if (!row) {
    res.status(404).json({ error: "not found" });
    return;
  }
  res.json({
    id: row.id,
    title: row.title,
    messages: JSON.parse(row.messages_json),
  });
});

async function runCompatLoop(opts: {
  creds: ProviderCredentials;
  run: ResolvedRun;
  history: MessageParam[];
  systemText: string;
  userId: number;
  send: (event: string, data: unknown) => void;
  maxTurns: number;
}): Promise<void> {
  const { creds, run, history, systemText, userId, send, maxTurns } = opts;
  const tools = chatToolsForRequest();
  let turn = 0;
  while (turn < maxTurns) {
    turn += 1;
    send("turn_start", { turn });
    const { assistantBlocks, toolUses, stopReason } = await runOpenAiCompatTurn({
      creds,
      run,
      history,
      system: systemText,
      tools,
      maxTokens: MAX_TOKENS,
      send,
    });
    history.push({ role: "assistant", content: assistantBlocks });

    if (toolUses.length > 0 && stopReason !== "tool_calls" && stopReason !== "tool_use") {
      if (stopReason === "length" || stopReason === "max_tokens") {
        history.pop();
        send("error", {
          error:
            "The assistant ran out of output space while building a tool call. "
            + "Ask it to work in smaller batches (e.g. fewer queries at a time).",
        });
        return;
      }
    }

    if (toolUses.length === 0) {
      const text = assistantBlocks
        .filter((b): b is TextBlock => (b as { type?: string }).type === "text")
        .map((b) => b.text)
        .join("\n");
      const thinking = assistantBlocks
        .filter((b): b is ThinkingBlock => (b as { type?: string }).type === "thinking")
        .map((b) => (b as ThinkingBlock).thinking)
        .join("\n");
      send("assistant_complete", { text, thinking, stop_reason: stopReason });
      return;
    }

    send("tools_running", { count: toolUses.length, aggregated: toolUses.length > 5 });
    const toolResults: ToolResultBlockParam[] = [];
    for (const tu of toolUses) {
      send("tool_call", { id: tu.id, name: tu.name, input: tu.input });
      const result = await runTool({ userId }, tu.name, tu.input as Record<string, unknown>);
      send("tool_result", { id: tu.id, name: tu.name, result });
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: clampToolResult(result),
      });
    }
    history.push({ role: "user", content: toolResults });
  }
  send("error", { error: `stopped after ${maxTurns} turns` });
}

chatRouter.post("/send", async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const defaultModel = getDefaultModel();
  const requestedModel = parsed.data.model;
  if (requestedModel && !isModelEnabled(requestedModel)) {
    res.status(400).json({
      error: `Model "${requestedModel}" is not enabled for this workspace.`,
    });
    return;
  }
  const model = requestedModel || defaultModel;
  const spec = findModel(model);
  if (!spec) {
    res.status(400).json({ error: `unknown model: ${model}` });
    return;
  }
  let creds;
  try {
    creds = await getProviderCredentials(spec.provider);
  } catch (err) {
    res.status(503).json({ error: (err as Error).message });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    res.write(`event: ${event}\n`);
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  const userId = req.user!.sub;
  const conv = loadConversation(userId, parsed.data.conversation_id ?? null);
  // Normalise once with the new message included, so a repaired history that
  // now ends on a user turn merges with it instead of doubling up.
  const history: MessageParam[] = sanitizeHistory([
    ...conv.history,
    { role: "user", content: parsed.data.message },
  ]);
  send("user_saved", { conversation_id: conv.id });

  const run = resolveRun({
    model,
    effort: parsed.data.effort ?? null,
    thinking: parsed.data.thinking ?? true,
    maxTokens: MAX_TOKENS,
  });
  for (const note of run.notes) send("notice", { text: note });
  send("run_config", {
    model: run.model,
    label: run.spec.label,
    effort: run.effort,
    thinking: run.thinking,
  });

  const searchTool = spec.provider === "anthropic" ? webSearchTool(run.model) : null;
  const workspaceBlock = parsed.data.workspace
    ? formatWorkspaceContext(parsed.data.workspace)
    : "";
  const systemText = workspaceBlock
    ? `${SYSTEM_PROMPT}\n\n${workspaceBlock}`
    : SYSTEM_PROMPT;

  let turn = 0;
  const maxTurns = 8;
  // Server-side tools run their own sampling loop; when it hits Anthropic's
  // iteration cap the turn comes back `pause_turn` and we resume it. Capped
  // separately from maxTurns so a long research turn can't starve tool turns.
  let pauseResumes = 0;
  const maxPauseResumes = 5;

  try {
    if (creds.protocol !== "anthropic") {
      await runCompatLoop({
        creds,
        run,
        history,
        systemText,
        userId,
        send,
        maxTurns,
      });
      const title = conv.history.length === 0 ? parsed.data.message.slice(0, 60) : "";
      const finalId = saveConversation(userId, conv.id, title, history);
      send("done", { conversation_id: finalId });
      return;
    }

    const client = new Anthropic({ apiKey: creds.api_key });

    while (turn < maxTurns) {
      turn += 1;
      send("turn_start", { turn });

      const systemBlocks: Array<{
        type: "text"; text: string; cache_control?: { type: "ephemeral" };
      }> = [
        { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
      ];
      if (parsed.data.workspace) {
        systemBlocks.push({
          type: "text",
          text: formatWorkspaceContext(parsed.data.workspace),
        });
      }
      const stream = client.messages.stream({
        model: run.model,
        // 4096 also had to cover thinking, so a proposal carrying several
        // queries' SQL would run out mid-tool-call. See the max_tokens branch
        // below for what that used to do to the conversation.
        max_tokens: MAX_TOKENS,
        system: systemBlocks,
        // Anthropic's server-side web search runs on their infrastructure, so
        // it sits alongside our own tools but never reaches runTool().
        tools: [...chatToolsForRequest(), ...(searchTool ? [searchTool] : [])],
        messages: history,
        // Thinking / effort come pre-shaped for this specific model — the
        // same pair 400s on several of them. See services/models.ts.
        ...run.params,
      } as Parameters<typeof client.messages.stream>[0]);

      stream.on("streamEvent", (event) => {
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "thinking") {
            send("thinking_start", { index: event.index });
          } else if (block.type === "text") {
            send("text_start", { index: event.index });
          } else if (block.type === "tool_use") {
            send("tool_start", { index: event.index, id: block.id, name: block.name });
          } else if (block.type === "server_tool_use" && block.name === "web_search") {
            // Show "searching…" the moment it starts. The query itself streams
            // in as input_json_delta, so it's filled in after finalMessage().
            // Non-search server tools are dynamic-filtering plumbing — see
            // emitServerToolActivity.
            send("tool_call", { id: block.id, name: "web_search", input: undefined });
          }
        } else if (event.type === "content_block_delta") {
          const delta = event.delta;
          if (delta.type === "thinking_delta") {
            send("thinking_delta", { index: event.index, text: delta.thinking });
          } else if (delta.type === "text_delta") {
            send("text_delta", { index: event.index, text: delta.text });
          } else if (delta.type === "input_json_delta") {
            send("tool_input_delta", { index: event.index, partial: delta.partial_json });
          }
        } else if (event.type === "content_block_stop") {
          send("block_stop", { index: event.index });
        } else if (event.type === "message_delta" && event.delta.stop_reason) {
          send("message_delta", { stop_reason: event.delta.stop_reason });
        }
      });

      const final = await stream.finalMessage();
      const assistantBlocks = final.content;
      history.push({ role: "assistant", content: assistantBlocks });

      emitServerToolActivity(assistantBlocks, send);

      // Server-side tools hit Anthropic's internal iteration cap. Resending the
      // conversation as-is resumes them — deliberately with no extra user
      // message, which the API would read as a new instruction.
      if (final.stop_reason === "pause_turn") {
        pauseResumes += 1;
        if (pauseResumes > maxPauseResumes) {
          send("error", {
            error: `Web research did not converge after ${maxPauseResumes} continuations.`,
          });
          break;
        }
        turn -= 1; // a resumed turn is the same turn, not a new one
        send("turn_paused", { turn, resume: pauseResumes });
        continue;
      }

      const toolUses = assistantBlocks.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );

      // Tool calls present but the turn didn't end *because* of them — the
      // model was cut off (usually max_tokens) partway through emitting the
      // block. Its input JSON is incomplete, so we can't run it, and leaving
      // it in history would orphan the tool_use. Drop the message and say so.
      if (toolUses.length > 0 && final.stop_reason !== "tool_use") {
        history.pop();
        send("error", {
          error:
            final.stop_reason === "max_tokens"
              ? "The assistant ran out of output space while building a tool call. "
                + "Ask it to work in smaller batches (e.g. fewer queries at a time)."
              : `Tool call was cut short (stop_reason: ${final.stop_reason}). Try again.`,
        });
        break;
      }

      if (toolUses.length === 0) {
        const text = assistantBlocks
          .filter((b): b is TextBlock => b.type === "text")
          .map((b) => b.text)
          .join("\n");
        const thinking = assistantBlocks
          .filter((b): b is ThinkingBlock => b.type === "thinking")
          .map((b) => b.thinking)
          .join("\n");
        send("assistant_complete", { text, thinking, stop_reason: final.stop_reason });
        break;
      }

      const toolResults: ToolResultBlockParam[] = [];
      send("tools_running", { count: toolUses.length, aggregated: toolUses.length > 5 });

      for (const tu of toolUses) {
        send("tool_call", { id: tu.id, name: tu.name, input: tu.input });
        const result = await runTool({ userId }, tu.name, tu.input as Record<string, unknown>);
        send("tool_result", { id: tu.id, name: tu.name, result });
        toolResults.push({
          type: "tool_result",
          tool_use_id: tu.id,
          content: clampToolResult(result),
        });
      }

      const userBlocks: ContentBlockParam[] = toolResults;
      history.push({ role: "user", content: userBlocks });
    }

    if (turn >= maxTurns) {
      send("error", { error: `stopped after ${maxTurns} turns` });
    }

    const title = conv.history.length === 0 ? parsed.data.message.slice(0, 60) : "";
    const finalId = saveConversation(userId, conv.id, title, history);
    send("done", { conversation_id: finalId });
  } catch (err) {
    send("error", { error: (err as Error).message });
  } finally {
    res.end();
  }
});
