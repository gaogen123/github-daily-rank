# GitHub Archive `WatchEvent` 与 Trending “stars today” 数量差异调查

> 调查日期：2026-08-27。优先使用 GitHub、GH Archive 和 Google Cloud 的一手公开资料。本文把已证实事实、项目实测和推断分开；没有把未获官方证实的机制描述为“采样”。

## 摘要结论

`githubarchive.day.20260826` 的 1,675 条 `WatchEvent(action=started)` **不能解释为 GitHub 在 2026-08-26 全站只新增了 1,675 个 star**。它准确表示的是：该 GH Archive 日表中有 1,675 条由公共 Events API 流被 GH Archive 获取并写入的此类记录。

GitHub 官方把 Events API 的 `WatchEvent` 定义为用户给仓库加 star；但是 GH Archive 不是 GitHub 的 star 交易账本，它通过轮询公共 `GET /events` 获取事件。GitHub 对这个 API 只文档化了滚动时间线、分页上限和延迟，没有承诺它是可用于审计的全量事件日志。Trending 则是 GitHub 自己的网页产品，页面显示 “stars today”，但公开页面没有定义其时区、窗口边界、净增/毛增、回撤处理或与 Events API 的对应关系。

因此，当前能证实的是**两个数据面的口径和采集路径不同，不能直接守恒比较**。现有一手资料不足以确定 2026-08-26 缺口究竟产生于 GitHub 公共 Events 流未暴露这些 star、GH Archive 轮询过程中遗漏，还是两者兼有；尤其没有官方依据把它称为某种确定比例或规则的“采样”。

## 已验证的项目数据

以下是题目提供、已经直接查询验证的结果，本文不重复执行 BigQuery：

| 指标 | `githubarchive.day.20260826` |
| --- | ---: |
| 全部事件 | 2,282,904 |
| `WatchEvent` 且 `payload.action = started` | 1,675 |
| 涉及仓库 | 1,393 |
| 涉及 actor | 1,641 |
| UTC 时间覆盖 | 00:01:28–23:57:45 |
| DWD 汇总 | 1,675 |

DWD 与原始 BigQuery 都是 1,675，只能证明当前下游汇总与这个 BigQuery 源一致。全天有 228 万条其他事件、且 `WatchEvent` 时间横跨全天，也只能排除“整张日表为空”或“只装载了一个很短连续时段”这类简单故障；它们**不能证明每一种事件类型都完整**。

## 可证事实

### 1. Events API 中的 `WatchEvent` 确实是 star，不是今天所说的通知订阅

