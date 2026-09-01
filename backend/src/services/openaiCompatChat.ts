/**
 * OpenAI-compatible chat runtime used by xAI, OpenAI, and Google Gemini.
 *
 * Conversation history is stored in Anthropic's block shape so switching labs
 * mid-thread still replays. This module converts that history, streams the
 * upstream SSE, and writes Anthropic-shaped assistant/tool blocks back.
 *
 * Two wire protocols:
 *   - chat_completions — `/chat/completions` (OpenAI, Gemini compat, xAI API key)
 *   - responses        — `/responses` (Grok SuperGrok subscription proxy)
 */

import type {
  ContentBlockParam,
  MessageParam,
  ToolResultBlockParam,
  ToolUseBlock,
} from "@anthropic-ai/sdk/resources/messages/messages.js";
import type { Tool } from "@anthropic-ai/sdk/resources/messages/messages.js";
import { request } from "undici";
import type { ProviderCredentials } from "./aiProviders.js";
import { openaiReasoningEffort, type ResolvedRun } from "./models.js";

export type ChatSend = (event: string, data: unknown) => void;

interface OpenAiToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface StreamResult {
  text: string;
  thinking: string;
  toolCalls: OpenAiToolCall[];
  stopReason: string;
}

function toOpenAiTools(tools: Tool[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.name,
      description: t.description,
      parameters: t.input_schema,
    },
  }));
}

function toResponsesTools(tools: Tool[]): unknown[] {
  return tools.map((t) => ({
    type: "function",
    name: t.name,
    description: t.description,
    parameters: t.input_schema,
  }));
}

