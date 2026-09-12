#!/usr/bin/env python3
"""将 AI 产品分类结果（含人工纠偏）回填写入 StarRocks dwd.dwd_github_trend_repo_f_1d。

用法：
  python3 scripts/dwd/load_categories_to_dwd.py
  python3 scripts/dwd/load_categories_to_dwd.py --dry-run
  python3 scripts/dwd/load_categories_to_dwd.py --dt 20260909
  python3 scripts/dwd/load_categories_to_dwd.py --all-dates
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import sys
import time
from datetime import datetime
from pathlib import Path

import pymysql
import requests

from repo_category_columns import ensure_category_columns, load_category_meta

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent

DEFAULT_CATEGORIES = PROJECT_ROOT / "public" / "data" / "project-categories.json"
DEFAULT_OVERRIDES = PROJECT_ROOT / "config" / "category-overrides.json"


def load_env_local(path: Path | None = None) -> dict[str, str]:
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


def env(name: str, default: str = "") -> str:
    return os.environ.get(name) or _ENV.get(name) or default


STARROCKS_MYSQL_HOST = env("STARROCKS_MYSQL_HOST", "127.0.0.1")
STARROCKS_MYSQL_PORT = int(env("STARROCKS_MYSQL_PORT", "9030"))
STARROCKS_HTTP = env("STARROCKS_HTTP", "http://localhost:8040")
STARROCKS_USER = env("STARROCKS_USER", "root")
STARROCKS_PASSWORD = env("STARROCKS_PASSWORD", "")
DWD_DB = env("DWD_DB", "dwd")
DWD_TABLE = env("DWD_TABLE", "dwd_github_trend_repo_f_1d")


def open_connection() -> pymysql.Connection:
    return pymysql.connect(
        host=STARROCKS_MYSQL_HOST,
        port=STARROCKS_MYSQL_PORT,
        user=STARROCKS_USER,
        password=STARROCKS_PASSWORD,
        database=DWD_DB,
        cursorclass=pymysql.cursors.DictCursor,
    )


def stream_load(rows: list[dict], label_suffix: str = "") -> dict:
    url = f"{STARROCKS_HTTP.rstrip('/')}/api/{DWD_DB}/{DWD_TABLE}/_stream_load"
    auth = base64.b64encode(f"{STARROCKS_USER}:{STARROCKS_PASSWORD}".encode()).decode()
    label = f"repo_category_{int(time.time() * 1000)}_{label_suffix or os.getpid()}"
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
        timeout=120,
    )
    result = resp.json()
    if not resp.ok or result.get("Status") != "Success":
        raise RuntimeError(f"Stream Load 失败: HTTP {resp.status_code} {json.dumps(result, ensure_ascii=False)[:300]}")
    return result


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--categories", type=Path, default=DEFAULT_CATEGORIES, help="分类 JSON 文件路径")
    parser.add_argument("--overrides", type=Path, default=DEFAULT_OVERRIDES, help="人工纠偏配置文件路径")
    parser.add_argument("--dt", type=str, help="指定快照日期（yyyyMMdd），默认最新快照")
    parser.add_argument("--all-dates", action="store_true", help="回填 DWD 表中所有日期的快照记录")
    parser.add_argument("--batch-size", type=int, default=2000, help="Stream Load 批次大小")
    parser.add_argument("--dry-run", action="store_true", help="仅打印统计，不实际写入 StarRocks")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    conn = open_connection()
    try:
        ensure_category_columns(conn, f"{DWD_DB}.{DWD_TABLE}")
        conn.commit()

        where_clause = ""
        if args.dt:
            dt_val = int(str(args.dt).replace("-", ""))
            where_clause = f"WHERE dt = {dt_val}"
        elif not args.all_dates:
            where_clause = f"WHERE dt = (SELECT MAX(dt) FROM {DWD_DB}.{DWD_TABLE})"

        sql = f"SELECT * FROM {DWD_DB}.{DWD_TABLE} {where_clause}"
        with conn.cursor() as cursor:
            cursor.execute(sql)
            rows = cursor.fetchall()
    finally:
        conn.close()

    if not rows:
        print("未查询到符合条件的 DWD 仓库快照记录")
        return 0

    print(f"读取到 DWD 仓库记录: {len(rows)} 条")
    cat_meta = load_category_meta(args.categories, args.overrides)
    print(f"读取到分类元数据: {len(cat_meta)} 个仓库（含人工纠偏）")

    updates: list[dict] = []
    matched = 0

    for row in rows:
        full_name = row["full_name"]
        if full_name in cat_meta:
            matched += 1
            row.update(cat_meta[full_name])
        else:
            row.setdefault("category_list", None)
            row.setdefault("primary_category", None)
            row.setdefault("is_ai", False)
            row.setdefault("category_reason", None)
            row.setdefault("category_source", None)
            row.setdefault("category_updated_at", None)

        formatted_row = {
            k: v.isoformat(sep=" ") if isinstance(v, datetime) else v
            for k, v in row.items()
        }
        updates.append(formatted_row)

    print(f"匹配并更新分类信息: {matched}/{len(rows)} 条记录")

    if args.dry_run:
        print("[Dry Run] 跳过 Stream Load 写入")
        return 0

    total_batches = (len(updates) + args.batch_size - 1) // args.batch_size
    loaded_count = 0
    for i in range(0, len(updates), args.batch_size):
        batch = updates[i : i + args.batch_size]
        res = stream_load(batch, f"cat_{i}")
        loaded_count += int(res.get("NumberLoadedRows", 0))
        print(f"Stream Load 批次 {i // args.batch_size + 1}/{total_batches}: 成功写入 {len(batch)} 行")

    print(f"分类回填完成，共更新 {loaded_count} 行至 {DWD_DB}.{DWD_TABLE}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
