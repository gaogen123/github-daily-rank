#!/usr/bin/env python3
"""通过 DolphinScheduler API 上线指定表名的数据任务。

用法：
  python3 scripts/ds_release_workflow.py \
      --project github_rank --workflow github_rank \
      --tables ods_repo_github_daily_rank_f_1d,dwd_github_trend_repo_f_1d,ads_github_trend_rank_f

  # 只预览生成的节点/依赖/坐标，不调用 API
  python3 scripts/ds_release_workflow.py \
      --project github_rank --workflow github_rank \
      --tables dwd_github_trend_rank_f_1d,ads_github_trend_rank_f --dry-run

功能：
  1. 根据表名前缀自动分层：ods_/dwd_/dws_/ads_；
  2. 同层任务每行放 3 个，节点间小间隔；不同层之间大间隔；
  3. 自动找依赖任务并配置依赖（有 DML 的表解析 FROM/JOIN，无 DML 的表查 DEPENDENCIES）；
  4. 增量更新工作流（保留已有任务），然后上线。
"""

import argparse
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
import json
import re
import sys
import urllib.parse
import urllib.request
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parent.parent
SQL_ROOT = PROJECT_ROOT / "sql"

LAYER_ORDER = ["ods", "dwd", "dws", "ads"]
LAYER_START_X = {"ods": 200, "dwd": 1200, "dws": 2200, "ads": 3200}
COLUMNS_PER_ROW = 3
Y_START = 100
Y_GAP = 130
X_GAP = 240

GLOBAL_PARAMS = [
    {"prop": "biz_date", "direct": "IN", "type": "VARCHAR", "value": "${system.biz.date}"},
    {"prop": "biz_curdate", "direct": "IN", "type": "VARCHAR", "value": "${system.biz.curdate}"},
    {"prop": "task_name", "direct": "IN", "type": "VARCHAR", "value": "${system.task.definition.name}"},
]

# 无 DML 的表：内置加载脚本命令
PROFILE_WORKFLOW = {
    "refresh_project_profiles": [],
    "export_project_profiles": ["refresh_project_profiles"],
    "index_project_profiles": ["export_project_profiles"],
}
PROFILE_SCHEDULE = {"crontab": "0 30 10 * * ? *", "timezoneId": "Asia/Shanghai"}

LOADERS = {
    "refresh_project_profiles": "python3 /app/github-daily-rank/scripts/projects/project_profiles.py",
    "export_project_profiles": "python3 /app/github-daily-rank/scripts/projects/project_profiles.py --export-only",
    "index_project_profiles": "node /app/github-daily-rank/scripts/projects/index-projects.mjs --refresh",
    "ods_repo_github_daily_rank_f_1d": "python3 /app/github-daily-rank/scripts/load_daily_rank_incremental.py",
    "ods_repo_github_weekly_rank_f_1w": "python3 /app/github-daily-rank/scripts/load_weekly_rank_incremental.py",
    "ods_repo_github_monthly_rank_f_1m": "python3 /app/github-daily-rank/scripts/load_monthly_rank_incremental.py",
    "ods_crawl_day_github_trending_f_1d": "python3 /app/github-daily-rank/scripts/crawl_and_load_trending.py --since daily --dt ${biz_curdate}",
    "ods_crawl_week_github_trending_f_1d": "python3 /app/github-daily-rank/scripts/crawl_and_load_trending.py --since weekly --dt ${biz_curdate}",
    "ods_crawl_mon_github_trending_f_1d": "python3 /app/github-daily-rank/scripts/crawl_and_load_trending.py --since monthly --dt ${biz_curdate}",
    "dwd_github_trend_repo_f_1d": "python3 /app/github-daily-rank/scripts/dwd/load_trend_repo_to_starrocks.py --dt '${biz_curdate}'",
    "dwd_github_repo_metrics_f_1d": "python3 /app/github-daily-rank/scripts/projects/project_metrics.py collect",
    "export_project_scores": "python3 /app/github-daily-rank/scripts/projects/export_project_scores.py",
    "export_dashboard_data": "python3 /app/github-daily-rank/scripts/exports/generate_data_from_starrocks.py",
}

