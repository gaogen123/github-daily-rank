import copy
from datetime import datetime, timedelta
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts/projects'))
sys.path.insert(0, str(ROOT / 'scripts/shared'))
import project_profiles as profiles
import project_catalog as catalog

NOW = datetime(2026, 9, 12, 10)
SOURCE = {'description': 'Convert PDF files to Markdown locally.', 'topics': 'pdf markdown', 'readme': 'Run offline with Python. Extract text from PDF files.'}


def valid():
    return {'summary': '本地运行的 PDF 转 Markdown 工具',
            'summary_evidence': {'source': 'description', 'quote': SOURCE['description']},
            'capabilities': [{'text': '将 PDF 转成 Markdown', 'source': 'description', 'quote': 'Convert PDF files to Markdown'}],
            'features': [{'text': '支持离线运行', 'source': 'readme', 'quote': 'Run offline with Python.'}],
            'use_cases': [], 'keywords': ['PDF', 'Markdown'], 'insufficient': False}


def source():
    return dict(sources=SOURCE, metadata={'repoId': 42, 'description': SOURCE['description']},
                source_hash='source-v1', readme_sha='sha', source_urls={'readme': 'https://github.com/a/pdf#readme'}, source_truncated=False)


class ProfileExtractionTests(unittest.TestCase):
    def test_valid_claims_keep_auditable_original_excerpts(self):
        result = profiles.validate_profile(valid(), SOURCE)
        self.assertEqual(result['capabilities'], ['将 PDF 转成 Markdown'])
        self.assertEqual(result['status'], 'ready')
        self.assertIn('summary', result['evidence_json'])

    def test_rejects_fabricated_translated_and_wrong_source_excerpts(self):
        for field, value in [('quote', 'supports free commercial use'), ('source', 'homepage'), ('quote', '支持离线运行')]:
            payload = valid()
            payload['features'][0][field] = value
            with self.subTest(field=field, value=value), self.assertRaises(ValueError):
                profiles.validate_profile(payload, SOURCE)

    def test_invalid_shapes_empty_summary_and_insufficient_claims(self):
        for update in [{'summary': ''}, {'keywords': 'pdf'}, {'features': [1]}, {'insufficient': 'false'}, {'insufficient': True}]:
            with self.subTest(update=update), self.assertRaises(ValueError):
                profiles.validate_profile({**valid(), **update}, SOURCE)

    def test_missing_readme_can_use_description(self):
        payload = valid()
        payload['features'] = []
        result = profiles.validate_profile(payload, {**SOURCE, 'readme': ''})
        self.assertEqual(result['status'], 'ready')

    def test_no_description_or_readme_does_not_call_model(self):
        with patch.object(profiles, 'request', side_effect=AssertionError('must not call model')):
            result = profiles.generate_profile('a/empty', {'description': '', 'topics': 'ai', 'readme': ''})
        self.assertEqual(result['status'], 'insufficient')
        self.assertEqual(result['capabilities'], [])

    def test_readme_prioritizes_features_and_bounds_input(self):
        text = '# Overview\nUseful tool.\n# Contributors\n' + 'x' * 500 + '\n# Features\nConvert PDF offline.'
        selected, truncated = profiles.clean_readme(text, 100)
        self.assertIn('Convert PDF offline.', selected)
        self.assertTrue(truncated)
        self.assertEqual(len(selected), 100)

    def test_readme_removes_script_comments_and_images(self):
        text, _ = profiles.clean_readme('hello<!-- hidden --><script>bad()</script>![badge](url)world')
        self.assertEqual(text, 'helloworld')

    def test_empty_model_json_is_error_not_published(self):
        response = Mock()
        response.json.return_value = {'choices': [{'message': {'content': ''}}]}
        with patch.dict('os.environ', {'DEEPSEEK_API_KEY': 'test'}), patch.object(profiles, 'request', return_value=response):
            with self.assertRaises(ValueError):
                profiles.generate_profile('a/pdf', SOURCE)

    def test_gemini_api_used_when_gemini_key_present(self):
        response = Mock()
        response.json.return_value = {'choices': [{'message': {'content': json.dumps(valid())}}]}
        with patch.dict('os.environ', {'GEMINI_API_KEY': 'gemini-key', 'DEEPSEEK_API_KEY': ''}, clear=False),              patch.object(profiles, 'request', return_value=response) as mock_req:
            res = profiles.generate_profile('a/pdf', SOURCE)
            self.assertEqual(res['status'], 'ready')
            self.assertIn('generativelanguage.googleapis.com', mock_req.call_args[0][1])
            self.assertEqual(mock_req.call_args[1]['headers']['Authorization'], 'Bearer gemini-key')
            self.assertEqual(mock_req.call_args[1]['json']['model'], 'gemini-2.5-flash')


