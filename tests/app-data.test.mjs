import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeAppData } from '../src/lib/normalize-app-data.js';

test('正式数据被归一化为统一结果', () => {
  const result = normalizeAppData({
    index: { dates: ['2026-09-01'], latest: '2026-09-01' },
    globalProjectIndex: { projects: [{ repo: 'acme/x' }] },
    authUser: { login: 'octo' },
    news: { generated_at: 't', count: 1, items: [] },
    projectCategories: { projects: { 'acme/x': ['AI智能体'] } },
    projectImages: { images: { 'acme/x': { url: '/data/x.webp' } } },
    projectScores: { projects: { 'acme/x': { comprehensiveScore: 80 } } }
  });

  assert.equal(result.selectedDate, '2026-09-01');
  assert.deepEqual(result.globalProjects, [{ repo: 'acme/x' }]);
  assert.deepEqual(result.user, { login: 'octo' });
  assert.deepEqual(result.projectCategories, { 'acme/x': ['AI智能体'] });
  assert.deepEqual(result.projectImages, { 'acme/x': { url: '/data/x.webp' } });
  assert.deepEqual(result.projectScores, { 'acme/x': { comprehensiveScore: 80 } });
});

test('缺失可选数据使用明确默认结果', () => {
  const result = normalizeAppData({
    index: { dates: [], latest: '' },
    globalProjectIndex: { projects: [] }
  });

  assert.deepEqual(result.user, null);
  assert.deepEqual(result.news, { generated_at: null, count: 0, items: [] });
  assert.deepEqual(result.projectCategories, {});
  assert.deepEqual(result.projectImages, {});
  assert.deepEqual(result.projectScores, {});
});

test('兼容四种历史分类数据形状', () => {
  const viaProjects = normalizeAppData({
    index: { dates: [], latest: '' },
    globalProjectIndex: { projects: [] },
    projectCategories: { projects: { 'acme/x': ['AI智能体'] } }
  });
  const viaCategories = normalizeAppData({
    index: { dates: [], latest: '' },
    globalProjectIndex: { projects: [] },
    projectCategories: { categories: { 'acme/x': ['AI智能体'] } }
  });
  const viaBare = normalizeAppData({
    index: { dates: [], latest: '' },
    globalProjectIndex: { projects: [] },
    projectCategories: { 'acme/x': ['AI智能体'] }
  });
  const viaProjectCategories = normalizeAppData({
    index: { dates: [], latest: '' },
    globalProjectIndex: { projects: [] },
    projectCategories: { projectCategories: { 'acme/x': ['AI智能体'] } }
  });

  assert.deepEqual(viaProjects.projectCategories, { 'acme/x': ['AI智能体'] });
  assert.deepEqual(viaCategories.projectCategories, { 'acme/x': ['AI智能体'] });
  assert.deepEqual(viaBare.projectCategories, { 'acme/x': ['AI智能体'] });
  assert.deepEqual(viaProjectCategories.projectCategories, { 'acme/x': ['AI智能体'] });
});

test('无效的必需数据产生稳定错误', () => {
  assert.throws(
    () => normalizeAppData({ globalProjectIndex: { projects: [] } }),
    /缺少日期索引/
  );
  assert.throws(
    () => normalizeAppData({ index: { dates: [], latest: '' } }),
    /缺少全库项目索引/
  );
});
