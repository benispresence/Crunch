"""
AI Agent service for NiceMeta.

Integrates Anthropic (Claude) and OpenAI (GPT) models with tool calling
to query connected databases, inspect schemas, and assist with SQL/Python.

API keys are stored per-user in NiceGUI's encrypted app.storage.user.
Uses httpx (already a project dependency) – no extra packages required.
"""

from __future__ import annotations

import json
import logging
import re
from typing import Any, Callable

import httpx

logger = logging.getLogger(__name__)

# SQL statements that are NOT allowed via the AI agent
_UNSAFE_SQL_PATTERN = re.compile(
    r"^\s*(INSERT|UPDATE|DELETE|DROP|TRUNCATE|ALTER|CREATE|GRANT|REVOKE|MERGE)\b",
    re.IGNORECASE | re.MULTILINE,
)


# ── Available models ──────────────────────────────────────────────────────────

ANTHROPIC_MODELS: dict[str, str] = {
    "claude-opus-4-6": "Claude Opus 4.6 (most capable)",
    "claude-sonnet-4-6": "Claude Sonnet 4.6 (balanced)",
    "claude-haiku-4-5-20251001": "Claude Haiku 4.5 (fastest)",
}

OPENAI_MODELS: dict[str, str] = {
    "gpt-4o": "GPT-4o (most capable)",
    "gpt-4o-mini": "GPT-4o Mini (fast & cheap)",
    "gpt-4-turbo": "GPT-4 Turbo",
}

ALL_MODELS: dict[str, dict[str, str]] = {
    "anthropic": ANTHROPIC_MODELS,
    "openai": OPENAI_MODELS,
}


# ── System prompt ─────────────────────────────────────────────────────────────

_SYSTEM_BASE = """You are an intelligent AI assistant embedded in **NiceMeta**, an open-source Business Intelligence platform (similar to Metabase).

## What NiceMeta can do
- Connect to PostgreSQL, MySQL, SQLite, and SQL Server databases
- Run SQL queries and display results as tables or interactive charts (bar, line, pie, scatter, etc.)
- Build queries visually (no-code query builder) or through a SQL editor with Python visualization code
- Save queries and organize them in folders
- Create dashboards with multiple chart widgets
- Visualizations can be customized with auto-generated or hand-written Python (Plotly)

## Your capabilities
You can help users by:
1. **Writing and optimizing SQL** – write queries, fix errors, explain query plans
2. **Querying databases** – use `execute_sql` to run queries and show results inline
3. **Schema inspection** – use `get_schema` to understand table structures before writing SQL
4. **Proposing edits** – use `propose_sql_edit` or `propose_python_edit` to suggest code changes; the user sees a diff and can accept or reject
5. **Navigating** – use `navigate_to` to open specific pages, queries, or dashboards
6. **Answering BI questions** – explain charts, suggest best practices, help with data analysis
7. **Saving queries** – use `save_query` to save the current SQL as a named saved question
8. **Dashboard management** – use `create_dashboard` to create dashboards, `add_widget_to_dashboard` to add saved queries as widgets

## Rules
- Always inspect the schema (`get_schema`) before writing SQL for a connection you haven't seen yet
- Prefer `propose_sql_edit` over explaining changes in text when the user is editing SQL
- Keep responses concise; use markdown formatting (headers, bullet points, code blocks)
- When showing query results, summarize the key insights, don't just dump raw data
- Ask for the connection to use if it's ambiguous
"""


def _build_system(context: dict) -> str:
    """Build system prompt with page context injected."""
    parts = [_SYSTEM_BASE]

    if context.get("current_page"):
        parts.append(f"\n## Current page\n`{context['current_page']}`")

    if context.get("current_sql"):
        escaped = context["current_sql"][:3000]  # truncate very long SQL
        parts.append(f"\n## SQL currently in the editor\n```sql\n{escaped}\n```")

    if context.get("current_python"):
        escaped = context["current_python"][:3000]
        parts.append(f"\n## Python visualization code currently in the editor\n```python\n{escaped}\n```")

    if context.get("current_connection_id"):
        parts.append(f"\n## Active connection ID\n`{context['current_connection_id']}`")

    if context.get("query_id"):
        parts.append(f"\n## Current saved query ID\n`{context['query_id']}`")

    return "\n".join(parts)