# 非表任务（脚本任务）的层级覆盖
LAYER_OVERRIDES = {
    "refresh_project_profiles": "dwd",
    "export_project_profiles": "dws",
    "index_project_profiles": "ads",
    "export_project_scores": "ads",
    "export_dashboard_data": "ads",
}

TASK_FIELDS = [
    "code", "name", "version", "description", "taskType", "taskParams",
    "flag", "taskPriority", "workerGroup", "environmentCode",
    "failRetryTimes", "failRetryInterval", "timeoutFlag", "timeout", "delayTime",
]


class DSClient:
    def __init__(self, host, port, user, password):
        self.base = f"http://{host}:{port}/dolphinscheduler"
        self.session = self._login(user, password)

    def _call(self, method, path, params=None, form=None):
        url = self.base + path
        headers = {"Cookie": f"sessionId={self.session}"}
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = None
        if form is not None:
            data = urllib.parse.urlencode(form).encode()
            headers["Content-Type"] = "application/x-www-form-urlencoded"
        req = urllib.request.Request(url, data=data, headers=headers, method=method)
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())

    def configure_profile_schedule(self, project_code, workflow_code):
        base = f"/projects/{project_code}/schedules"
        def checked(method, path, **kwargs):
            response = self._call(method, path, **kwargs)
            if response.get("code") != 0:
                raise RuntimeError(f"调度配置失败：{response.get('msg', 'unknown error')}")
            return response.get("data")
        listing = checked("GET", base, params={"workflowDefinitionCode": workflow_code, "pageNo": 1, "pageSize": 100})
        schedules = listing.get("totalList", [])
        if len(schedules) > 1:
            raise RuntimeError("项目档案工作流有多个定时配置，请先保留一个")
        now = datetime.now(ZoneInfo("Asia/Shanghai"))
        schedule = {**PROFILE_SCHEDULE, "startTime": now.strftime("%Y-%m-%d %H:%M:%S"),
                    "endTime": (now + timedelta(days=3650)).strftime("%Y-%m-%d %H:%M:%S")}
        form = {"schedule": json.dumps(schedule), "failureStrategy": "END", "warningType": "NONE"}
        if schedules:
            schedule_id = schedules[0]["id"]
            if schedules[0].get("releaseState") == "ONLINE":
                checked("POST", f"{base}/{schedule_id}/offline")
            checked("PUT", f"{base}/{schedule_id}", form=form)
        else:
            created = checked("POST", base, form={**form, "workflowDefinitionCode": workflow_code})
            schedule_id = created["id"]
        checked("POST", f"{base}/{schedule_id}/online")

    def _login(self, user, password):
        url = self.base + "/login"
        data = urllib.parse.urlencode({"userName": user, "userPassword": password}).encode()
        req = urllib.request.Request(url, data=data, method="POST",
                                     headers={"Content-Type": "application/x-www-form-urlencoded"})
        with urllib.request.urlopen(req, timeout=60) as resp:
            return json.loads(resp.read().decode())["data"]["sessionId"]

    def project_code(self, name):
        resp = self._call("GET", "/projects", {"searchVal": name, "pageSize": 50, "pageNo": 1})
        for item in resp["data"]["totalList"]:
            if item["name"] == name:
                return item["code"]
        raise RuntimeError(f"未找到项目：{name}")

    def get_workflow(self, project_code, name):
        resp = self._call(
            "GET", f"/projects/{project_code}/workflow-definition/list",
            {"searchVal": name, "pageSize": 50, "pageNo": 1},
        )
        for item in resp["data"]:
            if item["workflowDefinition"]["name"] == name:
                return item
        return None

    def gen_task_codes(self, project_code, num):
        return self._call(
            "GET", f"/projects/{project_code}/task-definition/gen-task-codes", {"genNum": num}
        )["data"]

    def create_workflow(self, project_code, payload):
        return self._call("POST", f"/projects/{project_code}/workflow-definition", payload)

    def update_workflow(self, project_code, code, payload):
        return self._call("PUT", f"/projects/{project_code}/workflow-definition/{code}", payload)

    def release(self, project_code, code, name, state="ONLINE"):
        return self._call(
            "POST", f"/projects/{project_code}/workflow-definition/{code}/release",
            {"releaseState": state, "name": name},
        )

    def start(self, project_code, workflow_code):
        return self._call(
            "POST", f"/projects/{project_code}/executors/start-workflow-instance",
            {
                "workflowDefinitionCode": workflow_code,
                "scheduleTime": "",
                "failureStrategy": "END",
                "warningType": "NONE",
                "workflowInstancePriority": "MEDIUM",
            },
        )


