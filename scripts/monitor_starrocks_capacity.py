#!/usr/bin/env python3
"""Compatibility entry point for scripts/operations/monitor_starrocks_capacity.py."""

if __name__ == "__main__":
    import runpy
    from pathlib import Path

    runpy.run_path(str(Path(__file__).resolve().parent / "operations" / "monitor_starrocks_capacity.py"), run_name="__main__")
else:
    import importlib
    import sys

    module_name = f"{__package__}.operations.monitor_starrocks_capacity" if __package__ else "operations.monitor_starrocks_capacity"
    sys.modules[__name__] = importlib.import_module(module_name)
