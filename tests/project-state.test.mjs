import test from 'node:test';
import assert from 'node:assert/strict';
import {
  categoriesForRepo,
  computeNewsItems,
  computeRankings,
  directoryProjects,
  formatNewsDate,
  formatRelativeNewsDate,
  isNewProject
} from '../src/lib/project-state.js';

const news = {
  items: [
    { id: 1, category: 'AI热门', score: 50, published_at: '2026-09-01T10:00:00Z', url: 'http://a', title: 'a', tldr: 'a', source: { name: 's' }, tags: [] },
    { id: 2, category: 'AI热门', score: 80, published_at: '2026-09-02T10:00:00Z', url: 'http://b', title: 'b', tldr: 'b', source: { name: 's' }, tags: [] },
    { id: 3, category: '后端', score: 99, published_at: '2026-09-03T10:00:00Z', url: 'http://c', title: 'c', tldr: 'c', source: { name: 's' }, tags: [] }
  ]
};

test('新闻分类切换返回正确集合', () => {
  const items = computeNewsItems({ news, category: 'AI热门', sort: 'recommended' });
  assert.deepEqual(items.map((item) => item.id), [2, 1]);
});

test('推荐排序先比较分数再比较发布时间', () => {
  const items = computeNewsItems({ news, category: 'AI热门', sort: 'recommended' });
  assert.equal(items[0].id, 2);
  assert.equal(items[1].id, 1);
});

test('最新排序按有效发布时间排列', () => {
  const items = computeNewsItems({ news, category: 'AI热门', sort: 'latest' });
  assert.deepEqual(items.map((item) => item.id), [2, 1]);
});

test('无效或缺失时间具有稳定结果', () => {
  const items = computeNewsItems({
    news: {
      items: [
        { id: 1, category: 'AI热门', score: 10, published_at: '' },
        { id: 2, category: 'AI热门', score: 20, published_at: 'not-a-date' }
      ]
    },
    category: 'AI热门',
    sort: 'recommended'
  });

  assert.equal(items[0].id, 2);
});

test('相对时间使用可控时钟', () => {
  const timestamp = '2026-09-01T10:00:00Z';
  const now = Date.parse('2026-09-01T10:05:00Z');
  assert.equal(formatRelativeNewsDate(timestamp, now), '5分钟前');
});

test('绝对时间格式化无效值回退', () => {
  assert.equal(formatNewsDate(''), '时间未知');
  assert.equal(formatRelativeNewsDate('', 0), '时间未知');
});

const rankingState = {
  data: {
    date: '2026-09-01',
    projects: [
      { repo: 'a/x', name: 'A', description: 'alpha', stars: 5000, dailyGrowth: 100, dailyRate: 1 },
      { repo: 'b/y', name: 'B', description: 'beta', stars: 2000, dailyGrowth: 200, dailyRate: 2 },
      { repo: 'c/z', name: 'C', description: 'gamma', stars: 8000, dailyGrowth: 50, dailyRate: 3, openedAt: '2026-08-20' }
    ]
  },
  minK: 1,
  maxK: 10,
  query: '',
  activeTab: 'dailyGrowth',
  searchMode: false,
  searchResults: null,
  globalProjects: [],
  searchProvider: 'keyword'
};

test('排行榜按 Star 范围筛选', () => {
  const result = computeRankings({ ...rankingState, minK: 3, maxK: 10 });
  assert.deepEqual(result.map((project) => project.repo).sort(), ['a/x', 'c/z']);
});

test('排行榜按 activeTab 指标排序', () => {
  const result = computeRankings({ ...rankingState });
  assert.deepEqual(result.map((project) => project.repo), ['b/y', 'a/x', 'c/z']);
});

test('关键词搜索匹配 repo/name/description', () => {
  const result = computeRankings({ ...rankingState, query: 'beta' });
  assert.deepEqual(result.map((project) => project.repo), ['b/y']);
});

test('新项目 30 天判定覆盖临界与无效日期', () => {
  assert.equal(isNewProject({ openedAt: '2026-08-20' }, '2026-09-01'), true);
  assert.equal(isNewProject({ openedAt: '2026-08-01' }, '2026-09-01'), false);
  assert.equal(isNewProject({}, '2026-09-01'), false);
});

const categoryNames = ['AI智能体', 'AI营销'];
const directoryFixture = {
  globalProjects: [
    { repo: 'a/x', name: 'A', stars: 100, dailyGrowth: 10, dailyRate: 1, lastSeen: '2026-09-01' },
    { repo: 'b/y', name: 'B', stars: 200, dailyGrowth: 20, dailyRate: 2, lastSeen: '2026-09-02' },
    { repo: 'c/z', name: 'C', stars: 300, dailyGrowth: 30, dailyRate: 3, lastSeen: '2026-09-03' }
  ],
  projectCategories: {
    'a/x': ['AI智能体'],
    'b/y': ['AI营销'],
    'c/z': ['未知分类']
  },
  projectScores: {
    'a/x': { 全部: { comprehensiveScore: 80, hotScore: 70, excluded: false } },
    'b/y': { 全部: { comprehensiveScore: 60, hotScore: 90, excluded: true } }
  }
};

test('categoriesForRepo 过滤未知分类', () => {
  assert.deepEqual(categoriesForRepo('a/x', directoryFixture.projectCategories, categoryNames), ['AI智能体']);
  assert.deepEqual(categoriesForRepo('c/z', directoryFixture.projectCategories, categoryNames), []);
});

test('目录全部分类筛选返回已分类项目', () => {
  const result = directoryProjects({ ...directoryFixture, directoryCategory: '全部', directorySort: 'recommended', projectCategoryNames: categoryNames });
  assert.deepEqual(result.map((project) => project.repo), ['a/x', 'b/y']);
});

test('目录单一分类筛选只返回该分类项目', () => {
  const result = directoryProjects({ ...directoryFixture, directoryCategory: 'AI营销', directorySort: 'recommended', projectCategoryNames: categoryNames });
  assert.deepEqual(result.map((project) => project.repo), ['b/y']);
});

test('目录推荐排序将排除项目放在后面', () => {
  const result = directoryProjects({ ...directoryFixture, directoryCategory: '全部', directorySort: 'recommended', projectCategoryNames: categoryNames });
  assert.deepEqual(result.map((project) => project.repo), ['a/x', 'b/y']);
});
