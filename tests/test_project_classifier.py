import json
import os
import sqlite3
import tempfile
import unittest
from pathlib import Path
from typing import cast
from unittest import mock

from scripts.project_classifier import (
    BatchClassifier,
    CATEGORIES,
    DeepSeekClassifier,
    Project,
    ProjectClassifier,
    export_categories,
)


class StrictResponseParsingTests(unittest.TestCase):
    def test_accepts_only_the_exact_response_shape(self) -> None:
        content = json.dumps(
            {
                "projects": [
                    {"repo": "owner/agent", "categories": ["AI智能体", "AI开发平台"]},
                    {"repo": "owner/other", "categories": []},
                ]
            },
            ensure_ascii=False,
        )

        result = DeepSeekClassifier.parse_result(content, ["owner/agent", "owner/other"])

        self.assertEqual(result["owner/agent"], ["AI智能体", "AI开发平台"])
        self.assertEqual(result["owner/other"], [])
        with self.assertRaises(ValueError):
            DeepSeekClassifier.parse_result(f"```json\n{content}\n```", ["owner/agent", "owner/other"])
        with self.assertRaises(ValueError):
            DeepSeekClassifier.parse_result(
                '{"projects":[{"repo":"owner/agent","categories":[]}],"extra":true}',
                ["owner/agent"],
            )
        with self.assertRaises(ValueError):
            DeepSeekClassifier.parse_result(
                '{"projects":[{"repo":"owner/agent","categories":[],"extra":true}]}',
                ["owner/agent"],
            )

    def test_rejects_illegal_duplicate_or_excess_categories(self) -> None:
        self.assertEqual(
            CATEGORIES,
            (
                "AI智能体",
                "AI编程工具",
                "AI开发平台",
                "AI运维",
                "AI图像工具",
                "AI视频工具",
                "AI音频工具",
                "AI搜索引擎",
                "AI爬虫工具",
                "Skills",
                "AI营销",
                "AI办公工具",
                "AI设计工具",
            ),
        )
        for categories in (["其他"], ["AI智能体", "AI智能体"], list(CATEGORIES[:5])):
            with self.subTest(categories=categories), self.assertRaises(ValueError):
                DeepSeekClassifier.parse_result(
                    json.dumps({"projects": [{"repo": "owner/name", "categories": categories}]}, ensure_ascii=False),
                    ["owner/name"],
                )

    def test_rejects_missing_extra_or_duplicate_repositories(self) -> None:
        requested = ["one/repo", "two/repo"]
        invalid_projects = (
            [{"repo": "one/repo", "categories": []}],
            [
                {"repo": "one/repo", "categories": []},
                {"repo": "two/repo", "categories": []},
                {"repo": "three/repo", "categories": []},
            ],
            [
                {"repo": "one/repo", "categories": []},
                {"repo": "one/repo", "categories": []},
            ],
        )
        for projects in invalid_projects:
            with self.subTest(projects=projects), self.assertRaises(ValueError):
                DeepSeekClassifier.parse_result(json.dumps({"projects": projects}), requested)


