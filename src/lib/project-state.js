import { profileSearchText } from './project-profiles.js';

export function computeNewsItems({ news, category, sort }) {
  const items = (news?.items || []).filter((item) => item.category === category);
  const publishedAt = (item) => {
    const timestamp = Date.parse(item.published_at || '');
    return Number.isNaN(timestamp) ? 0 : timestamp;
  };

  return [...items].sort((left, right) => {
    if (sort === 'latest') {
      return publishedAt(right) - publishedAt(left) || String(left.id ?? left.title ?? '').localeCompare(String(right.id ?? right.title ?? ''));
    }
    return (Number(right.score) || 0) - (Number(left.score) || 0)
      || publishedAt(right) - publishedAt(left)
      || String(left.id ?? left.title ?? '').localeCompare(String(right.id ?? right.title ?? ''));
  });
}

export function formatNewsDate(value) {
  if (!value) return '时间未知';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit'
  }).format(date);
}

export function formatRelativeNewsDate(value, now = Date.now()) {
  if (!value) return '时间未知';
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return '时间未知';
  const elapsed = Math.max(0, now - timestamp);
  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  if (elapsed < minute) return '刚刚';
  if (elapsed < hour) return `${Math.floor(elapsed / minute)}分钟前`;
  if (elapsed < day) return `${Math.floor(elapsed / hour)}小时前`;
  if (elapsed < 7 * day) return `${Math.floor(elapsed / day)}天前`;
  if (elapsed < 30 * day) return `${Math.floor(elapsed / (7 * day))}周前`;
  if (elapsed < 365 * day) return `${Math.floor(elapsed / (30 * day))}个月前`;
  return `${Math.floor(elapsed / (365 * day))}年前`;
}

export function isNewProject(project, reportDate) {
  if (!project.openedAt) return false;
  const report = new Date(`${reportDate}T00:00:00Z`);
  const opened = new Date(`${project.openedAt}T00:00:00Z`);
  const age = (report - opened) / 86_400_000;
  return age >= 0 && age <= 30;
}

export function categoriesForRepo(repo, projectCategories, projectCategoryNames) {
  const value = projectCategories[repo];
  const categories = Array.isArray(value) ? value : Array.isArray(value?.categories) ? value.categories : [];
  return categories.filter((category) => projectCategoryNames.includes(category));
}

export function directoryScore(project, projectScores, directoryCategory) {
  return projectScores[project.repo]?.[directoryCategory] || null;
}

export function directoryProjects({
  globalProjects,
  projectCategories,
  projectScores,
  directoryCategory,
  directorySort,
  projectCategoryNames
}) {
  const categories = (repo) => categoriesForRepo(repo, projectCategories, projectCategoryNames);
  const projects = (globalProjects || [])
    .filter((project) => categories(project.repo).length)
    .filter((project) => directoryCategory === '全部' || categories(project.repo).includes(directoryCategory));

  const scoreDifference = (field, left, right) => {
    const leftScore = directoryScore(left, projectScores, directoryCategory);
    const rightScore = directoryScore(right, projectScores, directoryCategory);
    if (Boolean(leftScore?.excluded) !== Boolean(rightScore?.excluded)) return leftScore?.excluded ? 1 : -1;
    return (Number(rightScore?.[field]) || -1) - (Number(leftScore?.[field]) || -1);
  };
  const comparators = {
    recommended: (left, right) => scoreDifference('comprehensiveScore', left, right),
    rising: (left, right) => scoreDifference('hotScore', left, right),
    hot: (left, right) => (Number(right.dailyGrowth) || 0) - (Number(left.dailyGrowth) || 0),
    popular: (left, right) => (Number(right.stars) || 0) - (Number(left.stars) || 0),
    fastest: (left, right) => (Number(right.dailyRate) || 0) - (Number(left.dailyRate) || 0),
    latest: (left, right) => (Date.parse(right.lastSeen || '') || 0) - (Date.parse(left.lastSeen || '') || 0)
  };

  return projects.sort((left, right) => comparators[directorySort](left, right) || left.repo.localeCompare(right.repo));
}

