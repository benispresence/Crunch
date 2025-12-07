"""
Visual query builder widget component.
"""

from typing import Any, Callable

from nicegui import ui

from nicemeta.query.builder import (
    AggregationType,
    Column,
    Filter,
    FilterOperator,
    JoinType,
    QueryBuilder,
    Sort,
    SortDirection,
    VisualQuery,
)


class QueryBuilderWidget:
    """
    Visual query builder widget.
    
    Allows users to build queries by selecting tables, columns,
    filters, and other options through a visual interface.
    """

    def __init__(
        self,
        tables: list[dict] | None = None,
        on_query_change: Callable | None = None,
    ):
        """
        Initialize the query builder.
        
        Args:
            tables: List of available tables with their columns
            on_query_change: Callback when query changes
        """
        self.tables = tables or []
        self.on_query_change = on_query_change
        
        # Query state
        self.selected_table: str | None = None
        self.selected_schema: str | None = None
        self.selected_columns: list[Column] = []
        self.filters: list[Filter] = []
        self.sorts: list[Sort] = []
        self.limit: int | None = 1000
        self.distinct: bool = False
        
        # Builder
        self._builder = QueryBuilder()

    def create(self) -> ui.element:
        """Create the query builder widget."""
        with ui.card().classes("w-full") as container:
            # Table selection
            with ui.expansion("1. Select Table", icon="table_chart", value=True).classes("w-full"):
                self._create_table_selector()
            
            # Column selection
            with ui.expansion("2. Select Columns", icon="view_column").classes("w-full"):
                self._create_column_selector()
            
            # Filters
            with ui.expansion("3. Add Filters", icon="filter_list").classes("w-full"):
                self._create_filter_panel()
            
            # Sorting
            with ui.expansion("4. Sort Results", icon="sort").classes("w-full"):
                self._create_sort_panel()
            
            # Options
            with ui.expansion("5. Options", icon="settings").classes("w-full"):
                self._create_options_panel()
            
            # Generated SQL preview
            with ui.expansion("Generated SQL", icon="code").classes("w-full"):
                self._sql_preview = ui.code(
                    "",
                    language="sql",
                ).classes("w-full")
        
        return container

    def _create_table_selector(self) -> None:
        """Create table selection UI."""
        if not self.tables:
            ui.label("No tables available").classes("text-gray-500")
            return
        
        # Group tables by schema
        schemas = set()
        for t in self.tables:
            schemas.add(t.get("schema", "default"))
        
        with ui.row().classes("gap-4 w-full"):
            # Schema selector
            self._schema_select = ui.select(
                label="Schema",
                options=sorted(schemas),
                value=self.selected_schema,
                on_change=self._on_schema_change,
            ).classes("w-48")
            
            # Table selector
            table_names = [
                t["name"] for t in self.tables
                if t.get("schema") == self.selected_schema or not self.selected_schema
            ]
            self._table_select = ui.select(
                label="Table",
                options=table_names,
                value=self.selected_table,
                on_change=self._on_table_change,
            ).classes("flex-grow")

    def _create_column_selector(self) -> None:
        """Create column selection UI."""
        self._columns_container = ui.column().classes("w-full gap-2")
        
        with self._columns_container:
            if not self.selected_table:
                ui.label("Select a table first").classes("text-gray-500")
                return
            
            # Get columns for selected table
            columns = self._get_table_columns()
            
            # Select all checkbox
            ui.checkbox(
                "Select All",
                on_change=lambda e: self._toggle_all_columns(e.value),
            )
            
            # Column list with aggregation options
            for col in columns:
                with ui.row().classes("items-center gap-2 w-full"):
                    ui.checkbox(
                        col["name"],
                        value=col["name"] in [c.name for c in self.selected_columns],
                        on_change=lambda e, c=col: self._toggle_column(c, e.value),
                    )
                    
                    # Aggregation selector
                    ui.select(
                        options=[a.value for a in AggregationType],
                        value="none",
                        on_change=lambda e, c=col: self._set_column_aggregation(c, e.value),
                    ).props("dense").classes("w-32")

    def _create_filter_panel(self) -> None:
        """Create filter configuration UI."""
        self._filters_container = ui.column().classes("w-full gap-2")
        
        with self._filters_container:
            if not self.selected_table:
                ui.label("Select a table first").classes("text-gray-500")
                return
            
            # Add filter button
            ui.button(
                "Add Filter",
                icon="add",
                on_click=self._add_filter,
            ).props("flat")
            
            # Filter list
            self._render_filters()

    def _create_sort_panel(self) -> None:
        """Create sort configuration UI."""
        self._sorts_container = ui.column().classes("w-full gap-2")
        
        with self._sorts_container:
            if not self.selected_table:
                ui.label("Select a table first").classes("text-gray-500")
                return
            
            # Add sort button
            ui.button(
                "Add Sort",
                icon="add",
                on_click=self._add_sort,
            ).props("flat")
            
            # Sort list
            self._render_sorts()

    def _create_options_panel(self) -> None:
        """Create query options UI."""
        with ui.column().classes("gap-4"):
            # Limit
            ui.number(
                label="Limit rows",
                value=self.limit,
                min=0,
                max=100000,
                on_change=lambda e: self._set_limit(e.value),
            ).classes("w-48")
            
            # Distinct
            ui.checkbox(
                "Distinct results",
                value=self.distinct,
                on_change=lambda e: self._set_distinct(e.value),
            )

    def _get_table_columns(self) -> list[dict]:
        """Get columns for the selected table."""
        if not self.selected_table:
            return []
        
        for table in self.tables:
            if table["name"] == self.selected_table:
                return table.get("columns", [])
        
        return []

    def _on_schema_change(self, e) -> None:
        """Handle schema selection change."""
        self.selected_schema = e.value
        self._update_query()

    def _on_table_change(self, e) -> None:
        """Handle table selection change."""
        self.selected_table = e.value
        self.selected_columns = []
        self.filters = []
        self.sorts = []
        self._update_query()

    def _toggle_column(self, column: dict, selected: bool) -> None:
        """Toggle column selection."""
        col = Column(name=column["name"])
        
        if selected:
            if col.name not in [c.name for c in self.selected_columns]:
                self.selected_columns.append(col)
        else:
            self.selected_columns = [c for c in self.selected_columns if c.name != col.name]
        
        self._update_query()

    def _toggle_all_columns(self, selected: bool) -> None:
        """Toggle all columns."""
        if selected:
            columns = self._get_table_columns()
            self.selected_columns = [Column(name=c["name"]) for c in columns]
        else:
            self.selected_columns = []
        
        self._update_query()

    def _set_column_aggregation(self, column: dict, aggregation: str) -> None:
        """Set aggregation for a column."""
        for col in self.selected_columns:
            if col.name == column["name"]:
                col.aggregation = AggregationType(aggregation)
                break
        
        self._update_query()

    def _add_filter(self) -> None:
        """Add a new filter."""
        columns = self._get_table_columns()
        if columns:
            self.filters.append(
                Filter(
                    column=columns[0]["name"],
                    operator=FilterOperator.EQUALS,
                    value="",
                )
            )
            self._render_filters()
            self._update_query()

    def _render_filters(self) -> None:
        """Render the filter list."""
        columns = self._get_table_columns()
        column_names = [c["name"] for c in columns]
        operators = [op.value for op in FilterOperator]
        
        for i, f in enumerate(self.filters):
            with ui.row().classes("items-center gap-2 w-full"):
                ui.select(
                    options=column_names,
                    value=f.column,
                    on_change=lambda e, idx=i: self._update_filter_column(idx, e.value),
                ).props("dense").classes("w-40")
                
                ui.select(
                    options=operators,
                    value=f.operator.value,
                    on_change=lambda e, idx=i: self._update_filter_operator(idx, e.value),
                ).props("dense").classes("w-32")
                
                ui.input(
                    value=str(f.value) if f.value else "",
                    on_change=lambda e, idx=i: self._update_filter_value(idx, e.value),
                ).props("dense").classes("flex-grow")
                
                ui.button(
                    icon="delete",
                    on_click=lambda idx=i: self._remove_filter(idx),
                ).props("flat round dense")

    def _update_filter_column(self, index: int, column: str) -> None:
        """Update filter column."""
        self.filters[index].column = column
        self._update_query()

    def _update_filter_operator(self, index: int, operator: str) -> None:
        """Update filter operator."""
        self.filters[index].operator = FilterOperator(operator)
        self._update_query()

    def _update_filter_value(self, index: int, value: str) -> None:
        """Update filter value."""
        self.filters[index].value = value
        self._update_query()

    def _remove_filter(self, index: int) -> None:
        """Remove a filter."""
        del self.filters[index]
        self._render_filters()
        self._update_query()

    def _add_sort(self) -> None:
        """Add a new sort."""
        columns = self._get_table_columns()
        if columns:
            self.sorts.append(
                Sort(
                    column=columns[0]["name"],
                    direction=SortDirection.ASC,
                )
            )
            self._render_sorts()
            self._update_query()

    def _render_sorts(self) -> None:
        """Render the sort list."""
        columns = self._get_table_columns()
        column_names = [c["name"] for c in columns]
        directions = [d.value for d in SortDirection]
        
        for i, s in enumerate(self.sorts):
            with ui.row().classes("items-center gap-2 w-full"):
                ui.select(
                    options=column_names,
                    value=s.column,
                    on_change=lambda e, idx=i: self._update_sort_column(idx, e.value),
                ).props("dense").classes("flex-grow")
                
                ui.select(
                    options=directions,
                    value=s.direction.value,
                    on_change=lambda e, idx=i: self._update_sort_direction(idx, e.value),
                ).props("dense").classes("w-24")
                
                ui.button(
                    icon="delete",
                    on_click=lambda idx=i: self._remove_sort(idx),
                ).props("flat round dense")

    def _update_sort_column(self, index: int, column: str) -> None:
        """Update sort column."""
        self.sorts[index].column = column
        self._update_query()

    def _update_sort_direction(self, index: int, direction: str) -> None:
        """Update sort direction."""
        self.sorts[index].direction = SortDirection(direction)
        self._update_query()

    def _remove_sort(self, index: int) -> None:
        """Remove a sort."""
        del self.sorts[index]
        self._render_sorts()
        self._update_query()

    def _set_limit(self, limit: int | None) -> None:
        """Set query limit."""
        self.limit = int(limit) if limit else None
        self._update_query()

    def _set_distinct(self, distinct: bool) -> None:
        """Set distinct flag."""
        self.distinct = distinct
        self._update_query()

    def _update_query(self) -> None:
        """Update the generated query."""
        if not self.selected_table:
            self._sql_preview.content = "-- Select a table to begin"
            return
        
        query = VisualQuery(
            table=self.selected_table,
            schema=self.selected_schema,
            columns=self.selected_columns,
            filters=self.filters,
            order_by=self.sorts,
            limit=self.limit,
            distinct=self.distinct,
        )
        
        sql = self._builder.build(query)
        self._sql_preview.content = sql
        
        if self.on_query_change:
            self.on_query_change(sql, query)

    def get_sql(self) -> str:
        """Get the generated SQL query."""
        if not self.selected_table:
            return ""
        
        query = VisualQuery(
            table=self.selected_table,
            schema=self.selected_schema,
            columns=self.selected_columns,
            filters=self.filters,
            order_by=self.sorts,
            limit=self.limit,
            distinct=self.distinct,
        )
        
        return self._builder.build(query)

    def get_visual_query(self) -> VisualQuery | None:
        """Get the visual query definition."""
        if not self.selected_table:
            return None
        
        return VisualQuery(
            table=self.selected_table,
            schema=self.selected_schema,
            columns=self.selected_columns,
            filters=self.filters,
            order_by=self.sorts,
            limit=self.limit,
            distinct=self.distinct,
        )

