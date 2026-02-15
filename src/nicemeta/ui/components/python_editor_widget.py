"""
Python Code Editor widget component for visualization code.

Provides a CodeMirror-based editor with Python syntax highlighting.
"""

import asyncio
from typing import Any, Callable

from nicegui import ui


class PythonEditorWidget:
    """
    Python code editor widget using CodeMirror with syntax highlighting.
    
    Used for editing visualization code that generates charts.
    """

    def __init__(
        self,
        value: str = "",
        on_change: Callable[[str], None] | None = None,
        on_run: Callable[[str], Any] | None = None,
        read_only: bool = False,
    ):
        """
        Initialize the Python editor.
        
        Args:
            value: Initial Python code content
            on_change: Callback when content changes
            on_run: Callback when run is triggered (can be sync or async)
            read_only: Whether the editor is read-only
        """
        self.value = value
        self.on_change = on_change
        self.on_run = on_run
        self.read_only = read_only
        self._editor = None
        self._error_container = None
        self._container = None

    def create(self) -> ui.element:
        """Create the Python editor widget."""
        with ui.card().classes("w-full") as self._container:
            # Toolbar
            with ui.row().classes("items-center gap-2 mb-2"):
                ui.button(
                    "Run",
                    icon="play_arrow",
                    on_click=self._handle_run,
                ).props("color=primary dense")
                
                ui.button(
                    "Format",
                    icon="auto_fix_high",
                    on_click=self._format_code,
                ).props("flat dense")
                
                ui.button(
                    "Reset",
                    icon="refresh",
                    on_click=self._reset,
                ).props("flat dense")
                
                ui.space()
                
                with ui.row().classes("items-center gap-1"):
                    ui.icon("code", size="xs").classes("text-gray-400 dark:text-gray-500")
                    ui.label("Python").classes("text-xs text-gray-500 dark:text-gray-400 font-mono")
            
            # Editor using CodeMirror with Python mode
            self._editor = ui.codemirror(
                value=self.value,
                language="Python",
                on_change=self._handle_change,
            ).classes("w-full border rounded").style(
                "min-height: 300px; font-size: 13px;"
            )
            
            # Error display area
            self._error_container = ui.column().classes("w-full mt-2")
            self._error_container.set_visibility(False)
        
        return self._container

    def _handle_change(self, e) -> None:
        """Handle editor content change."""
        self.value = e.value
        if self.on_change:
            self.on_change(e.value)
        # Clear any displayed errors when code changes
        self._clear_error()

    async def _handle_run(self) -> None:
        """Handle run button click."""
        if self.on_run:
            result = self.on_run(self.value)
            # Handle async callbacks
            if asyncio.iscoroutine(result):
                await result

    def _format_code(self) -> None:
        """Format the Python code using black."""
        try:
            import black
            
            formatted = black.format_str(
                self.value,
                mode=black.Mode(
                    line_length=88,
                    string_normalization=True,
                ),
            )
            self._editor.value = formatted
            self.value = formatted
            ui.notify("Code formatted", type="positive")
        except ImportError:
            ui.notify("black not installed, skipping format", type="warning")
        except Exception as e:
            ui.notify(f"Format error: {str(e)}", type="negative")

    def _reset(self) -> None:
        """Reset to last generated code (trigger on_change with empty to signal reset)."""
        if self.on_change:
            self.on_change("")  # Signal reset request
        ui.notify("Code reset to generated version", type="info")

    def _clear_error(self) -> None:
        """Clear the error display."""
        if self._error_container:
            self._error_container.clear()
            self._error_container.set_visibility(False)

    def show_error(self, error: str) -> None:
        """Display an error message below the editor."""
        if self._error_container:
            self._error_container.clear()
            with self._error_container:
                with ui.card().classes("w-full bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800"):
                    with ui.row().classes("items-start gap-2 p-2"):
                        ui.icon("error", size="sm").classes("text-red-500 mt-0.5")
                        with ui.column().classes("gap-1"):
                            ui.label("Execution Error").classes("text-sm font-semibold text-red-700 dark:text-red-300")
                            ui.code(error, language="text").classes("text-xs")
            self._error_container.set_visibility(True)

    def show_success(self, message: str = "Code executed successfully") -> None:
        """Display a success message."""
        if self._error_container:
            self._error_container.clear()
            with self._error_container:
                with ui.card().classes("w-full bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800"):
                    with ui.row().classes("items-center gap-2 p-2"):
                        ui.icon("check_circle", size="sm").classes("text-green-500")
                        ui.label(message).classes("text-sm text-green-700 dark:text-green-300")
            self._error_container.set_visibility(True)

    def set_value(self, value: str) -> None:
        """Set the editor content."""
        self.value = value
        if self._editor:
            self._editor.value = value

    def get_value(self) -> str:
        """Get the editor content."""
        return self.value


def create_python_editor(
    value: str = "",
    on_change: Callable[[str], None] | None = None,
    on_run: Callable[[str], Any] | None = None,
) -> PythonEditorWidget:
    """
    Factory function to create a Python editor widget.
    
    Args:
        value: Initial code content
        on_change: Callback when content changes
        on_run: Callback when run is triggered
        
    Returns:
        PythonEditorWidget instance
    """
    widget = PythonEditorWidget(value=value, on_change=on_change, on_run=on_run)
    widget.create()
    return widget