export function rankingBoard(data, activeTab = '') {
  const tab = String(activeTab || '');
  const kind = tab.startsWith('trending_') ? tab
    : tab.startsWith('weekly') ? 'weekly_rank'
    : tab.startsWith('monthly') ? 'monthly_rank' : 'daily_rank';
  if (data?.boards) return data.boards[kind] || { date: '', projects: [] };
  return { date: data?.date || '', projects: tab.startsWith('trending_') ? [] : data?.projects || [] };
}

export function extractSearchTokens(query) {
  const stopWords = new Set([
    '把', '的', '了', '在', '是', '我', '有', '和', '就', '不', '人', '都', '一', '一个',
    '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己',
    '这', '项目', '工具', '框架', '推荐', '请问', '什么', '哪些', '如何', '怎么', '相关',
    '关于', '能够', '可以', '实现', '基于', '类似', '专程', '转成', '转换'
  ]);
  const parts = String(query || '').toLowerCase().split(/([a-z0-9_+#.-]+|[\s\p{P}\p{S}]+)/gu).map((s) => s.trim()).filter(Boolean);
  const tokens = [];
  for (const part of parts) {
    if (/^[a-z0-9_+#.-]+$/.test(part)) {
      if (part.length >= 2) tokens.push(part);
    } else {
      let s = part;
      for (const sw of stopWords) {
        s = s.replaceAll(sw, ' ');
      }
      for (const sub of s.split(/\s+/).filter(Boolean)) {
        if (sub.length >= 2) tokens.push(sub);
      }
    }
  }
  return [...new Set(tokens)];
}

export function matchProjectQuery(project, normalizedQuery) {
  if (!normalizedQuery) return 100;
  const text = profileSearchText(project).toLowerCase();
  if (text.includes(normalizedQuery)) return 100;
  const tokens = extractSearchTokens(normalizedQuery);
  if (!tokens.length) return 0;
  let matched = 0;
  for (const t of tokens) {
    if (text.includes(t)) matched++;
  }
  if (matched === tokens.length) return 50 + matched * 5;
  if (tokens.length > 1 && matched > 0) return matched;
  return 0;
}

export function computeRankings({
  data,
  minK,
  maxK,
  query,
  activeTab = '',
  searchMode = false,
  searchResults = null,
  globalProjects = [],
  searchProvider = 'keyword'
}) {
  const min = minK * 1_000;
  const max = maxK == null ? Infinity : maxK * 1_000;
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const key = searchMode ? 'stars' : activeTab === 'new' ? 'dailyGrowth' : activeTab;
  const board = rankingBoard(data, activeTab);
  const source = searchMode ? (searchResults ?? globalProjects ?? []) : board.projects;
  let filtered = source
    .filter((project) => project.stars >= min && project.stars <= max)
    .filter((project) => searchMode || activeTab !== 'new' || isNewProject(project, board.date));

  if (searchMode && searchProvider === 'semantic') return filtered;

  if (normalizedQuery && searchProvider !== 'semantic') {
    const scored = [];
    for (const project of filtered) {
      const score = matchProjectQuery(project, normalizedQuery);
      if (score > 0) scored.push({ project, score });
    }
    const fullMatches = scored.filter((s) => s.score >= 50);
    const results = fullMatches.length > 0 ? fullMatches : scored;
    if (searchMode) {
      return results
        .sort((a, b) => (b.score - a.score) || (b.project.stars - a.project.stars) || String(a.project.repo).localeCompare(String(b.project.repo)))
        .map((s) => s.project);
    }
    filtered = results.map((s) => s.project);
  }

  if (!searchMode && String(activeTab).startsWith('trending_')) return filtered.sort((a, b) => a.rank - b.rank);
  return filtered.filter((p) => searchMode || p[key] != null).sort((left, right) => (right[key] - left[key]) || String(left.repo).localeCompare(String(right.repo)));
}
