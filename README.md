# NiceMeta

**Open-source Business Intelligence platform** — a Metabase alternative.

NiceMeta now runs as three cooperating services:

```
┌──────────────────┐    HTTP      ┌──────────────────┐   HTTP    ┌──────────────────┐
│  Vue 3 frontend  │  ───────►   │  Express + TS    │  ──────► │  Python engine   │
│  (Vite, Pinia,   │   /api      │  backend         │          │  (FastAPI; SQL   │
│  Monaco, Plotly) │              │  + Anthropic SSE │          │  + visualization │
└──────────────────┘              └──────────────────┘          │  + sandbox)      │
                                                                 └──────────────────┘
```

- The **Python engine** keeps the existing SQL execution, visualization
  rendering (Plotly et al.), and sandboxed user-Python features. It is now
  a thin FastAPI service with no UI.
- The **Express/TypeScript backend** owns auth, persistent state, the AI
  chat orchestration loop, and proxies compute-heavy work to the engine.
- The **Vue 3/TypeScript frontend** is a Cursor-style workspace with
  resizable panes, an Anthropic-style chat experience, and confirmations
  before any AI-proposed change touches your editor.

## Layout

```
nicemeta/
├── python-engine/     FastAPI service (re-exports src/nicemeta/{query,visualization,connections})
├── backend/           Express + TypeScript API + Anthropic chat orchestrator
├── frontend/          Vue 3 + TypeScript + Vite UI
├── src/nicemeta/      Original Python package (still imported by python-engine)
├── config/            Engine config (existing)
└── docker/            Existing Docker assets
```

## Quick start (dev)

Three terminals, in order:

```bash
# 1. Python engine (port 8765)
cd python-engine
pip install -r requirements.txt -e ../.
PYTHON_ENGINE_TOKEN=dev-engine-token python server.py

# 2. Express backend (port 3691)
cd backend
cp .env.example .env          # set ANTHROPIC_API_KEY
npm install
npm run dev

# 3. Vue frontend (port 5173)
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`, register, add a connection, run SQL, ask the
assistant for a chart.

## What the new UX gives you

- **Adjustable panes (Cursor-style).** Sidebar / editor / results / chart /
  chat are all `splitpanes` regions. Drag any divider; layouts are
  remembered for the session. The top bar can hide either side panel for a
  full-bleed editor.
- **Adaptive layout.** A breakpoint at 1100px reflows pane sizes so the
  workspace stays usable on laptops without sacrificing density.
- **Anthropic-style assistant.**
  - Streamed reasoning shows in a quiet *Thinking* block (collapses when
    the answer arrives).
  - Tool calls display as inline cards with running / ok / error dots and
    expandable input + result panels.
  - When more than 5 tool calls happen in one turn, they collapse into a
    single summary chip ("Used 8 tools — `execute_sql ×4` `render_chart ×2`
    …") with a *Show all* affordance.
  - Code blocks are wrapped in a header (language label + copy button) and
    rendered with `highlight.js` using the warm Anthropic palette.
  - When the model proposes SQL the editor should accept, a confirmation
    bar appears at the bottom of the editor with **Accept & replace** and
    **Reject** — no silent overwrites.
- **Tool side effects flow into the workspace.** When the assistant runs
  `execute_sql`, the results table updates. When it calls `render_chart`,
  the visualization panel renders the Plotly spec.

## Tools the assistant has

| Tool             | Purpose                                                  |
| ---------------- | -------------------------------------------------------- |
| `list_connections` | Browse the user's saved connections                    |
| `execute_sql`    | Run a read-only query through the Python engine          |
| `render_chart`   | Render a chart spec from columnar data                   |
| `run_python`     | Execute sandboxed Python (the existing CodeExecutor)     |

Destructive SQL is rejected by the engine's existing validator before any
adapter sees it.

## Environment

`backend/.env`:

```
PORT=3691
JWT_SECRET=change-me
PYTHON_ENGINE_URL=http://127.0.0.1:8765
PYTHON_ENGINE_TOKEN=dev-engine-token
ANTHROPIC_API_KEY=sk-ant-...
ANTHROPIC_MODEL=claude-opus-4-7
DATABASE_FILE=./nicemeta.sqlite
CORS_ORIGIN=http://localhost:5173
```

## Surfaces

Top-bar nav routes:

- **Workspace** — connections sidebar, Monaco SQL editor, results table,
  chart panel, AI chat. `Save` on the chart panel persists a
  Visualization (SQL + chart type + column mapping).
- **Dashboards** — grid of dashboards. Each dashboard is a 12-column
  layout of widgets that point at saved visualizations. Toggle **Edit
  layout** to drag and resize widgets on the grid (cell-snapped, with
  guides), then **Save layout** persists positions. Adding a widget
  picks from your saved visualizations.
- **Admin** (only for users with `role = "admin"`):
  - Allowed packages table — add a pip package, install/uninstall via the
    Python engine (`/packages/install`, `/packages/uninstall`),
    enable/disable per package. Defaults (pandas, numpy, plotly, matplotlib,
    seaborn, scipy, altair) cannot be deleted.
  - Users table — flip roles between `viewer`, `editor`, and `admin`.
    The first registered user is auto-promoted to admin.

## Migration status

The TypeScript/Vue/Express stack now covers every surface from the original
NiceGUI UI: workspace, dashboards, admin. The Python engine remains the
authority on SQL execution, chart rendering, and sandboxed Python — Express
proxies all of it.

## License

MIT — see [LICENSE](LICENSE).
