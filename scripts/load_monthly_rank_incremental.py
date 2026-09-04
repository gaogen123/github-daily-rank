#!/usr/bin/env python3
"""Compatibility entry point for scripts/rankings/load_monthly_rank_incremental.py."""

if __name__ == "__main__":
    import runpy
    from pathlib import Path

    runpy.run_path(str(Path(__file__).resolve().parent / "rankings" / "load_monthly_rank_incremental.py"), run_name="__main__")
else:
    import importlib
    import sys

    module_name = f"{__package__}.rankings.load_monthly_rank_incremental" if __package__ else "rankings.load_monthly_rank_incremental"
    sys.modules[__name__] = importlib.import_module(module_name)
