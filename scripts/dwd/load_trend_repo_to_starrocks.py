#!/usr/bin/env python3
"""构建 GitHub 仓库维度表 dwd.dwd_github_trend_repo_f_1d。

流程：
  1. 从 ODS 六张榜单/抓取表去重得到 (full_name, repo_url)；
  2. 逐仓库调用 GitHub REST API /repos/{full_name} 补全仓库元数据；
  3. 关联 AI 产品分类结果（含人工纠偏与思考链）；
  4. 每天一份全量快照写入 DWD 主键表（PRIMARY KEY (dt, full_name)），
     Stream Load 按主键 upsert，同一天重复跑覆盖、不翻倍。

依赖：pymysql、requests

用法：
  python3 scripts/dwd/load_trend_repo_to_starrocks.py
  python3 scripts/dwd/load_trend_repo_to_starrocks.py --dry-run --limit 20
  python3 scripts/dwd/load_trend_repo_to_starrocks.py --dt 2026-09-05 --concurrency 5
  python3 scripts/dwd/load_trend_repo_to_starrocks.py --categories-only
"""

import argparse
import base64
import json
import os
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from pathlib import Path

import pymysql
import requests

from repo_category_columns import ensure_category_columns, load_category_meta
from repo_social_preview import ensure_image_columns, fetch_previews

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent

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


# StarRocks：查询走 MySQL 协议（FE 9030），写入走 Stream Load（BE 8040）
STARROCKS_MYSQL_HOST = env("STARROCKS_MYSQL_HOST", "127.0.0.1")
STARROCKS_MYSQL_PORT = int(env("STARROCKS_MYSQL_PORT", "9030"))
STARROCKS_HTTP = env("STARROCKS_HTTP", "http://localhost:8040")
STARROCKS_USER = env("STARROCKS_USER", "root")
STARROCKS_PASSWORD = env("STARROCKS_PASSWORD", "")
STARROCKS_DB = env("STARROCKS_DB", "ods")

DWD_DB = env("DWD_DB", "dwd")
DWD_TABLE = env("DWD_TABLE", "dwd_github_trend_repo_f_1d")
DDL_PATH = PROJECT_ROOT / "sql" / "dwd" / "dwd_github_trend_repo_f_1d_ddl.sql"
CATEGORIES_JSON_PATH = PROJECT_ROOT / "public" / "data" / "project-categories.json"
OVERRIDES_JSON_PATH = PROJECT_ROOT / "config" / "category-overrides.json"

GITHUB_TOKEN = env("GITHUB_TOKEN")
GITHUB_API = "https://api.github.com"
GITHUB_HEADERS = {
    "Accept": "application/vnd.github+json",
    "User-Agent": "github-daily-rank-dashboard",
    "X-GitHub-Api-Version": "2022-11-28",
}
if GITHUB_TOKEN:
    GITHUB_HEADERS["Authorization"] = f"Bearer {GITHUB_TOKEN}"

BATCH_SIZE = 5000

# 全局限流状态：匿名 60 次/小时，token 5000 次/小时
_rate_lock = threading.Lock()
_rate_remaining = None
_rate_reset = 0.0


SOURCE_SQL = """
SELECT full_name, repo_url FROM ods.ods_crawl_day_github_trending_f_1d
UNION
SELECT full_name, repo_url FROM ods.ods_crawl_week_github_trending_f_1d
UNION
SELECT full_name, repo_url FROM ods.ods_crawl_mon_github_trending_f_1d
UNION
SELECT full_name, repo_url FROM ods.ods_repo_github_monthly_rank_f_1m
UNION
SELECT full_name, repo_url FROM ods.ods_repo_github_weekly_rank_f_1w
UNION
SELECT full_name, repo_url FROM ods.ods_repo_github_daily_rank_f_1d
"""


# --------------------------------------------------------------------------- #
# StarRocks 查询 / 建表
# --------------------------------------------------------------------------- #
def open_connection():
    return pymysql.connect(
        host=STARROCKS_MYSQL_HOST,
        port=STARROCKS_MYSQL_PORT,
        user=STARROCKS_USER,
        password=STARROCKS_PASSWORD,
        database=STARROCKS_DB,
        cursorclass=pymysql.cursors.DictCursor,
    )


