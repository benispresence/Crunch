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
The manual form remains available. Run details refresh automatically, expose
cancellation, and show attempts and check results. Versions include readable
configuration differences and a Monaco code diff.

Validation commands:

- `cd backend && npm test`
- `npm run typecheck --prefix backend`
- `npm run typecheck --prefix frontend`
- `venv/bin/python -m unittest tests.test_pipeline_release`
- `npm run build --prefix backend`
- `npm run build --prefix frontend`
