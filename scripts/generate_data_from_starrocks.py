#!/usr/bin/env python3
"""Compatibility entry point for scripts/exports/generate_data_from_starrocks.py."""

if __name__ == "__main__":
    import runpy
    from pathlib import Path

    runpy.run_path(str(Path(__file__).resolve().parent / "exports" / "generate_data_from_starrocks.py"), run_name="__main__")
else:
    import importlib
    import sys

    module_name = f"{__package__}.exports.generate_data_from_starrocks" if __package__ else "exports.generate_data_from_starrocks"
    sys.modules[__name__] = importlib.import_module(module_name)
