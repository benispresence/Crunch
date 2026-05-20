# NiceMeta

**Open-source Business Intelligence platform** — a Metabase alternative with a
Cursor-style workspace and a built-in Anthropic-powered assistant.

```
┌──────────────────┐   HTTP    ┌──────────────────┐   HTTP   ┌──────────────────┐
│  Vue 3 frontend  │  ──────►  │  Express + TS    │  ──────► │  Python engine   │
│  (Vite, Pinia,   │  /api     │  backend         │          │  (FastAPI; SQL   │
│  Monaco, Plotly) │           │  + Anthropic SSE │          │  + visualization │
└──────────────────┘           └──────────────────┘          │  + sandbox)      │
                                                              └──────────────────┘
```

- **Python engine** — SQL execution, chart rendering (Plotly et al.), and the
  sandboxed user-Python executor, exposed as a small FastAPI service.
- **Express/TypeScript backend** — auth, persistent state (SQLite), AI chat
  orchestration; proxies compute-heavy work to the engine.
- **Vue 3 / TypeScript frontend** — a Cursor-style workspace: SQL editor,
  visualization panel, results table, and assistant — every panel is
  resizable and collapsible.

---

## Quick start

Pick one of the two paths:

- [**Docker** — one command, no toolchain setup](#run-with-docker)
- [**Native** — full local dev loop with hot reload](#run-natively)

You'll need an **Anthropic API key** for the AI assistant. The rest of the
app works without one.

---

## Run with Docker

The simplest way to try NiceMeta. Requires
[Docker Desktop](https://docs.docker.com/get-docker/) (macOS / Windows) or a
recent Docker Engine + Compose plugin (Linux).

```bash
# From the repo root
cp docker/.env.example docker/.env
# edit docker/.env — at minimum set ANTHROPIC_API_KEY

docker compose -f docker/docker-compose.yml --env-file docker/.env up --build
```

Then open <http://localhost:8080>.

What's running:

| Service    | Container port | Host port    | Notes                                  |
| ---------- | -------------- | ------------ | -------------------------------------- |
| `frontend` | 80             | **8080**     | nginx; serves the SPA, proxies `/api`  |
| `backend`  | 3691           | (internal)   | Express + Anthropic SSE                |
| `engine`   | 8765           | (internal)   | FastAPI                                |

Data is persisted in named volumes (`nicemeta-data`, `nicemeta-workspace`).
Bring it down with `docker compose -f docker/docker-compose.yml down`; add
`-v` to also wipe the volumes.

**First-run credentials.** The backend seeds a default admin on first start
and prints the email + temporary password to its container logs:

```bash
docker compose -f docker/docker-compose.yml logs backend | grep -A4 "Default admin"
```

Sign in, then change the password via the **Change password** form on the
login screen.

---

## Run natively

You'll run three processes side by side: the Python engine, the Express
backend, and the Vite dev server. All three support hot reload.

Prerequisites (every OS):

- **Python ≥ 3.11** ([python.org](https://www.python.org/downloads/))
- **Node.js ≥ 20** ([nodejs.org](https://nodejs.org/) — LTS is fine)
- **git**
- An **Anthropic API key** (optional, needed only for the assistant)

OS-specific setup below.

### macOS

```bash
# One-time toolchain (Homebrew)
brew install python@3.11 node@20 git
# Make sure Xcode CLT is installed for the better-sqlite3 native build:
xcode-select --install || true

# Clone and enter the repo
git clone https://github.com/benispresence/NiceMeta.git
cd NiceMeta
```

Three terminals — one per service. From the repo root:

**Terminal 1 — Python engine (port 8765)**

```bash
cd python-engine
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt -e ../.
PYTHON_ENGINE_TOKEN=dev-engine-token python server.py
```

**Terminal 2 — Express backend (port 3691)**

```bash
cd backend
cp .env.example .env
# Edit .env and paste your ANTHROPIC_API_KEY
npm install
npm run dev
```

The first start prints a default admin email and temporary password to the
terminal — write it down.

**Terminal 3 — Vue frontend (port 5173)**

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173>.

### Linux (Debian / Ubuntu)

```bash
# One-time toolchain
sudo apt update
sudo apt install -y python3.11 python3.11-venv python3-pip nodejs npm git build-essential libpq-dev
# Ubuntu 22.04 ships an older nodejs — for Node 20 use NodeSource:
#   curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
#   sudo apt install -y nodejs

git clone https://github.com/benispresence/NiceMeta.git
cd NiceMeta
```

Then run the three terminals exactly as in the macOS section above.

**Note on `better-sqlite3`.** The backend uses a native binding that
compiles on first `npm install`. `build-essential` (gcc, make) covers
this on Debian/Ubuntu; on Fedora/RHEL install `gcc-c++ make` and the
Python 3 development headers.

### Windows

The recommended path on Windows is **WSL 2 + Ubuntu** — follow the Linux
instructions inside WSL. You'll get the same fast hot-reload loop with no
toolchain pain.

If you'd rather run natively on Windows:

1. **Install prerequisites**
   - [Python 3.11](https://www.python.org/downloads/windows/) — tick *Add to
     PATH* in the installer.
   - [Node.js 20 LTS](https://nodejs.org/) — the installer offers to add the
     C++ build tools needed by native modules; **accept that option**, or
     install [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/)
     manually (the *Desktop development with C++* workload).
   - [Git for Windows](https://git-scm.com/download/win).
2. **Clone the repo**
   ```powershell
   git clone https://github.com/benispresence/NiceMeta.git
   cd NiceMeta
   ```
3. **Run the three services in three PowerShell windows** (commands below
   use `python` — on some systems it's `py -3.11`):

   **PowerShell 1 — Python engine**
   ```powershell
   cd python-engine
   python -m venv .venv
   .\.venv\Scripts\Activate.ps1
   pip install -r requirements.txt -e ..\
   $env:PYTHON_ENGINE_TOKEN = "dev-engine-token"
   python server.py
   ```
   *If `Activate.ps1` is blocked*, run
   `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once, in an
   elevated PowerShell.

   **PowerShell 2 — Express backend**
   ```powershell
   cd backend
   Copy-Item .env.example .env
   # Open .env in your editor and paste your ANTHROPIC_API_KEY
   npm install
   npm run dev
   ```

   **PowerShell 3 — Vue frontend**
   ```powershell
   cd frontend
   npm install
   npm run dev
   ```

Open <http://localhost:5173>.

---

## Environment

`backend/.env` (created from `backend/.env.example`):

```
PORT=3691
JWT_SECRET=change-me-in-production
PYTHON_ENGINE_URL=http://127.0.0.1:8765
PYTHON_ENGINE_TOKEN=dev-engine-token
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-4-7
DATABASE_FILE=./nicemeta.sqlite
CORS_ORIGIN=http://localhost:5173
```

When running with Docker, the equivalent values come from `docker/.env`
(see `docker/.env.example`). The backend reads them as container environment
variables — there's no need to mount `.env` files into the containers.

---

## Data sources

Connections are managed in the sidebar. Drivers for the heavier
warehouses are lazy-loaded — Crunch boots fine without them and tells
you the exact `pip install` to run the first time you connect.

| Category     | Type                          | Driver                              | Install                          |
| ------------ | ----------------------------- | ----------------------------------- | -------------------------------- |
| OLTP         | PostgreSQL                    | `asyncpg`                           | included                         |
|              | MySQL                         | `aiomysql`                          | included                         |
|              | MariaDB (MySQL-compatible)    | `aiomysql`                          | included                         |
|              | SQLite                        | `aiosqlite`                         | included                         |
|              | SQL Server                    | `pyodbc`                            | included                         |
| Warehouses   | Snowflake                     | `snowflake-sqlalchemy`              | `pip install -e .[snowflake]`    |
|              | BigQuery                      | `sqlalchemy-bigquery`               | `pip install -e .[bigquery]`     |
|              | Amazon Redshift               | `sqlalchemy-redshift`               | `pip install -e .[redshift]`     |
|              | Databricks                    | `databricks-sql-connector`          | `pip install -e .[databricks]`   |
|              | ClickHouse                    | `clickhouse-sqlalchemy`             | `pip install -e .[clickhouse]`   |
|              | Trino / Presto                | `sqlalchemy-trino`                  | `pip install -e .[trino]`        |
| Files        | CSV, TSV (incl. `.csv.gz`)    | DuckDB                              | included                         |
|              | Parquet                       | DuckDB                              | included                         |
|              | JSON / NDJSON                 | DuckDB                              | included                         |
|              | Arrow / Feather               | `pyarrow`                           | `pip install -e .[cloud-files]`  |
|              | Excel (`.xlsx`, `.xls`)       | `openpyxl`                          | included                         |
|              | S3 / GCS / Azure / HTTPS URIs | DuckDB `httpfs`                     | included                         |
| Embedded     | DuckDB (`.duckdb` files)      | DuckDB                              | included                         |
| Document     | MongoDB                       | `pymongo`                           | `pip install -e .[mongo]`        |

Install everything in one shot with `pip install -e .[all-sources]`.
**MongoDB note:** Mongo queries are JSON pipelines, not SQL — the
editor still works, but you write a body like
`{"collection":"orders","pipeline":[{"$match":{"status":"paid"}}]}`.

**File format detection.** When you pick the **File** connection
type, formats are inferred from each file's extension (CSV, Parquet,
JSON, Arrow, Excel — including compressed `.csv.gz`) so there's no
manual selector. Hit **Browse folder…** to walk a directory
recursively: the dialog lists every supported file with a format
chip + size, expands Excel workbooks into one row per sheet (each
becomes its own table), and offers select-all / select-none / pick
by format. Excel sheets become tables named `<workbook>_<sheet>`.

## Workspace UX

- **Three collapsible panes** stacked in the centre — SQL/Python editor on
  top, the big chart in the middle, results at the bottom. Each pane has a
  chevron on its header to focus on a single surface.
- **SQL ↔ Visualization Python tabs** in the top pane. Picking any standard
  chart type generates editable starter Python code that reproduces it; edit
  freely and save it as a custom Python visualization.
- **Sidebar** lists connections, saved queries, saved visualizations, and
  folders. **Chat** sits on the right.
- **Assistant** streams thinking + tool calls inline. When it proposes a SQL
  change, a confirmation bar appears at the bottom of the editor — no silent
  overwrites.

## Filters and variables

Crunch supports Metabase-compatible filter syntax in SQL and Python charts:

```sql
SELECT *
FROM orders
WHERE 1 = 1
  [[ AND created_at >= {{since}} ]]
  [[ AND status   =  {{status}} ]]
```

- **`{{name}}`** — variable reference. Values flow through your driver as
  SQL bind parameters, so they can't be injected.
- **`[[ … {{name}} … ]]`** — optional clause. The bracketed chunk vanishes
  when `name` is left blank; supply a value and it's substituted as a bind.

Every `{{var}}` you type is auto-detected and shown in the **Variables**
strip above the editor, where you set its type (`text`, `number`, `date`,
`boolean`), a default, and whether it's required. Python charts get the
same values exposed as a `params` dict — handy for dynamic titles,
thresholds, etc.

On a dashboard, click **Edit layout → Edit filters** to add filter chips
to the top bar. The gear icon on each chart opens a small dialog that
maps each filter to a variable in that chart's underlying query. One
filter can drive many charts at once.

## Authentication

Crunch ships with email + password out of the box. **Admin →
Authentication** adds the options most teams ask for next:

- **OIDC / OAuth2** — paste a discovery URL + client id/secret. Covers
  Google Workspace, Microsoft 365, Okta, Auth0, Authentik, Keycloak,
  GitHub, and anything else that speaks the standard. Sign-in buttons
  appear on the login screen the moment the provider is enabled.
- **SAML 2.0** — for enterprise IdPs (Azure AD, OneLogin, ADFS).
  Configure the entry point, SP issuer, and the IdP signing cert; the
  admin dialog shows the exact ACS URL to register with the IdP.
- **LDAP / Active Directory** — bind-then-search pattern with optional
  StartTLS. Renders a "Sign in via directory" form on the login page.
- **API keys** — long-lived bearer tokens (`crunch_pk_…`) for
  embedding queries from scripts or CI. The plaintext is shown once
  at creation; the DB stores only a hash.
- **Email domain allowlist** — single setting that gates self-
  registration *and* every SSO method, so a leaked OIDC link can't
  enroll outsiders.

Provider secrets (OIDC client secret, LDAP bind password, SAML SP
private key) are encrypted at rest with the same key used for
connection passwords. The login page reads the enabled providers via
`/api/auth/config` and renders one button per OIDC/SAML provider plus
an optional LDAP form.

## Version history

Every save of a query or a dashboard creates a snapshot you can revert
to from the **History** button in the editor / dashboard header. The
timeline is monotonic — reverting stamps a new "revert" revision on
top instead of rewriting history, so an accidental revert is itself
undoable. Identical back-to-back saves are deduped so the timeline
isn't noisy.

If the workspace is git-initialized (Admin → Git), each snapshot also
runs `git add -A && git commit`, mirroring the same history to disk.
The commit SHA shows up next to the in-app revision so you can `git
diff` between two points or push the lot to a remote. When git isn't
initialized, snapshots still work and live entirely in SQLite.

## Agent on dashboards

The assistant can build and edit dashboards too, using the same
Accept/Reject proposal flow as queries:

- `propose_new_dashboard` — create a board with optional initial
  widgets + filters in one shot.
- `propose_add_widget` / `propose_remove_widget` — wire saved queries
  onto an existing board.
- `propose_dashboard_filter_change` — edit the filter bar.
- `propose_widget_mapping` — connect filters to per-chart variables.
- `propose_navigate` — jump the user between workspace and a specific
  dashboard, e.g. after creating a query and adding it to a board.

With auto-accept on in the chat panel, the assistant can chain
"create a query → add it to a dashboard → take me there" into a
single hands-off flow.

## Tools the assistant has

| Tool               | Purpose                                              |
| ------------------ | ---------------------------------------------------- |
| `list_connections` | Browse the user's saved connections                  |
| `execute_sql`      | Run a read-only query through the Python engine      |
| `render_chart`     | Render a chart spec from columnar data               |
| `run_python`       | Execute sandboxed Python (the existing CodeExecutor) |

Destructive SQL is rejected by the engine's validator before any adapter
sees it.

## Surfaces

- **Workspace** — connections sidebar, SQL/Python editor, results, chart,
  chat. `Save` on the chart panel persists a Visualization.
- **Dashboards** — 12-column grid; toggle **Edit layout** to drag/resize
  widgets that point at saved visualizations.
- **Admin** (role = `admin` only):
  - *Allowed packages* — install/uninstall pip packages on the engine, toggle
    enablement; defaults (pandas, numpy, plotly, matplotlib, seaborn, scipy,
    altair) can't be deleted.
  - *Users* — flip roles between `viewer`, `editor`, `admin`. The first
    registered user is auto-promoted to admin.

## Repository layout

```
nicemeta/
├── python-engine/   FastAPI service (server.py + requirements)
├── backend/         Express + TypeScript API + Anthropic chat
├── frontend/        Vue 3 + TypeScript + Vite UI
├── src/nicemeta/    Original Python package (SQL, viz, connections)
├── docker/          Dockerfile.{engine,backend,frontend}, compose, nginx
├── config/          Engine config
└── scripts/         Maintenance scripts
```

## License

MIT — see [LICENSE](LICENSE).
