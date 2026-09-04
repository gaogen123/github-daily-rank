#!/usr/bin/env python3
"""Persistence layer and pipeline entry point for GitHub project metrics."""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any

if __package__:
    from .project_scoring import score_category
else:  # Direct execution: python3 scripts/project_metrics.py
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
    from scripts.project_scoring import score_category


PROJECT_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_PROJECTS = PROJECT_ROOT / "public" / "data" / "projects.json"
DEFAULT_CATEGORIES = PROJECT_ROOT / "public" / "data" / "project-categories.json"
DEFAULT_DATABASE = PROJECT_ROOT / "storage" / "project-metrics.db"
DEFAULT_OUTPUT = PROJECT_ROOT / "public" / "data" / "project-scores.json"
SCORE_VERSION = "v1"
GRAPHQL_ENDPOINT = "https://api.github.com/graphql"
REST_ENDPOINT = "https://api.github.com"


_REPOSITORY_COLUMNS = (
    "repo",
    "github_url",
    "homepage",
    "description",
    "stars",
    "forks",
    "created_at",
    "pushed_at",
    "owner_created_at",
    "commits_30d",
    "open_issues",
    "closed_issues",
    "avg_issue_close_hours",
    "open_prs",
    "merged_prs",
    "contributors",
    "releases_30d",
    "license_spdx",
    "readme_bytes",
    "readme_has_ci",
    "readme_has_demo",
    "has_code",
    "is_collection",
    "source_star_delta_1d",
    "source_star_delta_7d",
    "source_star_delta_30d",
    "fetched_at",
)

_SCORE_COLUMNS = (
    "repo",
    "category",
    "comprehensive_score",
    "hot_score",
    "momentum_score",
    "activity_score",
    "engagement_score",
    "quality_score",
    "freshness_score",
    "excluded",
)


def initialize_database(connection: sqlite3.Connection) -> None:
    """Create the durable base-metric, snapshot, and score tables."""
    connection.executescript(
        """
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS repositories (
            repo TEXT PRIMARY KEY,
            github_url TEXT,
            homepage TEXT,
            description TEXT,
            stars INTEGER,
            forks INTEGER,
            created_at TEXT,
            pushed_at TEXT,
            owner_created_at TEXT,
            commits_30d INTEGER,
            open_issues INTEGER,
            closed_issues INTEGER,
            avg_issue_close_hours REAL,
            open_prs INTEGER,
            merged_prs INTEGER,
            contributors INTEGER,
            releases_30d INTEGER,
            license_spdx TEXT,
            readme_bytes INTEGER,
            readme_has_ci INTEGER,
            readme_has_demo INTEGER,
            has_code INTEGER,
            is_collection INTEGER,
            source_star_delta_1d INTEGER,
            source_star_delta_7d INTEGER,
            source_star_delta_30d INTEGER,
            fetched_at TEXT
        );

        CREATE TABLE IF NOT EXISTS repository_snapshots (
            repo TEXT NOT NULL,
            snapshot_date TEXT NOT NULL,
            stars INTEGER NOT NULL,
            forks INTEGER NOT NULL,
            PRIMARY KEY (repo, snapshot_date),
            FOREIGN KEY (repo) REFERENCES repositories(repo) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS repository_snapshots_date
            ON repository_snapshots(snapshot_date);

        CREATE TABLE IF NOT EXISTS project_scores (
            repo TEXT NOT NULL,
            category TEXT NOT NULL,
            score_version TEXT NOT NULL,
            comprehensive_score REAL NOT NULL,
            hot_score REAL NOT NULL,
            momentum_score REAL NOT NULL,
            activity_score REAL NOT NULL,
            engagement_score REAL NOT NULL,
            quality_score REAL NOT NULL,
            freshness_score REAL NOT NULL,
            excluded INTEGER NOT NULL,
            penalties_json TEXT NOT NULL,
            calculated_at TEXT NOT NULL,
            PRIMARY KEY (repo, category, score_version),
            FOREIGN KEY (repo) REFERENCES repositories(repo) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS project_scores_category
            ON project_scores(category, score_version, comprehensive_score DESC);
        """
    )
    connection.commit()


def upsert_repository_metrics(connection: sqlite3.Connection, metrics: dict[str, Any]) -> None:
    """Persist one API result without replacing reliable values with missing fields."""
    repo = metrics.get("repo")
    if not isinstance(repo, str) or not repo:
        raise ValueError("repo is required")

    values = [metrics.get(column) for column in _REPOSITORY_COLUMNS]
    placeholders = ", ".join("?" for _ in _REPOSITORY_COLUMNS)
    updates = ", ".join(
        f"{column} = COALESCE(excluded.{column}, repositories.{column})"
        for column in _REPOSITORY_COLUMNS
        if column != "repo"
    )
    connection.execute(
        f"""
        INSERT INTO repositories ({', '.join(_REPOSITORY_COLUMNS)})
        VALUES ({placeholders})
        ON CONFLICT(repo) DO UPDATE SET {updates}
        """,
        values,
    )


