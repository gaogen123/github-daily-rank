import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeProjectProfiles, profileSearchText, renderProfileDetails } from '../src/lib/project-profiles.js';
import { computeRankings } from '../src/lib/project-state.js';
import { normalizeAppData } from '../src/lib/normalize-app-data.js';
import { prepareDocument, indexCacheKey } from '../scripts/projects/index-projects.mjs';
import { createProjectIndexSynchronizer, createSemanticProjectSearch } from '../lib/vector-search.mjs';
import { createRuntime } from '../lib/runtime.mjs';

const exported = { schemaVersion: 1, projects: {
  'a/pdf': { repo: 'a/pdf', stars: 10, summary: '文档转换', capabilities: ['将 PDF 转成 Markdown'], features: ['本地运行'], useCases: ['知识库导入'], keywords: ['格式转换'] },
  'b/new': { repo: 'b/new', stars: 0, description: 'New project without profile' }
} };

test('profile merge includes historical-only inventory and keeps existing latest Star metrics', () => {
  const projects = mergeProjectProfiles([{ repo: 'A/PDF', stars: 20, dailyGrowth: 2 }], exported);
  assert.equal(projects.length, 2);
  assert.equal(projects[0].stars, 20);
  assert.equal(projects[0].dailyGrowth, 2);
  assert.equal(projects[0].capabilities[0], '将 PDF 转成 Markdown');
  assert.equal(projects[1].stars, 0);
  assert.deepEqual(mergeProjectProfiles([{ repo: 'a/pdf' }], null), [{ repo: 'a/pdf' }]);
  assert.throws(() => mergeProjectProfiles([], {}));
});

test('bootstrap merges profiles and keyword text includes every feature field', () => {
  const state = normalizeAppData({ index: { dates: [], latest: '' }, globalProjectIndex: { projects: [] }, projectProfiles: exported });
  const text = profileSearchText(state.globalProjects[0]);
  for (const term of ['PDF', '本地运行', '知识库导入', '格式转换']) assert.ok(text.includes(term));
});

test('search without upper bound includes zero-star and very popular projects, preserving semantic order', () => {
  const searchResults = [{ repo: 'a/small', stars: 0 }, { repo: 'b/large', stars: 20_000_000 }];
  const state = { data: {}, minK: 0, maxK: null, query: '本地工具', activeTab: 'dailyGrowth', searchMode: true, searchProvider: 'semantic', searchResults };
  assert.deepEqual(computeRankings(state), searchResults);
  assert.deepEqual(computeRankings({ ...state, maxK: 1 }), [searchResults[0]]);
});

test('keyword query finds capability text rather than just original description', () => {
  const globalProjects = mergeProjectProfiles([], exported);
  const found = computeRankings({ data: {}, minK: 0, maxK: null, query: '知识库', activeTab: 'stars', searchMode: true, globalProjects });
  assert.deepEqual(found.map(p => p.repo), ['a/pdf']);
});

test('feature UI escapes model output and only initially displays three capabilities', () => {
  const escape = value => String(value).replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const html = renderProfileDetails({ capabilities: ['a', 'b', 'c', '<script>x</script>'], features: ['本地'], useCases: ['搜索'] }, escape);
  assert.ok(!html.includes('<script>'));
  assert.ok(html.indexOf('&lt;script&gt;') > html.indexOf('<details>'));
  assert.ok(html.includes('适用场景'));
});

test('index preparation uses exported profiles and has no network/model dependency', () => {
  const doc = prepareDocument({ ...exported.projects['a/pdf'], topics: '["pdf"]' });
  assert.equal(doc.readmeSummary, '文档转换');
  assert.deepEqual(doc.topics, ['pdf']);
  assert.equal(prepareDocument({ repo: 'b/new', description: 'raw' }).readmeSummary, '');
});

test('index checkpoints are isolated by collection/model/dimension', () => {
  const config = { qdrantUrl: 'https://qdrant.invalid', collection: 'profiles', model: 'bge', dimension: 1024 };
  const key = indexCacheKey(config);
  for (const change of [{ collection: 'old' }, { model: 'other' }, { dimension: 768 }]) {
    assert.notEqual(indexCacheKey({ ...config, ...change }), key);
  }
});