class ProjectClassifierTests(unittest.TestCase):
    temp_dir: tempfile.TemporaryDirectory[str] = cast(tempfile.TemporaryDirectory[str], object())
    root: Path = cast(Path, object())
    input_path: Path = cast(Path, object())
    database_path: Path = cast(Path, object())
    output_path: Path = cast(Path, object())

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.input_path = self.root / "projects.json"
        self.database_path = self.root / "storage" / "project-categories.db"
        self.output_path = self.root / "public" / "data" / "project-categories.json"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write_projects(self, description: str = "An autonomous AI agent") -> None:
        self.input_path.write_text(
            json.dumps(
                {
                    "projects": [
                        {"repo": "owner/agent", "name": "Agent", "description": description},
                        {"repo": "owner/plain", "name": "Plain", "description": "A text utility"},
                    ]
                }
            ),
            encoding="utf-8",
        )

    def pipeline(self, classify_batch: BatchClassifier, *, max_process: int = 100) -> ProjectClassifier:
        return ProjectClassifier(
            input_path=self.input_path,
            database_path=self.database_path,
            output_path=self.output_path,
            batch_size=20,
            max_process=max_process,
            model="deepseek-test",
            classify_batch=classify_batch,
        )

    def test_unchanged_projects_are_cached_and_fingerprint_changes_are_reclassified(self) -> None:
        self.write_projects()
        calls: list[list[Project]] = []

        def classify(projects: list[Project]) -> dict[str, list[str]]:
            calls.append(projects)
            return {
                project.repo: (["AI智能体"] if project.repo == "owner/agent" else [])
                for project in projects
            }

        first = self.pipeline(classify).run()
        second = self.pipeline(classify).run()
        self.write_projects(description="A changed autonomous agent")
        third = self.pipeline(classify).run()

        self.assertEqual((first.processed, first.cached, first.errors), (2, 0, 0))
        self.assertEqual((second.processed, second.cached, second.errors), (0, 2, 0))
        self.assertEqual((third.processed, third.cached, third.errors), (1, 1, 0))
        self.assertEqual([[project.repo for project in batch] for batch in calls], [
            ["owner/agent", "owner/plain"],
            ["owner/agent"],
        ])
        with sqlite3.connect(self.database_path) as connection:
            rows = connection.execute(
                "SELECT repo, fingerprint, categories_json, model, classified_at FROM project_categories ORDER BY repo"
            ).fetchall()
        self.assertEqual(len(rows), 2)
        self.assertEqual(json.loads(rows[0][2]), ["AI智能体"])
        self.assertEqual(rows[0][3], "deepseek-test")
        self.assertTrue(rows[0][4].endswith("Z"))

    def test_taxonomy_version_change_reclassifies_cached_projects(self) -> None:
        self.write_projects()
        calls: list[list[str]] = []

        def classify(projects: list[Project]) -> dict[str, list[str]]:
            calls.append([project.repo for project in projects])
            return {project.repo: ["AI运维"] for project in projects}

        first = self.pipeline(classify).run()
        with mock.patch("scripts.project_classifier.CLASSIFICATION_SCHEMA_VERSION", 999):
            second = self.pipeline(classify).run()

        self.assertEqual((first.processed, first.cached), (2, 0))
        self.assertEqual((second.processed, second.cached), (2, 0))
        self.assertEqual(calls, [
            ["owner/agent", "owner/plain"],
            ["owner/agent", "owner/plain"],
        ])

    def test_zero_max_process_exports_cache_without_calling_classifier(self) -> None:
        self.write_projects()
        classifier = mock.Mock(side_effect=AssertionError("classifier must not be called"))

        report = self.pipeline(classifier, max_process=0).run()
        exported = json.loads(self.output_path.read_text(encoding="utf-8"))

        self.assertEqual((report.processed, report.errors), (0, 0))
        classifier.assert_not_called()
        self.assertEqual(exported["projects"], {"owner/agent": [], "owner/plain": []})

    def test_failed_batch_does_not_block_later_batches(self) -> None:
        projects = [
            {"repo": f"owner/repo-{index}", "name": str(index), "description": "AI"}
            for index in range(3)
        ]
        self.input_path.write_text(json.dumps({"projects": projects}), encoding="utf-8")
        calls = 0

        def classify(batch: list[Project]) -> dict[str, list[str]]:
            nonlocal calls
            calls += 1
            if calls == 1:
                raise ValueError("bad response")
            return {project.repo: ["AI开发平台"] for project in batch}

        pipeline = ProjectClassifier(
            input_path=self.input_path,
            database_path=self.database_path,
            output_path=self.output_path,
            batch_size=2,
            max_process=3,
            model="deepseek-test",
            classify_batch=classify,
        )
        with mock.patch("sys.stderr"):
            report = pipeline.run()

        self.assertEqual((report.processed, report.errors), (1, 1))
        self.assertEqual(json.loads(self.output_path.read_text())["projects"], {
            "owner/repo-0": [],
            "owner/repo-1": [],
            "owner/repo-2": ["AI开发平台"],
        })

    def test_export_is_atomic_and_has_required_shape(self) -> None:
        target = self.output_path
        with mock.patch("scripts.project_classifier.os.replace", wraps=os.replace) as replace:
            export_categories(target, {"two/repo": [], "one/repo": ["Skills"]})

        payload = json.loads(target.read_text(encoding="utf-8"))
        self.assertEqual(payload["version"], 1)
        self.assertTrue(payload["generated_at"].endswith("Z"))
        self.assertEqual(payload["count"], 2)
        self.assertEqual(payload["projects"], {"one/repo": ["Skills"], "two/repo": []})
        replace.assert_called_once()
        source, destination = replace.call_args.args
        self.assertEqual(Path(source).parent, target.parent)
        self.assertEqual(Path(destination), target)
        self.assertEqual(list(target.parent.glob(f".{target.name}.*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
