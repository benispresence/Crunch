/**
 * Pure pipeline classifiers and state machines.
 *
 * Queue admission, health vs freshness, quality-check evaluation,
 * secret stripping, retry backoff, extract-vs-write normalization,
 * version diffs, backfill warnings, failure explanations, and
 * overview DTO assembly live here so tests can drive them without
 * SQLite, the UI, or an LLM.
 */

export type ExtractStrategy = "full" | "incremental" | "streaming";
export type WriteBehavior = "replace" | "append" | "merge";
export type RunTrigger =
  | "manual"
  | "schedule"
  | "agent"
  | "retry"
  | "backfill"
  | "test";
export type RunStatus =
  | "queued"
  | "running"
  | "success"
  | "failed"
  | "cancelled"
  | "retrying";
export type AttentionBucket =
  | "needs_attention"
  | "running"
  | "queued"
  | "healthy"
  | "paused";
export type ExecutionHealth =
  | "healthy"
  | "failed"
  | "running"
  | "queued"
  | "paused"
  | "never_run";
export type FreshnessStatus = "fresh" | "stale" | "unknown";
export type CauseConfidence = "likely" | "confirmed";

export const SENSITIVE_KEYS = new Set([
  "password",
  "passphrase",
  "secret",
  "auth_header",
  "api_key",
  "token",
  "access_token",
  "private_key",
  "connection_url",
]);

export interface SecretRef {
  $secret_ref: string;
}

export function isSecretRef(value: unknown): value is SecretRef {
  return (
    !!value &&
    typeof value === "object" &&
    "$secret_ref" in (value as Record<string, unknown>) &&
    typeof (value as SecretRef).$secret_ref === "string"
  );
}

/** Replace secret values with `{ $secret_ref }` pointers. Never stores values. */
export function stripSecretsFromConfig(
  config: unknown,
  path = "",
): { sanitized: unknown; refs: string[] } {
  const { sanitized, secrets } = extractAndReplaceSecrets(config, { path });
  return { sanitized, refs: Object.keys(secrets) };
}

/**
 * Split a config into a secret-free copy and a { ref → plaintext } map.
 * Callers persist the map in an encrypted vault; versions/AI see only refs.
 */
export function extractAndReplaceSecrets(
  config: unknown,
  opts: {
    path?: string;
    mask?: string;
    previous?: Record<string, string>;
  } = {},
): { sanitized: unknown; secrets: Record<string, string> } {
  const secrets: Record<string, string> = { ...(opts.previous ?? {}) };
  const sanitized = walkExtract(config, opts.path ?? "", secrets, opts.mask ?? null);
  return { sanitized, secrets };
}

function walkExtract(
  value: unknown,
  path: string,
  secrets: Record<string, string>,
  mask: string | null,
): unknown {
  if (value == null) return value;
  if (Array.isArray(value)) {
    return value.map((v, i) =>
      walkExtract(v, path ? `${path}.${i}` : String(i), secrets, mask),
    );
  }
  if (typeof value === "object") {
    if (isSecretRef(value)) {
      return value;
    }
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) {
      const child = path ? `${path}.${k}` : k;
      if (SENSITIVE_KEYS.has(k) && typeof v === "string" && v.length > 0) {
        if (mask && v === mask) {
          out[k] = { $secret_ref: child } satisfies SecretRef;
        } else {
          secrets[child] = v;
          out[k] = { $secret_ref: child } satisfies SecretRef;
        }
      } else {
        out[k] = walkExtract(v, child, secrets, mask);
      }
    }
    return out;
  }
  return value;
}

/** Resolve `$secret_ref` leaves through a lookup. Used only at execution time. */
export function resolveSecretReferences(
  config: unknown,
  resolver: (ref: string) => string | undefined,
): unknown {
  if (config == null) return config;
  if (isSecretRef(config)) {
    const resolved = resolver(config.$secret_ref);
    if (resolved === undefined) {
      throw new Error(`unresolved secret reference: ${config.$secret_ref}`);
    }
    return resolved;
  }
  if (Array.isArray(config)) {
    return config.map((v) => resolveSecretReferences(v, resolver));
  }
  if (typeof config === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(config as Record<string, unknown>)) {
      out[k] = resolveSecretReferences(v, resolver);
    }
    return out;
  }
  return config;
}

