# GitHub Trending 与官方 API

> 结论截至 2026-08-24；仅依据 GitHub 官方文档和 GitHub 自身公开页面。

## 结论

- **官方公开且文档化的 REST API 和 GraphQL API 均没有 GitHub Trending 榜单接口。** REST 只提供通用的 [`Search repositories`](https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28#search-repositories)，GraphQL 也只有通用 [`search`](https://docs.github.com/en/graphql/reference/queries#search) 查询；二者都没有 `trending` 资源、字段或排序方式。
- GitHub 自己的 [Trending 页面](https://github.com/trending) 是网页功能，只能选择滚动的 **Today / This week / This month**，以及语言筛选；没有指定任意历史日期的入口。因此，官方 API **不能直接取得某个历史日期的真实 Trending 榜单**。
- 事后仅凭当前 API 数据也无法精确还原：Trending 的榜单快照和排名算法没有作为 API 数据公开，仓库当前累计 stars、当前元数据不等于当日新增 stars 或当时的榜单状态。

## 可用于近似计算的官方数据

### 1. Repository Search：生成候选集

[`GET /search/repositories`](https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28#search-repositories) 可使用与 GitHub 网页搜索相同的限定符：

- `created:YYYY-MM-DD..YYYY-MM-DD`：仓库创建时间；
- `pushed:YYYY-MM-DD..YYYY-MM-DD`：最后一次 push 时间。官方说明它对应仓库任意分支最近一次 commit；
- `stars:N`、`stars:>N`、`stars:N..M`：**当前累计** star 数；
- `language:...`、`topic:...`、`fork:true|only`、`archived:false`、`is:public` 等。

限定符定义见 GitHub 官方的 [Searching for repositories](https://docs.github.com/en/search-github/searching-on-github/searching-for-repositories)。Search 响应还包含 `created_at`、`updated_at`、`pushed_at`、`stargazers_count`、`forks_count`、`open_issues_count`、`language` 等当前值；官方响应示例见 [`Search repositories`](https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28#search-repositories)。

例如，可用下面两类查询近似发现“某日新建且受关注”或“某日活跃且总体热门”的仓库：

```text
created:2026-08-23..2026-08-23 is:public archived:false
pushed:2026-08-23..2026-08-23 is:public archived:false
```

再使用 `sort=stars&order=desc` 排序。但该排序依据是**查询时的累计 stars**，不是目标日期的新增 stars，所以只能得到替代榜单，不能复现 Trending。

### 2. Star 时间戳：对已知候选仓库计算增量

REST 的 [`List stargazers`](https://docs.github.com/en/rest/activity/starring?apiVersion=2022-11-28#list-stargazers) 在请求 `application/vnd.github.star+json` 媒体类型时可返回每次 star 的创建时间。理论上可对一个**已知候选集**统计目标日获得的 stars。

限制很强：

- 每页最多 100 条，需要逐仓库分页；
- 该接口列出当前 stargazers，官方也明确当前 star 计数不包含后来取消 star 的用户，因此不能恢复完整的历史毛增量；
- GitHub 已在 2026 年 7 月将 stargazers 列表访问限制为仓库管理员和协作者，普通第三方无法据此批量统计任意公共仓库；
- 它不能回答“全站哪些仓库当日新增 star 最多”，仍需先解决候选集发现问题。

GraphQL 可读取 Repository 的当前字段和连接，但同样没有 Trending 榜单或历史快照；还受每个连接 `first`/`last` 最大 100、点数和节点数限制，见 [GraphQL resource limits](https://docs.github.com/en/graphql/overview/resource-limitations)。

### 3. Events：只适合近期信号，不适合历史全量榜单

官方 [Events API](https://docs.github.com/en/rest/activity/events?apiVersion=2022-11-28) 中 `WatchEvent` 可表示 star、`PushEvent` 可表示 push。但事件时间线最多 300 条、只保留最近 30 天，而且公开事件延迟可能为 30 秒到 6 小时。全站事件流因此不是完整历史数据源，不能可靠重建 Trending。

## 主要 API 限制

- Search 每个查询最多返回 **1,000** 个结果；一个查询最多在符合过滤条件的 **4,000** 个仓库范围内搜索；超时可能返回 `incomplete_results: true`。见 [REST Search 的限制](https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28#about-search)。
- Repository Search 只支持按 `stars`、`forks`、`help-wanted-issues`、`updated` 排序，**不支持按某日 star 增量排序**。见 [`Search repositories` 参数](https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28#search-repositories)。
- Search 的独立限流为：认证请求 30 次/分钟，未认证请求 10 次/分钟；REST 普通主限额通常为未认证 60 次/小时、认证用户 5,000 次/小时，另有次级限流。见 [Search rate limit](https://docs.github.com/en/rest/search/search?apiVersion=2022-11-28#rate-limit) 和 [REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28)。
- API 返回的是查询时可见的当前仓库状态；`created`/`pushed` 是日期过滤条件，并不是“as of 某日”的快照参数。

## 实务建议

若需要稳定的每日榜单，应从现在开始定时保存：

1. 当时的 [Trending 页面](https://github.com/trending)结果，作为“GitHub Trending”真值快照；或
2. 固定 Search 查询得到的候选集及每个仓库的累计 stars/push 时间，以相邻快照差值计算自定义“近似 Trending”。

历史日期若此前没有快照，只能生成基于当前数据的替代排名，结果应明确标注为“近似榜单”，不能称为 GitHub 官方 Trending 历史榜单。
