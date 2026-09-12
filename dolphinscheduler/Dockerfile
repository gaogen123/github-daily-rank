# DolphinScheduler standalone 扩展镜像：加装运行榜单增量脚本所需依赖
FROM node:22-bookworm-slim AS node-runtime
WORKDIR /deps
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM apache/dolphinscheduler-standalone-server:3.4.2

USER root
COPY --from=node-runtime /usr/local/bin/node /usr/local/bin/node
COPY --from=node-runtime /deps/node_modules /app/github-daily-rank/node_modules

# git：增量脚本会 clone/pull OpenGithubs 仓库
# python3-pip：安装 pymysql / requests
RUN apt-get update \
    && apt-get install -y --no-install-recommends git python3-pip \
    && pip3 install --break-system-packages pymysql requests \
    && rm -rf /var/lib/apt/lists/*

# StarRocks 连接配置写入 /etc/profile.d：
# DolphinScheduler 用 `sudo -u <tenant> -i` 的 login shell 执行任务，
# 容器的 environment 会被 sudo 重置；只有 login shell 加载的 profile.d 能可靠传递。
RUN printf '%s\n' \
    'export STARROCKS_MYSQL_HOST=host.docker.internal' \
    'export STARROCKS_MYSQL_PORT=9030' \
    'export STARROCKS_USER=root' \
    'export STARROCKS_PASSWORD=' \
    'export STARROCKS_DB=ods' \
    'export STARROCKS_HTTP=http://host.docker.internal:8040' \
    > /etc/profile.d/starrocks.sh

# 代理配置与 sudo 环境变量保留：确保 Shell 任务在 sudo -u root -i 环境下执行 git 时能正常走宿主机代理
RUN printf '%s\n' \
    'export HTTP_PROXY=http://host.docker.internal:7897' \
    'export HTTPS_PROXY=http://host.docker.internal:7897' \
    'export http_proxy=http://host.docker.internal:7897' \
    'export https_proxy=http://host.docker.internal:7897' \
    'export NO_PROXY=127.0.0.1,localhost,host.docker.internal,postgresql,standalone' \
    'export no_proxy=127.0.0.1,localhost,host.docker.internal,postgresql,standalone' \
    > /etc/profile.d/proxy.sh \
    && echo 'Defaults env_keep += "http_proxy https_proxy HTTP_PROXY HTTPS_PROXY no_proxy NO_PROXY STARROCKS_MYSQL_HOST STARROCKS_MYSQL_PORT STARROCKS_USER STARROCKS_PASSWORD STARROCKS_DB STARROCKS_HTTP"' > /etc/sudoers.d/dolphinscheduler-proxy \
    && chmod 440 /etc/sudoers.d/dolphinscheduler-proxy \
    && git config --system http.proxy http://host.docker.internal:7897 \
    && git config --system https.proxy http://host.docker.internal:7897