/** True when any known secret string appears in the serialized payload. */
export function payloadContainsSecretValues(
  payload: unknown,
  knownSecrets: string[],
): boolean {
  const blob = JSON.stringify(payload);
  for (const secret of knownSecrets) {
    if (secret && secret.length >= 3 && blob.includes(secret)) return true;
  }
  return false;
}

export function payloadHasSecretRefs(payload: unknown): boolean {
  if (payload == null) return false;
  if (isSecretRef(payload)) return true;
  if (Array.isArray(payload)) return payload.some(payloadHasSecretRefs);
  if (typeof payload === "object") {
    return Object.values(payload as Record<string, unknown>).some(payloadHasSecretRefs);
  }
  return false;
}

/**
 * Incremental extraction and merge writes are independent.
 * Legacy `load_mode` is mapped when the split fields are absent.
 */
export function normalizeLoadBehavior(input: {
  extract_strategy?: string | null;
  write_behavior?: string | null;
  load_mode?: string | null;
}): { extract_strategy: ExtractStrategy; write_behavior: WriteBehavior } {
  const extractIn = input.extract_strategy;
  const writeIn = input.write_behavior;
  if (isExtract(extractIn) && isWrite(writeIn)) {
    return { extract_strategy: extractIn, write_behavior: writeIn };
  }
  const mode = input.load_mode ?? "replace";
  switch (mode) {
    case "incremental":
      return {
        extract_strategy: extractIn && isExtract(extractIn) ? extractIn : "incremental",
        write_behavior: writeIn && isWrite(writeIn) ? writeIn : "append",
      };
    case "merge":
      return {
        extract_strategy: extractIn && isExtract(extractIn) ? extractIn : "full",
        write_behavior: writeIn && isWrite(writeIn) ? writeIn : "merge",
      };
    case "append":
      return {
        extract_strategy: extractIn && isExtract(extractIn) ? extractIn : "full",
        write_behavior: writeIn && isWrite(writeIn) ? writeIn : "append",
      };
    case "streaming":
      return {
        extract_strategy: extractIn && isExtract(extractIn) ? extractIn : "streaming",
        write_behavior: writeIn && isWrite(writeIn) ? writeIn : "append",
      };
    default:
      return {
        extract_strategy: extractIn && isExtract(extractIn) ? extractIn : "full",
        write_behavior: writeIn && isWrite(writeIn) ? writeIn : "replace",
      };
  }
}

export function deriveLoadMode(
  extract: ExtractStrategy,
  write: WriteBehavior,
): string {
  if (extract === "streaming") return "streaming";
  if (extract === "incremental" && write === "append") return "incremental";
  return write;
}

function isExtract(v: unknown): v is ExtractStrategy {
  return v === "full" || v === "incremental" || v === "streaming";
}
function isWrite(v: unknown): v is WriteBehavior {
  return v === "replace" || v === "append" || v === "merge";
}

export function classifyExecutionHealth(input: {
  scheduleEnabled: boolean;
  lastRunStatus: string | null;
  running: boolean;
  queued: boolean;
}): ExecutionHealth {
  if (input.running) return "running";
  if (input.queued) return "queued";
  if (input.lastRunStatus === "failed") return "failed";
  if (input.lastRunStatus === "success") return "healthy";
  if (!input.scheduleEnabled && input.lastRunStatus == null) return "paused";
  if (input.lastRunStatus == null) return "never_run";
  if (input.lastRunStatus === "cancelled") {
    return input.scheduleEnabled ? "never_run" : "paused";
  }
  return "never_run";
}

