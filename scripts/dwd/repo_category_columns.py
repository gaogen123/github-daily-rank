"""StarRocks DWD 仓库表分类列管理与回填辅助模块。"""
from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

CATEGORY_COLUMNS = {
    "category_list": "varchar(1024) NULL COMMENT '产品分类列表 JSON 字符串'",
    "primary_category": "varchar(128) NULL COMMENT '首选/第一主分类'",
    "is_ai": "boolean NULL COMMENT '是否为 AI 相关项目'",
    "category_reason": "varchar(65533) NULL COMMENT '分类思考链推理依据'",
    "category_source": "varchar(64) NULL COMMENT '分类来源：deepseek-chat / manual-override / rule'",
    "category_updated_at": "datetime NULL COMMENT '分类打标/更新时间'",
}


def ensure_category_columns(connection: Any, table: str) -> None:
    """自动检测并补齐 DWD 表中缺失的分类字段。"""
    with connection.cursor() as cursor:
        cursor.execute(f"DESCRIBE {table}")
        columns = {row["Field"] if isinstance(row, dict) else row[0] for row in cursor.fetchall()}
        missing = [f"ADD COLUMN `{name}` {kind}" for name, kind in CATEGORY_COLUMNS.items() if name not in columns]
        if missing:
            sql = f"ALTER TABLE {table} " + ", ".join(missing)
            cursor.execute(sql)


def load_category_meta(
    categories_json_path: Path,
    overrides_json_path: Path | None = None,
) -> dict[str, dict[str, Any]]:
    """读取分类结果及人工纠偏配置，组装 DWD 写入所需结构。"""
    categories_map: dict[str, list[str]] = {}
    if categories_json_path.exists():
        try:
            data = json.loads(categories_json_path.read_text(encoding="utf-8"))
            if isinstance(data, dict) and "projects" in data:
                categories_map = data["projects"]
            elif isinstance(data, dict):
                categories_map = data
        except Exception as exc:
            print(f"读取分类文件 {categories_json_path} 失败: {exc}")

    overrides_map: dict[str, dict[str, Any]] = {}
    if overrides_json_path and overrides_json_path.exists():
        try:
            raw_overrides = json.loads(overrides_json_path.read_text(encoding="utf-8"))
            if isinstance(raw_overrides, dict):
                overrides_map = raw_overrides
        except Exception as exc:
            print(f"读取人工纠偏文件 {overrides_json_path} 失败: {exc}")

    result: dict[str, dict[str, Any]] = {}
    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")

    # 1. 模型预测分类
    for repo, cats in categories_map.items():
        if not isinstance(cats, list):
            continue
        is_ai = bool(len(cats) > 0)
        primary = cats[0] if is_ai else None
        result[repo] = {
            "category_list": json.dumps(cats, ensure_ascii=False) if cats else None,
            "primary_category": primary,
            "is_ai": is_ai,
            "category_reason": None,
            "category_source": "deepseek",
            "category_updated_at": now_str,
        }

    # 2. 人工纠偏覆盖（最高优先级）
    for repo, info in overrides_map.items():
        if isinstance(info, list):
            cats = info
            is_ai = bool(len(cats) > 0)
            reason = "人工标注指定分类"
        elif isinstance(info, dict):
            cats = info.get("categories", [])
            is_ai = info.get("is_ai", bool(len(cats) > 0))
            reason = info.get("reason", "人工标注纠偏")
        else:
            continue

        result[repo] = {
            "category_list": json.dumps(cats, ensure_ascii=False) if cats else None,
            "primary_category": cats[0] if cats else None,
            "is_ai": is_ai,
            "category_reason": reason,
            "category_source": "manual-override",
            "category_updated_at": now_str,
        }

    return result
