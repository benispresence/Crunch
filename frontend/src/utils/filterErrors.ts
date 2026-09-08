/** Heuristic: this SQL / chart error is about templated filters. */

const FILTER_ERROR_RE = /parameter '|field filter|mapped column|not a valid date|Docs → Filters|\{\{[A-Za-z_]|optional clause|TemplateError|invalid input for query argument|expected a datetime|has no mapped column|Invalid field filter|cannot cast type boolean|CAST\(1\s*=\s*1|1=1 AS timestamp/i;

export const FILTERS_DOCS_PATH = "/docs/filters";

export function isFilterError(message: string | null | undefined): boolean {
  if (!message) return false;
  return FILTER_ERROR_RE.test(message);
}
