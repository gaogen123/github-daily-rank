-- StarRocks ADS 表结构演进：为 ads_github_trend_repo_f 表新增 AI 产品分类相关字段
-- 适用场景：线上已有 ads_github_trend_repo_f 表，直接执行此 DDL 增加字段

ALTER TABLE ads.ads_github_trend_repo_f
    ADD COLUMN `category_list` varchar(1024) NULL COMMENT "产品分类列表 JSON 字符串",
    ADD COLUMN `primary_category` varchar(128) NULL COMMENT "首选/第一主分类",
    ADD COLUMN `is_ai` boolean NULL COMMENT "是否为 AI 相关项目",
    ADD COLUMN `category_reason` varchar(65533) NULL COMMENT "分类思考链推理依据",
    ADD COLUMN `category_source` varchar(64) NULL COMMENT "分类来源",
    ADD COLUMN `category_updated_at` datetime NULL COMMENT "分类打标/更新时间";
