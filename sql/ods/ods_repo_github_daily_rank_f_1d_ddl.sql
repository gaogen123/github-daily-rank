-- GitHub 每日开源项目飙升榜（数据源：OpenGithubs/github-daily-rank）
-- 主键模型：(dt, full_name) 唯一，Stream Load 按 upsert 去重
-- 按天分区：表达式分区 date_trunc('day', dt)，按写入日期自动创建日分区，无需预先建分区

CREATE TABLE IF NOT EXISTS ods.ods_repo_github_daily_rank_f_1d (
    `dt`                  date           NOT NULL COMMENT "统计日期（分区键）",
    `full_name`           varchar(255)   NOT NULL COMMENT "仓库全名 owner/name",
    `rank_num`            int(11)        NOT NULL COMMENT "当日榜单排名",
    `repo_url`            varchar(512)   NULL COMMENT "仓库地址",
    `repo_name`           varchar(255)   NULL COMMENT "项目中文名（可能为空）",
    `description`         varchar(65533) NULL COMMENT "项目描述",
    `total_stars`         bigint(20)     NULL COMMENT "总星标数量",
    `stars_today`         bigint(20)     NULL COMMENT "今日新增星标（日增长量）",
    `stars_week`          bigint(20)     NULL COMMENT "上周新增星标",
    `stars_month`         bigint(20)     NULL COMMENT "上月新增星标",
    `daily_growth_rate`   decimal(10,2)  NULL COMMENT "日增长率 %",
    `weekly_growth_rate`  decimal(10,2)  NULL COMMENT "周增长率 %",
    `monthly_growth_rate` decimal(10,2)  NULL COMMENT "月增长率 %",
    `opened_at`           date           NULL COMMENT "开源时间",
    `crawled_at`          datetime       NULL COMMENT "数据写入时间"
) ENGINE=OLAP
PRIMARY KEY (`dt`, `full_name`)
PARTITION BY date_trunc('day', `dt`)
DISTRIBUTED BY HASH (`full_name`) BUCKETS 1
PROPERTIES (
    "replication_num" = "1",
    "enable_persistent_index" = "true",
    "fast_schema_evolution" = "true",
    "replicated_storage" = "true"
);