export function classifyFreshness(input: {
  lastSuccessfulUpdate: number | null;
  freshnessThresholdSeconds: number | null;
  now: number;
  freshnessCheckFailed?: boolean;
}): FreshnessStatus {
  if (input.freshnessCheckFailed) return "stale";
  if (input.freshnessThresholdSeconds == null || input.freshnessThresholdSeconds <= 0) {
    return input.lastSuccessfulUpdate == null ? "unknown" : "fresh";
  }
  if (input.lastSuccessfulUpdate == null) return "unknown";
  const age = input.now - input.lastSuccessfulUpdate;
  return age > input.freshnessThresholdSeconds ? "stale" : "fresh";
}

/**
 * One pipeline occupies exactly one attention bucket, in priority order:
 * running → queued → needs attention (failed / stale / failed checks) → paused → healthy.
 */
export function classifyAttention(input: {
  scheduleEnabled: boolean;
  running: boolean;
  queued: boolean;
  executionFailed: boolean;
  freshness: FreshnessStatus;
  checksFailed: boolean;
  lastRunStatus: string | null;
}): AttentionBucket {
  if (input.running) return "running";
  if (input.queued) return "queued";
  const needs =
    input.executionFailed ||
    input.freshness === "stale" ||
    input.checksFailed ||
    input.lastRunStatus === "failed";
  if (needs) return "needs_attention";
  if (!input.scheduleEnabled) return "paused";
  return "healthy";
}

export function buildOverviewCounts(
  buckets: AttentionBucket[],
): Record<AttentionBucket, number> {
  const counts: Record<AttentionBucket, number> = {
    needs_attention: 0,
    running: 0,
    queued: 0,
    healthy: 0,
    paused: 0,
  };
  for (const b of buckets) counts[b] += 1;
  return counts;
}

/** Never drop work: if slots are full, enqueue. */
export function admitRun(input: {
  inFlightCount: number;
  maxConcurrent: number;
}): "start" | "enqueue" {
  if (input.inFlightCount >= input.maxConcurrent) return "enqueue";
  return "start";
}

export function computeRetryBackoffMs(
  attemptNumber: number,
  baseMs = 15_000,
  maxMs = 15 * 60_000,
): number {
  const n = Math.max(1, Math.floor(attemptNumber));
  const ms = baseMs * 2 ** (n - 1);
  return Math.min(maxMs, ms);
}

const TRANSIENT_PATTERNS = [
  /\b429\b/,
  /\b503\b/,
  /\b502\b/,
  /\b504\b/,
  /too many requests/i,
  /rate limit/i,
  /timeout/i,
  /timed out/i,
  /temporar(?:y|ily)/i,
  /connection reset/i,
  /econnreset/i,
  /econnrefused/i,
  /unavailable/i,
];

export function isTransientFailure(error: string | null | undefined): boolean {
  if (!error) return false;
  return TRANSIENT_PATTERNS.some((re) => re.test(error));
}

export function shouldRetry(input: {
  attemptNumber: number;
  maxAttempts: number;
  error: string | null;
  retryPolicy?: "transient" | "never" | "always";
}): boolean {
  if (input.attemptNumber >= input.maxAttempts) return false;
  const policy = input.retryPolicy ?? "transient";
  if (policy === "never") return false;
  if (policy === "always") return true;
  return isTransientFailure(input.error);
}

export function classifyRetryKind(input: {
  retryVersionId: number;
  publishedVersionId: number;
}): "retry_original" | "run_new_version" {
  return input.retryVersionId === input.publishedVersionId
    ? "retry_original"
    : "run_new_version";
}

export function canResumeFromFailedStep(checkpoints: unknown): boolean {
  if (!Array.isArray(checkpoints) || checkpoints.length === 0) return false;
  return checkpoints.some((c) => {
    if (!c || typeof c !== "object") return false;
    const rec = c as Record<string, unknown>;
    return rec.status === "success" && rec.checkpoint != null;
  });
}

export type QualityCheckType =
  | "unique"
  | "not_null"
  | "accepted_values"
  | "freshness"
  | "row_count";

