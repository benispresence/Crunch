/** Validate a dotted SQL identifier (schema.table.column) the same way
 *  the template engine does, so field-filter DISTINCT queries can't
 *  interpolate arbitrary SQL. */

const SEG = /("[^"]+"|`[^`]+`|\[[^\]]+\]|[A-Za-z_][A-Za-z0-9_]*)/y;

export function splitSqlIdent(target: string): string[] | null {
  const s = target.trim();
  if (!s) return null;
  const parts: string[] = [];
  let i = 0;
  while (i < s.length) {
    SEG.lastIndex = i;
    const m = SEG.exec(s);
    if (!m) return null;
    parts.push(m[1]);
    i = SEG.lastIndex;
    if (i === s.length) break;
    if (s[i] === ".") {
      i += 1;
      if (i === s.length) return null;
      continue;
    }
    return null;
  }
  return parts.length ? parts : null;
}

/** Return the identifier unchanged if every segment is safe. */
export function sqlIdent(target: string): string | null {
  const parts = splitSqlIdent(target);
  return parts ? parts.join(".") : null;
}

export function fieldTableAndColumn(target: string): { table: string; column: string } | null {
  const parts = splitSqlIdent(target);
  if (!parts || parts.length < 2) return null;
  return {
    table: parts.slice(0, -1).join("."),
    column: parts[parts.length - 1],
  };
}
