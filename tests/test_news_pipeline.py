import json
import tempfile
import unittest
from pathlib import Path
from typing import Any, cast

from scripts.news_pipeline import Analysis, Analyzer, DeepSeekAnalyzer, FeedItem, NewsPipeline, parse_feed


RSS = b"""<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>RSS Test</title>
  <item><title>Open Source &amp; Tools</title><link>https://example.test/rss-one</link>
    <description><![CDATA[<p>A <b>useful</b> tool.</p>]]></description>
    <pubDate>Mon, 24 Aug 2026 10:00:00 GMT</pubDate></item>
  <item><title>Second item</title><link>https://example.test/rss-two</link><description>More news</description></item>
</channel></rss>"""

ATOM = b"""<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom Test</title>
  <entry><title>New AI Model</title><link rel="alternate" href="https://example.test/atom-one" />
    <summary type="html">&lt;p&gt;Model details.&lt;/p&gt;</summary>
    <published>2026-08-24T11:00:00Z</published></entry>
</feed>"""


def keep_all(item: FeedItem) -> Analysis:
    return Analysis(
        zh_title=f"中文：{item.title}",
        tldr=f"摘要：{item.summary}",
        tags=("开源", "AI"),
        score=85,
        keep=True,
    )


class PipelineCase(unittest.TestCase):
    temp_dir: tempfile.TemporaryDirectory[str] = cast(tempfile.TemporaryDirectory[str], object())
    root: Path = cast(Path, object())
    config: Path = cast(Path, object())
    database: Path = cast(Path, object())
    output: Path = cast(Path, object())

    def setUp(self) -> None:
        self.temp_dir = tempfile.TemporaryDirectory()
        self.root = Path(self.temp_dir.name)
        self.config = self.root / "sources.json"
        self.database = self.root / "storage" / "news.db"
        self.output = self.root / "public" / "news.json"

    def tearDown(self) -> None:
        self.temp_dir.cleanup()

    def write_sources(self, sources: list[dict[str, object]]) -> None:
        _ = self.config.write_text(json.dumps({"sources": sources}), encoding="utf-8")

    def pipeline(
        self, payloads: dict[str, bytes], analyzer: Analyzer | None = keep_all, max_process: int = 20
    ) -> NewsPipeline:
        def fetcher(url: str, timeout: float) -> bytes:
            self.assertEqual(timeout, 3.0)
            return payloads[url]

        return NewsPipeline(
            config_path=self.config,
            database_path=self.database,
            output_path=self.output,
            rsshub_base_url="https://rsshub.test",
            timeout=3.0,
            max_process=max_process,
            min_score=60,
            fetcher=fetcher,
            analyzer=analyzer,
        )

    def read_export(self) -> dict[str, Any]:
        return json.loads(self.output.read_text(encoding="utf-8"))

    def test_parses_rss_and_atom_through_pipeline(self):
        self.write_sources([
            {"id": "rss", "name": "RSS", "path": "/rss", "enabled": True},
            {"id": "atom", "name": "Atom", "path": "/atom", "enabled": True},
            {"id": "off", "name": "Disabled", "path": "/off", "enabled": False},
        ])
        pipeline = self.pipeline({
            "https://rsshub.test/rss": RSS,
            "https://rsshub.test/atom": ATOM,
        })

        report = pipeline.run_once()
        exported = self.read_export()

        self.assertEqual((report.sources, report.fetched, report.inserted), (2, 3, 3))
        self.assertEqual(exported["count"], 3)
        by_url = {item["url"]: item for item in exported["items"]}
        self.assertEqual(by_url["https://example.test/rss-one"]["original_title"], "Open Source & Tools")
        self.assertIn("A useful tool.", by_url["https://example.test/rss-one"]["tldr"])
        self.assertEqual(by_url["https://example.test/atom-one"]["published_at"], "2026-08-24T11:00:00Z")
        self.assertEqual(by_url["https://example.test/atom-one"]["category"], "AI热门")

    def test_url_is_deduplicated_across_rounds_and_sources(self):
        duplicate_atom = ATOM.replace(b"https://example.test/atom-one", b"https://example.test/rss-one")
        self.write_sources([
            {"id": "rss", "name": "RSS", "path": "/rss", "enabled": True},
            {"id": "atom", "name": "Atom", "path": "/atom", "enabled": True},
        ])
        pipeline = self.pipeline({
            "https://rsshub.test/rss": RSS,
            "https://rsshub.test/atom": duplicate_atom,
        })

        first = pipeline.run_once()
        second = pipeline.run_once()

        self.assertEqual(first.inserted, 2)
        self.assertEqual(second.inserted, 0)
        self.assertEqual(self.read_export()["count"], 2)

    def test_processing_round_robins_sources_to_avoid_large_feed_starvation(self):
        self.write_sources([
            {"id": "rss", "name": "RSS", "path": "/rss", "enabled": True},
            {"id": "atom", "name": "Atom", "path": "/atom", "enabled": True},
        ])
        processed_sources: list[str] = []

        def analyze(item: FeedItem) -> Analysis:
            processed_sources.append(item.source_id)
            return keep_all(item)

        pipeline = self.pipeline({
            "https://rsshub.test/rss": RSS,
            "https://rsshub.test/atom": ATOM,
        }, analyzer=analyze, max_process=2)

        report = pipeline.run_once()

        self.assertEqual(report.processed, 2)
        self.assertEqual(set(processed_sources), {"rss", "atom"})

    def test_ai_results_filter_low_score_and_rejected_content_before_export(self):
        self.write_sources([{"id": "rss", "name": "RSS", "path": "/rss", "enabled": True}])

        def analyze(item: FeedItem) -> Analysis:
            if item.url.endswith("rss-one"):
                return Analysis("优质工具", "这是一个实用开源工具。", ("开源",), 90, True)
            return Analysis("广告", "营销内容。", ("广告",), 95, False)

        pipeline = self.pipeline({"https://rsshub.test/rss": RSS}, analyzer=analyze)
        first = pipeline.run_once()

        low_score_feed = RSS.replace(b"https://example.test/rss-one", b"https://example.test/low").replace(
            b"https://example.test/rss-two", b"https://example.test/low-two"
        )

        def low_score(_item: FeedItem) -> Analysis:
            return Analysis("低质量", "信息不足。", ("杂项",), 40, True)

        low_pipeline = self.pipeline({"https://rsshub.test/rss": low_score_feed}, analyzer=low_score)
        second = low_pipeline.run_once()
        exported = self.read_export()

        self.assertEqual((first.published, first.filtered), (1, 1))
        self.assertEqual((second.published, second.filtered), (0, 2))
        self.assertEqual(exported["count"], 1)
        self.assertEqual(exported["items"][0]["title"], "优质工具")
        self.assertEqual(exported["items"][0]["tags"], ["开源"])

    def test_without_analyzer_new_items_remain_pending_and_export_is_empty(self):
        self.write_sources([{"id": "atom", "name": "Atom", "path": "/atom", "enabled": True}])
        pipeline = self.pipeline({"https://rsshub.test/atom": ATOM}, analyzer=None)

        report = pipeline.run_once()

        self.assertEqual((report.inserted, report.processed, report.pending), (1, 0, 1))
        self.assertEqual(self.read_export()["items"], [])

    def test_feed_parser_rejects_non_http_article_urls(self):
        unsafe = RSS.replace(b"https://example.test/rss-one", b"javascript:alert(1)")
        urls = [item.url for item in parse_feed(unsafe, "rss", "RSS")]
        self.assertEqual(urls, ["https://example.test/rss-two"])

    def test_deepseek_result_parser_rejects_non_strict_or_invalid_json(self):
        valid = '{"zh_title":"标题","tldr":"摘要。","tags":["AI"],"score":80,"keep":true,"category":"AI热门"}'
        self.assertEqual(DeepSeekAnalyzer.parse_result(valid).score, 80)
        self.assertEqual(DeepSeekAnalyzer.parse_result(valid).category, "AI热门")
        with self.assertRaises(ValueError):
            DeepSeekAnalyzer.parse_result(f"```json\n{valid}\n```")
        with self.assertRaises(ValueError):
            DeepSeekAnalyzer.parse_result('{"zh_title":"标题","tldr":"摘要","tags":[],"score":101,"keep":true,"category":"AI热门"}')
        with self.assertRaises(ValueError):
            DeepSeekAnalyzer.parse_result(valid.replace("AI热门", "综合"))


if __name__ == "__main__":
    unittest.main()