export interface QualityCheck {
  type: QualityCheckType;
  column?: string;
  values?: unknown[];
  max_age_seconds?: number;
  max_relative_change?: number;
  table?: string;
}

export interface CheckResult {
  type: QualityCheckType;
  column?: string;
  passed: boolean | null;
  message: string;
}

export function evaluateQualityChecks(input: {
  rows: Record<string, unknown>[];
  checks: QualityCheck[];
  now?: number;
  previousRowCount?: number | null;
}): CheckResult[] {
  const now = input.now ?? Math.floor(Date.now() / 1000);
  const results: CheckResult[] = [];
  for (const check of input.checks) {
    results.push(evalOneCheck(check, input.rows, now, input.previousRowCount ?? null));
  }
  return results;
}

function evalOneCheck(
  check: QualityCheck,
  rows: Record<string, unknown>[],
  now: number,
  previousRowCount: number | null,
): CheckResult {
  switch (check.type) {
    case "unique": {
      const col = check.column ?? "";
      const vals = rows.map((r) => JSON.stringify(r[col]));
      const dupes = vals.length - new Set(vals).size;
      return {
        type: "unique",
        column: col,
        passed: dupes === 0,
        message:
          dupes === 0
            ? `${col} is unique`
            : `${dupes} duplicate value(s) in ${col}`,
      };
    }
    case "not_null": {
      const col = check.column ?? "";
      const missing = rows.filter((r) => r[col] == null || r[col] === "").length;
      return {
        type: "not_null",
        column: col,
        passed: missing === 0,
        message:
          missing === 0
            ? `${col} has no nulls`
            : `${missing} null/empty value(s) in ${col}`,
      };
    }
    case "accepted_values": {
      const col = check.column ?? "";
      const allowed = new Set((check.values ?? []).map((v) => JSON.stringify(v)));
      const bad = rows.filter((r) => !allowed.has(JSON.stringify(r[col]))).length;
      return {
        type: "accepted_values",
        column: col,
        passed: bad === 0,
        message:
          bad === 0
            ? `${col} values are in the accepted set`
            : `${bad} value(s) in ${col} outside accepted set`,
      };
    }
    case "freshness": {
      const col = check.column;
      const maxAge = check.max_age_seconds ?? 0;
      let ts: number | null = null;
      if (col) {
        for (const row of rows) {
          const n = coerceTimestamp(row[col]);
          if (n != null && (ts == null || n > ts)) ts = n;
        }
      }
      if (ts == null) {
        return {
          type: "freshness",
          column: col,
          passed: false,
          message: col
            ? `no timestamp values in ${col}`
            : "no freshness timestamp available",
        };
      }
      const age = now - ts;
      const passed = age <= maxAge;
      return {
        type: "freshness",
        column: col,
        passed,
        message: passed
          ? `data is within ${maxAge}s`
          : `data is ${age}s old (threshold ${maxAge}s)`,
      };
    }
    case "row_count": {
      const cur = rows.length;
      const prev = previousRowCount;
      const maxRel = check.max_relative_change ?? 0.5;
      if (prev == null || prev === 0) {
        return {
          type: "row_count",
          passed: true,
          message: `row count ${cur} (no baseline)`,
        };
      }
      const change = Math.abs(cur - prev) / prev;
      const passed = change <= maxRel;
      return {
        type: "row_count",
        passed,
        message: passed
          ? `row count ${cur} within ${(maxRel * 100).toFixed(0)}% of ${prev}`
          : `row count changed from ${prev} to ${cur} (${(change * 100).toFixed(0)}% > ${(maxRel * 100).toFixed(0)}%)`,
      };
    }
    default:
      return {
        type: check.type,
        passed: false,
        message: `unknown check type ${(check as QualityCheck).type}`,
      };
  }
}

function coerceTimestamp(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) {
    return v > 1e12 ? Math.floor(v / 1000) : v;
  }
  if (typeof v === "string" && v) {
    const n = Number(v);
    if (Number.isFinite(n)) return n > 1e12 ? Math.floor(n / 1000) : n;
    const parsed = Date.parse(v);
    if (!Number.isNaN(parsed)) return Math.floor(parsed / 1000);
  }
  return null;
}

