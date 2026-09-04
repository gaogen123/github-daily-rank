# 项目目录说明

本项目同时包含 Web 应用、榜单数据、数据管道和调度基础设施。以下路径是约定的模块接口；整理文件时应保持这些入口稳定。

## 目录职责

| 路径 | 职责 | 注意事项 |
| --- | --- | --- |
| `src/` | Vite 前端源码 | 浏览器端代码集中于此 |
| `lib/` | Node.js 后端共享模块 | 由 `server.mjs` 引用 |
| `scripts/` | 按业务流水线组织的数据与运维脚本 | 根目录兼容入口保留旧调用路径，实际实现位于子目录 |
| `tests/` | Node.js 与 Python 测试 | 测试文件按被测模块命名 |
| `config/` | 可版本化配置 | 不应放置密钥 |
| `public/data/` | Web 应用读取的数据及生成结果 | 运行时会被数据生成脚本更新 |

| `sql/` | StarRocks DDL 和数据初始化 SQL | 按数据库或数据层继续分目录 |
| `dolphinscheduler/` | DolphinScheduler 自定义镜像 | 与 `docker-compose.dolphinscheduler.yml` 配套 |
| `docs/` | 架构、数据管道及运维说明 | 新文档统一放在这里 |
| `prototypes/` | 隔离的实验性实现 | 不应成为生产运行依赖 |
| `storage/` | 本地运行数据 | 已被 Git 忽略 |

## 脚本目录

| 路径 | 职责 |
| --- | --- |
| `scripts/rankings/` | 日榜、周榜和月榜的全量/增量入库 |
| `scripts/trending/` | GitHub Trending 抓取与入库 |
| `scripts/github-archive/` | GitHub Archive 聚合与入库 |
| `scripts/projects/` | 项目分类、指标、评分、图片和向量索引 |
| `scripts/news/` | 科技新闻流水线 |
| `scripts/exports/` | 从 StarRocks 生成 Web 数据 |
| `scripts/operations/` | StarRocks 容量监控等运维任务 |

`scripts/` 根目录中的同名脚本是旧路径兼容入口。仓库内调用应使用上述新路径；DolphinScheduler 等外部任务迁移完成后，才可删除对应兼容入口。

## 根目录稳定入口

以下文件保留在根目录，以兼容工具默认约定并降低部署风险：

- `package.json`、`package-lock.json`：Node.js 工程入口。
- `index.html`：Vite 构建入口。
- `server.mjs`：生产服务入口。
- `Dockerfile`、`docker-compose.yml`：应用容器入口。
- `docker-compose.dolphinscheduler.yml`：调度环境入口。
- `.env.example`：环境变量模板。

## 整理原则

1. 新脚本放入对应业务子目录；调整已有入口时同步更新仓库调用方，并为尚未迁移的外部调度任务保留兼容入口。
2. 不把生成数据混入 `src/`；前端继续通过 `public/data/` 使用数据。
3. 临时文件、Python 缓存、构建产物和本地存储不提交，遵循 `.gitignore`。
4. 新的实验代码放入 `prototypes/`，验证成熟后再迁入正式模块。
5. 基础设施文件与其专属资源保持相邻；DolphinScheduler 镜像资源留在 `dolphinscheduler/`。
