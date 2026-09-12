#!/usr/bin/env python3
"""第 5 步：将优化后的分类全链路同步到下游 DWS 评分表与 ADS 展示表。

步骤：
  1. 应用 config/category-overrides.json 更新 public/data/project-categories.json
  2. 清空并重新装载桥接表 dwd.dwd_github_repo_category_f（仅包含有效合法 AI 分类）
  3. 清理并重算 DWS 仓库评分表 dws.dws_github_repo_score_f_1d
  4. 覆盖写入 ADS 结果表 ads.ads_github_repo_score_f 与 ads.ads_github_trend_repo_f
  5. 导出前端 project-scores.json 与 projects.json
  6. 校验数据完整性与纠偏结果
"""

import argparse
import base64
import json
import os
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

import pymysql
import requests

from repo_category_columns import load_category_meta

SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = SCRIPT_DIR.parent.parent


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
STARROCKS_HTTP = env("STARROCKS_HTTP", "http://localhost:8040")
STARROCKS_USER = env("STARROCKS_USER", "root")
STARROCKS_PASSWORD = env("STARROCKS_PASSWORD", "")

CATEGORIES_JSON_PATH = PROJECT_ROOT / "public" / "data" / "project-categories.json"
DIST_CATEGORIES_JSON_PATH = PROJECT_ROOT / "dist" / "data" / "project-categories.json"
OVERRIDES_JSON_PATH = PROJECT_ROOT / "config" / "category-overrides.json"


def open_connection():
    return pymysql.connect(
        host=STARROCKS_MYSQL_HOST,
        port=STARROCKS_MYSQL_PORT,
        user=STARROCKS_USER,
        password=STARROCKS_PASSWORD,
        cursorclass=pymysql.cursors.DictCursor,
    )


def stream_load(rows, db, table, label_prefix):
    url = f"{STARROCKS_HTTP}/api/{db}/{table}/_stream_load"
    data = json.dumps(rows, ensure_ascii=False).encode("utf-8")
    auth = base64.b64encode(f"{STARROCKS_USER}:{STARROCKS_PASSWORD}".encode()).decode()
    label = f"{label_prefix}_{int(time.time()*1000)}"
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