class RefreshTests(unittest.TestCase):
    def refresh(self, old=None, fetched=None, generate=None, **kwargs):
        return profiles.refresh_project({'repo': 'a/pdf'}, old, fetch=lambda p: fetched or source(),
            generate=generate or (lambda repo, src: profiles.validate_profile(valid(), src)), now=NOW, **kwargs)

    def test_repeat_skips_model_and_updates_checked_time(self):
        record, outcome = self.refresh()
        self.assertEqual(outcome, 'processed')
        again, outcome = self.refresh(record, generate=Mock(side_effect=AssertionError('duplicate model call')))
        self.assertEqual(outcome, 'skipped')
        self.assertEqual(again['generated_at'], record['generated_at'])
        self.assertEqual(again['checked_at'], NOW)

    def test_source_change_and_prompt_change_and_force_regenerate(self):
        old, _ = self.refresh()
        for kwargs, previous in [({'fetched': {**source(), 'source_hash': 'new'}}, old),
                                 ({}, {**old, 'prompt_version': 'v0'}), ({'force': True}, old)]:
            generator = Mock(return_value=profiles.validate_profile(valid(), SOURCE))
            self.refresh(previous, generate=generator, **kwargs)
            generator.assert_called_once()

    def test_failed_refresh_preserves_good_content_hash_evidence_and_timestamp(self):
        old, _ = self.refresh()
        result, outcome = self.refresh(old, fetched={**source(), 'source_hash': 'new'}, generate=Mock(side_effect=ValueError('bad JSON')))
        self.assertEqual(outcome, 'errors')
        for key in ['summary', 'capabilities', 'source_hash', 'generated_at', 'evidence_json']:
            self.assertEqual(result[key], old[key])
        self.assertEqual(result['status'], 'error')
        self.assertGreater(result['next_retry_at'], NOW)
        _, outcome = self.refresh(result, fetched={**source(), 'source_hash': 'new'})
        self.assertEqual(outcome, 'processed')

    def test_queue_includes_new_retry_stale_but_not_fresh_or_backoff(self):
        projects = {repo: {'repo': repo} for repo in ['a/new', 'b/retry', 'c/stale', 'd/fresh', 'e/backoff']}
        old, _ = self.refresh()
        records = {'b/retry': {**old, 'status': 'error', 'next_retry_at': NOW - timedelta(hours=1)},
                   'c/stale': {**old, 'checked_at': NOW - timedelta(days=8)},
                   'd/fresh': old, 'e/backoff': {**old, 'status': 'error', 'next_retry_at': NOW + timedelta(days=1)}}
        selected = profiles.select_projects(projects, records, now=NOW)
        self.assertEqual([p['repo'] for p in selected], ['a/new', 'b/retry', 'c/stale'])
        self.assertEqual(len(profiles.select_projects(projects, records, now=NOW, limit=1)), 1)

    def test_sql_upsert_uses_parameters_and_roundtrips_json(self):
        row, _ = self.refresh()
        connection = Mock()
        cursor = Mock()
        connection.cursor.return_value = Mock(__enter__=Mock(return_value=cursor), __exit__=Mock(return_value=False))
        profiles.save_record(connection, row)
        sql, values = cursor.execute.call_args.args
        self.assertNotIn('将 PDF', sql)
        saved = dict(zip(profiles.COLUMNS, values))
        self.assertEqual(profiles.decode_record(saved)['capabilities'], row['capabilities'])


