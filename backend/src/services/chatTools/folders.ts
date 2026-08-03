/**
 * Folder (collection) tools.
 *
 * Folders were previously invisible to the agent: `propose_new_query` took a
 * `folder_id` but nothing could produce one, so "put these in a new subfolder"
 * dead-ended on "create it in the UI and tell me the id".
 *
 * `propose_new_folder` closes that by optionally carrying the queries that
 * belong in it. Accept creates the folder, then creates each query inside it —
 * which sidesteps the ordering problem, since the folder's id doesn't exist
 * until the user accepts. Same shape as `propose_new_dashboard` seeding its
 * widgets.
 */

import { db } from "../../db/index.js";
import { safeParse, type ToolHandler, type ToolModule } from "./types.js";

interface FolderRow {
  id: number;
  parent_id: number | null;
  name: string;
}

/** "Whoop / August" — so the model can talk about nesting without walking parents. */
function folderPaths(userId: number): Map<number, string> {
  const rows = db
    .prepare("SELECT id, parent_id, name FROM folders WHERE user_id = ?")
    .all(userId) as FolderRow[];
  const byId = new Map(rows.map((r) => [r.id, r]));
  const paths = new Map<number, string>();
  for (const row of rows) {
    const parts: string[] = [];
    let cur: FolderRow | undefined = row;
    // Depth guard: a cycle would otherwise spin here forever.
    for (let i = 0; cur && i < 32; i++) {
      parts.unshift(cur.name);
      cur = cur.parent_id == null ? undefined : byId.get(cur.parent_id);
    }
    paths.set(row.id, parts.join(" / "));
  }
  return paths;
}

const list_folders: ToolHandler = (ctx) => {
  const paths = folderPaths(ctx.userId);
  const rows = db
    .prepare(
      `SELECT f.id, f.parent_id, f.name,
              (SELECT COUNT(*) FROM queries q WHERE q.folder_id = f.id) AS query_count
       FROM folders f WHERE f.user_id = ?
       ORDER BY f.parent_id IS NULL DESC, f.parent_id, f.sort_order, f.name`,
    )
    .all(ctx.userId) as Array<FolderRow & { query_count: number }>;
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    parent_id: r.parent_id,
    path: paths.get(r.id) ?? r.name,
    query_count: r.query_count,
  }));
};

interface SeedQueryInput {
  name?: unknown;
  sql?: unknown;
  connection_id?: unknown;
  chart_type?: unknown;
  chart_config?: unknown;
  chart_mode?: unknown;
  chart_python_code?: unknown;
}

const propose_new_folder: ToolHandler = (ctx, input) => {
  const name = String(input.name ?? "").trim();
  if (!name) return { error: "name is required", success: false };

  const parentId = (input.parent_id as number | null | undefined) ?? null;
  let parentPath: string | null = null;
  if (parentId != null) {
    const parent = db
      .prepare("SELECT id, name FROM folders WHERE id = ? AND user_id = ?")
      .get(parentId, ctx.userId) as { id: number; name: string } | undefined;
    if (!parent) {
      return {
        error: `folder #${parentId} not found, or it isn't yours. Use list_folders first.`,
        success: false,
      };
    }
    parentPath = folderPaths(ctx.userId).get(parentId) ?? parent.name;
  }

  // Validate every seeded query up front. A half-valid proposal would show
  // the user a card that accept-time then refuses partway through.
  const seeds = (input.queries as SeedQueryInput[] | undefined) ?? [];
  if (seeds.length > 100) {
    return { error: "capped at 100 queries per folder proposal", success: false };
  }
  const connCache = new Map<number, string>();
  const queries = [];
  for (const [i, s] of seeds.entries()) {
    const qName = String(s.name ?? "").trim();
    const sql = String(s.sql ?? "").trim();
    const connId = Number(s.connection_id);
    if (!qName || !sql) {
      return { error: `queries[${i}]: name and sql are required`, success: false };
    }
    if (!Number.isFinite(connId)) {
      return { error: `queries[${i}] ("${qName}"): connection_id is required`, success: false };
    }
    if (!connCache.has(connId)) {
      const c = db
        .prepare("SELECT id, name FROM connections WHERE id = ? AND user_id = ?")
        .get(connId, ctx.userId) as { id: number; name: string } | undefined;
      if (!c) {
        return {
          error:
            `queries[${i}] ("${qName}"): connection #${connId} not found, or you don't `
            + "have access to it. Use list_connections to pick a valid id.",
          success: false,
        };
      }
      connCache.set(connId, c.name);
    }
    queries.push({
      name: qName,
      sql,
      connection_id: connId,
      connection_name: connCache.get(connId)!,
      chart_type: (s.chart_type as string | undefined) ?? "bar",
      chart_config: (s.chart_config as Record<string, unknown> | undefined) ?? {},
      chart_mode: (s.chart_mode as string | undefined) ?? "picker",
      chart_python_code: (s.chart_python_code as string | undefined) ?? null,
    });
  }

  return {
    success: true,
    proposal: {
      kind: "new_folder",
      rationale: input.rationale as string | undefined,
      folder: {
        name,
        parent_id: parentId,
        parent_path: parentPath,
        queries,
      },
    },
  };
};