export function buildBackfillPlan(input: {
  intervalStart: number;
  intervalEnd: number;
  writeBehavior: WriteBehavior;
}): {
  processing_interval_start: number;
  processing_interval_end: number;
  overwrite_duplicate_implications: string;
  warning: string;
} {
  if (input.intervalEnd <= input.intervalStart) {
    throw new Error("backfill interval end must be after start");
  }
  const implications: Record<WriteBehavior, string> = {
    merge:
      "Replaying this interval will upsert matching keys and may overwrite newer values if the source is not the system of record.",
    append:
      "Replaying this interval will INSERT additional rows and can create duplicates unless a unique key is enforced at the destination.",
    replace:
      "Replaying this interval will REPLACE destination contents for this load — existing data outside the interval may also be removed depending on the script.",
  };
  const warning =
    `This backfill covers ${new Date(input.intervalStart * 1000).toISOString()} → ` +
    `${new Date(input.intervalEnd * 1000).toISOString()}. ${implications[input.writeBehavior]} ` +
    "Confirm before replaying the load.";
  return {
    processing_interval_start: input.intervalStart,
    processing_interval_end: input.intervalEnd,
    overwrite_duplicate_implications: implications[input.writeBehavior],
    warning,
  };
}

export interface VersionSnapshot {
  python_code: string;
  config: Record<string, unknown>;
  schedule: string | null;
  timezone: string;
  extract_strategy: ExtractStrategy;
  write_behavior: WriteBehavior;
  quality_checks: QualityCheck[];
  secret_refs: string[];
}

export function buildVersionSnapshot(input: {
  python_code: string;
  config: Record<string, unknown>;
  schedule: string | null;
  timezone?: string;
  extract_strategy?: string | null;
  write_behavior?: string | null;
  load_mode?: string | null;
  quality_checks?: QualityCheck[];
}): VersionSnapshot {
  const load = normalizeLoadBehavior(input);
  const { sanitized, refs } = stripSecretsFromConfig(input.config);
  return {
    python_code: input.python_code,
    config: (sanitized && typeof sanitized === "object"
      ? sanitized
      : {}) as Record<string, unknown>,
    schedule: input.schedule,
    timezone: input.timezone || "UTC",
    extract_strategy: load.extract_strategy,
    write_behavior: load.write_behavior,
    quality_checks: input.quality_checks ?? [],
    secret_refs: refs,
  };
}

export interface ConfigDiffEntry {
  path: string;
  before: unknown;
  after: unknown;
}

export function diffConfigs(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): ConfigDiffEntry[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: ConfigDiffEntry[] = [];
  for (const k of [...keys].sort()) {
    const av = a[k];
    const bv = b[k];
    if (isPlain(av) && isPlain(bv)) {
      for (const child of diffConfigs(av, bv)) {
        out.push({ path: `${k}.${child.path}`, before: child.before, after: child.after });
      }
    } else if (JSON.stringify(av) !== JSON.stringify(bv)) {
      out.push({ path: k, before: av, after: bv });
    }
  }
  return out;
}

function isPlain(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v) && !isSecretRef(v);
}

export function diffCode(
  before: string,
  after: string,
): { before: string; after: string; changed: boolean } {
  return { before, after, changed: before !== after };
}

export interface FailureExplanation {
  headline: string;
  explanation: string;
  confidence: CauseConfidence;
  evidence: Array<{ line: string; source: "log" | "error" }>;
  actions: Array<
    "Retry" | "Ask AI to investigate" | "View logs" | "Pause schedule"
  >;
  phase: "extraction" | "load" | "validate" | "execution";
}