def step1_update_project_categories_json():
    print("👉 [Step 5.1] 更新 public/data/project-categories.json 中的纠偏配置...")
    raw = json.loads(CATEGORIES_JSON_PATH.read_text(encoding="utf-8"))
    projects = raw.get("projects", {})
    overrides = json.loads(OVERRIDES_JSON_PATH.read_text(encoding="utf-8"))

    modified = 0
    for repo, item in overrides.items():
        if not item.get("is_ai"):
            if repo in projects:
                projects[repo] = []
                modified += 1
        elif item.get("categories"):
            projects[repo] = item["categories"]
            modified += 1

    raw["projects"] = projects
    raw["updated_at"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    formatted = json.dumps(raw, ensure_ascii=False, indent=2)
    CATEGORIES_JSON_PATH.write_text(formatted, encoding="utf-8")
    if DIST_CATEGORIES_JSON_PATH.parent.exists():
        DIST_CATEGORIES_JSON_PATH.write_text(formatted, encoding="utf-8")

    print(f"   已应用人工纠偏规则：更新 {modified} 个仓库的分类配置")


def step2_sync_dwd_category_table():
    print("👉 [Step 5.2] 同步有效 AI 分类至 dwd.dwd_github_repo_category_f...")
    cat_meta = load_category_meta(CATEGORIES_JSON_PATH, OVERRIDES_JSON_PATH)

    rows = []
    for repo, meta in cat_meta.items():
        if meta.get("is_ai") and meta.get("category_list"):
            try:
                cats = json.loads(meta["category_list"])
                for cat in cats:
                    rows.append({"repo": repo, "category": cat})
            except Exception:
                pass

    conn = open_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("TRUNCATE TABLE dwd.dwd_github_repo_category_f")
            conn.commit()
    finally:
        conn.close()

    if rows:
        stream_load(rows, "dwd", "dwd_github_repo_category_f", "sync_cat")
    print(f"   同步完成：写入 {len(rows)} 条分类记录（去重涵盖 {len(set(r['repo'] for r in rows))} 个开源 AI 项目）")


def step3_recalculate_dws(ds):
    print(f"👉 [Step 5.3] 重新计算 DWS 分类多维评分 (ds={ds})...")
    conn = open_connection()
    try:
        with conn.cursor() as cur:
            cur.execute(f"DELETE FROM dws.dws_github_repo_score_f_1d WHERE dt = {ds}")
            conn.commit()
    finally:
        conn.close()

    cmd = ["python3", str(PROJECT_ROOT / "scripts" / "run_dml.py"), "dws_github_repo_score_f_1d", "--ds", str(ds)]
    subprocess.run(cmd, check=True)
    print("   DWS 评分计算完成")


def step4_overwrite_ads(ds):
    print(f"👉 [Step 5.4] 覆盖写入 ADS 结果表 (ds={ds})...")
    cmd_score = ["python3", str(PROJECT_ROOT / "scripts" / "run_dml.py"), "ads_github_repo_score_f"]
    subprocess.run(cmd_score, check=True)

    cmd_repo = ["python3", str(PROJECT_ROOT / "scripts" / "run_dml.py"), "ads_github_trend_repo_f", "--ds", str(ds)]
    subprocess.run(cmd_repo, check=True)
    print("   ADS 表覆盖写入完成")


def step5_export_frontend():
    print("👉 [Step 5.5] 导出前端页面所需 JSON 数据文件...")
    cmd_scores = ["python3", str(PROJECT_ROOT / "scripts" / "projects" / "export_project_scores.py")]
    subprocess.run(cmd_scores, check=True)

    cmd_dash = ["python3", str(PROJECT_ROOT / "scripts" / "exports" / "generate_data_from_starrocks.py")]
    subprocess.run(cmd_dash, check=True)
    print("   前端数据导出完成：project-scores.json、projects.json 已更新")


def step6_verify():
    print("👉 [Step 5.6] 校验 StarRocks ADS 数据纠偏结果...")
    conn = open_connection()
    try:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM ads.ads_github_repo_score_f WHERE repo = '1Panel-dev/1Panel'")
            panel_res = cur.fetchall()
            cur.execute("SELECT * FROM ads.ads_github_repo_score_f WHERE repo = 'NaiboWang/EasySpider'")
            spider_res = cur.fetchall()
            cur.execute("SELECT * FROM ads.ads_github_repo_score_f WHERE repo = 'langgenius/dify'")
            dify_res = cur.fetchall()
            cur.execute("SELECT category, count(*) FROM ads.ads_github_repo_score_f GROUP BY category ORDER BY count(*) DESC")
            cat_counts = cur.fetchall()

            print(f"   [校验] 1Panel 在 ads_github_repo_score_f 中的记录数: {len(panel_res)} (期望: 0)")
            print(f"   [校验] EasySpider 在 ads_github_repo_score_f 中的记录数: {len(spider_res)} (期望: 0)")
            print(f"   [校验] Dify 在 ads_github_repo_score_f 中的分类: {[r['category'] for r in dify_res]}")
            print(f"   [校验] 当前各分类项目数量统计:")
            for item in cat_counts:
                print(f"         - {item['category']}: {item['count(*)']} 个")
    finally:
        conn.close()


def main():
    parser = argparse.ArgumentParser(description="执行分类下游同步第 5 步")
    parser.add_argument("--ds", type=int, default=20260906, help="要重算评分的业务快照日期，默认 20260906")
    args = parser.parse_args()

    print(f"🚀 开始执行第 5 步优化全链路闭环 (目标快照: {args.ds})...\n")
    step1_update_project_categories_json()
    step2_sync_dwd_category_table()
    step3_recalculate_dws(args.ds)
    step4_overwrite_ads(args.ds)
    step5_export_frontend()
    step6_verify()
    print("\n🎉 第 5 步下游同步与页面刷新全部圆满完成！")


if __name__ == "__main__":
    main()
