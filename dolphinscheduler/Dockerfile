# DolphinScheduler standalone 扩展镜像：加装运行榜单增量脚本所需依赖
FROM apache/dolphinscheduler-standalone-server:3.4.2

USER root

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
