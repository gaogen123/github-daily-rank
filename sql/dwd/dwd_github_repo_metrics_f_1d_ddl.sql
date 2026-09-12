-- DWD 仓库指标明细表：GitHub 仓库级深度指标（用于后续 DWS 评分）
-- 数据源：scripts/projects/project_metrics.py 通过 GitHub GraphQL/REST 抓取后 Stream Load 写入
-- 主键 (dt, repo)，按天分区；同一天重复采集 upsert 覆盖

CREATE TABLE IF NOT EXISTS dwd.dwd_github_repo_metrics_f_1d (
    `dt`                      bigint(20)     NOT NULL COMMENT "采集日期 yyyyMMdd（分区键）",
    `repo`                    varchar(512)   NOT NULL COMMENT "仓库全名 owner/name",
    `github_url`              varchar(2048)  NULL COMMENT "GitHub 仓库地址",
    `homepage`                varchar(2048)  NULL COMMENT "项目主页",
    `description`             varchar(65533) NULL COMMENT "项目描述",
    `stars`                   bigint(20)     NULL COMMENT "Star 数",
    `forks`                   bigint(20)     NULL COMMENT "Fork 数",
    `created_at`              datetime       NULL COMMENT "仓库创建时间",
    `pushed_at`               datetime       NULL COMMENT "最近推送时间",
    `owner_created_at`        datetime       NULL COMMENT "所有者账号创建时间",
    `commits_30d`             bigint(20)     NULL COMMENT "近 30 天提交数",
    `open_issues`             bigint(20)     NULL COMMENT "开放 issue 数",
    `closed_issues`           bigint(20)     NULL COMMENT "已关闭 issue 数",
    `avg_issue_close_hours`   double         NULL COMMENT "issue 平均关闭耗时（小时）",
    `open_prs`                bigint(20)     NULL COMMENT "开放 PR 数",
    `merged_prs`              bigint(20)     NULL COMMENT "已合并 PR 数",
    `contributors`            bigint(20)     NULL COMMENT "贡献者数",
    `releases_30d`            bigint(20)     NULL COMMENT "近 30 天 release 数（0/1）",
    `license_spdx`            varchar(64)    NULL COMMENT "许可证 SPDX 标识",
    `readme_bytes`            bigint(20)     NULL COMMENT "README 字节数",
    `readme_has_ci`           boolean        NULL COMMENT "README 是否含 CI 标识",
    `readme_has_demo`         boolean        NULL COMMENT "README 是否含 demo/截图",
    `has_code`                boolean        NULL COMMENT "是否有代码",
    `is_collection`           boolean        NULL COMMENT "是否为合集/awesome 仓库",
    `source_star_delta_1d`    bigint(20)     NULL COMMENT "日增 Star（榜单来源）",
    `source_star_delta_7d`    bigint(20)     NULL COMMENT "周增 Star（榜单来源）",
    `source_star_delta_30d`   bigint(20)     NULL COMMENT "月增 Star（榜单来源）",
    `fetched_at`              datetime       NULL COMMENT "数据抓取时间"
) ENGINE=OLAP
PRIMARY KEY (`dt`, `repo`)
PARTITION BY (`dt`)
DISTRIBUTED BY HASH (`repo`) BUCKETS 1
PROPERTIES (
    "replication_num" = "1",
    "enable_persistent_index" = "true",
    "fast_schema_evolution" = "true",
    "replicated_storage" = "true"
);
