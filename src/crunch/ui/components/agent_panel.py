"""
AI Agent panel for NiceMeta — Cursor-like right-drawer chat.

Features:
- Multiple saved conversations with DB persistence
- Combined model picker (all providers in one dropdown)
- Markdown chat with tool-call chips and diff proposals
- Accept/Reject per proposal, Accept All / Reject All
- Drag-to-resize drawer (300-700 px, persisted to localStorage)
"""

from __future__ import annotations

import asyncio
import difflib
import html as _html
import json
import logging
from typing import Callable

from nicegui import app, ui

from crunch.services.agent_service import (
    AgentService,
    ALL_MODELS,
    ANTHROPIC_MODELS,
    OPENAI_MODELS,
)
from crunch.services import agent_conversation_service as conv_svc

logger = logging.getLogger(__name__)

# ── Diff helpers ──────────────────────────────────────────────────────────────


def _make_diff_html(old: str, new: str) -> str:
    """Return an HTML snippet showing a unified diff (dark theme)."""
    old_lines = old.splitlines()
    new_lines = new.splitlines()
    diff = list(difflib.unified_diff(old_lines, new_lines, lineterm="", n=3))

    if not diff:
        return '<div class="nm-diff"><div class="nm-diff-ctx" style="padding:8px">No changes</div></div>'

    parts = ['<div class="nm-diff">']
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

# ── Combined model list ──────────────────────────────────────────────────────

_COMBINED_MODELS: dict[str, str] = {}
for _prov, _models in ALL_MODELS.items():
    for _mid, _mname in _models.items():
        _COMBINED_MODELS[f"{_prov}:{_mid}"] = _mname

# ── Resize JS ────────────────────────────────────────────────────────────────

_AGENT_RESIZE_JS = """
(function() {
  var KEY = 'nm_agent_w';
  var MIN = 300;
  var MAX = 700;

  function isDrawerOpen(drawer) {
    /* Quasar hides the drawer via an aria-hidden attribute or by
       translating it off-screen.  Check a few reliable signals. */
    if (drawer.getAttribute('aria-hidden') === 'true') return false;
    var s = getComputedStyle(drawer);
    if (s.display === 'none') return false;
    /* Quasar translates closed right-drawers off-screen to the right */
    var m = s.transform.match(/matrix.*,\\s*([\\d.-]+)\\)$/);
    if (m && parseFloat(m[1]) > 50) return false;
    return true;
  }

  function applyWidth(w) {
    var styleEl = document.getElementById('nm-aw-override');
    if (!styleEl) {
      styleEl = document.createElement('style');
      styleEl.id = 'nm-aw-override';
      document.head.appendChild(styleEl);
    }
    styleEl.textContent =
      '.q-drawer--right{width:' + w + 'px!important;min-width:0!important}';
    var pc = document.querySelector('.q-page-container');
    if (pc) pc.style.setProperty('padding-right', w + 'px', 'important');
  }

  function clearWidth() {
    var pc = document.querySelector('.q-page-container');
    if (pc) pc.style.removeProperty('padding-right');
    var styleEl = document.getElementById('nm-aw-override');
    if (styleEl) styleEl.textContent = '';
  }

  function syncDrawer(drawer) {
    if (isDrawerOpen(drawer)) {
      var saved = parseInt(localStorage.getItem(KEY) || '0', 10);
      if (saved >= MIN && saved <= MAX) applyWidth(saved);
    } else {
      clearWidth();
    }
  }

  function init() {
    var drawer = document.querySelector('.q-drawer--right');
    if (!drawer || document.getElementById('nm-arh')) return;

    /* Watch for open/close (style changes include Quasar transforms) */
    var obs = new MutationObserver(function() {
      setTimeout(function(){ syncDrawer(drawer); }, 50);
    });
    obs.observe(drawer, { attributes: true, attributeFilter: ['style', 'aria-hidden', 'class'] });

    var rh = document.createElement('div');
    rh.id = 'nm-arh';
    rh.style.cssText = [
      'position:absolute', 'left:0', 'top:0',
      'width:5px', 'height:100%', 'cursor:col-resize',
      'z-index:9999', 'user-select:none', 'border-radius:2px 0 0 2px'
    ].join(';');
    drawer.appendChild(rh);

    rh.addEventListener('mouseenter', function() {
      rh.style.background = 'rgba(86,156,214,0.45)';
    });
    rh.addEventListener('mouseleave', function() {
      if (!rh._d) rh.style.background = '';
    });

    rh.addEventListener('mousedown', function(e) {
      e.preventDefault();
      rh._d = true;
      rh.style.background = 'rgba(86,156,214,0.7)';
      document.body.classList.add('nm-resizing');
      var x0 = e.clientX;
      var w0 = drawer.offsetWidth;

      function mv(e) {
        applyWidth(Math.max(MIN, Math.min(MAX, w0 - (e.clientX - x0))));
      }
      function up() {
        rh._d = false;
        rh.style.background = '';
        document.body.classList.remove('nm-resizing');
        localStorage.setItem(KEY, drawer.offsetWidth);
        window.removeEventListener('mousemove', mv);
        window.removeEventListener('mouseup', up);
      }
      window.addEventListener('mousemove', mv);
      window.addEventListener('mouseup', up);
    });

    syncDrawer(drawer);
  }

  var n = 0;
  var iv = setInterval(function() {
    n++;
    if (n > 50) { clearInterval(iv); return; }
    if (document.querySelector('.q-drawer--right')) { clearInterval(iv); setTimeout(init, 80); }
  }, 100);
})();
"""


