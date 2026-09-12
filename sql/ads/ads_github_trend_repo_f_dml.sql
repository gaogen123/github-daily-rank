-- ADS 应用层仓库表 DML：把 DWD 当天分区数据 INSERT OVERWRITE 到 ads_github_trend_repo_f
-- 日期变量：biz_curdate（即 ds，业务当前日期，bigint yyyyMMdd），脚本会替换下方 WHERE 条件中的日期占位符
-- 若只想取「今天」，可把 WHERE dt = ${biz_curdate} 改成 WHERE dt = CAST(date_format(current_date(), '%Y%m%d') AS BIGINT)

INSERT OVERWRITE ads.ads_github_trend_repo_f
SELECT
    full_name          , -- 仓库全名 owner/name
    dt                 , -- 快照日期
    repo_id            , -- GitHub 仓库 ID
    repo_url           , -- 仓库主页 html_url
    repo_name          , -- 仓库名 name
    description        , -- 项目描述
    homepage           , -- 项目主页
    language           , -- 主要编程语言
    default_branch     , -- 默认分支
    topics             , -- topics，JSON 数组字符串
    created_at         , -- 仓库创建时间
    updated_at         , -- 仓库最近更新时间
    pushed_at          , -- 最近推送时间
    size_kb            , -- 仓库大小（KB）
    stargazers_count   , -- Star 数
    watchers_count     , -- Watch 数
    forks_count        , -- Fork 数
    open_issues_count  , -- 未关闭 issue 数
    subscribers_count  , -- 订阅数
    network_count      , -- 网络 Fork 数
    archived           , -- 是否已归档
    disabled           , -- 是否已禁用
    is_fork            , -- 是否为 fork 仓库
    is_template        , -- 是否为模板仓库
    visibility         , -- 可见性 public/private/internal
    license_spdx       , -- 许可证 SPDX 标识
    license_name       , -- 许可证名称
    owner_login        , -- 所有者登录名
    owner_id           , -- 所有者 ID
    owner_type         , -- 所有者类型 User/Organization
    owner_html_url     , -- 所有者主页
    fetched_at         , -- 数据抓取写入时间
    open_graph_image_url,
    uses_custom_open_graph_image,
    image_fetched_at   ,
    category_list      , -- 产品分类列表 JSON 字符串
    primary_category   , -- 首选/第一主分类
    is_ai              , -- 是否为 AI 相关项目
    category_reason    , -- 分类思考链推理依据
    category_source    , -- 分类来源
    category_updated_at  -- 分类打标/更新时间
FROM dwd.dwd_github_trend_repo_f_1d
WHERE dt = ${biz_curdate};
