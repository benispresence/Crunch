"""
SQL Editor widget component.
"""

import asyncio
from datetime import date, datetime
from decimal import Decimal
from typing import Any, Callable

import pandas as pd
from nicegui import ui


def serialize_value(value: Any) -> Any:
    """
    Convert a value to a JSON-serializable type.
    
    Handles pandas Timestamp, datetime, date, Decimal, etc.
    """
    if value is None:
        return None
    if pd.isna(value):
        return None
    if isinstance(value, pd.Timestamp):
        return value.isoformat()
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Decimal):
        return float(value)
    if isinstance(value, bytes):
        return value.decode("utf-8", errors="replace")
    # Return as-is for basic types (str, int, float, bool)
    return value


def serialize_row(row: tuple | list, columns: list[str]) -> dict[str, Any]:
    """Convert a row tuple to a serializable dictionary."""
    return {col: serialize_value(row[i]) for i, col in enumerate(columns)}


class SQLEditorWidget:
    """
    SQL code editor widget using CodeMirror.
    """

    def __init__(
        self,
        value: str = "",
        on_change: Callable | None = None,
        on_run: Callable | None = None,
    ):
        """
        Initialize the SQL editor.
        
        Args:
            value: Initial SQL content
            on_change: Callback when content changes
            on_run: Callback when run is triggered (can be sync or async)
        """
        self.value = value
        self.on_change = on_change
        self.on_run = on_run
        self._editor = None

    def create(self) -> ui.element:
        """Create the SQL editor widget."""
        with ui.column().classes("w-full p-3 bg-white border border-gray-200") as container:
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
                    on_click=self._format_sql,
                ).props("flat dense").classes("text-gray-600")
                
                ui.button(
                    "Clear",
                    icon="clear",
                    on_click=self._clear,
                ).props("flat dense").classes("text-gray-600")
                
                ui.space()
                
                ui.label("Ctrl/Cmd + Enter to run").classes("text-xs text-gray-400")
            
            # SQL Editor with CodeMirror and syntax highlighting
            self._editor = ui.codemirror(
                value=self.value,
                language="sql",
                on_change=self._handle_change,
            ).classes("w-full border border-gray-200 rounded").style(
                "min-height: 150px;"
            )
        
        return container

    def _handle_change(self, e) -> None:
        """Handle editor content change."""
        self.value = e.value
        if self.on_change:
            self.on_change(e.value)

    async def _handle_run(self) -> None:
        """Handle run button click."""
        if self.on_run:
            result = self.on_run(self.value)
            # Handle async callbacks
            if asyncio.iscoroutine(result):
                await result

    def _format_sql(self) -> None:
        """Format the SQL query."""
        # Basic formatting - in production use sqlparse or similar
        try:
            import sqlparse
            formatted = sqlparse.format(
                self.value,
                reindent=True,
                keyword_case="upper",
            )
            if self._editor:
                self._editor.set_value(formatted)
            self.value = formatted
        except ImportError:
            # sqlparse not available, do basic formatting
            keywords = [
                "SELECT", "FROM", "WHERE", "AND", "OR", "JOIN",
                "LEFT", "RIGHT", "INNER", "OUTER", "ON", "GROUP BY",
                "ORDER BY", "HAVING", "LIMIT", "OFFSET", "INSERT",
                "UPDATE", "DELETE", "CREATE", "ALTER", "DROP",
            ]
            formatted = self.value
            for kw in keywords:
                formatted = formatted.replace(kw.lower(), kw)
            if self._editor:
                self._editor.set_value(formatted)
            self.value = formatted

    def _clear(self) -> None:
        """Clear the editor."""
        if self._editor:
            self._editor.set_value("")
        self.value = ""

    def set_value(self, value: str) -> None:
        """Set the editor content."""
        self.value = value
        if self._editor:
            self._editor.set_value(value)

    def get_value(self) -> str:
        """Get the editor content."""
        return self.value


def create_results_table(
    columns: list[str],
    rows: list[tuple],
    row_count: int,
    execution_time: float,
) -> ui.element:
    """
    Create a results table for query output.
    
    Args:
        columns: Column names
        rows: Data rows
        row_count: Total row count
        execution_time: Query execution time in ms
        
    Returns:
        UI element containing the results table
    """
    with ui.card().classes("w-full") as container:
        # Results header
        with ui.row().classes("items-center gap-4 mb-2"):
            ui.label(f"{row_count} rows").classes("text-sm font-medium")
            ui.label(f"{execution_time:.1f}ms").classes("text-sm text-gray-500")
            
            ui.space()
            
            ui.button(
                "Export CSV",
                icon="download",
                on_click=lambda: export_csv(columns, rows),
            ).props("flat dense")
        
        # Table
        if columns and rows:
            table_columns = [
                {"name": col, "label": col, "field": col, "sortable": True}
                for col in columns
            ]
            # Serialize rows to handle Timestamp, datetime, etc.
            table_rows = [serialize_row(row, columns) for row in rows]
            
            ui.table(
                columns=table_columns,
                rows=table_rows,
                row_key=columns[0] if columns else "id",
                pagination={"rowsPerPage": 50},
            ).classes("w-full")
        else:
            ui.label("No results").classes("text-gray-500 p-4")
    
    return container


def export_csv(columns: list[str], rows: list[tuple]) -> None:
    """Export results to CSV and trigger download."""
    import io
    import csv
    
    output = io.StringIO()
    writer = csv.writer(output)
    writer.writerow(columns)
    writer.writerows(rows)
    
    # In production, trigger file download
    ui.notify("Export functionality coming soon", type="info")

