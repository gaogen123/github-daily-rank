"""Compatibility alias for scripts/projects/project_scoring.py."""

import importlib
import sys

module_name = f"{__package__}.projects.project_scoring" if __package__ else "projects.project_scoring"
sys.modules[__name__] = importlib.import_module(module_name)
