"""
AI Agent panel for NiceMeta.

A right-side chat drawer with:
- Markdown-formatted LLM output
- Inline tool-call status cards
- Diff view (accept/reject) for SQL and Python proposals
- Model/provider selector
- API keys loaded from app.storage.user (set in Admin → AI tab)
"""

from __future__ import annotations

import difflib
import html as _html
import json
from typing import Callable

from nicegui import app, ui

from nicemeta.services.agent_service import (
    AgentService,
    ALL_MODELS,
    ANTHROPIC_MODELS,
    OPENAI_MODELS,
)

# ── Diff helpers ──────────────────────────────────────────────────────────────

_DIFF_STYLES = """
<style>
.nm-diff{font-family:monospace;font-size:12px;line-height:1.5;
  border-radius:6px;overflow:auto;max-height:340px;background:#1e1e1e;
  border:1px solid #3e3e42;}
.nm-diff-line{display:block;padding:0 10px;white-space:pre;}
.nm-diff-add{background:#1a3a1a;color:#4ec94e;}
.nm-diff-del{background:#3a1a1a;color:#f97583;}
.nm-diff-hunk{background:#1a1f2e;color:#7a8aaa;padding:2px 10px;font-size:11px;}
.nm-diff-ctx{color:#888;}
</style>
"""


def _make_diff_html(old: str, new: str) -> str:
    """Return an HTML snippet showing a unified diff (dark theme)."""
    old_lines = old.splitlines()
    new_lines = new.splitlines()
    diff = list(difflib.unified_diff(old_lines, new_lines, lineterm="", n=3))

    if not diff:
        return '<div class="nm-diff"><div class="nm-diff-ctx" style="padding:8px">No changes</div></div>'

    parts = [_DIFF_STYLES, '<div class="nm-diff">']
    for line in diff:
        esc = _html.escape(line)
        if line.startswith("+++") or line.startswith("---"):
            continue
        elif line.startswith("@@"):
            parts.append(f'<span class="nm-diff-line nm-diff-hunk">{esc}</span>')
        elif line.startswith("+"):
            parts.append(f'<span class="nm-diff-line nm-diff-add">{esc}</span>')
        elif line.startswith("-"):
            parts.append(f'<span class="nm-diff-line nm-diff-del">{esc}</span>')
        else:
            parts.append(f'<span class="nm-diff-line nm-diff-ctx">{esc}</span>')
    parts.append("</div>")
    return "".join(parts)


# ── Storage keys ──────────────────────────────────────────────────────────────

_KEY_ANTHROPIC = "agent_anthropic_key"
_KEY_OPENAI = "agent_openai_key"
_KEY_PROVIDER = "agent_provider"
_KEY_MODEL = "agent_model"
_KEY_HISTORY = "agent_history"
_MAX_HISTORY = 40  # messages kept in storage


# ── AgentPanel ────────────────────────────────────────────────────────────────