export function explainFailure(input: {
  error: string | null;
  log: string;
  lastSuccessfulUpdate: number | null;
  retryAt?: number | null;
  pipelineName: string;
  now?: number;
}): FailureExplanation {
  const log = input.log || "";
  const error = input.error || "";
  const combined = `${error}\n${log}`;
  const phase = detectPhase(combined);
  const evidence: FailureExplanation["evidence"] = [];
  for (const line of log.split("\n")) {
    if (
      /error|exception|failed|429|503|traceback|timeout/i.test(line) &&
      line.trim()
    ) {
      evidence.push({ line: line.trim().slice(0, 400), source: "log" });
      if (evidence.length >= 8) break;
    }
  }
  if (error) evidence.unshift({ line: error.slice(0, 400), source: "error" });

  let cause = error || "unknown error";
  let confidence: CauseConfidence = evidence.some((e) => e.source === "log")
    ? "confirmed"
    : "likely";
  if (/\b429\b|too many requests|rate limit/i.test(combined)) {
    cause = "The source returned HTTP 429.";
    confidence = /429/.test(log) ? "confirmed" : "likely";
  } else if (/timeout|timed out/i.test(combined)) {
    cause = "The run timed out waiting on the source or destination.";
  } else if (/permission|denied|auth/i.test(combined)) {
    cause = "Authentication or permission failed against the source or destination.";
  }

  const last =
    input.lastSuccessfulUpdate != null
      ? new Date(input.lastSuccessfulUpdate * 1000).toLocaleString()
      : "never";
  let extra = `Last successful update: ${last}.`;
  if (input.retryAt) {
    const now = input.now ?? Math.floor(Date.now() / 1000);
    const secs = Math.max(0, input.retryAt - now);
    extra += ` Retry scheduled in ${Math.ceil(secs / 60) || 0} minutes.`;
  }

  return {
    headline: `${input.pipelineName} failed during ${phase}`,
    explanation: `${cause} ${extra}`.trim(),
    confidence,
    evidence,
    actions: ["Retry", "Ask AI to investigate", "View logs", "Pause schedule"],
    phase,
  };
}

function detectPhase(
  text: string,
): FailureExplanation["phase"] {
  if (/extract|source|http 429|requests\.|pagination/i.test(text)) return "extraction";
  if (/validate|quality check|constraint/i.test(text)) return "validate";
  if (/load|destination|insert|merge|write_disposition/i.test(text)) return "load";
  return "execution";
}

export function recoverRunsOnRestart(
  runs: Array<{ id: number; status: string; pid: number | null }>,
  pidAlive: (pid: number) => boolean,
): Array<{ id: number; nextStatus: RunStatus; requeue: boolean }> {
  const out: Array<{ id: number; nextStatus: RunStatus; requeue: boolean }> = [];
  for (const r of runs) {
    if (r.status === "queued" || r.status === "retrying") {
      out.push({ id: r.id, nextStatus: "queued", requeue: false });
      continue;
    }
    if (r.status === "running") {
      if (r.pid != null && pidAlive(r.pid)) {
        out.push({ id: r.id, nextStatus: "running", requeue: false });
      } else {
        out.push({ id: r.id, nextStatus: "failed", requeue: false });
      }
    }
  }
  return out;
}

export function recentRunStrip(
  runs: Array<{ id: number; status: string }>,
  limit = 10,
): Array<{ id: number; status: string }> {
  return runs.slice(0, limit).map((r) => ({ id: r.id, status: r.status }));
}

export function schemaInspectSql(connectionType: string): string {
  const t = connectionType.toLowerCase();
  if (t === "sqlite" || t === "duckdb") {
    return "SELECT name AS table_name, 'main' AS table_schema FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 200";
  }
  if (t === "postgres" || t === "postgresql" || t === "redshift") {
    return "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema') ORDER BY table_schema, table_name LIMIT 200";
  }
  if (t === "mysql" || t === "mariadb") {
    return "SELECT table_schema, table_name FROM information_schema.tables WHERE table_schema NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY table_schema, table_name LIMIT 200";
  }
  return "SELECT table_schema, table_name FROM information_schema.tables ORDER BY table_schema, table_name LIMIT 200";
}