const propose_move_queries: ToolHandler = (ctx, input) => {
  const ids = (input.query_ids as number[] | undefined) ?? [];
  if (ids.length === 0) return { error: "query_ids is empty", success: false };
  const folderId = (input.folder_id as number | null | undefined) ?? null;

  let folderPath: string | null = null;
  if (folderId != null) {
    const f = db
      .prepare("SELECT id, name FROM folders WHERE id = ? AND user_id = ?")
      .get(folderId, ctx.userId) as { id: number; name: string } | undefined;
    if (!f) {
      return { error: `folder #${folderId} not found, or it isn't yours.`, success: false };
    }
    folderPath = folderPaths(ctx.userId).get(folderId) ?? f.name;
  }

  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT id, name, folder_id FROM queries WHERE user_id = ? AND id IN (${placeholders})`,
    )
    .all(ctx.userId, ...ids) as Array<{ id: number; name: string; folder_id: number | null }>;
  const found = new Set(rows.map((r) => r.id));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    return {
      error: `not your queries: ${missing.join(", ")}. Use list_saved_queries first.`,
      success: false,
    };
  }

  return {
    success: true,
    proposal: {
      kind: "move_queries",
      rationale: input.rationale as string | undefined,
      folder_id: folderId,
      folder_path: folderPath,
      queries: rows.map((r) => ({ id: r.id, name: r.name, from_folder_id: r.folder_id })),
    },
  };
};

const seedQuerySchema = {
  type: "object" as const,
  properties: {
    name: { type: "string" },
    sql: { type: "string" },
    connection_id: { type: "number", description: "Id from list_connections" },
    chart_type: { type: "string" },
    chart_config: { type: "object", additionalProperties: { type: "string" } },
    chart_mode: { type: "string", description: "'picker' or 'python'" },
    chart_python_code: {
      type: "string",
      description:
        "Custom python code (sets `fig`). Must be theme-aware — see the chart code rules.",
    },
  },
  required: ["name", "sql", "connection_id"],
};

export const folderTools: ToolModule = {
  tools: [
    {
      name: "list_folders",
      description:
        "List the user's folders (collections) with their id, nesting path, and how many saved queries each holds. Call this before proposing a folder or moving queries into one.",
      input_schema: { type: "object", properties: {} },
    },
    {
      name: "propose_new_folder",
      description:
        "Propose creating a folder (collection), optionally pre-filled with new saved queries. "
        + "Accepting creates the folder and then every query inside it, so use this whenever the "
        + "user wants queries in a folder that doesn't exist yet — you do not need the folder id "
        + "in advance. Pass parent_id to nest it under an existing folder. DOES NOT mutate the DB.",
      input_schema: {
        type: "object",
        properties: {
          name: { type: "string", description: "Folder name, e.g. 'August'" },
          parent_id: {
            type: "number",
            description: "Parent folder id from list_folders. Omit for a top-level folder.",
          },
          queries: {
            type: "array",
            description:
              "Saved queries to create inside the new folder. To duplicate existing queries, "
              + "read their full SQL with get_saved_queries first.",
            items: seedQuerySchema,
          },
          rationale: { type: "string" },
        },
        required: ["name"],
      },
    },
    {
      name: "propose_move_queries",
      description:
        "Propose moving existing saved queries into a folder (or to the root with folder_id null). Returns one Accept/Reject card listing every move. DOES NOT mutate the DB.",
      input_schema: {
        type: "object",
        properties: {
          query_ids: { type: "array", items: { type: "number" } },
          folder_id: {
            type: "number",
            description: "Destination folder id from list_folders. Omit or null for the root.",
          },
          rationale: { type: "string" },
        },
        required: ["query_ids"],
      },
    },
  ],
  handlers: { list_folders, propose_new_folder, propose_move_queries },
};

// Shared with queries.ts so both modules render the same folder paths.
export { folderPaths };