def layer_of(table):
    if table in LAYER_OVERRIDES:
        return LAYER_OVERRIDES[table]
    for layer in LAYER_ORDER:
        if table.startswith(layer + "_"):
            return layer
    return "ods"


def command_for(table):
    if table in LOADERS:
        return LOADERS[table]
    return "python3 /app/github-daily-rank/scripts/run_dml.py '${system.task.definition.name}' --ds '${system.biz.curdate}'"


def has_dml(table):
    return (SQL_ROOT / layer_of(table) / f"{table}_dml.sql").is_file()


def strip_sql_comments(sql):
    sql = re.sub(r"--[^\n]*", "", sql)
    return re.sub(r"/\*.*?\*/", "", sql, flags=re.DOTALL)


def extract_dependencies(table):
    """解析 {table}_dml.sql 里 FROM/JOIN 引用的表名。"""
    dml_path = SQL_ROOT / layer_of(table) / f"{table}_dml.sql"
    if not dml_path.is_file():
        return []
    sql = strip_sql_comments(dml_path.read_text(encoding="utf-8"))
    deps = []
    for match in re.finditer(
        r"\b(?:FROM|JOIN)\s+`?(?:[A-Za-z_][\w]*`?\s*\.\s*`?)?([A-Za-z_][\w]*)",
        sql, flags=re.IGNORECASE,
    ):
        dep = match.group(1)
        if dep and dep != table and dep not in deps:
            deps.append(dep)
    return deps


def dependencies_of(table):
    if table in PROFILE_WORKFLOW:
        return PROFILE_WORKFLOW[table]
    if table == "export_dashboard_data":
        return ["ads_github_trend_rank_f", "ads_github_trend_repo_f", "dwd_github_repo_metrics_f_1d"]
    if table == "export_project_scores":
        return ["ads_github_repo_score_f"]
    return extract_dependencies(table)


def build_task_definition(code, name, version, command):
    return {
        "code": code,
        "name": name,
        "version": version,
        "description": "",
        "taskType": "SHELL",
        "taskParams": {"localParams": [], "rawScript": command, "resourceList": []},
        "flag": "YES",
        "taskPriority": "MEDIUM",
        "workerGroup": "default",
        "environmentCode": -1,
        "failRetryTimes": 0,
        "failRetryInterval": 1,
        "timeoutFlag": "CLOSE",
        "timeout": 0,
        "delayTime": 0,
    }


def build_layout(tasks):
    """tasks: [(code, name, layer)]，返回 locations 列表。

    层与层左右排列（x 方向，大间隔），层内任务按传入顺序横向排列，
    每行最多 3 个，补满 3 个再换下一行（y 方向小间隔）。
    """
    by_layer = {layer: [] for layer in LAYER_ORDER}
    for code, name, layer in tasks:
        by_layer.setdefault(layer, []).append((code, name))
    locations = []
    for layer in LAYER_ORDER:
        items = by_layer.get(layer, [])
        base_x = LAYER_START_X[layer]
        for i, (code, name) in enumerate(items):
            row, col = divmod(i, COLUMNS_PER_ROW)
            locations.append({
                "taskCode": code,
                "x": base_x + col * X_GAP,
                "y": Y_START + row * Y_GAP,
            })
    return locations


