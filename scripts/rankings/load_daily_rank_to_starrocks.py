#!/usr/bin/env python3
"""拉取 OpenGithubs/github-daily-rank 最新数据，解析每个项目，写入 StarRocks。

- 拉取：git clone/pull https://github.com/OpenGithubs/github-daily-rank.git
- 解析：兼容「详情段落(h3)」与「纯表格」两种日报格式（等价于 generate-data.mjs 的 parseReport）
- 入库：StarRocks Stream Load，主键模型按 (dt, full_name) upsert，表达式分区按天

依赖：requests
用法：
  python3 scripts/rankings/load_daily_rank_to_starrocks.py                 # 全量回填（幂等）
  python3 scripts/rankings/load_daily_rank_to_starrocks.py --since 2026-08-20
  python3 scripts/rankings/load_daily_rank_to_starrocks.py --dry-run --since 2026-08-20
"""

import argparse
import base64
import json
import os
import random
import re
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent

RANK_REPO_URL = "https://github.com/OpenGithubs/github-daily-rank.git"
RANK_REPO_DIR = PROJECT_ROOT / "storage" / "opengithubs-daily-rank"
BRANCH = "main"
BATCH_SIZE = 5000


def load_env_local(path=None):
    """读取项目根目录的 .env.local（不覆盖已存在的环境变量）。"""
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


RANK_REPO_URL = env("RANK_REPO_URL", RANK_REPO_URL)
RANK_REPO_DIR = Path(env("RANK_REPO_DIR", str(RANK_REPO_DIR)))

STARROCKS_HTTP = env("STARROCKS_HTTP", "http://localhost:8040")
STARROCKS_USER = env("STARROCKS_USER", "root")
STARROCKS_PASSWORD = env("STARROCKS_PASSWORD", "")
STARROCKS_DB = env("STARROCKS_DB", "ods")
STARROCKS_TABLE = env("STARROCKS_TABLE", "ods_repo_github_daily_rank_f_1d")


def parse_compact_number(value):
    """'25,845' -> 25845，'12.3k' -> 12300，'1.2m' -> 1200000，'🔺328' -> 328。"""
    if not value:
        return 0
    normalized = re.sub(r"[^ -~]", "", str(value).lower().replace(",", ""))
    matched = re.match(r"([\d.]+)\s*([km]?)", normalized)
    if not matched:
        return 0
    number = float(matched.group(1))
    multiplier = {"": 1, "k": 1_000, "m": 1_000_000}[matched.group(2)]
    return int(round(number * multiplier))


def read_metric(section, label):
    matched = re.search(rf"{re.escape(label)}：\s*([\d.,]+(?:[kKmM])?)", section)
    return parse_compact_number(matched.group(1)) if matched else 0


def strip_tags(value):
    return re.sub(r"\s+", " ", re.sub(r"<[^>]*>", " ", value)).strip()


def calculate_rate(total_stars, growth):
    if not growth:
        return 0
    return round((growth / max(total_stars - growth, 1)) * 100, 2)


def date_from_source(source, content):
    filename_date = re.search(r"(\d{4})(\d{2})(\d{2})\.md$", source)
    if filename_date:
        return f"{filename_date.group(1)}-{filename_date.group(2)}-{filename_date.group(3)}"

    heading_date = re.search(r"^##\s+(\d{4})\.(\d{1,2})\.(\d{1,2})", content, re.M)
    if heading_date:
        return f"{heading_date.group(1)}-{int(heading_date.group(2)):02d}-{int(heading_date.group(3)):02d}"

    raise ValueError(f"无法从 {source or '日报'} 中识别统计日期")


