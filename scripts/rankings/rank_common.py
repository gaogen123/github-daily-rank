#!/usr/bin/env python3
"""周榜 / 月榜加载的共享核心。

抽取周榜与月榜共用的能力：
- 环境变量读取、Stream Load、批量、增量日期对比
- 通用 Markdown 解析（h3 详情段落 + 纯表格降级），增长量字段名可参数化
- 通用全量 / 增量主流程 run()

各榜单通过 config 传入：仓库地址、缓存目录、表名、增长量字段名、
find_reports 与 parse_key 两个 callable。
"""

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

import pymysql
import requests

PROJECT_ROOT = Path(__file__).resolve().parents[2]
BATCH_SIZE = 5000


# --------------------------------------------------------------------------- #
# 环境变量
# --------------------------------------------------------------------------- #
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


STARROCKS_HTTP = env("STARROCKS_HTTP", "http://localhost:8040")
STARROCKS_USER = env("STARROCKS_USER", "root")
STARROCKS_PASSWORD = env("STARROCKS_PASSWORD", "")
STARROCKS_DB = env("STARROCKS_DB", "ods")


# --------------------------------------------------------------------------- #
# 纯工具
# --------------------------------------------------------------------------- #
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
    """增速 = 增长量 / (增长前 Star 数)，保留两位小数。"""
    if not growth:
        return 0
    return round((growth / max(total_stars - growth, 1)) * 100, 2)


def date_from_source(source, content):
    """从文件名或标题识别日报统计日期。"""
    filename_date = re.search(r"(\d{4})(\d{2})(\d{2})\.md$", source or "")
    if filename_date:
        return f"{filename_date.group(1)}-{filename_date.group(2)}-{filename_date.group(3)}"

    heading_date = re.search(r"^##\s+(\d{4})\.(\d{1,2})\.(\d{1,2})", content, re.M)
    if heading_date:
        return f"{heading_date.group(1)}-{int(heading_date.group(2)):02d}-{int(heading_date.group(3)):02d}"

    raise ValueError(f"无法从 {source or '日报'} 中识别统计日期")


def to_bigint_date(value):
    """'2025-03-08' -> 20250308；已为整数则原样返回。"""
    if value is None or value == "":
        return None
    if isinstance(value, int):
        return value
    return int(str(value).replace("-", ""))


def format_date_key(value):
    """bigint 20260905 -> '2026-09-05'；date/datetime 走 isoformat；其它原样转字符串。"""
    if hasattr(value, "isoformat"):
        return value.isoformat()
    s = str(value)
    if len(s) == 8 and s.isdigit():
        return f"{s[:4]}-{s[4:6]}-{s[6:]}"
    return s


def chunk(array, size):
    for index in range(0, len(array), size):
        yield array[index:index + size]


# --------------------------------------------------------------------------- #
# Markdown 解析（通用）
# --------------------------------------------------------------------------- #
def parse_report(content, date, growth_label):
    """解析周榜 / 月榜日报。

    growth_label：详情段落里的增长量字段名，如 '周Star增长量' 或 '月Star增长量'。
    返回 {'date': ..., 'projects': [{repo, url, name, description, stars, growth, openedAt}]}
    """
    projects = []

    # 1) h3 详情段落
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
        growth = read_metric(section, growth_label)

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
            "growth": growth,
            "openedAt": opened_at,
        })

    if projects:
        return {"date": date, "projects": projects}

    # 2) 纯表格降级（早期 2024 无 h3 详情段落）
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
        growth = parse_compact_number(cells[repo_cell_index + 2]) if repo_cell_index + 2 < len(cells) else 0
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
            "growth": growth,
            "openedAt": opened_at,
        })

    return {"date": date, "projects": projects}


def parse_daily_report(content, source=""):
    """解析日榜日报，保留日/周/月三个增长字段及其增速。

    兼容「详情段落(h3)」与「纯表格」两种格式。
    """
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

    # 降级：纯表格格式（早期日报无 h3 详情段落）
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


def daily_find_reports(repo_dir):
    reports = []
    for year in sorted(repo_dir.iterdir()):
        if not year.is_dir() or not re.fullmatch(r"20\d{2}", year.name):
            continue
        for month in sorted(year.iterdir()):
            if not month.is_dir() or not re.fullmatch(r"\d{2}", month.name):
                continue
            for filename in sorted(month.iterdir()):
                if re.fullmatch(r"\d{8}\.md", filename.name):
                    reports.append(filename)
    reports.sort()
    if not reports:
        raise ValueError("没有找到日报 Markdown 文件")
    return reports


