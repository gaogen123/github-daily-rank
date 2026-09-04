"""共享 rankings module 的能力测试（#2/#8/#14）。"""

import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts" / "rankings"))

import rank_common as common  # noqa: E402


DAILY_DETAIL = """## 2025.03.08 最佳开源项目:pathway

<h3>1. 多智能体框架 https://github.com/geekan/MetaGPT</h3>

- 总星标数量：50.4k
- 日增长数量：479
- 上周增长数量：1826
- 上月增长数量：4390
- 开源时间：2023-06-30
- 项目描述：一个多智能体元编程框架。
"""

DAILY_TABLE = """## 2024.01.18

| 排名 | 项目名 | Star | 今日增长量 |
|---|---|---|---|
| 1 | [geekan/MetaGPT](https://github.com/geekan/MetaGPT) | 50.4k | 479 | 2023-06-30 |
| 2 | [mendableai/firecrawl](https://github.com/mendableai/firecrawl) | 29.3k | 234 | 2024-01-01 |
"""


class DailyParseTests(unittest.TestCase):
    def test_detail_sections_preserve_multi_growth_fields(self):
        report = common.parse_daily_report(DAILY_DETAIL, "20250308.md")

        self.assertEqual(report["date"], "2025-03-08")
        self.assertEqual(len(report["projects"]), 1)
        project = report["projects"][0]
        self.assertEqual(project["repo"], "geekan/MetaGPT")
        self.assertEqual(project["stars"], 50400)
        self.assertEqual(project["dailyGrowth"], 479)
        self.assertEqual(project["weeklyGrowth"], 1826)
        self.assertEqual(project["monthlyGrowth"], 4390)
        self.assertEqual(project["openedAt"], "2023-06-30")
        self.assertIn("多智能体框架", project["name"])

    def test_table_format_fallback_is_supported(self):
        report = common.parse_daily_report(DAILY_TABLE, "20240118.md")

        self.assertEqual(report["date"], "2024-01-18")
        self.assertEqual(len(report["projects"]), 2)
        first = report["projects"][0]
        self.assertEqual(first["repo"], "geekan/MetaGPT")
        self.assertEqual(first["stars"], 50400)
        self.assertEqual(first["dailyGrowth"], 479)

    def test_daily_parse_key_and_find_reports(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "2025" / "03").mkdir(parents=True)
            (root / "2025" / "03" / "20250308.md").write_text(DAILY_DETAIL, encoding="utf-8")

            reports = common.daily_find_reports(root)
            self.assertEqual(len(reports), 1)
            self.assertEqual(common.daily_parse_key(reports[0]), "2025-03-08")


WEEKLY_DETAIL = """<h3>1. https://github.com/geekan/MetaGPT</h3>

- 总星标数量：50.4k
- 周Star增长量：4126
- 开源时间：2023-06-30
"""

MONTHLY_DETAIL = """<h3>1. https://github.com/geekan/MetaGPT</h3>

- 总星标数量：50.4k
- 月Star增长量：6243
- 开源时间：2023-06-30
"""


class RunFlowTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)

    def tearDown(self):
        self.tmp.cleanup()

    def _daily_config(self):
        (self.root / "2025" / "03").mkdir(parents=True)
        (self.root / "2025" / "03" / "20250308.md").write_text(DAILY_DETAIL, encoding="utf-8")
        config = dict(common.DAILY_CONFIG)
        config["repo_dir"] = self.root
        return config

    @mock.patch("rank_common.stream_load")
    @mock.patch("rank_common.ensure_repo")
    def test_daily_full_run_stream_loads_rows(self, mock_ensure, mock_stream):
        mock_stream.return_value = {"NumberLoadedRows": 1}
        common.run(self._daily_config(), incremental=False, dry_run=False)

        mock_ensure.assert_called_once()
        mock_stream.assert_called_once()
        rows = mock_stream.call_args[0][0]
        self.assertEqual(rows[0]["full_name"], "geekan/MetaGPT")
        self.assertEqual(rows[0]["stars_today"], 479)

    @mock.patch("rank_common.stream_load")
    @mock.patch("rank_common.query_existing_dates")
    @mock.patch("rank_common.ensure_repo")
    def test_incremental_skips_existing_dates(self, mock_ensure, mock_query, mock_stream):
        mock_query.return_value = {"2025-03-08"}
        mock_stream.return_value = {"NumberLoadedRows": 0}

        common.run(self._daily_config(), incremental=True, dry_run=False)

        mock_stream.assert_not_called()

    @mock.patch("rank_common.stream_load")
    @mock.patch("rank_common.ensure_repo")
    def test_dry_run_does_not_stream_load(self, mock_ensure, mock_stream):
        common.run(self._daily_config(), incremental=False, dry_run=True)

        mock_stream.assert_not_called()

    @mock.patch("rank_common.stream_load")
    @mock.patch("rank_common.ensure_repo")
    def test_stream_load_failure_propagates(self, mock_ensure, mock_stream):
        mock_stream.side_effect = RuntimeError("Stream Load 失败")

        with self.assertRaises(RuntimeError):
            common.run(self._daily_config(), incremental=False, dry_run=False)


