#!/usr/bin/env python3
"""月榜全量加载：拉取 github-monthly-rank，解析项目，写入 StarRocks。

表：ods.ods_repo_github_monthly_rank_f_1m（主键模型 (dt, full_name)，按月分区）
用法：
  python3 scripts/rankings/load_monthly_rank_to_starrocks.py
  python3 scripts/rankings/load_monthly_rank_to_starrocks.py --dry-run
"""

import argparse
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import rank_common as common  # noqa: E402


def monthly_find_reports(repo_dir):
    reports = []
    for year in sorted(repo_dir.iterdir()):
        if not year.is_dir() or not re.fullmatch(r"20\d{2}", year.name):
            continue
        for filename in sorted(year.iterdir()):
            if filename.is_file() and re.fullmatch(r"\d{2}\.md", filename.name):
                reports.append(filename)
    reports.sort()
    if not reports:
        raise ValueError("没有找到月榜 Markdown 文件")
    return reports


def monthly_parse_key(report_path):
    matched = re.search(r"/(\d{4})/(\d{2})\.md$", str(report_path))
    if matched:
        return f"{matched.group(1)}-{matched.group(2)}-01"
    raise ValueError(f"无法从 {report_path} 识别月")


MONTHLY_CONFIG = {
    "repo_url": "https://github.com/OpenGithubs/github-monthly-rank.git",
    "repo_dir": SCRIPT_DIR.parent.parent / "storage" / "opengithubs-monthly-rank",
    "table": "ods_repo_github_monthly_rank_f_1m",
    "growth_label": "月Star增长量",
    "growth_field": "stars_month",
    "find_reports": monthly_find_reports,
    "parse_key": monthly_parse_key,
}


def main(argv):
    parser = argparse.ArgumentParser(description="月榜全量加载到 StarRocks")
    parser.add_argument("--dry-run", action="store_true", help="只解析并预览，不写入")
    args = parser.parse_args(argv)
    common.run(MONTHLY_CONFIG, incremental=False, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)
