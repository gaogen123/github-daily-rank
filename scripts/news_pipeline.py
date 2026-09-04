#!/usr/bin/env python3
"""Compatibility entry point for scripts/news/news_pipeline.py."""

if __name__ == "__main__":
    import runpy
    from pathlib import Path

    runpy.run_path(str(Path(__file__).resolve().parent / "news" / "news_pipeline.py"), run_name="__main__")
else:
    import importlib
    import sys

    module_name = f"{__package__}.news.news_pipeline" if __package__ else "news.news_pipeline"
    sys.modules[__name__] = importlib.import_module(module_name)