export function detectLineage(input: {
  destinationDataset: string | null;
  destinationTable: string | null;
  queries: Array<{ id: number; name: string; sql: string }>;
  widgets: Array<{
    dashboard_id: number;
    dashboard_name: string;
    query_id: number | null;
  }>;
}): {
  queries: Array<{ id: number; name: string }>;
  dashboards: Array<{ id: number; name: string }>;
} {
  const needles: string[] = [];
  if (input.destinationDataset) needles.push(input.destinationDataset.toLowerCase());
  if (input.destinationTable) needles.push(input.destinationTable.toLowerCase());
  const matchedQueries = input.queries.filter((q) => {
    const sql = (q.sql || "").toLowerCase();
    return needles.some((n) => n && sql.includes(n));
  });
  const qids = new Set(matchedQueries.map((q) => q.id));
  const dashMap = new Map<number, string>();
  for (const w of input.widgets) {
    if (w.query_id != null && qids.has(w.query_id)) {
      dashMap.set(w.dashboard_id, w.dashboard_name);
    }
  }
  return {
    queries: matchedQueries.map((q) => ({ id: q.id, name: q.name })),
    dashboards: [...dashMap.entries()].map(([id, name]) => ({ id, name })),
  };
}

export interface OverviewPipelineInput {
  id: number;
  name: string;
  description: string | null;
  sourceType: string;
  sourceName: string | null;
  destinationName: string | null;
  destinationDataset: string | null;
  tags: string[];
  schedule: string | null;
  scheduleEnabled: boolean;
  timezone: string;
  nextRun: number | null;
  lastSuccessfulUpdate: number | null;
  lastDurationSeconds: number | null;
  lastRows: number | null;
  lastRunStatus: string | null;
  lastFailedRunId: number | null;
  publishedVersionId: number | null;
  publishedVersionNumber: number | null;
  recentRuns: Array<{ id: number; status: string }>;
  running: boolean;
  queued: boolean;
  freshnessThresholdSeconds: number | null;
  checksFailed: boolean;
  now: number;
}

export interface OverviewPipeline {
  id: number;
  name: string;
  description: string | null;
  source: { type: string; name: string | null };
  destination: { name: string | null; dataset: string | null };
  execution_health: ExecutionHealth;
  freshness: FreshnessStatus;
  attention: AttentionBucket;
  recent_runs: Array<{ id: number; status: string }>;
  last_successful_update: number | null;
  schedule: string | null;
  timezone: string;
  next_run: number | null;
  duration_seconds: number | null;
  rows_loaded: number | null;
  published_version: { id: number; version_number: number } | null;
  tags: string[];
  last_failed_run_id: number | null;
}

export function buildOverviewEntry(p: OverviewPipelineInput): OverviewPipeline {
  const freshness = classifyFreshness({
    lastSuccessfulUpdate: p.lastSuccessfulUpdate,
    freshnessThresholdSeconds: p.freshnessThresholdSeconds,
    now: p.now,
  });
  const execution_health = classifyExecutionHealth({
    scheduleEnabled: p.scheduleEnabled,
    lastRunStatus: p.lastRunStatus,
    running: p.running,
    queued: p.queued,
  });
  const attention = classifyAttention({
    scheduleEnabled: p.scheduleEnabled,
    running: p.running,
    queued: p.queued,
    executionFailed: p.lastRunStatus === "failed" || execution_health === "failed",
    freshness,
    checksFailed: p.checksFailed,
    lastRunStatus: p.lastRunStatus,
  });
  return {
    id: p.id,
    name: p.name,
    description: p.description,
    source: { type: p.sourceType, name: p.sourceName },
    destination: { name: p.destinationName, dataset: p.destinationDataset },
    execution_health,
    freshness,
    attention,
    recent_runs: recentRunStrip(p.recentRuns),
    last_successful_update: p.lastSuccessfulUpdate,
    schedule: p.schedule,
    timezone: p.timezone,
    next_run: p.nextRun,
    duration_seconds: p.lastDurationSeconds,
    rows_loaded: p.lastRows,
    published_version:
      p.publishedVersionId != null && p.publishedVersionNumber != null
        ? { id: p.publishedVersionId, version_number: p.publishedVersionNumber }
        : null,
    tags: p.tags,
    last_failed_run_id: p.lastFailedRunId,
  };
}

