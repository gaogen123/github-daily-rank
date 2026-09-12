-- DWS 仓库评分 DML：从 DWD 指标表 + DWD 分类表计算分类内相对评分
-- 评分逻辑与 scripts/projects/project_scoring.py 一致（动量/活跃/参与/新鲜加权 + 黑马分）
-- 占位符 ${biz_curdate} 由 run_dml.py 替换为业务日期（yyyyMMdd）
-- 注：fork_delta_7d 暂缺（无每日快照），第一版按 0 处理

INSERT INTO dws.dws_github_repo_score_f_1d
WITH repo_cat AS (
    SELECT
        m.dt, c.category, m.repo,
        m.stars, m.forks, m.created_at, m.pushed_at, m.owner_created_at,
        m.commits_30d, m.open_issues, m.closed_issues, m.avg_issue_close_hours,
        m.open_prs, m.merged_prs, m.contributors, m.releases_30d, m.license_spdx,
        m.readme_bytes, m.readme_has_ci, m.readme_has_demo, m.has_code, m.is_collection,
        m.source_star_delta_7d AS star_delta_7d
    FROM dwd.dwd_github_repo_metrics_f_1d m
    JOIN dwd.dwd_github_repo_category_f c ON c.repo = m.repo
    WHERE m.dt = ${biz_curdate}
    UNION ALL
    SELECT
        m.dt, '全部' AS category, m.repo,
        m.stars, m.forks, m.created_at, m.pushed_at, m.owner_created_at,
        m.commits_30d, m.open_issues, m.closed_issues, m.avg_issue_close_hours,
        m.open_prs, m.merged_prs, m.contributors, m.releases_30d, m.license_spdx,
        m.readme_bytes, m.readme_has_ci, m.readme_has_demo, m.has_code, m.is_collection,
        m.source_star_delta_7d AS star_delta_7d
    FROM dwd.dwd_github_repo_metrics_f_1d m
    JOIN (SELECT DISTINCT repo FROM dwd.dwd_github_repo_category_f) c ON c.repo = m.repo
    WHERE m.dt = ${biz_curdate}
),
raw AS (
    SELECT
        rc.*,
        DATEDIFF(NOW(), rc.created_at) AS age_days,
        DATEDIFF(NOW(), rc.pushed_at) AS push_days,
        COALESCE(DATEDIFF(NOW(), rc.owner_created_at), 365) AS owner_age,
        ((rc.readme_bytes IS NOT NULL AND rc.readme_bytes < 200)
            OR (rc.has_code IS NOT NULL AND NOT rc.has_code)) AS excluded,
        (COALESCE(rc.star_delta_7d, 0) >= 2000
            AND COALESCE(rc.commits_30d, 0) = 0
            AND rc.owner_created_at IS NOT NULL
            AND COALESCE(DATEDIFF(NOW(), rc.owner_created_at), 365) < 90) AS suspicious,
        0.55 * LN(1 + COALESCE(rc.star_delta_7d, 0))
            + 0.20 * LN(1 + (COALESCE(rc.star_delta_7d, 0) / (COALESCE(rc.stars, 0) + 100)) * 100) AS raw_momentum,
        0.45 * LN(1 + COALESCE(rc.commits_30d, 0))
            + 0.20 / LN(COALESCE(DATEDIFF(NOW(), rc.pushed_at), 365) + 2)
            + 0.20 * LN(1 + COALESCE(rc.contributors, 3))
            + 0.15 / LN(COALESCE(rc.avg_issue_close_hours, 48) + 2) AS raw_activity,
        0.45 * LN(1 + COALESCE(rc.forks, 0))
            + 0.30 * (CASE WHEN COALESCE(rc.open_issues, 0) + COALESCE(rc.closed_issues, 0) <= 0 THEN 0.5
                           ELSE LEAST(1.0, COALESCE(rc.closed_issues, 0) * 1.0 / (COALESCE(rc.open_issues, 0) + COALESCE(rc.closed_issues, 0))) END)
            + 0.15 * (CASE WHEN COALESCE(rc.open_prs, 0) + COALESCE(rc.merged_prs, 0) <= 0 THEN 0.5
                           ELSE LEAST(1.0, COALESCE(rc.merged_prs, 0) * 1.0 / (COALESCE(rc.open_prs, 0) + COALESCE(rc.merged_prs, 0))) END)
            + 0.10 * LN(1 + COALESCE(rc.releases_30d, 0)) AS raw_engagement,
        1.0 / LN(COALESCE(DATEDIFF(NOW(), rc.created_at), 365) + 2) AS raw_freshness,
        (COALESCE(rc.star_delta_7d, 0) + COALESCE(rc.commits_30d, 0))
            / POWER(COALESCE(DATEDIFF(NOW(), rc.created_at), 365) + 2, 1.5) AS raw_hot,
        (CASE WHEN rc.license_spdx IS NOT NULL AND rc.license_spdx != '' THEN 100 ELSE 50 END
            + CASE WHEN COALESCE(rc.releases_30d, 0) > 0 THEN 100 ELSE 40 END
            + LEAST(100, LN(1 + COALESCE(rc.readme_bytes, 1000)) / LN(1 + 8000) * 100)
            + CASE WHEN COALESCE(rc.readme_has_ci, FALSE) THEN 100 ELSE 50 END
            + CASE WHEN COALESCE(rc.readme_has_demo, FALSE) THEN 100 ELSE 50 END) / 5.0 AS quality_score
    FROM repo_cat rc
),
norm AS (
    SELECT
        r.*,
        MIN(CASE WHEN r.excluded THEN NULL ELSE r.raw_momentum END) OVER (PARTITION BY r.category) AS min_momentum,
        MAX(CASE WHEN r.excluded THEN NULL ELSE r.raw_momentum END) OVER (PARTITION BY r.category) AS max_momentum,
        MIN(CASE WHEN r.excluded THEN NULL ELSE r.raw_activity END) OVER (PARTITION BY r.category) AS min_activity,
        MAX(CASE WHEN r.excluded THEN NULL ELSE r.raw_activity END) OVER (PARTITION BY r.category) AS max_activity,
        MIN(CASE WHEN r.excluded THEN NULL ELSE r.raw_engagement END) OVER (PARTITION BY r.category) AS min_engagement,
        MAX(CASE WHEN r.excluded THEN NULL ELSE r.raw_engagement END) OVER (PARTITION BY r.category) AS max_engagement,
        MIN(CASE WHEN r.excluded THEN NULL ELSE r.raw_freshness END) OVER (PARTITION BY r.category) AS min_freshness,
        MAX(CASE WHEN r.excluded THEN NULL ELSE r.raw_freshness END) OVER (PARTITION BY r.category) AS max_freshness,
        MIN(CASE WHEN r.excluded THEN NULL ELSE r.raw_hot END) OVER (PARTITION BY r.category) AS min_hot,
        MAX(CASE WHEN r.excluded THEN NULL ELSE r.raw_hot END) OVER (PARTITION BY r.category) AS max_hot
    FROM raw r
),
scored AS (
    SELECT
        n.dt, n.category, n.repo, n.excluded,
        CASE WHEN n.excluded THEN 0
             WHEN n.max_momentum = n.min_momentum THEN 50
             ELSE 100.0 * (n.raw_momentum - n.min_momentum) / NULLIF(n.max_momentum - n.min_momentum, 0)
        END AS momentum_score,
        CASE WHEN n.excluded THEN 0
             WHEN n.max_activity = n.min_activity THEN 50
             ELSE 100.0 * (n.raw_activity - n.min_activity) / NULLIF(n.max_activity - n.min_activity, 0)
        END AS activity_score,
        CASE WHEN n.excluded THEN 0
             WHEN n.max_engagement = n.min_engagement THEN 50
             ELSE 100.0 * (n.raw_engagement - n.min_engagement) / NULLIF(n.max_engagement - n.min_engagement, 0)
        END AS engagement_score,
        CASE WHEN n.excluded THEN 0
             WHEN n.max_freshness = n.min_freshness THEN 50
             ELSE 100.0 * (n.raw_freshness - n.min_freshness) / NULLIF(n.max_freshness - n.min_freshness, 0)
        END AS freshness_score,
        CASE WHEN n.excluded THEN 0
             WHEN n.max_hot = n.min_hot THEN 50
             ELSE 100.0 * (n.raw_hot - n.min_hot) / NULLIF(n.max_hot - n.min_hot, 0)
        END AS hot_score_norm,
        n.quality_score,
        (CASE WHEN COALESCE(n.license_spdx, '') != '' THEN 1.10 ELSE 1.0 END)
            * (CASE WHEN COALESCE(n.releases_30d, 0) > 0 THEN 1.15 ELSE 1.0 END)
            * (CASE WHEN n.contributors IS NOT NULL AND n.contributors <= 1 THEN 0.90 ELSE 1.0 END)
            * (CASE WHEN COALESCE(n.is_collection, FALSE) THEN 0.75 ELSE 1.0 END)
            * (CASE WHEN n.suspicious THEN 0.25 ELSE 1.0 END) AS quality_multiplier,
        (CASE WHEN COALESCE(n.is_collection, FALSE) THEN 0.75 ELSE 1.0 END)
            * (CASE WHEN n.suspicious THEN 0.25 ELSE 1.0 END) AS hot_multiplier
    FROM norm n
)
SELECT
    s.dt, s.category, s.repo,
    CASE WHEN s.excluded THEN 0
         ELSE LEAST(100, (0.40 * s.momentum_score + 0.25 * s.activity_score
                          + 0.20 * s.engagement_score + 0.15 * s.freshness_score) * s.quality_multiplier)
    END AS comprehensive_score,
    CASE WHEN s.excluded THEN 0
         ELSE LEAST(100, s.hot_score_norm * s.hot_multiplier)
    END AS hot_score,
    s.momentum_score, s.activity_score, s.engagement_score, s.quality_score, s.freshness_score, s.excluded
FROM scored s;
