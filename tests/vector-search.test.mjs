import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createProjectIndexSynchronizer,
  createSemanticProjectSearch,
  vectorSearchConfigured,
  vectorSearchConfig
} from '../lib/vector-search.mjs';
import * as legacyIndexAdapter from '../scripts/index-projects.mjs';
import * as canonicalIndex from '../scripts/projects/index-projects.mjs';

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

test('缺少密钥时不启用语义搜索', () => {
  assert.equal(vectorSearchConfigured({ QDRANT_URL: 'https://example.qdrant.io' }), false);
  assert.throws(
    () => vectorSearchConfig({ QDRANT_URL: 'https://example.qdrant.io' }),
    /SILICONFLOW_API_KEY/
  );
});

test('production adapter 通过同一语义搜索 interface 保持远端契约', async (context) => {
  const requests = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    if (url === 'https://api.siliconflow.cn/v1/embeddings') {
      return {
        ok: true,
        async json() {
          return { data: [{ index: 0, embedding: [0.4, 0.6] }] };
        }
      };
    }
    return {
      ok: true,
      status: 200,
      async json() {
        return {
          result: [{
            score: 0.87,
            payload: { repo: 'acme/search', stars: 5200 }
          }]
        };
      }
    };
  });
  const search = createSemanticProjectSearch({
    environment: {
      SILICONFLOW_API_KEY: 'siliconflow-key',
      QDRANT_URL: 'https://qdrant.example',
      QDRANT_API_KEY: 'qdrant-key'
    },
    proxyUrl: ''
  });

  const projects = await search.search('semantic search', {
    minStars: 5000,
    maxStars: 9000,
    limit: 8
  });

  assert.deepEqual(projects, [{ repo: 'acme/search', stars: 5200, semanticScore: 0.87 }]);
  assert.equal(requests[1].url, 'https://qdrant.example/collections/github_projects_bge_m3_v1/points/search');
  assert.deepEqual(JSON.parse(requests[0].options.body), {
    model: 'BAAI/bge-m3',
    input: ['semantic search'],
    encoding_format: 'float'
  });
  assert.deepEqual(JSON.parse(requests[1].options.body), {
    vector: [0.4, 0.6],
    limit: 8,
    with_payload: true,
    score_threshold: 0.2,
    filter: { must: [{ key: 'stars', range: { gte: 5000, lte: 9000 } }] }
  });
});

test('索引同步将内容变化项目标记为完整向量更新', async () => {
  const prepared = [];
  const synchronizer = createProjectIndexSynchronizer({
    documentProvider: {
      async list() {
        return {
          'acme/agent-tools': {
            contentFingerprint: 'old-content',
            payloadFingerprint: 'old-payload',
            repo: 'acme/agent-tools'
          }
        };
      },
      async prepare(project) {
        prepared.push(project.repo);
        return {
          repo: project.repo,
          name: 'Agent Tools',
          description: 'New description',
          embeddingText: 'project name and description'
        };
      },
      async save() {}
    },
    vectorIndexWriter: {
      async sync({ vectors, payloads }) {
        return { vectors, payloads };
      }
    }
  });

  const result = await synchronizer.sync({
    projects: [{ repo: 'acme/agent-tools' }]
  });

  assert.equal(prepared.length, 1);
  assert.equal(result.prepared, 1);
});

test('payload-only 变化只调用 payload 同步不触发 Embedding', async () => {
  const events = [];
  const prepare = () => ({
    repo: 'acme/payload',
    name: 'Payload',
    description: 'same',
    readmeSummary: 'same summary',
    topics: [],
    stars: 200
  });
  const prior = prepare();
  const capture = {};
  const priorSync = createProjectIndexSynchronizer({
    documentProvider: {
      async list() { return { 'acme/payload': prior }; },
      async prepare() { return prepare(); },
      async save() {}
    },
    vectorIndexWriter: {
      async sync({ vectors }) {
        for (const document of vectors) capture['acme/payload'] = document;
      }
    }
  });
  await priorSync.sync({ projects: [{ repo: 'acme/payload' }], force: true });

  const changed = { ...prepare(), stars: 999 };
  const synchronizer = createProjectIndexSynchronizer({
    documentProvider: {
      async list() { return { 'acme/payload': capture['acme/payload'] }; },
      async prepare() { return changed; },
      async save() {}
    },
    vectorIndexWriter: {
      async sync({ vectors, payloads }) {
        events.push({ vectors: vectors.length, payloads: payloads.length });
      }
    }
  });

  await synchronizer.sync({ projects: [{ repo: 'acme/payload' }] });

  assert.deepEqual(events, [{ vectors: 0, payloads: 1 }]);
});

