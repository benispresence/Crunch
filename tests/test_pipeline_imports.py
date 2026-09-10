"""Static import analysis and install-policy vs viz-blocklist."""
import unittest

from crunch.pipelines.imports import analyze_imports, extract_imports
from crunch.visualization.sandbox_modules import classify, classify_install


class ExtractImportsTest(unittest.TestCase):
    def test_top_level_and_from_imports(self):
        code = "import requests\nfrom kafka import KafkaConsumer\nfrom .local import x\n"
        self.assertEqual(
            extract_imports(code),
            [("requests", 1), ("kafka", 2)],
        )

    def test_syntax_error_is_empty(self):
        self.assertEqual(extract_imports("import "), [])


class AnalyzeImportsTest(unittest.TestCase):
    def test_os_is_ok(self):
        rows = analyze_imports("import os\n", {"json": "json"})
        self.assertEqual(rows[0]["status"], "ok")
        self.assertEqual(rows[0]["module"], "os")

    def test_unknown_module_is_not_allowed(self):
        rows = analyze_imports("import definitely_not_allowed_zzz\n", {"json": "json"})
        self.assertEqual(rows[0]["status"], "not_allowed")
        self.assertEqual(rows[0]["action"], "allow_and_install")
        self.assertEqual(rows[0]["pip_name"], "definitely_not_allowed_zzz")

    def test_requests_is_on_the_default_allowlist(self):
        rows = analyze_imports("import requests\n", {"json": "json"})
        self.assertEqual(len(rows), 1)
        self.assertNotEqual(rows[0]["status"], "not_allowed")
        self.assertIn(rows[0]["status"], ("ok", "not_installed"))
        if rows[0]["status"] == "not_installed":
            self.assertEqual(rows[0]["action"], "install")

    def test_allowed_but_missing_is_not_installed(self):
        rows = analyze_imports(
            "import missing_pipeline_pkg_zzz\n",
            {"json": "json", "missing_pipeline_pkg_zzz": "missing-pipeline-pkg-zzz"},
        )
        self.assertEqual(rows[0]["status"], "not_installed")
        self.assertEqual(rows[0]["pip_name"], "missing_pipeline_pkg_zzz")

    def test_kafka_maps_to_pip_name(self):
        rows = analyze_imports("from kafka import KafkaConsumer\n", {"json": "json"})
        self.assertEqual(rows[0]["pip_name"], "kafka-python")


class InstallPolicyTest(unittest.TestCase):
    def test_requests_is_blocked_for_viz_but_installable(self):
        self.assertEqual(classify("requests"), "blocked")
        self.assertEqual(classify_install("requests"), "pypi")

    def test_stdlib_skips_pip_even_when_viz_blocked(self):
        self.assertEqual(classify("os"), "blocked")
        self.assertEqual(classify_install("os"), "stdlib")
        self.assertEqual(classify_install("time"), "stdlib")

    def test_ordinary_pypi_stays_installable(self):
        self.assertEqual(classify_install("pandas"), "pypi")

    def test_packaging_tools_are_refused(self):
        self.assertEqual(classify_install("pip"), "refused")
        self.assertEqual(classify_install("setuptools"), "refused")


if __name__ == "__main__":
    unittest.main()
