"""
Visual query builder.

Converts visual query definitions (JSON) to SQL queries.
"""

from dataclasses import dataclass, field
from enum import Enum
from typing import Any


class AggregationType(Enum):
    """SQL aggregation functions."""
    NONE = "none"
    COUNT = "count"
    COUNT_DISTINCT = "count_distinct"
    SUM = "sum"
    AVG = "avg"
    MIN = "min"
    MAX = "max"


class FilterOperator(Enum):
    """SQL filter operators."""
    EQUALS = "="
    NOT_EQUALS = "!="
    GREATER_THAN = ">"
    GREATER_THAN_OR_EQUAL = ">="
    LESS_THAN = "<"
    LESS_THAN_OR_EQUAL = "<="
    LIKE = "LIKE"
    NOT_LIKE = "NOT LIKE"
    IN = "IN"
    NOT_IN = "NOT IN"
    IS_NULL = "IS NULL"
    IS_NOT_NULL = "IS NOT NULL"
    BETWEEN = "BETWEEN"


class JoinType(Enum):
    """SQL join types."""
    INNER = "INNER JOIN"
    LEFT = "LEFT JOIN"
    RIGHT = "RIGHT JOIN"
    FULL = "FULL OUTER JOIN"
    CROSS = "CROSS JOIN"


class SortDirection(Enum):
    """Sort direction."""
    ASC = "ASC"
    DESC = "DESC"


@dataclass
class Column:
    """Column selection in visual query."""
    name: str
    table: str | None = None
    alias: str | None = None
    aggregation: AggregationType = AggregationType.NONE


@dataclass
class Filter:
    """Filter condition in visual query."""
    column: str
    operator: FilterOperator
    value: Any = None
    value2: Any = None  # For BETWEEN
    table: str | None = None


@dataclass
class Join:
    """Join definition in visual query."""
    table: str
    join_type: JoinType
    left_column: str
    right_column: str
    left_table: str | None = None
    alias: str | None = None


@dataclass
class Sort:
    """Sort definition in visual query."""
    column: str
    direction: SortDirection = SortDirection.ASC
    table: str | None = None