def record_snapshot(
    connection: sqlite3.Connection,
    repo: str,
    snapshot_date: str | dt.date,
    stars: int,
    forks: int,
) -> None:
    """Record one daily counter snapshot; reruns update rather than duplicate it."""
    date_text = snapshot_date.isoformat() if isinstance(snapshot_date, dt.date) else snapshot_date
    connection.execute(
        """
        INSERT INTO repository_snapshots (repo, snapshot_date, stars, forks)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(repo, snapshot_date) DO UPDATE SET
            stars = excluded.stars,
            forks = excluded.forks
        """,
        (repo, date_text, stars, forks),
    )


def load_scoring_rows(
    connection: sqlite3.Connection,
    repos: Sequence[str],
    *,
    as_of: dt.date | None = None,
) -> list[dict[str, Any]]:
    """Load persisted base metrics and derive deltas from durable snapshots."""
    if not repos:
        return []
    as_of = as_of or dt.datetime.now(dt.timezone.utc).date()
    baseline_date = (as_of - dt.timedelta(days=7)).isoformat()
    earliest_baseline_date = (as_of - dt.timedelta(days=9)).isoformat()
    as_of_text = as_of.isoformat()
    result: list[dict[str, Any]] = []

    for repo in repos:
        repository = connection.execute(
            "SELECT * FROM repositories WHERE repo = ?",
            (repo,),
        ).fetchone()
        if repository is None:
            continue
        columns = [description[0] for description in connection.execute("SELECT * FROM repositories LIMIT 0").description]
        row = dict(zip(columns, repository)) if not isinstance(repository, sqlite3.Row) else dict(repository)

        latest = connection.execute(
            """
            SELECT stars, forks FROM repository_snapshots
            WHERE repo = ? AND snapshot_date <= ?
            ORDER BY snapshot_date DESC LIMIT 1
            """,
            (repo, as_of_text),
        ).fetchone()
        baseline = connection.execute(
            """
            SELECT stars, forks FROM repository_snapshots
            WHERE repo = ? AND snapshot_date BETWEEN ? AND ?
            ORDER BY snapshot_date DESC LIMIT 1
            """,
            (repo, earliest_baseline_date, baseline_date),
        ).fetchone()

        row["star_delta_7d"] = row.get("source_star_delta_7d")
        row["fork_delta_7d"] = None
        if latest is not None:
            row["stars"], row["forks"] = latest[0], latest[1]
        if latest is not None and baseline is not None:
            row["star_delta_7d"] = latest[0] - baseline[0]
            row["fork_delta_7d"] = latest[1] - baseline[1]
        result.append(row)

    return result


def save_project_scores(
    connection: sqlite3.Connection,
    scores: Iterable[dict[str, Any]],
    *,
    score_version: str,
    calculated_at: str,
) -> None:
    """Persist calculated scores as an explicit second pipeline stage."""
    for score in scores:
        values = [score[column] for column in _SCORE_COLUMNS]
        connection.execute(
            """
            INSERT INTO project_scores (
                repo, category, comprehensive_score, hot_score, momentum_score,
                activity_score, engagement_score, quality_score, freshness_score,
                excluded, score_version, penalties_json, calculated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(repo, category, score_version) DO UPDATE SET
                comprehensive_score = excluded.comprehensive_score,
                hot_score = excluded.hot_score,
                momentum_score = excluded.momentum_score,
                activity_score = excluded.activity_score,
                engagement_score = excluded.engagement_score,
                quality_score = excluded.quality_score,
                freshness_score = excluded.freshness_score,
                excluded = excluded.excluded,
                penalties_json = excluded.penalties_json,
                calculated_at = excluded.calculated_at
            """,
            values
            + [
                score_version,
                json.dumps(score.get("penalties", []), ensure_ascii=False),
                calculated_at,
            ],
        )


def _load_env(path: Path) -> None:
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip("\"").strip("'")
        os.environ.setdefault(key.strip(), value)