interface OpenAiMessage {
  role: string;
  content?: string | null;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

function historyToChatCompletions(history: MessageParam[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  for (const msg of history) {
    const content = msg.content;
    if (typeof content === "string") {
      out.push({ role: msg.role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    if (msg.role === "user") {
      const texts: string[] = [];
      for (const b of content) {
        const blk = b as { type?: string; text?: string; tool_use_id?: string; content?: unknown };
        if (blk.type === "text" && blk.text) texts.push(blk.text);
        if (blk.type === "tool_result" && blk.tool_use_id) {
          const body = typeof blk.content === "string" ? blk.content : JSON.stringify(blk.content ?? "");
          out.push({ role: "tool", tool_call_id: blk.tool_use_id, content: body });
        }
      }
      if (texts.length > 0) out.push({ role: "user", content: texts.join("\n") });
      continue;
    }

    const texts: string[] = [];
    const toolCalls: NonNullable<OpenAiMessage["tool_calls"]> = [];
    for (const b of content) {
      const blk = b as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
      if (blk.type === "text" && blk.text) texts.push(blk.text);
      if (blk.type === "tool_use" && blk.id && blk.name) {
        toolCalls.push({
          id: blk.id,
          type: "function",
          function: { name: blk.name, arguments: JSON.stringify(blk.input ?? {}) },
        });
      }
    }
    if (texts.length === 0 && toolCalls.length === 0) continue;
    out.push({
      role: "assistant",
      content: texts.length > 0 ? texts.join("\n") : null,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
    });
  }
  return out;
}

function historyToResponsesInput(history: MessageParam[]): unknown[] {
  const out: unknown[] = [];
  for (const msg of history) {
    const content = msg.content;
    if (typeof content === "string") {
      out.push({ role: msg.role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;
    if (msg.role === "user") {
      const texts: string[] = [];
      for (const b of content) {
        const blk = b as { type?: string; text?: string; tool_use_id?: string; content?: unknown };
        if (blk.type === "text" && blk.text) texts.push(blk.text);
        if (blk.type === "tool_result" && blk.tool_use_id) {
          const body = typeof blk.content === "string" ? blk.content : JSON.stringify(blk.content ?? "");
          out.push({ type: "function_call_output", call_id: blk.tool_use_id, output: body });
        }
      }
      if (texts.length > 0) out.push({ role: "user", content: texts.join("\n") });
      continue;
    }
    const texts: string[] = [];
    for (const b of content) {
      const blk = b as { type?: string; text?: string; id?: string; name?: string; input?: unknown };
      if (blk.type === "text" && blk.text) texts.push(blk.text);
      if (blk.type === "tool_use" && blk.id && blk.name) {
        out.push({
          type: "function_call",
          call_id: blk.id,
          name: blk.name,
          arguments: JSON.stringify(blk.input ?? {}),
        });
      }
    }
    if (texts.length > 0) out.push({ role: "assistant", content: texts.join("\n") });
  }
  return out;
}

function assistantBlocksFromStream(result: StreamResult): ContentBlockParam[] {
  const blocks: ContentBlockParam[] = [];
  // Don't persist OpenAI-compat reasoning as Anthropic `thinking` blocks —
  // those need a signature the Messages API would reject on replay.
  if (result.text) {
    blocks.push({ type: "text", text: result.text } as ContentBlockParam);
  }
  for (const tc of result.toolCalls) {
    let input: unknown = {};
    try {
      input = tc.arguments ? JSON.parse(tc.arguments) : {};
    } catch {
      input = { _raw: tc.arguments };
    }
    blocks.push({
      type: "tool_use",
      id: tc.id,
      name: tc.name,
      input,
    } as ToolUseBlock as unknown as ContentBlockParam);
  }
  return blocks;
}

async function* iterateSse(body: AsyncIterable<Buffer>): AsyncGenerator<{ event: string; data: string }> {
  let buf = "";
  for await (const chunk of body) {
    buf += chunk.toString("utf8");
    let sep = buf.indexOf("\n\n");
    while (sep >= 0) {
      const raw = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      sep = buf.indexOf("\n\n");
      let event = "message";
      const dataLines: string[] = [];
      for (const line of raw.split("\n")) {
        const trimmed = line.replace(/\r$/, "");
        if (trimmed.startsWith("event:")) event = trimmed.slice(6).trim();
        else if (trimmed.startsWith("data:")) dataLines.push(trimmed.slice(5).trimStart());
      }
      const data = dataLines.join("\n");
      if (data) yield { event, data };
    }
  }
}

function parseJson(data: string): Record<string, unknown> | null {
  if (data === "[DONE]") return null;
  try {
    return JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function streamChatCompletions(opts: {
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  send: ChatSend;
}): Promise<StreamResult> {
  const { statusCode, body } = await request(opts.url, {
    method: "POST",
    headers: opts.headers,
    body: JSON.stringify(opts.payload),
  });
  if (statusCode >= 400) {
    const text = await body.text();
    throw new Error(upstreamError(text, statusCode));
  }

  let text = "";
  let thinking = "";
  let thinkingStarted = false;
  let textStarted = false;
  const toolAcc = new Map<number, { id: string; name: string; arguments: string }>();
  let stopReason = "stop";

  for await (const evt of iterateSse(body)) {
    const json = parseJson(evt.data);
    if (!json) continue;
    const choices = json.choices as Array<Record<string, unknown>> | undefined;
    const choice = choices?.[0];
    if (!choice) continue;
    const delta = (choice.delta ?? {}) as Record<string, unknown>;
    const finish = choice.finish_reason;
    if (typeof finish === "string" && finish) stopReason = finish;

    const reasoning = (delta.reasoning_content ?? delta.reasoning) as string | undefined;
    if (typeof reasoning === "string" && reasoning) {
      if (!thinkingStarted) {
        opts.send("thinking_start", { index: 0 });
        thinkingStarted = true;
      }
      thinking += reasoning;
      opts.send("thinking_delta", { index: 0, text: reasoning });
    }

    if (typeof delta.content === "string" && delta.content) {
      if (!textStarted) {
        opts.send("text_start", { index: 1 });
        textStarted = true;
      }
      text += delta.content;
      opts.send("text_delta", { index: 1, text: delta.content });
    }

    const tcs = delta.tool_calls as Array<Record<string, unknown>> | undefined;
    if (Array.isArray(tcs)) {
      for (const tc of tcs) {
        const idx = typeof tc.index === "number" ? tc.index : 0;
        const cur = toolAcc.get(idx) ?? { id: "", name: "", arguments: "" };
        if (typeof tc.id === "string" && tc.id) cur.id = tc.id;
        const fn = (tc.function ?? {}) as Record<string, unknown>;
        if (typeof fn.name === "string" && fn.name) cur.name = fn.name;
        if (typeof fn.arguments === "string" && fn.arguments) cur.arguments += fn.arguments;
        toolAcc.set(idx, cur);
        if (cur.id && cur.name) {
          opts.send("tool_start", { index: 10 + idx, id: cur.id, name: cur.name });
        }
        if (fn.arguments) {
          opts.send("tool_input_delta", { index: 10 + idx, partial: String(fn.arguments) });
        }
      }
    }
  }

  const toolCalls: OpenAiToolCall[] = [...toolAcc.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, v]) => ({
      id: v.id || `call_${Math.random().toString(36).slice(2, 10)}`,
      name: v.name,
      arguments: v.arguments,
    }))
    .filter((t) => t.name);

  return { text, thinking, toolCalls, stopReason };
}

async function streamResponses(opts: {
  url: string;
  headers: Record<string, string>;
  payload: Record<string, unknown>;
  send: ChatSend;
}): Promise<StreamResult> {
  const { statusCode, body } = await request(opts.url, {
    method: "POST",
    headers: opts.headers,
    body: JSON.stringify(opts.payload),
  });
  if (statusCode >= 400) {
    const text = await body.text();
    throw new Error(upstreamError(text, statusCode));
  }

  let text = "";
  let thinking = "";
  let thinkingStarted = false;
  let textStarted = false;
  const toolByItem = new Map<string, { id: string; name: string; arguments: string }>();
  let stopReason = "stop";

  for await (const evt of iterateSse(body)) {
    const json = parseJson(evt.data);
    if (!json) continue;
    const type = String(json.type ?? evt.event ?? "");

    if (type === "response.output_text.delta" || type === "response.text.delta") {
      const delta = String(json.delta ?? json.text ?? "");
      if (!delta) continue;
      if (!textStarted) {
        opts.send("text_start", { index: 1 });
        textStarted = true;
      }
      text += delta;
      opts.send("text_delta", { index: 1, text: delta });
    } else if (
      type === "response.reasoning_summary_text.delta"
      || type === "response.reasoning.delta"
      || type === "response.reasoning_text.delta"
    ) {
      const delta = String(json.delta ?? json.text ?? "");
      if (!delta) continue;
      if (!thinkingStarted) {
        opts.send("thinking_start", { index: 0 });
        thinkingStarted = true;
      }
      thinking += delta;
      opts.send("thinking_delta", { index: 0, text: delta });
    } else if (type === "response.output_item.added") {
      const item = (json.item ?? {}) as Record<string, unknown>;
      if (item.type === "function_call" || item.type === "tool_use") {
        const callId = String(item.call_id ?? item.id ?? "");
        const name = String(item.name ?? "");
        const itemId = String(item.id ?? callId);
        if (callId && name) {
          toolByItem.set(itemId, { id: callId, name, arguments: String(item.arguments ?? "") });
          opts.send("tool_start", { index: 10, id: callId, name });
        }
      }
    } else if (type === "response.function_call_arguments.delta") {
      const itemId = String(json.item_id ?? json.output_index ?? "");
      const delta = String(json.delta ?? "");
      const cur = toolByItem.get(itemId);
      if (cur && delta) {
        cur.arguments += delta;
        opts.send("tool_input_delta", { index: 10, partial: delta });
      } else if (delta && toolByItem.size === 1) {
        const only = [...toolByItem.values()][0]!;
        only.arguments += delta;
        opts.send("tool_input_delta", { index: 10, partial: delta });
      }
    } else if (type === "response.completed" || type === "response.incomplete") {
      const response = (json.response ?? json) as Record<string, unknown>;
      const status = String(response.status ?? "");
      if (status === "incomplete") stopReason = "length";
      const output = response.output as Array<Record<string, unknown>> | undefined;
      if (Array.isArray(output)) {
        for (const item of output) {
          if (item.type === "function_call") {
            const callId = String(item.call_id ?? item.id ?? "");
            const name = String(item.name ?? "");
            const args = String(item.arguments ?? "");
            if (callId && name && ![...toolByItem.values()].some((t) => t.id === callId)) {
              toolByItem.set(callId, { id: callId, name, arguments: args });
            }
          }
        }
      }
    } else if (type === "error" || type === "response.failed") {
      const err = (json.error ?? json) as { message?: string };
      throw new Error(err.message || "upstream response failed");
    }
  }

  const toolCalls = [...toolByItem.values()].filter((t) => t.name);
  if (toolCalls.length > 0) stopReason = "tool_calls";
  return { text, thinking, toolCalls, stopReason };
}

function upstreamError(text: string, status: number): string {
  try {
    const j = JSON.parse(text) as {
      error?: { message?: string; code?: string } | string;
      message?: string;
    };
    if (typeof j.error === "string") return j.error;
    if (j.error && typeof j.error === "object" && j.error.message) {
      return j.error.code ? `${j.error.message} (${j.error.code})` : j.error.message;
    }
    if (typeof j.message === "string") return j.message;
  } catch {
    /* fall through */
  }
  return text.slice(0, 400) || `HTTP ${status}`;
}

export async function runOpenAiCompatTurn(opts: {
  creds: ProviderCredentials;
  run: ResolvedRun;
  history: MessageParam[];
  system: string;
  tools: Tool[];
  maxTokens: number;
  send: ChatSend;
}): Promise<{
  assistantBlocks: ContentBlockParam[];
  toolUses: ToolUseBlock[];
  stopReason: string;
}> {
  const { creds, run, history, system, tools, maxTokens, send } = opts;
  const reasoning = openaiReasoningEffort(run.spec, run.effort, run.thinking);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "text/event-stream",
    authorization: `Bearer ${creds.api_key}`,
    ...creds.extra_headers,
  };

  const base = creds.base_url.replace(/\/+$/, "");
  let result: StreamResult;

  if (creds.protocol === "responses") {
    const payload: Record<string, unknown> = {
      model: run.model,
      instructions: system,
      input: historyToResponsesInput(history),
      stream: true,
      store: false,
      max_output_tokens: maxTokens,
      tools: tools.length > 0 ? toResponsesTools(tools) : undefined,
    };
    if (reasoning && run.thinking) payload.reasoning = { effort: reasoning };
    try {
      result = await streamResponses({
        url: `${base}/responses`,
        headers,
        payload,
        send,
      });
    } catch (err) {
      // Some subscription accounts still speak chat/completions on the CLI proxy.
      const msg = (err as Error).message;
      if (!/404|not found|no route/i.test(msg)) throw err;
      result = await streamChatCompletions({
        url: `${base}/chat/completions`,
        headers,
        payload: chatCompletionsPayload(run.model, system, history, tools, maxTokens, reasoning, run.thinking),
        send,
      });
    }
  } else {
    result = await streamChatCompletions({
      url: `${base}/chat/completions`,
      headers,
      payload: chatCompletionsPayload(run.model, system, history, tools, maxTokens, reasoning, run.thinking),
      send,
    });
  }

  const assistantBlocks = assistantBlocksFromStream(result);
  const toolUses = assistantBlocks.filter((b): b is ToolUseBlock => (b as { type?: string }).type === "tool_use");
  return { assistantBlocks, toolUses, stopReason: result.stopReason };
}

function chatCompletionsPayload(
  model: string,
  system: string,
  history: MessageParam[],
  tools: Tool[],
  maxTokens: number,
  reasoning: string | undefined,
  thinking: boolean,
): Record<string, unknown> {
  const messages: OpenAiMessage[] = [
    { role: "system", content: system },
    ...historyToChatCompletions(history),
  ];
  const payload: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    max_tokens: maxTokens,
    tools: tools.length > 0 ? toOpenAiTools(tools) : undefined,
    tool_choice: tools.length > 0 ? "auto" : undefined,
  };
  if (reasoning) payload.reasoning_effort = thinking ? reasoning : "none";
  return payload;
}

export function toolResultBlocks(
  results: Array<{ id: string; content: string }>,
): ToolResultBlockParam[] {
  return results.map((r) => ({
    type: "tool_result",
    tool_use_id: r.id,
    content: r.content,
  }));
}
