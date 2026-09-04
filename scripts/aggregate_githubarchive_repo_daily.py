#!/usr/bin/env python3
"""Aggregate one GitHub Archive day in BigQuery and load repository metrics into StarRocks."""

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
DATABASE = "dwd"
TABLE = "dwd_github_repo_daily_f_1d"
BATCH_ROWS = 10_000
CREDENTIALS_FILENAME = "gen-lang-client-0343530385-8b990965e50a.json"


def local_file_or_fallback(filename: str, fallback: str) -> str:
    script_path = Path(__file__).resolve().parent / filename
    project_path = Path(__file__).resolve().parents[1] / filename
    if script_path.is_file():
        return str(script_path)
    if project_path.is_file():
        return str(project_path)
    return fallback


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
    event_date DATE NOT NULL COMMENT 'UTC event date',
    repo_id BIGINT NOT NULL COMMENT 'Stable GitHub repository ID',
    repo_name VARCHAR(512) NOT NULL COMMENT 'Latest owner/name observed that day',
    repo_owner VARCHAR(255) NULL COMMENT 'Repository owner parsed from repo_name',
    repo_url VARCHAR(2048) NULL COMMENT 'GitHub API repository URL',
    org_id BIGINT NULL COMMENT 'Latest organization ID observed that day',
    org_login VARCHAR(255) NULL COMMENT 'Latest organization login observed that day',
    repo_description VARCHAR(4096) NULL COMMENT 'Description exposed by repository CreateEvent',
    default_branch VARCHAR(255) NULL COMMENT 'Default branch exposed by repository CreateEvent',
    first_event_at DATETIME NOT NULL,
    last_event_at DATETIME NOT NULL,
    event_count BIGINT NOT NULL,
    event_type_count BIGINT NOT NULL,
    active_hour_count BIGINT NOT NULL,
    actor_count BIGINT NOT NULL,
    human_actor_count BIGINT NOT NULL,
    bot_actor_count BIGINT NOT NULL,
    human_event_count BIGINT NOT NULL,
    bot_event_count BIGINT NOT NULL,
    push_count BIGINT NOT NULL,
    push_actor_count BIGINT NOT NULL,
    star_count BIGINT NOT NULL COMMENT 'WatchEvent started count; daily stars gained',
    fork_count BIGINT NOT NULL,
    issue_opened_count BIGINT NOT NULL,
    issue_closed_count BIGINT NOT NULL,
    issue_reopened_count BIGINT NOT NULL,
    issue_comment_count BIGINT NOT NULL,
    pr_opened_count BIGINT NOT NULL,
    pr_closed_count BIGINT NOT NULL,
    pr_reopened_count BIGINT NOT NULL,
    pr_synchronize_count BIGINT NOT NULL,
    pr_review_count BIGINT NOT NULL,
    pr_review_approved_count BIGINT NOT NULL,
    pr_review_changes_requested_count BIGINT NOT NULL,
    pr_review_comment_count BIGINT NOT NULL,
    release_published_count BIGINT NOT NULL,
    branch_created_count BIGINT NOT NULL,
    branch_deleted_count BIGINT NOT NULL,
    tag_created_count BIGINT NOT NULL,
    tag_deleted_count BIGINT NOT NULL,
    repository_created_count BIGINT NOT NULL,
    commit_comment_count BIGINT NOT NULL,
    member_added_count BIGINT NOT NULL,
    wiki_event_count BIGINT NOT NULL,
    discussion_event_count BIGINT NOT NULL,
    public_event_count BIGINT NOT NULL,
    source_table VARCHAR(128) NOT NULL,
    aggregated_at DATETIME NOT NULL
)
ENGINE=OLAP
PRIMARY KEY(event_date, repo_id)
COMMENT 'GitHub Archive repository activity aggregated by UTC day in BigQuery'
PARTITION BY (event_date)
DISTRIBUTED BY HASH(repo_id) BUCKETS 4
PROPERTIES (
    "replication_num" = "1",
    "enable_persistent_index" = "true"
);
"""


def source_query(date: str) -> str:
    source = f"githubarchive.day.{date}"
    return f"""
