# 科技新闻管道

新闻版块采用以下数据流：

```text
RSSHub → Python 采集与去重 → DeepSeek 编辑 → SQLite → news.json → 网站前端
```

SQLite 文件 `storage/news.db` 是新闻真源（已被 `.gitignore` 忽略）。`public/data/news.json` 是供前端读取的原子更新物化视图，可以安全地随网站构建发布。

## 配置

新闻源位于 `config/news-sources.json`。`path` 可以是 RSSHub 路径，也可以是完整的 RSS/Atom URL；通过 `enabled` 控制是否启用。

在项目根目录的 `.env.local` 中配置：

```dotenv
DEEPSEEK_API_KEY=your_api_key

# 可选
DEEPSEEK_BASE_URL=https://api.deepseek.com
DEEPSEEK_MODEL=deepseek-chat
RSSHUB_BASE_URL=http://127.0.0.1:1200
NEWS_MIN_SCORE=60
NEWS_MAX_PROCESS=20
NEWS_TIMEOUT=20
NEWS_REFRESH_CRON=*/30 * * * *
NEWS_REFRESH_TIMEZONE=Asia/Shanghai
ENABLE_NEWS_SCHEDULER=true
PYTHON_BIN=python3

# GitHub 项目 AI 分类
PROJECT_CATEGORY_MAX_PROCESS=100
PROJECT_CATEGORY_CRON=30 10 * * *
PROJECT_CATEGORY_TIMEZONE=Asia/Shanghai
ENABLE_PROJECT_CATEGORY_SCHEDULER=true

# GitHub 项目卡片图片
PROJECT_IMAGE_MAX_PROCESS=20
PROJECT_IMAGE_CRON=0 11 * * *
PROJECT_IMAGE_TIMEZONE=Asia/Shanghai
ENABLE_PROJECT_IMAGE_SCHEDULER=true
PLAYWRIGHT_CHROME_PATH=/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome
```

`.env.local` 不应提交到 Git。管道默认连接本机 `http://127.0.0.1:1200`。这是有意的：`rsshub.app` 官方演示实例可能对服务器请求返回 `403`，第三方公共实例也不保证可用性，不建议用于生产。

### RSSHub 部署

当前服务器没有 Docker，因此 RSSHub 已从 `DIYgod/RSSHub` 源码安装到 `/root/rsshub`，构建产物由 Supervisor 以 `rsshub` 服务名持续运行，监听 `http://127.0.0.1:1200`：

```bash
supervisorctl status rsshub
curl http://127.0.0.1:1200/healthz
```

RSSHub 必须使用 Node.js 24（当前路径为 `/opt/node-v24.19.0-linux-x64/bin/node`），不能使用系统自带的 Node.js 14。由于服务器访问部分上游需要代理，Supervisor 服务配置了 `PROXY_URI=http://127.0.0.1:7890`。

当前已实测并启用 12 个公开路由：

- `/36kr/newsflashes`（36氪最新资讯）
- `/ai-bot/daily-ai-news`（AI工具集每日资讯）
- `/juejin/category/ai`（掘金人工智能）
- `/openai/news`（OpenAI News）
- `/qbitai/category/%E8%B5%84%E8%AE%AF`（量子位）
- `/cnblogs/aggsite/topdiggs`（博客园热门）
- `/51cto/index/recommend`（51CTO 推荐）
- `/cursor/blog`（Cursor 博客，暂按用户所说“光标”理解）
- `/github/trending/daily/any`（GitHub Trending）
- `/hellogithub/home`（HelloGitHub）
- `/hackernews/newest`（Hacker News）
- `/zhihu/hot`（知乎热榜，非科技内容由 DeepSeek 相关度过滤）

以下来源已写入 `config/news-sources.json` 但保持禁用：InfoQ 中文和极客公园上游返回 `403`；技术头条证书过期；阿里云路由无内容；AI 博客响应超时；知识星球、Twitter、哔哩哔哩、微博和小红书需要账号参数、Cookie、Token 或 Playwright。“人为”尚不能确认对应的具体媒体。

36氪旧的最新资讯路由 `/36kr/news` 因上游页面结构变化返回 `503`，因此使用稳定的 `/36kr/newsflashes`。所有禁用项都记录了 `reason`，条件满足后可单独实测启用。

若其他环境支持 Docker，也可使用官方镜像：

```bash
docker run -d --name rsshub -p 1200:1200 diygod/rsshub
```

若 RSSHub 部署在其他主机，只需修改 `RSSHUB_BASE_URL`。第三方实例会收到你请求的公开订阅路径，使用前应自行评估其稳定性和信任风险。