test('Embedding 数量不完整会抛错且不写入向量', async () => {
  const events = [];
  const synchronizer = createProjectIndexSynchronizer({
    documentProvider: {
      async list() { return {}; },
      async prepare() {
        return { repo: 'acme/new', name: 'New', description: 'new', topics: [], stars: 1, embeddingText: 'new' };
      },
      async save() {}
    },
    vectorIndexWriter: {
      async sync({ vectors }) {
        events.push({ vectors: vectors.length });
        if (vectors.length) {
          const error = new Error('Embedding 数量不完整');
          error.code = 'INCOMPLETE_EMBEDDING';
          throw error;
        }
      }
    }
  });

  await assert.rejects(
    () => synchronizer.sync({ projects: [{ repo: 'acme/new' }] }),
    /Embedding 数量不完整/
  );
  assert.deepEqual(events, [{ vectors: 1 }]);
});

test('payload 写入失败返回稳定错误且项目下次仍被选择', async () => {
  let failures = 0;
  const prepare = () => ({
    repo: 'acme/payload',
    name: 'Payload',
    description: 'same',
    readmeSummary: 'same summary',
    topics: [],
    stars: 200
  });
  const capture = {};
  const priorSync = createProjectIndexSynchronizer({
    documentProvider: {
      async list() { return { 'acme/payload': prepare() }; },
      async prepare() { return prepare(); },
      async save() {}
    },
    vectorIndexWriter: {
      async sync({ vectors }) { for (const document of vectors) capture['acme/payload'] = document; }
    }
  });
  await priorSync.sync({ projects: [{ repo: 'acme/payload' }], force: true });

  const changed = { ...prepare(), stars: 999 };
  const synchronizer = createProjectIndexSynchronizer({
    documentProvider: {
      async list() { return { 'acme/payload': capture['acme/payload'] }; },
      async prepare() { return changed; },
      async save() {}
    },
    vectorIndexWriter: {
      async sync({ payloads }) {
        failures += 1;
        if (failures === 1) {
          const error = new Error('Payload 写入失败');
          error.code = 'PAYLOAD_WRITE_FAILED';
          throw error;
        }
      }
    }
  });

  await assert.rejects(
    () => synchronizer.sync({ projects: [{ repo: 'acme/payload' }] }),
    /Payload 写入失败/
  );
  await synchronizer.sync({ projects: [{ repo: 'acme/payload' }] });
  assert.equal(failures, 2);
});

test('refresh 不会让未变化项目重嵌', async () => {
  const writes = [];
  const cached = {
    'acme/stable': {
      repo: 'acme/stable',
      name: 'Stable',
      description: 'unchanged',
      readmeSummary: 'unchanged summary',
      topics: [],
      stars: 100,
      url: 'https://github.com/acme/stable',
      dailyGrowth: 1,
      openedAt: '2026-01-01',
      firstSeen: '2026-01-01',
      lastSeen: '2026-01-01',
      sourceHash: 'ignored',
      contentHash: 'ignored'
    }
  };
  const synchronizer = createProjectIndexSynchronizer({
    documentProvider: {
      async list() { return cached; },
      async prepare() { return { ...cached['acme/stable'] }; },
      async save() {}
    },
    vectorIndexWriter: {
      async sync({ vectors, payloads }) {
        writes.push({ vectors: vectors.length, payloads: payloads.length });
      }
    }
  });

  await synchronizer.sync({ projects: [{ repo: 'acme/stable' }], refresh: true });

  assert.deepEqual(writes, []);
});

