# Branch audit — claude/add-query-filters-txNZP

A self-review of the six features delivered on this branch (Metabase-style
filters, version history, expanded data sources, file scanner, SSO/auth,
pipelines). Audit happened in one pass after the features landed. Critical
findings were fixed in-line; structural reworks documented at the bottom.

## Critical fixes applied (commit immediately following audit)

1. **Pipeline sandbox now uses an import allowlist.**
   `src/nicemeta/pipelines/__init__.py` previously exposed the real
   `__import__` and only blocked a handful of identifiers via regex —
   trivially bypassable. Replaced with a controlled `__import__` that
   checks every import against a default allowlist (dlt, requests,
   sqlalchemy, kafka, …), augmented with the admin-curated whitelist
   from Admin → Packages. Adversarial imports (`import socket`,
   `__import__("sub" + "process")`) are now refused.

2. **Pipeline wall-clock timeout enforced.** SIGALRM in
   `execute_pipeline` plus `asyncio.wait_for(timeout_seconds + 30)` in
   the engine route. A stuck Kafka subscriber or infinite REST paging
   loop can no longer hold a scheduler slot indefinitely.

3. **OIDC verifies JWT signatures.** Previously decoded id_tokens
   without any check (with a comment admitting it). Now uses `jose`'s
   `jwtVerify` against the IdP's JWKS, with issuer + audience checks.
   Sign-in aborts on bad signature; IdPs that don't advertise a JWKS
   degrade to userinfo-only (and refuse the id_token).

4. **SQL injection in introspection closed.** `postgresql.py`,
   `mysql.py`, and `sqla_warehouse.py` interpolated schema/table names
   directly into `information_schema` queries. Switched to bind
   parameters everywhere. The picker can no longer be turned into a
   SQL-injection vector even when a user has limited query privileges.

5. **MongoDB rejects server-side-JS operators.** `$where`,
   `$function`, `$accumulator` and `$expr.$function` are blocked at
   parse time. A pipeline body can no longer execute arbitrary JS on
   the MongoDB server.

6. **File source containment.** New `NICEMETA_FILE_SOURCE_ROOT` env
   var (and `config.fileSourceRoot`). When set, the `FileAdapter` and
   the folder scanner refuse any local path that resolves outside the
   configured root — closes the "point at /etc/passwd as CSV" hole.
   Cloud URIs (s3://, gs://, https://) are unaffected.

7. **Public callback URL is explicit.** Both OIDC and SAML callback
   URL builders now honour `NICEMETA_PUBLIC_BASE_URL` for deployments
   behind path-rewriting proxies. The dangling `(TODO)` comment is
   resolved.

## Modularity fix applied

8. **`chatTools.ts` split into per-domain modules.** The 915-line file
   became a 60-line aggregator (`services/chatTools.ts`) over five
   per-domain bundles (`chatTools/{data,queries,dashboards,
   pipelines,navigate}.ts`). Each module exports `{tools, handlers}`;
   the aggregator merges them and detects accidental name collisions
   at load time. Adding a new tool = new file + push to `MODULES`.

## Code-quality cleanups applied

9. **Dead column removed.** `pipelines.last_scheduled_check` was
   declared in the schema and the TS row type, but never written.
   Dropped both.

## What I'd do differently — bigger reworks

These are correct but larger than this audit can absorb. Tagged with
the issue I'd file.

### Rework 1 — Two sandboxes, not one with two configs

Pipelines and visualisations have fundamentally different risk
profiles:

* Viz: pure transform, no network, small allowlist (pandas / plotly /
  numpy). Static validator blocks `os` / `requests` because viz code
  *shouldn't* need them.
* Pipeline: outbound network is the point; many libraries needed; the
  blast radius is whatever the destination connection can do.

Running both through `CodeExecutor` + an allowlist works but the
codebase pretends they're the same. I'd split into
`viz_sandbox.py` and `pipeline_sandbox.py`, each with its own
allowlist + validator + builtins. The pipeline sandbox should
eventually run in a subprocess with ulimits — that's the only honest
sandbox for code that wants `requests`.

### Rework 2 — Pipeline scheduler should be a job queue

The current `setInterval` ticker in `services/pipelines.ts` is fine
for one Express instance. It falls over the moment you scale out
(two instances would double-fire schedules) or restart mid-run (the
in-memory `inFlight` set is lost — the run row stays `running` forever).

Right shape: a `pipeline_jobs` table with `claimed_by`, `claimed_at`,
`heartbeat_at` columns. Workers `UPDATE jobs SET claimed_by=:me WHERE
status='pending' LIMIT 1 RETURNING …` to claim atomically; a sweeper
returns claims abandoned for > N seconds. That's also the natural
place to express max-concurrency *per user*, not just per instance.

### Rework 3 — Schema migrations

`backend/src/db/index.ts` accumulates `ensureColumn` calls. Every
feature adds a few; nothing is reversible; the order matters. Alembic
is already in `pyproject.toml` but unused on the TS side. A simple
`migrations/NNNN_*.sql` directory + a `schema_migrations(version)`
table + a boot-time runner that applies missing files in order would
be enough. Time to pay this back is when the next breaking change
shows up (we got lucky so far — every change has been additive).

### Rework 4 — Proposal kinds as a registry

The "propose X" feature now has nine kinds. Each one touches:

* `chatTools/{domain}.ts` — tool definition + handler
* `stores/chat.ts` — accept handler dispatch + the union type
* `components/ProposalCard.vue` — the render `v-if` block

That's three files per kind, easy to forget one. A registry would
have one file per kind exporting `{toolDef, handler, AcceptApplicator,
RenderComponent}`, and the three places above each import from the
registry. Adding kind ten becomes one new file.

### Rework 5 — Provider interface

OIDC, SAML, and LDAP each have their own service file with their own
`startLogin` / `handleCallback` shape. They share the same end —
`upsertSsoUser` + `signToken`. I'd extract an `AuthProvider`
interface so a new provider is a single class implementing
`signIn(req, res) → {ok, token} | {ok: false, error}`.

### Rework 6 — Don't regen the template under the user's cursor

`PipelineDetailView.vue` regenerates the Python script with a 400ms
debounce whenever any form field changes. If the user is mid-keystroke
in the editor when the regen fires, their typing is replaced. Better:
a manual "Sync from form" button (matches the existing "Sync from
picker" pattern in the viz editor), or only regen when
`code_mode === 'template'` AND the editor is unfocused.

### Rework 7 — Standardise tool error returns

Some handlers `return { error }`, some `{success: false, error}`, some
throw. The chat route and the SDK both have to parse all three. Pick
one — `{success: false, error: string}` is the most informative — and
enforce via a wrapper.

### Rework 8 — Frontend store actions are too thick

`chat.ts:acceptProposal` is now a 100+ line switch that calls APIs,
refreshes stores, navigates routers, opens queries. The dispatch
should live with the proposal definition (see rework 4) and the store
should call a single `apply(proposal)`.

### Rework 9 — `AdminView.vue` is doing six jobs

1139 lines covering Settings / Packages / Users / Auth / Pipelines /
Git. AuthSettings + PipelineSettings are already extracted. The
remaining four should follow: AdminView becomes the tab shell, each
tab a thin component.

### Rework 10 — `Pipeline` Python file is three concerns

`src/nicemeta/pipelines/__init__.py` (~700 lines) mixes:

* Template generation (per source × load-mode permutations)
* Context object + destination resolution
* Execution + sandboxing

Three modules — `templates.py`, `context.py`, `executor.py` — would
make each easier to reason about and test in isolation. The current
`__init__.py` would re-export the public bits.
