# 项目能力档案与自然语言搜索

项目档案以 StarRocks 为真源，Qdrant 只保存可重建的检索索引。网站请求不调用模型生成档案。

```text
六张 ODS 榜单 + DWD/ADS 仓库 + DWD 指标
  → 去重项目清单 → README / Description / Topics
  → Gemini / DeepSeek JSON 提取 → 校验字段和来源摘录
  → dwd.dwd_github_repo_profile_f
  → public/data/project-profiles.json
  → Gemini (text-embedding-004) 或 SiliconFlow Embedding → Qdrant → POST /api/search
```

## 配置与首次运行

使用 Node.js 22、Python 3.9+，Python 依赖为 `pymysql`、`requests`。安装到虚拟环境后，把该环境的 `python3` 放到 PATH 前面；npm 脚本使用 PATH 中的 `python3`。

把 `.env.example` 中的 StarRocks、GitHub、Gemini（或 DeepSeek）、Qdrant 配置填入项目根目录 `.env.local`。生产环境也可以注入环境变量，优先级高于文件。GitHub Token 用于提高公开仓库 API 限额。读取私有仓库不是本功能的目标。

### 模型与向量配置选项

1. **Gemini 方案（推荐）**：
   - 档案能力提取：配置 `GEMINI_API_KEY`（默认使用 `gemini-2.5-flash`，模型地址 `https://generativelanguage.googleapis.com/v1beta/openai`）。
   - 语义向量嵌入：当配置 `GEMINI_API_KEY` 时，向量模块自动切换为 `provider: gemini`，默认模型 `text-embedding-004`，向量维度 `768`，默认集合 `github_projects_gemini_v1`。
2. **DeepSeek + SiliconFlow 方案**：
   - 档案能力提取：配置 `DEEPSEEK_API_KEY`（默认使用 `deepseek-chat`）。
   - 语义向量嵌入：配置 `SILICONFLOW_API_KEY`（默认模型 `BAAI/bge-m3`，向量维度 `1024`，集合 `github_projects_profiles_v1`）。

按以下顺序手动运行：

```bash
npm ci
python3 -m pip install pymysql requests
npm run profiles:init
npm run profiles:refresh -- --dry-run
npm run profiles:refresh -- --limit 100
npm run profiles:export
npm run index:projects
```

`profiles:init` 只创建独立档案表，不修改现有仓库表；需要已有 `dwd` 数据库和建表权限。其他档案命令不会自动建表。`--dry-run` 只读数据库，不创建锁文件、调用 GitHub/模型、生成 JSON 或写入档案。

首次先检查100份档案和来源证据，再重复运行 `profiles:refresh` 补齐其余项目。每批默认100条、并发3，可以用 `--limit`、`PROFILE_BATCH_SIZE`、`PROFILE_CONCURRENCY` 调整。`--repo owner/name` 立即检查指定已收录项目；`--force` 强制重新提取选中项目，索引脚本的 `--force` 则强制重建选中项目向量。

正在运行的网站应显式保留原 `QDRANT_COLLECTION`，先用上述命令构建新集合。验证完成后，把网站配置切换到新集合（Gemini 为 `github_projects_gemini_v1`）并重启。回退时改回旧集合，无需删除档案表或 JSON。不要用旧集合名称执行新版索引命令，否则其向量会被更新。

## 数据约定

档案表主键是转为小写的 `full_name`。内容字段：

| 字段 | 内容 |
| --- | --- |
| `summary` | 最多300字的中文简介 |
| `capabilities` | 能做什么，最多8条 |
| `features` | 明确支持的特点，最多8条 |
| `use_cases` | 适用需求或场景，最多8条 |
| `keywords` | 最多16个检索关键词 |
| `evidence_json` | 简介、功能、特点和场景的来源名称及原文摘录 |
| `source_urls`、`readme_sha`、`source_hash` | 来源链接、README版本和完整输入指纹 |
| `model`、`prompt_version` | 提取模型及提示词版本 |
| `generated_at`、`checked_at` | 最近成功处理及最近检查的 UTC 时间 |
| `status`、`last_error`、`retry_count`、`next_retry_at` | 状态及失败重试信息 |

数组及对象以 JSON 字符串存储。每条记录使用完整 UPSERT，避免依赖 StarRocks 特定版本的部分更新行为。

README 按标题分段，优先介绍、功能、用法和部署内容；移除注释、脚本块及 Markdown 图片。提交给模型的资料总量上限为24,000字符。保留截断标记；完整原文只参与哈希，不导出到网站。没有 README 时使用元数据；没有足够资料时为 `insufficient`，不猜测功能。

模型输出必须通过结构和原文摘录校验，但“摘录存在”不能证明中文归纳绝对正确，首次样本仍需人工核查语义，尤其是离线、许可和计划中的功能。资料中的指令被当作数据处理。

