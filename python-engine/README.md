# Crunch Python Engine

Thin FastAPI service that exposes the existing Python BI engine
(SQL execution, visualization rendering, sandboxed Python code) over
HTTP so the Express/TypeScript backend can call it.

## Endpoints

| Method | Path             | Purpose                                 |
| ------ | ---------------- | --------------------------------------- |
| GET    | `/health`        | Liveness check                          |
| POST   | `/sql/validate`  | Validate SQL without executing          |
| POST   | `/sql/execute`   | Execute SQL against a connection config |
| POST   | `/viz/render`    | Render a chart spec (Plotly etc.)       |
| POST   | `/python/execute`| Run user Python in the sandbox          |

All requests must include `token` matching `PYTHON_ENGINE_TOKEN`.

## Run

```bash
cd python-engine
pip install -r requirements.txt
PYTHON_ENGINE_TOKEN=dev-engine-token python server.py
```
