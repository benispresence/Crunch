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
import { chatTools, runTool } from "../services/chatTools.js";
import { getAnthropicApiKey, getAnthropicModel } from "../services/settings.js";

export const chatRouter = Router();
chatRouter.use(requireAuth);

const SYSTEM_PROMPT = `You are Crunch, an analytics copilot embedded in a BI tool.

Behavior rules:
- Be concise. Prefer short, direct sentences over preambles.
- When the user asks a data question, plan briefly, call the tools, then summarize.
- Always inspect the schema (\`list_connections\` then a small \`SELECT\` against information_schema-style tables) before writing larger queries.
- For numeric results, format them readably (commas, units).
- Wrap any SQL or Python you produce in fenced code blocks with the language tag.

Modifying the user's saved queries / charts:
- NEVER mutate state silently in prose. If the user asks you to edit, create, or delete a saved query or its chart settings, you MUST call the corresponding \`propose_*\` tool. The UI renders a Cursor-style diff and lets the user Accept/Reject.
- Discovery order: \`list_saved_queries\` (find ids) → call the relevant propose tool with a one-line \`rationale\`.
- For editing existing query SQL/name: \`propose_query_edit\`.
- For changing chart_type / chart_config / python code on a saved query: \`propose_chart_change\`.
- For creating a new saved query: \`propose_new_query\` (requires connection_id from \`list_connections\`).
- For deleting a saved query: \`propose_delete_query\`.

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
  return { id: row.id, history: JSON.parse(row.messages_json) as MessageParam[] };
}

function saveConversation(
  userId: number,
  id: number | null,
  title: string,
  history: MessageParam[],
): number {
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

chatRouter.post("/send", async (req, res) => {
  const parsed = sendSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const apiKey = getAnthropicApiKey();
  const model = getAnthropicModel();
  if (!apiKey) {
    res.status(503).json({
      error: "Anthropic API key not configured. Set it in Admin → Settings.",
    });
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
  const history: MessageParam[] = [...conv.history];
  history.push({ role: "user", content: parsed.data.message });
  send("user_saved", { conversation_id: conv.id });

  const client = new Anthropic({ apiKey });
  const wantThinking = parsed.data.thinking ?? true;

  let turn = 0;
  const maxTurns = 8;

  try {
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
        model,
        max_tokens: 4096,
        system: systemBlocks,
        tools: chatTools,
        messages: history,
        // Claude 4.x uses adaptive thinking with an effort knob. The older
        // `{ type: "enabled", budget_tokens }` shape returns 400 on Sonnet 4.6+.
        ...(wantThinking
          ? {
              thinking: { type: "adaptive" },
              output_config: { effort: "low" },
            }
          : {}),
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

      const toolUses = assistantBlocks.filter(
        (b): b is ToolUseBlock => b.type === "tool_use",
      );

      if (toolUses.length === 0 || final.stop_reason !== "tool_use") {
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
          content: JSON.stringify(result).slice(0, 60_000),
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
