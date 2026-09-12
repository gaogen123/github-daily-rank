-- GitHub Trending / Rank 仓库维度表（DWD，主键模型 PRIMARY KEY）
-- 数据源：ODS 六张榜单/抓取表去重后的 full_name，经 GitHub REST API 补全仓库元数据
-- 主键模型：(dt, full_name)，按天分区；同一天重复执行按 upsert 覆盖，跨天保留历史快照
-- dt 为 bigint yyyyMMdd，按天自动分区 PARTITION BY (dt)，无需预先建分区

CREATE TABLE IF NOT EXISTS dwd.dwd_github_trend_repo_f_1d (
    `dt`                bigint(20)     NOT NULL COMMENT "快照日期 yyyyMMdd（分区键）",
    `full_name`         varchar(512)   NOT NULL COMMENT "仓库全名 owner/name",
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
    `raw_json`          varchar(65533) NULL COMMENT "GitHub API 原始响应 JSON（截断保存）",
    `fetched_at`        datetime       NULL COMMENT "数据抓取写入时间",
    `open_graph_image_url` varchar(4096) NULL COMMENT "GitHub 社交预览图 URL",
    `uses_custom_open_graph_image` boolean NULL COMMENT "是否为作者自定义封面；NULL 为未采集",
    `image_fetched_at` datetime NULL COMMENT "展示图采集时间 UTC",
    -- AI 产品分类扩展字段（5 步优化产出）
    `category_list`     varchar(1024)  NULL COMMENT "产品分类列表 JSON 字符串，例如 [\"AI智能体\", \"AI开发平台\"]",
    `primary_category`  varchar(128)   NULL COMMENT "首选/第一主分类（如 AI智能体）",
    `is_ai`             boolean        NULL COMMENT "是否为 AI 相关项目",
    `category_reason`   varchar(65533) NULL COMMENT "分类思考链推理依据",
    `category_source`   varchar(64)    NULL COMMENT "分类来源：deepseek-chat / manual-override / rule",
    `category_updated_at` datetime     NULL COMMENT "分类打标/更新时间"
) ENGINE=OLAP
PRIMARY KEY (`dt`, `full_name`)
PARTITION BY (`dt`)
DISTRIBUTED BY HASH (`full_name`) BUCKETS 1
PROPERTIES (
    "replication_num" = "1",
    "enable_persistent_index" = "true",
    "fast_schema_evolution" = "true",
    "replicated_storage" = "true"
);