def ensure_table():
    """建 dwd 库 + 表（幂等），DDL 读取自 sql/dwd/..._ddl.sql。"""
    conn = open_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(f"CREATE DATABASE IF NOT EXISTS `{DWD_DB}`")
            if DDL_PATH.is_file():
                lines = []
                for line in DDL_PATH.read_text(encoding="utf-8").splitlines():
                    lines.append(line.split("--", 1)[0].rstrip())
                ddl = "\n".join(lines).strip()
                if ddl.endswith(";"):
                    ddl = ddl[:-1]
                cur.execute(ddl)
        ensure_image_columns(conn, f"{DWD_DB}.{DWD_TABLE}")
        ensure_category_columns(conn, f"{DWD_DB}.{DWD_TABLE}")
        conn.commit()
    finally:
        conn.close()


def query_source_repos():
    """查询六张 ODS 表，按 full_name 去重（repo_url 优先取非空值）。"""
    conn = open_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(SOURCE_SQL)
            repos = {}
            for row in cur.fetchall():
                full_name = (row.get("full_name") or "").strip()
                if not full_name:
                    continue
                url = (row.get("repo_url") or "").strip()
                if full_name not in repos or (url and not repos[full_name]["repo_url"]):
                    repos[full_name] = {"full_name": full_name, "repo_url": url}
        return repos
    finally:
        conn.close()


# --------------------------------------------------------------------------- #
# GitHub API
# --------------------------------------------------------------------------- #
def _observe_rate_limit(resp):
    global _rate_remaining, _rate_reset
    remaining = resp.headers.get("X-RateLimit-Remaining")
    reset = resp.headers.get("X-RateLimit-Reset")
    if remaining is None:
        return
    with _rate_lock:
        _rate_remaining = int(remaining)
        if reset:
            _rate_reset = float(reset)


def _wait_for_rate_limit():
    global _rate_remaining, _rate_reset
    with _rate_lock:
        remaining = _rate_remaining
        reset = _rate_reset
    if remaining is not None and remaining <= 1:
        wait = max(reset - time.time() + 1, 1.0)
        print(f"[限流等待] GitHub API 剩余配额不足，暂停等待 {wait:.0f}s ...", flush=True)
        time.sleep(wait)
        with _rate_lock:
            _rate_remaining = None
            _rate_reset = 0.0


def fetch_repo(full_name):
    """调用 GET /repos/{full_name}，返回 JSON 或 None（不存在/被屏蔽）。"""
    _wait_for_rate_limit()
    url = f"{GITHUB_API}/repos/{full_name}"
    for _ in range(3):
        resp = requests.get(url, headers=GITHUB_HEADERS, timeout=30)
        _observe_rate_limit(resp)
        if resp.status_code == 200:
            return resp.json()
        if resp.status_code in (404, 451):
            return None
        if resp.status_code == 403:
            # 判断是否是真正的 API 配额限流，还是封禁/权限/大文件屏蔽
            is_rate_limit = (
                resp.headers.get("X-RateLimit-Remaining") == "0"
                or "rate limit" in resp.text.lower()
            )
            if not is_rate_limit:
                # 属于仓库屏蔽、DMCA、或权限不足，直接跳过
                return None
        if resp.status_code in (403, 429):
            reset = float(resp.headers.get("X-RateLimit-Reset", "0"))
            retry_after = int(resp.headers.get("Retry-After", "0"))
            wait = max(retry_after, reset - time.time() + 1, 5.0)
            print(f"[限流等待] {full_name} 触发限流，等待 {wait:.0f}s ...", flush=True)
            time.sleep(wait)
            continue
        resp.raise_for_status()
    return None


def to_datetime(value):
    if not value:
        return None
    text = str(value).strip().replace("T", " ").replace("Z", "")
    return text[:19] if len(text) >= 19 else text


