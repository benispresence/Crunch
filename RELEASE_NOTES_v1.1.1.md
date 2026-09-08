# Crunch v1.1.1

Feature release: a native Mac app, filters that actually bind, theme-aware
charts, multi-lab AI settings with a model picker, and web search for the
assistant.

## Highlights

### Crunch as a Mac app
- **Desktop build** — an Electron shell that boots the Python engine and
  Express API on loopback, serves the built SPA from the same origin, and
  keeps SQLite and the workspace under Application Support
- **Downloadable zips per architecture** — Apple Silicon (arm64) and Intel
  (x64), attached to this release
- **File → Import from another Crunch instance** — copies a consistent
  snapshot from a browser install and re-encrypts stored passwords for the
  app's own `DATA_KEY`, so a `npm run dev` database moves across intact

### Filters and variables
- **Filter bar on the query** — type `{{name}}` (or click **+ Filter**) and a
  chip appears above the SQL; values re-run the query, optional `[[ … ]]`
  clauses drop when a chip is empty, and `{{vars}}` are highlighted in the
  editor
- **Field filters** — map `{{var}}` to a column and it expands into a
  parameterized clause rather than a scalar bind
- **Filter operators** — `eq`, `ne`, `contains`, `between`, `gte`, `lte`, so a
  mapped column can express a range or a substring match. Everything still
  binds: `contains` binds `%value%`, `between` binds two keys
- **Docs → Filters** — a page documenting the syntax with worked examples,
  which template errors now point at
- **Fix:** date variables bind real `date`/`datetime` objects. asyncpg rejects
  ISO date strings for timestamp parameters even when the SQL casts them,
  which silently broke date chips
- **Fix:** File/DuckDB execution ignored bind parameters — file-backed queries
  looked wired up but did not filter

### Charts and theme
- **Theme-aware Plotly charts** — text and marks flip with the light/dark
  theme instead of settling for one shade that is legible in both. Figures can
  declare their own two-theme palette, and `$token` / `$(light: …, dark: …)`
  colour tokens resolve at render time, so the assistant can propose charts
  that follow the theme
- Auto-fit when panels collapse, restored mode bar, and a full-visualization
  toggle in the top bar

### AI assistant
- **Web search** — via Anthropic's server-side tool, with results linked in
  the tool-call list
- **Model catalog and picker** — choose the model and reasoning effort per
  conversation; an admin checklist controls which models appear
- **Per-lab AI settings** — Anthropic, xAI, OpenAI and Google each get their
  own connection: an API key from the developer console, or SuperGrok / X
  Premium via xAI's device-code OAuth
- **Folder tools** — the assistant can create folders and move queries, and
  the saved-query list is no longer truncated mid-JSON
- **Fix:** one interrupted turn could permanently brick a conversation. A
  `tool_use` block left without its `tool_result` made every later message
  fail with a 400; histories are now repaired on load and on save

### Workspace UX
- Deep links for queries and dashboards, resizable chat panel, collections
  collapsed by default with expand state remembered, single-line query rows
  with ellipsis, and a cookie-crunch ASCII loading animation

## Fixes

- **Sandbox imports** — the package manager had no effect on the sandbox,
  which fell back to a hardcoded module list, so `import time` failed and
  stdlib modules could not be added (they have no version to `pip install`).
  The allowlist is now derived server-side from the database, stdlib is
  detected via `sys.stdlib_module_names`, and the blocklist is re-checked at
  import time

## Upgrade notes

- No new required environment variables, and no schema migration steps.
- **Mac app data lives elsewhere:** the desktop build keeps its database under
  Application Support with its own `DATA_KEY`, separate from
  `backend/nicemeta.sqlite`. Use **File → Import from another Crunch
  instance** to bring a browser install's data across — copying the SQLite
  file by hand will leave stored connection passwords undecryptable.
- **Behaviour change:** collections are collapsed by default on first load.

## Running it

```bash
# Docker (recommended)
cp docker/.env.example docker/.env
# generate three random secrets and paste them into docker/.env:
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
docker compose -f docker/docker-compose.yml --env-file docker/.env up --build
# open http://localhost:8080
```

On macOS you can instead download `Crunch-v1.1.1-mac-arm64.zip` (Apple
Silicon) or `Crunch-v1.1.1-mac-x64.zip` (Intel) from this release.

See [README.md](README.md) for the native development setup (three
hot-reloading services) and the full data-source / driver matrix.
