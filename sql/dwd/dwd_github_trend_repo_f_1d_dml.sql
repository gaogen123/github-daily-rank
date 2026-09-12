-- DWD 仓库维度表依赖声明
-- 说明：本文件仅用于调度依赖解析（脚本据此找到 6 张上游 ODS 表），
--       实际数据加载由 scripts/dwd/load_trend_repo_to_starrocks.py 完成（GitHub API 补全元数据）。
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
SELECT full_name, repo_url FROM ods.ods_repo_github_daily_rank_f_1d;
