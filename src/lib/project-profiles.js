const list = (value) => Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];

export function profileFields(value = {}) {
  return {
    summary: typeof value.summary === 'string' ? value.summary : '',
    capabilities: list(value.capabilities),
    features: list(value.features),
    useCases: list(value.useCases),
    keywords: list(value.keywords),
    profileUpdatedAt: typeof value.profileUpdatedAt === 'string' ? value.profileUpdatedAt : null
  };
}

export function mergeProjectProfiles(projects, exported) {
  if (!exported) return projects;
  if (exported.schemaVersion !== 1 || !exported.projects || Array.isArray(exported.projects)) {
    throw new Error('项目档案格式无效');
  }
  const existing = new Map(projects.map((project) => [project.repo.toLowerCase(), project]));
  for (const [repo, profile] of Object.entries(exported.projects)) {
    if (!profile || typeof profile !== 'object') continue;
    const key = repo.toLowerCase();
    existing.set(key, { ...profile, ...existing.get(key), repo: key, ...profileFields(profile) });
  }
  return [...existing.values()];
}

export function profileSearchText(project) {
  const profile = profileFields(project);
  return [project.repo, project.name, project.description, profile.summary,
    ...profile.capabilities, ...profile.features, ...profile.useCases, ...profile.keywords].join(' ');
}

export function renderProfileDetails(project, escapeHtml) {
  const profile = profileFields(project);
  const items = (values) => `<ul>${values.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
  const capabilities = profile.capabilities.slice(0, 3);
  const extra = profile.capabilities.slice(3);
  const details = [
    extra.length ? `<strong>更多功能</strong>${items(extra)}` : '',
    profile.features.length ? `<strong>特点</strong>${items(profile.features)}` : '',
    profile.useCases.length ? `<strong>适用场景</strong>${items(profile.useCases)}` : ''
  ].join('');
  return `<div class="project-profile">${capabilities.length ? items(capabilities) : ''}${details
    ? `<details><summary>查看功能与特点</summary>${details}</details>` : ''}</div>`;
}
