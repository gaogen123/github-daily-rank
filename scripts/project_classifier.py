#!/usr/bin/env python3
"""Compatibility entry point for scripts/projects/project_classifier.py."""

if __name__ == "__main__":
    import runpy
    from pathlib import Path

    runpy.run_path(str(Path(__file__).resolve().parent / "projects" / "project_classifier.py"), run_name="__main__")
else:
    import importlib
    import sys

    module_name = f"{__package__}.projects.project_classifier" if __package__ else "projects.project_classifier"
    sys.modules[__name__] = importlib.import_module(module_name)
