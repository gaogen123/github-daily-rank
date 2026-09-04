import datetime as dt
import sqlite3
import unittest

from scripts.project_metrics import (
    initialize_database,
    load_scoring_rows,
    record_snapshot,
    save_project_scores,
    upsert_repository_metrics,
)


class ProjectMetricsDatabaseTests(unittest.TestCase):
    def setUp(self):
        self.connection = sqlite3.connect(":memory:")
        self.connection.row_factory = sqlite3.Row
        initialize_database(self.connection)

    def tearDown(self):
        self.connection.close()

    def complete_metrics(self, **overrides):
        values = {
            "repo": "owner/tool",
            "github_url": "https://github.com/owner/tool",
            "homepage": "https://tool.example",
            "description": "Useful tool",
            "stars": 1200,
            "forks": 140,
            "created_at": "2025-01-01T00:00:00Z",
            "pushed_at": "2026-08-24T00:00:00Z",
            "owner_created_at": "2018-01-01T00:00:00Z",
            "commits_30d": 32,
            "open_issues": 10,
            "closed_issues": 90,
            "avg_issue_close_hours": 36.5,
            "open_prs": 3,
            "merged_prs": 27,
            "contributors": 12,
            "releases_30d": 2,
            "license_spdx": "MIT",
            "readme_bytes": 5200,
            "readme_has_ci": True,
            "readme_has_demo": True,
            "has_code": True,
            "is_collection": False,
            "source_star_delta_1d": 20,
            "source_star_delta_7d": 120,
            "source_star_delta_30d": 400,
            "fetched_at": "2026-08-25T01:00:00Z",
        }
        values.update(overrides)
        return values

    def test_all_base_metrics_are_persisted_before_scoring(self):
        upsert_repository_metrics(self.connection, self.complete_metrics())
        row = self.connection.execute("SELECT * FROM repositories WHERE repo = ?", ("owner/tool",)).fetchone()

        self.assertEqual(row["stars"], 1200)
        self.assertEqual(row["forks"], 140)
        self.assertEqual(row["commits_30d"], 32)
        self.assertEqual(row["avg_issue_close_hours"], 36.5)
        self.assertEqual(row["license_spdx"], "MIT")
        self.assertEqual(row["readme_bytes"], 5200)
        self.assertEqual(row["has_code"], 1)
        self.assertEqual(row["source_star_delta_7d"], 120)
        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM project_scores").fetchone()[0],
            0,
            "collecting base metrics must not calculate scores",
        )

    def test_missing_api_fields_do_not_destroy_previous_reliable_values(self):
        upsert_repository_metrics(self.connection, self.complete_metrics())
        upsert_repository_metrics(
            self.connection,
            self.complete_metrics(
                stars=1210,
                contributors=None,
                license_spdx=None,
                readme_bytes=None,
                fetched_at="2026-08-25T02:00:00Z",
            ),
        )
        row = self.connection.execute("SELECT * FROM repositories WHERE repo = ?", ("owner/tool",)).fetchone()

        self.assertEqual(row["stars"], 1210)
        self.assertEqual(row["contributors"], 12)
        self.assertEqual(row["license_spdx"], "MIT")
        self.assertEqual(row["readme_bytes"], 5200)
        self.assertEqual(row["fetched_at"], "2026-08-25T02:00:00Z")

    def test_snapshots_are_idempotent_and_supply_real_seven_day_deltas(self):
        upsert_repository_metrics(self.connection, self.complete_metrics())
        record_snapshot(self.connection, "owner/tool", "2026-08-18", 1000, 100)
        record_snapshot(self.connection, "owner/tool", "2026-08-25", 1250, 145)
        record_snapshot(self.connection, "owner/tool", "2026-08-25", 1260, 146)

        rows = load_scoring_rows(
            self.connection,
            ["owner/tool"],
            as_of=dt.date(2026, 8, 25),
        )

        self.assertEqual(
            self.connection.execute("SELECT COUNT(*) FROM repository_snapshots").fetchone()[0],
            2,
        )
        self.assertEqual(rows[0]["stars"], 1260)
        self.assertEqual(rows[0]["forks"], 146)
        self.assertEqual(rows[0]["star_delta_7d"], 260)
        self.assertEqual(rows[0]["fork_delta_7d"], 46)

    def test_stale_snapshot_is_not_misrepresented_as_seven_day_growth(self):
        upsert_repository_metrics(self.connection, self.complete_metrics())
        record_snapshot(self.connection, "owner/tool", "2026-07-01", 500, 50)
        record_snapshot(self.connection, "owner/tool", "2026-08-25", 1200, 140)

        row = load_scoring_rows(self.connection, ["owner/tool"], as_of=dt.date(2026, 8, 25))[0]

        self.assertEqual(row["star_delta_7d"], 120)
        self.assertIsNone(row["fork_delta_7d"])

    def test_source_growth_is_used_until_snapshot_history_exists(self):
        upsert_repository_metrics(self.connection, self.complete_metrics())
        record_snapshot(self.connection, "owner/tool", "2026-08-25", 1200, 140)

        row = load_scoring_rows(self.connection, ["owner/tool"], as_of=dt.date(2026, 8, 25))[0]

        self.assertEqual(row["star_delta_7d"], 120)
        self.assertIsNone(row["fork_delta_7d"])

    def test_scores_are_written_only_by_the_explicit_scoring_stage(self):
        upsert_repository_metrics(self.connection, self.complete_metrics())
        score = {
            "repo": "owner/tool",
            "category": "AI编程工具",
            "comprehensive_score": 88.5,
            "hot_score": 72.0,
            "momentum_score": 90.0,
            "activity_score": 80.0,
            "engagement_score": 75.0,
            "quality_score": 95.0,
            "freshness_score": 70.0,
            "excluded": False,
            "penalties": ["INCOMPLETE_DATA"],
        }
        save_project_scores(self.connection, [score], score_version="v1", calculated_at="2026-08-25T03:00:00Z")

        row = self.connection.execute("SELECT * FROM project_scores").fetchone()
        self.assertEqual(row["category"], "AI编程工具")
        self.assertEqual(row["score_version"], "v1")
        self.assertEqual(row["comprehensive_score"], 88.5)
        self.assertEqual(row["penalties_json"], '["INCOMPLETE_DATA"]')


if __name__ == "__main__":
    unittest.main()
