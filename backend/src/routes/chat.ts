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
import { config } from "../config.js";
import { db } from "../db/index.js";
import { requireAuth } from "../middleware/auth.js";
import { chatTools, runTool } from "../services/chatTools.js";

export const chatRouter = Router();
chatRouter.use(requireAuth);

const SYSTEM_PROMPT = `You are NiceMeta, an analytics copilot embedded in a BI tool.

Behavior rules:
- Be concise. Prefer short, direct sentences over preambles.
- When the user asks a data question, plan briefly, call the tools, then summarize.
- Always inspect the schema (\`list_connections\` then a small \`SELECT\` against information_schema-style tables) before writing larger queries.
- For numeric results, format them readably (commas, units).
- Wrap any SQL or Python you produce in fenced code blocks with the language tag.
- When proposing a SQL change the user should accept into their editor, end the message with a single fenced \`\`\`sql block tagged \`-- proposed\` so the UI can offer an Accept button.`;

const sendSchema = z.object({
  conversation_id: z.number().int().nullable().optional(),
  message: z.string().min(1),
  thinking: z.boolean().optional(),
});

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
  if (!config.anthropicApiKey) {
    res.status(503).json({ error: "ANTHROPIC_API_KEY not configured" });
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

  const client = new Anthropic({ apiKey: config.anthropicApiKey });
  const wantThinking = parsed.data.thinking ?? true;

  let turn = 0;
  const maxTurns = 8;

  try {
    while (turn < maxTurns) {
      turn += 1;
      send("turn_start", { turn });

      const stream = client.messages.stream({
        model: config.anthropicModel,
        max_tokens: 4096,
        system: [
          { type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } },
        ],
        tools: chatTools,
        messages: history,
        ...(wantThinking
          ? { thinking: { type: "enabled", budget_tokens: 2000 } }
          : {}),
      });

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
