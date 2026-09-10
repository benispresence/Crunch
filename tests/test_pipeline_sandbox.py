"""Sandbox surface for pipeline code: the curated ``os``, and run() shapes."""
import unittest

from crunch.pipelines.context import PipelineContext
from crunch.pipelines.executor import execute_pipeline


def _ctx(env=None):
    return PipelineContext(
        destination_type="duckdb",
        destination_config={"database": ":memory:"},
        env=env,
    )


class PipelineSandboxTest(unittest.TestCase):
    def test_os_environ_exposes_pipeline_variables_only(self):
        import os

        os.environ["ENGINE_ONLY_SECRET"] = "must-not-leak"
        try:
            result = execute_pipeline(
                "import os\n"
                "def run():\n"
                "    return {'rows_loaded': 1, 'steps': [\n"
                "        os.environ.get('TOKEN'),\n"
                "        os.getenv('ENGINE_ONLY_SECRET', 'absent'),\n"
                "        os.path.join('a', 'b'),\n"
                "    ]}\n",
                _ctx({"TOKEN": "pipeline-token"}),
            )
        finally:
            os.environ.pop("ENGINE_ONLY_SECRET", None)
        self.assertTrue(result.success, result.error)
        self.assertEqual(result.steps, ["pipeline-token", "absent", "a/b"])

    def test_os_process_control_is_absent(self):
        for attribute in ("system", "popen", "remove", "fork", "execv"):
            result = execute_pipeline(
                f"import os\ndef run():\n    return os.{attribute}\n", _ctx(),
            )
            self.assertFalse(result.success, attribute)
            self.assertIn("AttributeError", result.error or "")

    def test_os_submodule_import_is_restricted(self):
        result = execute_pipeline(
            "from os import path\ndef run():\n    return 0\n", _ctx(),
        )
        self.assertTrue(result.success, result.error)
        result = execute_pipeline(
            "import os.system\ndef run():\n    return 0\n", _ctx(),
        )
        self.assertFalse(result.success)
        self.assertIn("not available to pipelines", result.error or "")

    def test_disallowed_module_still_refused(self):
        result = execute_pipeline(
            "import socket\ndef run():\n    return 0\n", _ctx(),
        )
        self.assertFalse(result.success)
        self.assertIn("allowed package list", result.error or "")

    def test_requests_is_allowed_even_if_not_installed(self):
        result = execute_pipeline(
            "import requests\ndef run():\n    return 0\n", _ctx(),
        )
        if result.success:
            return
        self.assertNotIn("allowed package list", result.error or "")
        self.assertIn("requests", result.error or "")
        self.assertIn("Allowed packages", result.error or "")

    def test_requests_runs_when_installed(self):
        try:
            import requests as _requests  # noqa: F401
        except ImportError:
            self.skipTest("requests not installed in this interpreter")
        result = execute_pipeline(
            "import requests\n"
            "def run():\n"
            "    return {'rows_loaded': 1, 'steps': [callable(getattr(requests, 'get', None))]}\n",
            _ctx(),
        )
        self.assertTrue(result.success, result.error)
        self.assertEqual(result.steps, [True])

    def test_allowed_library_can_import_its_dependencies(self):
        """User code cannot import urllib3, but `import json` (stdlib on
        the allowlist) still works, and a missing allowed package is
        reported as not installed rather than not allowed."""
        result = execute_pipeline(
            "import urllib3\ndef run():\n    return 0\n", _ctx(),
        )
        self.assertFalse(result.success)
        self.assertIn("allowed package list", result.error or "")

    def test_run_returning_a_list_reports_rows(self):
        result = execute_pipeline(
            "def run():\n    return [{'id': 1}, {'id': 2}]\n", _ctx(),
        )
        self.assertTrue(result.success, result.error)
        self.assertEqual(result.rows_loaded, 2)
        self.assertEqual(
            result.output_tables, [{"name": "output", "rows": [{"id": 1}, {"id": 2}]}],
        )


if __name__ == "__main__":
    unittest.main()
