import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('dashboard_export', Path(__file__).resolve().parents[1] / 'scripts/exports/generate_data_from_starrocks.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)


class BoardExportTests(unittest.TestCase):
    def row(self, kind, date, repo='a/repo', rank=1):
        return dict(sort_type=kind, dt=date, full_name=repo, rank_num=rank,
                    repo_url='', repo_name='', description='', total_stars=2000,
                    opened_at=None, growth=100, growth_rate=None)

    def test_snapshot_preserves_each_board_date_and_missing_rate(self):
        boards = module.build_boards([
            self.row('trending_daily', 20260906),
            self.row('weekly_rank', 20260831),
        ])
        self.assertEqual(boards['trending_daily']['date'], '2026-09-06')
        self.assertEqual(boards['weekly_rank']['date'], '2026-08-31')
        project = boards['weekly_rank']['projects'][0]
        self.assertEqual(project['weeklyGrowth'], 100)
        self.assertIsNone(project['weeklyRate'])
        self.assertNotIn('dailyGrowth', project)

    def test_source_rank_is_preserved_and_mixed_dates_rejected(self):
        rows = [self.row('trending_daily', 20260906, 'b/repo', 2), self.row('trending_daily', 20260906)]
        self.assertEqual(module.build_boards(rows)['trending_daily']['projects'][0]['repo'], 'a/repo')
        rows.append(self.row('trending_daily', 20260905))
        with self.assertRaises(ValueError):
            module.build_boards(rows)

class MetricMergeTests(unittest.TestCase):
    def test_latest_metric_fills_repo_missing_from_ads_without_overwriting_newer_ads(self):
        from datetime import datetime
        def row(stars, fetched):
            return dict(repo='a/repo', dt=20260906, fetched_at=datetime.fromisoformat(fetched),
                        stars=stars, forks=2, github_url='', description='fresh', homepage='',
                        source_star_delta_1d=10, source_star_delta_7d=None,
                        source_star_delta_30d=None, created_at=None)
        records = [row(120, '2026-09-06T02:00:00'), row(110, '2026-09-05T02:00:00')]
        result = module.merge_metrics({'a/repo': {'stars': 50, 'lastSeen': '2026-08-24'}}, records)
        self.assertEqual(result['a/repo']['stars'], 120)
        self.assertEqual(result['a/repo']['updatedAt'], '2026-09-06')
        self.assertEqual(result['a/repo']['lastSeen'], '2026-08-24')
        result = module.merge_metrics({'a/repo': {'stars': 150, 'fetchedAt': '2026-09-06T10:00:00'}}, records)
        self.assertEqual(result['a/repo']['stars'], 150)