def to_bigint_date(value):
    """'2026-09-05' 或 '20260905' -> 20260905；已为整数则原样返回。"""
    if value is None or value == "":
        return None
    if isinstance(value, int):
        return value
    return int(str(value).replace("-", ""))


# --------------------------------------------------------------------------- #
# 行转换 / 写入
# --------------------------------------------------------------------------- #
def to_row(repo, dt, fetched_at, cat_meta=None):
    owner = repo.get("owner") or {}
    license_info = repo.get("license") or {}
    topics = repo.get("topics") or []
    raw = json.dumps(repo, ensure_ascii=False)
    full_name = repo.get("full_name") or ""

    row = {
        "dt": dt,
        "full_name": full_name,
        "repo_id": repo.get("id"),
        "repo_url": repo.get("html_url"),
        "repo_name": repo.get("name"),
        "owner_login": owner.get("login"),
        "owner_id": owner.get("id"),
        "owner_type": owner.get("type"),
        "owner_avatar_url": owner.get("avatar_url"),
        "description": repo.get("description"),
        "homepage": repo.get("homepage"),
        "primary_language": repo.get("language"),
        "stargazers_count": repo.get("stargazers_count"),
        "forks_count": repo.get("forks_count"),
        "open_issues_count": repo.get("open_issues_count"),
        "subscribers_count": repo.get("subscribers_count"),
        "network_count": repo.get("network_count"),
        "license_spdx": license_info.get("spdx_id"),
        "license_name": license_info.get("name"),
        "default_branch": repo.get("default_branch"),
        "is_fork": repo.get("fork"),
        "is_archived": repo.get("archived"),
        "is_disabled": repo.get("disabled"),
        "is_template": repo.get("is_template"),
        "has_issues": repo.get("has_issues"),
        "has_projects": repo.get("has_projects"),
        "has_wiki": repo.get("has_wiki"),
        "has_pages": repo.get("has_pages"),
        "has_downloads": repo.get("has_downloads"),
        "has_discussions": repo.get("has_discussions"),
        "topics": json.dumps(topics, ensure_ascii=False) if topics else None,
        "created_at": to_datetime(repo.get("created_at")),
        "updated_at": to_datetime(repo.get("updated_at")),
        "pushed_at": to_datetime(repo.get("pushed_at")),
        "fetched_at": fetched_at,
        "raw_json": raw,
    }

    if cat_meta and full_name in cat_meta:
        row.update(cat_meta[full_name])

    return row


def chunk(items, size):
    for i in range(0, len(items), size):
        yield items[i : i + size]


def stream_load(rows, batch_id):
    """通过 Stream Load 写入 StarRocks（JSON 格式）。"""
    url = f"{STARROCKS_HTTP}/api/{DWD_DB}/{DWD_TABLE}/_stream_load"
    data = json.dumps(rows, ensure_ascii=False).encode("utf-8")
    auth = base64.b64encode(f"{STARROCKS_USER}:{STARROCKS_PASSWORD}".encode()).decode()
    label = f"{DWD_TABLE}_{int(time.time()*1000)}_{batch_id}"
    headers = {
        "Authorization": f"Basic {auth}",
        "Expect": "100-continue",
        "format": "json",
        "strip_outer_array": "true",
        "label": label,
        "Content-Type": "application/json",
    }
    resp = requests.put(url, data=data, headers=headers, timeout=120)
    result = resp.json()
    if result.get("Status") != "Success":
        raise RuntimeError(f"Stream Load 失败: {json.dumps(result, ensure_ascii=False)}")
    return result


