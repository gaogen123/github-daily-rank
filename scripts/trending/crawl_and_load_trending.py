#!/usr/bin/env python3
"""抓取 GitHub Trending（Firecrawl）并加载到 StarRocks。

- 抓取：Firecrawl /v2/scrape 的 json 格式，按 schema 结构化提取
- 清洗：千分位/缩写 star 数转整数、crawledAt -> dt + DATETIME
- 入库：StarRocks Stream Load，主键模型按 (dt, full_name) upsert，保留所有分区

依赖：requests
用法：
  python3 scripts/trending/crawl_and_load_trending.py --since daily
  python3 scripts/trending/crawl_and_load_trending.py --from-file public/data/trending.json --dry-run
"""

import argparse
import base64
import json
import os
import random
import re
import sys
import time
from datetime import datetime
from pathlib import Path

import requests

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent

TRENDING_SCHEMA = {
    "type": "object",
    "properties": {
        "repositories": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "rank": {"type": "number", "description": "榜单排名，从 1 开始"},
                    "fullName": {"type": "string", "description": "仓库完整名 owner/name"},
                    "url": {"type": "string", "description": "仓库地址"},
                    "description": {"type": "string"},
                    "language": {"type": "string"},
                    "totalStars": {"type": "string", "description": "总 star 数（如 12.3k）"},
                    "starsToday": {"type": "string", "description": "今日新增 star 数（如 1,234）"},
                },
                "required": ["fullName", "url"],
            },
        }
    },
    "required": ["repositories"],
}


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


FIRECRAWL_API_KEY = env("FIRECRAWL_API_KEY")
FIRECRAWL_API_URL = env("FIRECRAWL_API_URL", "https://api.firecrawl.dev")
STARROCKS_HTTP = env("STARROCKS_HTTP", "http://localhost:8040")  # BE HTTP 端口，Stream Load 直接发到 BE，避免 FE 307 重定向丢鉴权
STARROCKS_USER = env("STARROCKS_USER", "root")
STARROCKS_PASSWORD = env("STARROCKS_PASSWORD", "")
STARROCKS_DB = env("STARROCKS_DB", "ods")

# --since 与目标表名的映射（STARROCKS_TABLE 环境变量可覆盖）
SINCE_TO_TABLE = {
    "daily": "ods_crawl_day_github_trending_f_1d",
    "weekly": "ods_crawl_week_github_trending_f_1d",
    "monthly": "ods_crawl_mon_github_trending_f_1d",
}


def table_for(since):
    override = os.environ.get("STARROCKS_TABLE") or _ENV.get("STARROCKS_TABLE")
    return override or SINCE_TO_TABLE.get(since, SINCE_TO_TABLE["daily"])


def parse_args(argv):
    parser = argparse.ArgumentParser(description="抓取 GitHub Trending 并加载到 StarRocks")
    parser.add_argument("--since", choices=["daily", "weekly", "monthly"], default="daily")
    parser.add_argument("--dt", metavar="DATE", help="数据写入的分区日期（yyyy-MM-dd 或 yyyyMMdd），默认当天")
    parser.add_argument("--from-file", metavar="PATH", help="不重新抓取，加载已有抓取结果 JSON")
    parser.add_argument("--dry-run", action="store_true", help="只转换不写入")
    return parser.parse_args(argv)


def parse_compact_number(value):
    """'25,845' -> 25845，'12.3k' -> 12300，'1.2m' -> 1200000。"""
    if not value:
        return 0
    normalized = re.sub(r"[^\d.]", "", str(value).lower())
    matched = re.match(r"([\d.]+)([km]?)", normalized)
    if not matched:
        return 0
    number = float(matched.group(1))
    multiplier = {"": 1, "k": 1_000, "m": 1_000_000}[matched.group(2)]
    return int(round(number * multiplier))


def normalize_dt(value):
    """把日期参数规范化成 yyyy-MM-dd，兼容 yyyyMMdd 与 yyyy-MM-dd。"""
    value = str(value).strip()
    matched = re.fullmatch(r"(\d{4})(\d{2})(\d{2})", value)
    if matched:
        return f"{matched.group(1)}-{matched.group(2)}-{matched.group(3)}"
    matched = re.fullmatch(r"(\d{4})-(\d{2})-(\d{2})", value)
    if matched:
        return f"{matched.group(1)}-{matched.group(2)}-{matched.group(3)}"
    raise ValueError(f"非法日期: {value}，应为 yyyy-MM-dd 或 yyyyMMdd")


