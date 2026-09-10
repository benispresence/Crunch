process.env.CRUNCH_PIPELINE_LOCAL_TEST = "1";
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import Database from "better-sqlite3";
import { installMinimalAppSchema } from "../src/db/pipelineSchema.ts";
import { payloadContainsSecretValues } from "../src/services/pipelineOps.ts";
import { isPidAlive } from "../src/services/pipelineProcess.ts";
import {
  cancelRun,
  dispatchQueued,
  enqueueBackfill,
  enqueueRun,
  getRun,
  listAttempts,
  prepareRuntimeSource,
  publishVersion,
  recoverQueue,
  retryRun,
  sealPipelineSourceConfig,
  setSchedulerConcurrency,
  shutdownRuns,
  waitForRun,
} from "../src/services/pipelineRuntime.ts";

function openDb(pythonCode: string, sourceConfig: Record<string, unknown> = { password: "super-secret-pass", host: "pg.internal" }) {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  installMinimalAppSchema(db);
  db.prepare(
    "INSERT INTO users (id, email, password_hash, role) VALUES (1, 't@t.test', 'x', 'admin')",
  ).run();
  db.prepare(
    "INSERT INTO connections (id, user_id, name, type, config_json) VALUES (1, 1, 'analytics', 'sqlite', ?)",
  ).run(JSON.stringify({ database: ":memory:" }));
  db.prepare(
    `INSERT INTO pipelines (
       id, user_id, name, source_type, source_config_json,
       destination_connection_id, destination_dataset, load_mode,
       python_code, code_mode, extract_strategy, write_behavior,
       scratch_destination_connection_id
     ) VALUES (1, 1, 'orders', 'custom', ?, 1, 'raw', 'replace', ?, 'custom', 'incremental', 'merge', 1)`,
  ).run(JSON.stringify(sourceConfig), pythonCode);
  db.prepare("UPDATE pipelines SET primary_key = 'id', cursor_field = 'updated_at' WHERE id = 1").run();
  publishVersion(db, 1, 1, "Initial fixture");
  return db;
}