# ── Tool definitions (Anthropic format) ───────────────────────────────────────

TOOLS: list[dict] = [
    {
        "name": "list_connections",
        "description": "List all database connections configured in NiceMeta (name, type, id).",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "get_schema",
        "description": (
            "Get the full schema for a database connection: all schemas, tables, and columns "
            "with their data types. Use this before writing SQL for an unfamiliar connection."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "connection_id": {
                    "type": "string",
                    "description": "The ID of the database connection",
                }
            },
            "required": ["connection_id"],
        },
    },
    {
        "name": "execute_sql",
        "description": (
            "Execute a SQL query on a connected database and return the first N rows. "
            "Use for answering data questions or validating queries."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "connection_id": {"type": "string", "description": "Database connection ID"},
                "sql": {"type": "string", "description": "SQL query to execute"},
                "limit": {
                    "type": "integer",
                    "description": "Maximum rows to return (default 50, max 500)",
                    "default": 50,
                },
            },
            "required": ["connection_id", "sql"],
        },
    },
    {
        "name": "propose_sql_edit",
        "description": (
            "Propose a replacement for the SQL currently in the editor. "
            "The user will see a diff view and can accept or reject the change. "
            "Use this whenever you want to rewrite or fix the SQL."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "new_sql": {"type": "string", "description": "The complete new SQL code"},
                "explanation": {
                    "type": "string",
                    "description": "Brief explanation of what changed and why",
                },
            },
            "required": ["new_sql", "explanation"],
        },
    },
    {
        "name": "propose_python_edit",
        "description": (
            "Propose a replacement for the Python visualization code in the editor. "
            "The user will see a diff view and can accept or reject the change."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "new_code": {
                    "type": "string",
                    "description": "The complete new Python visualization code",
                },
                "explanation": {
                    "type": "string",
                    "description": "Brief explanation of what changed and why",
                },
            },
            "required": ["new_code", "explanation"],
        },
    },
    {
        "name": "list_saved_queries",
        "description": "List all saved SQL queries with their names, IDs, and connection info.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "list_dashboards",
        "description": "List all saved dashboards with names and IDs.",
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "navigate_to",
        "description": (
            "Navigate the user to a page in NiceMeta. "
            "Paths: / (home), /sql (new SQL query), /sql?query_id=<id> (open query), "
            "/query-builder, /dashboards, /dashboards/<id>, /connections, /admin"
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "path": {
                    "type": "string",
                    "description": "The URL path to navigate to",
                }
            },
            "required": ["path"],
        },
    },
    {
        "name": "save_query",
        "description": (
            "Save the current SQL as a named saved question. Updates the existing "
            "question if one is loaded, otherwise creates a new one. Returns the saved query ID."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Name for the saved question"},
                "sql": {
                    "type": "string",
                    "description": "SQL to save. If omitted, uses the current SQL from the editor.",
                },
            },
            "required": ["name"],
        },
    },
    {
        "name": "create_dashboard",
        "description": "Create a new empty dashboard and navigate to it.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Dashboard name"},
                "description": {"type": "string", "description": "Optional description"},
            },
            "required": ["name"],
        },
    },
    {
        "name": "add_widget_to_dashboard",
        "description": (
            "Add a saved query as a widget to an existing dashboard. "
            "The query must already be saved (use save_query first)."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "dashboard_id": {"type": "string", "description": "Target dashboard ID"},
                "query_id": {"type": "string", "description": "Saved query ID to add"},
                "chart_type": {
                    "type": "string",
                    "description": "Visualization type: table, bar, line, pie, area, scatter",
                    "default": "bar",
                },
                "width": {"type": "integer", "description": "Widget width (1-12)", "default": 6},
                "height": {"type": "integer", "description": "Widget height (1-6)", "default": 3},
            },
            "required": ["dashboard_id", "query_id"],
        },
    },
    {
        "name": "git_status",
        "description": (
            "Get the current git workspace status: branch name, whether it is clean or "
            "has uncommitted changes, and the remote origin URL. Use this to answer "
            "questions about the version history state."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "git_sync_all",
        "description": (
            "Export all NiceMeta content (queries, dashboards, connection configs) to the "
            "git workspace files and create a commit. Use when the user wants to snapshot "
            "the current state or before pushing to a remote."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "git_push",
        "description": (
            "Push the local git workspace commits to the configured remote origin. "
            "The remote must be set first (Admin → Git → Set Remote)."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
    {
        "name": "git_pull",
        "description": (
            "Pull the latest commits from the remote git origin and import any new or "
            "updated queries and dashboards into NiceMeta. Use when the user wants to "
            "refresh from a shared remote workspace."
        ),
        "input_schema": {"type": "object", "properties": {}, "required": []},
    },
]


def _tools_for_openai(tools: list[dict]) -> list[dict]:
    """Convert Anthropic-format tool definitions to OpenAI format."""
    result = []
    for t in tools:
        result.append(
            {
                "type": "function",
                "function": {
                    "name": t["name"],
                    "description": t["description"],
                    "parameters": t["input_schema"],
                },
            }
        )
    return result


# ── AgentService ──────────────────────────────────────────────────────────────


class AgentService:
    """
    Sends messages to Anthropic or OpenAI with tool calling.

    Tool side-effects:
    - DB tools (list_connections, get_schema, execute_sql) run immediately and
      return data as structured dicts.
    - Proposal tools (propose_sql_edit, propose_python_edit) return a
      `{"type": "proposal", ...}` dict that the UI panel turns into a diff view.
    - navigate_to returns `{"type": "navigation", "path": "..."}` for the panel.
    """

    def __init__(self, provider: str, api_key: str, model: str) -> None:
        self.provider = provider.lower()
        self.api_key = api_key
        self.model = model
        # Injected by the panel before each turn so tools can access DB services
        self._context: dict = {}

    # ── Public API ────────────────────────────────────────────────────────────

    async def chat(
        self,
        messages: list[dict],
        context: dict,
        on_tool_start: Callable[[str, dict], None] | None = None,
        max_tool_rounds: int = 8,
    ) -> tuple[str, list[dict]]:
        """
        Send a conversation turn to the LLM and return:
          (assistant_text, ui_actions)

        ui_actions is a list of action dicts (proposals, navigation) that the
        panel should render after the text response.
        """
        self._context = context
        system = _build_system(context)
        ui_actions: list[dict] = []

        if self.provider == "anthropic":
            text = await self._anthropic_loop(
                system, messages, ui_actions, on_tool_start, max_tool_rounds
            )
        else:
            text = await self._openai_loop(
                system, messages, ui_actions, on_tool_start, max_tool_rounds
            )

        return text, ui_actions

    # ── Anthropic ─────────────────────────────────────────────────────────────

    async def _anthropic_loop(
        self,
        system: str,
        messages: list[dict],
        ui_actions: list[dict],
        on_tool_start: Callable | None,
        rounds_left: int,
    ) -> str:
        async with httpx.AsyncClient(timeout=90.0) as client:
            while rounds_left > 0:
                rounds_left -= 1
                resp = await client.post(
                    "https://api.anthropic.com/v1/messages",
                    headers={
                        "x-api-key": self.api_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json",
                    },
                    json={
                        "model": self.model,
                        "max_tokens": 4096,
                        "system": system,
                        "tools": TOOLS,
                        "messages": messages,
                    },
                )
                resp.raise_for_status()
                data = resp.json()

                stop_reason = data.get("stop_reason")
                content_blocks = data.get("content", [])

                if stop_reason != "tool_use":
                    # Final text response
                    text = "".join(
                        b.get("text", "") for b in content_blocks if b.get("type") == "text"
                    )
                    return text

                # Process tool calls
                tool_results = []
                for block in content_blocks:
                    if block.get("type") != "tool_use":
                        continue
                    name = block["name"]
                    inputs = block.get("input", {})
                    tool_id = block["id"]

                    if on_tool_start:
                        on_tool_start(name, inputs)

                    result = await self._execute_tool(name, inputs, ui_actions)
                    tool_results.append(
                        {
                            "type": "tool_result",
                            "tool_use_id": tool_id,
                            "content": json.dumps(result),
                        }
                    )

                messages.append({"role": "assistant", "content": content_blocks})
                messages.append({"role": "user", "content": tool_results})

        return "(Max tool rounds reached)"

    # ── OpenAI ────────────────────────────────────────────────────────────────

    async def _openai_loop(
        self,
        system: str,
        messages: list[dict],
        ui_actions: list[dict],
        on_tool_start: Callable | None,
        rounds_left: int,
    ) -> str:
        oai_messages = [{"role": "system", "content": system}] + messages
        oai_tools = _tools_for_openai(TOOLS)

        async with httpx.AsyncClient(timeout=90.0) as client:
            while rounds_left > 0:
                rounds_left -= 1
                resp = await client.post(
                    "https://api.openai.com/v1/chat/completions",
                    headers={
                        "Authorization": f"Bearer {self.api_key}",
                        "content-type": "application/json",
                    },
                    json={
                        "model": self.model,
                        "max_tokens": 4096,
                        "tools": oai_tools,
                        "tool_choice": "auto",
                        "messages": oai_messages,
                    },
                )
                resp.raise_for_status()
                data = resp.json()

                choice = data["choices"][0]
                msg = choice["message"]
                finish_reason = choice.get("finish_reason")

                oai_messages.append(msg)

                if finish_reason != "tool_calls" or not msg.get("tool_calls"):
                    return msg.get("content") or ""

                # Process tool calls
                for tc in msg["tool_calls"]:
                    name = tc["function"]["name"]
                    tc_id = tc["id"]
                    try:
                        inputs = json.loads(tc["function"]["arguments"] or "{}")
                    except (json.JSONDecodeError, TypeError):
                        oai_messages.append(
                            {
                                "role": "tool",
                                "tool_call_id": tc_id,
                                "content": json.dumps({"error": "Failed to parse tool arguments"}),
                            }
                        )
                        continue

                    if on_tool_start:
                        on_tool_start(name, inputs)

                    result = await self._execute_tool(name, inputs, ui_actions)
                    oai_messages.append(
                        {
                            "role": "tool",
                            "tool_call_id": tc_id,
                            "content": json.dumps(result),
                        }
                    )

        return "(Max tool rounds reached)"

    # ── Tool execution ────────────────────────────────────────────────────────

    async def _execute_tool(
        self, name: str, inputs: dict, ui_actions: list[dict]
    ) -> Any:
        """Dispatch to the correct tool implementation."""
        try:
            if name == "list_connections":
                return await self._tool_list_connections()
            elif name == "get_schema":
                return await self._tool_get_schema(inputs["connection_id"])
            elif name == "execute_sql":
                return await self._tool_execute_sql(
                    inputs["connection_id"],
                    inputs["sql"],
                    int(inputs.get("limit", 50)),
                )
            elif name == "propose_sql_edit":
                action = {
                    "type": "sql_proposal",
                    "new_code": inputs["new_sql"],
                    "old_code": self._context.get("current_sql", ""),
                    "explanation": inputs.get("explanation", ""),
                }
                ui_actions.append(action)
                return {"status": "proposal_shown", "explanation": inputs.get("explanation", "")}
            elif name == "propose_python_edit":
                action = {
                    "type": "python_proposal",
                    "new_code": inputs["new_code"],
                    "old_code": self._context.get("current_python", ""),
                    "explanation": inputs.get("explanation", ""),
                }
                ui_actions.append(action)
                return {"status": "proposal_shown", "explanation": inputs.get("explanation", "")}
            elif name == "list_saved_queries":
                return await self._tool_list_saved_queries()
            elif name == "list_dashboards":
                return await self._tool_list_dashboards()
            elif name == "navigate_to":
                path = inputs["path"]
                if not path.startswith("/") or "//" in path:
                    return {"error": "Invalid navigation path"}
                action = {"type": "navigation", "path": path}
                ui_actions.append(action)
                return {"status": "navigating", "path": path}
            elif name == "save_query":
                result = await self._tool_save_query(
                    inputs["name"], inputs.get("sql"),
                )
                if result.get("status") == "saved":
                    ui_actions.append({
                        "type": "query_saved",
                        "query_id": result["query_id"],
                        "name": inputs["name"],
                    })
                return result
            elif name == "create_dashboard":
                result = await self._tool_create_dashboard(
                    inputs["name"], inputs.get("description", ""),
                )
                if result.get("navigate_path"):
                    ui_actions.append({"type": "navigation", "path": result["navigate_path"]})
                return result
            elif name == "add_widget_to_dashboard":
                return await self._tool_add_widget(
                    inputs["dashboard_id"], inputs["query_id"],
                    inputs.get("chart_type", "bar"),
                    int(inputs.get("width", 6)),
                    int(inputs.get("height", 3)),
                )
            elif name == "git_status":
                return await self._tool_git_status()
            elif name == "git_sync_all":
                return await self._tool_git_sync_all()
            elif name == "git_push":
                return await self._tool_git_push()
            elif name == "git_pull":
                return await self._tool_git_pull()
            else:
                return {"error": f"Unknown tool: {name}"}
        except Exception as exc:
            logger.exception("Tool execution error in '%s'", name)
            return {"error": "An internal error occurred while executing the tool."}

    # ── Tool implementations ──────────────────────────────────────────────────

    async def _get_adapter(self, connection_id: str):
        """Look up a connection and return (adapter, None) or (None, error_dict)."""
        from crunch.services.connection_service import get_connection_by_id
        from crunch.ui.utils import create_adapter_from_connection

        conn = await get_connection_by_id(connection_id)
        if not conn:
            return None, {"error": f"Connection '{connection_id}' not found"}

        adapter = await create_adapter_from_connection(conn)
        return adapter, None

    async def _tool_list_connections(self) -> dict:
        from crunch.services.connection_service import get_connections

        conns = await get_connections()
        return {
            "connections": [
                {"id": c["id"], "name": c["name"], "type": c["db_type"]}
                for c in conns
            ]
        }

    async def _tool_get_schema(self, connection_id: str) -> dict:
        adapter, err = await self._get_adapter(connection_id)
        if err:
            return err

        try:
            tables = await adapter.get_tables()
            schema: dict[str, list[dict]] = {}
            for table in tables[:60]:  # cap to avoid huge context
                table_name = (
                    f"{table.schema}.{table.name}" if table.schema else table.name
                )
                cols = await adapter.get_columns(table.name, table.schema)
                schema[table_name] = [
                    {
                        "column": c.name,
                        "type": c.data_type,
                        "nullable": c.nullable,
                        "primary_key": c.primary_key,
                    }
                    for c in cols
                ]
            return {"connection": connection_id, "schema": schema}
        finally:
            await adapter.close()

    async def _tool_execute_sql(
        self, connection_id: str, sql: str, limit: int = 50
    ) -> dict:
        limit = min(limit, 500)

        # Restrict to read-only queries
        if _UNSAFE_SQL_PATTERN.search(sql):
            return {"error": "Only SELECT queries are allowed via the AI agent."}

        adapter, err = await self._get_adapter(connection_id)
        if err:
            return err

        try:
            result = await adapter.execute_query(sql, limit=limit)
            if result.error:
                return {"error": result.error}
            df = result.to_dataframe()
            rows = df.head(limit).to_dict("records")
            # Serialize non-JSON-safe types
            safe_rows = []
            for row in rows:
                safe_row = {}
                for k, v in row.items():
                    try:
                        json.dumps(v)
                        safe_row[k] = v
                    except (TypeError, ValueError):
                        safe_row[k] = str(v)
                safe_rows.append(safe_row)
            return {
                "columns": list(df.columns),
                "rows": safe_rows,
                "row_count": result.row_count,
                "execution_time_ms": result.execution_time_ms,
            }
        finally:
            await adapter.close()

    async def _tool_list_saved_queries(self) -> dict:
        from crunch.services.query_service import get_saved_queries

        queries = await get_saved_queries()
        return {
            "queries": [
                {"id": q["id"], "name": q["name"], "connection_id": q.get("connection_id")}
                for q in queries
            ]
        }

    async def _tool_list_dashboards(self) -> dict:
        from crunch.services.dashboard_service import get_dashboards

        dashboards = await get_dashboards()
        return {
            "dashboards": [
                {"id": d["id"], "name": d["name"]}
                for d in dashboards
            ]
        }

    async def _tool_save_query(self, name: str, sql: str | None = None) -> dict:
        from crunch.ui.components.sidebar import save_query as sidebar_save_query

        sql = sql or self._context.get("current_sql", "")
        connection_id = self._context.get("current_connection_id", "")
        query_id = self._context.get("query_id")

        if not sql.strip():
            return {"error": "No SQL to save"}
        if not connection_id:
            return {"error": "No connection selected"}

        saved = await sidebar_save_query(
            name=name, sql=sql, connection_id=connection_id, query_id=query_id,
        )
        return {"status": "saved", "query_id": saved["id"], "name": name}

    async def _tool_create_dashboard(self, name: str, description: str = "") -> dict:
        from crunch.ui.components.sidebar import create_dashboard as sidebar_create_dashboard

        dashboard = await sidebar_create_dashboard(name=name, description=description)
        return {
            "status": "created",
            "dashboard_id": dashboard["id"],
            "name": name,
            "navigate_path": f"/dashboards/{dashboard['id']}",
        }

    async def _tool_add_widget(
        self, dashboard_id: str, query_id: str,
        chart_type: str = "bar", width: int = 6, height: int = 3,
    ) -> dict:
        from crunch.services.dashboard_service import (
            add_widget_to_dashboard, get_dashboard_by_id,
        )

        dashboard = await get_dashboard_by_id(dashboard_id)
        if not dashboard:
            return {"error": f"Dashboard '{dashboard_id}' not found"}

        widgets = dashboard.get("widgets", [])
        max_y = max(
            (w.get("position_y", 0) + w.get("height", 4) for w in widgets),
            default=0,
        )

        widget = await add_widget_to_dashboard(
            dashboard_id=dashboard_id,
            query_id=query_id,
            chart_type=chart_type,
            position_x=0,
            position_y=max_y,
            width=width,
            height=height,
        )
        if widget:
            return {"status": "widget_added", "widget_id": widget.get("id")}
        return {"error": "Failed to add widget"}

    async def _tool_git_status(self) -> dict:
        from crunch.services.git_service import get_git_service

        git = get_git_service()
        return {
            "short_status": git.get_short_status(),
            "full_status": git.get_status(),
            "remote": git.get_remote(),
            "branch": git.get_current_branch(),
            "initialized": git.is_initialized(),
        }

    async def _tool_git_sync_all(self) -> dict:
        from crunch.services.git_service import get_git_service

        git = get_git_service()
        summary = await git.sync_all()
        return {"result": summary}

    async def _tool_git_push(self) -> dict:
        from crunch.services.git_service import get_git_service

        git = get_git_service()
        ok, msg = await git.push()
        return {"success": ok, "message": msg}

    async def _tool_git_pull(self) -> dict:
        from crunch.services.git_service import get_git_service

        git = get_git_service()
        ok, msg = await git.pull()
        return {"success": ok, "message": msg}