@dataclass
class VisualQuery:
    """
    Visual query definition.
    
    Represents a query built using the visual query builder UI.
    Can be serialized to/from JSON for storage.
    """
    
    # Source table
    table: str
    schema: str | None = None
    
    # Selected columns
    columns: list[Column] = field(default_factory=list)
    
    # Joins
    joins: list[Join] = field(default_factory=list)
    
    # Filters (WHERE clause)
    filters: list[Filter] = field(default_factory=list)
    
    # Grouping
    group_by: list[str] = field(default_factory=list)
    
    # Having clause (filters on aggregates)
    having: list[Filter] = field(default_factory=list)
    
    # Sorting
    order_by: list[Sort] = field(default_factory=list)
    
    # Pagination
    limit: int | None = None
    offset: int | None = None
    
    # Distinct
    distinct: bool = False

    def to_dict(self) -> dict:
        """Convert to dictionary for JSON serialization."""
        return {
            "table": self.table,
            "schema": self.schema,
            "columns": [
                {
                    "name": c.name,
                    "table": c.table,
                    "alias": c.alias,
                    "aggregation": c.aggregation.value,
                }
                for c in self.columns
            ],
            "joins": [
                {
                    "table": j.table,
                    "join_type": j.join_type.value,
                    "left_column": j.left_column,
                    "right_column": j.right_column,
                    "left_table": j.left_table,
                    "alias": j.alias,
                }
                for j in self.joins
            ],
            "filters": [
                {
                    "column": f.column,
                    "operator": f.operator.value,
                    "value": f.value,
                    "value2": f.value2,
                    "table": f.table,
                }
                for f in self.filters
            ],
            "group_by": self.group_by,
            "having": [
                {
                    "column": h.column,
                    "operator": h.operator.value,
                    "value": h.value,
                    "value2": h.value2,
                    "table": h.table,
                }
                for h in self.having
            ],
            "order_by": [
                {
                    "column": s.column,
                    "direction": s.direction.value,
                    "table": s.table,
                }
                for s in self.order_by
            ],
            "limit": self.limit,
            "offset": self.offset,
            "distinct": self.distinct,
        }

    @classmethod
    def from_dict(cls, data: dict) -> "VisualQuery":
        """Create VisualQuery from dictionary."""
        return cls(
            table=data["table"],
            schema=data.get("schema"),
            columns=[
                Column(
                    name=c["name"],
                    table=c.get("table"),
                    alias=c.get("alias"),
                    aggregation=AggregationType(c.get("aggregation", "none")),
                )
                for c in data.get("columns", [])
            ],
            joins=[
                Join(
                    table=j["table"],
                    join_type=JoinType(j["join_type"]),
                    left_column=j["left_column"],
                    right_column=j["right_column"],
                    left_table=j.get("left_table"),
                    alias=j.get("alias"),
                )
                for j in data.get("joins", [])
            ],
            filters=[
                Filter(
                    column=f["column"],
                    operator=FilterOperator(f["operator"]),
                    value=f.get("value"),
                    value2=f.get("value2"),
                    table=f.get("table"),
                )
                for f in data.get("filters", [])
            ],
            group_by=data.get("group_by", []),
            having=[
                Filter(
                    column=h["column"],
                    operator=FilterOperator(h["operator"]),
                    value=h.get("value"),
                    value2=h.get("value2"),
                    table=h.get("table"),
                )
                for h in data.get("having", [])
            ],
            order_by=[
                Sort(
                    column=s["column"],
                    direction=SortDirection(s.get("direction", "ASC")),
                    table=s.get("table"),
                )
                for s in data.get("order_by", [])
            ],
            limit=data.get("limit"),
            offset=data.get("offset"),
            distinct=data.get("distinct", False),
        )


