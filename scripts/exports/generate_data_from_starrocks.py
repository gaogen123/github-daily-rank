#!/usr/bin/env python3
"""从 StarRocks 生成前端 dashboard 所需 public/data JSON。

替代 generate-data.mjs 的本地 Markdown 解析，改为直接查询
ods.ods_repo_github_daily_rank_f_1d，产出与原来完全兼容的：

- public/data/dates.json         {latest, dates[]}
- public/data/rankings.json      最新一天的报告
- public/data/reports/{date}.json  每天的报告
- public/data/projects.json      {projects[]} 全库项目索引（含 firstSeen/lastSeen）

依赖：pymysql
用法：
  python3 scripts/exports/generate_data_from_starrocks.py
"""

import json
import os
import sys
from collections import defaultdict
from pathlib import Path

import pymysql

PROJECT_ROOT = Path(__file__).resolve().parents[2]


def load_env_local(path=None):
    env = {}
    env_path = path or PROJECT_ROOT / ".env.local"
    try:
        for raw in env_path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            if key and not os.environ.get(key):
                env[key] = value.strip().strip("'\"")
    except FileNotFoundError:
        pass
    return env


_ENV = load_env_local()


def env(name, default=""):
    return os.environ.get(name) or _ENV.get(name) or default


STARROCKS_MYSQL_HOST = env("STARROCKS_MYSQL_HOST", "127.0.0.1")
STARROCKS_MYSQL_PORT = int(env("STARROCKS_MYSQL_PORT", "9030"))
STARROCKS_USER = env("STARROCKS_USER", "root")
STARROCKS_PASSWORD = env("STARROCKS_PASSWORD", "")
STARROCKS_DB = env("STARROCKS_DB", "ods")
STARROCKS_TABLE = env("STARROCKS_TABLE", "ods_repo_github_daily_rank_f_1d")


def query_rows():
    conn = pymysql.connect(
        host=STARROCKS_MYSQL_HOST,
        port=STARROCKS_MYSQL_PORT,
        user=STARROCKS_USER,
        password=STARROCKS_PASSWORD,
        database=STARROCKS_DB,
        cursorclass=pymysql.cursors.DictCursor,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                f"""
                SELECT dt, full_name, rank_num, repo_url, repo_name, description,
                       total_stars, stars_today, stars_week, stars_month,
                       daily_growth_rate, weekly_growth_rate, monthly_growth_rate, opened_at
                FROM `{STARROCKS_TABLE}`
                ORDER BY dt, rank_num
                """
            )
            return cur.fetchall()
    finally:
        conn.close()


def to_project(row):
    repo = row["full_name"]
    return {
        "repo": repo,
        "url": row["repo_url"] or f"https://github.com/{repo}",
        "name": row["repo_name"] or "",
        "description": row["description"] or "",
        "stars": int(row["total_stars"] or 0),
        "dailyGrowth": int(row["stars_today"] or 0),
        "weeklyGrowth": int(row["stars_week"] or 0),
        "monthlyGrowth": int(row["stars_month"] or 0),
        "dailyRate": float(row["daily_growth_rate"] or 0),
        "weeklyRate": float(row["weekly_growth_rate"] or 0),
        "monthlyRate": float(row["monthly_growth_rate"] or 0),
        "openedAt": row["opened_at"].isoformat() if row["opened_at"] else "",
    }


def build_project_index(dates, reports_by_date):
    """复刻 generate-data.mjs 的 projectIndex 聚合逻辑：
    按日期升序遍历，后出现的覆盖前面的；name/description 取最新非空值。"""
    project_index = {}
    for date in dates:
        for project in reports_by_date[date]:
            existing = project_index.get(project["repo"])
            project_index[project["repo"]] = {
                **project,
                "name": project["name"] or (existing["name"] if existing else ""),
                "description": project["description"] or (existing["description"] if existing else ""),
                "firstSeen": existing["firstSeen"] if existing else date,
                "lastSeen": date,
            }
    return sorted(project_index.values(), key=lambda p: -p["stars"])


def main():
    rows = query_rows()
    if not rows:
        print("StarRocks 中没有数据，请先运行日榜加载脚本")
        return 1

    reports_by_date = defaultdict(list)
    for row in rows:
        dt = row["dt"].isoformat()
        reports_by_date[dt].append(to_project(row))

    dates = sorted(reports_by_date.keys())
    latest = dates[-1]

    data_dir = PROJECT_ROOT / "public" / "data"
    reports_dir = data_dir / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)

    # 清理旧 report 文件，避免残留已不存在的日期
    for old in reports_dir.glob("*.json"):
        old.unlink()

    # 1) 每天报告 + 2) 最新一天 rankings
    for date in dates:
        report = {"date": date, "projects": reports_by_date[date]}
        (reports_dir / f"{date}.json").write_text(
            json.dumps(report, ensure_ascii=False) + "\n", encoding="utf-8"
        )

    latest_report = {"date": latest, "projects": reports_by_date[latest]}
    (data_dir / "rankings.json").write_text(
        json.dumps(latest_report, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    # 3) dates.json
    (data_dir / "dates.json").write_text(
        json.dumps({"latest": latest, "dates": dates}, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    # 4) projects.json
    projects = build_project_index(dates, reports_by_date)
    (data_dir / "projects.json").write_text(
        json.dumps({"projects": projects}, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    print(f"已生成 {len(dates)} 份单日报和 {len(projects)} 个全库项目，最新日期：{latest}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)
