# Pipeline operations in v1.2.0

Pipelines have saved drafts and immutable published versions. Publishing validates
configuration and database connectivity. Scheduled and manual production runs use
the published version; testing uses a snapshot of the draft. Restore copies a
version's configuration into a new draft without changing the published version.

The Python engine owns authenticated, killable subprocess jobs. Express stores
opaque job IDs and reconciles jobs after an API restart. If engine ownership is
lost, execution is reported as interrupted; inspect destination writes before
retrying. Jobs are never blindly replayed after a crash. Docker persists job
results and incremental state in the `crunch-pipeline-jobs` volume.

Each pipeline executes at most one run at a time. All triggers share the same
queue and global concurrency limit. Missed schedule windows are coalesced into
one run after downtime. Cron previews use the published timezone and schedule.

Draft tests require a separate connection targeting a different database and an
explicit scratch dataset. Use credentials restricted to scratch data. Custom
Python must use the supplied context for destinations; arbitrary hardcoded writes
cannot be redirected automatically. Test outcomes do not update production health,
freshness, or row-count baselines.

Generated SQL pipelines with a cursor support half-open backfill intervals
(start inclusive, end exclusive). Unsupported scripts are rejected. Backfill
replays may overwrite data with merge/replace or duplicate data with append;
the UI presents the write implications before submitting. Retries preserve the
original snapshot, test designation, and interval.

Generated pipelines evaluate column quality checks using destination aggregates.
Unavailable checks are reported as **Not evaluated**, rather than passed or failed.
Execution success and check outcomes are separate. Row-count checks compare actual
numeric counts, including loads larger than 10,000 rows.

The creation prompt submits a request to the chat assistant, which inspects
connections and proposes an editable draft. A configured AI provider is required.
Pending AI proposals can be edited before acceptance. The manual form remains available. Run details refresh automatically, expose
cancellation, and show attempts and check results. Versions include readable
configuration differences and a Monaco code diff.

Validation commands:

- `cd backend && npm test`
- `npm run typecheck --prefix backend`
- `npm run typecheck --prefix frontend`
- `venv/bin/python -m unittest tests.test_pipeline_release`
- `npm run build --prefix backend`
- `npm run build --prefix frontend`

## Release validation

The browser harness (`backend/scripts/pipeline-browser.mjs`) exercises publish,
production and scratch runs, live refresh, cancel, code diff, and AI proposal
acceptance. Its assistant response is a deterministic SSE fixture; it does not
measure a live model's reasoning. The API and proposal persistence are real.

`backend/scripts/pipeline-restart.mjs` kills/restarts Express during a job and
asserts exactly one destination write. `pipeline-container.mjs` submits a job
through the backend Docker image to a separate Python engine container.

Set `PLAYWRIGHT_MODULE` and `PLAYWRIGHT_EXECUTABLE` to installed Playwright and
Chromium paths, and `API_BASE` / `FRONTEND_URL` for isolated test instances.
Only use these harnesses against disposable databases.

Validated for this release: 29 backend regression tests, four Python engine/load
regressions, frontend and backend production builds, a cross-container DuckDB
write, a real API crash/restart with exactly one destination write, and Chromium
publish/test/cancel/diff/proposal flows. Browser checks also cover failed-save
publication blocking and custom-script edits that omit `code_mode`.

The frontend build retains its existing large-chunk warning for Monaco/Plotly.
A native desktop installer and live AI provider generation were not exercised;
desktop resources were updated, and assistant UI behavior used a deterministic
response fixture.
