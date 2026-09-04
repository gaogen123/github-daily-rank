-- GitHub Trending 每月抓取表（数据源：https://github.com/trending?since=monthly）
-- 主键模型：(dt, full_name)，按天动态分区（保留 30 天历史 + 3 天未来）

CREATE TABLE IF NOT EXISTS ods.ods_crawl_mon_github_trending_f_1d (
    `dt`          date           NOT NULL COMMENT "统计日期（分区键）",
    `full_name`   varchar(255)   NOT NULL COMMENT "仓库全名 owner/name",
    `rank_num`    int(11)        NOT NULL COMMENT "榜单排名",
    `repo_url`    varchar(512)   NULL COMMENT "仓库地址",
    `description` varchar(65533) NULL COMMENT "项目描述",
    `language`    varchar(64)    NULL COMMENT "主要编程语言",
    `total_stars` bigint(20)     NULL COMMENT "总 star 数",
    `stars_today` bigint(20)     NULL COMMENT "本期新增 star 数",
    `crawled_at`  datetime       NULL COMMENT "抓取时间"
) ENGINE=OLAP
PRIMARY KEY (`dt`, `full_name`)
PARTITION BY RANGE (`dt`) ()
DISTRIBUTED BY HASH (`full_name`) BUCKETS 1
PROPERTIES (
    "replication_num" = "1",
    "dynamic_partition.enable" = "true",
    "dynamic_partition.time_unit" = "DAY",
    "dynamic_partition.start" = "-30",
    "dynamic_partition.end" = "3",
    "dynamic_partition.prefix" = "p",
    "dynamic_partition.buckets" = "1",
    "enable_persistent_index" = "true",
    "fast_schema_evolution" = "true",
    "replicated_storage" = "true"
);