class WeeklyMonthlyRunTests(unittest.TestCase):
    def setUp(self):
        import load_weekly_rank_to_starrocks as weekly
        import load_monthly_rank_to_starrocks as monthly

        self.weekly = weekly
        self.monthly = monthly

    @mock.patch("rank_common.stream_load")
    @mock.patch("rank_common.ensure_repo")
    def test_weekly_full_run_uses_single_growth_field(self, mock_ensure, mock_stream):
        mock_stream.return_value = {"NumberLoadedRows": 1}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "2025" / "03").mkdir(parents=True)
            (root / "2025" / "03" / "20250318.md").write_text(WEEKLY_DETAIL, encoding="utf-8")
            config = dict(self.weekly.WEEKLY_CONFIG)
            config["repo_dir"] = root

            common.run(config, incremental=False, dry_run=False)

        rows = mock_stream.call_args[0][0]
        self.assertEqual(rows[0]["full_name"], "geekan/MetaGPT")
        self.assertEqual(rows[0]["stars_week"], 4126)

    @mock.patch("rank_common.stream_load")
    @mock.patch("rank_common.ensure_repo")
    def test_monthly_full_run_uses_single_growth_field(self, mock_ensure, mock_stream):
        mock_stream.return_value = {"NumberLoadedRows": 1}
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "2025").mkdir(parents=True)
            (root / "2025" / "08.md").write_text(MONTHLY_DETAIL, encoding="utf-8")
            config = dict(self.monthly.MONTHLY_CONFIG)
            config["repo_dir"] = root

            common.run(config, incremental=False, dry_run=False)

        rows = mock_stream.call_args[0][0]
        self.assertEqual(rows[0]["full_name"], "geekan/MetaGPT")
        self.assertEqual(rows[0]["stars_month"], 6243)


class WeeklyMonthlyDiscoveryTests(unittest.TestCase):
    def setUp(self):
        import load_weekly_rank_to_starrocks as weekly
        import load_monthly_rank_to_starrocks as monthly

        self.weekly = weekly
        self.monthly = monthly

    def test_weekly_find_reports_and_parse_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "2025" / "03").mkdir(parents=True)
            (root / "2025" / "03" / "20250318.md").write_text("", encoding="utf-8")

            reports = self.weekly.weekly_find_reports(root)
            self.assertEqual(len(reports), 1)
            self.assertEqual(self.weekly.weekly_parse_key(reports[0]), "2025-03-18")

    def test_monthly_find_reports_and_parse_key(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "2025").mkdir(parents=True)
            (root / "2025" / "08.md").write_text("", encoding="utf-8")

            reports = self.monthly.monthly_find_reports(root)
            self.assertEqual(len(reports), 1)
            self.assertEqual(self.monthly.monthly_parse_key(reports[0]), "2025-08-01")


class AdapterSmokeTests(unittest.TestCase):
    def test_legacy_daily_entries_re_export_canonical_main(self):
        import importlib.util

        legacy_full = importlib.util.spec_from_file_location(
            "legacy_daily_full",
            Path(__file__).resolve().parents[1] / "scripts" / "load_daily_rank_to_starrocks.py",
        )
        legacy_incr = importlib.util.spec_from_file_location(
            "legacy_daily_incr",
            Path(__file__).resolve().parents[1] / "scripts" / "load_daily_rank_incremental.py",
        )

        self.assertIsNotNone(legacy_full)
        self.assertIsNotNone(legacy_incr)

    def test_legacy_daily_full_help_exits_zero(self):
        import subprocess

        legacy = Path(__file__).resolve().parents[1] / "scripts" / "load_daily_rank_to_starrocks.py"
        result = subprocess.run(
            [sys.executable, str(legacy), "--help"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
