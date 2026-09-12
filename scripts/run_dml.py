#!/usr/bin/env python3
"""通用 DML 执行器：按表名找到对应 *_dml.sql，代入日期后连接 StarRocks 执行。

查找规则：在 sql/ 目录下递归查找文件名等于 `{table}_dml.sql` 的文件。
日期替换：默认把 DML 中的 ${biz_curdate} 替换为传入日期（可用 --placeholder 覆盖）。

依赖：pymysql
用法：
  python3 scripts/run_dml.py ads_github_trend_repo_f --ds 20260905
  python3 scripts/run_dml.py ads_github_trend_repo_f --dry-run
  BIZ_CURDATE=20260905 python3 scripts/run_dml.py ads_github_trend_repo_f
"""

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path

import pymysql

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SQL_ROOT = PROJECT_ROOT / "sql"


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


def find_dml(table):
    matches = sorted(SQL_ROOT.rglob(f"{table}_dml.sql"))
    if not matches:
        raise FileNotFoundError(f"未找到 DML 文件：sql/**/{table}_dml.sql")
    return matches[0]


def build_sql(dml_path, date, placeholder):
    return dml_path.read_text(encoding="utf-8").replace(placeholder, date)


def to_bigint_ds(value):
    """'2026-09-05' 或 '20260905' -> '20260905'。"""
    return str(value).replace("-", "")


def execute_sql(sql):
    conn = pymysql.connect(
        host=STARROCKS_MYSQL_HOST,
        port=STARROCKS_MYSQL_PORT,
        user=STARROCKS_USER,
        password=STARROCKS_PASSWORD,
        database=STARROCKS_DB,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
            affected = cur.rowcount
        conn.commit()
        return affected
    finally:
        conn.close()


def parse_args(argv):
    parser = argparse.ArgumentParser(description="按表名执行对应的 DML")
    parser.add_argument("table", help="表名，如 ads_github_trend_repo_f")
    parser.add_argument("--ds", metavar="DATE", help="业务日期 biz_curdate（yyyyMMdd 或 yyyy-MM-dd），默认当天")
    parser.add_argument("--placeholder", default="${biz_curdate}", help="DML 中要替换的日期占位符，默认 ${biz_curdate}")
    parser.add_argument("--dry-run", action="store_true", help="只打印要执行的 SQL，不实际执行")
    return parser.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    raw = args.ds or env("biz_curdate") or env("BIZ_CURDATE")
    date = to_bigint_ds(raw) if raw else datetime.now().strftime("%Y%m%d")

    dml_path = find_dml(args.table)
    sql = build_sql(dml_path, date, args.placeholder)

    print(f"DML 文件：{dml_path}")
    print(f"日期参数：{date}")

    if args.dry_run:
        print("待执行 SQL：")
        print(sql)
        return 0

    affected = execute_sql(sql)
    print(f"执行完成，影响行数：{affected}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)
