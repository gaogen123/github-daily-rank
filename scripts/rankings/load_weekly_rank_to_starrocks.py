#!/usr/bin/env python3
"""周榜全量加载：拉取 github-weekly-rank，解析项目，写入 StarRocks。

表：ods.ods_repo_github_weekly_rank_f_1w（主键模型 (dt, full_name)，按周分区）
用法：
  python3 scripts/rankings/load_weekly_rank_to_starrocks.py
  python3 scripts/rankings/load_weekly_rank_to_starrocks.py --dry-run
"""

import argparse
import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import rank_common as common  # noqa: E402


def weekly_find_reports(repo_dir):
    reports = []
    for year in sorted(repo_dir.iterdir()):
        if not year.is_dir() or not re.fullmatch(r"20\d{2}", year.name):
            continue
        for month in sorted(year.iterdir()):
            if not month.is_dir() or not re.fullmatch(r"\d{2}", month.name):
                continue
            for filename in sorted(month.iterdir()):
                if re.fullmatch(r"\d{8}\.md", filename.name) or \
                        re.fullmatch(r"\d{1,2}\.\d{1,2}-\d{1,2}\.\d{1,2}\.md", filename.name):
                    reports.append(filename)
    reports.sort()
    if not reports:
        raise ValueError("没有找到周榜 Markdown 文件")
    return reports


def weekly_parse_key(report_path):
    s = str(report_path)
    matched = re.search(r"(\d{4})(\d{2})(\d{2})\.md$", s)
    if matched:
        return f"{matched.group(1)}-{matched.group(2)}-{matched.group(3)}"
    matched = re.search(r"/(\d{4})/\d{2}/\d{1,2}\.\d{1,2}-(\d{1,2})\.(\d{1,2})\.md$", s)
    if matched:
        return f"{matched.group(1)}-{int(matched.group(2)):02d}-{int(matched.group(3)):02d}"
    raise ValueError(f"无法从 {s} 识别周")


WEEKLY_CONFIG = {
    "repo_url": "https://github.com/OpenGithubs/github-weekly-rank.git",
    "repo_dir": SCRIPT_DIR.parent.parent / "storage" / "opengithubs-weekly-rank",
    "table": "ods_repo_github_weekly_rank_f_1w",
    "growth_label": "周Star增长量",
    "growth_field": "stars_week",
    "find_reports": weekly_find_reports,
    "parse_key": weekly_parse_key,
}


def main(argv):
    parser = argparse.ArgumentParser(description="周榜全量加载到 StarRocks")
    parser.add_argument("--dry-run", action="store_true", help="只解析并预览，不写入")
    args = parser.parse_args(argv)
    common.run(WEEKLY_CONFIG, incremental=False, dry_run=args.dry_run)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)