describe("pipelineRuntime queue and versions", { concurrency: 1 }, () => {
  it("overlapping scheduled + manual + AI triggers enqueue instead of dropping", async () => {
    const db = openDb("def run():\n    return {'rows_loaded': 1}\n");
    setSchedulerConcurrency(1);
    const a = enqueueRun(db, { pipelineId: 1, userId: 1, trigger: "schedule" });
    const b = enqueueRun(db, { pipelineId: 1, userId: 1, trigger: "manual" });
    const c = enqueueRun(db, { pipelineId: 1, userId: 1, trigger: "agent" });
    const rows = db
      .prepare("SELECT id, triggered_by, status FROM pipeline_runs WHERE id IN (?, ?, ?)")
      .all(a.id, b.id, c.id) as Array<{ triggered_by: string; status: string }>;
    assert.equal(rows.length, 3);
    const triggers = new Set(rows.map((r) => r.triggered_by));
    assert.ok(triggers.has("schedule") && triggers.has("manual") && triggers.has("agent"));
    const queuedOrActive = rows.filter((r) =>
      ["queued", "running", "retrying"].includes(r.status),
    );
    assert.ok(queuedOrActive.length >= 1, "due work was dropped");
    await shutdownRuns(db);
    db.close();
  });

  it("queued work is still present after simulated restart", async () => {
    const db = openDb("def run():\n    import time\n    time.sleep(30)\n    return {'rows_loaded': 0}\n");
    setSchedulerConcurrency(1);
    enqueueRun(db, { pipelineId: 1, userId: 1, trigger: "schedule" });
    enqueueRun(db, { pipelineId: 1, userId: 1, trigger: "manual" });
    enqueueRun(db, { pipelineId: 1, userId: 1, trigger: "agent" });
    const before = db
      .prepare("SELECT id, status FROM pipeline_runs WHERE status IN ('queued','retrying')")
      .all() as Array<{ id: number; status: string }>;
    assert.ok(before.length >= 1, "need queued rows to recover");
    recoverQueue(db);
    for (const q of before) {
      const row = getRun(db, q.id);
      assert.ok(row, `run ${q.id} missing after restart`);
    }
    const after = db
      .prepare("SELECT COUNT(*) AS c FROM pipeline_runs WHERE status IN ('queued','retrying','running')")
      .get() as { c: number };
    assert.ok(after.c >= before.length, "queued work dropped on restart");
    await shutdownRuns(db);
    db.close();
  });

  it("publish snapshot has secret references and not secret values; retry original vs new version", async () => {
    const db = openDb("def run():\n    return {'rows_loaded': 1}\n");
    const pub1 = publishVersion(db, 1, 1, "v1");
    assert.equal(payloadContainsSecretValues(pub1.snapshot, ["super-secret-pass"]), false);
    assert.ok(JSON.stringify(pub1.snapshot.config).includes("$secret_ref"));
    const runN = enqueueRun(db, {
      pipelineId: 1,
      userId: 1,
      trigger: "manual",
      versionId: pub1.version_id,
    });
    const pub2 = publishVersion(db, 1, 1, "v2");
    await cancelRun(db, 1, Number(runN.id), 1);
    const retried = retryRun(db, 1, Number(runN.id), 1);
    // Original version (v1) is retried; a new run uses published v2.
    assert.equal(Number(retried.version_id), pub1.version_id);
    const fresh = enqueueRun(db, { pipelineId: 1, userId: 1, trigger: "manual" });
    assert.equal(Number(fresh.version_id), pub2.version_id);
    assert.notEqual(Number(fresh.version_id), Number(retried.version_id));
    assert.equal(retried.retry_kind, "run_new_version");
    await shutdownRuns(db);
    db.close();
  });

  it("cancel leaves the run cancelled and the child process gone", async () => {
    const db = openDb(
      "import time\ndef run():\n    time.sleep(60)\n    return {\"rows_loaded\": 0}\n",
    );
    publishVersion(db, 1, 1, "sleep");
    setSchedulerConcurrency(4);
    const run = enqueueRun(db, { pipelineId: 1, userId: 1, trigger: "manual" });
    const runId = Number(run.id);
    const deadline = Date.now() + 15_000;
    let pid: number | null = null;
    while (Date.now() < deadline) {
      const row = getRun(db, runId)!;
      if (row.pid) {
        pid = Number(row.pid);
        break;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.ok(pid, "child process never started");
    const result = await cancelRun(db, 1, runId, 1);
    const killDeadline = Date.now() + 5000;
    while (pid && isPidAlive(pid) && Date.now() < killDeadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    assert.equal(result.status, "cancelled");
    assert.equal(isPidAlive(pid!), false, `pid ${pid} still alive`);
    const finished = await waitForRun(db, runId, 10_000).catch(() => getRun(db, runId)!);
    assert.equal(String(finished.status), "cancelled");
    await shutdownRuns(db);
    db.close();
  });

  it("two attempts of a transient failure are both stored with logs", async () => {
    const db = openDb(
      "def run():\n    raise RuntimeError('HTTP 429 Too Many Requests')\n",
    );
    publishVersion(db, 1, 1, "429");
    setSchedulerConcurrency(4);
    const run = enqueueRun(db, { pipelineId: 1, userId: 1, trigger: "manual" });
    const runId = Number(run.id);
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const attempts = listAttempts(db, runId);
      const row = getRun(db, runId)!;
      if (attempts.length >= 1 && String(row.status) !== "running") break;
      await new Promise((r) => setTimeout(r, 50));
    }
    // Accelerate backoff so the shipped dispatcher starts attempt 2.
    db.prepare("UPDATE pipeline_runs SET next_retry_at = 0, status = 'queued' WHERE id = ?").run(runId);
    await dispatchQueued(db);
    const deadline2 = Date.now() + 15_000;
    while (Date.now() < deadline2) {
      const rows = listAttempts(db, runId) as Array<{
        finished_at: number | null;
        log: string;
        error_message: string | null;
      }>;
      const done = rows.filter((a) => a.finished_at != null);
      if (done.length >= 2) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const attempts = listAttempts(db, runId) as Array<{
      attempt_number: number;
      finished_at: number | null;
      log: string;
      error_message: string | null;
    }>;
    const finished = attempts.filter((a) => a.finished_at != null);
    assert.ok(finished.length >= 2, `expected 2 finished attempts, got ${JSON.stringify(attempts)}`);
    for (const a of finished) {
      const text = `${a.log ?? ""}\n${a.error_message ?? ""}`;
      assert.ok(/429/.test(text), `attempt ${a.attempt_number} missing 429: ${text}`);
    }
    await shutdownRuns(db);
    db.close();
  });

  it("backfill records the processing interval and surfaces overwrite/duplicate implications", async () => {
    const db = openDb("def run():\n    return {'rows_loaded': 1}\n");
    db.prepare("UPDATE pipelines SET source_type = 'sql', python_code = ? WHERE id = 1").run("def run():\n    return {'rows_loaded': int(ctx.in_interval({'updated_at': 1500}, 'updated_at'))}\n");
    publishVersion(db, 1, 1, "bf");
    const preview = enqueueBackfill(db, 1, 1, 1_000, 2_000, false) as {
      needs_confirm?: boolean;
      warning?: string;
      processing_interval_start?: number;
      overwrite_duplicate_implications?: string;
    };
    assert.equal(preview.needs_confirm, true);
    assert.equal(preview.processing_interval_start, 1_000);
    assert.match(String(preview.overwrite_duplicate_implications), /overwrite|duplicate/i);
    assert.match(String(preview.warning), /Confirm/i);
    const run = enqueueBackfill(db, 1, 1, 1_000, 2_000, true) as Record<string, unknown>;
    assert.equal(run.triggered_by, "backfill");
    assert.equal(Number(run.processing_interval_start), 1_000);
    assert.equal(Number(run.processing_interval_end), 2_000);
    assert.ok(String(run.backfill_warning || "").length > 0);
    await shutdownRuns(db);
    db.close();
  });

  it("resolves source secrets from the vault and saved connection into the child job", async () => {
    const secret = "runtime-secret-xyz";
    const db = openDb("def run():\n    return {'rows_loaded': 1}\n");
    const sealed = sealPipelineSourceConfig({
      host: "pg.internal",
      password: secret,
      auth_header: "Bearer runtime-secret-xyz",
    });
    assert.equal(payloadContainsSecretValues(sealed.sanitized, [secret]), false);
    db.prepare(
      "UPDATE pipelines SET source_config_json = ?, source_secrets_json = ?, python_code = ? WHERE id = 1",
    ).run(
      JSON.stringify(sealed.sanitized),
      sealed.sealed,
      "def run():\n"
        + "    cfg = ctx.source_config or {}\n"
        + "    assert cfg.get('password') == 'runtime-secret-xyz', repr(cfg)\n"
        + "    assert cfg.get('auth_header') == 'Bearer runtime-secret-xyz', repr(cfg)\n"
        + "    return {'rows_loaded': 1}\n",
    );
    const prepared = prepareRuntimeSource(db, db.prepare("SELECT * FROM pipelines WHERE id = 1").get() as Record<string, unknown>, null, 1);
    assert.equal(prepared.sourceConfig.password, secret);
    assert.equal(payloadContainsSecretValues(
      db.prepare("SELECT source_config_json FROM pipelines WHERE id = 1").get() as { source_config_json: string },
      [secret],
    ), false);

    db.prepare(
      "INSERT INTO connections (id, user_id, name, type, config_json) VALUES (2, 1, 'prod', 'sqlite', ?)",
    ).run(JSON.stringify({ database: ":memory:", password: "from-saved-connection" }));
    db.prepare("UPDATE pipelines SET source_connection_id = 2 WHERE id = 1").run();
    const fromConn = prepareRuntimeSource(
      db,
      db.prepare("SELECT * FROM pipelines WHERE id = 1").get() as Record<string, unknown>,
      null,
      1,
    );
    assert.equal(fromConn.sourceConnection?.password, "from-saved-connection");
    assert.ok(fromConn.sourceConnection);
    assert.match(String(fromConn.sourceConfig.connection_url || ""), /sqlite/);

    db.prepare("UPDATE pipelines SET python_code = ? WHERE id = 1").run(
      "def run():\n"
        + "    cfg = ctx.source_config or {}\n"
        + "    assert cfg.get('password') in ('runtime-secret-xyz', 'from-saved-connection'), repr(cfg)\n"
        + "    assert ctx.source_engine is not None, 'source_engine was not injected'\n"
        + "    return {'rows_loaded': 1}\n",
    );
    publishVersion(db, 1, 1, "secrets");
    setSchedulerConcurrency(4);
    const run = enqueueRun(db, { pipelineId: 1, userId: 1, trigger: "manual" });
    const finished = await waitForRun(db, Number(run.id), 30_000);
    assert.equal(String(finished.status), "success", String(finished.error_message || finished.log));
    await shutdownRuns(db);
    db.close();
  });

  it("stores unique and not_null check failures on the run", async () => {
    const db = openDb(
      "def run():\n"
        + "    return {\n"
        + "        'rows_loaded': 2,\n"
        + "        'rows': [\n"
        + "            {'order_id': 1, 'status': 'open'},\n"
        + "            {'order_id': 1, 'status': None},\n"
        + "        ],\n"
        + "    }\n",
    );
    db.prepare("UPDATE pipelines SET quality_checks_json = ? WHERE id = 1").run(
      JSON.stringify([
        { type: "unique", column: "order_id" },
        { type: "not_null", column: "status" },
      ]),
    );
    publishVersion(db, 1, 1, "checks");
    setSchedulerConcurrency(4);
    const run = enqueueRun(db, { pipelineId: 1, userId: 1, trigger: "manual" });
    const finished = await waitForRun(db, Number(run.id), 30_000);
    assert.equal(String(finished.status), "success", String(finished.error_message || finished.log));
    const checks = JSON.parse(String(finished.check_results_json || "[]")) as Array<{
      type: string;
      passed: boolean;
      message: string;
    }>;
    const unique = checks.find((c) => c.type === "unique");
    const required = checks.find((c) => c.type === "not_null");
    assert.ok(unique, JSON.stringify(checks));
    assert.equal(unique!.passed, false, unique!.message);
    assert.ok(required, JSON.stringify(checks));
    assert.equal(required!.passed, false, required!.message);
    await shutdownRuns(db);
    db.close();
  });
});

describe("v1.2 regression outcomes", {concurrency: 1}, () => {
  it("published checks and limits survive draft edits and same-pipeline runs serialize", async () => {
    const db = openDb("def run():\n    import time\n    time.sleep(.2)\n    return {'rows_loaded': ctx.stream_max_messages}\n");
    db.prepare("UPDATE pipelines SET stream_max_messages = 20000, quality_checks_json = ? WHERE id=1").run(JSON.stringify([{type: "row_count", max_relative_change: 0}]));
    publishVersion(db, 1, 1);
    db.prepare("UPDATE pipelines SET stream_max_messages = 1, quality_checks_json = '[]' WHERE id=1").run();
    setSchedulerConcurrency(4);
    const a = enqueueRun(db, {pipelineId: 1, userId: 1, trigger: "manual"});
    const b = enqueueRun(db, {pipelineId: 1, userId: 1, trigger: "manual"});
    assert.equal(getRun(db, Number(b.id))?.status, "queued");
    const first = await waitForRun(db, Number(a.id));
    const second = await waitForRun(db, Number(b.id));
    assert.equal(first.rows_loaded, 20000);
    assert.equal(second.rows_loaded, 20000);
    assert.equal(JSON.parse(String(second.check_results_json))[0].passed, true);
    await shutdownRuns(db); db.close();
  });
  it("scratch test cannot target production and cannot update production freshness", async () => {
    const db = openDb("def run():\n    return {'rows_loaded': 5}\n");
    assert.throws(() => enqueueRun(db, {pipelineId:1,userId:1,trigger:"test",isTest:true}), /separate scratch/);
    db.prepare("INSERT INTO connections(id,user_id,name,type,config_json) VALUES (2,1,'scratch','sqlite',?)").run(JSON.stringify({database:"/private/tmp/crunch-scratch-regression.sqlite"}));
    db.prepare("UPDATE pipelines SET scratch_destination_connection_id=2,scratch_destination_dataset='test_data' WHERE id=1").run();
    const run = enqueueRun(db, {pipelineId:1,userId:1,trigger:"test",isTest:true});
    const done = await waitForRun(db, Number(run.id));
    assert.equal(done.status,"success");
    assert.equal((db.prepare("SELECT last_successful_update FROM pipelines WHERE id=1").get() as {last_successful_update:unknown}).last_successful_update,null);
    await shutdownRuns(db); db.close();
  });
  it("backfills unsupported scripts are rejected and publish is explicit", async () => {
    const db = openDb("def run():\n    return 0\n");
    assert.throws(() => enqueueBackfill(db,1,1,100,200,true), /interval support/);
    db.prepare("UPDATE pipelines SET published_version_id=NULL WHERE id=1").run();
    assert.throws(() => enqueueRun(db,{pipelineId:1,userId:1,trigger:"manual"}), /Publish/);
    await shutdownRuns(db); db.close();
  });
});

describe("version restore and schedule isolation", {concurrency: 1}, () => {
  it("restores source connection and explicit nulls without changing the published version", async () => {
    const {restoreVersionAsDraft} = await import("../src/services/pipelineRuntime.ts");
    const db = openDb("def run():\n    return 0\n");
    db.prepare("UPDATE pipelines SET source_connection_id=1, primary_key=NULL, cursor_field=NULL, destination_dataset=NULL, extract_strategy='full', write_behavior='append' WHERE id=1").run();
    const original = publishVersion(db,1,1);
    db.prepare("UPDATE pipelines SET source_connection_id=NULL, primary_key='id', cursor_field='time', destination_dataset='changed' WHERE id=1").run();
    const latest = publishVersion(db,1,1);
    const draft = restoreVersionAsDraft(db,1,1,original.version_id);
    assert.equal(draft.source_connection_id,1);
    assert.equal(draft.primary_key,null);
    assert.equal(draft.cursor_field,null);
    assert.equal(draft.destination_dataset,null);
    assert.equal(draft.published_version_id,latest.version_id);
    db.close();
  });
  it("uses published cron even when the draft removes its schedule", async () => {
    const {enqueueDueSchedules} = await import("../src/services/pipelineRuntime.ts");
    const db = openDb("def run():\n    return 0\n");
    db.prepare("UPDATE pipelines SET schedule='* * * * *', schedule_enabled=1 WHERE id=1").run();
    const version = publishVersion(db,1,1);
    db.prepare("UPDATE pipelines SET schedule=NULL WHERE id=1").run();
    db.prepare("INSERT INTO settings(key,value) VALUES ('pipeline_scheduler_tick',?)").run(String(Math.floor(Date.now()/1000)-90));
    assert.equal(enqueueDueSchedules(db),1);
    assert.equal(enqueueDueSchedules(db),0);
    const run=db.prepare("SELECT version_id FROM pipeline_runs WHERE pipeline_id=1").get() as {version_id:number};
    assert.equal(run.version_id,version.version_id);
    await shutdownRuns(db); db.close();
  });
});

describe("legacy pipeline upgrade", () => {
  it("preserves incremental append behavior instead of defaulting to replace", async () => {
    const {upgradePipelineTables} = await import("../src/db/pipelineSchema.ts");
    const db = openDb("def run():\n    return 0\n");
    db.prepare("UPDATE pipelines SET load_mode='incremental' WHERE id=1").run();
    db.exec("ALTER TABLE pipelines DROP COLUMN extract_strategy");
    db.exec("ALTER TABLE pipelines DROP COLUMN write_behavior");
    upgradePipelineTables(db);
    const row = db.prepare("SELECT extract_strategy,write_behavior FROM pipelines WHERE id=1").get();
    assert.deepEqual(row, {extract_strategy: 'incremental', write_behavior: 'append'});
    db.close();
  });
});
