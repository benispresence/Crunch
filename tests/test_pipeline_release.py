"""Outcome tests for generated loads: destination isolation, intervals and checks."""
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

from crunch.pipelines.context import PipelineContext
from crunch.pipelines.executor import execute_pipeline
from crunch.pipelines.templates import generate_template


class PipelineReleaseTest(unittest.TestCase):
    def test_generated_backfill_and_scratch_isolation(self):
        import duckdb
        with tempfile.TemporaryDirectory() as tmp:
            source = str(Path(tmp) / 'source.sqlite')
            conn = sqlite3.connect(source)
            conn.execute('CREATE TABLE orders(id INTEGER, updated_at INTEGER)')
            conn.executemany('INSERT INTO orders VALUES (?, ?)', [(1, 900), (2, 1500), (3, 2500)])
            conn.commit()
            conn.close()
            production = str(Path(tmp) / 'production.duckdb')
            scratch = str(Path(tmp) / 'scratch.duckdb')
            db = duckdb.connect(production)
            db.execute('CREATE TABLE untouched AS SELECT 42 AS id')
            db.close()
            code = generate_template({'name': 'orders', 'source_type': 'sql',
                'source_config': {'query': 'SELECT * FROM orders'},
                'destination': {'type': 'duckdb', 'dataset': 'production'},
                'extract_strategy': 'incremental', 'write_behavior': 'merge',
                'load_mode': 'merge', 'primary_key': 'id', 'cursor_field': 'updated_at'})
            ctx = PipelineContext('duckdb', {'database': scratch},
                source_config={'connection_url': 'sqlite:///' + source},
                runtime_config={'pipeline_identity': 'release_' + Path(tmp).name,
                    'destination_dataset': 'test_data', 'state_dir': str(Path(tmp) / 'state'), 'processing_interval_start': 1000,
                    'processing_interval_end': 2000,
                    'quality_checks': [{'type': 'unique', 'column': 'id'}, {'type': 'not_null', 'column': 'id'}]})
            result = execute_pipeline(code, ctx)
            self.assertTrue(result.success, result.log)
            db = duckdb.connect(scratch)
            self.assertEqual(db.execute('SELECT id FROM test_data.rows').fetchall(), [(2,)])
            db.close()
            db = duckdb.connect(production)
            self.assertEqual(db.execute('SELECT * FROM untouched').fetchall(), [(42,)])
            self.assertEqual(db.execute("SELECT count(*) FROM information_schema.schemata WHERE schema_name='test_data'").fetchone()[0], 0)
            db.close()
            checks = result.output_tables[0]['check_results']
            self.assertTrue(all(c['passed'] is True for c in checks), checks)

    def test_interval_boundaries(self):
        ctx = PipelineContext('sqlite', {}, runtime_config={'processing_interval_start': 10, 'processing_interval_end': 20})
        self.assertTrue(ctx.in_interval({'ts': 10}, 'ts'))
        self.assertFalse(ctx.in_interval({'ts': 20}, 'ts'))

if __name__ == '__main__':
    unittest.main()
