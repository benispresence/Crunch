"""
SQL query validation and sanitization.

Provides security checks and validation for SQL queries.
"""

import re
from dataclasses import dataclass
from enum import Enum


class QueryType(Enum):
    """Type of SQL query."""
    SELECT = "select"
    INSERT = "insert"
    UPDATE = "update"
    DELETE = "delete"
    DDL = "ddl"  # CREATE, ALTER, DROP, etc.
    OTHER = "other"


@dataclass
class ValidationResult:
    """Result of query validation."""
    is_valid: bool
    query_type: QueryType
    warnings: list[str]
    errors: list[str]
    
    @property
    def is_read_only(self) -> bool:
        """Check if query is read-only (SELECT)."""
        return self.query_type == QueryType.SELECT


class QueryValidator:
    """
    Validates and sanitizes SQL queries.
    
    Provides security checks to prevent SQL injection and
    restrict dangerous operations.
    """

    # Dangerous patterns that might indicate SQL injection
    INJECTION_PATTERNS = [
        r";\s*--",  # Comment after semicolon
        r";\s*/\*",  # Block comment after semicolon
        r"'\s*OR\s+'?\d+'?\s*=\s*'?\d+'?",  # OR 1=1 pattern
        r"UNION\s+ALL\s+SELECT",  # UNION injection
        r"INTO\s+OUTFILE",  # File writing
        r"INTO\s+DUMPFILE",  # File writing
        r"LOAD_FILE\s*\(",  # File reading
    ]

    # DDL keywords that modify schema
    DDL_KEYWORDS = [
        "CREATE", "ALTER", "DROP", "TRUNCATE", "RENAME",
        "GRANT", "REVOKE", "COMMENT",
    ]

    # Write keywords
    WRITE_KEYWORDS = ["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE"]

    def __init__(
        self,
        allow_writes: bool = False,
        allow_ddl: bool = False,
        max_query_length: int = 100000,
    ):
        """
        Initialize the validator.
        
        Args:
            allow_writes: Allow INSERT, UPDATE, DELETE queries
            allow_ddl: Allow DDL (CREATE, DROP, ALTER, etc.) queries
            max_query_length: Maximum allowed query length
        """
        self.allow_writes = allow_writes
        self.allow_ddl = allow_ddl
        self.max_query_length = max_query_length

    def detect_query_type(self, sql: str) -> QueryType:
        """
        Detect the type of SQL query.
        
        Args:
            sql: SQL query string
            
        Returns:
            QueryType enum value
        """
        # Normalize and get first meaningful keyword
        normalized = sql.strip().upper()
        
        # Remove leading comments
        while normalized.startswith("--") or normalized.startswith("/*"):
            if normalized.startswith("--"):
                newline = normalized.find("\n")
                if newline == -1:
                    return QueryType.OTHER
                normalized = normalized[newline + 1:].strip()
            elif normalized.startswith("/*"):
                end_comment = normalized.find("*/")
                if end_comment == -1:
                    return QueryType.OTHER
                normalized = normalized[end_comment + 2:].strip()

        # Check for DDL
        for keyword in self.DDL_KEYWORDS:
            if normalized.startswith(keyword):
                return QueryType.DDL

        # Check for write operations
        for keyword in self.WRITE_KEYWORDS:
            if normalized.startswith(keyword):
                if keyword == "INSERT":
                    return QueryType.INSERT
                elif keyword == "UPDATE":
                    return QueryType.UPDATE
                elif keyword == "DELETE":
                    return QueryType.DELETE

        # Check for SELECT
        if normalized.startswith("SELECT") or normalized.startswith("WITH"):
            return QueryType.SELECT

        return QueryType.OTHER

    def check_injection_patterns(self, sql: str) -> list[str]:
        """
        Check for potential SQL injection patterns.
        
        Args:
            sql: SQL query string
            
        Returns:
            List of warning messages for detected patterns
        """
        warnings = []
        sql_upper = sql.upper()

        for pattern in self.INJECTION_PATTERNS:
            if re.search(pattern, sql_upper, re.IGNORECASE):
                warnings.append(f"Potential SQL injection pattern detected: {pattern}")

        return warnings

    def validate(self, sql: str) -> ValidationResult:
        """
        Validate a SQL query.
        
        Args:
            sql: SQL query string to validate
            
        Returns:
            ValidationResult with validation status and messages
        """
        errors = []
        warnings = []

        # Check query length
        if len(sql) > self.max_query_length:
            errors.append(
                f"Query exceeds maximum length ({len(sql)} > {self.max_query_length})"
            )

        # Check for empty query
        if not sql or not sql.strip():
            errors.append("Query is empty")
            return ValidationResult(
                is_valid=False,
                query_type=QueryType.OTHER,
                warnings=warnings,
                errors=errors,
            )

        # Detect query type
        query_type = self.detect_query_type(sql)

        # Check if write operations are allowed
        if query_type in (QueryType.INSERT, QueryType.UPDATE, QueryType.DELETE):
            if not self.allow_writes:
                errors.append(
                    f"{query_type.value.upper()} queries are not allowed"
                )

        # Check if DDL is allowed
        if query_type == QueryType.DDL:
            if not self.allow_ddl:
                errors.append("DDL queries (CREATE, DROP, ALTER, etc.) are not allowed")

        # Check for injection patterns
        injection_warnings = self.check_injection_patterns(sql)
        warnings.extend(injection_warnings)

        # Check for multiple statements (potential injection)
        semicolon_count = sql.count(";")
        if semicolon_count > 1:
            warnings.append(
                f"Query contains multiple statements ({semicolon_count} semicolons)"
            )

        return ValidationResult(
            is_valid=len(errors) == 0,
            query_type=query_type,
            warnings=warnings,
            errors=errors,
        )

    def sanitize(self, sql: str) -> str:
        """
        Basic sanitization of SQL query.
        
        Note: This is NOT a substitute for parameterized queries.
        Always use parameters for user input.
        
        Args:
            sql: SQL query string
            
        Returns:
            Sanitized query string
        """
        # Remove trailing semicolons (prevent statement chaining)
        sql = sql.rstrip().rstrip(";")
        
        # Remove null bytes
        sql = sql.replace("\x00", "")
        
        return sql

