-- GitHub 每周开源项目飙升榜（数据源：OpenGithubs/github-weekly-rank）
-- 主键模型：(dt, full_name) 唯一，Stream Load 按 upsert 去重
-- 按周分区：表达式分区 date_trunc('week', dt)，dt 为周标识（文件名日期）

CREATE TABLE IF NOT EXISTS ods.ods_repo_github_weekly_rank_f_1w (
    `dt`          date           NOT NULL COMMENT "周标识（分区键，取文件名日期）",
    `full_name`   varchar(255)   NOT NULL COMMENT "仓库全名 owner/name",
    `rank_num`    int(11)        NOT NULL COMMENT "周榜排名",
    `repo_url`    varchar(512)   NULL COMMENT "仓库地址",
    `repo_name`   varchar(255)   NULL COMMENT "项目中文名（可能为空）",
    `description` varchar(65533) NULL COMMENT "项目描述",
    `total_stars` bigint(20)     NULL COMMENT "总星标数量",
    `stars_week`  bigint(20)     NULL COMMENT "周增长星标（上周增长量）",
    `opened_at`   date           NULL COMMENT "开源时间",
    `crawled_at`  datetime       NULL COMMENT "数据写入时间"
) ENGINE=OLAP
PRIMARY KEY (`dt`, `full_name`)
PARTITION BY date_trunc('week', `dt`)
DISTRIBUTED BY HASH (`full_name`) BUCKETS 1
PROPERTIES (
    "replication_num" = "1",
    "enable_persistent_index" = "true",
    "fast_schema_evolution" = "true",
    "replicated_storage" = "true"
);
