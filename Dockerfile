# syntax=docker/dockerfile:1

# ---------- 构建阶段 ----------
# 只打包前端静态资源；榜单数据改为运行时从 StarRocks 生成，构建阶段无需连接数据库
FROM node:22-alpine AS builder
WORKDIR /app

# 先复制依赖清单，充分利用 Docker 层缓存
COPY package.json package-lock.json ./
RUN npm ci

# 复制源码并打包（vite build 不依赖 public/data）
COPY . .
RUN npx vite build

# ---------- 运行阶段 ----------
FROM node:22-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production \
    PORT=3000

# 只安装生产依赖（express / node-cron / undici）
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# 安装 Python 运行时与连库依赖（启动时从 StarRocks 生成榜单数据需要）
RUN apk add --no-cache python3 py3-pip \
    && pip3 install --no-cache-dir --break-system-packages pymysql requests

# 运行时所需文件
COPY --from=builder /app/dist ./dist
COPY server.mjs ./
COPY lib ./lib

# 数据生成脚本与公开目录（public/data 在启动时由脚本写入）
COPY scripts ./scripts
COPY sql/dwd/dwd_github_repo_profile_f_ddl.sql ./sql/dwd/dwd_github_repo_profile_f_ddl.sql
COPY src/lib ./src/lib
COPY public ./public

# 统一交给 node 用户，便于非 root 运行
RUN mkdir -p storage && chown -R node:node /app
USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT:-3000}/" >/dev/null || exit 1

# 启动前先从 StarRocks 生成榜单数据，再启动服务
CMD ["sh", "-c", "python3 scripts/exports/generate_data_from_starrocks.py && node server.mjs"]