def main():
    parser = argparse.ArgumentParser(description="DolphinScheduler 上线指定表任务")
    parser.add_argument("--project", required=True, help="项目名称")
    parser.add_argument("--workflow", required=True, help="工作流名称")
    parser.add_argument("--profiles", action="store_true", help="独立项目档案流水线，每日10:30 Asia/Shanghai")
    parser.add_argument("--tables", default="", help="逗号分隔的表名列表")
    parser.add_argument("--host", default="localhost")
    parser.add_argument("--port", type=int, default=12345)
    parser.add_argument("--user", default="admin")
    parser.add_argument("--password", default="dolphinscheduler123")
    parser.add_argument("--no-release", action="store_true", help="只保存不上线")
    parser.add_argument("--start", action="store_true", help="上线后启动实例")
    parser.add_argument("--dry-run", action="store_true", help="只预览，不调用 API")
    args = parser.parse_args()

    if args.profiles and args.tables:
        parser.error("--profiles 与 --tables 不能同时使用")
    requested = list(PROFILE_WORKFLOW) if args.profiles else [t.strip() for t in args.tables.split(",") if t.strip()]
    if not requested:
        print("错误：--tables 不能为空")
        return 1

    for table in requested:
        if not has_dml(table) and table not in LOADERS:
            print(f"警告：表 {table} 没有 DML 文件，也不在 LOADERS 中，命令将退回 run_dml.py")

    if args.dry_run:
        print(json.dumps({
            "workflow": args.workflow,
            "tasks": [{"name": task, "command": command_for(task), "dependencies": dependencies_of(task)} for task in requested],
            "schedule": PROFILE_SCHEDULE if args.profiles else None,
        }, ensure_ascii=False, indent=2))
        return 0

    client = DSClient(args.host, args.port, args.user, args.password)
    project_code = client.project_code(args.project)

    existing = client.get_workflow(project_code, args.workflow)
    existing_tasks = {}      # name -> {"code", "version"}
    existing_relations = []
    workflow_code = None
    release_state = None
    if args.profiles and existing and any(task["name"] not in PROFILE_WORKFLOW for task in existing["taskDefinitionList"]):
        raise RuntimeError("--profiles 必须使用独立工作流名称，不能替换其他业务工作流")
    if existing:
        workflow_code = existing["workflowDefinition"]["code"]
        release_state = existing["workflowDefinition"].get("releaseState")
        for t in existing["taskDefinitionList"]:
            existing_tasks[t["name"]] = {"code": t["code"], "version": t["version"]}
        existing_relations = [
            {
                "name": r.get("name", ""),
                "preTaskCode": r["preTaskCode"],
                "preTaskVersion": r["preTaskVersion"],
                "postTaskCode": r["postTaskCode"],
                "postTaskVersion": r["postTaskVersion"],
                "conditionType": r.get("conditionType", "NONE"),
                "conditionParams": r.get("conditionParams", {}),
            }
            for r in existing["workflowTaskRelationList"]
        ]

    # 需要新增的任务（指定表里不在工作流中的）
    new_tables = [t for t in requested if t not in existing_tasks]
    new_codes = client.gen_task_codes(project_code, len(new_tables)) if new_tables else []

    # name -> {"code", "version"} 的全量映射（现有 + 新增）
    all_tasks = dict(existing_tasks)
    for table, code in zip(new_tables, new_codes):
        all_tasks[table] = {"code": code, "version": 1}

    requested_set = set(requested)

    # 任务定义：本次指定的表更新命令，其余现有表保持原样
    task_definitions = []
    for t in existing["taskDefinitionList"] if existing else []:
        if t["name"] in requested_set:
            task_definitions.append(build_task_definition(
                t["code"], t["name"], t["version"], command_for(t["name"]),
            ))
        else:
            task_definitions.append({k: t.get(k) for k in TASK_FIELDS})
    for table, code in zip(new_tables, new_codes):
        task_definitions.append(build_task_definition(code, table, 1, command_for(table)))

    # 依赖：移除本次指定表已有的依赖边，再按最新解析结果重新配置
    requested_codes = {all_tasks[t]["code"] for t in requested}
    relations = [r for r in existing_relations if r["postTaskCode"] not in requested_codes]
    for table in requested:
        deps = dependencies_of(table)
        resolved = [d for d in deps if d in all_tasks and d != table]
        if deps and not resolved:
            print(f"警告：{table} 的依赖 {deps} 均不在工作流中，无法建立依赖边")
        if not resolved:
            relations.append({
                "name": "", "preTaskCode": 0, "preTaskVersion": 0,
                "postTaskCode": all_tasks[table]["code"],
                "postTaskVersion": all_tasks[table]["version"],
                "conditionType": "NONE", "conditionParams": {},
            })
        for dep in resolved:
            relations.append({
                "name": "", "preTaskCode": all_tasks[dep]["code"],
                "preTaskVersion": all_tasks[dep]["version"],
                "postTaskCode": all_tasks[table]["code"],
                "postTaskVersion": all_tasks[table]["version"],
                "conditionType": "NONE", "conditionParams": {},
            })

    # 重新布局所有任务：现有任务保持稳定，新增任务追加到末尾，每行 3 个换行
    ordered_names = sorted(existing_tasks.keys()) + [t for t in requested if t not in existing_tasks]
    task_layout_input = [
        (all_tasks[name]["code"], name, layer_of(name)) for name in ordered_names
    ]
    locations = build_layout(task_layout_input)

    payload = {
        "name": args.workflow,
        "description": "",
        "globalParams": json.dumps(GLOBAL_PARAMS, ensure_ascii=False),
        "locations": json.dumps(locations, ensure_ascii=False),
        "timeout": 0,
        "taskRelationJson": json.dumps(relations, ensure_ascii=False),
        "taskDefinitionJson": json.dumps(task_definitions, ensure_ascii=False),
        "executionType": "SERIAL_WAIT" if args.profiles else "PARALLEL",
    }

    print(f"项目：{args.project}（code={project_code}）")
    print(f"工作流：{args.workflow}{'（新建）' if workflow_code is None else '（更新 code=' + str(workflow_code) + '）'}")
    print(f"本次指定表：{len(requested)} 个，新增：{len(new_tables)} 个，工作流总任务：{len(all_tasks)} 个")
    for layer in LAYER_ORDER:
        names = [n for n in all_tasks if layer_of(n) == layer]
        if names:
            print(f"  [{layer}] {', '.join(sorted(names))}")
    print("依赖关系（本次指定表）：")
    for r in relations:
        if r["postTaskCode"] in requested_codes:
            pre = r["preTaskCode"] if r["preTaskCode"] else 0
            print(f"  {pre} -> {r['postTaskCode']}")

    if args.dry_run:
        print("\n（dry-run，未调用 API）")
        return 0

    # 已上线的工作流需要先下线才能编辑
    if release_state == "ONLINE":
        off = client.release(project_code, workflow_code, args.workflow, "OFFLINE")
        print("下线：", off.get("msg"), "code=", off.get("code"))
        if off.get("code") != 0:
            print(json.dumps(off, ensure_ascii=False)[:2000])
            return 1

    if workflow_code is None:
        resp = client.create_workflow(project_code, payload)
    else:
        resp = client.update_workflow(project_code, workflow_code, payload)
    print("保存：", resp.get("msg"), "code=", resp.get("code"))
    if resp.get("code") != 0:
        print(json.dumps(resp, ensure_ascii=False)[:2000])
        return 1

    # 创建后需要拿到 workflow code
    if workflow_code is None:
        workflow_code = resp["data"]["code"]

    if not args.no_release:
        rel = client.release(project_code, workflow_code, args.workflow)
        print("上线：", rel.get("msg"), "code=", rel.get("code"))
        if rel.get("code") != 0:
            print(json.dumps(rel, ensure_ascii=False)[:2000])
            return 1

    if args.profiles and not args.no_release:
        client.configure_profile_schedule(project_code, workflow_code)
        print("档案定时任务已启用：每日10:30 Asia/Shanghai")

    if args.start:
        st = client.start(project_code, workflow_code)
        print("启动：", st.get("msg"), "data=", st.get("data"))

    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:  # noqa: BLE001
        print("ERROR:", exc)
        sys.exit(1)
