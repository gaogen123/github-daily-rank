#!/usr/bin/env python3
"""Load one GitHub Archive BigQuery daily table into StarRocks."""

from __future__ import annotations

import argparse
import configparser
import json
import subprocess
import uuid
from datetime import datetime, timezone
from pathlib import Path

import requests
from google.cloud import bigquery
from google.oauth2 import service_account

PROJECT_ID = "gen-lang-client-0343530385"
DATABASE = "ods"
TABLE = "ods_big_query_github_events_f_1d"
BATCH_ROWS = 10_000
CREDENTIALS_FILENAME = "gen-lang-client-0343530385-8b990965e50a.json"


def local_file_or_fallback(filename: str, fallback: str) -> str:
    local_path = Path(__file__).resolve().parent / filename
    return str(local_path) if local_path.is_file() else fallback


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("date", help="GitHub Archive date in YYYYMMDD format")
    parser.add_argument(
        "--credentials",
        default=local_file_or_fallback(CREDENTIALS_FILENAME, CREDENTIALS_FILENAME),
        help="GCP service account JSON path",
    )
    parser.add_argument(
        "--starrocks-config",
        default=local_file_or_fallback(".starrocks-client.cnf", "/root/.starrocks-client.cnf"),
        help="MySQL client config for StarRocks",
    )
    parser.add_argument(
        "--keep-existing",
        action="store_true",
        help="Append instead of replacing the selected date",
    )
    return parser.parse_args()


def validate_date(value: str) -> str:
    datetime.strptime(value, "%Y%m%d")
    return value


