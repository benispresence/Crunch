# Crunch v1.1.2

Fixes macOS desktop distribution and first-run administrator setup.

- The v1.1.1 Apple Silicon ZIP contains an invalid application signature. Mac builds now explicitly ad-hoc sign the assembled app, check its signature, and verify the extracted distribution ZIP before upload.
- Builds explicitly select the intended native architecture and invalidate runtime caches when the architecture or Node version changes. Validation loads bundled Node, SQLite, Python and native Python dependencies. Intel CI uses the supported macos-15-intel runner.
- First desktop launch asks you to choose your administrator email and password, then signs you in. Packaged v1.1.1 previously hid its randomly generated admin password because production mode suppressed it, leaving users at an unexplained login screen.
- Upgrading an untouched v1.1.1 desktop installation also opens setup. Existing configured accounts keep their credentials and data. Setup requires a private per-launch capability passed by the desktop shell and is disabled after completion; production server deployments cannot use this endpoint.

Validation: backend and frontend production builds; production API regression tests for setup, unauthorized requests, restart recovery, repeat-setup rejection and subsequent login. Native ARM64 execution and new ZIP validation run on the corresponding Mac CI runner; they have not been exercised on an Apple Silicon Mac locally.

These builds use ad-hoc signing, not an Apple Developer ID certificate or notarization. macOS may still require approval in Privacy & Security for a downloaded app.
