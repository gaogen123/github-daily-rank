#!/usr/bin/env python3
"""构建 ADS 应用层仓库表 ads.ads_github_trend_repo_f。

把 dwd.dwd_github_trend_repo_f_1d 当天分区数据 INSERT OVERWRITE 到 ADS 表，
每次全量覆盖，ADS 表始终只保留「最新一天」的全量仓库快照。

依赖：pymysql
用法：
  python3 scripts/ads/load_trend_repo_ads.py
  python3 scripts/ads/load_trend_repo_ads.py --ds 20260905
  python3 scripts/ads/load_trend_repo_ads.py --dry-run --ds 20260905

日期变量：biz_curdate（即 ds）。优先级：--ds 参数 > 环境变量 biz_curdate / BIZ_CURDATE > 当天。
"""

import argparse
import os
import sys
from datetime import datetime
from pathlib import Path

import pymysql

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "dwd"))
from repo_social_preview import ensure_image_columns

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent

ADS_DB = "ads"
ADS_TABLE = "ads_github_trend_repo_f"
DDL_PATH = PROJECT_ROOT / "sql" / "ads" / "ads_github_trend_repo_f_ddl.sql"
DML_PATH = PROJECT_ROOT / "sql" / "ads" / "ads_github_trend_repo_f_dml.sql"


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


def open_connection():
    return pymysql.connect(
        host=STARROCKS_MYSQL_HOST,
        port=STARROCKS_MYSQL_PORT,
        user=STARROCKS_USER,
        password=STARROCKS_PASSWORD,
        database=STARROCKS_DB,
    )


def ensure_ads_table():
    """建 ads 库 + 表（幂等），DDL 读取自 sql/ads/..._ddl.sql。"""
    conn = open_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(f"CREATE DATABASE IF NOT EXISTS `{ADS_DB}`")
            if DDL_PATH.is_file():
                lines = []
                for line in DDL_PATH.read_text(encoding="utf-8").splitlines():
                    lines.append(line.split("--", 1)[0].rstrip())
                ddl = "\n".join(lines).strip()
                if ddl.endswith(";"):
                    ddl = ddl[:-1]
                cur.execute(ddl)
        ensure_image_columns(conn, f"{ADS_DB}.{ADS_TABLE}")
        conn.commit()
    finally:
        conn.close()


def build_dml(dt):
    if not DML_PATH.is_file():
        raise FileNotFoundError(DML_PATH)
    return DML_PATH.read_text(encoding="utf-8").replace("${biz_curdate}", dt)


def to_bigint_ds(value):
    """'2026-09-05' 或 '20260905' -> '20260905'。"""
    return str(value).replace("-", "")


def run_overwrite(dt):
    """执行 INSERT OVERWRITE，返回 ADS 表最终行数。"""
    sql = build_dml(dt)
    conn = open_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
            cur.execute(f"SELECT COUNT(*) FROM `{ADS_DB}`.`{ADS_TABLE}`")
            return int(cur.fetchone()[0])
        conn.commit()
    finally:
        conn.close()


def parse_args(argv):
    parser = argparse.ArgumentParser(description="构建 ADS 应用层仓库表 ads_github_trend_repo_f")
    parser.add_argument("--ds", metavar="DATE", help="业务日期 biz_curdate（yyyyMMdd 或 yyyy-MM-dd），默认当天")
    parser.add_argument("--skip-ddl", action="store_true", help="跳过自动建库建表")
    parser.add_argument("--dry-run", action="store_true", help="只打印要执行的 SQL，不实际写入")
    return parser.parse_args(argv)


def main(argv):
    args = parse_args(argv)
    raw = args.ds or env("biz_curdate") or env("BIZ_CURDATE")
    dt = to_bigint_ds(raw) if raw else datetime.now().strftime("%Y%m%d")

    if not args.skip_ddl:
        ensure_ads_table()
        print(f"目标表已就绪：{ADS_DB}.{ADS_TABLE}")

    sql = build_dml(dt)

    if args.dry_run:
        print("待执行 SQL：")
        print(sql)
        return 0

    rows = run_overwrite(dt)
    print(f"INSERT OVERWRITE 完成，{ADS_DB}.{ADS_TABLE} 当前行数：{rows}（dt={dt}）")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main(sys.argv[1:]))
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)
