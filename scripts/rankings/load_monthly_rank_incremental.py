#!/usr/bin/env python3
"""月榜增量加载：只补数据库缺少的月。

用法：
  python3 scripts/rankings/load_monthly_rank_incremental.py
  python3 scripts/rankings/load_monthly_rank_incremental.py --dry-run
"""

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import rank_common as common  # noqa: E402
from load_monthly_rank_to_starrocks import MONTHLY_CONFIG  # noqa: E402


def main(argv):
    parser = argparse.ArgumentParser(description="月榜增量加载到 StarRocks")
    parser.add_argument("--dry-run", action="store_true", help="只计算差异并预览，不写入")
    args = parser.parse_args(argv)
    common.run(MONTHLY_CONFIG, incremental=True, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)
