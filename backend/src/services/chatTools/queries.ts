/**
 * Query + chart proposal tools. Every mutation is a *proposal* — the
 * UI renders an Accept/Reject card; nothing here writes the DB.
 */

import { db } from "../../db/index.js";
import { safeParse, type ToolHandler, type ToolModule } from "./types.js";

const list_saved_queries: ToolHandler = (ctx) => {
  const rows = db
    .prepare(
      `SELECT id, name, connection_id, folder_id, sql,
              chart_type, chart_mode, chart_config_json, chart_python_code
       FROM queries WHERE user_id = ? ORDER BY updated_at DESC`,
    )
    .all(ctx.userId) as Array<{
      id: number; name: string; connection_id: number | null; folder_id: number | null;
      sql: string; chart_type: string; chart_mode: string;
      chart_config_json: string; chart_python_code: string | null;
    }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    connection_id: r.connection_id,
    folder_id: r.folder_id,
    sql: r.sql,
    chart_type: r.chart_type,
    chart_mode: r.chart_mode,
    chart_config: safeParse(r.chart_config_json),
    chart_python_code: r.chart_python_code,
  }));
};

interface ConnectionRow {
  id: number;
  name: string;
  type: string;
}

/** Verify that a connection id exists *and* belongs to the caller.
 *  Returns the row (for the proposal preview) or null. We refuse to
 *  let the agent retarget a query at someone else's connection — the
 *  user owns the data plane, the agent can only suggest within it. */
function resolveOwnedConnection(
  userId: number,
  connectionId: number,
): ConnectionRow | null {
  return (
    (db
      .prepare("SELECT id, name, type FROM connections WHERE id = ? AND user_id = ?")
      .get(connectionId, userId) as ConnectionRow | undefined) ?? null
  );
}

const propose_query_edit: ToolHandler = (ctx, input) => {
  const id = input.query_id as number;
  const row = db
    .prepare(
      "SELECT id, name, sql, connection_id FROM queries WHERE id = ? AND user_id = ?",
    )
    .get(id, ctx.userId) as
    | { id: number; name: string; sql: string; connection_id: number | null }
    | undefined;
  if (!row) return { error: `query #${id} not found`, success: false };
  const newSql = (input.new_sql as string | undefined) ?? row.sql;
  const newName = (input.new_name as string | undefined) ?? row.name;

  // Optional connection retarget. We validate ownership *before*
  // building the proposal so the diff card can't promise something
  // accept will refuse — the user sees an error in chat instead.
  // ``null`` is allowed and means "unbind" (rare but valid).
  let beforeConn: { id: number | null; name: string | null } = {
    id: row.connection_id, name: null,
  };
  let afterConn = beforeConn;
  if (row.connection_id != null) {
    const c = db
      .prepare("SELECT name FROM connections WHERE id = ? AND user_id = ?")
      .get(row.connection_id, ctx.userId) as { name: string } | undefined;
    beforeConn = { id: row.connection_id, name: c?.name ?? null };
    afterConn = beforeConn;
  }
  if (input.new_connection_id !== undefined) {
    const newId = input.new_connection_id as number | null;
    if (newId == null) {
      afterConn = { id: null, name: null };
    } else {
      const c = resolveOwnedConnection(ctx.userId, newId);
      if (!c) {
        return {
          error:
            `connection #${newId} not found, or you don't have access to it. `
            + "Use list_connections to pick a valid id.",
          success: false,
        };
      }
      afterConn = { id: c.id, name: c.name };
    }
  }

  return {
    success: true,
    proposal: {
      kind: "query_edit",
      query_id: row.id,
      rationale: input.rationale as string | undefined,
      before: { name: row.name, sql: row.sql, connection: beforeConn },
      after: { name: newName, sql: newSql, connection: afterConn },
    },
  };
};

interface BulkEditItem {
  query_id: number;
  new_sql?: string;
  new_name?: string;
  new_connection_id?: number | null;
}

interface BulkEditChange {
  query_id: number;
  query_name: string;
  before: { name: string; sql: string; connection: { id: number | null; name: string | null } };
  after: { name: string; sql: string; connection: { id: number | null; name: string | null } };
  has_sql_change: boolean;
  has_name_change: boolean;
  has_connection_change: boolean;
}

/** Bulk query edit. The typical use case is "repoint these N queries
 *  from connection A to connection B"; we also accept per-row SQL /
 *  name changes for completeness. Every item is validated; any
 *  invalid item aborts the whole proposal so the diff card never
 *  shows a change that accept-time would refuse. */