class QueryBuilder:
    """
    Builds SQL queries from visual query definitions.
    
    Converts VisualQuery objects to valid SQL strings.
    """

    def __init__(self, quote_char: str = '"'):
        """
        Initialize the query builder.
        
        Args:
            quote_char: Character to use for quoting identifiers
        """
        self.quote_char = quote_char

    def quote_identifier(self, name: str) -> str:
        """Quote an identifier (table/column name)."""
        return f'{self.quote_char}{name}{self.quote_char}'

    def format_value(self, value: Any) -> str:
        """Format a value for SQL."""
        if value is None:
            return "NULL"
        elif isinstance(value, bool):
            return "TRUE" if value else "FALSE"
        elif isinstance(value, (int, float)):
            return str(value)
        elif isinstance(value, (list, tuple)):
            formatted = ", ".join(self.format_value(v) for v in value)
            return f"({formatted})"
        else:
            # Escape single quotes
            escaped = str(value).replace("'", "''")
            return f"'{escaped}'"

    def build_column_reference(self, column: Column) -> str:
        """Build column reference with optional table prefix and aggregation."""
        if column.table:
            col_ref = f"{self.quote_identifier(column.table)}.{self.quote_identifier(column.name)}"
        else:
            col_ref = self.quote_identifier(column.name)

        # Apply aggregation
        if column.aggregation != AggregationType.NONE:
            if column.aggregation == AggregationType.COUNT:
                col_ref = f"COUNT({col_ref})"
            elif column.aggregation == AggregationType.COUNT_DISTINCT:
                col_ref = f"COUNT(DISTINCT {col_ref})"
            elif column.aggregation == AggregationType.SUM:
                col_ref = f"SUM({col_ref})"
            elif column.aggregation == AggregationType.AVG:
                col_ref = f"AVG({col_ref})"
            elif column.aggregation == AggregationType.MIN:
                col_ref = f"MIN({col_ref})"
            elif column.aggregation == AggregationType.MAX:
                col_ref = f"MAX({col_ref})"

        # Add alias
        if column.alias:
            col_ref = f"{col_ref} AS {self.quote_identifier(column.alias)}"

        return col_ref

    def build_filter_condition(self, filter: Filter) -> str:
        """Build a single filter condition."""
        if filter.table:
            col_ref = f"{self.quote_identifier(filter.table)}.{self.quote_identifier(filter.column)}"
        else:
            col_ref = self.quote_identifier(filter.column)

        op = filter.operator

        if op == FilterOperator.IS_NULL:
            return f"{col_ref} IS NULL"
        elif op == FilterOperator.IS_NOT_NULL:
            return f"{col_ref} IS NOT NULL"
        elif op == FilterOperator.BETWEEN:
            return f"{col_ref} BETWEEN {self.format_value(filter.value)} AND {self.format_value(filter.value2)}"
        elif op in (FilterOperator.IN, FilterOperator.NOT_IN):
            values = filter.value if isinstance(filter.value, (list, tuple)) else [filter.value]
            formatted = ", ".join(self.format_value(v) for v in values)
            return f"{col_ref} {op.value} ({formatted})"
        else:
            return f"{col_ref} {op.value} {self.format_value(filter.value)}"

    def build(self, query: VisualQuery) -> str:
        """
        Build SQL from a visual query definition.
        
        Args:
            query: VisualQuery to convert
            
        Returns:
            SQL query string
        """
        parts = []

        # SELECT clause
        select_keyword = "SELECT DISTINCT" if query.distinct else "SELECT"
        
        if query.columns:
            columns_sql = ", ".join(
                self.build_column_reference(col) for col in query.columns
            )
        else:
            columns_sql = "*"
        
        parts.append(f"{select_keyword} {columns_sql}")

        # FROM clause
        if query.schema:
            table_ref = f"{self.quote_identifier(query.schema)}.{self.quote_identifier(query.table)}"
        else:
            table_ref = self.quote_identifier(query.table)
        
        parts.append(f"FROM {table_ref}")

        # JOIN clauses
        for join in query.joins:
            join_table = self.quote_identifier(join.table)
            if join.alias:
                join_table = f"{join_table} AS {self.quote_identifier(join.alias)}"
            
            left_table = self.quote_identifier(join.left_table) if join.left_table else self.quote_identifier(query.table)
            right_table = self.quote_identifier(join.alias or join.table)
            
            on_clause = f"{left_table}.{self.quote_identifier(join.left_column)} = {right_table}.{self.quote_identifier(join.right_column)}"
            
            parts.append(f"{join.join_type.value} {join_table} ON {on_clause}")

        # WHERE clause
        if query.filters:
            conditions = [self.build_filter_condition(f) for f in query.filters]
            parts.append(f"WHERE {' AND '.join(conditions)}")

        # GROUP BY clause
        if query.group_by:
            group_cols = ", ".join(self.quote_identifier(col) for col in query.group_by)
            parts.append(f"GROUP BY {group_cols}")

        # HAVING clause
        if query.having:
            conditions = [self.build_filter_condition(h) for h in query.having]
            parts.append(f"HAVING {' AND '.join(conditions)}")

        # ORDER BY clause
        if query.order_by:
            order_parts = []
            for sort in query.order_by:
                if sort.table:
                    col_ref = f"{self.quote_identifier(sort.table)}.{self.quote_identifier(sort.column)}"
                else:
                    col_ref = self.quote_identifier(sort.column)
                order_parts.append(f"{col_ref} {sort.direction.value}")
            parts.append(f"ORDER BY {', '.join(order_parts)}")

        # LIMIT and OFFSET
        if query.limit is not None:
            parts.append(f"LIMIT {query.limit}")
        if query.offset is not None:
            parts.append(f"OFFSET {query.offset}")

        return "\n".join(parts)

    def build_from_dict(self, data: dict) -> str:
        """Build SQL from a dictionary (JSON) representation."""
        query = VisualQuery.from_dict(data)
        return self.build(query)