def parse_report(content, source=""):
    date = date_from_source(source, content)
    projects = []

    sections = re.split(r"(?=<h3\b)", content, flags=re.I)
    for section in sections:
        if not section.startswith("<h3"):
            continue
        end = section.find("</h3>")
        heading = strip_tags(section[: end + 5] if end != -1 else section)
        repo_match = re.search(r"https://github\.com/([\w.-]+/[\w.-]+)", heading, re.I)
        if not repo_match:
            continue

        repo = repo_match.group(1)
        stars = read_metric(section, "总星标数量")
        daily_growth = read_metric(section, "日增长数量")
        weekly_growth = read_metric(section, "上周增长数量")
        monthly_growth = read_metric(section, "上月增长数量")

        opened_at_match = re.search(r"开源时间：\s*(\d{4}-\d{2}-\d{2})", section)
        opened_at = opened_at_match.group(1) if opened_at_match else ""

        description_match = re.search(r"项目描述：\s*([^\r\n<]*)", section)
        description = description_match.group(1).strip() if description_match else ""

        name = re.sub(r"^\d+\.\s*", "", heading)
        name = re.sub(r"https://github\.com/[\w.-]+/[\w.-]+", "", name, flags=re.I).strip()

        projects.append({
            "repo": repo,
            "url": f"https://github.com/{repo}",
            "name": name,
            "description": description,
            "stars": stars,
            "dailyGrowth": daily_growth,
            "weeklyGrowth": weekly_growth,
            "monthlyGrowth": monthly_growth,
            "dailyRate": calculate_rate(stars, daily_growth),
            "weeklyRate": calculate_rate(stars, weekly_growth),
            "monthlyRate": calculate_rate(stars, monthly_growth),
            "openedAt": opened_at,
        })

    exact_best_stars = re.search(r"总星标数量：\s*([\d,]+)⭐", content)
    if projects and exact_best_stars:
        stars = parse_compact_number(exact_best_stars.group(1))
        projects[0]["stars"] = stars
        projects[0]["dailyRate"] = calculate_rate(stars, projects[0]["dailyGrowth"])
        projects[0]["weeklyRate"] = calculate_rate(stars, projects[0]["weeklyGrowth"])
        projects[0]["monthlyRate"] = calculate_rate(stars, projects[0]["monthlyGrowth"])

    if projects:
        return {"date": date, "source": source, "projects": projects}

    # 降级：纯表格格式（早期 2024 日报无 h3 详情段落）
    for line in content.splitlines():
        if not line.strip().startswith("|") or "github.com/" not in line:
            continue
        cells = [cell.strip() for cell in line.split("|")]
        repo_cell_index = next(
            (i for i, cell in enumerate(cells) if re.search(r"github\.com/[\w.-]+/[\w.-]+", cell, re.I)),
            -1,
        )
        if repo_cell_index < 0:
            continue
        repo_match = re.search(r"github\.com/([\w.-]+/[\w.-]+)", cells[repo_cell_index], re.I)
        if not repo_match:
            continue

        repo = repo_match.group(1)
        stars = parse_compact_number(cells[repo_cell_index + 1]) if repo_cell_index + 1 < len(cells) else 0
        daily_growth = parse_compact_number(cells[repo_cell_index + 2]) if repo_cell_index + 2 < len(cells) else 0
        weekly_growth = parse_compact_number(cells[repo_cell_index + 3]) if repo_cell_index + 3 < len(cells) else 0
        opened_at_match = re.search(r"\d{4}-\d{2}-\d{2}", line)
        opened_at = opened_at_match.group(0) if opened_at_match else ""

        if not stars:
            continue

        projects.append({
            "repo": repo,
            "url": f"https://github.com/{repo}",
            "name": "",
            "description": "",
            "stars": stars,
            "dailyGrowth": daily_growth,
            "weeklyGrowth": weekly_growth,
            "monthlyGrowth": 0,
            "dailyRate": calculate_rate(stars, daily_growth),
            "weeklyRate": calculate_rate(stars, weekly_growth),
            "monthlyRate": 0,
            "openedAt": opened_at,
        })

    return {"date": date, "source": source, "projects": projects}


def find_reports(root):
    reports = []
    root = Path(root)
    for year in sorted(os.listdir(root)):
        year_path = root / year
        if not year_path.is_dir() or not re.fullmatch(r"20\d{2}", year):
            continue
        for month in sorted(os.listdir(year_path)):
            month_path = year_path / month
            if not month_path.is_dir() or not re.fullmatch(r"\d{2}", month):
                continue
            for filename in sorted(os.listdir(month_path)):
                if re.fullmatch(r"\d{8}\.md", filename):
                    reports.append(month_path / filename)
    reports.sort()
    if not reports:
        raise ValueError("没有找到日报 Markdown 文件")
    return reports


def ensure_repo():
    os.makedirs(RANK_REPO_DIR.parent, exist_ok=True)
    is_repo = (RANK_REPO_DIR / ".git").is_dir()
    if is_repo:
        try:
            subprocess.run(
                ["git", "-C", str(RANK_REPO_DIR), "pull", "--ff-only", "origin", BRANCH],
                check=True,
            )
            return
        except subprocess.CalledProcessError as exc:
            print(f"增量拉取失败，改用全新浅克隆：{exc}", file=sys.stderr)

    shutil.rmtree(RANK_REPO_DIR, ignore_errors=True)
    subprocess.run(
        ["git", "clone", "--depth", "1", "--branch", BRANCH, RANK_REPO_URL, str(RANK_REPO_DIR)],
        check=True,
    )


