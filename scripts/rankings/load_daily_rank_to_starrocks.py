#!/usr/bin/env python3
"""日榜全量加载：拉取 github-daily-rank，解析项目，写入 StarRocks。

表：ods.ods_repo_github_daily_rank_f_1d（主键模型 (dt, full_name)，按天分区）
用法：
  python3 scripts/rankings/load_daily_rank_to_starrocks.py
  python3 scripts/rankings/load_daily_rank_to_starrocks.py --since 2026-08-20
  python3 scripts/rankings/load_daily_rank_to_starrocks.py --dry-run --since 2026-08-20
"""

import argparse
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import rank_common as common  # noqa: E402


def parse_args(argv):
    parser = argparse.ArgumentParser(description="拉取 OpenGithubs 日榜并加载到 StarRocks")
    parser.add_argument("--since", metavar="YYYY-MM-DD", help="仅加载该日期及之后的日报")
    parser.add_argument("--dry-run", action="store_true", help="只解析并打印，不真正 Stream Load")
    return parser.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    common.run(common.DAILY_CONFIG, incremental=False, dry_run=args.dry_run, since=args.since)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)
