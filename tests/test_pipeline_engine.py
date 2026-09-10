"""Engine boundary regressions for subprocess pipeline execution."""
import asyncio
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "python-engine"))
import server


class PipelineEngineTest(unittest.IsolatedAsyncioTestCase):
    async def test_validation_releases_duckdb_for_worker(self):
        with tempfile.TemporaryDirectory() as tmp:
            database = str(Path(tmp) / "destination.duckdb")
            result = await server.execute_sql(server.ExecuteSqlRequest(
                token=os.environ.get("PYTHON_ENGINE_TOKEN", "dev-engine-token"),
                connection=server.ConnectionConfig(type="duckdb", database=database),
                sql="SELECT 1",
            ))
            self.assertTrue(result.success, result.error)
            worker = await asyncio.to_thread(subprocess.run, [sys.executable, "-c",
                "import duckdb,sys; c=duckdb.connect(sys.argv[1]); c.execute('CREATE TABLE written AS SELECT 42 AS id'); c.close()",
                database], capture_output=True, text=True, timeout=15)
            self.assertEqual(worker.returncode, 0, worker.stderr)
            result = await server.execute_sql(server.ExecuteSqlRequest(
                token=os.environ.get("PYTHON_ENGINE_TOKEN", "dev-engine-token"),
                connection=server.ConnectionConfig(type="duckdb", database=database),
                sql="SELECT id FROM written",
            ))
            self.assertTrue(result.success, result.error)
            self.assertEqual(result.rows, [[42]])

    async def test_job_operations_require_engine_token(self):
        from fastapi import HTTPException
        for fn in (server.pipeline_status, server.pipeline_cancel):
            with self.assertRaises(HTTPException) as ctx:
                await fn("does-not-matter", {"token": "incorrect"})
            self.assertEqual(ctx.exception.status_code, 401)


if __name__ == "__main__":
    unittest.main()