GitHub 的 [Events API 事件类型文档](https://docs.github.com/en/rest/using-the-rest-api/github-event-types?apiVersion=2022-11-28#watchevent)明确写道：

- `WatchEvent` 的触发是用户 star 一个仓库；“watching” 是历史称呼；
- payload 的 `action` 只能是 `started`，表示用户给仓库加了 star。

GitHub 的 [Starring REST 文档](https://docs.github.com/en/rest/activity/starring?apiVersion=2022-11-28#about-starring)进一步澄清了历史命名：`watchers`、`watchers_count`、`stargazers_count` 都对应 star 数，真正的通知订阅人数使用 `subscribers_count`。

所以，把 BigQuery 中 `WatchEvent(action=started)` 解释为“加 star 事件”是正确的；不能因为名字叫 WatchEvent 就把 1,675 解释成通知订阅数。

需要避免把另一套 webhook 名称混进来：当前 webhook 文档分别有 [`star`](https://docs.github.com/en/webhooks/webhook-events-and-payloads#star) 和 [`watch`](https://docs.github.com/en/webhooks/webhook-events-and-payloads#watch) 事件，后者指仓库通知订阅。这不改变 Events API 中 `WatchEvent = star` 的官方定义。

### 2. GH Archive 归档的是公共 Events API 响应，不是 GitHub 内部 star 账本

GH Archive 官网说明，它记录 “public GitHub timeline”，并称每个归档包含 GitHub API 报告的 JSON 事件；2015-01-01 起的数据来自 Events API：

- [GH Archive 官网：下载与 BigQuery 说明](https://www.gharchive.org/)
- [GH Archive 项目 README](https://github.com/igrigorik/gharchive.org)

更直接的是其 [crawler README](https://github.com/igrigorik/gharchive.org/blob/master/crawler/README.md)：活动通过**周期性轮询 Events API**归档，并称不做额外后处理。公开的 [`crawler.rb`](https://github.com/igrigorik/gharchive.org/blob/master/crawler/crawler.rb) 请求的是 `https://api.github.com/events`，按事件 ID 与上一批响应去重、对 email 做隐私处理后写入小时文件；这些处理不补充缺失事件，也不会把其他类型转换成 `WatchEvent`。

因此数据链是：

```text
GitHub 公共 Events API → GH Archive 小时 JSON → BigQuery day 表 → 本项目 DWD
```

DWD 与 BigQuery 相等，只验证链路最后一段；它不验证公共 Events API 相对于 GitHub 内部 star 数据是否完整，也不验证 GH Archive 在轮询阶段没有错过记录。

### 3. Events API 官方公开的是受限滚动时间线，没有“全量审计日志”承诺

GitHub 的 [Events REST 文档](https://docs.github.com/en/rest/activity/events?apiVersion=2022-11-28)写明：

- 事件时间线最多包含 300 条；
- 只包含最近 30 天创建的事件；
- `List public events` 不为实时场景设计，延迟会随时段在 30 秒到 6 小时之间；
- `per_page` 最大为 100。

GitHub 的通用 [REST 分页文档](https://docs.github.com/en/rest/using-the-rest-api/using-pagination-in-the-rest-api?apiVersion=2022-11-28#changing-the-number-of-items-per-page)还明确说明：多数端点的 `per_page` 最大值为 100；传入更大值不会报错，而是被自动降到最大值，调用方可能在没有提示的情况下拿到少于预期的结果。

这些是可证限制。官方文档没有把 `GET /events` 定义为每个公开动作恰好出现一次、绝不丢失、可回放的全量日志。因此，不能从“接口事件类型包含 WatchEvent”推出“Archive 中 WatchEvent 数必等于 GitHub 当日所有 stars”。

### 4. GH Archive 公开 crawler 的设计存在漏取窗口，但不能据此断言它就是本日缺口原因

当前公开 [`crawler.rb`](https://github.com/igrigorik/gharchive.org/blob/master/crawler/crawler.rb) 有这些可观察行为：

- 设置 `PAGE_LIMIT = 500` 并请求 `/events?per_page=500`；按 GitHub 当前分页规则，服务端最多返回 100 条；
- 大约每 0.75 秒重新请求最新一页；
- 只将当前响应与上一批 ID 比较，没有沿 `Link` 分页回追；
- 只有 `new_events.size >= 500` 才记录 “Missed records”，但在每页最多 100 的规则下这个条件不会因单页装满而触发。

这证明该实现并非具有连续游标和补偿回放的审计采集器：如果两次可用响应之间有超过最新一页容量的、此前未见的事件，它在代码层面存在漏取可能。认证用户通常还有每小时 5,000 次 REST 请求的主限额及次级限流，见 [GitHub REST rate limits](https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api?apiVersion=2022-11-28#primary-rate-limit-for-authenticated-users)。

但必须保留两个边界：

1. 公开仓库中的当前源码不等于已证明的 2026-08-26 生产部署版本和运行状态；
2. 即使轮询可能漏取，也没有一手证据证明它会选择性地漏掉本日绝大多数 `WatchEvent`。

所以它是**可证的采集风险**，不是已经证实的 1,675 根因。

### 5. BigQuery day 表是同一 GH Archive 数据的装载形态，不是独立校验源

GH Archive 官网称 BigQuery 公共数据集由 GH Archive 自动按小时更新，并提供 year/month/day 表（例如 `day.20150101`）；schema 将通用字段拆列、将事件特有 payload 保留为 JSON 字符串，见 [官网 BigQuery 说明](https://www.gharchive.org/#bigquery)。

公开的 [`bigquery/upload.rb`](https://github.com/igrigorik/gharchive.org/blob/master/bigquery/upload.rb) 从小时归档转换后装入 `day.YYYYMMDD`。代码只会因旧版 BigQuery 的单行 2 MB 限制跳过超大编码事件；`WatchEvent` payload 只有很小的 `{"action":"started"}`，没有证据表明这一行大小限制可以解释本次 star 缺口。

Google Cloud 也把 GitHub “pulse since 2011”明确归因于 GitHub Archive 项目，见 [GitHub on BigQuery](https://cloud.google.com/blog/products/gcp/github-on-bigquery-analyze-all-the-open-source-code)。注意该文章主体还介绍另一个“GitHub 源代码快照”数据集；其中提到的 10% 文件样本属于代码内容表，**不能移植成 GH Archive Events 数据集的采样说明**。

### 6. Trending 官方页面能确认展示文案，不能确认其计算公式

GitHub 官方 [`Trending?since=daily`](https://github.com/trending?since=daily) 页面把 daily 视图描述为 “See what the GitHub community is most excited about today”，并在每个仓库旁显示形如 “N stars today” 的标签。调查时的实时页面确实可见单仓库数千 “stars today”，因此“页面量级可远高于 GH Archive 全日 1,675”这一现象本身成立。

但这个页面是滚动的实时页面，不提供 2026-08-26 历史快照；公开页面也没有给出以下定义：

- “today” 使用哪个时区以及何时滚动；
- 数字是加星动作毛数、当前仍保留的净增，还是其他内部统计；
- unstar、账号/仓库状态变化、反滥用过滤如何处理；
- 是否来自 Events API，或应与 `WatchEvent` 一一对应。

因此不能把 Trending 的 `N stars today` 当成 UTC 自然日 `WatchEvent(action=started)` 的官方校验和。它至少证明 GitHub 自身掌握并展示另一套日内 star 指标，但公开资料不足以证明两者应满足何种数值关系。

### 7. 2026 年 7 月的数据访问限制不能被扩写成 Events API “采样”公告

GitHub 于 2026-06-30 发布的官方 changelog [Upcoming access restrictions to public API endpoints and UI views](https://github.blog/changelog/2026-06-30-upcoming-access-restrictions-to-public-api-endpoints-and-ui-views/)宣布，2026 年 7 月起限制：

- `/repos/{owner}/{repo}/stargazers`；
- `/repos/{owner}/{repo}/subscribers`；
- `/users/{username}/subscriptions`；
- 对应 stargazers/watchers UI 列表。

公告给出的原因是防止公开用户列表被用于垃圾信息。它**没有列出** `/events`，也没有宣布对 `WatchEvent` 按比例采样、限量或停止发布。因此这项变更与调查日期相近，且说明 GitHub 正在收紧 stargazer 身份列表，但它不能作为“Events API 从 7 月开始采样 stars”的证据。

## 事实、推断与不能下的结论

| 分类 | 结论 |
| --- | --- |
| 可证事实 | `WatchEvent(action=started)` 在 Events API 中表示一次加 star。 |
| 可证事实 | GH Archive 轮询公共 `/events` 并归档其响应；BigQuery day 表由这些归档装载。 |
| 可证事实 | Events API 有 100/页、最多 300 条滚动时间线、30 天保留和 30 秒–6 小时延迟等限制。 |
| 可证事实 | 当前公开 crawler 只轮询最新页、无连续游标回放，架构上可能漏取。 |
| 可证事实 | Trending daily 页面显示 “stars today”，但官方页面未公开其精确统计公式和时区。 |
| 合理推断 | 1,675 更适合表述为“GH Archive 捕获到的 WatchEvent 记录数”，而不是“GitHub 全站当日 star 总数”。 |
| 尚未证实 | 缺口主要发生在 GitHub 对公共 Events 流的暴露层，还是 GH Archive 的轮询层。现有结果无法在二者间归因。 |
| 尚未证实 | GitHub 对 `WatchEvent` 使用了某种采样比例、按仓库/actor 限流或反滥用过滤。官方来源没有给出这种机制。 |
| 不能推出 | “全天总事件 228 万且时间覆盖完整”意味着各事件类型都完整。 |
| 不能推出 | “BigQuery = DWD = 1,675”意味着 1,675 等于 GitHub 的真实加星数。 |
| 不能推出 | 2026 年 7 月 stargazer 列表访问限制已经改变或采样了 `/events`。公告没有这样说。 |

## 对项目的建议口径

1. **命名**：将基于 GH Archive 的指标命名为“captured WatchEvents”或“GH Archive star events”，不要直接命名为“stars today”。
2. **用途**：在 2026-08-26 这种明显失配的日期，不应用该字段计算或复刻 GitHub Trending，也不应把零/小值解释为仓库没有获得 stars。
3. **Trending 真值**：若目标是复现 GitHub Trending，应按固定频率保存官方 Trending 页面及其 “stars today” 文案；官方页面不提供任意历史日回查。
4. **独立校验**：对已知候选仓库，可使用有权限的数据面或定时累计 `stargazers_count` 快照做差；当前计数会受 unstar 等变化影响，仍需明确它是自定义口径。GitHub 官方说明当前 stargazer count 不包含后来取消 star 的用户，见 [`Get stargazer count`](https://docs.github.com/en/rest/activity/starring?apiVersion=2022-11-28#get-stargazer-count)。
5. **继续定位根因所需证据**：至少需要同小时 GH Archive 原始 JSON、当时 `/events` 连续响应/headers/状态日志，以及 GitHub 对公共 Events 流在该日期的官方说明。仅凭现有 BigQuery 聚合无法区分“上游未发布”和“轮询未捕获”。

## 最终回答

为什么 228 万总事件中只有 1,675 条 `WatchEvent`，而 Trending 单仓库却显示数千 “stars today”？

**可证的回答是：两者不是同一个有守恒保证的数据源。** GH Archive 的 1,675 来自受限、滚动且由第三方轮询的公共 Events API；Trending 的数字来自 GitHub 官方网页内部指标，计算口径没有公开。228 万总事件和全天时间覆盖不能证明 `WatchEvent` 类型完整，BigQuery 与 DWD 相等也只能证明下游一致。

**不能诚实声称的回答是：GitHub 按某个已知规则采样了 WatchEvent。** 本次查到的 GitHub 官方文档和 changelog 没有公布这种机制。公开 crawler 的确存在漏取窗口，但现有证据也不足以把 2026-08-26 的巨大且可能具有事件类型选择性的缺口单独归因给它。故精确根因目前应标记为“公开一手资料未证实”，而不是命名一种未经证实的采样机制。