test('索引同步用真实缓存 shape 判定未变化项目不重嵌', async () => {
  const writes = [];
  const cached = {
    'acme/stable': {
      repo: 'acme/stable',
      name: 'Stable',
      description: 'unchanged',
      readmeSummary: 'unchanged summary',
      topics: [],
      stars: 100,
      url: 'https://github.com/acme/stable',
      dailyGrowth: 1,
      openedAt: '2026-01-01',
      firstSeen: '2026-01-01',
      lastSeen: '2026-01-01',
      sourceHash: 'ignored',
      contentHash: 'ignored'
    }
  };
  const synchronizer = createProjectIndexSynchronizer({
    documentProvider: {
      async list() { return cached; },
      async prepare() {
        return { ...cached['acme/stable'] };
      },
      async save() {}
    },
    vectorIndexWriter: {
      async sync({ vectors, payloads }) {
        writes.push({ vectors: vectors.length, payloads: payloads.length });
      }
    }
  });

  await synchronizer.sync({ projects: [{ repo: 'acme/stable' }] });

  assert.deepEqual(writes, []);
});

test('索引同步区分内容变化、payload 变化和未变化项目', async () => {
  const calls = [];
  const prepare = (repo) => ({
    'acme/same': { repo, name: 'Same', description: 'same', readmeSummary: 'same summary', topics: [], stars: 100 },
    'acme/payload': { repo, name: 'Payload', description: 'same', readmeSummary: 'same summary', topics: [], stars: 200 },
    'acme/full': { repo, name: 'Full', description: 'changed', readmeSummary: 'changed summary', topics: [], stars: 300 }
  }[repo]);

  const samePrior = prepare('acme/same');
  const payloadPrior = { ...prepare('acme/payload'), stars: 250 };
  const fullPrior = { ...prepare('acme/full'), description: 'old', readmeSummary: 'old summary' };

  const capture = {};
  const state = {
    'acme/same': samePrior,
    'acme/payload': payloadPrior,
    'acme/full': fullPrior
  };
  const priorSync = createProjectIndexSynchronizer({
    documentProvider: {
      async list() { return state; },
      async prepare(project) { return state[project.repo]; },
      async save() {}
    },
    vectorIndexWriter: {
      async sync({ vectors, payloads }) {
        for (const document of [...vectors, ...payloads]) {
          capture[document.repo] = {
            contentFingerprint: document.contentFingerprint,
            payloadFingerprint: document.payloadFingerprint
          };
        }
      }
    }
  });
  await priorSync.sync({ projects: Object.values(state).map((project) => ({ repo: project.repo })), force: true });
  for (const repo of Object.keys(state)) {
    state[repo] = { ...state[repo], ...capture[repo] };
  }
  state['acme/payload'] = { ...state['acme/payload'], stars: 250 };

  const synchronizer = createProjectIndexSynchronizer({
    documentProvider: {
      async list() {
        return {
          'acme/same': state['acme/same'],
          'acme/payload': state['acme/payload'],
          'acme/full': state['acme/full']
        };
      },
      async prepare(project) {
        return prepare(project.repo);
      },
      async save() {}
    },
    vectorIndexWriter: {
      async sync({ vectors, payloads }) {
        calls.push({ vectors: vectors.map((document) => document.repo), payloads: payloads.map((document) => document.repo) });
      }
    }
  });

  await synchronizer.sync({
    projects: [{ repo: 'acme/same' }, { repo: 'acme/payload' }, { repo: 'acme/full' }]
  });

  assert.deepEqual(calls, [{
    vectors: ['acme/full'],
    payloads: ['acme/payload']
  }]);
});

