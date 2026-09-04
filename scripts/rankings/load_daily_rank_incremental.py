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
import json
import sys
from datetime import datetime
from pathlib import Path

import pymysql

SCRIPT_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(SCRIPT_DIR))

import load_daily_rank_to_starrocks as base  # noqa: E402


def query_existing_dates():
    """查询表里已有哪些统计日期（distinct dt）。"""
    conn = pymysql.connect(
        host=base.env("STARROCKS_MYSQL_HOST", "127.0.0.1"),
        port=int(base.env("STARROCKS_MYSQL_PORT", "9030")),
        user=base.STARROCKS_USER,
        password=base.STARROCKS_PASSWORD,
        database=base.STARROCKS_DB,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(f"SELECT DISTINCT `dt` FROM `{base.STARROCKS_TABLE}`")
            dates = set()
            for row in cur.fetchall():
                value = row[0]
                dates.add(value.isoformat() if hasattr(value, "isoformat") else str(value))
        return dates
    finally:
        conn.close()


def parse_args(argv):
    parser = argparse.ArgumentParser(description="增量加载 OpenGithubs 日榜到 StarRocks")
    parser.add_argument("--dry-run", action="store_true", help="只计算差异并预览，不真正写入")
    return parser.parse_args(argv)


def main(argv):
    args = parse_args(argv)

    # 1. 数据库已有日期
    db_dates = query_existing_dates()
    print(f"数据库已有日期：{len(db_dates)} 天" + (f"，最新 {max(db_dates)}" if db_dates else "（空表）"))

    # 2. 同步远程仓库，取全部日报日期
    print(f"拉取数据源：{base.RANK_REPO_URL}")
    base.ensure_repo()
    report_paths = base.find_reports(base.RANK_REPO_DIR)

    remote_dates = {base.date_from_path(p) for p in report_paths}
    missing = sorted(d for d in remote_dates if d not in db_dates)
    print(f"远程仓库日期：{len(remote_dates)} 天，最新 {max(remote_dates)}")
    print(f"缺少的天：{len(missing)} 天" + (f"（{missing[0]} ~ {missing[-1]}）" if missing else ""))

    if not missing:
        print("已是最新，无需增量加载")
        return 0

    # 3. 只解析缺少那几天的日报
    missing_set = set(missing)
    target_paths = [p for p in report_paths if base.date_from_path(p) in missing_set]

    crawled_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    rows = []
    for report_path in target_paths:
        content = report_path.read_text(encoding="utf-8", errors="replace")
        report = base.parse_report(content, str(report_path))
        rows.extend(base.to_star_rows(report, crawled_at))

    print(f"解析完成：{len(target_paths)} 份日报，共 {len(rows)} 条项目记录")

    if args.dry_run:
        print(json.dumps(rows[:50], ensure_ascii=False, indent=2))
        print(f"（仅预览前 50 行，共 {len(rows)} 行）")
        return 0

    if not rows:
        print("没有可加载的数据")
        return 0

    # 4. 增量写入
    loaded = 0
    for index, batch in enumerate(base.chunk(rows, base.BATCH_SIZE), start=1):
        result = base.stream_load(batch, f"incr_{index}")
        loaded += int(result.get("NumberLoadedRows", 0))
        print(f"批次 {index} 完成：加载 {result.get('NumberLoadedRows')} 行")

    print(f"增量完成，共加载 {loaded} 行 -> {base.STARROCKS_DB}.{base.STARROCKS_TABLE}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)
