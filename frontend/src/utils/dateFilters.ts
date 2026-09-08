/** Date-filter presets and range helpers shared by the query and dashboard bars. */

export interface DatePreset {
  id: string;
  label: string;
}

/** Point-in-time date variables (`{{start_date}}` as a bind). */
export const DATE_POINT_PRESETS: DatePreset[] = [
  { id: "", label: "Custom date" },
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "this_month", label: "Start of month" },
  { id: "this_year", label: "Start of year" },
];

/** Field-filter / date-range widgets. */
export const DATE_RANGE_PRESETS: DatePreset[] = [
  { id: "", label: "Custom range" },
  { id: "today", label: "Today" },
  { id: "yesterday", label: "Yesterday" },
  { id: "last_7_days", label: "Last 7 days" },
  { id: "last_30_days", label: "Last 30 days" },
  { id: "last_90_days", label: "Last 90 days" },
  { id: "this_week", label: "This week" },
  { id: "last_week", label: "Last week" },
  { id: "this_month", label: "This month" },
  { id: "last_month", label: "Last month" },
  { id: "this_quarter", label: "This quarter" },
  { id: "this_year", label: "This year" },
  { id: "last_year", label: "Last year" },
];

export interface DateRangeValue {
  start?: string | null;
  end?: string | null;
}

export function isDateRangeValue(v: unknown): v is DateRangeValue {
  return v != null && typeof v === "object" && !Array.isArray(v) && ("start" in v || "end" in v);
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

export function ymd(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function atLocalMidnight(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const x = atLocalMidnight(d);
  x.setDate(x.getDate() + n);
  return x;
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function weekStart(d: Date): Date {
  const x = atLocalMidnight(d);
  const day = x.getDay(); // 0 Sun
  const iso = day === 0 ? 6 : day - 1; // Monday=0
  return addDays(x, -iso);
}

function quarterStart(d: Date): Date {
  const q = Math.floor(d.getMonth() / 3) * 3;
  return new Date(d.getFullYear(), q, 1);
}

const RANGE_IDS = new Set(DATE_RANGE_PRESETS.map((p) => p.id).filter(Boolean));
const POINT_IDS = new Set(DATE_POINT_PRESETS.map((p) => p.id).filter(Boolean));

export function stripRelativePrefix(raw: string): string {
  return raw.toLowerCase().startsWith("relative:") ? raw.slice(9) : raw;
}

export function isRangePresetId(v: string): boolean {
  const key = stripRelativePrefix(v);
  return RANGE_IDS.has(key) || /^\d+d$/.test(key);
}

export function isPointPresetId(v: string): boolean {
  const key = stripRelativePrefix(v);
  return POINT_IDS.has(key) || /^\d+d$/.test(key) || key.startsWith("last_");
}

/**
 * Inclusive start / inclusive end as YYYY-MM-DD, for display. Matches the
 * python engine's relative-token math (local calendar, last N days includes today).
 */
export function resolveDateRange(
  raw: unknown,
  today = new Date(),
): { start: string; end: string } | null {
  if (raw == null || raw === "") return null;
  const now = atLocalMidnight(today);

  if (isDateRangeValue(raw)) {
    const start = (raw.start ?? "").trim();
    const end = (raw.end ?? "").trim();
    if (!start && !end) return null;
    return { start, end };
  }

  if (typeof raw !== "string") return null;
  const s = stripRelativePrefix(raw.trim());
  if (!s) return null;
  if (s.includes("~")) {
    const [a, b] = s.split("~", 2);
    return { start: (a ?? "").trim(), end: (b ?? "").trim() };
  }

  const tomorrow = addDays(now, 1);
  let start: Date;
  let endExcl: Date;
  switch (s) {
    case "today":
    case "now":
      start = now;
      endExcl = tomorrow;
      break;
    case "yesterday":
      start = addDays(now, -1);
      endExcl = now;
      break;
    case "this_week":
      start = weekStart(now);
      endExcl = addDays(start, 7);
      break;
    case "last_week":
      start = addDays(weekStart(now), -7);
      endExcl = addDays(start, 7);
      break;
    case "this_month":
    case "month":
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      endExcl = addMonths(start, 1);
      break;
    case "last_month":
      endExcl = new Date(now.getFullYear(), now.getMonth(), 1);
      start = addMonths(endExcl, -1);
      break;
    case "this_quarter":
      start = quarterStart(now);
      endExcl = addMonths(start, 3);
      break;
    case "this_year":
    case "year":
      start = new Date(now.getFullYear(), 0, 1);
      endExcl = new Date(now.getFullYear() + 1, 0, 1);
      break;
    case "last_year":
      start = new Date(now.getFullYear() - 1, 0, 1);
      endExcl = new Date(now.getFullYear(), 0, 1);
      break;
    default: {
      const n = /^(\d+)d$/.exec(s) ?? /^last_(\d+)_days$/.exec(s);
      if (n) {
        const days = Number(n[1]);
        start = addDays(now, -(days - 1));
        endExcl = tomorrow;
        break;
      }
      if (/^\d{4}-\d{2}$/.test(s)) {
        const [y, m] = s.split("-").map(Number);
        start = new Date(y, m - 1, 1);
        endExcl = addMonths(start, 1);
        break;
      }
      if (/^\d{4}-\d{2}-\d{2}$/.test(s)) {
        start = new Date(s + "T00:00:00");
        endExcl = addDays(start, 1);
        break;
      }
      return null;
    }
  }
  return { start: ymd(start), end: ymd(addDays(endExcl, -1)) };
}

export function formatRangeSummary(raw: unknown): string {
  const r = resolveDateRange(raw);
  if (!r) return "";
  if (r.start && r.end) return r.start === r.end ? r.start : `${r.start} → ${r.end}`;
  if (r.start) return `from ${r.start}`;
  if (r.end) return `until ${r.end}`;
  return "";
}

/** Names that should default to a date widget when auto-detected from SQL. */
export function inferParameterType(name: string): "text" | "number" | "date" | "boolean" {
  const n = name.toLowerCase();
  if (
    /(?:^|_)(?:date|time|timestamp|month|year)(?:$|_)/.test(n)
    || /(?:_at|_on|_ts)$/.test(n)
    || n === "since"
    || n === "until"
  ) {
    return "date";
  }
  if (/^(?:is_|has_|flag_)/.test(n) || /(?:_flag|_bool)$/.test(n)) {
    return "boolean";
  }
  return "text";
}

export function looksLikeDateColumn(target: string | undefined | null): boolean {
  if (!target) return false;
  const last = (target.split(".").pop() ?? target).replace(/["`[\]]/g, "");
  return inferParameterType(last) === "date";
}