test('profile changes re-embed; timestamps and Stars only update payload', async () => {
  const before = prepareDocument(exported.projects['a/pdf']);
  for (const [change, expected] of [[{ capabilities: ['转换 PDF 和图片'] }, [1, 0]], [{ stars: 99 }, [0, 1]], [{ profileUpdatedAt: '2026-09-12' }, [0, 1]]]) {
    let result;
    const indexer = createProjectIndexSynchronizer({ documentProvider: {
      async list() { return { 'a/pdf': before }; }, async prepare() { return { ...before, ...change }; }, async save() {}
    }, vectorIndexWriter: { async sync({ vectors, payloads }) { result = [vectors.length, payloads.length]; } } });
    await indexer.sync({ projects: [before] });
    assert.deepEqual(result, expected);
  }
});

test('batch interruption resumes after successfully checkpointed projects', async () => {
  const projects = Array.from({ length: 35 }, (_, i) => ({ repo: `a/repo-${i}`, description: 'test' }));
  const cache = {};
  let batches = 0;
  const indexer = createProjectIndexSynchronizer({ documentProvider: {
    async list() { return cache; }, async prepare(p) { return p; }, async save(p) { cache[p.repo] = p; }
  }, vectorIndexWriter: { async sync() { if (++batches === 2) throw new Error('interrupted'); } } });
  await assert.rejects(() => indexer.sync({ projects }), /interrupted/);
  assert.equal(Object.keys(cache).length, 32);
  const result = await indexer.sync({ projects });
  assert.equal(result.prepared, 3);
  assert.equal(Object.keys(cache).length, 35);
});

test('query vectors with no upper bound do not send a hidden Star ceiling', async (context) => {
  const calls = [];
  context.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(JSON.parse(options.body));
    return { ok: true, json: async () => url.includes('embeddings') ? { data: [{ index: 0, embedding: [1, 0] }] } : { result: [] } };
  });
  const search = createSemanticProjectSearch({ environment: { SILICONFLOW_API_KEY: 'test', QDRANT_URL: 'https://qdrant.invalid', QDRANT_API_KEY: 'test' }, proxyUrl: '' });
  await search.search('PDF 转 Markdown');
  assert.deepEqual(calls[1].filter.must[0].range, { gte: 0 });
});

test('API preserves profile fields and accepts an unbounded or zero upper Star range', async () => {
  const calls = [];
  const runtime = createRuntime({ environment: {}, semanticSearch: { async search(query, options) {
    calls.push(options); return [{ ...exported.projects['a/pdf'], semanticScore: 0.8 }];
  } } });
  const server = runtime.app.listen(0);
  await new Promise(resolve => server.once('listening', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/search`;
    for (const maxStars of [null, 0, 200]) {
      const response = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '文档转换', maxStars }) });
      assert.equal(response.status, 200);
      const result = await response.json();
      assert.deepEqual(result.projects[0].capabilities, ['将 PDF 转成 Markdown']);
      assert.equal(calls.at(-1).maxStars, maxStars);
    }
    const bad = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: '文档转换', minStars: 10, maxStars: 1 }) });
    assert.equal(bad.status, 400);
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('Node scheduler defaults to off even with configured vector services', () => {
  let calls = 0;
  const runtime = createRuntime({ environment: { SILICONFLOW_API_KEY: 'test', QDRANT_URL: 'https://qdrant.invalid', QDRANT_API_KEY: 'test' }, scheduler: { validate: () => true, schedule: () => calls++ } });
  runtime.startScheduler();
  assert.equal(calls, 0);
});

test('search evaluation requires real annotations and measures top-five hits', async () => {
  const { evaluateResults } = await import('../scripts/projects/evaluate-profile-search.mjs');
  const cases = Array.from({ length: 20 }, (_, i) => ({ query: `query ${i}`, expectedRepos: ['a/relevant'] }));
  const results = Object.fromEntries(cases.map((item, i) => [item.query, i < 16 ? [{ repo: 'a/relevant' }] : [{ repo: 'a/other' }]]));
  const report = evaluateResults(cases, results);
  assert.equal(report.hitRateAt5, 0.8);
  assert.equal(report.passed, true);
  assert.throws(() => evaluateResults(cases.map(item => ({ ...item, expectedRepos: [] })), results));
  assert.throws(() => evaluateResults(cases.map(item => ({ ...item, query: 'duplicate' })), results));
});

test('an incompatible optional profile export does not take the website down', () => {
  const state = normalizeAppData({ index: { dates: [], latest: '' }, globalProjectIndex: { projects: [{ repo: 'a/raw' }] }, projectProfiles: { schemaVersion: 99 } });
  assert.deepEqual(state.globalProjects, [{ repo: 'a/raw' }]);
});