## 手动运行

```bash
npm run news:refresh
```

每轮会：

1. 拉取所有启用的 RSSHub 源；
2. 按文章 URL 写入 SQLite 并去重；
3. 处理最多 `NEWS_MAX_PROCESS` 条待处理文章；
4. 让 DeepSeek 一次完成中文标题、1–2 句 TL;DR、标签、质量/相关度评分、保留判断和唯一主分类；
5. 主分类必须是 `AI热门`、`GitHub热门`、`后端`、`前端`、`Android`、`iOS`、`Web3` 之一，无法归类的内容必须 `keep=false`；
6. 将低于 `NEWS_MIN_SCORE` 或 `keep=false` 的内容过滤；
7. 原子更新 `public/data/news.json`。

待处理文章按来源轮转，每个来源优先处理最新内容，防止单个大 Feed 长期阻塞其他来源。前端“推荐”按质量分倒序、同分按发布时间倒序；“最新”仅按发布时间倒序。

未配置 `DEEPSEEK_API_KEY` 时仍会采集并写入 SQLite，但文章保持 `pending`，不会生成伪造摘要、分类或发布到前端。配置密钥后再次运行即可处理积压内容。

## GitHub 项目 AI 分类

主页 GitHub 趋势榜使用独立的 DeepSeek 多标签分类管道：

```bash
npm run projects:classify
```

分类严格限定为：`AI智能体`、`AI编程工具`、`AI开发平台`、`AI图像工具`、`AI视频工具`、`AI音频工具`、`AI搜索引擎`、`AI爬虫工具`、`Skills`、`AI营销`、`AI办公工具`、`AI设计工具`。普通或非 AI 项目返回空分类；每个项目最多 4 个分类。

SQLite 缓存位于 `storage/project-categories.db`，以仓库、名称和描述的 SHA256 指纹增量去重。只有新增或描述变化的项目才会再次调用 DeepSeek。前端读取动态导出文件 `public/data/project-categories.json`，在独立的“AI 产品分类”版块中展示全库已分类项目：桌面端使用左侧分类栏和右侧项目卡片，移动端改为横向分类条；支持最热、最受欢迎、增长最快、最新以及分批加载。原有按日期 GitHub 趋势排行榜保持不变。

默认每天 `10:30` 增量处理最多 100 个变化项目，可用 `PROJECT_CATEGORY_MAX_PROCESS` 和 `PROJECT_CATEGORY_CRON` 调整；设置 `ENABLE_PROJECT_CATEGORY_SCHEDULER=false` 可禁用。

## GitHub 项目卡片图片

所有 AI 产品目录卡片统一使用后台生成的本地图片，按以下顺序回退：

1. 从 GitHub REST API 读取仓库 `homepage`，使用 Chromium 截取官网首屏；
2. 无官网或截图失败时，根据仓库描述、Star、Fork 和语言在本地生成仓库预览图；
3. 前两步都失败时使用统一默认图。

图片统一裁切为 `1200×600`，并以质量参数 `72` 压缩为 WebP。文件保存于 `public/data/project-images/`，清单为 `public/data/project-images.json`，处理缓存为 `storage/project-images.json`。页面请求只读取已生成图片，不会实时访问官网或执行截图；尚未生成和加载失败的卡片均显示本地默认图，也不会批量依赖易受限流影响的 GitHub OpenGraph 服务。

```bash
npm run projects:images
# 手动扩大单批处理量；重复运行会跳过有效缓存
node scripts/project_images.mjs --max-process 100 --concurrency 2
```

正常图片缓存 30 天；项目名称、描述或 URL 变化时立即刷新。默认图或 GitHub 元数据请求失败的缓存会在 1 天后重试，避免短暂网络错误导致长期错过官网。默认每天 `11:00` 增量生成最多 20 张，可通过 `PROJECT_IMAGE_MAX_PROCESS`、`PROJECT_IMAGE_CRON` 和 `PROJECT_IMAGE_TIMEZONE` 调整；设置 `ENABLE_PROJECT_IMAGE_SCHEDULER=false` 可禁用。

## 自动调度

为避免未确认数据源和 DeepSeek 调用成本时自动产生请求，Node 服务默认不运行新闻任务。确认配置后设置：

```dotenv
ENABLE_NEWS_SCHEDULER=true
```

即可启用自动调度，默认每 30 分钟执行一次；可通过 `NEWS_REFRESH_CRON` 修改 Cron 表达式。单个来源失败不会阻止其他来源采集，但该轮命令会返回非零状态并在服务日志中记录错误。

## 测试

```bash
npm run test:news
npm run test:project-images
npm test
npm run build
```
