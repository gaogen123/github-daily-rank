-- ADS 仓库评分结果表（最新快照，非分区，INSERT OVERWRITE 全量覆盖）
-- 数据源：dws.dws_github_repo_score_f_1d 最新分区
-- 用途：前端产品分类目录的「综合推荐 / 潜力黑马」排序数据源

CREATE TABLE IF NOT EXISTS ads.ads_github_repo_score_f (
    `dt`                  bigint(20)     NOT NULL COMMENT "评分日期 yyyyMMdd",
    `category`            varchar(128)   NOT NULL COMMENT "产品分类（含『全部』）",
    `repo`                varchar(512)   NOT NULL COMMENT "仓库全名 owner/name",
    `comprehensive_score` double         NULL COMMENT "综合评分 0~100",
    `hot_score`           double         NULL COMMENT "潜力黑马评分 0~100",
    `momentum_score`      double         NULL COMMENT "动量分",
    `activity_score`      double         NULL COMMENT "活跃分",
    `engagement_score`    double         NULL COMMENT "参与分",
    `quality_score`       double         NULL COMMENT "质量分",
    `freshness_score`     double         NULL COMMENT "新鲜分",
    `excluded`            boolean        NULL COMMENT "是否被排除"
) ENGINE=OLAP
DUPLICATE KEY (`dt`, `category`, `repo`)
DISTRIBUTED BY HASH (`repo`) BUCKETS 1
PROPERTIES (
    "replication_num" = "1",
    "fast_schema_evolution" = "true",
    "replicated_storage" = "true"
);
