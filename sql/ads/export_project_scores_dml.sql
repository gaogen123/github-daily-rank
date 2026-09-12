-- 导出任务依赖声明
-- 说明：本文件仅用于调度依赖解析，实际导出由 scripts/projects/export_project_scores.py 完成
-- 导出评分结果依赖 ADS 评分表
SELECT * FROM ads.ads_github_repo_score_f;