def mysql(config_path: str, sql: str) -> str:
    result = subprocess.run(
        ["mysql", f"--defaults-extra-file={config_path}", "-N", "-e", sql],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.strip()


def read_starrocks_connection(config_path: str) -> tuple[str, str, str]:
    config = configparser.ConfigParser()
    config.read(config_path)
    client = config["client"]
    return client.get("host", "127.0.0.1"), client.get("user", "root"), client.get("password", "")


def destination_ddl() -> str:
    return f"""
CREATE DATABASE IF NOT EXISTS {DATABASE};
CREATE TABLE IF NOT EXISTS {DATABASE}.{TABLE} (
    id VARCHAR(64) NOT NULL,
    event_date DATE NOT NULL,
    created_at DATETIME NULL,
    type VARCHAR(64) NULL,
    public BOOLEAN NULL,
    payload JSON NULL,
    repo_id BIGINT NULL,
    repo_name VARCHAR(512) NULL,
    repo_url VARCHAR(2048) NULL,
    actor_id BIGINT NULL,
    actor_login VARCHAR(255) NULL,
    actor_gravatar_id VARCHAR(255) NULL,
    actor_avatar_url VARCHAR(2048) NULL,
    actor_url VARCHAR(2048) NULL,
    org_id BIGINT NULL,
    org_login VARCHAR(255) NULL,
    org_gravatar_id VARCHAR(255) NULL,
    org_avatar_url VARCHAR(2048) NULL,
    org_url VARCHAR(2048) NULL,
    other JSON NULL,
    source_table VARCHAR(128) NOT NULL,
    ingested_at DATETIME NOT NULL
)
ENGINE=OLAP
PRIMARY KEY(id, event_date)
COMMENT 'github事件表'
PARTITION BY (event_date)
DISTRIBUTED BY HASH(id) BUCKETS 8
ORDER BY(repo_name)
PROPERTIES (
    "replication_num" = "1",
    "enable_persistent_index" = "true"
);
"""


def source_query(date: str) -> str:
    source = f"githubarchive.day.{date}"
    return f"""
SELECT TO_JSON_STRING(STRUCT(
    DATE(created_at) AS event_date,
    FORMAT_TIMESTAMP('%F %T', created_at, 'UTC') AS created_at,
    id,
    type,
    public,
    SAFE.PARSE_JSON(payload) AS payload,
    repo.id AS repo_id,
    repo.name AS repo_name,
    repo.url AS repo_url,
    actor.id AS actor_id,
    actor.login AS actor_login,
    actor.gravatar_id AS actor_gravatar_id,
    actor.avatar_url AS actor_avatar_url,
    actor.url AS actor_url,
    org.id AS org_id,
    org.login AS org_login,
    org.gravatar_id AS org_gravatar_id,
    org.avatar_url AS org_avatar_url,
    org.url AS org_url,
    SAFE.PARSE_JSON(other) AS other,
    '{source}' AS source_table,
    FORMAT_TIMESTAMP('%F %T', CURRENT_TIMESTAMP(), 'UTC') AS ingested_at
)) AS row_json
FROM `{source}`
"""


def stream_load(
    host: str,
    user: str,
    password: str,
    payload: bytes,
    batch_number: int,
) -> int:
    label = f"githubarchive_{TABLE}_{batch_number}_{uuid.uuid4().hex}"
    headers = {
        "Expect": "100-continue",
        "format": "json",
        "strip_outer_array": "false",
        "label": label,
        "max_filter_ratio": "0",
    }
    with requests.Session() as session:
        session.trust_env = False
        response = session.put(
            f"http://{host}:8030/api/{DATABASE}/{TABLE}/_stream_load",
            auth=(user, password),
            headers=headers,
            data=payload,
            allow_redirects=False,
            timeout=300,
        )
        if response.is_redirect:
            response = session.put(
                response.headers["Location"],
                auth=(user, password),
                headers=headers,
                data=payload,
                allow_redirects=False,
                timeout=300,
            )
        response.raise_for_status()
    result = response.json()
    if result.get("Status") not in {"Success", "Publish Timeout"}:
        raise RuntimeError(json.dumps(result, ensure_ascii=False, indent=2))
    loaded = int(result.get("NumberLoadedRows", 0))
    if loaded != int(result.get("NumberTotalRows", loaded)):
        raise RuntimeError(json.dumps(result, ensure_ascii=False, indent=2))
    return loaded


def main() -> None:
    args = parse_args()
    date = validate_date(args.date)
    event_date = datetime.strptime(date, "%Y%m%d").date().isoformat()
    credentials_path = Path(args.credentials)
    if not credentials_path.is_file():
        raise FileNotFoundError(credentials_path)

    credentials = service_account.Credentials.from_service_account_file(credentials_path)
    client = bigquery.Client(project=PROJECT_ID, credentials=credentials)
    source_table = client.get_table(f"githubarchive.day.{date}")
    print(f"源表: githubarchive.day.{date}")
    print(f"源表元数据行数: {int(source_table.num_rows or 0):,}")
    print(f"源表大小: {source_table.num_bytes:,} bytes")

    query_job = client.query(source_query(date))
    rows = query_job.result(page_size=BATCH_ROWS)
    expected_rows = int(rows.total_rows or 0)
    print(f"查询快照行数: {expected_rows:,}")

    mysql(args.starrocks_config, destination_ddl())
    date_filter = f"event_date = '{event_date}'"
    existing_rows = int(
        mysql(
            args.starrocks_config,
            f"SELECT COUNT(*) FROM {DATABASE}.{TABLE} WHERE {date_filter}",
        )
    )
    if not args.keep_existing:
        mysql(
            args.starrocks_config,
            f"DELETE FROM {DATABASE}.{TABLE} WHERE {date_filter}",
        )
        existing_rows = 0

    host, user, password = read_starrocks_connection(args.starrocks_config)

    batch: list[str] = []
    loaded_rows = 0
    batch_number = 0
    started_at = datetime.now(timezone.utc)

    for row in rows:
        batch.append(row.row_json)
        if len(batch) >= BATCH_ROWS:
            batch_number += 1
            data = ("\n".join(batch) + "\n").encode("utf-8")
            loaded_rows += stream_load(host, user, password, data, batch_number)
            print(f"批次 {batch_number}: 已导入 {loaded_rows:,}/{expected_rows:,}")
            batch.clear()

    if batch:
        batch_number += 1
        data = ("\n".join(batch) + "\n").encode("utf-8")
        loaded_rows += stream_load(host, user, password, data, batch_number)
        print(f"批次 {batch_number}: 已导入 {loaded_rows:,}/{expected_rows:,}")

    actual_rows = int(
        mysql(
            args.starrocks_config,
            f"SELECT COUNT(*) FROM {DATABASE}.{TABLE} WHERE {date_filter}",
        )
    )
    expected_target_rows = existing_rows + expected_rows
    if loaded_rows != expected_rows or actual_rows != expected_target_rows:
        raise RuntimeError(
            "行数校验失败: "
            f"source={expected_rows}, loaded={loaded_rows}, "
            f"target_date={actual_rows}, expected_target_date={expected_target_rows}"
        )

    elapsed = datetime.now(timezone.utc) - started_at
    print(f"导入完成: {DATABASE}.{TABLE}")
    print(f"{event_date} 目标行数: {actual_rows:,}")
    print(f"耗时: {elapsed}")


if __name__ == "__main__":
    main()
