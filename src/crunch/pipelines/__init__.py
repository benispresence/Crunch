"""
Pipeline package. The public surface (everything the engine route +
admin smoke tests need) is re-exported here; implementation lives in
three focused modules:

* :mod:`.templates` — auto-generate the starter dlt script from
  the form fields (one builder per source type).
* :mod:`.context`   — ``PipelineResult`` + ``PipelineContext``
  dataclasses. The context bundles destination credentials so user
  code never has to handle them.
* :mod:`.executor`  — sandboxed `exec`, import allowlist, SIGALRM
  wall-clock guard, captured stdout/stderr.
* :mod:`.imports`   — static import analysis, so the editor can flag a
  missing or unallowed package before a run instead of after one.

Old code imported these names directly from ``nicemeta.pipelines``;
keep the re-exports so callers don't break.
"""

from __future__ import annotations

from .context import PipelineContext, PipelineResult
from .executor import execute_pipeline
from .imports import analyze_imports, extract_imports, pip_name_for_import
from .templates import LOAD_MODE_TO_DISPOSITION, generate_template

# runner is a CLI module (python -m crunch.pipelines.runner) — imported on demand.

__all__ = [
    "LOAD_MODE_TO_DISPOSITION",
    "analyze_imports",
    "extract_imports",
    "pip_name_for_import",
    "PipelineContext",
    "PipelineResult",
    "execute_pipeline",
    "generate_template",
]