class AgentPanel:
    """
    Right-drawer AI chat panel.

    Pass page-specific callbacks so the panel can apply code proposals:
      on_apply_sql(new_sql)     – called when user accepts a SQL proposal
      on_apply_python(new_code) – called when user accepts a Python proposal
      get_context()             – returns dict with current_sql, current_python, etc.
    """

    def __init__(
        self,
        on_apply_sql: Callable[[str], None] | None = None,
        on_apply_python: Callable[[str], None] | None = None,
        get_context: Callable[[], dict] | None = None,
    ) -> None:
        self.on_apply_sql = on_apply_sql
        self.on_apply_python = on_apply_python
        self.get_context = get_context or (lambda: {})

        self._drawer: ui.right_drawer | None = None
        self._messages_container: ui.column | None = None
        self._input: ui.input | None = None
        self._send_btn: ui.button | None = None
        self._status_label: ui.label | None = None
        self._provider_select: ui.select | None = None
        self._model_select: ui.select | None = None

    # ── Public ────────────────────────────────────────────────────────────────

    def create(self) -> ui.right_drawer:
        """Build and return the right drawer. Call inside a NiceGUI page."""
        self._drawer = ui.right_drawer(value=False).props("bordered").style(
            "width: 420px; min-width: 0; overflow: hidden;"
        )
        with self._drawer:
            self._build_ui()
        return self._drawer

    def toggle(self) -> None:
        if self._drawer:
            self._drawer.toggle()

    # ── Internal UI build ─────────────────────────────────────────────────────

    def _build_ui(self) -> None:
        # ── Header bar ──────────────────────────────────────────────────────
        with ui.row().classes(
            "items-center justify-between px-4 py-3 border-b border-gray-200"
        ):
            with ui.row().classes("items-center gap-2"):
                ui.icon("smart_toy", size="sm").classes("text-blue-500")
                ui.label("AI Agent").classes("font-semibold text-gray-800")
            with ui.row().classes("gap-1"):
                ui.button(
                    icon="delete_sweep",
                    on_click=self._clear_history,
                ).props("flat round dense").classes("text-gray-400").tooltip("Clear conversation")
                ui.button(
                    icon="close",
                    on_click=lambda: self._drawer.toggle(),
                ).props("flat round dense").classes("text-gray-500")

        # ── Model selector ───────────────────────────────────────────────────
        with ui.row().classes("items-center gap-2 px-3 py-2 border-b border-gray-100"):
            storage = app.storage.user
            cur_provider = storage.get(_KEY_PROVIDER, "anthropic")
            cur_model = storage.get(_KEY_MODEL, "claude-sonnet-4-6")

            def _on_provider_change(e) -> None:
                storage[_KEY_PROVIDER] = e.value
                models = ALL_MODELS.get(e.value, ANTHROPIC_MODELS)
                if self._model_select:
                    self._model_select.options = models
                    first = next(iter(models))
                    self._model_select.value = first
                    storage[_KEY_MODEL] = first

            def _on_model_change(e) -> None:
                storage[_KEY_MODEL] = e.value

            self._provider_select = ui.select(
                options={"anthropic": "Anthropic", "openai": "OpenAI"},
                value=cur_provider,
                on_change=_on_provider_change,
            ).props("dense outlined").classes("text-xs").style("width:100px")

            models_for_provider = ALL_MODELS.get(cur_provider, ANTHROPIC_MODELS)
            if cur_model not in models_for_provider:
                cur_model = next(iter(models_for_provider))

            self._model_select = ui.select(
                options=models_for_provider,
                value=cur_model,
                on_change=_on_model_change,
            ).props("dense outlined").classes("text-xs flex-1")

        # ── Messages area ────────────────────────────────────────────────────
        with ui.scroll_area().style("height: calc(100% - 200px); overflow-x: hidden;"):
            self._messages_container = ui.column().classes(
                "w-full gap-3 px-3 py-3"
            ).style("min-width:0")
            self._render_history()

        # ── Status line ──────────────────────────────────────────────────────
        self._status_label = ui.label("").classes(
            "text-xs text-gray-400 px-4 py-1"
        ).style("min-height:18px")

        # ── Input area ───────────────────────────────────────────────────────
        with ui.row().classes(
            "items-end gap-2 px-3 py-3 border-t border-gray-200 w-full"
        ).style("min-width:0"):
            self._input = ui.textarea(
                placeholder="Ask anything about your data...",
                on_change=lambda e: None,
            ).props("dense outlined autogrow").classes("flex-1").style(
                "font-size:13px; max-height:120px; min-width:0;"
            )
            # Send on Shift+Enter or click
            self._input.on(
                "keydown",
                lambda e: self._maybe_send(e),
            )
            self._send_btn = ui.button(
                icon="send",
                on_click=self._send,
            ).props("color=primary round dense")

    # ── History persistence ───────────────────────────────────────────────────

    def _load_history(self) -> list[dict]:
        raw = app.storage.user.get(_KEY_HISTORY, "[]")
        try:
            return json.loads(raw) if isinstance(raw, str) else raw
        except Exception:
            return []

    def _save_history(self, messages: list[dict]) -> None:
        trimmed = messages[-_MAX_HISTORY:]
        app.storage.user[_KEY_HISTORY] = json.dumps(trimmed)

    def _clear_history(self) -> None:
        app.storage.user[_KEY_HISTORY] = "[]"
        if self._messages_container:
            self._messages_container.clear()
            with self._messages_container:
                ui.label("Conversation cleared.").classes(
                    "text-xs text-gray-400 text-center py-4"
                )

    # ── Message rendering ─────────────────────────────────────────────────────

    def _render_history(self) -> None:
        """Re-render all stored messages."""
        if not self._messages_container:
            return
        messages = self._load_history()
        for msg in messages:
            self._render_message_bubble(msg, save=False)
        if not messages:
            with self._messages_container:
                ui.label(
                    "Ask me anything about your data, connections, or queries."
                ).classes("text-xs text-gray-400 text-center py-8")

    def _render_message_bubble(self, msg: dict, save: bool = True) -> None:
        """Render a single message bubble inside self._messages_container."""
        if not self._messages_container:
            return
        role = msg.get("role", "user")
        content = msg.get("content", "")
        ui_actions = msg.get("ui_actions", [])

        with self._messages_container:
            if role == "user":
                with ui.row().classes("justify-end w-full"):
                    ui.markdown(f"> {content}").classes(
                        "bg-blue-500 text-white rounded-2xl rounded-tr-sm "
                        "px-4 py-2 max-w-xs text-sm ml-auto"
                    ).style("word-break:break-word;")
            elif role == "tool_status":
                # Tool call status chip
                with ui.row().classes("items-center gap-2"):
                    ui.icon("build", size="xs").classes("text-gray-400")
                    ui.label(content).classes("text-xs text-gray-400 italic")
            elif role == "assistant":
                with ui.column().classes("gap-2 w-full"):
                    if content:
                        ui.markdown(content).classes(
                            "bg-white border border-gray-200 rounded-2xl rounded-tl-sm "
                            "px-4 py-3 text-sm text-gray-800 w-full"
                        ).style("word-break:break-word;")
                    # Render UI actions (proposals, navigation)
                    for action in ui_actions:
                        self._render_ui_action(action)

    def _render_ui_action(self, action: dict) -> None:
        """Render a proposal diff card or navigation card."""
        atype = action.get("type")

        if atype in ("sql_proposal", "python_proposal"):
            lang = "SQL" if atype == "sql_proposal" else "Python"
            old_code = action.get("old_code", "")
            new_code = action.get("new_code", "")
            explanation = action.get("explanation", "")
            diff_html = _make_diff_html(old_code, new_code)

            with ui.card().classes(
                "w-full border border-blue-200 bg-blue-50 rounded-xl"
            ):
                with ui.column().classes("gap-2 p-3"):
                    with ui.row().classes("items-center gap-2"):
                        ui.icon(
                            "code" if atype == "sql_proposal" else "functions",
                            size="xs",
                        ).classes("text-blue-600")
                        ui.label(f"{lang} Proposal").classes(
                            "text-sm font-semibold text-blue-700"
                        )

                    if explanation:
                        ui.label(explanation).classes("text-xs text-gray-600")

                    # Diff view
                    ui.html(diff_html).classes("w-full rounded overflow-hidden")

                    # Accept / Reject buttons
                    with ui.row().classes("gap-2"):
                        def _accept(nc=new_code, at=atype):
                            if at == "sql_proposal" and self.on_apply_sql:
                                self.on_apply_sql(nc)
                                ui.notify("SQL applied ✓", type="positive")
                            elif at == "python_proposal" and self.on_apply_python:
                                self.on_apply_python(nc)
                                ui.notify("Python code applied ✓", type="positive")
                            else:
                                ui.notify(
                                    "No editor available on this page", type="warning"
                                )

                        ui.button(
                            "Accept",
                            icon="check",
                            on_click=_accept,
                        ).props("color=positive dense no-caps").classes("text-xs")
                        ui.button(
                            "Reject",
                            icon="close",
                            on_click=lambda: ui.notify("Change rejected", type="info"),
                        ).props("flat dense no-caps").classes("text-xs text-gray-500")

        elif atype == "navigation":
            path = action.get("path", "/")
            with ui.row().classes("items-center gap-2"):
                ui.icon("open_in_new", size="xs").classes("text-blue-500")
                ui.link(f"Navigate to {path}", target=path).classes(
                    "text-xs text-blue-600 underline cursor-pointer"
                )

    # ── Sending messages ──────────────────────────────────────────────────────

    def _maybe_send(self, e) -> None:
        """Send on Enter (without Shift)."""
        try:
            args = e.args or {}
            if args.get("key") == "Enter" and not args.get("shiftKey"):
                ui.run_javascript("event.preventDefault()")
                self._send()
        except (AttributeError, TypeError):
            pass

    def _send(self) -> None:
        if not self._input:
            return
        text = (self._input.value or "").strip()
        if not text:
            return
        self._input.value = ""

        import asyncio

        asyncio.ensure_future(self._do_send(text))

    async def _do_send(self, user_text: str) -> None:
        """Execute the send flow: add user msg, call LLM, render response."""
        service = self._make_service()
        if not service:
            if self._messages_container:
                with self._messages_container:
                    ui.label(
                        "⚠ No API key configured. Go to Admin → AI tab to add one."
                    ).classes("text-xs text-red-500 px-2 py-1")
            return

        # Disable input while thinking
        if self._send_btn:
            self._send_btn.props(add="loading")
        if self._status_label:
            self._status_label.text = "Thinking…"

        # Add user message
        user_msg = {"role": "user", "content": user_text}
        history = self._load_history()

        # Clear empty state placeholder on first message
        if self._messages_container and not history:
            self._messages_container.clear()
        self._render_message_bubble(user_msg, save=False)
        history.append(user_msg)

        # Build messages for LLM (omit ui_actions - not part of LLM convo)
        llm_messages = [
            {"role": m["role"], "content": m["content"]}
            for m in history
            if m["role"] in ("user", "assistant")
        ]

        def _on_tool_start(name: str, inputs: dict) -> None:
            label = _tool_status_label(name, inputs)
            status_msg = {"role": "tool_status", "content": label}
            self._render_message_bubble(status_msg, save=False)
            if self._status_label:
                self._status_label.text = label

        try:
            ctx = self.get_context()
            ctx["current_page"] = _current_path()
            assistant_text, ui_actions = await service.chat(
                llm_messages, ctx, on_tool_start=_on_tool_start
            )

            # Apply navigation side-effects immediately
            for action in ui_actions:
                if action.get("type") == "navigation":
                    ui.navigate.to(action["path"])

            assistant_msg = {
                "role": "assistant",
                "content": assistant_text,
                "ui_actions": ui_actions,
            }
            history.append(assistant_msg)
            self._save_history(history)
            self._render_message_bubble(assistant_msg, save=False)

        except Exception as exc:
            import logging
            logging.getLogger(__name__).exception("Agent chat error")
            err_msg = {
                "role": "assistant",
                "content": "**Error:** Something went wrong. Please check your API key and try again.",
                "ui_actions": [],
            }
            self._render_message_bubble(err_msg, save=False)
        finally:
            if self._send_btn:
                self._send_btn.props(remove="loading")
            if self._status_label:
                self._status_label.text = ""

    # ── Service factory ───────────────────────────────────────────────────────

    def _make_service(self) -> AgentService | None:
        storage = app.storage.user
        provider = storage.get(_KEY_PROVIDER, "anthropic")
        model = storage.get(_KEY_MODEL, "claude-sonnet-4-6")

        if provider == "anthropic":
            key = storage.get(_KEY_ANTHROPIC, "")
        else:
            key = storage.get(_KEY_OPENAI, "")

        if not key:
            return None

        return AgentService(provider=provider, api_key=key, model=model)


# ── Helpers ───────────────────────────────────────────────────────────────────


def _tool_status_label(name: str, inputs: dict) -> str:
    labels = {
        "list_connections": "Listing database connections…",
        "get_schema": f"Fetching schema for connection {inputs.get('connection_id', '')}…",
        "execute_sql": "Executing SQL query…",
        "propose_sql_edit": "Preparing SQL proposal…",
        "propose_python_edit": "Preparing Python proposal…",
        "list_saved_queries": "Listing saved queries…",
        "list_dashboards": "Listing dashboards…",
        "navigate_to": f"Navigating to {inputs.get('path', '')}…",
    }
    return labels.get(name, f"Calling tool: {name}…")


def _current_path() -> str:
    try:
        return ui.context.client.request.url.path
    except Exception:
        return "/"
