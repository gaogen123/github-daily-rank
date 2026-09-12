-- ADS 应用层仓库表（最终结果表，非分区，INSERT OVERWRITE 全量覆盖）
-- 数据源：dwd.dwd_github_trend_repo_f_1d 当天分区
-- 模型：明细模型 DUPLICATE KEY(full_name)，每次用当天全量覆盖，保留 dt 作为快照日期

CREATE TABLE IF NOT EXISTS ads.ads_github_trend_repo_f (
    `full_name`         varchar(512)   NOT NULL COMMENT "仓库全名 owner/name",
    `dt`                bigint(20)     NOT NULL COMMENT "快照日期 yyyyMMdd",
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
    `stargazers_count`  bigint(20)     NULL COMMENT "Star 数",
    `watchers_count`    bigint(20)     NULL COMMENT "Watch 数",
    `forks_count`       bigint(20)     NULL COMMENT "Fork 数",
    `open_issues_count` bigint(20)     NULL COMMENT "未关闭 issue 数",
    `subscribers_count` bigint(20)     NULL COMMENT "订阅数",
    `network_count`     bigint(20)     NULL COMMENT "网络 Fork 数",
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
    `fetched_at`        datetime       NULL COMMENT "数据抓取写入时间",
    `open_graph_image_url` varchar(4096) NULL COMMENT "GitHub 社交预览图 URL",
    `uses_custom_open_graph_image` boolean NULL COMMENT "是否为作者自定义封面；NULL 为未采集",
    `image_fetched_at` datetime NULL COMMENT "展示图采集时间 UTC",
    -- AI 产品分类字段（来自 DWD）
    `category_list`     varchar(1024)  NULL COMMENT "产品分类列表 JSON 字符串",
    `primary_category`  varchar(128)   NULL COMMENT "首选/第一主分类",
    `is_ai`             boolean        NULL COMMENT "是否为 AI 相关项目",
    `category_reason`   varchar(65533) NULL COMMENT "分类思考链推理依据",
    `category_source`   varchar(64)    NULL COMMENT "分类来源",
    `category_updated_at` datetime     NULL COMMENT "分类打标/更新时间"
) ENGINE=OLAP
DUPLICATE KEY (`full_name`)
DISTRIBUTED BY HASH (`full_name`) BUCKETS 1
PROPERTIES (
    "replication_num" = "1",
    "fast_schema_evolution" = "true",
    "replicated_storage" = "true"
);