def _request_json(
    url: str,
    token: str,
    *,
    body: dict[str, Any] | None = None,
    timeout: float = 60.0,
) -> tuple[Any, dict[str, str]]:
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {
        "Accept": "application/vnd.github+json",
        "Authorization": f"Bearer {token}",
        "User-Agent": "github-daily-rank-metrics",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if data is not None:
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers)
    last_error: Exception | None = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                response_headers = {key.lower(): value for key, value in response.headers.items()}
                return json.loads(response.read().decode("utf-8")), response_headers
        except (urllib.error.URLError, TimeoutError) as error:
            last_error = error
            if attempt < 2:
                time.sleep(2**attempt)
    assert last_error is not None
    raise last_error


def _graphql_query(repos: Sequence[str], since: str) -> tuple[str, dict[str, str]]:
    aliases: list[str] = []
    alias_to_repo: dict[str, str] = {}
    for index, repo in enumerate(repos):
        owner, name = repo.split("/", 1)
        alias = f"r{index}"
        alias_to_repo[alias] = repo
        aliases.append(
            f"""
            {alias}: repository(owner: {json.dumps(owner)}, name: {json.dumps(name)}) {{
              url homepageUrl description stargazerCount forkCount createdAt pushedAt diskUsage
              owner {{
                __typename
                ... on User {{ createdAt }}
                ... on Organization {{ createdAt }}
              }}
              licenseInfo {{ spdxId }}
              languages(first: 1) {{ totalCount }}
              issuesOpen: issues(states: OPEN) {{ totalCount }}
              issuesClosed: issues(states: CLOSED) {{ totalCount }}
              recentClosedIssues: issues(
                states: CLOSED, first: 20,
                orderBy: {{field: UPDATED_AT, direction: DESC}}
              ) {{ nodes {{ createdAt closedAt }} }}
              prsOpen: pullRequests(states: OPEN) {{ totalCount }}
              prsMerged: pullRequests(states: MERGED) {{ totalCount }}
              releases(first: 1, orderBy: {{field: CREATED_AT, direction: DESC}}) {{
                nodes {{ publishedAt }}
              }}
              defaultBranchRef {{
                target {{ ... on Commit {{ history(since: {json.dumps(since)}) {{ totalCount }} }} }}
              }}
              readme: object(expression: "HEAD:README.md") {{
                ... on Blob {{ byteSize text }}
              }}
            }}
            """
        )
    query = "query {\n" + "\n".join(aliases) + "\nrateLimit { remaining resetAt }\n}"
    return query, alias_to_repo


def _average_issue_close_hours(nodes: Sequence[dict[str, Any]]) -> float | None:
    durations: list[float] = []
    for node in nodes:
        try:
            created = dt.datetime.fromisoformat(node["createdAt"].replace("Z", "+00:00"))
            closed = dt.datetime.fromisoformat(node["closedAt"].replace("Z", "+00:00"))
        except (KeyError, TypeError, ValueError):
            continue
        durations.append(max(0.0, (closed - created).total_seconds() / 3600))
    return round(sum(durations) / len(durations), 2) if durations else None


def _recent_release_count(repository: dict[str, Any], cutoff: dt.datetime) -> int:
    nodes = repository.get("releases", {}).get("nodes") or []
    if not nodes or not nodes[0].get("publishedAt"):
        return 0
    published = dt.datetime.fromisoformat(nodes[0]["publishedAt"].replace("Z", "+00:00"))
    return 1 if published >= cutoff else 0


def _looks_like_collection(repo: str, description: str, readme: str) -> bool:
    name = repo.split("/", 1)[-1].lower()
    sample = f"{name} {description[:500]} {readme[:1000]}".lower()
    return bool(
        name.startswith(("awesome-", "awesome_"))
        or re.search(r"\b(curated list|awesome list|collection of awesome|resource collection)\b", sample)
    )


