# 语义搜索配置

项目使用 SiliconFlow 的 `BAAI/bge-m3` Embedding 模型和 Qdrant Cloud。
所有密钥仅由 Node 服务和离线建库脚本读取，不会进入浏览器资源。

## 环境变量

在项目根目录的 `.env.local` 中配置：

```env
SILICONFLOW_API_KEY=
QDRANT_URL=https://your-cluster.cloud.qdrant.io
QDRANT_API_KEY=
QDRANT_COLLECTION=github_projects_bge_m3_v1
EMBEDDING_MODEL=BAAI/bge-m3
EMBEDDING_DIMENSION=1024

# 批量读取 GitHub Topics 和 README 时强烈建议配置
GITHUB_TOKEN=

# 每日增量检测（以下均为默认值，可按需覆盖）
ENABLE_VECTOR_SCHEDULER=true
VECTOR_INDEX_CRON=0 10 * * *
VECTOR_INDEX_TIMEZONE=Asia/Shanghai
INDEX_CONCURRENCY=3
```

不要为这些变量添加 `VITE_` 前缀，否则可能被打包到浏览器代码中。

## 建立向量索引

首次建议先用少量项目验证配置：

```bash
npm run index:projects -- --limit=20
```

确认成功后执行完整建库：

```bash
npm run index:projects
```

脚本使用 `storage/search-documents.json` 保存断点：

- 已生成的 README 摘要不会重复生成。
- 内容未变化且已经写入 Qdrant 的项目不会重复调用 Embedding。
- 失败后重新执行会从未完成的项目继续。

索引命令有三种工作方式：

- `npm run index:projects`：只处理本地缓存中尚未建立文档的新项目。
- `npm run index:projects -- --refresh`：重新读取本项目项目清单，并从 GitHub 获取当前 Description、README 和 Topics；只对新增或内容发生变化的项目生成摘要和向量。首次刷新只为现有缓存建立远端内容基线，不会强制重算已有向量。
- `npm run index:projects -- --force`：忽略缓存，重新生成所有摘要和向量。该模式不应用于每日任务。

手动执行一次增量检测：

```bash
npm run index:projects -- --refresh
```

强制重新生成并覆盖向量：

```bash
npm run index:projects -- --force
```

## 索引内容

每个向量文档组合以下字段：

```text
项目名
名称
GitHub Description
README 中文摘要
Topic 标签
```

Qdrant Payload 同时保存 Star、首次入榜、最后入榜等展示字段。即使向量内容没有变化，增量任务也会单独同步发生变化的 Payload，不会因此重复调用 Embedding。

## 每日自动检测

Node 服务启动后，如果 SiliconFlow 和 Qdrant 配置完整，默认会在
`Asia/Shanghai` 时区每天 `10:00` 依次执行：

```bash
git pull --ff-only
node scripts/generate-data.mjs
node scripts/index-projects.mjs --refresh
```

`git pull --ff-only` 会从当前分支配置的上游仓库快进拉取最新代码，其中包括新增或更新的 Markdown 日报。只有拉取成功后才会重新解析日报并检测向量变化；如果本地修改与远程提交冲突，任务会失败且不会更新向量，不会自动覆盖本地工作。

任务仅处理本仓库 Markdown 日报中出现的 GitHub 项目。项目以小写
`owner/repo` 生成稳定 Qdrant Point ID，因此重复项目不会产生第二条向量；
内容哈希未变化时也不会重复计算 Embedding。

可通过 `VECTOR_INDEX_CRON` 修改 Cron 表达式，通过
`VECTOR_INDEX_TIMEZONE` 修改时区。设置
`ENABLE_VECTOR_SCHEDULER=false` 可关闭调度器。服务进程内设有互斥锁，若上一次任务尚未结束，本次调度会直接跳过。

自动调度依赖 Node 服务持续运行；服务停止期间不会补跑错过的任务。若 GitHub 限流或网络异常导致部分项目刷新失败，任务会记录失败状态，未更新的项目会在下一次运行时重试。

## 在线搜索

启动 Node 服务：

```bash
npm run dev
```

前端会请求 `POST /api/search`。服务未配置或暂时不可用时，前端自动回退到静态关键词搜索。

接口限制：

- 查询长度：2～300 字符
- 单次最多返回 100 个项目
- 每个 IP 每分钟最多 20 次请求
