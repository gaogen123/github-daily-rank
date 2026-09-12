import sys
import unittest
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts/dwd'))
from repo_social_preview import decode_batch


class PreviewTests(unittest.TestCase):
    def test_custom_default_and_missing_are_distinct(self):
        result = decode_batch({'data': {
            'r0': {'openGraphImageUrl': 'https://example.com/custom.png', 'usesCustomOpenGraphImage': True},
            'r1': {'openGraphImageUrl': 'https://example.com/default.png', 'usesCustomOpenGraphImage': False},
            'r2': None,
        }, 'errors': [{'type': 'NOT_FOUND'}]}, ['a/custom', 'b/default', 'c/missing'])
        self.assertTrue(result['a/custom']['uses_custom_open_graph_image'])
        self.assertFalse(result['b/default']['uses_custom_open_graph_image'])
        self.assertNotIn('c/missing', result)
        self.assertTrue(result['a/custom']['image_fetched_at'])

    def test_api_errors_do_not_become_default_images(self):
        for payload in [{'errors': [{'type': 'RATE_LIMITED'}]}, {'data': {}}, {'data': {'r0': {'openGraphImageUrl': 'url'}}}]:
            with self.assertRaises(RuntimeError):
                decode_batch(payload, ['a/repo'])