WITH repo_daily AS (
    SELECT
        DATE(created_at) AS event_date,
        repo.id AS repo_id,
        ARRAY_AGG(repo.name IGNORE NULLS ORDER BY created_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS repo_name,
        ARRAY_AGG(repo.url IGNORE NULLS ORDER BY created_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS repo_url,
        ARRAY_AGG(org.id IGNORE NULLS ORDER BY created_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS org_id,
        ARRAY_AGG(org.login IGNORE NULLS ORDER BY created_at DESC LIMIT 1)[SAFE_OFFSET(0)] AS org_login,
        MAX(IF(type = 'CreateEvent' AND JSON_VALUE(payload, '$.ref_type') = 'repository',
               JSON_VALUE(payload, '$.description'), NULL)) AS repo_description,
        MAX(IF(type = 'CreateEvent' AND JSON_VALUE(payload, '$.ref_type') = 'repository',
               JSON_VALUE(payload, '$.master_branch'), NULL)) AS default_branch,
        MIN(created_at) AS first_event_at,
        MAX(created_at) AS last_event_at,
        COUNT(*) AS event_count,
        COUNT(DISTINCT type) AS event_type_count,
        COUNT(DISTINCT TIMESTAMP_TRUNC(created_at, HOUR)) AS active_hour_count,
        COUNT(DISTINCT actor.id) AS actor_count,
        COUNT(DISTINCT IF(NOT REGEXP_CONTAINS(IFNULL(actor.login, ''), r'\\[bot\\]$'), actor.id, NULL)) AS human_actor_count,
        COUNT(DISTINCT IF(REGEXP_CONTAINS(IFNULL(actor.login, ''), r'\\[bot\\]$'), actor.id, NULL)) AS bot_actor_count,
        COUNTIF(NOT REGEXP_CONTAINS(IFNULL(actor.login, ''), r'\\[bot\\]$')) AS human_event_count,
        COUNTIF(REGEXP_CONTAINS(IFNULL(actor.login, ''), r'\\[bot\\]$')) AS bot_event_count,
        COUNTIF(type = 'PushEvent') AS push_count,
        COUNT(DISTINCT IF(type = 'PushEvent', actor.id, NULL)) AS push_actor_count,
        COUNTIF(type = 'WatchEvent' AND JSON_VALUE(payload, '$.action') = 'started') AS star_count,
        COUNTIF(type = 'ForkEvent') AS fork_count,
        COUNTIF(type = 'IssuesEvent' AND JSON_VALUE(payload, '$.action') = 'opened') AS issue_opened_count,
        COUNTIF(type = 'IssuesEvent' AND JSON_VALUE(payload, '$.action') = 'closed') AS issue_closed_count,
        COUNTIF(type = 'IssuesEvent' AND JSON_VALUE(payload, '$.action') = 'reopened') AS issue_reopened_count,
        COUNTIF(type = 'IssueCommentEvent' AND JSON_VALUE(payload, '$.action') = 'created') AS issue_comment_count,
        COUNTIF(type = 'PullRequestEvent' AND JSON_VALUE(payload, '$.action') = 'opened') AS pr_opened_count,
        COUNTIF(type = 'PullRequestEvent' AND JSON_VALUE(payload, '$.action') = 'closed') AS pr_closed_count,
        COUNTIF(type = 'PullRequestEvent' AND JSON_VALUE(payload, '$.action') = 'reopened') AS pr_reopened_count,
        COUNTIF(type = 'PullRequestEvent' AND JSON_VALUE(payload, '$.action') = 'synchronize') AS pr_synchronize_count,
        COUNTIF(type = 'PullRequestReviewEvent' AND JSON_VALUE(payload, '$.action') = 'created') AS pr_review_count,
        COUNTIF(type = 'PullRequestReviewEvent' AND JSON_VALUE(payload, '$.review.state') = 'approved') AS pr_review_approved_count,
        COUNTIF(type = 'PullRequestReviewEvent' AND JSON_VALUE(payload, '$.review.state') = 'changes_requested') AS pr_review_changes_requested_count,
        COUNTIF(type = 'PullRequestReviewCommentEvent' AND JSON_VALUE(payload, '$.action') = 'created') AS pr_review_comment_count,
        COUNTIF(type = 'ReleaseEvent' AND JSON_VALUE(payload, '$.action') = 'published') AS release_published_count,
        COUNTIF(type = 'CreateEvent' AND JSON_VALUE(payload, '$.ref_type') = 'branch') AS branch_created_count,
        COUNTIF(type = 'DeleteEvent' AND JSON_VALUE(payload, '$.ref_type') = 'branch') AS branch_deleted_count,
        COUNTIF(type = 'CreateEvent' AND JSON_VALUE(payload, '$.ref_type') = 'tag') AS tag_created_count,
        COUNTIF(type = 'DeleteEvent' AND JSON_VALUE(payload, '$.ref_type') = 'tag') AS tag_deleted_count,
        COUNTIF(type = 'CreateEvent' AND JSON_VALUE(payload, '$.ref_type') = 'repository') AS repository_created_count,
        COUNTIF(type = 'CommitCommentEvent' AND JSON_VALUE(payload, '$.action') = 'created') AS commit_comment_count,
        COUNTIF(type = 'MemberEvent' AND JSON_VALUE(payload, '$.action') = 'added') AS member_added_count,
        COUNTIF(type = 'GollumEvent') AS wiki_event_count,
        COUNTIF(type = 'DiscussionEvent') AS discussion_event_count,
        COUNTIF(type = 'PublicEvent') AS public_event_count
    FROM `{source}`
    WHERE repo.id IS NOT NULL AND repo.name IS NOT NULL
    GROUP BY event_date, repo_id
)
SELECT TO_JSON_STRING(STRUCT(
    event_date,
    repo_id,
    repo_name,
    SPLIT(repo_name, '/')[SAFE_OFFSET(0)] AS repo_owner,
    repo_url,
    org_id,
    org_login,
    repo_description,
    default_branch,
    FORMAT_TIMESTAMP('%F %T', first_event_at, 'UTC') AS first_event_at,
    FORMAT_TIMESTAMP('%F %T', last_event_at, 'UTC') AS last_event_at,
    event_count,
    event_type_count,
    active_hour_count,
    actor_count,
    human_actor_count,
    bot_actor_count,
    human_event_count,
    bot_event_count,
    push_count,
    push_actor_count,
    star_count,
    fork_count,
    issue_opened_count,
    issue_closed_count,
    issue_reopened_count,
    issue_comment_count,
    pr_opened_count,
    pr_closed_count,
    pr_reopened_count,
    pr_synchronize_count,
    pr_review_count,
    pr_review_approved_count,
    pr_review_changes_requested_count,
    pr_review_comment_count,
    release_published_count,
    branch_created_count,
    branch_deleted_count,
    tag_created_count,
    tag_deleted_count,
    repository_created_count,
    commit_comment_count,
    member_added_count,
    wiki_event_count,
    discussion_event_count,
    public_event_count,
    '{source}' AS source_table,
    FORMAT_TIMESTAMP('%F %T', CURRENT_TIMESTAMP(), 'UTC') AS aggregated_at
)) AS row_json
FROM repo_daily
"""


def stream_load(
    host: str,
    user: str,
    password: str,
    payload: bytes,
    date: str,
    batch_number: int,
) -> int:
    label = f"github_repo_daily_{date}_{batch_number}_{uuid.uuid4().hex}"
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
    source_table_name = f"githubarchive.day.{date}"
    source_table = client.get_table(source_table_name)
    source_rows = int(source_table.num_rows or 0)
    print(f"云端源表: {source_table_name}")
    print(f"云端原始事件: {source_rows:,}")
    print(f"云端源表大小: {int(source_table.num_bytes or 0):,} bytes")

    query_job = client.query(source_query(date))
    rows = query_job.result(page_size=BATCH_ROWS)
    expected_repositories = int(rows.total_rows or 0)
    print(f"云端聚合仓库数: {expected_repositories:,}")
    print(f"BigQuery 实际扫描: {int(query_job.total_bytes_processed or 0):,} bytes")

    mysql(args.starrocks_config, destination_ddl())
    mysql(
        args.starrocks_config,
        f"DELETE FROM {DATABASE}.{TABLE} WHERE event_date = '{event_date}'",
    )
    host, user, password = read_starrocks_connection(args.starrocks_config)

    batch: list[str] = []
    loaded_rows = 0
    loaded_events = 0
    batch_number = 0
    started_at = datetime.now(timezone.utc)

    for row in rows:
        batch.append(row.row_json)
        loaded_events += int(json.loads(row.row_json)["event_count"])
        if len(batch) >= BATCH_ROWS:
            batch_number += 1
            data = ("\n".join(batch) + "\n").encode("utf-8")
            loaded_rows += stream_load(host, user, password, data, date, batch_number)
            print(f"批次 {batch_number}: 已导入 {loaded_rows:,}/{expected_repositories:,} 个仓库")
            batch.clear()

    if batch:
        batch_number += 1
        data = ("\n".join(batch) + "\n").encode("utf-8")
        loaded_rows += stream_load(host, user, password, data, date, batch_number)
        print(f"批次 {batch_number}: 已导入 {loaded_rows:,}/{expected_repositories:,} 个仓库")

    verification = mysql(
        args.starrocks_config,
        f"SELECT COUNT(*), COALESCE(SUM(event_count), 0) FROM {DATABASE}.{TABLE} "
        f"WHERE event_date = '{event_date}'",
    ).split("\t")
    actual_repositories, actual_events = map(int, verification)
    if loaded_rows != expected_repositories or actual_repositories != expected_repositories:
        raise RuntimeError(
            "仓库数校验失败: "
            f"cloud={expected_repositories}, loaded={loaded_rows}, target={actual_repositories}"
        )
    if actual_events != loaded_events:
        raise RuntimeError(
            f"事件数校验失败: cloud_aggregate={loaded_events}, target={actual_events}"
        )

    elapsed = datetime.now(timezone.utc) - started_at
    print(f"聚合完成: {DATABASE}.{TABLE}")
    print(f"{event_date} 仓库数: {actual_repositories:,}")
    print(f"{event_date} 聚合事件数: {actual_events:,}")
    print(f"无有效仓库的排除事件数: {source_rows - actual_events:,}")
    print(f"耗时: {elapsed}")


if __name__ == "__main__":
    main()