test('索引同步对完全未变化项目不产生远端写入', async () => {
  const writes = [];
  const prepare = () => ({
    repo: 'acme/stable',
    name: 'Stable',
    description: 'unchanged',
    readmeSummary: 'unchanged',
    topics: [],
    stars: 100
  });
  const prior = prepare();
  const capture = {};
  const priorSync = createProjectIndexSynchronizer({
    documentProvider: {
      async list() { return { 'acme/stable': prior }; },
      async prepare() { return prepare(); },
      async save() {}
    },
    vectorIndexWriter: {
      async sync({ vectors }) {
        for (const document of vectors) capture['acme/stable'] = document;
      }
    }
  });
  await priorSync.sync({ projects: [{ repo: 'acme/stable' }], force: true });

  const synchronizer = createProjectIndexSynchronizer({
    documentProvider: {
      async list() { return { 'acme/stable': capture['acme/stable'] }; },
      async prepare() { return prepare(); },
      async save() {}
    },
    vectorIndexWriter: {
      async sync({ vectors, payloads }) {
        writes.push({ vectors: vectors.length, payloads: payloads.length });
      }
    }
  });

  await synchronizer.sync({ projects: [{ repo: 'acme/stable' }] });

  assert.deepEqual(writes, []);
});

test('production 索引同步通过同一 factory 写入向量并跳过未变化项目', async (context) => {
  const requests = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    requests.push({ url, options });
    if (url === 'https://api.siliconflow.cn/v1/embeddings') {
      return {
        ok: true,
        async json() {
          return { data: [{ index: 0, embedding: [1, 0] }] };
        }
      };
    }
    if (url.includes('/collections/github_projects_bge_m3_v1')) {
      return { ok: true, status: 200, async json() { return {}; } };
    }
    return { ok: true, status: 204, async json() { return null; } };
  });
  const search = createSemanticProjectSearch({
    environment: {
      SILICONFLOW_API_KEY: 'siliconflow-key',
      QDRANT_URL: 'https://qdrant.example',
      QDRANT_API_KEY: 'qdrant-key'
    },
    proxyUrl: ''
  });
  const state = {
    'acme/new': {
      repo: 'acme/new',
      name: 'New',
      description: 'old',
      topics: [],
      stars: 1
    }
  };
  const indexer = search.createIndexer({
    list: async () => state,
    prepare: async () => ({
      repo: 'acme/new',
      name: 'New',
      description: 'new',
      readmeSummary: 'new summary',
      topics: [],
      stars: 2,
      embeddingText: 'new project'
    }),
    save: async () => {}
  });

  await indexer.sync({ projects: [{ repo: 'acme/new' }] });

  assert.ok(requests.some(({ url }) => url.includes('/points?wait=true')));
});

test('旧脚本路径兼容 adapter 转发 canonical 索引入口', () => {
  assert.equal(typeof legacyIndexAdapter.main, 'function');
  assert.equal(legacyIndexAdapter.main, canonicalIndex.main);
});

test('通过语义搜索 interface 返回符合约束的规范化项目', async () => {
  const calls = [];
  const search = createSemanticProjectSearch({
    embeddingAdapter: {
      async embed(texts) {
        calls.push({ adapter: 'embedding', texts });
        return [[0.25, 0.75]];
      }
    },
    vectorIndexAdapter: {
      async search(options) {
        calls.push({ adapter: 'vector-index', options });
        return [{
          score: 0.91,
          payload: { repo: 'acme/agent-tools', name: 'Agent Tools', stars: 4200 }
        }];
      }
    }
  });

  const projects = await search.search('agent tools', {
    minStars: 1000,
    maxStars: 10_000,
    limit: 12
  });

  assert.deepEqual(projects, [{
    repo: 'acme/agent-tools',
    name: 'Agent Tools',
    stars: 4200,
    semanticScore: 0.91
  }]);
  assert.deepEqual(calls, [
    { adapter: 'embedding', texts: ['agent tools'] },
    {
      adapter: 'vector-index',
      options: {
        vector: [0.25, 0.75],
        minStars: 1000,
        maxStars: 10_000,
        limit: 12
      }
    }
  ]);
});
