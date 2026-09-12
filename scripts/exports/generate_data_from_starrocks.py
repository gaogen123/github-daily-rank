#!/usr/bin/env python3
"""从 StarRocks 生成前端 dashboard 所需 public/data JSON。

最新榜单读取 ads.ads_github_trend_rank_f，项目元数据读取 ADS 仓库表。
历史榜单使用 DWD 明细和 ODS 日榜，产出：

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

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'shared'))
from project_catalog import load_catalog

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


def format_dt(value):
    """bigint 20260905 -> '2026-09-05'；date/datetime 则走 isoformat。"""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    s = str(value)
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    return s


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



def query_table(table):
    conn = pymysql.connect(
        host=STARROCKS_MYSQL_HOST, port=STARROCKS_MYSQL_PORT,
        user=STARROCKS_USER, password=STARROCKS_PASSWORD,
        cursorclass=pymysql.cursors.DictCursor,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(f"SELECT * FROM {table}")
            return cur.fetchall()
    finally:
        conn.close()


PERIODS = {"daily_rank": "daily", "weekly_rank": "weekly", "monthly_rank": "monthly"}


def build_boards(rows):
    boards = {}
    for row in rows:
        kind = row["sort_type"]
        date = format_dt(row["dt"])
        board = boards.setdefault(kind, {"date": date, "projects": []})
        if date != board["date"]:
            raise ValueError(f"榜单 {kind} 包含不同日期")
        project = {
            "repo": row["full_name"], "url": row["repo_url"] or f'https://github.com/{row["full_name"]}',
            "name": row["repo_name"] or "", "description": row["description"] or "",
            "stars": int(row["total_stars"] or 0),
            "openedAt": format_dt(row["opened_at"]) if row["opened_at"] else "",
            "rank": row["rank_num"], "growth": row["growth"],
        }
        period = PERIODS.get(kind)
        if period:
            project[period + "Growth"] = row["growth"]
            project[period + "Rate"] = float(row["growth_rate"]) if row["growth_rate"] is not None else None
        board["projects"].append(project)
    for board in boards.values():
        board["projects"].sort(key=lambda p: (p["rank"], p["repo"]))
    return boards


def write_json(path, value):
    temporary = path.with_suffix(".json.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, default=float) + "\n", encoding="utf-8")
    temporary.replace(path)



def merge_metrics(projects, rows):
    # 同一项目有多天记录；仅用比现有仓库快照更新的实际采集结果。
    for row in sorted(rows, key=lambda r: (str(r["fetched_at"] or ""), r["dt"])):
        repo = row["repo"]
        existing = projects.get(repo, {})
        fetched = row["fetched_at"].isoformat() if row["fetched_at"] else ""
        if not fetched or fetched < existing.get("fetchedAt", ""):
            continue
        growth = row["source_star_delta_1d"]
        stars = row["stars"]
        projects[repo] = {
            **existing, "repo": repo, "url": row["github_url"] or existing.get("url", f"https://github.com/{repo}"),
            "name": existing.get("name", ""), "description": row["description"] or existing.get("description", ""),
            "homepage": row["homepage"] or existing.get("homepage", ""),
            "stars": stars, "forks": row["forks"],
            "dailyGrowth": growth, "weeklyGrowth": row["source_star_delta_7d"],
            "monthlyGrowth": row["source_star_delta_30d"],
            "dailyRate": 100 * growth / (stars - growth) if growth is not None and stars is not None and stars > growth else None,
            "openedAt": format_dt(row["created_at"].date()) if row["created_at"] else existing.get("openedAt", ""),
            "firstSeen": existing.get("firstSeen", ""), "lastSeen": existing.get("lastSeen", ""),
            "fetchedAt": fetched, "updatedAt": fetched[:10],
        }
    return projects


def main():
    rows = query_rows()
    ads_rows = query_table("ads.ads_github_trend_rank_f")
    if not ads_rows:
        raise ValueError("ADS 榜单为空，保留现有网站数据")
    boards = build_boards(ads_rows)
    latest = max(board["date"] for board in boards.values())
    reports_by_date = defaultdict(list)
    for row in rows:
        reports_by_date[format_dt(row["dt"])].append(to_project(row))
    reports = {date: {"date": date, "projects": projects} for date, projects in reports_by_date.items()}
    history = defaultdict(list)
    for row in query_table("dwd.dwd_github_trend_rank_f_1d"):
        history[format_dt(row["dt"])].append(row)
    for date, items in history.items():
        report = reports.setdefault(date, {"date": date, "projects": []})
        report["boards"] = build_boards(items)
    # 最新页展示各榜单的最新一期；每个榜单保留自己的真实统计日期。
    latest_report = {"date": latest, "projects": reports_by_date.get(latest, []), "boards": boards, "source": "ads"}
    reports[latest] = latest_report
    dates = sorted(reports)
    projects = {p["repo"]: p for p in build_project_index(sorted(reports_by_date), reports_by_date)}
    for row in query_table("ads.ads_github_trend_repo_f"):
        repo = row["full_name"]
        existing = projects.get(repo, {})
        projects[repo] = {
            **existing, "repo": repo, "url": row["repo_url"] or f"https://github.com/{repo}",
            "name": row["repo_name"] or existing.get("name", ""),
            "description": row["description"] or existing.get("description", ""),
            "stars": int(row["stargazers_count"] or 0), "homepage": row["homepage"] or "",
            "openGraphImageUrl": row["open_graph_image_url"],
            "usesCustomOpenGraphImage": bool(row["uses_custom_open_graph_image"]) if row["uses_custom_open_graph_image"] is not None else None,
            "imageFetchedAt": row["image_fetched_at"].isoformat() if row["image_fetched_at"] else None,
            "openedAt": format_dt(row["created_at"].date()) if row["created_at"] else existing.get("openedAt", ""),
            "firstSeen": existing.get("firstSeen", ""), "lastSeen": existing.get("lastSeen", ""),
            "updatedAt": row["fetched_at"].isoformat()[:10] if row["fetched_at"] else "",
            "fetchedAt": row["fetched_at"].isoformat() if row["fetched_at"] else "",
        }
    merge_metrics(projects, query_table("dwd.dwd_github_repo_metrics_f_1d"))
    conn = pymysql.connect(
        host=STARROCKS_MYSQL_HOST, port=STARROCKS_MYSQL_PORT,
        user=STARROCKS_USER, password=STARROCKS_PASSWORD,
        cursorclass=pymysql.cursors.DictCursor,
    )
    try:
        inventory = load_catalog(conn)
    finally:
        conn.close()
    projects = {repo.lower(): {**project, "repo": repo.lower()} for repo, project in projects.items()}
    for repo, project in inventory.items():
        projects.setdefault(repo, project)
    data_dir = PROJECT_ROOT / "public" / "data"
    reports_dir = data_dir / "reports"
    reports_dir.mkdir(parents=True, exist_ok=True)
    for date, report in reports.items():
        write_json(reports_dir / f"{date}.json", report)
    write_json(data_dir / "rankings.json", latest_report)
    write_json(data_dir / "projects.json", {"projects": sorted(projects.values(), key=lambda p: -p["stars"])})
    write_json(data_dir / "dates.json", {"latest": latest, "dates": dates})
    print(f"已导出 ADS 最新榜单 {latest}，{len(boards)} 种榜单，{len(projects)} 个项目")
    return 0


if __name__ == "__main__":
    sys.exit(main())
