function normalizeCategories(value) {
  if (!value || typeof value !== 'object') return {};
  return value.projects || value.projectCategories || value.categories || value;
}

export function normalizeAppData(raw = {}) {
  const {
    index,
    globalProjectIndex,
    authUser = null,
    news = null,
    projectCategories = null,
    projectImages = null,
    projectScores = null
  } = raw;

  if (!index || !Array.isArray(index.dates)) {
    throw new Error('缺少日期索引');
  }
  if (!globalProjectIndex || !Array.isArray(globalProjectIndex.projects)) {
    throw new Error('缺少全库项目索引');
  }

  return {
    dates: index.dates,
    selectedDate: index.latest,
    globalProjects: globalProjectIndex.projects,
    user: authUser || null,
    news: news || { generated_at: null, count: 0, items: [] },
    projectCategories: normalizeCategories(projectCategories),
    projectImages: projectImages?.images && typeof projectImages.images === 'object' ? projectImages.images : {},
    projectScores: projectScores?.projects && typeof projectScores.projects === 'object' ? projectScores.projects : {}
  };
}
