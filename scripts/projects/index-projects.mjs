import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ProxyAgent } from 'undici';
import { createSemanticProjectSearch, vectorSearchConfig } from '../../lib/vector-search.mjs';
import { mergeProjectProfiles, profileFields } from '../../src/lib/project-profiles.js';

const projectRoot = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}

async function loadLocalEnvironment() {
  try {
    const content = await readFile(join(projectRoot, '.env.local'), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim().replace(/^['"]|['"]$/g, '');
    }
  } catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export function indexCacheKey(config) {
  return createHash('sha256').update(JSON.stringify([
    'profiles-v1', config.qdrantUrl, config.collection, config.model, config.dimension
  ])).digest('hex').slice(0, 24);
}

export function prepareDocument(project) {
  let topics = project.topics || [];
  if (typeof topics === 'string') {
    try { topics = JSON.parse(topics); } catch { topics = []; }
  }
  return {
    ...project, repo: project.repo.toLowerCase(),
    ...profileFields(project),
    topics: Array.isArray(topics) ? topics : [],
    // Old private README-summary caches are deliberately not a profile source.
    readmeSummary: project.summary || '',
    stars: Number(project.stars) || 0
  };
}

export async function main() {
  await loadLocalEnvironment();
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const limitArg = args.find((arg) => arg.startsWith('--limit='));
  const limit = limitArg ? Number(limitArg.split('=')[1]) : Infinity;
  if (!(limit > 0)) throw new Error('--limit must be positive');
  const config = vectorSearchConfig();
  const cachePath = join(projectRoot, 'storage', `search-documents-${indexCacheKey(config)}.json`);
  await mkdir(dirname(cachePath), { recursive: true });
  // Shared-volume lock prevents scheduler/manual runs racing on the same collection.
  const lockPath = cachePath + '.lock';
  await writeFile(lockPath, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }), { flag: 'wx' })
    .catch((error) => { throw new Error(error.code === 'EEXIST' ? `索引任务正在运行或锁未清理：${lockPath}` : error.message); });
  const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || '';
  const dispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
  try {
    const cache = await readJson(cachePath, {});
    const projectIndex = await readJson(join(projectRoot, 'public/data/projects.json'), { projects: [] });
    // Required export: missing/corrupt files must not overwrite good vectors with fallback text.
    const profiles = await readJson(join(projectRoot, 'public/data/project-profiles.json'));
    const projects = mergeProjectProfiles(projectIndex.projects, profiles).slice(0, limit);
    const search = createSemanticProjectSearch({ environment: process.env, proxyUrl, dispatcher });
    const indexer = search.createIndexer({
      async list() { return cache; },
      async prepare(project) { return prepareDocument(project); },
      async save(document) {
        cache[document.repo] = document;
        const temporary = cachePath + '.tmp';
        await writeFile(temporary, JSON.stringify(cache) + '\n', 'utf8');
        await rename(temporary, cachePath);
      }
    });
    const result = await indexer.sync({ projects, force });
    console.log(JSON.stringify({ total: projects.length, ...result }));
  } finally {
    try { await dispatcher?.close(); } finally { await unlink(lockPath); }
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