# ── AgentPanel ────────────────────────────────────────────────────────────────


class AgentPanel:
    """
    Right-drawer AI chat panel with Cursor-like UX.

    Features:
    - Multiple saved conversations (DB-persisted)
    - Combined model picker
    - Tool-call status chips
    - Diff proposals with Accept / Reject (+ Accept All / Reject All)
    - Auto-apply side-effects (SQL run, save, navigate)
    """

    def __init__(
        self,
        on_apply_sql: Callable[[str], None] | None = None,
        on_apply_python: Callable[[str], None] | None = None,
        on_apply_and_run_sql: Callable[[str], None] | None = None,
        on_apply_and_run_python: Callable[[str], None] | None = None,
        get_context: Callable[[], dict] | None = None,
        sidebar=None,  # MetabaseSidebar | None — avoid circular import
    ) -> None:
        self.on_apply_sql = on_apply_sql
        self.on_apply_python = on_apply_python
        self.on_apply_and_run_sql = on_apply_and_run_sql
        self.on_apply_and_run_python = on_apply_and_run_python
        self.get_context = get_context or (lambda: {})
        self.sidebar = sidebar

        # UI elements
        self._drawer: ui.right_drawer | None = None
        self._messages_container: ui.column | None = None
        self._input: ui.textarea | None = None
        self._send_btn: ui.button | None = None
        self._status_label: ui.label | None = None
        self._model_select: ui.select | None = None

        # Chat history views
        self._history_panel: ui.column | None = None
        self._chat_panel: ui.column | None = None
        self._conversations_container: ui.column | None = None
        self._history_visible = False

        # Current conversation
        self._current_conversation_id: str | None = None
        self._messages: list[dict] = []

    # ── Public ────────────────────────────────────────────────────────────────

    def create(self) -> ui.right_drawer:
        """Build and return the right drawer."""
        self._drawer = ui.right_drawer(value=False).props("bordered").style(
            "width: 420px; min-width: 0; overflow: hidden;"
        )
        with self._drawer:
            self._build_ui()
        ui.timer(0.2, lambda: ui.run_javascript(_AGENT_RESIZE_JS), once=True)
        return self._drawer

    def toggle(self) -> None:
        if self._drawer:
            self._drawer.toggle()

    # ── Internal UI build ─────────────────────────────────────────────────────

    def _build_ui(self) -> None:
        # ── Header bar ──────────────────────────────────────────────────────
        with ui.row().classes(
            "items-center justify-between px-4 py-3 border-b border w-full"
        ):
            with ui.row().classes("items-center gap-2"):
                ui.button(
                    icon="menu",
                    on_click=self._toggle_history,
                ).props("flat round dense").classes("text-grey-6").tooltip("Chat history")
                ui.icon("smart_toy", size="sm").classes("text-primary")
                ui.label("AI Agent").classes("font-semibold text-weight-medium")
            with ui.row().classes("gap-1"):
                ui.button(
                    icon="add",
                    on_click=self._new_conversation,
                ).props("flat round dense").classes("text-grey-5").tooltip("New chat")
                ui.button(
                    icon="close",
                    on_click=lambda: self._drawer.toggle(),
                ).props("flat round dense").classes("text-grey-6")

        # ── Model selector (combined) ─────────────────────────────────────
        with ui.row().classes("items-center gap-2 px-3 py-2 border-b border w-full"):
            storage = app.storage.user
            cur_provider = storage.get(_KEY_PROVIDER, "anthropic")
            cur_model = storage.get(_KEY_MODEL, "claude-sonnet-4-6")
            combined_value = f"{cur_provider}:{cur_model}"
            if combined_value not in _COMBINED_MODELS:
                combined_value = next(iter(_COMBINED_MODELS))

            def _on_model_change(e):
                if ":" in (e.value or ""):
                    prov, mod = e.value.split(":", 1)
                    storage[_KEY_PROVIDER] = prov
                    storage[_KEY_MODEL] = mod

            self._model_select = ui.select(
                options=_COMBINED_MODELS,
                value=combined_value,
                on_change=_on_model_change,
            ).props("dense borderless").classes("text-xs flex-1")

        # Wrapper for history and chat (only one visible at a time)
        with ui.column().classes("w-full flex-grow gap-0").style("min-height: 0; overflow: hidden;"):

            # ── History panel (toggled — replaces chat, not overlay) ──────
            self._history_panel = ui.column().classes("w-full flex-grow gap-0").style(
                "min-height: 0;"
            )
            self._history_panel.set_visibility(False)
            with self._history_panel:
                with ui.row().classes(
                    "items-center justify-between px-3 py-2 border-b border w-full flex-shrink-0"
                ):
                    ui.label("Chat History").classes("text-sm font-semibold")
                    ui.button(
                        icon="close", on_click=self._toggle_history
                    ).props("flat round dense size=sm")
                with ui.scroll_area().classes("w-full flex-grow"):
                    self._conversations_container = ui.column().classes("w-full gap-1 p-2")

            # ── Chat panel ────────────────────────────────────────────────
            self._chat_panel = ui.column().classes("w-full flex-grow gap-0").style("min-height: 0;")
            with self._chat_panel:
                # Messages area
                with ui.scroll_area().style(
                    "flex: 1 1 0; min-height: 0; overflow-x: hidden;"
                ).classes("w-full") as self._scroll_area:
                    self._messages_container = ui.column().classes(
                        "w-full gap-3 px-3 py-3"
                    ).style("min-width:0")
                    self._render_empty_state()

                # Status line
                self._status_label = ui.label("").classes(
                    "text-xs text-grey-5 px-4 py-1 flex-shrink-0"
                ).style("min-height:18px")

                # Input area
                with ui.row().classes(
                    "items-end gap-2 px-3 py-3 border-t border w-full flex-shrink-0"
                ).style("min-width:0"):
                    self._input = ui.textarea(
                        placeholder="Ask anything about your data...",
                        on_change=lambda e: None,
                    ).props("dense outlined autogrow").classes("flex-1").style(
                        "font-size:13px; max-height:120px; min-width:0;"
                    )
                    self._input.on("keydown", lambda e: self._maybe_send(e))
                    self._send_btn = ui.button(
                        icon="send",
                        on_click=self._send,
                    ).props("color=primary round dense")

    # ── History panel ─────────────────────────────────────────────────────────

    def _toggle_history(self) -> None:
        self._history_visible = not self._history_visible
        if self._history_panel:
            self._history_panel.set_visibility(self._history_visible)
        if self._chat_panel:
            self._chat_panel.set_visibility(not self._history_visible)
        if self._history_visible:
            asyncio.ensure_future(self._load_conversations_list())

    async def _load_conversations_list(self) -> None:
        if not self._conversations_container:
            return
        self._conversations_container.clear()
        try:
            conversations = await conv_svc.list_conversations()
        except Exception:
            logger.exception("Error loading conversations")
            conversations = []

        with self._conversations_container:
            if not conversations:
                ui.label("No conversations yet").classes("text-grey-6 text-sm py-4 text-center w-full")
                return

            for conv in conversations:
                is_active = conv["id"] == self._current_conversation_id
                bg = " bg-primary/10" if is_active else ""
                with ui.row().classes(
                    f"items-center gap-2 px-3 py-2 rounded-lg cursor-pointer w-full hover:bg-grey-2{bg}"
                ).style("transition: background 0.12s;").on(
                    "click", lambda c=conv: asyncio.ensure_future(self._open_conversation(c["id"]))
                ):
                    ui.icon("chat_bubble_outline", size="xs").classes("text-grey-6 flex-shrink-0")
                    with ui.column().classes("flex-1 gap-0 min-w-0"):
                        ui.label(conv["title"][:50]).classes("text-sm truncate")
                        if conv.get("updated_at"):
                            ui.label(_relative_time(conv["updated_at"])).classes("text-xs text-grey-5")
                    ui.button(
                        icon="delete_outline",
                        on_click=lambda c=conv: asyncio.ensure_future(self._delete_conversation(c["id"])),
                    ).props("flat round dense size=xs").classes("text-grey-5")

    async def _open_conversation(self, conversation_id: str) -> None:
        conv = await conv_svc.get_conversation(conversation_id)
        if not conv:
            ui.notify("Conversation not found", type="warning")
            return
        self._current_conversation_id = conversation_id
        self._messages = conv.get("messages", [])
        self._toggle_history()  # close history panel
        self._render_messages()

    async def _delete_conversation(self, conversation_id: str) -> None:
        await conv_svc.delete_conversation(conversation_id)
        if self._current_conversation_id == conversation_id:
            self._current_conversation_id = None
            self._messages = []
            self._render_messages()
        await self._load_conversations_list()

    def _new_conversation(self) -> None:
        self._current_conversation_id = None
        self._messages = []
        self._render_messages()
        if self._history_visible:
            self._toggle_history()

    # ── Message rendering ─────────────────────────────────────────────────────

    def _render_empty_state(self) -> None:
        if not self._messages_container:
            return
        with self._messages_container:
            with ui.column().classes("items-center justify-center py-8 gap-2 w-full"):
                ui.icon("smart_toy", size="xl").classes("text-grey-4")
                ui.label(
                    "Ask me anything about your data, connections, or queries."
                ).classes("text-xs text-grey-5 text-center")

    def _render_messages(self) -> None:
        """Re-render all messages for the current conversation."""
        if not self._messages_container:
            return
        self._messages_container.clear()
        if not self._messages:
            self._render_empty_state()
            return
        for msg in self._messages:
            self._render_message_bubble(msg)

    def _render_message_bubble(self, msg: dict) -> None:
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
                        "bg-primary text-white "
                        "px-4 py-2 max-w-xs text-sm ml-auto"
                    ).style("word-break:break-word; border-radius: 16px 4px 16px 16px;")

            elif role == "tool_status":
                with ui.element("div").classes(
                    "flex items-center gap-2 px-3 py-1.5 rounded-lg"
                ).style("background: rgba(0,0,0,0.04);"):
                    ui.icon("settings", size="xs").classes("text-grey-5")
                    ui.label(content).classes("text-xs text-grey-6 font-mono")

            elif role == "assistant":
                with ui.column().classes("gap-2 w-full"):
                    if content:
                        ui.markdown(content).classes(
                            "border "
                            "px-4 py-3 text-sm text-weight-medium w-full"
                        ).style("word-break:break-word; border-radius: 4px 16px 16px 16px;")
                    # Render UI actions (proposals, navigation)
                    for action in ui_actions:
                        self._render_ui_action(action)
                    # Accept All / Reject All if there are proposals
                    if any(a.get("type") in ("sql_proposal", "python_proposal") for a in ui_actions):
                        with ui.row().classes("gap-2 mt-1"):
                            def _accept_all(actions=ui_actions):
                                for a in actions:
                                    if a.get("type") == "sql_proposal" and self.on_apply_sql:
                                        self.on_apply_sql(a["new_code"])
                                    elif a.get("type") == "python_proposal" and self.on_apply_python:
                                        self.on_apply_python(a["new_code"])
                                ui.notify("All changes accepted", type="positive")

                            def _reject_all():
                                ui.notify("All changes rejected", type="info")

                            ui.button(
                                "Accept All", icon="check_circle", on_click=_accept_all,
                            ).props("color=positive dense outlined no-caps").classes("text-xs")
                            ui.button(
                                "Reject All", icon="cancel", on_click=_reject_all,
                            ).props("flat dense no-caps").classes("text-xs text-grey-6")

    def _render_ui_action(self, action: dict) -> None:
        """Render a proposal diff card or navigation card."""
        atype = action.get("type")

        if atype in ("sql_proposal", "python_proposal"):
            lang = "SQL" if atype == "sql_proposal" else "Python"
            old_code = action.get("old_code", "")
            new_code = action.get("new_code", "")
            explanation = action.get("explanation", "")
            diff_html = _make_diff_html(old_code, new_code)

            with ui.card().classes("w-full border"):
                with ui.column().classes("gap-2 p-3"):
                    with ui.row().classes("items-center gap-2"):
                        ui.icon(
                            "code" if atype == "sql_proposal" else "functions",
                            size="xs",
                        ).classes("text-primary")
                        ui.label(f"{lang} Proposal").classes(
                            "text-sm font-semibold text-primary"
                        )

                    if explanation:
                        ui.label(explanation).classes("text-xs text-grey-7")

                    # Diff view
                    ui.html(diff_html, sanitize=False).classes("w-full rounded overflow-hidden")

                    # Accept / Reject buttons
                    with ui.row().classes("gap-2"):
                        def _accept(nc=new_code, at=atype):
                            if at == "sql_proposal" and self.on_apply_sql:
                                self.on_apply_sql(nc)
                                ui.notify("SQL applied", type="positive")
                            elif at == "python_proposal" and self.on_apply_python:
                                self.on_apply_python(nc)
                                ui.notify("Python code applied", type="positive")
                            else:
                                ui.notify(
                                    "No editor available on this page", type="warning"
                                )

                        ui.button(
                            "Accept", icon="check", on_click=_accept,
                        ).props("color=positive dense no-caps").classes("text-xs")
                        ui.button(
                            "Reject", icon="close",
                            on_click=lambda: ui.notify("Change rejected", type="info"),
                        ).props("flat dense no-caps").classes("text-xs text-grey-6")

        elif atype == "navigation":
            path = action.get("path", "/")
            with ui.row().classes("items-center gap-2"):
                ui.icon("open_in_new", size="xs").classes("text-primary")
                ui.link(f"Navigate to {path}", target=path).classes(
                    "text-xs text-primary underline cursor-pointer"
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
        asyncio.ensure_future(self._do_send(text))

    async def _do_send(self, user_text: str) -> None:
        """Execute the send flow: add user msg, call LLM, render response."""
        service = self._make_service()
        if not service:
            if self._messages_container:
                with self._messages_container:
                    ui.label(
                        "No API key configured. Go to Admin > AI tab to add one."
                    ).classes("text-xs text-negative px-2 py-1")
            return

        # Disable input while thinking
        if self._send_btn:
            self._send_btn.props(add="loading")
        if self._status_label:
            self._status_label.text = "Thinking..."

        # Create conversation if needed
        if not self._current_conversation_id:
            try:
                conv = await conv_svc.create_conversation(
                    title=user_text[:60],
                    provider=app.storage.user.get(_KEY_PROVIDER, "anthropic"),
                    model=app.storage.user.get(_KEY_MODEL, ""),
                )
                self._current_conversation_id = conv["id"]
            except Exception:
                logger.exception("Error creating conversation")

        # Add user message
        user_msg = {"role": "user", "content": user_text}

        # Clear empty state on first message
        if self._messages_container and not self._messages:
            self._messages_container.clear()
        self._render_message_bubble(user_msg)
        self._messages.append(user_msg)

        # Build messages for LLM (omit ui_actions, tool_status)
        llm_messages = [
            {"role": m["role"], "content": m["content"]}
            for m in self._messages
            if m["role"] in ("user", "assistant")
        ]

        def _on_tool_start(name: str, inputs: dict) -> None:
            label = _tool_status_label(name, inputs)
            status_msg = {"role": "tool_status", "content": label}
            self._render_message_bubble(status_msg)
            if self._status_label:
                self._status_label.text = label

        try:
            ctx = self.get_context()
            ctx["current_page"] = _current_path()
            assistant_text, ui_actions = await service.chat(
                llm_messages, ctx, on_tool_start=_on_tool_start
            )

            # Apply side-effects immediately (auto-run, save, navigate)
            for action in ui_actions:
                if action.get("type") == "sql_proposal" and self.on_apply_and_run_sql:
                    self.on_apply_and_run_sql(action["new_code"])
                elif action.get("type") == "python_proposal" and self.on_apply_and_run_python:
                    self.on_apply_and_run_python(action["new_code"])
                elif action.get("type") == "query_saved":
                    if self.sidebar:
                        await self.sidebar.refresh()
                    ui.notify(
                        f"Query '{action.get('name', '')}' saved!",
                        type="positive", icon="save",
                    )
                elif action.get("type") == "navigation":
                    ui.navigate.to(action["path"])

            assistant_msg = {
                "role": "assistant",
                "content": assistant_text,
                "ui_actions": ui_actions,
            }
            self._messages.append(assistant_msg)
            self._render_message_bubble(assistant_msg)

            # Persist to DB
            if self._current_conversation_id:
                try:
                    # Only persist user + assistant messages (not tool_status)
                    persistable = [
                        m for m in self._messages if m["role"] in ("user", "assistant")
                    ]
                    await conv_svc.update_messages(
                        self._current_conversation_id, persistable
                    )
                except Exception:
                    logger.exception("Error saving conversation")

        except Exception as exc:
            logger.exception("Agent chat error")
            err_msg = {
                "role": "assistant",
                "content": "**Error:** Something went wrong. Please check your API key and try again.",
                "ui_actions": [],
            }
            self._render_message_bubble(err_msg)
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
        "list_connections": "Listing database connections...",
        "get_schema": f"Fetching schema for connection {inputs.get('connection_id', '')}...",
        "execute_sql": "Executing SQL query...",
        "propose_sql_edit": "Preparing SQL proposal...",
        "propose_python_edit": "Preparing Python proposal...",
        "list_saved_queries": "Listing saved queries...",
        "list_dashboards": "Listing dashboards...",
        "navigate_to": f"Navigating to {inputs.get('path', '')}...",
        "save_query": f"Saving query '{inputs.get('name', '')}'...",
        "create_dashboard": f"Creating dashboard '{inputs.get('name', '')}'...",
        "add_widget_to_dashboard": "Adding widget to dashboard...",
    }
    return labels.get(name, f"Calling tool: {name}...")


def _current_path() -> str:
    try:
        return ui.context.client.request.url.path
    except Exception:
        return "/"


def _relative_time(dt_str: str) -> str:
    """Convert a datetime string to relative time like '2 min ago'."""
    try:
        from datetime import datetime, timezone
        dt = datetime.fromisoformat(dt_str.replace("Z", "+00:00"))
        now = datetime.now(timezone.utc)
        if dt.tzinfo is None:
            from datetime import timezone as tz
            dt = dt.replace(tzinfo=tz.utc)
        diff = now - dt
        seconds = int(diff.total_seconds())
        if seconds < 60:
            return "just now"
        elif seconds < 3600:
            m = seconds // 60
            return f"{m} min ago"
        elif seconds < 86400:
            h = seconds // 3600
            return f"{h}h ago"
        else:
            d = seconds // 86400
            return f"{d}d ago"
    except Exception:
        return ""
