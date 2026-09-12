#!/usr/bin/env python3
"""从 StarRocks ADS 评分表生成前端 public/data/project-scores.json。

替代 scripts/projects/project_metrics.py 的 SQLite export，
改为从 ads.ads_github_repo_score_f（最新快照）读取并导出。

用法：
  python3 scripts/projects/export_project_scores.py
"""

import json
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

import pymysql

PROJECT_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_PATH = PROJECT_ROOT / "public" / "data" / "project-scores.json"


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


def main():
    conn = pymysql.connect(
        host=STARROCKS_MYSQL_HOST,
        port=STARROCKS_MYSQL_PORT,
        user=STARROCKS_USER,
        password=STARROCKS_PASSWORD,
        database="ads",
        cursorclass=pymysql.cursors.DictCursor,
    )
    try:
        with conn.cursor() as cur:
            cur.execute(
                """
                SELECT dt, category, repo, comprehensive_score, hot_score,
                       momentum_score, activity_score, engagement_score,
                       quality_score, freshness_score, excluded
                FROM ads.ads_github_repo_score_f
                WHERE dt = (SELECT MAX(dt) FROM ads.ads_github_repo_score_f)
                """
            )
            rows = cur.fetchall()
    finally:
        conn.close()

    if not rows:
        print("ADS 评分表暂无数据，请先运行评分 DML", file=sys.stderr)
        return 1

    projects: dict[str, dict[str, dict]] = {}
    for row in rows:
        projects.setdefault(row["repo"], {})[row["category"]] = {
            "updatedAt": str(row["dt"])[:4] + "-" + str(row["dt"])[4:6] + "-" + str(row["dt"])[6:8],
            "comprehensiveScore": row["comprehensive_score"],
            "hotScore": row["hot_score"],
            "momentumScore": row["momentum_score"],
            "activityScore": row["activity_score"],
            "engagementScore": row["engagement_score"],
            "qualityScore": row["quality_score"],
            "freshnessScore": row["freshness_score"],
            "excluded": bool(row["excluded"]),
            "penalties": [],
        }

    document = {
        "version": 1,
        "scoreVersion": "v1",
        "generatedAt": datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "count": len(projects),
        "projects": projects,
    }
    OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    temporary = OUTPUT_PATH.with_suffix(OUTPUT_PATH.suffix + ".tmp")
    temporary.write_text(
        json.dumps(document, ensure_ascii=False, separators=(",", ":")), encoding="utf-8"
    )
    temporary.replace(OUTPUT_PATH)
    print(f"评分导出：{len(projects)} 个项目 -> {OUTPUT_PATH}")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print(str(exc), file=sys.stderr)
        sys.exit(1)