class CatalogAndExportTests(unittest.TestCase):
    def test_deduplicates_across_sources_and_keeps_latest_metadata_and_historical_only_repo(self):
        rows = [dict(full_name='A/PDF', dt=20260901, total_stars=20, description='old'),
                dict(full_name='a/pdf', dt=20260902, stargazers_count=30, description='new'),
                dict(full_name='b/historical', dt=20240101, total_stars=1)]
        result = catalog.catalog_from_rows(rows)
        self.assertEqual(len(result), 2)
        self.assertEqual(result['a/pdf']['description'], 'new')
        self.assertEqual(result['a/pdf']['stars'], 30)
        self.assertEqual(result['a/pdf']['firstSeen'], '2026-09-01')
        self.assertEqual(len(catalog.SOURCE_TABLES), 9)

    def test_catalog_only_ignores_missing_table_errors(self):
        connection = Mock()
        with patch.object(catalog, 'query', side_effect=catalog.pymysql.err.ProgrammingError(1146, 'missing')):
            self.assertEqual(catalog.load_catalog(connection), {})
        with patch.object(catalog, 'query', side_effect=catalog.pymysql.err.OperationalError(5502, "Unknown table 'dwd.profile'")):
            self.assertEqual(catalog.optional_table(connection, 'dwd.profile'), [])
            self.assertEqual(catalog.load_catalog(connection), {})
        with patch.object(catalog, 'query', side_effect=catalog.pymysql.err.ProgrammingError(1045, 'access denied')):
            with self.assertRaises(catalog.pymysql.err.ProgrammingError):
                catalog.load_catalog(connection)

    def test_export_last_good_content_and_unprofiled_inventory_without_private_fields(self):
        record, _ = profiles.refresh_project({'repo': 'a/pdf'}, None, fetch=lambda p: source(),
            generate=lambda repo, src: profiles.validate_profile(valid(), src), now=NOW)
        record['status'] = 'error'
        record['last_error'] = 'private error'
        with tempfile.TemporaryDirectory() as temp:
            destination = Path(temp) / 'profiles.json'
            inventory = {'a/pdf': {'repo': 'a/pdf', 'stars': 12}, 'b/new': {'repo': 'b/new', 'stars': 0}}
            profiles.export_profiles(inventory, {'a/pdf': record}, destination)
            value = json.loads(destination.read_text())
            self.assertEqual(value['projects']['a/pdf']['capabilities'], ['将 PDF 转成 Markdown'])
            self.assertEqual(value['projects']['b/new']['stars'], 0)
            self.assertNotIn('private error', destination.read_text())
            self.assertNotIn('evidence_json', destination.read_text())
            self.assertEqual(list(Path(temp).iterdir()), [destination])

    def test_dry_run_is_read_only_and_works_without_profile_table(self):
        with patch.object(profiles, 'load_environment'), patch.object(profiles, 'connect') as connection, \
             patch.object(profiles, 'load_catalog', return_value={'a/pdf': {'repo': 'a/pdf'}}), \
             patch.object(profiles, 'load_profiles', return_value={}), \
             patch.object(profiles, 'save_record', side_effect=AssertionError('write')), \
             patch.object(profiles, 'fetch_sources', side_effect=AssertionError('network')):
            self.assertEqual(profiles.main(['--dry-run']), 0)
            connection.return_value.cursor.assert_not_called()


class RetryTests(unittest.TestCase):
    def test_rate_limit_backoff_then_success(self):
        limited = Mock(status_code=429, headers={'Retry-After': '3'}, ok=False)
        success = Mock(status_code=200, headers={}, ok=True)
        session = Mock()
        session.request.side_effect = [limited, success]
        sleeps = []
        self.assertIs(profiles.request('GET', 'https://example.invalid', session=session, sleep=sleeps.append), success)
        self.assertEqual(sleeps, [3])

    def test_permanent_failure_and_optional_readme(self):
        session = Mock()
        session.request.return_value = Mock(status_code=404, headers={}, ok=False)
        self.assertIsNone(profiles.request('GET', 'https://example.invalid', session=session, optional=True))
        with self.assertRaises(RuntimeError):
            profiles.request('GET', 'https://example.invalid', session=session)


class WorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        spec = importlib.util.spec_from_file_location('ds_profiles', ROOT / 'scripts/ds_release_workflow.py')
        cls.ds = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.ds)

    def test_dependencies_and_schedule(self):
        self.assertEqual(self.ds.dependencies_of('export_project_profiles'), ['refresh_project_profiles'])
        self.assertEqual(self.ds.dependencies_of('index_project_profiles'), ['export_project_profiles'])
        self.assertEqual(self.ds.PROFILE_SCHEDULE['timezoneId'], 'Asia/Shanghai')

    def test_dry_run_uses_no_api(self):
        result = subprocess.run([sys.executable, str(ROOT / 'scripts/ds_release_workflow.py'),
            '--project', 'test', '--workflow', 'profiles', '--profiles', '--dry-run', '--host', 'invalid.invalid'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len(json.loads(result.stdout)['tasks']), 3)

    def test_schedule_create_and_repeat_update(self):
        client = object.__new__(self.ds.DSClient)
        for existing in [[], [{'id': 9, 'releaseState': 'ONLINE'}]]:
            calls = []
            def call(method, path, **kwargs):
                calls.append((method, path, kwargs))
                data = {'totalList': existing} if method == 'GET' else {'id': 9}
                return {'code': 0, 'data': data}
            client._call = call
            client.configure_profile_schedule(1, 2)
            self.assertTrue(calls[-1][1].endswith('/9/online'))
            if existing:
                self.assertTrue(any(method == 'PUT' for method, _, _ in calls))
            else:
                self.assertEqual(calls[1][2]['form']['workflowDefinitionCode'], 2)


if __name__ == '__main__':
    unittest.main()
