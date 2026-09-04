import datetime as dt
import unittest

from scripts.project_scoring import score_category


NOW = dt.datetime(2026, 8, 25, tzinfo=dt.timezone.utc)


def metrics(repo: str, **overrides):
    base = {
        "repo": repo,
        "stars": 1_000,
        "forks": 150,
        "star_delta_7d": 100,
        "fork_delta_7d": 10,
        "commits_30d": 20,
        "created_at": "2025-08-25T00:00:00Z",
        "pushed_at": "2026-08-24T00:00:00Z",
        "open_issues": 20,
        "closed_issues": 80,
        "avg_issue_close_hours": 48,
        "open_prs": 5,
        "merged_prs": 25,
        "contributors": 8,
        "releases_30d": 2,
        "license_spdx": "MIT",
        "readme_bytes": 4_000,
        "readme_has_ci": True,
        "readme_has_demo": True,
        "has_code": True,
        "is_collection": False,
        "owner_created_at": "2020-01-01T00:00:00Z",
    }
    base.update(overrides)
    return base


class ProjectScoringTests(unittest.TestCase):
    def test_scores_are_normalized_per_category_and_expose_all_dimensions(self):
        result = score_category(
            [
                metrics("org/steady", star_delta_7d=80, fork_delta_7d=8),
                metrics("org/rising", star_delta_7d=800, fork_delta_7d=70),
                metrics("org/quiet", star_delta_7d=5, fork_delta_7d=0),
            ],
            "AI智能体",
            now=NOW,
        )

        self.assertEqual({item["repo"] for item in result}, {"org/steady", "org/rising", "org/quiet"})
        for item in result:
            self.assertEqual(item["category"], "AI智能体")
            for field in (
                "comprehensive_score",
                "hot_score",
                "momentum_score",
                "activity_score",
                "engagement_score",
                "quality_score",
                "freshness_score",
            ):
                self.assertGreaterEqual(item[field], 0)
                self.assertLessEqual(item[field], 100)
        by_repo = {item["repo"]: item for item in result}
        self.assertGreater(by_repo["org/rising"]["comprehensive_score"], by_repo["org/quiet"]["comprehensive_score"])
        self.assertGreater(by_repo["org/rising"]["hot_score"], by_repo["org/steady"]["hot_score"])

    def test_excluded_outlier_does_not_compress_valid_category_scores(self):
        valid, excluded = score_category(
            [metrics("org/valid", star_delta_7d=10), metrics("org/excluded", star_delta_7d=100_000, has_code=False)],
            "AI编程工具",
            now=NOW,
        )

        self.assertEqual(valid["momentum_score"], 50.0)
        self.assertEqual(excluded["momentum_score"], 0.0)

    def test_issue_close_speed_contributes_to_health_score(self):
        fast, slow = score_category(
            [metrics("org/fast", avg_issue_close_hours=2), metrics("org/slow", avg_issue_close_hours=720)],
            "AI开发平台",
            now=NOW,
        )

        self.assertGreater(fast["activity_score"], slow["activity_score"])

    def test_quality_gate_excludes_empty_or_non_code_repositories(self):
        result = score_category(
            [
                metrics("org/good"),
                metrics("org/no-readme", readme_bytes=120),
                metrics("org/no-code", has_code=False),
            ],
            "AI编程工具",
            now=NOW,
        )
        by_repo = {item["repo"]: item for item in result}

        self.assertFalse(by_repo["org/good"]["excluded"])
        self.assertTrue(by_repo["org/no-readme"]["excluded"])
        self.assertEqual(by_repo["org/no-readme"]["comprehensive_score"], 0)
        self.assertIn("README_TOO_SHORT", by_repo["org/no-readme"]["penalties"])
        self.assertTrue(by_repo["org/no-code"]["excluded"])
        self.assertIn("NO_CODE", by_repo["org/no-code"]["penalties"])

    def test_collection_and_suspicious_growth_are_downweighted(self):
        normal, collection, suspicious = score_category(
            [
                metrics("org/normal", star_delta_7d=2_500, fork_delta_7d=3, commits_30d=0),
                metrics("org/collection", star_delta_7d=2_500, fork_delta_7d=3, commits_30d=0, is_collection=True),
                metrics(
                    "new/suspicious",
                    star_delta_7d=2_500,
                    fork_delta_7d=3,
                    commits_30d=0,
                    owner_created_at="2026-08-01T00:00:00Z",
                ),
            ],
            "AI智能体",
            now=NOW,
        )
        by_repo = {item["repo"]: item for item in (normal, collection, suspicious)}

        self.assertIn("COLLECTION", by_repo["org/collection"]["penalties"])
        self.assertLess(by_repo["org/collection"]["comprehensive_score"], by_repo["org/normal"]["comprehensive_score"])
        self.assertIn("SUSPICIOUS_GROWTH", by_repo["new/suspicious"]["penalties"])
        self.assertLess(by_repo["new/suspicious"]["comprehensive_score"], by_repo["org/normal"]["comprehensive_score"])

    def test_sqlite_integer_booleans_trigger_quality_rules(self):
        no_code, collection = score_category(
            [metrics("org/no-code-int", has_code=0), metrics("org/collection-int", is_collection=1)],
            "AI智能体",
            now=NOW,
        )
        by_repo = {item["repo"]: item for item in (no_code, collection)}

        self.assertTrue(by_repo["org/no-code-int"]["excluded"])
        self.assertIn("NO_CODE", by_repo["org/no-code-int"]["penalties"])
        self.assertIn("COLLECTION", by_repo["org/collection-int"]["penalties"])

    def test_missing_enrichment_is_neutral_instead_of_failing_quality_gate(self):
        incomplete = metrics(
            "org/incomplete",
            readme_bytes=None,
            has_code=None,
            license_spdx=None,
            contributors=None,
        )
        result = score_category([incomplete], "AI开发平台", now=NOW)[0]

        self.assertFalse(result["excluded"])
        self.assertIn("INCOMPLETE_DATA", result["penalties"])
        self.assertGreater(result["comprehensive_score"], 0)


if __name__ == "__main__":
    unittest.main()
