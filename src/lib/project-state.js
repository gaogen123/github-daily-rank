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

export function computeRankings({
  data,
  minK,
  maxK,
  query,
  activeTab,
  searchMode = false,
  searchResults = null,
  globalProjects = [],
  searchProvider = 'keyword'
}) {
  const min = minK * 1_000;
  const max = maxK * 1_000;
  const normalizedQuery = String(query || '').trim().toLowerCase();
  const key = searchMode ? 'stars' : activeTab === 'new' ? 'dailyGrowth' : activeTab;
  const source = searchMode ? (searchResults ?? globalProjects ?? []) : (data?.projects || []);
  const filtered = source
    .filter((project) => project.stars >= min && project.stars <= max)
    .filter((project) => searchMode || activeTab !== 'new' || isNewProject(project, data?.date))
    .filter((project) => searchProvider === 'semantic' || !normalizedQuery || `${project.repo} ${project.name} ${project.description}`.toLowerCase().includes(normalizedQuery));

  if (searchMode && searchProvider === 'semantic') return filtered;
  return filtered.sort((left, right) => (right[key] - left[key]) || String(left.repo).localeCompare(String(right.repo)));
}
