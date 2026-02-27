"""
Cursor-like inline diff overlay for code editors.

Shows added/removed lines with per-line accept/reject buttons.
Temporarily replaces the editor, then restores it on accept/reject.
"""

from __future__ import annotations

import difflib
import html as _html
from typing import Callable

from nicegui import ui


class InlineDiffView:
    """
    Overlay diff view that shows old vs new code with line-level controls.

    Usage:
        diff_view = InlineDiffView(old, new, on_accept_all, on_reject_all)
        diff_view.create()  # renders inside the current NiceGUI context
        # later: diff_view.destroy() to remove
    """

    def __init__(
        self,
        old_code: str,
        new_code: str,
        language: str = "sql",
        on_accept_all: Callable[[str], None] | None = None,
        on_reject_all: Callable[[], None] | None = None,
    ) -> None:
        self.old_code = old_code
        self.new_code = new_code
        self.language = language
        self.on_accept_all = on_accept_all
        self.on_reject_all = on_reject_all
        self._container: ui.element | None = None
        self._lines = self._compute_diff_lines()

    def _compute_diff_lines(self) -> list[dict]:
        """Compute line-level diff using SequenceMatcher."""
        old_lines = self.old_code.splitlines()
        new_lines = self.new_code.splitlines()
        result: list[dict] = []

        sm = difflib.SequenceMatcher(None, old_lines, new_lines)
        for tag, i1, i2, j1, j2 in sm.get_opcodes():
            if tag == "equal":
                for line in old_lines[i1:i2]:
                    result.append({"type": "context", "text": line})
            elif tag == "delete":
                for line in old_lines[i1:i2]:
                    result.append({"type": "delete", "text": line})
            elif tag == "insert":
                for line in new_lines[j1:j2]:
                    result.append({"type": "add", "text": line})
            elif tag == "replace":
                for line in old_lines[i1:i2]:
                    result.append({"type": "delete", "text": line})
                for line in new_lines[j1:j2]:
                    result.append({"type": "add", "text": line})
        return result

    def create(self) -> ui.element:
        """Render the inline diff overlay."""
        self._container = ui.column().classes("w-full gap-0")
        with self._container:
            # Action bar
            with ui.row().classes("items-center gap-2 px-3 py-2 border-b w-full"):
                ui.icon("compare_arrows", size="sm").classes("text-primary")
                ui.label(f"{self.language.upper()} Changes").classes("text-sm font-semibold flex-1")
                ui.button(
                    "Accept All", icon="check_circle",
                    on_click=lambda: self._do_accept_all(),
                ).props("color=positive dense no-caps").classes("text-xs")
                ui.button(
                    "Reject All", icon="cancel",
                    on_click=lambda: self._do_reject_all(),
                ).props("flat dense no-caps").classes("text-xs text-grey-6")

            # Diff lines
            with ui.element("div").classes("nm-inline-diff w-full").style(
                "max-height: 400px; overflow: auto;"
            ):
                for line_info in self._lines:
                    self._render_line(line_info)

        return self._container

    def _render_line(self, line_info: dict) -> None:
        line_type = line_info["type"]
        text = line_info["text"]
        esc = _html.escape(text) or "&nbsp;"

        if line_type == "context":
            ui.html(
                f'<div class="nm-idiff-ctx">&nbsp; {esc}</div>',
                sanitize=False,
            )
        elif line_type == "add":
            ui.html(
                f'<div class="nm-idiff-add">+ {esc}</div>',
                sanitize=False,
            )
        elif line_type == "delete":
            ui.html(
                f'<div class="nm-idiff-del">- {esc}</div>',
                sanitize=False,
            )

    def _do_accept_all(self) -> None:
        if self.on_accept_all:
            self.on_accept_all(self.new_code)
        self.destroy()

    def _do_reject_all(self) -> None:
        if self.on_reject_all:
            self.on_reject_all()
        self.destroy()

    def destroy(self) -> None:
        """Remove the diff overlay from the UI."""
        if self._container:
            self._container.delete()
            self._container = None
