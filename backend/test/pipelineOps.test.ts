import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  admitRun,
  buildBackfillPlan,
  buildOverviewCounts,
  buildOverviewEntry,
  buildVersionSnapshot,
  canResumeFromFailedStep,
  classifyAttention,
  classifyFreshness,
  classifyRetryKind,
  computeRetryBackoffMs,
  detectLineage,
  evaluateQualityChecks,
  explainFailure,
  extractAndReplaceSecrets,
  flattenOutputRows,
  isTransientFailure,
  normalizeLoadBehavior,
  payloadContainsSecretValues,
  payloadHasSecretRefs,
  recoverRunsOnRestart,
  resolveSecretReferences,
  shouldRetry,
  stripSecretsFromConfig,
  validatePipelineConfig,
} from "../src/services/pipelineOps.ts";

describe("pipelineOps", () => {
  it("never drops due work when slots are full", () => {
    assert.equal(admitRun({ inFlightCount: 4, maxConcurrent: 4 }), "enqueue");
    assert.equal(admitRun({ inFlightCount: 0, maxConcurrent: 4 }), "start");
  });

  it("combines incremental extraction with merge write", () => {
    const both = normalizeLoadBehavior({
      extract_strategy: "incremental",
      write_behavior: "merge",
    });
    assert.equal(both.extract_strategy, "incremental");
    assert.equal(both.write_behavior, "merge");
    const fromLegacyInc = normalizeLoadBehavior({ load_mode: "incremental" });
    assert.equal(fromLegacyInc.extract_strategy, "incremental");
    assert.equal(fromLegacyInc.write_behavior, "append");
  });

  it("strips secret values and keeps references", () => {
    const { sanitized, refs } = stripSecretsFromConfig({
      host: "db.example",
      password: "hunter2-secret",
      auth_header: "Bearer super-secret-token",
      nested: { api_key: "sk_live_abc" },
    });
    const blob = JSON.stringify(sanitized);
    assert.equal(payloadContainsSecretValues(sanitized, ["hunter2-secret", "super-secret-token", "sk_live_abc"]), false);
    assert.ok(payloadHasSecretRefs(sanitized));
    assert.ok(refs.includes("password"));
    assert.ok(!blob.includes("hunter2"));
    const resolved = resolveSecretReferences(sanitized, (ref) => {
      if (ref === "password") return "hunter2-secret";
      return "x";
    });
    assert.equal((resolved as { password: string }).password, "hunter2-secret");
  });

  it("extracts secret values into a vault map that resolveSecretReferences can replay", () => {
    const incoming = {
      host: "db.example",
      password: "vault-password",
      auth_header: "Bearer vault-token",
    };
    const { sanitized, secrets } = extractAndReplaceSecrets(incoming);
    assert.equal(secrets.password, "vault-password");
    assert.equal(secrets.auth_header, "Bearer vault-token");
    assert.equal(payloadContainsSecretValues(sanitized, ["vault-password", "vault-token"]), false);
    const resolved = resolveSecretReferences(sanitized, (ref) => secrets[ref]) as {
      password: string;
      auth_header: string;
      host: string;
    };
    assert.equal(resolved.password, "vault-password");
    assert.equal(resolved.auth_header, "Bearer vault-token");
    assert.equal(resolved.host, "db.example");
  });

  it("flattens captured output rows from run() results", () => {
    const rows = flattenOutputRows({
      rows: [{ order_id: 1 }, { order_id: 1, status: null }],
    });
    assert.equal(rows.length, 2);
    assert.equal(rows[0]?.order_id, 1);
    const fromTables = flattenOutputRows({
      output_tables: [{ name: "orders", rows: [{ order_id: 2 }] }],
    });
    assert.equal(fromTables[0]?.order_id, 2);
  });

  it("version snapshot never contains secret values", () => {
    const snap = buildVersionSnapshot({
      python_code: "def run(): return {'rows_loaded': 1}",
      config: {
        source_config: { password: "s3cret-value", host: "pg" },
        destination_connection_id: 3,
      },
      schedule: "0 * * * *",
      timezone: "Europe/Berlin",
      extract_strategy: "incremental",
      write_behavior: "merge",
      quality_checks: [{ type: "unique", column: "id" }],
    });
    assert.equal(payloadContainsSecretValues(snap, ["s3cret-value"]), false);
    assert.ok(payloadHasSecretRefs(snap.config));
    assert.equal(snap.extract_strategy, "incremental");
    assert.equal(snap.write_behavior, "merge");
    assert.equal(snap.timezone, "Europe/Berlin");
  });

  it("splits execution health from freshness: success can still be stale", () => {
    const now = 1_700_000_000;
    const freshness = classifyFreshness({
      lastSuccessfulUpdate: now - 7200,
      freshnessThresholdSeconds: 3600,
      now,
    });
    assert.equal(freshness, "stale");
    const entry = buildOverviewEntry({
      id: 1,
      name: "orders",
      description: null,
      sourceType: "sql",
      sourceName: "prod",
      destinationName: "analytics",
      destinationDataset: "raw",
      tags: ["orders"],
      schedule: "0 * * * *",
      scheduleEnabled: true,
      timezone: "Europe/Berlin",
      nextRun: now + 600,
      lastSuccessfulUpdate: now - 7200,
      lastDurationSeconds: 12,
      lastRows: 100,
      lastRunStatus: "success",
      lastFailedRunId: null,
      publishedVersionId: 9,
      publishedVersionNumber: 2,
      recentRuns: [{ id: 4, status: "success" }],
      running: false,
      queued: false,
      freshnessThresholdSeconds: 3600,
      checksFailed: false,
      now,
    });
    assert.equal(entry.execution_health, "healthy");
    assert.equal(entry.freshness, "stale");
    assert.equal(entry.attention, "needs_attention");
    assert.equal(entry.timezone, "Europe/Berlin");
    assert.equal(entry.published_version?.version_number, 2);
    const counts = buildOverviewCounts([entry.attention]);
    assert.equal(counts.needs_attention, 1);
    assert.equal(counts.healthy, 0);
  });

  it("evaluates unique, required, accepted values, freshness, and row-count checks", () => {
    const now = 1_700_000_000;
    const good = evaluateQualityChecks({
      rows: [
        { order_id: 1, status: "open", updated_at: now - 10 },
        { order_id: 2, status: "closed", updated_at: now - 20 },
      ],
      checks: [
        { type: "unique", column: "order_id" },
        { type: "not_null", column: "order_id" },
        { type: "accepted_values", column: "status", values: ["open", "closed"] },
        { type: "freshness", column: "updated_at", max_age_seconds: 60 },
        { type: "row_count", max_relative_change: 0.5 },
      ],
      previousRowCount: 2,
      now,
    });
    assert.ok(good.every((c) => c.passed), JSON.stringify(good));

    const bad = evaluateQualityChecks({
      rows: [
        { order_id: 1, status: "weird", updated_at: now - 10_000 },
        { order_id: 1, status: null, updated_at: now - 10_000 },
      ],
      checks: [
        { type: "unique", column: "order_id" },
        { type: "not_null", column: "status" },
        { type: "accepted_values", column: "status", values: ["open", "closed"] },
        { type: "freshness", column: "updated_at", max_age_seconds: 60 },
        { type: "row_count", max_relative_change: 0.1 },
      ],
      previousRowCount: 20,
      now,
    });
    assert.equal(bad.find((c) => c.type === "unique")?.passed, false);
    assert.equal(bad.find((c) => c.type === "not_null")?.passed, false);
    assert.equal(bad.find((c) => c.type === "accepted_values")?.passed, false);
    assert.equal(bad.find((c) => c.type === "freshness")?.passed, false);
    assert.equal(bad.find((c) => c.type === "row_count")?.passed, false);
  });

  it("records processing interval and overwrite/duplicate implications for backfills", () => {
    const plan = buildBackfillPlan({
      intervalStart: 1000,
      intervalEnd: 2000,
      writeBehavior: "append",
    });
    assert.equal(plan.processing_interval_start, 1000);
    assert.equal(plan.processing_interval_end, 2000);
    assert.match(plan.overwrite_duplicate_implications, /duplicates/i);
    assert.match(plan.warning, /Confirm/i);
    const merge = buildBackfillPlan({
      intervalStart: 1000,
      intervalEnd: 2000,
      writeBehavior: "merge",
    });
    assert.match(merge.overwrite_duplicate_implications, /overwrite/i);
  });

  it("retries transient failures with bounded backoff and preserves attempt semantics", () => {
    assert.equal(isTransientFailure("HTTP 429 Too Many Requests"), true);
    assert.equal(isTransientFailure("unique constraint violated"), false);
    assert.equal(shouldRetry({ attemptNumber: 1, maxAttempts: 3, error: "429" }), true);
    assert.equal(shouldRetry({ attemptNumber: 3, maxAttempts: 3, error: "429" }), false);
    assert.ok(computeRetryBackoffMs(2) > computeRetryBackoffMs(1));
    assert.equal(classifyRetryKind({ retryVersionId: 4, publishedVersionId: 4 }), "retry_original");
    assert.equal(classifyRetryKind({ retryVersionId: 4, publishedVersionId: 5 }), "run_new_version");
  });

  it("only offers resume from failed step when checkpoints exist", () => {
    assert.equal(canResumeFromFailedStep([]), false);
    assert.equal(canResumeFromFailedStep([{ status: "failed" }]), false);
    assert.equal(
      canResumeFromFailedStep([{ status: "success", checkpoint: { cursor: "2020-01-01" } }]),
      true,
    );
  });

  it("explains failures with log evidence and likely vs confirmed", () => {
    const exp = explainFailure({
      error: "HTTP 429",
      log: "GET /orders failed with 429 Too Many Requests\nretry later",
      lastSuccessfulUpdate: 1_700_000_000,
      pipelineName: "Orders refresh",
    });
    assert.match(exp.headline, /failed during/);
    assert.match(exp.explanation, /429/);
    assert.equal(exp.confidence, "confirmed");
    assert.ok(exp.evidence.some((e) => /429/.test(e.line)));
    assert.deepEqual(exp.actions, ["Retry", "Ask AI to investigate", "View logs", "Pause schedule"]);
  });

  it("recovers queued work across restart and requeues dead running pids", () => {
    const recovered = recoverRunsOnRestart(
      [
        { id: 1, status: "queued", pid: null },
        { id: 2, status: "running", pid: 99999999 },
        { id: 3, status: "running", pid: process.pid },
      ],
      (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
    );
    const q = recovered.find((r) => r.id === 1);
    assert.equal(q?.nextStatus, "queued");
    const dead = recovered.find((r) => r.id === 2);
    assert.equal(dead?.requeue, true);
    const live = recovered.find((r) => r.id === 3);
    assert.equal(live?.nextStatus, "running");
  });

  it("validates merge/incremental requirements", () => {
    const issues = validatePipelineConfig({
      name: "x",
      extract_strategy: "incremental",
      write_behavior: "merge",
      primary_key: null,
      cursor_field: null,
      destination_connection_id: null,
      schedule: null,
    });
    assert.ok(issues.some((i) => i.field === "primary_key"));
    assert.ok(issues.some((i) => i.field === "cursor_field"));
    assert.ok(issues.some((i) => i.field === "destination_connection_id"));
  });

  it("detects dashboards fed by a pipeline dataset", () => {
    const lin = detectLineage({
      destinationDataset: "raw",
      destinationTable: "orders",
      queries: [
        { id: 1, name: "Orders", sql: "select * from raw.orders" },
        { id: 2, name: "Other", sql: "select 1" },
      ],
      widgets: [
        { dashboard_id: 9, dashboard_name: "Sales", query_id: 1 },
      ],
    });
    assert.equal(lin.queries[0]?.name, "Orders");
    assert.equal(lin.dashboards[0]?.name, "Sales");
  });
});
