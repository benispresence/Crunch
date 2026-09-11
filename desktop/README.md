# Crunch desktop (Mac first)

Opens the same workspace in an app window instead of a browser tab.
Electron is only the chrome: it starts the local API + Python engine,
then loads `http://127.0.0.1:<port>`.

Nothing under `desktop/release/` or `desktop/.pack/` is committed.

## Run from this repo (Mac)

Needs the same toolchain as native dev: Node, and Python 3.11+ with the
engine venv (`python-engine/.venv` or repo `venv`).

```bash
cd frontend && npm run build && cd ..
cd desktop && npm install && npm start
```

A Crunch window should open. Data lives in
`~/Library/Application Support/Crunch/` (SQLite, workspace, generated
secrets) so it does not touch your git repo.

## Import from the browser / `npm run dev` instance

The two copies keep separate databases:

| Instance | Database |
|----------|----------|
| Browser (`npm run dev`) | `backend/nicemeta.sqlite` in the git repo |
| Mac app | `~/Library/Application Support/Crunch/data/nicemeta.sqlite` |

To bring queries, connections, dashboards, and users across: open the
Mac app → **File → Import from another Crunch instance…** → pick
`backend/nicemeta.sqlite`. The app re-encrypts connection passwords
for its own key (the two instances do not share `DATA_KEY`), copies
`nicemeta-workspace` if it sits next to the file, then restarts.

**File → Reveal data folder** opens the Application Support directory
if you want to inspect or back up the files yourself.

## Downloadable zip (Intel vs Apple Silicon)

These are **two different files**. Native Python/Node wheels cannot be
universal. Pack on the matching Mac, or run the `Desktop Mac zips`
GitHub Action (it builds both on `macos-15-intel` Intel and `macos-14` Apple
Silicon and uploads artifacts).

```bash
cd desktop && npm install && npm run pack:mac
```

Output (gitignored):

| Machine        | File |
|----------------|------|
| Apple Silicon  | `desktop/release/Crunch-1.1.3-mac-arm64.zip` |
| Intel          | `desktop/release/Crunch-1.1.3-mac-x64.zip` |

Send the zip. The other person unzips, then **right-click `Crunch.app` →
Open** (the build is ad-hoc signed, without Apple notarization).

The first pack is slow (downloads CPython + pandas/Plotly/DuckDB). The
zip is large — hundreds of MB.

## Windows

electron-builder has an NSIS target stub. Do not ship it yet — the pack
script only fetches macOS CPython/Node. A Windows pack needs Win
binaries and a code-signing story of its own.

### First launch

Choose your administrator email and password in the app; completing setup signs you in. An untouched v1.1.1 default account is recovered by the same screen when upgrading. Existing configured accounts continue to use their chosen credentials.

Builds validate the app signature and bundled native runtimes; CI repeats validation after extracting the ZIP. Run the setup regression tests with `node --test backend/test/desktopSetup.test.mjs` from the repository root after building the backend.

The desktop engine dependency list lives in `requirements-engine.txt`. Changing it invalidates cached Python dependencies. Packaging starts the actual bundled engine, runs SQLite and CSV queries, and renders charts with every built-in renderer. Startup waits for engine health; service output is saved to `~/Library/Application Support/Crunch/desktop.log` (the previous launch is retained as `desktop.log.previous`).
