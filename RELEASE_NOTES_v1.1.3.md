# Crunch v1.1.3

Fixes the macOS query engine crash that left data connections reporting `ECONNREFUSED` while the workspace window remained usable.

The v1.1.2 desktop bundle omitted required Python dependencies. Running the downloaded app's engine reproduced `ModuleNotFoundError: No module named 'tomli'`; configuration and chart renderer dependencies were also absent from the build list. Desktop packaging now installs the complete engine runtime from `desktop/requirements-engine.txt` and invalidates cached dependencies whenever that list changes. Failed dependency installations cannot be mistaken for completed bundles.

The desktop shell now waits for the Python engine's health response before opening the workspace. Missing executables, nonzero exits, signals and unexpected clean exits are handled explicitly. Startup failures stop the remaining services. Logs are written to `~/Library/Application Support/Crunch/desktop.log`, with the previous launch retained as `desktop.log.previous`. Matplotlib's writable cache is kept outside the signed app.

Packaging validation now starts the actual bundled server in production mode, executes SQLite and CSV queries, and renders a chart using Plotly, Matplotlib, Seaborn, Altair and Bokeh. CI repeats this against the extracted ZIP on both Mac architectures, alongside setup and startup-health regression tests.

Existing account credentials and workspace data are preserved when replacing the app.
