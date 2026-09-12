-- DWD 榜单排名明细表：把 6 种「排序规则」的排名合并到一张表，用 sort_type 区分
-- 数据源：
--   排名/指标  <- ODS 六张榜单/抓取表（rank_num / total_stars / growth / growth_rate / opened_at）
--   仓库元数据 <- DWD.dwd_github_trend_repo_f_1d 最新分区（加 dt 分区条件，LEFT JOIN）
-- 主键模型 (dt, sort_type, full_name)：同一榜单同一仓库重复执行 upsert 覆盖，跨天保留历史
-- dt 为 bigint yyyyMMdd，按天自动分区 PARTITION BY (dt)

CREATE TABLE IF NOT EXISTS dwd.dwd_github_trend_rank_f_1d (
    `dt`                bigint(20)     NOT NULL COMMENT "榜单统计日期 yyyyMMdd（分区键）",
    `sort_type`         varchar(32)    NOT NULL COMMENT "排序类型：daily_rank/weekly_rank/monthly_rank/trending_daily/trending_weekly/trending_monthly",
    `full_name`         varchar(512)   NOT NULL COMMENT "仓库全名 owner/name",
    `rank_num`          int(11)        NOT NULL COMMENT "榜单排名",
    `total_stars`       bigint(20)     NULL COMMENT "榜单抓取时的总 Star 数",
    `growth`            bigint(20)     NULL COMMENT "榜单周期增长量（对应 sort_type）",
    `growth_rate`       decimal(10,2)  NULL COMMENT "增速 %（日榜取原值，周/月榜计算，trending 为空）",
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
    `stargazers_count`  bigint(20)     NULL COMMENT "最新 Star 数（来自 DWD 最新快照）",
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
PRIMARY KEY (`dt`, `sort_type`, `full_name`)
PARTITION BY (`dt`)
DISTRIBUTED BY HASH (`full_name`) BUCKETS 1
PROPERTIES (
    "replication_num" = "1",
    "enable_persistent_index" = "true",
    "fast_schema_evolution" = "true",
    "replicated_storage" = "true"
);
