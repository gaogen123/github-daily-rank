export function githubRepositoryUrl(repo) {
  const segments = String(repo || '').split('/');
  if (segments.length !== 2 || segments.some((segment) => !segment)) return '';
  return `https://github.com/${segments.map(encodeURIComponent).join('/')}`;
}

export function projectRepositoryUrl(project = {}) {
  if (project.url) {
    try {
      const url = new URL(project.url);
      if (url.protocol === 'http:' || url.protocol === 'https:') return url.href;
    } catch {}
  }
  return githubRepositoryUrl(project.repo);
}
