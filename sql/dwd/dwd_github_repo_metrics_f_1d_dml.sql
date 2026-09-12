-- DWD 仓库指标表依赖声明
-- 说明：本文件仅用于调度依赖解析，实际采集由 scripts/projects/project_metrics.py 完成
-- 指标采集需要 projects.json（含榜单星增量），由 ODS 日榜表生成
SELECT full_name FROM ods.ods_repo_github_daily_rank_f_1d;