def _repository_metrics(
    repo: str,
    repository: dict[str, Any],
    source: dict[str, Any],
    contributors: int | None,
    now: dt.datetime,
) -> dict[str, Any]:
    readme_was_returned = "readme" in repository
    readme_node = repository.get("readme") or {}
    readme = readme_node.get("text") or ""
    languages = repository.get("languages")
    description = repository.get("description") or source.get("description") or ""
    cutoff = now - dt.timedelta(days=30)
    return {
        "repo": repo,
        "github_url": repository.get("url") or source.get("url"),
        "homepage": repository.get("homepageUrl"),
        "description": description,
        "stars": repository.get("stargazerCount"),
        "forks": repository.get("forkCount"),
        "created_at": repository.get("createdAt"),
        "pushed_at": repository.get("pushedAt"),
        "owner_created_at": (repository.get("owner") or {}).get("createdAt"),
        "commits_30d": (((repository.get("defaultBranchRef") or {}).get("target") or {}).get("history") or {}).get("totalCount"),
        "open_issues": (repository.get("issuesOpen") or {}).get("totalCount"),
        "closed_issues": (repository.get("issuesClosed") or {}).get("totalCount"),
        "avg_issue_close_hours": _average_issue_close_hours(
            (repository.get("recentClosedIssues") or {}).get("nodes") or []
        ),
        "open_prs": (repository.get("prsOpen") or {}).get("totalCount"),
        "merged_prs": (repository.get("prsMerged") or {}).get("totalCount"),
        "contributors": contributors,
        "releases_30d": _recent_release_count(repository, cutoff),
        "license_spdx": (repository.get("licenseInfo") or {}).get("spdxId"),
        "readme_bytes": (readme_node.get("byteSize") if readme_node else 0) if readme_was_returned else None,
        "readme_has_ci": bool(re.search(r"github/actions|github/workflows|travis|circleci|build status|ci badge", readme, re.I)) if readme_was_returned else None,
        "readme_has_demo": bool(re.search(r"\b(demo|screenshot|preview)\b|\.gif(?:\)|\s|$)", readme, re.I)) if readme_was_returned else None,
        "has_code": ((languages.get("totalCount") or 0) > 0) if languages is not None else None,
        "is_collection": _looks_like_collection(repo, description, readme),
        "source_star_delta_1d": source.get("dailyGrowth"),
        "source_star_delta_7d": source.get("weeklyGrowth"),
        "source_star_delta_30d": source.get("monthlyGrowth"),
        "fetched_at": now.isoformat().replace("+00:00", "Z"),
    }


def _contributor_count(repo: str, token: str) -> int | None:
    url = f"{REST_ENDPOINT}/repos/{repo}/contributors?per_page=1&anon=1"
    try:
        payload, headers = _request_json(url, token)
    except urllib.error.HTTPError as error:
        if error.code in (404, 409):
            return None
        raise
    link = headers.get("link", "")
    match = re.search(r"[?&]page=(\d+)>; rel=\"last\"", link)
    return int(match.group(1)) if match else len(payload)


def collect_metrics(
    connection: sqlite3.Connection,
    projects: Sequence[dict[str, Any]],
    token: str,
    *,
    batch_size: int = 10,
    include_contributors: bool = True,
) -> tuple[int, list[str]]:
    """Fetch GitHub data and persist it without calculating any score."""
    if batch_size < 1 or batch_size > 20:
        raise ValueError("batch_size must be between 1 and 20")
    now = dt.datetime.now(dt.timezone.utc)
    since = (now - dt.timedelta(days=30)).isoformat().replace("+00:00", "Z")
    source_by_repo = {project["repo"]: project for project in projects}
    repos = list(source_by_repo)
    collected = 0
    failures: list[str] = []

    for start in range(0, len(repos), batch_size):
        batch = repos[start : start + batch_size]
        query, alias_to_repo = _graphql_query(batch, since)
        payload, _ = _request_json(GRAPHQL_ENDPOINT, token, body={"query": query})
        data = payload.get("data") or {}
        if payload.get("errors"):
            messages = "; ".join(error.get("message", "GraphQL error") for error in payload["errors"])
            print(f"[项目指标] GraphQL 部分错误：{messages}", file=sys.stderr)

        for alias, repo in alias_to_repo.items():
            repository = data.get(alias)
            if not repository:
                failures.append(repo)
                continue
            contributors = None
            if include_contributors:
                try:
                    contributors = _contributor_count(repo, token)
                except (urllib.error.URLError, TimeoutError) as error:
                    print(f"[项目指标] {repo} 贡献者采集失败：{error}", file=sys.stderr)
            metrics = _repository_metrics(repo, repository, source_by_repo[repo], contributors, now)
            upsert_repository_metrics(connection, metrics)
            if metrics["stars"] is not None and metrics["forks"] is not None:
                record_snapshot(
                    connection,
                    repo,
                    now.date(),
                    int(metrics["stars"]),
                    int(metrics["forks"]),
                )
            collected += 1

        connection.commit()
        rate_limit = data.get("rateLimit") or {}
        print(
            f"[项目指标] 已采集 {collected}/{len(repos)}，GraphQL 剩余额度 {rate_limit.get('remaining', '未知')}",
            file=sys.stderr,
        )
    return collected, failures