# --------------------------------------------------------------------------- #
# 主流程
# --------------------------------------------------------------------------- #
def parse_args(argv):
    parser = argparse.ArgumentParser(description="构建 DWD 仓库维度表 dwd_github_trend_repo_f_1d")
    parser.add_argument("--dt", metavar="DATE", help="快照日期（yyyyMMdd 或 yyyy-MM-dd），默认当天")
    parser.add_argument("--concurrency", type=int, default=int(env("GITHUB_CONCURRENCY", "10")),
                        help="GitHub API 并发数，默认 10")
    parser.add_argument("--limit", type=int, default=0, help="只处理前 N 个仓库（调试用），0 表示全部")
    parser.add_argument("--skip-ddl", action="store_true", help="跳过自动建库建表")
    parser.add_argument("--dry-run", action="store_true", help="只拉取转换不写入")
    parser.add_argument("--images-only", action="store_true", help="仅回填最新 DWD 快照展示图，保留其他字段")
    parser.add_argument("--categories-only", action="store_true", help="仅回填最新 DWD 快照分类字段，保留其他字段")
    return parser.parse_args(argv)


def main(argv):
    args = parse_args(argv)

    if not GITHUB_TOKEN and not (args.images_only or args.categories_only):
        print("警告：未配置 GITHUB_TOKEN，GitHub API 匿名配额（60 次/小时）可能不足以完成全量拉取")

    if not args.skip_ddl:
        ensure_table()
        print(f"目标表已就绪：{DWD_DB}.{DWD_TABLE}")

    if args.images_only:
        connection = open_connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(f"SELECT * FROM {DWD_DB}.{DWD_TABLE} WHERE dt = (SELECT MAX(dt) FROM {DWD_DB}.{DWD_TABLE})")
                rows = cursor.fetchall()
        finally:
            connection.close()
        if args.limit:
            rows = rows[:args.limit]
        print(f"[展示图回填] 待处理仓库数: {len(rows)}")
        previews = fetch_previews([row["full_name"] for row in rows], GITHUB_API, GITHUB_HEADERS)
        updates = []
        for row in rows:
            if row["full_name"] in previews:
                row.update(previews[row["full_name"]])
                updates.append({key: value.isoformat(sep=" ") if isinstance(value, datetime) else value for key, value in row.items()})
        if not args.dry_run and updates:
            total_batches = (len(updates) + BATCH_SIZE - 1) // BATCH_SIZE
            loaded = 0
            for index, batch in enumerate(chunk(updates, BATCH_SIZE), start=1):
                res = stream_load(batch, f"images_{index}")
                loaded += int(res.get("NumberLoadedRows", 0))
                print(f"[写入] 批次 {index}/{total_batches} 完成，已写入 {loaded}/{len(updates)} 行", flush=True)
        print(f"展示图回填完成：更新 {len(updates)}/{len(rows)} 条记录")
        return 0

    if args.categories_only:
        connection = open_connection()
        try:
            with connection.cursor() as cursor:
                cursor.execute(f"SELECT * FROM {DWD_DB}.{DWD_TABLE} WHERE dt = (SELECT MAX(dt) FROM {DWD_DB}.{DWD_TABLE})")
                rows = cursor.fetchall()
        finally:
            connection.close()
        if args.limit:
            rows = rows[:args.limit]
        print(f"[分类回填] 待处理仓库数: {len(rows)}")
        cat_meta = load_category_meta(CATEGORIES_JSON_PATH, OVERRIDES_JSON_PATH)
        updates = []
        matched = 0
        for row in rows:
            fn = row["full_name"]
            if fn in cat_meta:
                row.update(cat_meta[fn])
                matched += 1
            updates.append({key: value.isoformat(sep=" ") if isinstance(value, datetime) else value for key, value in row.items()})
        if not args.dry_run and updates:
            total_batches = (len(updates) + BATCH_SIZE - 1) // BATCH_SIZE
            loaded = 0
            for index, batch in enumerate(chunk(updates, BATCH_SIZE), start=1):
                res = stream_load(batch, f"cats_{index}")
                loaded += int(res.get("NumberLoadedRows", 0))
                print(f"[写入] 批次 {index}/{total_batches} 完成，已写入 {loaded}/{len(updates)} 行", flush=True)
        print(f"分类回填完成：匹配 {matched}/{len(rows)} 条记录")
        return 0

    repos = query_source_repos()
    print(f"去重后待处理仓库：{len(repos)} 个")

    items = list(repos.values())
    if args.limit:
        items = items[: args.limit]
        print(f"仅处理前 {len(items)} 个仓库")

    dt = to_bigint_date(args.dt) or int(datetime.now().strftime("%Y%m%d"))
    fetched_at = datetime.now().strftime("%Y-%m-%d %H:%M:%S")

    cat_meta = load_category_meta(CATEGORIES_JSON_PATH, OVERRIDES_JSON_PATH)

    rows = []
    fetched = 0
    failed = 0
    skipped = 0
    total = len(items)
    concurrency = max(1, args.concurrency)
    start_time = time.time()

    print(f"开始并发拉取 GitHub 元数据（并发数: {concurrency}，总计: {total}）...")

    with ThreadPoolExecutor(max_workers=concurrency) as executor:
        futures = {executor.submit(fetch_repo, item["full_name"]): item for item in items}
        for future in as_completed(futures):
            item = futures[future]
            full_name = item["full_name"]
            try:
                repo = future.result()
            except Exception as exc:  # noqa: BLE001
                failed += 1
                processed = fetched + skipped + failed
                elapsed = max(time.time() - start_time, 0.1)
                rate = processed / elapsed
                print(f"[{processed}/{total}] ({(processed/total)*100:5.1f}%) [失败] {full_name}: {exc} (速率: {rate:.1f}个/s)", flush=True)
                continue

            if repo is None:
                skipped += 1
                processed = fetched + skipped + failed
                elapsed = max(time.time() - start_time, 0.1)
                rate = processed / elapsed
                print(f"[{processed}/{total}] ({(processed/total)*100:5.1f}%) [跳过] {full_name}: 仓库不存在或已屏蔽 (速率: {rate:.1f}个/s)", flush=True)
                continue

            fetched += 1
            row = to_row(repo, dt, fetched_at, cat_meta=cat_meta)
            if not row["repo_url"] and item["repo_url"]:
                row["repo_url"] = item["repo_url"]
            rows.append(row)

            processed = fetched + skipped + failed
            elapsed = max(time.time() - start_time, 0.1)
            rate = processed / elapsed
            eta = max((total - processed) / rate, 0)
            print(f"[{processed}/{total}] ({(processed/total)*100:5.1f}%) 成功:{fetched} 跳过:{skipped} 失败:{failed} | 速率:{rate:.1f}个/s 预估剩余:{eta:.0f}s | {full_name}", flush=True)

    elapsed_total = time.time() - start_time
    print(f"\n元数据拉取完成：耗时 {elapsed_total:.1f}s | 成功: {fetched}，跳过: {skipped}，失败: {failed}")

    if not rows:
        print("没有可写入的数据")
        return 0

    if args.dry_run:
        print(json.dumps(rows[:5], ensure_ascii=False, indent=2))
        print(f"（仅预览前 5 行，共 {len(rows)} 行）")
        return 0

    print(f"\n开始抓取仓库封面展示图（GraphQL 批量，共 {len(rows)} 个）...")
    previews = fetch_previews([row["full_name"] for row in rows], GITHUB_API, GITHUB_HEADERS)
    for row in rows:
        row.update(previews.get(row["full_name"], {}))

    print(f"\n开始向 StarRocks DWD 表写入数据 (Stream Load，共 {len(rows)} 行)...")
    total_batches = (len(rows) + BATCH_SIZE - 1) // BATCH_SIZE
    loaded = 0
    for index, batch in enumerate(chunk(rows, BATCH_SIZE), start=1):
        result = stream_load(batch, str(index))
        loaded_count = int(result.get("NumberLoadedRows", 0))
        loaded += loaded_count
        print(f"[写入 DWD] 批次 {index}/{total_batches} ({(index/total_batches)*100:5.1f}%) 完成：本次写入 {loaded_count} 行，累计已写入 {loaded}/{len(rows)} 行", flush=True)

    print(f"\n✅ 全部完成！共写入 {loaded} 行 -> {DWD_DB}.{DWD_TABLE} (分区 dt={dt})")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)
