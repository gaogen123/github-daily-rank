import test from 'node:test';
import assert from 'node:assert/strict';
import {
  vectorSearchConfigured,
  vectorSearchConfig
} from '../lib/vector-search.mjs';

test('识别完整的向量搜索配置', () => {
  const environment = {
    SILICONFLOW_API_KEY: 'test-siliconflow-key',
    QDRANT_URL: 'https://example.qdrant.io/',
    QDRANT_API_KEY: 'test-qdrant-key'
  };

  assert.equal(vectorSearchConfigured(environment), true);
  const config = vectorSearchConfig(environment);
  assert.equal(config.qdrantUrl, 'https://example.qdrant.io');
  assert.equal(config.collection, 'github_projects_bge_m3_v1');
  assert.equal(config.model, 'BAAI/bge-m3');
  assert.equal(config.dimension, 1024);
});

test('缺少密钥时不启用向量搜索', () => {
  assert.equal(vectorSearchConfigured({ QDRANT_URL: 'https://example.qdrant.io' }), false);
  assert.throws(
    () => vectorSearchConfig({ QDRANT_URL: 'https://example.qdrant.io' }),
    /SILICONFLOW_API_KEY/
  );
});