export interface ValidationIssue {
  field: string;
  message: string;
}

export function validatePipelineConfig(input: {
  name: string;
  extract_strategy: ExtractStrategy;
  write_behavior: WriteBehavior;
  primary_key: string | null;
  cursor_field: string | null;
  destination_connection_id: number | null;
  schedule: string | null;
  quality_checks?: QualityCheck[];
}): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  if (!input.name.trim()) issues.push({ field: "name", message: "Name is required" });
  if (input.destination_connection_id == null) {
    issues.push({ field: "destination_connection_id", message: "Destination connection is required" });
  }
  if (input.write_behavior === "merge" && !input.primary_key) {
    issues.push({ field: "primary_key", message: "Merge write requires a primary key" });
  }
  if (input.extract_strategy === "incremental" && !input.cursor_field) {
    issues.push({ field: "cursor_field", message: "Incremental extraction requires a cursor field" });
  }
  for (const c of input.quality_checks ?? []) {
    if (
      (c.type === "unique" || c.type === "not_null" || c.type === "accepted_values") &&
      !c.column
    ) {
      issues.push({ field: "quality_checks", message: `${c.type} check needs a column` });
    }
    if (c.type === "accepted_values" && (!c.values || c.values.length === 0)) {
      issues.push({ field: "quality_checks", message: "accepted_values check needs a values list" });
    }
  }
  return issues;
}

export const FAILURE_ACTIONS = [
  "Retry",
  "Ask AI to investigate",
  "View logs",
  "Pause schedule",
] as const;

/** Build a SQLAlchemy URL from a decrypted connection record. */
export function buildSqlAlchemyUrl(conn: Record<string, unknown>): string {
  if (typeof conn.connection_url === "string" && conn.connection_url) {
    return conn.connection_url;
  }
  const dt = String(conn.type ?? "").toLowerCase();
  const database = conn.database ?? ":memory:";
  const user = encodeURIComponent(String(conn.user ?? ""));
  const password = encodeURIComponent(String(conn.password ?? ""));
  const host = conn.host ?? "localhost";
  const port = conn.port;
  if (dt === "sqlite") return `sqlite:///${database}`;
  if (dt === "duckdb") return `duckdb:///${database}`;
  if (dt === "postgres" || dt === "postgresql") {
    return `postgresql+psycopg2://${user}:${password}@${host}:${port ?? 5432}/${database}`;
  }
  if (dt === "mysql" || dt === "mariadb") {
    return `mysql+pymysql://${user}:${password}@${host}:${port ?? 3306}/${database}`;
  }
  if (dt === "mssql" || dt === "sqlserver") {
    return `mssql+pyodbc://${user}:${password}@${host}:${port ?? 1433}/${database}`;
  }
  return "";
}

/** Flatten captured pipeline output into row dicts for quality checks. */
export function flattenOutputRows(
  result: {
    rows?: unknown;
    output_tables?: unknown;
  } | null,
): Record<string, unknown>[] {
  if (!result) return [];
  const out: Record<string, unknown>[] = [];
  if (Array.isArray(result.rows)) {
    for (const r of result.rows) {
      if (r && typeof r === "object" && !Array.isArray(r)) {
        out.push(r as Record<string, unknown>);
      }
    }
  }
  if (out.length > 0) return out;
  if (!Array.isArray(result.output_tables)) return out;
  for (const t of result.output_tables) {
    if (!t || typeof t !== "object") continue;
    const rows = (t as { rows?: unknown }).rows;
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      if (r && typeof r === "object" && !Array.isArray(r)) {
        out.push(r as Record<string, unknown>);
      }
    }
  }
  return out;
}
