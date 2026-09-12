-- DWS 仓库评分表：按产品分类对仓库做相对评分（综合分 + 黑马分）
-- 数据源：dwd.dwd_github_repo_metrics_f_1d（指标）+ dwd.dwd_github_repo_category_f（分类）
-- 评分逻辑：与 scripts/projects/project_scoring.py 一致，改用 StarRocks SQL 实现
-- 主键 (dt, category, repo)，按天分区

CREATE TABLE IF NOT EXISTS dws.dws_github_repo_score_f_1d (
    `dt`                  bigint(20)     NOT NULL COMMENT "评分日期 yyyyMMdd（分区键）",
    `category`            varchar(128)   NOT NULL COMMENT "产品分类（含『全部』）",
    `repo`                varchar(512)   NOT NULL COMMENT "仓库全名 owner/name",
    `comprehensive_score` double         NULL COMMENT "综合评分 0~100",
    `hot_score`           double         NULL COMMENT "潜力黑马评分 0~100",
    `momentum_score`      double         NULL COMMENT "动量分",
    `activity_score`      double         NULL COMMENT "活跃分",
    `engagement_score`    double         NULL COMMENT "参与分",
    `quality_score`       double         NULL COMMENT "质量分",
    `freshness_score`     double         NULL COMMENT "新鲜分",
    `excluded`            boolean        NULL COMMENT "是否被排除（README 过短/无代码）"
) ENGINE=OLAP
PRIMARY KEY (`dt`, `category`, `repo`)
PARTITION BY (`dt`)
DISTRIBUTED BY HASH (`repo`) BUCKETS 1
PROPERTIES (
    "replication_num" = "1",
    "enable_persistent_index" = "true",
    "fast_schema_evolution" = "true",
    "replicated_storage" = "true"
);
