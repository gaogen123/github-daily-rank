-- DWD 仓库分类维度表：仓库 -> 产品分类（多对多，一个仓库可属多个分类）
-- 数据源：public/data/project-categories.json（DeepSeek 分类器产出）
-- 主键 (repo, category)，非分区维度表

CREATE TABLE IF NOT EXISTS dwd.dwd_github_repo_category_f (
    `repo`      varchar(512) NOT NULL COMMENT "仓库全名 owner/name",
    `category`  varchar(128) NOT NULL COMMENT "产品分类（AI智能体/AI编程工具/...）"
) ENGINE=OLAP
PRIMARY KEY (`repo`, `category`)
DISTRIBUTED BY HASH (`repo`) BUCKETS 1
PROPERTIES (
    "replication_num" = "1",
    "enable_persistent_index" = "true",
    "fast_schema_evolution" = "true",
    "replicated_storage" = "true"
);
