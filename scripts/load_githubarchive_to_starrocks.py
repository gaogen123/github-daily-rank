#!/usr/bin/env python3
"""Compatibility entry point for scripts/github-archive/load_githubarchive_to_starrocks.py."""

from pathlib import Path

TARGET = Path(__file__).resolve().parent / "github-archive" / "load_githubarchive_to_starrocks.py"

if __name__ == "__main__":
    import runpy

    runpy.run_path(str(TARGET), run_name="__main__")
else:
    import importlib.util
    import sys

    spec = importlib.util.spec_from_file_location(f"{__name__}.__implementation__", TARGET)
    if spec is None or spec.loader is None:
        raise ImportError(f"无法加载兼容模块：{TARGET}")
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    sys.modules[__name__] = module
