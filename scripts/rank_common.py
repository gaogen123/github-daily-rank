"""Compatibility alias for scripts/rankings/rank_common.py."""

import importlib
import sys

module_name = f"{__package__}.rankings.rank_common" if __package__ else "rankings.rank_common"
sys.modules[__name__] = importlib.import_module(module_name)
