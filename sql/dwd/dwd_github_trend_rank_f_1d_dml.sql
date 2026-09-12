-- DWD 榜单排名明细表 DML：从 6 张 ODS 榜单取排名，LEFT JOIN 最新 DWD 仓库维度分区补元数据，写入一张表
-- 说明：
--   * sort_type 区分榜单类型（6 种）
--   * 仓库维度按「最新分区」关联（加 dt 分区条件，避免全表扫历史重复快照）
--   * 主键模型 (dt, sort_type, full_name)，INSERT 自动 upsert，重复执行不翻倍

INSERT INTO dwd.dwd_github_trend_rank_f_1d
SELECT
    r.dt,
    'daily_rank' AS sort_type,
    r.full_name,
    r.rank_num,
    r.total_stars,
    r.stars_today AS growth,
    r.daily_growth_rate AS growth_rate,
    r.opened_at,
    d.repo_id, d.repo_url, d.repo_name, d.description, d.homepage, d.language,
    d.default_branch, d.topics, d.created_at, d.updated_at, d.pushed_at, d.size_kb,
    d.stargazers_count, d.watchers_count, d.forks_count, d.open_issues_count,
    d.subscribers_count, d.archived, d.disabled, d.is_fork, d.is_template,
    d.visibility, d.license_spdx, d.license_name, d.owner_login, d.owner_id,
    d.owner_type, d.owner_html_url, NOW() AS crawled_at
FROM ods.ods_repo_github_daily_rank_f_1d r
LEFT JOIN dwd.dwd_github_trend_repo_f_1d d
       ON d.full_name = r.full_name
      AND d.dt = (SELECT MAX(dt) FROM dwd.dwd_github_trend_repo_f_1d)

UNION ALL

SELECT
    r.dt,
    'weekly_rank' AS sort_type,
    r.full_name,
    r.rank_num,
    r.total_stars,
    r.stars_week AS growth,
    CASE WHEN r.total_stars > r.stars_week
         THEN ROUND(r.stars_week / (r.total_stars - r.stars_week) * 100, 2)
         ELSE NULL END AS growth_rate,
    r.opened_at,
    d.repo_id, d.repo_url, d.repo_name, d.description, d.homepage, d.language,
    d.default_branch, d.topics, d.created_at, d.updated_at, d.pushed_at, d.size_kb,
    d.stargazers_count, d.watchers_count, d.forks_count, d.open_issues_count,
    d.subscribers_count, d.archived, d.disabled, d.is_fork, d.is_template,
    d.visibility, d.license_spdx, d.license_name, d.owner_login, d.owner_id,
    d.owner_type, d.owner_html_url, NOW() AS crawled_at
FROM ods.ods_repo_github_weekly_rank_f_1w r
LEFT JOIN dwd.dwd_github_trend_repo_f_1d d
       ON d.full_name = r.full_name
      AND d.dt = (SELECT MAX(dt) FROM dwd.dwd_github_trend_repo_f_1d)

UNION ALL

SELECT
    r.dt,
    'monthly_rank' AS sort_type,
    r.full_name,
    r.rank_num,
    r.total_stars,
    r.stars_month AS growth,
    CASE WHEN r.total_stars > r.stars_month
         THEN ROUND(r.stars_month / (r.total_stars - r.stars_month) * 100, 2)
         ELSE NULL END AS growth_rate,
    r.opened_at,
    d.repo_id, d.repo_url, d.repo_name, d.description, d.homepage, d.language,
    d.default_branch, d.topics, d.created_at, d.updated_at, d.pushed_at, d.size_kb,
    d.stargazers_count, d.watchers_count, d.forks_count, d.open_issues_count,
    d.subscribers_count, d.archived, d.disabled, d.is_fork, d.is_template,
    d.visibility, d.license_spdx, d.license_name, d.owner_login, d.owner_id,
    d.owner_type, d.owner_html_url, NOW() AS crawled_at
FROM ods.ods_repo_github_monthly_rank_f_1m r
LEFT JOIN dwd.dwd_github_trend_repo_f_1d d
       ON d.full_name = r.full_name
      AND d.dt = (SELECT MAX(dt) FROM dwd.dwd_github_trend_repo_f_1d)

UNION ALL

SELECT
    r.dt,
    'trending_daily' AS sort_type,
    r.full_name,
    r.rank_num,
    r.total_stars,
    r.stars_today AS growth,
    NULL AS growth_rate,
    NULL AS opened_at,
    d.repo_id, d.repo_url, d.repo_name, d.description, d.homepage, d.language,
    d.default_branch, d.topics, d.created_at, d.updated_at, d.pushed_at, d.size_kb,
    d.stargazers_count, d.watchers_count, d.forks_count, d.open_issues_count,
    d.subscribers_count, d.archived, d.disabled, d.is_fork, d.is_template,
    d.visibility, d.license_spdx, d.license_name, d.owner_login, d.owner_id,
    d.owner_type, d.owner_html_url, NOW() AS crawled_at
FROM ods.ods_crawl_day_github_trending_f_1d r
LEFT JOIN dwd.dwd_github_trend_repo_f_1d d
       ON d.full_name = r.full_name
      AND d.dt = (SELECT MAX(dt) FROM dwd.dwd_github_trend_repo_f_1d)

UNION ALL

SELECT
    r.dt,
    'trending_weekly' AS sort_type,
    r.full_name,
    r.rank_num,
    r.total_stars,
    r.stars_today AS growth,
    NULL AS growth_rate,
    NULL AS opened_at,
    d.repo_id, d.repo_url, d.repo_name, d.description, d.homepage, d.language,
    d.default_branch, d.topics, d.created_at, d.updated_at, d.pushed_at, d.size_kb,
    d.stargazers_count, d.watchers_count, d.forks_count, d.open_issues_count,
    d.subscribers_count, d.archived, d.disabled, d.is_fork, d.is_template,
    d.visibility, d.license_spdx, d.license_name, d.owner_login, d.owner_id,
    d.owner_type, d.owner_html_url, NOW() AS crawled_at
FROM ods.ods_crawl_week_github_trending_f_1d r
LEFT JOIN dwd.dwd_github_trend_repo_f_1d d
       ON d.full_name = r.full_name
      AND d.dt = (SELECT MAX(dt) FROM dwd.dwd_github_trend_repo_f_1d)

UNION ALL

SELECT
    r.dt,
    'trending_monthly' AS sort_type,
    r.full_name,
    r.rank_num,
    r.total_stars,
    r.stars_today AS growth,
    NULL AS growth_rate,
    NULL AS opened_at,
    d.repo_id, d.repo_url, d.repo_name, d.description, d.homepage, d.language,
    d.default_branch, d.topics, d.created_at, d.updated_at, d.pushed_at, d.size_kb,
    d.stargazers_count, d.watchers_count, d.forks_count, d.open_issues_count,
    d.subscribers_count, d.archived, d.disabled, d.is_fork, d.is_template,
    d.visibility, d.license_spdx, d.license_name, d.owner_login, d.owner_id,
    d.owner_type, d.owner_html_url, NOW() AS crawled_at
FROM ods.ods_crawl_mon_github_trending_f_1d r
LEFT JOIN dwd.dwd_github_trend_repo_f_1d d
       ON d.full_name = r.full_name
      AND d.dt = (SELECT MAX(dt) FROM dwd.dwd_github_trend_repo_f_1d);
