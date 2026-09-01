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

## Pack a `.app` (Mac)

```bash
cd desktop && npm install && npm run pack:mac
```

That downloads a relocatable CPython + a Node binary into
`desktop/.pack/` (gitignored), builds the SPA and API, and writes
`desktop/release/mac/Crunch.app`.

The first pack is slow (Python scientific wheels). The `.app` is large
(hundreds of MB) because pandas / Plotly / DuckDB come along.

The app is **unsigned**. First launch: right-click → Open.

## Windows

electron-builder has an NSIS target stub. Do not ship it yet — the pack
script only fetches macOS CPython/Node. A Windows pack needs Win
binaries and a code-signing story of its own.