def calculate_scores(
    connection: sqlite3.Connection,
    categories: dict[str, list[str]],
    *,
    score_version: str = SCORE_VERSION,
    now: dt.datetime | None = None,
) -> int:
    """Read persisted metrics, calculate category-relative scores, and persist them."""
    now = now or dt.datetime.now(dt.timezone.utc)
    categorized_repos = [repo for repo, values in categories.items() if values]
    category_names = sorted({category for values in categories.values() for category in values})
    grouped: dict[str, list[str]] = {"全部": categorized_repos}
    grouped.update({
        category: [repo for repo, values in categories.items() if category in values]
        for category in category_names
    })
    calculated_at = now.isoformat().replace("+00:00", "Z")
    total = 0
    with connection:
        for category, repos in grouped.items():
            rows = load_scoring_rows(connection, repos, as_of=now.date())
            scores = score_category(rows, category, now=now)
            connection.execute(
                "DELETE FROM project_scores WHERE category = ? AND score_version = ?",
                (category, score_version),
            )
            save_project_scores(
                connection,
                scores,
                score_version=score_version,
                calculated_at=calculated_at,
            )
            total += len(scores)
    return total


def export_scores(
    connection: sqlite3.Connection,
    output_path: Path,
    *,
    score_version: str = SCORE_VERSION,
) -> int:
    rows = connection.execute(
        """
        SELECT * FROM project_scores
        WHERE score_version = ?
        ORDER BY repo, category
        """,
        (score_version,),
    ).fetchall()
    column_names = [description[0] for description in connection.execute("SELECT * FROM project_scores LIMIT 0").description]
    projects: dict[str, dict[str, Any]] = {}
    generated_at = None
    for raw_row in rows:
        row = dict(raw_row) if isinstance(raw_row, sqlite3.Row) else dict(zip(column_names, raw_row))
        generated_at = max(generated_at or row["calculated_at"], row["calculated_at"])
        projects.setdefault(row["repo"], {})[row["category"]] = {
            "comprehensiveScore": row["comprehensive_score"],
            "hotScore": row["hot_score"],
            "momentumScore": row["momentum_score"],
            "activityScore": row["activity_score"],
            "engagementScore": row["engagement_score"],
            "qualityScore": row["quality_score"],
            "freshnessScore": row["freshness_score"],
            "excluded": bool(row["excluded"]),
            "penalties": json.loads(row["penalties_json"]),
        }
    document = {
        "version": 1,
        "scoreVersion": score_version,
        "generatedAt": generated_at,
        "count": len(projects),
        "projects": projects,
    }
    output_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = output_path.with_suffix(output_path.suffix + ".tmp")
    temporary.write_text(json.dumps(document, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    temporary.replace(output_path)
    return len(projects)


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _open_database(path: Path) -> sqlite3.Connection:
    path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(path)
    connection.row_factory = sqlite3.Row
    initialize_database(connection)
    return connection


def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--database", type=Path, default=DEFAULT_DATABASE)
    parser.add_argument("--projects", type=Path, default=DEFAULT_PROJECTS)
    parser.add_argument("--categories", type=Path, default=DEFAULT_CATEGORIES)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    subparsers = parser.add_subparsers(dest="command", required=True)

    collect_parser = subparsers.add_parser("collect", help="collect base metrics into SQLite")
    collect_parser.add_argument("--limit", type=int)
    collect_parser.add_argument("--batch-size", type=int, default=10)
    collect_parser.add_argument("--skip-contributors", action="store_true")
    subparsers.add_parser("score", help="calculate scores from persisted metrics")
    subparsers.add_parser("export", help="export persisted scores for the frontend")
    subparsers.add_parser("run", help="collect, then score, then export")
    args = parser.parse_args(argv)

    _load_env(PROJECT_ROOT / ".env.local")
    projects_document = _read_json(args.projects)
    categories_document = _read_json(args.categories)
    categories = categories_document.get("projects", categories_document)
    classified = {repo for repo, values in categories.items() if values}
    projects = [project for project in projects_document.get("projects", []) if project.get("repo") in classified]
    if getattr(args, "limit", None) is not None:
        projects = projects[: max(0, args.limit)]

    with _open_database(args.database) as connection:
        if args.command in ("collect", "run"):
            token = os.environ.get("GITHUB_TOKEN", "")
            if not token:
                parser.error("GITHUB_TOKEN is required for collect")
            collected, failures = collect_metrics(
                connection,
                projects,
                token,
                batch_size=getattr(args, "batch_size", 10),
                include_contributors=not getattr(args, "skip_contributors", False),
            )
            print(f"基础指标入表：{collected}，失败：{len(failures)}")
        if args.command in ("score", "run"):
            count = calculate_scores(connection, categories)
            print(f"分类评分入表：{count}")
        if args.command in ("export", "run"):
            count = export_scores(connection, args.output)
            print(f"评分导出：{count} 个项目 -> {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