def daily_parse_key(report_path):
    matched = re.search(r"(\d{4})(\d{2})(\d{2})\.md$", str(report_path))
    if matched:
        return f"{matched.group(1)}-{matched.group(2)}-{matched.group(3)}"
    raise ValueError(f"无法从 {report_path} 识别统计日期")


def daily_to_star_rows(report, crawled_at):
    rows = []
    for index, project in enumerate(report["projects"]):
        rows.append({
            "dt": to_bigint_date(report["date"]),
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


def to_star_rows(report, growth_field, crawled_at):
    rows = []
    for index, project in enumerate(report["projects"]):
        rows.append({
            "dt": to_bigint_date(report["date"]),
            "full_name": project["repo"],
            "rank_num": index + 1,
            "repo_url": project.get("url") or "",
            "repo_name": project.get("name") or "",
            "description": project.get("description") or "",
            "total_stars": project.get("stars") or 0,
            growth_field: project.get("growth") or 0,
            "opened_at": project.get("openedAt") or None,
            "crawled_at": crawled_at,
        })
    return rows


def get_git_proxy():
    """获取适用于 Git 命令的网络代理地址（优先读取环境变量，在容器内默认使用宿主机代理）。"""
    proxy = env("HTTPS_PROXY") or env("HTTP_PROXY") or env("https_proxy") or env("http_proxy")
    if not proxy and (Path("/.dockerenv").exists() or Path("/app/github-daily-rank").exists()):
        # Docker 容器环境下，默认回退到宿主机代理端口
        proxy = "http://host.docker.internal:7897"
    return proxy


def run_git_command(args, cwd=None, retries=3, delay=2):
    """执行 Git 命令，针对网络抖动支持自动重试，并自动附带代理参数避免网络握手失败。"""
    last_exc = None
    proxy = get_git_proxy()
    cmd = list(args)
    # 如果配置了代理，在 git 基础命令后注入 -c 代理配置，解决 sudo -u root -i 剥离环境变量的问题
    if proxy and cmd and cmd[0] == "git":
        proxy_flags = [
            "-c", f"http.proxy={proxy}",
            "-c", f"https.proxy={proxy}",
        ]
        cmd = [cmd[0]] + proxy_flags + cmd[1:]

    git_env = os.environ.copy()
    if proxy:
        git_env["http_proxy"] = proxy
        git_env["https_proxy"] = proxy
        git_env["HTTP_PROXY"] = proxy
        git_env["HTTPS_PROXY"] = proxy

    for attempt in range(1, retries + 1):
        try:
            return subprocess.run(
                cmd,
                cwd=str(cwd) if cwd else None,
                check=True,
                capture_output=True,
                text=True,
                env=git_env,
            )
        except subprocess.CalledProcessError as exc:
            last_exc = exc
            error_msg = (exc.stderr or exc.stdout or str(exc)).strip()
            if attempt < retries:
                print(f"[Git重试] 命令 {' '.join(cmd)} 失败（第 {attempt}/{retries} 次）：{error_msg}，{delay} 秒后重试...", file=sys.stderr)
                time.sleep(delay)
                delay *= 2
            else:
                print(f"[Git错误] 命令 {' '.join(cmd)} 最终失败：{error_msg}", file=sys.stderr)
    raise last_exc


def clean_directory(path):
    """彻底清空指定目录内的所有内容（含隐藏文件如 .DS_Store）。"""
    path = Path(path)
    if not path.exists():
        return
    for item in path.iterdir():
        if item.is_dir():
            shutil.rmtree(item, ignore_errors=True)
        else:
            try:
                item.unlink(missing_ok=True)
            except OSError:
                pass


def ensure_repo(repo_url, repo_dir, branch="main"):
    """确保本地存在目标 Git 仓库的最新代码。

    逻辑：
    1. 若已存在有效 .git，优先通过带重试的 fetch + reset 同步，避免因单次网络抖动粗暴删库。
    2. 若同步失败或本地目录损坏，彻底清理残余文件（避免挂载卷中 .DS_Store 导致非空目录无法 clone），再全新克隆。
    """
    repo_dir = Path(repo_dir)
    os.makedirs(repo_dir.parent, exist_ok=True)
    is_repo = (repo_dir / ".git").is_dir()

    if is_repo:
        try:
            # 优先采用 fetch + reset，支持网络重试且不会由于合并冲突导致 pull 失败
            run_git_command(["git", "-C", str(repo_dir), "fetch", "--depth", "1", "origin", branch])
            subprocess.run(["git", "-C", str(repo_dir), "reset", "--hard", f"origin/{branch}"], check=True)
            subprocess.run(["git", "-C", str(repo_dir), "clean", "-fd"], check=True)
            return
        except Exception as exc:
            print(f"现有仓库同步失败（{exc}），尝试清理并重新浅克隆...", file=sys.stderr)

    # 清理旧目录中残留的所有文件（彻底避免挂载卷上 .DS_Store 等导致 git clone 报 destination exists and is not empty）
    if repo_dir.exists():
        clean_directory(repo_dir)
        try:
            repo_dir.rmdir()
        except OSError:
            pass

    # 若目录已彻底删除则直接 clone；若目录仍存在（为空目录），在空目录中执行 clone
    clean_directory(repo_dir)
    run_git_command(["git", "clone", "--depth", "1", "--branch", branch, repo_url, str(repo_dir)])


def stream_load(rows, db, table, label_suffix=""):
    base = STARROCKS_HTTP.rstrip("/")
    url = f"{base}/api/{db}/{table}/_stream_load"
    auth = base64.b64encode(f"{STARROCKS_USER}:{STARROCKS_PASSWORD}".encode()).decode()
    label = f"rank_{int(time.time() * 1000)}_{label_suffix or random.randint(0, 999999)}"

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


def query_existing_dates(db, table, col="dt"):
    conn = pymysql.connect(
        host=env("STARROCKS_MYSQL_HOST", "127.0.0.1"),
        port=int(env("STARROCKS_MYSQL_PORT", "9030")),
        user=STARROCKS_USER,
        password=STARROCKS_PASSWORD,
        database=db,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(f"SELECT DISTINCT `{col}` FROM `{table}`")
            dates = set()
            for row in cur.fetchall():
                value = row[0]
                dates.add(format_date_key(value))
        return dates
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def run(config, incremental=False, dry_run=False, since=None):
    db = config.get("db", STARROCKS_DB)
    table = config["table"]
    parse = config.get("parse_report")
    to_rows = config.get("to_star_rows")

    print(f"拉取数据源：{config['repo_url']}")
    ensure_repo(config["repo_url"], config["repo_dir"])

    report_paths = config["find_reports"](config["repo_dir"])

    if since:
        report_paths = [p for p in report_paths if config["parse_key"](p) >= since]

    if incremental:
        existing = query_existing_dates(db, table)
        keys = {config["parse_key"](p) for p in report_paths}
        missing = sorted(k for k in keys if k not in existing)
        print(f"数据库已有：{len(existing)} 个周期" + (f"，最新 {max(existing)}" if existing else "（空表）"))
        print(f"远程仓库：{len(keys)} 个周期，最新 {max(keys)}")
        print(f"缺少的周期：{len(missing)} 个" + (f"（{missing[0]} ~ {missing[-1]}）" if missing else ""))
        if not missing:
            print("已是最新，无需增量加载")
            return
        missing_set = set(missing)
        report_paths = [p for p in report_paths if config["parse_key"](p) in missing_set]

    crawled_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    rows = []
    for report_path in report_paths:
        content = report_path.read_text(encoding="utf-8", errors="replace")
        if parse is not None:
            report = parse(content, str(report_path))
            rows.extend(to_rows(report, crawled_at))
        else:
            date = config["parse_key"](report_path)
            report = parse_report(content, date, config["growth_label"])
            rows.extend(to_star_rows(report, config["growth_field"], crawled_at))

    print(f"解析完成：{len(report_paths)} 份日报，共 {len(rows)} 条项目记录")

    if dry_run:
        print(json.dumps(rows[:50], ensure_ascii=False, indent=2))
        print(f"（仅预览前 50 行，共 {len(rows)} 行）")
        return

    if not rows:
        print("没有可加载的数据")
        return

    loaded = 0
    for index, batch in enumerate(chunk(rows, BATCH_SIZE), start=1):
        result = stream_load(batch, db, table, f"incr_{index}" if incremental else str(index))
        loaded += int(result.get("NumberLoadedRows", 0))
        print(f"批次 {index} 完成：加载 {result.get('NumberLoadedRows')} 行")

    print(f"完成，共加载 {loaded} 行 -> {db}.{table}")


DAILY_CONFIG = {
    "repo_url": "https://github.com/OpenGithubs/github-daily-rank.git",
    "repo_dir": PROJECT_ROOT / "storage" / "opengithubs-daily-rank",
    "table": "ods_repo_github_daily_rank_f_1d",
    "find_reports": daily_find_reports,
    "parse_key": daily_parse_key,
    "parse_report": parse_daily_report,
    "to_star_rows": daily_to_star_rows,
}