导出格式是 `{schemaVersion: 1, generatedAt, projects: {"owner/repo": {...}}}`。`projects` 包含完整去重清单；有有效档案的项目附带 `summary`、`capabilities`、`features`、`useCases`、`keywords`、`profileUpdatedAt`。无档案的项目仍以原始描述参与搜索。失败信息、证据摘录和原始 README 不公开。

`POST /api/search` 保持 `{query, minStars?, maxStars?, limit?}` 输入以及 `{projects, mode}` 输出。`maxStars` 缺省或为 `null` 表示无上限，`0` 是有效上限。结果新增上述档案字段，仍含 `semanticScore`。网页搜索默认不限制 Star；榜单原有筛选不变，用户在搜索页设置范围后会重新检索。

首版按语义相似度匹配需求，不做自然语言硬条件解析，也不生成聊天回答。关键词搜索会匹配所有档案字段。

## 增量更新与调度

默认优先未处理项目、到期失败项目、超过7天未检查或模型/提示词版本变化的项目。README、描述、Topics 等输入内容未变时跳过模型；Star 改变不参与模型输入哈希。HTTP暂时失败最多尝试3次并退避，单项目失败保留上一份成功内容及其来源，下轮按 `next_retry_at` 重试（2小时起，最长7天）。单行失败不会阻塞其余有效档案发布；连库/写库失败则使任务失败。

档案任务使用共享目录文件锁。索引缓存按 Qdrant 地址、集合、模型和维度隔离，每32个项目一批，向量/附带字段写入成功后才提交本地检查点。索引被强制终止可能留下 `storage/search-documents-*.json.lock`：确认没有其他索引进程后再删除该锁重试。档案锁会随进程退出释放。所有写入使用幂等主键，导出和缓存采用原子替换。

独立 DolphinScheduler 工作流：

```bash
python3 scripts/ds_release_workflow.py \
  --project github_rank --workflow github_project_profiles --profiles --dry-run

# 设置实际的 API 连接参数后发布；默认上线每日10:30 Asia/Shanghai定时任务
python3 scripts/ds_release_workflow.py \
  --project github_rank --workflow github_project_profiles --profiles
```

`--dry-run` 完全不调用调度 API，输出三个任务及依赖、Cron和时区。正式发布为串行等待工作流：`refresh_project_profiles → export_project_profiles → index_project_profiles`，创建或更新一条定时配置；`--no-release` 仅保存工作流，不启用定时任务。不会把档案链路混进已有其他业务工作流。

Docker 调度镜像现在包含 Node.js 22 和生产 Node 依赖。构建上下文已改为仓库根目录，专用 `profiles-node-modules` 卷避免被项目目录挂载覆盖。更新依赖时同步更新该依赖卷；不能复用其他平台的本机 `node_modules`。Worker 使用项目根目录 `.env.local` 读取模型凭据及 Qdrant 配置。部署时保持工作目录和 `storage/` 可写；应用容器继续通过共享的 `public/data/` 读取导出结果。

默认 `ENABLE_VECTOR_SCHEDULER=false`，由 DolphinScheduler 管理。只有单机替代方案才设为 `true`，Node 的每日10:30任务会依次更新榜单、导出项目、更新档案、导出档案、同步向量。不要同时启用两种调度。

每轮日志包含 `total`、`selected`、`processed`、`skipped`、`errors`、`pending`。巡检时查看未生成、失败以及最近成功更新时间，不能只看调度节点成功状态；`insufficient` 项目还需补充上游资料。

## 验证与搜索质量

```bash
npm test
python3 -m unittest discover -s tests -p 'test_*.py'
npx vite build
```

`config/project-search-evaluation.json` 提供20条固定需求，初始 `expectedRepos` 留空，明确不是已经验证的答案。首批档案完成后，人工依据 README 标注样本中相关项目；无法覆盖的需求替换为样本内可验证需求，保存这套查询用于新旧方案对比，不能按搜索结果反推答案。

```bash
# 旧服务保留旧代码及旧集合，在独立端口生成基线
npm run profiles:evaluate -- --base-url=http://127.0.0.1:3001 --output=/tmp/search-baseline.json
# 新服务使用档案集合，对比相同查询
npm run profiles:evaluate -- --base-url=http://127.0.0.1:3000 --baseline=/tmp/search-baseline.json --output=/tmp/search-profiles.json
```

评估器拒绝未完成标注的查询集，且在验证标注前不发搜索请求。验收为至少80%的查询前5条含人工标注的相关项目，报告同时列出与旧服务的差异。每次20条查询会产生查询向量调用，请避开服务已有每分钟20次的限流窗口。单元测试和模拟页面验证不代表真实模型的检索质量已达到此门槛。