def date_from_path(report_path):
    matched = re.search(r"(\d{4})(\d{2})(\d{2})\.md$", str(report_path))
    return f"{matched.group(1)}-{matched.group(2)}-{matched.group(3)}" if matched else ""


def to_star_rows(report, crawled_at):
    rows = []
    for index, project in enumerate(report["projects"]):
        rows.append({
            "dt": report["date"],
            "full_name": project["repo"],
            "rank_num": index + 1,
            "repo_url": project.get("url") or "",
            "repo_name": project.get("name") or "",
            "description": project.get("description") or "",
            "total_stars": project.get("stars") or 0,
            "stars_today": project.get("dailyGrowth") or 0,
            "stars_week": project.get("weeklyGrowth") or 0,
            "stars_month": project.get("monthlyGrowth") or 0,
            "daily_growth_rate": project.get("dailyRate", 0),
            "weekly_growth_rate": project.get("weeklyRate", 0),
            "monthly_growth_rate": project.get("monthlyRate", 0),
            "opened_at": project.get("openedAt") or None,
            "crawled_at": crawled_at,
        })
    return rows


def stream_load(rows, label_suffix=""):
    base = STARROCKS_HTTP.rstrip("/")
    url = f"{base}/api/{STARROCKS_DB}/{STARROCKS_TABLE}/_stream_load"
    auth = base64.b64encode(f"{STARROCKS_USER}:{STARROCKS_PASSWORD}".encode()).decode()
    label = f"daily_rank_{int(time.time() * 1000)}_{label_suffix or random.randint(0, 999999)}"

    resp = requests.put(
        url,
        headers={
            "Authorization": f"Basic {auth}",
            "label": label,
            "format": "json",
            "strip_outer_array": "true",
            "Content-Type": "application/json",
        },
        data=json.dumps(rows, ensure_ascii=False),
        timeout=60,
    )
    result = resp.json()
    if not resp.ok or result.get("Status") != "Success":
        raise RuntimeError(f"Stream Load 失败: HTTP {resp.status_code} {json.dumps(result, ensure_ascii=False)[:300]}")
    return result


def chunk(array, size):
    for index in range(0, len(array), size):
        yield array[index:index + size]


def parse_args(argv):
    parser = argparse.ArgumentParser(description="拉取 OpenGithubs 日榜并加载到 StarRocks")
    parser.add_argument("--since", metavar="YYYY-MM-DD", help="仅加载该日期及之后的日报")
    parser.add_argument("--dry-run", action="store_true", help="只解析并打印，不真正 Stream Load")
    return parser.parse_args(argv)


def main(argv):
    args = parse_args(argv)

    print(f"拉取数据源：{RANK_REPO_URL}")
    ensure_repo()

    report_paths = find_reports(RANK_REPO_DIR)
    if args.since:
        report_paths = [p for p in report_paths if date_from_path(p) >= args.since]

    if not report_paths:
        print("没有匹配的日报文件")
        return 0

    crawled_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    rows = []
    for report_path in report_paths:
        # 个别日报混入非 UTF-8 字节，用 replace 容忍（与 Node readFile('utf8') 行为一致）
        content = report_path.read_text(encoding="utf-8", errors="replace")
        report = parse_report(content, str(report_path))
        rows.extend(to_star_rows(report, crawled_at))

    print(f"解析完成：{len(report_paths)} 份日报，共 {len(rows)} 条项目记录")

    if args.dry_run:
        print(json.dumps(rows[:50], ensure_ascii=False, indent=2))
        print(f"（仅预览前 50 行，共 {len(rows)} 行）")
        return 0

    if not rows:
        print("没有可加载的数据")
        return 0

    loaded = 0
    for index, batch in enumerate(chunk(rows, BATCH_SIZE), start=1):
        result = stream_load(batch, str(index))
        loaded += int(result.get("NumberLoadedRows", 0))
        print(
            f"批次 {index} 完成：Label={result.get('Label')} "
            f"总行数={result.get('NumberTotalRows')} 加载={result.get('NumberLoadedRows')}"
        )
    print(f"全部完成，共加载 {loaded} 行 -> {STARROCKS_DB}.{STARROCKS_TABLE}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)