def to_star_rows(extract, since, dt=None):
    """把抓取结果转成表结构对应的行。dt 默认取抓取当天，可用 --dt 指定。"""
    crawled_at = datetime.now()
    dt = normalize_dt(dt) if dt else crawled_at.strftime("%Y-%m-%d")
    rows = []
    for index, repo in enumerate(extract.get("repositories", [])):
        rows.append(
            {
                "dt": dt,
                "full_name": repo.get("fullName"),
                "rank_num": repo.get("rank") or (index + 1),
                "repo_url": repo.get("url"),
                "description": repo.get("description") or "",
                "language": repo.get("language") or "",
                "total_stars": parse_compact_number(repo.get("totalStars")),
                "stars_today": parse_compact_number(repo.get("starsToday")),
                "crawled_at": crawled_at.strftime("%Y-%m-%d %H:%M:%S"),
            }
        )
    return rows


def scrape_trending_markdown(since):
    """抓取 GitHub Trending 页面的完整 markdown（全量仓库，非 LLM 提取，避免截断）。"""
    headers = {"Content-Type": "application/json"}
    if FIRECRAWL_API_KEY:
        headers["Authorization"] = f"Bearer {FIRECRAWL_API_KEY}"

    body = {
        "url": f"https://github.com/trending?since={since}",
        "formats": ["markdown"],
        "onlyMainContent": False,
        "timeout": 60000,
    }

    resp = requests.post(
        f"{FIRECRAWL_API_URL.rstrip('/')}/v2/scrape",
        headers=headers,
        json=body,
        timeout=90,
    )
    resp.raise_for_status()
    payload = resp.json()
    if not payload.get("success"):
        raise RuntimeError(f"Firecrawl 抓取失败: {json.dumps(payload, ensure_ascii=False)[:300]}")
    return ((payload.get("data") or {}).get("markdown") or "")


def parse_trending_markdown(md):
    """解析 GitHub Trending markdown，返回全量仓库列表。"""
    repos = []
    for block in re.split(r"(?=^##\s+\[)", md, flags=re.M):
        lines = block.splitlines()
        if not lines:
            continue
        head = re.search(r"\]\((https://github\.com/([\w.-]+)/([\w.-]+))\)", lines[0])
        if not head:
            continue

        star_line = next((line for line in lines if "/stargazers" in line), "")
        lang_match = re.match(r"\s*([^\[\]]+)\[([\d,]+)\]\([^)]*?/stargazers\)", star_line)
        stars_match = re.search(r"([\d,]+)\s+stars?\s+(today|this week|this month)", block)

        star_idx = next((i for i, line in enumerate(lines) if "/stargazers" in line), len(lines))
        description = " ".join(line.strip() for line in lines[1:star_idx] if line.strip()).strip()

        repos.append(
            {
                "fullName": f"{head.group(2)}/{head.group(3)}",
                "url": head.group(1),
                "description": description,
                "language": (lang_match.group(1) or "").strip() if lang_match else "",
                "totalStars": lang_match.group(2) if lang_match else "",
                "starsToday": stars_match.group(1) if stars_match else "",
            }
        )
    return repos


def stream_load(rows, table):
    url = f"{STARROCKS_HTTP.rstrip('/')}/api/{STARROCKS_DB}/{table}/_stream_load"
    auth = base64.b64encode(f"{STARROCKS_USER}:{STARROCKS_PASSWORD}".encode()).decode()
    label = f"trending_{int(time.time() * 1000)}_{random.randint(0, 999999)}"

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


def obtain_result(args):
    if args.from_file:
        return json.loads(Path(args.from_file).resolve().read_text(encoding="utf-8"))
    markdown = scrape_trending_markdown(args.since)
    return {
        "source": "github-trending",
        "since": args.since,
        "crawledAt": datetime.now().isoformat(),
        "repositories": parse_trending_markdown(markdown),
    }


def main(argv):
    args = parse_args(argv)
    result = obtain_result(args)
    rows = to_star_rows(result, args.since, args.dt)

    print(
        f"抓取结果：{result.get('source', 'github-trending')} / since={args.since} / "
        f"共 {len(rows)} 行，dt={rows[0]['dt'] if rows else '-'}"
    )

    if args.dry_run:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return 0

    if not rows:
        print("没有可加载的数据")
        return 0

    loaded = stream_load(rows, table_for(args.since))
    print(
        f"Stream Load 成功：Label={loaded.get('Label')} "
        f"总行数={loaded.get('NumberTotalRows')} 加载={loaded.get('NumberLoadedRows')} "
        f"过滤={loaded.get('NumberFilteredRows', 0)}"
    )
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)
