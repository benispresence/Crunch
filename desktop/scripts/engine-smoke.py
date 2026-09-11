"""Exercise the real bundled server with only its bundled Python dependencies."""
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
import time
from urllib.request import Request, urlopen

root = Path(sys.argv[1]).resolve()
with tempfile.TemporaryDirectory(prefix="crunch-engine-smoke-") as scratch:
    scratch = Path(scratch)
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]
    token = "desktop-smoke-private-token"
    env = {**os.environ, "ENGINE_ENV": "production", "PYTHON_ENGINE_TOKEN": token,
           "PYTHON_ENGINE_HOST": "127.0.0.1", "PYTHON_ENGINE_PORT": str(port),
           "PYTHONNOUSERSITE": "1", "PYTHONDONTWRITEBYTECODE": "1",
           "MPLCONFIGDIR": str(scratch / "matplotlib")}
    def call(route, data=None):
        payload = None if data is None else json.dumps({"token": token, **data}).encode()
        request = Request(f"http://127.0.0.1:{port}{route}", data=payload,
                          headers={"Content-Type": "application/json"})
        with urlopen(request, timeout=10) as response:
            return json.load(response)
    with (scratch / "engine.log").open("w+") as log:
        child = subprocess.Popen([sys.executable, str(root / "python-engine/server.py")],
                                 cwd=scratch, env=env, stdout=log, stderr=log)
        try:
            deadline = time.monotonic() + 90
            while True:
                if child.poll() is not None:
                    raise RuntimeError(f"Engine exited with {child.returncode}")
                try:
                    assert call("/health")["status"] == "ok"
                    break
                except (OSError, ValueError):
                    if time.monotonic() >= deadline:
                        raise RuntimeError("Engine startup timed out")
                    time.sleep(.2)
            result = call("/sql/execute", {"connection": {"type": "sqlite", "database": str(scratch / "query.sqlite")},
                                           "sql": "SELECT 42 AS answer"})
            assert result["success"] and result["rows"] == [[42]], result
            csv = scratch / "sales.csv"
            csv.write_text("amount\n3\n7\n")
            result = call("/sql/execute", {"connection": {"type": "file", "database": str(scratch)},
                                           "sql": "SELECT SUM(amount) AS total FROM sales"})
            assert result["success"] and result["rows"] == [[10]], result
            for renderer in ["plotly", "matplotlib", "seaborn", "altair", "bokeh"]:
                result = call("/viz/render", {"chart_type": "bar", "renderer": renderer,
                    "data": {"label": ["a", "b"], "amount": [3, 7]},
                    "config": {"x": "label", "y": "amount"}})
                assert result["success"], (renderer, result)
            print("Engine smoke passed: startup, SQLite query, CSV query, five chart renderers")
        except BaseException:
            log.flush()
            print((scratch / "engine.log").read_text(), file=sys.stderr)
            raise
        finally:
            if child.poll() is None:
                child.terminate()
                try:
                    child.wait(timeout=10)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
