#!/usr/bin/env python3
"""Compatibility entry point for scripts/trending/crawl_and_load_trending.py."""

if __name__ == "__main__":
    import runpy
    from pathlib import Path

    runpy.run_path(str(Path(__file__).resolve().parent / "trending" / "crawl_and_load_trending.py"), run_name="__main__")
else:
    import importlib
    import sys

    module_name = f"{__package__}.trending.crawl_and_load_trending" if __package__ else "trending.crawl_and_load_trending"
    sys.modules[__name__] = importlib.import_module(module_name)
