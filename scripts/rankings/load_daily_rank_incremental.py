#!/usr/bin/env python3
"""增量加载 OpenGithubs 日榜到 StarRocks。

对比数据库已有日期与远程仓库日报日期，只把「缺少的天」的项目增量写入。
主键模型 (dt, full_name) upsert，重复执行幂等。

依赖：requests、pymysql
用法：
  python3 scripts/rankings/load_daily_rank_incremental.py
  python3 scripts/rankings/load_daily_rank_incremental.py --dry-run
"""

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import rank_common as common  # noqa: E402


def parse_args(argv):
    parser = argparse.ArgumentParser(description="增量加载 OpenGithubs 日榜到 StarRocks")
    parser.add_argument("--dry-run", action="store_true", help="只计算差异并预览，不真正写入")
    return parser.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    common.run(common.DAILY_CONFIG, incremental=True, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)