const propose_bulk_query_edit: ToolHandler = (ctx, input) => {
  const items = (input.edits as Array<Record<string, unknown>> | undefined) ?? [];
  if (items.length === 0) {
    return { error: "edits[] is empty — nothing to propose", success: false };
  }
  if (items.length > 100) {
    return { error: "bulk edit capped at 100 queries per proposal", success: false };
  }

  // Pre-collect any candidate connection ids and verify all of them
  // belong to the caller in a single round trip. Avoids the
  // N-queries-per-bulk-edit problem and gives one error per missing
  // connection instead of stopping at the first.
  const candidateConnIds = new Set<number>();
  for (const it of items) {
    if (it.new_connection_id != null) {
      candidateConnIds.add(Number(it.new_connection_id));
    }
  }
  const ownedConns = new Map<number, ConnectionRow>();
  if (candidateConnIds.size > 0) {
    const placeholders = [...candidateConnIds].map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id, name, type FROM connections
         WHERE user_id = ? AND id IN (${placeholders})`,
      )
      .all(ctx.userId, ...candidateConnIds) as ConnectionRow[];
    for (const r of rows) ownedConns.set(r.id, r);
    const missing = [...candidateConnIds].filter((id) => !ownedConns.has(id));
    if (missing.length > 0) {
      return {
        error: `not your connections: ${missing.join(", ")}. Use list_connections first.`,
        success: false,
      };
    }
  }

  // Single query for all queries the caller asks to edit. Keeps the
  // tool's runtime O(1) in DB round trips regardless of batch size.
  const queryIds = [...new Set(items.map((it) => Number(it.query_id)))];
  const placeholders = queryIds.map(() => "?").join(",");
  const queryRows = db
    .prepare(
      `SELECT q.id, q.name, q.sql, q.connection_id, c.name AS connection_name
       FROM queries q
       LEFT JOIN connections c ON c.id = q.connection_id AND c.user_id = q.user_id
       WHERE q.user_id = ? AND q.id IN (${placeholders})`,
    )
    .all(ctx.userId, ...queryIds) as Array<{
      id: number; name: string; sql: string;
      connection_id: number | null; connection_name: string | null;
    }>;
  const queryById = new Map(queryRows.map((r) => [r.id, r]));
  const missingQueries = queryIds.filter((id) => !queryById.has(id));
  if (missingQueries.length > 0) {
    return {
      error: `not your queries: ${missingQueries.join(", ")}. Use list_saved_queries first.`,
      success: false,
    };
  }

  const changes: BulkEditChange[] = [];
  for (const it of items) {
    const qid = Number(it.query_id);
    const q = queryById.get(qid)!;  // checked above
    const beforeConn = { id: q.connection_id, name: q.connection_name };
    let afterConn = beforeConn;
    if (it.new_connection_id !== undefined) {
      const newId = it.new_connection_id as number | null;
      afterConn = newId == null
        ? { id: null, name: null }
        : { id: newId, name: ownedConns.get(newId)?.name ?? null };
    }
    const newName = (it.new_name as string | undefined) ?? q.name;
    const newSql = (it.new_sql as string | undefined) ?? q.sql;
    changes.push({
      query_id: qid,
      query_name: q.name,
      before: { name: q.name, sql: q.sql, connection: beforeConn },
      after: { name: newName, sql: newSql, connection: afterConn },
      has_sql_change: newSql !== q.sql,
      has_name_change: newName !== q.name,
      has_connection_change: afterConn.id !== beforeConn.id,
    });
  }

  // Drop no-op rows so the diff card doesn't show "edit this query"
  // for queries the agent left identical.
  const effective = changes.filter(
    (c) => c.has_sql_change || c.has_name_change || c.has_connection_change,
  );
  if (effective.length === 0) {
    return {
      error: "every item is a no-op — nothing would change. Did you forget new_connection_id?",
      success: false,
    };
  }

  return {
    success: true,
    proposal: {
      kind: "bulk_query_edit",
      rationale: input.rationale as string | undefined,
      changes: effective,
    },
  };
};

const propose_chart_change: ToolHandler = (ctx, input) => {
  const id = input.query_id as number;
  const row = db
    .prepare(
      `SELECT id, name, chart_type, chart_mode, chart_config_json, chart_python_code
       FROM queries WHERE id = ? AND user_id = ?`,
    )
    .get(id, ctx.userId) as {
      id: number; name: string; chart_type: string; chart_mode: string;
      chart_config_json: string; chart_python_code: string | null;
    } | undefined;
  if (!row) return { error: `query #${id} not found`, success: false };
  const before = {
    chart_type: row.chart_type,
    chart_mode: row.chart_mode,
    chart_config: safeParse(row.chart_config_json),
    chart_python_code: row.chart_python_code,
  };
  const after = {
    chart_type: (input.chart_type as string | undefined) ?? before.chart_type,
    chart_mode: (input.chart_mode as string | undefined) ?? before.chart_mode,
    chart_config: (input.chart_config as Record<string, unknown> | undefined) ?? before.chart_config,
    chart_python_code: (input.chart_python_code as string | undefined) ?? before.chart_python_code,
  };
  return {
    success: true,
    proposal: {
      kind: "chart_change",
      query_id: row.id,
      query_name: row.name,
      rationale: input.rationale as string | undefined,
      before, after,
    },
  };
};

const propose_new_query: ToolHandler = (_ctx, input) => ({
  success: true,
  proposal: {
    kind: "new_query",
    rationale: input.rationale as string | undefined,
    query: {
      name: input.name as string,
      sql: input.sql as string,
      connection_id: input.connection_id as number,
      folder_id: (input.folder_id as number | undefined) ?? null,
      chart_type: (input.chart_type as string | undefined) ?? "bar",
      chart_config: (input.chart_config as Record<string, unknown> | undefined) ?? {},
      chart_mode: (input.chart_mode as string | undefined) ?? "picker",
      chart_python_code: (input.chart_python_code as string | undefined) ?? null,
    },
  },
});

const propose_delete_query: ToolHandler = (ctx, input) => {
  const id = input.query_id as number;
  const row = db
    .prepare("SELECT id, name, sql FROM queries WHERE id = ? AND user_id = ?")
    .get(id, ctx.userId) as { id: number; name: string; sql: string } | undefined;
  if (!row) return { error: `query #${id} not found`, success: false };
  return {
    success: true,
    proposal: {
      kind: "delete_query",
      query_id: row.id,
      rationale: input.rationale as string | undefined,
      target: { name: row.name, sql: row.sql },
    },
  };
};

export const queryTools: ToolModule = {
  tools: [
    {
      name: "list_saved_queries",
      description:
        "List the user's saved queries (id, name, connection, chart settings). Call this before any propose_* tool so you can target the right query by id.",
      input_schema: { type: "object", properties: {}, required: [] },
    },
    {
      name: "propose_query_edit",
      description:
        "Propose changes to an EXISTING saved query (SQL, name, and/or the connection it targets). Returns a proposal the UI renders as a Cursor-style diff with Accept/Reject. To repoint a query at another data source without rewriting its SQL, pass new_connection_id alone — leave new_sql unset. DOES NOT mutate the DB.",
      input_schema: {
        type: "object",
        properties: {
          query_id: { type: "number", description: "Id from list_saved_queries" },
          new_sql: { type: "string", description: "Replacement SQL. Omit to leave SQL unchanged." },
          new_name: { type: "string", description: "Replacement name. Omit to leave name unchanged." },
          new_connection_id: {
            type: "number",
            description:
              "Optional. Repoint the saved query at another connection (id from list_connections). The connection must belong to the same user; the proposal is rejected before the user sees it if not. Pair this with leaving new_sql unset to migrate the query without rewriting it.",
          },
          rationale: { type: "string", description: "One-line explanation shown to the user above the diff." },
        },
        required: ["query_id"],
      },
    },
    {
      name: "propose_bulk_query_edit",
      description:
        "Propose the same kind of edit (SQL / name / connection retarget) across many saved queries at once. The typical use is 'repoint these N queries from connection A to connection B' — set new_connection_id on each edits[] item and leave new_sql unset. The UI renders one Accept/Reject card that lists every change, validates all queries + connections belong to the user, and refuses no-op rows. DOES NOT mutate the DB.",
      input_schema: {
        type: "object",
        properties: {
          edits: {
            type: "array",
            description: "One row per query to edit. Each row references a query id and the fields to change; omit a field to leave it.",
            items: {
              type: "object",
              properties: {
                query_id: { type: "number" },
                new_sql: { type: "string" },
                new_name: { type: "string" },
                new_connection_id: { type: "number" },
              },
              required: ["query_id"],
            },
          },
          rationale: { type: "string" },
        },
        required: ["edits"],
      },
    },
    {
      name: "propose_chart_change",
      description:
        "Propose changing the chart settings attached to an EXISTING saved query (chart_type / chart_config / python_code / chart_mode). Returns a proposal the UI renders for Accept/Reject. DOES NOT mutate the DB.",
      input_schema: {
        type: "object",
        properties: {
          query_id: { type: "number" },
          chart_type: { type: "string", description: "e.g. bar, line, scatter, pie, histogram" },
          chart_config: {
            type: "object",
            description: "Picker field bindings, e.g. {x: 'date', y: 'value'}",
            additionalProperties: { type: "string" },
          },
          chart_python_code: { type: "string", description: "Custom python code (sets `fig`). Switches mode to python." },
          chart_mode: { type: "string", description: "'picker' or 'python'" },
          rationale: { type: "string" },
        },
        required: ["query_id"],
      },
    },
    {
      name: "propose_new_query",
      description:
        "Propose creating a brand-new saved query (SQL + name + optional chart). Returns a proposal the UI renders with a preview and an Accept button. DOES NOT mutate the DB.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string" },
          sql: { type: "string" },
          connection_id: { type: "number", description: "Id from list_connections" },
          folder_id: { type: "number", description: "Optional folder/collection id" },
          chart_type: { type: "string" },
          chart_config: { type: "object", additionalProperties: { type: "string" } },
          chart_mode: { type: "string", description: "'picker' or 'python'" },
          chart_python_code: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["name", "sql", "connection_id"],
      },
    },
    {
      name: "propose_delete_query",
      description:
        "Propose deleting an existing saved query. Returns a proposal the UI renders with a confirm prompt. DOES NOT mutate the DB.",
      input_schema: {
        type: "object",
        properties: {
          query_id: { type: "number" },
          rationale: { type: "string" },
        },
        required: ["query_id"],
      },
    },
  ],
  handlers: {
    list_saved_queries, propose_query_edit, propose_bulk_query_edit,
    propose_chart_change, propose_new_query, propose_delete_query,
  },
};
