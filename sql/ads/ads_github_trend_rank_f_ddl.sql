-- ADS 榜单结果表（最新快照，非分区，INSERT OVERWRITE 全量覆盖）
-- 数据源：dwd.dwd_github_trend_rank_f_1d，每种 sort_type 取最新 dt
-- 模型：明细模型 DUPLICATE KEY(sort_type, full_name)，展示层直接按 sort_type 读取当前最新榜单

CREATE TABLE IF NOT EXISTS ads.ads_github_trend_rank_f (
    `dt`                bigint(20)     NOT NULL COMMENT "榜单统计日期 yyyyMMdd（该榜单最新快照日期）",
    `sort_type`         varchar(32)    NOT NULL COMMENT "排序类型：daily_rank/weekly_rank/monthly_rank/trending_daily/trending_weekly/trending_monthly",
    `full_name`         varchar(512)   NOT NULL COMMENT "仓库全名 owner/name",
    `rank_num`          int(11)        NOT NULL COMMENT "榜单排名",
    `total_stars`       bigint(20)     NULL COMMENT "榜单抓取时的总 Star 数",
    `growth`            bigint(20)     NULL COMMENT "榜单周期增长量（对应 sort_type）",
    `growth_rate`       decimal(10,2)  NULL COMMENT "增速 %",
    `opened_at`         date           NULL COMMENT "开源时间",
    `repo_id`           bigint(20)     NULL COMMENT "GitHub 仓库 ID",
    `repo_url`          varchar(2048)  NULL COMMENT "仓库主页 html_url",
    `repo_name`         varchar(255)   NULL COMMENT "仓库名 name",
    `description`       varchar(65533) NULL COMMENT "项目描述",
    `homepage`          varchar(2048)  NULL COMMENT "项目主页",
    `language`          varchar(64)    NULL COMMENT "主要编程语言",
    `default_branch`    varchar(255)   NULL COMMENT "默认分支",
    `topics`            varchar(65533) NULL COMMENT "topics，JSON 数组字符串",
    `created_at`        datetime       NULL COMMENT "仓库创建时间",
    `updated_at`        datetime       NULL COMMENT "仓库最近更新时间",
    `pushed_at`         datetime       NULL COMMENT "最近推送时间",
    `size_kb`           bigint(20)     NULL COMMENT "仓库大小（KB）",
    `stargazers_count`  bigint(20)     NULL COMMENT "最新 Star 数",
    `watchers_count`    bigint(20)     NULL COMMENT "Watch 数",
    `forks_count`       bigint(20)     NULL COMMENT "Fork 数",
    `open_issues_count` bigint(20)     NULL COMMENT "未关闭 issue 数",
    `subscribers_count` bigint(20)     NULL COMMENT "订阅数",
    `archived`          boolean        NULL COMMENT "是否已归档",
    `disabled`          boolean        NULL COMMENT "是否已禁用",
    `is_fork`           boolean        NULL COMMENT "是否为 fork 仓库",
    `is_template`       boolean        NULL COMMENT "是否为模板仓库",
    `visibility`        varchar(32)    NULL COMMENT "可见性 public/private/internal",
    `license_spdx`      varchar(64)    NULL COMMENT "许可证 SPDX 标识",
    `license_name`      varchar(255)   NULL COMMENT "许可证名称",
    `owner_login`       varchar(255)   NULL COMMENT "所有者登录名",
    `owner_id`          bigint(20)     NULL COMMENT "所有者 ID",
    `owner_type`        varchar(32)    NULL COMMENT "所有者类型 User/Organization",
    `owner_html_url`    varchar(2048)  NULL COMMENT "所有者主页",
    `crawled_at`        datetime       NULL COMMENT "数据写入时间"
) ENGINE=OLAP
DUPLICATE KEY (`dt`, `sort_type`, `full_name`)
DISTRIBUTED BY HASH (`full_name`) BUCKETS 1
PROPERTIES (
    "replication_num" = "1",
    "fast_schema_evolution" = "true",
    "replicated_storage" = "true"
);
