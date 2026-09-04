import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cron from 'node-cron';
import { ProxyAgent } from 'undici';
import {
  searchProjects,
  vectorSearchConfigured,
  vectorSearchConfig
} from './lib/vector-search.mjs';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const projectDataRepository = 'https://github.com/OpenGithubs/github-daily-rank.git';
const projectReportPathspec = ':(glob)20??/??/20??????.md';
const isDevelopment = process.argv.includes('--dev');
const port = Number(process.env.PORT) || 3000;
const defaultClientId = 'Iv23lipOXPUiR5ZQFSTr';
const sessions = new Map();
const searchRateLimits = new Map();
let projectDataRefreshRunning = false;
let vectorIndexRunning = false;
let newsRefreshRunning = false;
let projectCategoryRefreshRunning = false;
let projectImageRefreshRunning = false;
let projectMetricsRefreshRunning = false;

async function loadLocalEnvironment() {
  try {
    const content = await readFile(join(projectRoot, '.env.local'), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const matched = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!matched || process.env[matched[1]]) continue;
      process.env[matched[1]] = matched[2].trim().replace(/^['"]|['"]$/g, '');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

function parseCookies(header = '') {
  return Object.fromEntries(header.split(';').flatMap((part) => {
    const separator = part.indexOf('=');
    if (separator < 0) return [];
    return [[part.slice(0, separator).trim(), decodeURIComponent(part.slice(separator + 1).trim())]];
  }));
}

function cookie(name, value, options = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, `Path=${options.path || '/'}`, 'SameSite=Lax'];
  if (options.httpOnly !== false) parts.push('HttpOnly');
  if (options.maxAge !== undefined) parts.push(`Max-Age=${options.maxAge}`);
  if (options.secure) parts.push('Secure');
  return parts.join('; ');
}

function oauthFailure(code, message) {
  const error = new Error(message);
  error.oauthCode = code;
  return error;
}

function currentUser(request) {
  const sessionId = parseCookies(request.headers.cookie).github_rank_session;
  const session = sessions.get(sessionId);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    sessions.delete(sessionId);
    return null;
  }
  return session.user;
}

function runCommand(command, arguments_, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, arguments_, {
      cwd: projectRoot,
      env: process.env,
      shell: false,
      stdio: 'inherit'
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) return resolve();
      reject(new Error(`${label}执行失败：${signal ? `信号 ${signal}` : `退出码 ${code}`}`));
    });
  });
}

function runNodeScript(script, arguments_ = []) {
  return runCommand(process.execPath, [join(projectRoot, script), ...arguments_], `${script} `);
}

async function refreshProjectData() {
  if (projectDataRefreshRunning) {
    console.warn('[项目数据任务] 上一次任务仍在运行，本次已跳过');
    return;
  }

  projectDataRefreshRunning = true;
  const startedAt = Date.now();
  console.log('[项目数据任务] 开始拉取远程日报并重新生成数据');
  try {
    await runCommand(
      'git',
      ['fetch', '--no-tags', projectDataRepository, 'main'],
      'GitHub 日报更新 '
    );
    await runCommand(
      'git',
      ['restore', '--source=FETCH_HEAD', '--worktree', '--', projectReportPathspec],
      'GitHub 日报同步 '
    );
    await runNodeScript('scripts/generate-data.mjs');
    console.log(`[项目数据任务] 完成，耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`);
  } catch (error) {
    console.error(`[项目数据任务] 失败：${error.message}`);
  } finally {
    projectDataRefreshRunning = false;
  }
}

async function refreshVectorIndex() {
  if (vectorIndexRunning) {
    console.warn('[向量定时任务] 上一次任务仍在运行，本次已跳过');
    return;
  }

  vectorIndexRunning = true;
  const startedAt = Date.now();
  console.log('[向量定时任务] 开始检测向量变化');
  try {
    await runNodeScript('scripts/index-projects.mjs', ['--refresh']);
    console.log(`[向量定时任务] 完成，耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`);
  } catch (error) {
    console.error(`[向量定时任务] 失败：${error.message}`);
  } finally {
    vectorIndexRunning = false;
  }
}

async function refreshProjectCategories() {
  if (projectCategoryRefreshRunning) {
    console.warn('[项目分类任务] 上一次任务仍在运行，本次已跳过');
    return;
  }

  const configuredMax = Number.parseInt(process.env.PROJECT_CATEGORY_MAX_PROCESS || '', 10);
  const maxProcess = Number.isInteger(configuredMax) && configuredMax >= 0 ? configuredMax : 100;
  projectCategoryRefreshRunning = true;
  const startedAt = Date.now();
  console.log(`[项目分类任务] 开始增量分类，最多处理 ${maxProcess} 个项目`);
  try {
    await runCommand(
      process.env.PYTHON_BIN || 'python3',
      [join(projectRoot, 'scripts/project_classifier.py'), '--max-process', String(maxProcess)],
      'GitHub 项目分类 '
    );
    console.log(`[项目分类任务] 完成，耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`);
  } catch (error) {
    console.error(`[项目分类任务] 失败：${error.message}`);
  } finally {
    projectCategoryRefreshRunning = false;
  }
}

async function refreshProjectImages() {
  if (projectImageRefreshRunning) {
    console.warn('[项目图片任务] 上一次任务仍在运行，本次已跳过');
    return;
  }

  const configuredMax = Number.parseInt(process.env.PROJECT_IMAGE_MAX_PROCESS || '', 10);
  const maxProcess = Number.isInteger(configuredMax) && configuredMax >= 0 ? configuredMax : 20;
  projectImageRefreshRunning = true;
  const startedAt = Date.now();
  console.log(`[项目图片任务] 开始增量生成，最多处理 ${maxProcess} 个项目`);
  try {
    await runNodeScript('scripts/project_images.mjs', ['--max-process', String(maxProcess)]);
    console.log(`[项目图片任务] 完成，耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`);
  } catch (error) {
    console.error(`[项目图片任务] 失败：${error.message}`);
  } finally {
    projectImageRefreshRunning = false;
  }
}

async function refreshProjectMetrics() {
  if (projectMetricsRefreshRunning) {
    console.warn('[项目指标任务] 上一次任务仍在运行，本次已跳过');
    return;
  }
  if (!process.env.GITHUB_TOKEN) {
    console.warn('[项目指标任务] 未配置 GITHUB_TOKEN，本次已跳过');
    return;
  }

  projectMetricsRefreshRunning = true;
  const startedAt = Date.now();
  console.log('[项目指标任务] 开始采集基础指标、计算分类评分并导出');
  try {
    await runCommand(
      process.env.PYTHON_BIN || 'python3',
      [join(projectRoot, 'scripts/project_metrics.py'), 'run'],
      'GitHub 项目指标 '
    );
    console.log(`[项目指标任务] 完成，耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`);
  } catch (error) {
    console.error(`[项目指标任务] 失败：${error.message}`);
  } finally {
    projectMetricsRefreshRunning = false;
  }
}

async function refreshNews() {
  if (newsRefreshRunning) {
    console.warn('[新闻定时任务] 上一次任务仍在运行，本次已跳过');
    return;
  }

  newsRefreshRunning = true;
  const startedAt = Date.now();
  console.log('[新闻定时任务] 开始抓取 RSSHub 并处理待发布新闻');
  try {
    await runCommand(process.env.PYTHON_BIN || 'python3', [join(projectRoot, 'scripts/news_pipeline.py')], '新闻采集 ');
    console.log(`[新闻定时任务] 完成，耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`);
  } catch (error) {
    console.error(`[新闻定时任务] 失败：${error.message}`);
  } finally {
    newsRefreshRunning = false;
  }
}

function startNewsScheduler() {
  if (process.env.ENABLE_NEWS_SCHEDULER !== 'true') {
    console.log('[新闻定时任务] 未启用；设置 ENABLE_NEWS_SCHEDULER=true 后开启');
    return;
  }

  const expression = process.env.NEWS_REFRESH_CRON || '*/30 * * * *';
  const timezone = process.env.NEWS_REFRESH_TIMEZONE || 'Asia/Shanghai';
  if (!cron.validate(expression)) {
    console.error(`[新闻定时任务] Cron 表达式无效：${expression}`);
    return;
  }

  try {
    cron.schedule(expression, refreshNews, { timezone });
    console.log(`[新闻定时任务] 已启用：${expression}（${timezone}）`);
  } catch (error) {
    console.error(`[新闻定时任务] 启动失败：${error.message}`);
  }
}

function startProjectCategoryScheduler() {
  if (process.env.ENABLE_PROJECT_CATEGORY_SCHEDULER === 'false') {
    console.log('[项目分类任务] 已通过环境变量禁用');
    return;
  }
  if (!process.env.DEEPSEEK_API_KEY) {
    console.log('[项目分类任务] 未配置 DEEPSEEK_API_KEY，未启用');
    return;
  }

  const expression = process.env.PROJECT_CATEGORY_CRON || '30 10 * * *';
  const timezone = process.env.PROJECT_CATEGORY_TIMEZONE || 'Asia/Shanghai';
  if (!cron.validate(expression)) {
    console.error(`[项目分类任务] Cron 表达式无效：${expression}`);
    return;
  }

  try {
    cron.schedule(expression, refreshProjectCategories, { timezone });
    console.log(`[项目分类任务] 已启用：${expression}（${timezone}）`);
  } catch (error) {
    console.error(`[项目分类任务] 启动失败：${error.message}`);
  }
}

function startProjectImageScheduler() {
  if (process.env.ENABLE_PROJECT_IMAGE_SCHEDULER === 'false') {
    console.log('[项目图片任务] 已通过环境变量禁用');
    return;
  }

  const expression = process.env.PROJECT_IMAGE_CRON || '0 11 * * *';
  const timezone = process.env.PROJECT_IMAGE_TIMEZONE || 'Asia/Shanghai';
  if (!cron.validate(expression)) {
    console.error(`[项目图片任务] Cron 表达式无效：${expression}`);
    return;
  }

  try {
    cron.schedule(expression, refreshProjectImages, { timezone });
    console.log(`[项目图片任务] 已启用：${expression}（${timezone}）`);
  } catch (error) {
    console.error(`[项目图片任务] 启动失败：${error.message}`);
  }
}

function startProjectDataScheduler() {
  if (process.env.ENABLE_PROJECT_DATA_SCHEDULER === 'false') {
    console.log('[项目数据任务] 已通过环境变量禁用');
    return;
  }

  const expression = process.env.PROJECT_DATA_CRON || '0 10 * * *';
  const timezone = process.env.PROJECT_DATA_TIMEZONE || 'Asia/Shanghai';
  if (!cron.validate(expression)) {
    console.error(`[项目数据任务] Cron 表达式无效：${expression}`);
    return;
  }

  try {
    cron.schedule(expression, refreshProjectData, { timezone });
    console.log(`[项目数据任务] 已启用：${expression}（${timezone}）`);
  } catch (error) {
    console.error(`[项目数据任务] 启动失败：${error.message}`);
  }
}

function startProjectMetricsScheduler() {
  if (process.env.ENABLE_PROJECT_METRICS_SCHEDULER === 'false') {
    console.log('[项目指标任务] 已通过环境变量禁用');
    return;
  }
  if (!process.env.GITHUB_TOKEN) {
    console.log('[项目指标任务] 未配置 GITHUB_TOKEN，未启用');
    return;
  }

  const expression = process.env.PROJECT_METRICS_CRON || '30 11 * * *';
  const timezone = process.env.PROJECT_METRICS_TIMEZONE || 'Asia/Shanghai';
  if (!cron.validate(expression)) {
    console.error(`[项目指标任务] Cron 表达式无效：${expression}`);
    return;
  }

  try {
    cron.schedule(expression, refreshProjectMetrics, { timezone });
    console.log(`[项目指标任务] 已启用：${expression}（${timezone}）`);
  } catch (error) {
    console.error(`[项目指标任务] 启动失败：${error.message}`);
  }
}

function startVectorScheduler() {
  if (process.env.ENABLE_VECTOR_SCHEDULER === 'false') {
    console.log('[向量定时任务] 已通过环境变量禁用');
    return;
  }
  if (!vectorSearchConfigured()) {
    console.log('[向量定时任务] 向量服务配置不完整，未启用');
    return;
  }

  const expression = process.env.VECTOR_INDEX_CRON || '15 10 * * *';
  const timezone = process.env.VECTOR_INDEX_TIMEZONE || 'Asia/Shanghai';
  if (!cron.validate(expression)) {
    console.error(`[向量定时任务] Cron 表达式无效：${expression}`);
    return;
  }

  try {
    cron.schedule(expression, refreshVectorIndex, { timezone });
    console.log(`[向量定时任务] 已启用：${expression}（${timezone}）`);
  } catch (error) {
    console.error(`[向量定时任务] 启动失败：${error.message}`);
  }
}

await loadLocalEnvironment();
const clientId = process.env.GITHUB_CLIENT_ID || defaultClientId;
const callbackUrl = process.env.GITHUB_CALLBACK_URL || `http://localhost:${port}/auth/github/callback`;
const secureCookies = callbackUrl.startsWith('https://');
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || (isDevelopment ? 'http://127.0.0.1:7890' : '');
const githubDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;
const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.post('/api/search', async (request, response) => {
  if (!vectorSearchConfigured()) {
    return response.status(503).json({
      code: 'SEMANTIC_SEARCH_NOT_CONFIGURED',
      message: '语义搜索服务尚未配置'
    });
  }

  const now = Date.now();
  const clientKey = request.ip;
  const rate = searchRateLimits.get(clientKey);
  if (!rate || now - rate.startedAt >= 60_000) {
    searchRateLimits.set(clientKey, { startedAt: now, count: 1 });
  } else if (rate.count >= 20) {
    return response.status(429).json({ code: 'RATE_LIMITED', message: '搜索请求过于频繁' });
  } else {
    rate.count += 1;
  }

  const query = String(request.body?.query || '').trim();
  if (query.length < 2 || query.length > 300) {
    return response.status(400).json({ code: 'INVALID_QUERY', message: '搜索内容长度应为 2 至 300 个字符' });
  }

  const minStars = Math.max(0, Number(request.body?.minStars) || 0);
  const maxStars = Math.max(minStars, Number(request.body?.maxStars) || 500_000);
  const limit = Math.min(100, Math.max(1, Number(request.body?.limit) || 50));

  try {
    const projects = await searchProjects(query, {
      config: vectorSearchConfig(),
      dispatcher: githubDispatcher,
      minStars,
      maxStars,
      limit
    });
    response.set('Cache-Control', 'no-store');
    response.json({ projects, mode: 'semantic' });
  } catch (error) {
    console.error(`[语义搜索] ${error.message}`);
    response.status(502).json({ code: 'SEARCH_UNAVAILABLE', message: '语义搜索暂时不可用' });
  }
});

app.get('/api/me', (request, response) => {
  response.set('Cache-Control', 'no-store');
  response.json({ user: currentUser(request) });
});

app.post('/api/logout', (request, response) => {
  const requestOrigin = request.get('origin');
  const expectedOrigin = `${request.protocol}://${request.get('host')}`;
  if (requestOrigin && requestOrigin !== expectedOrigin) return response.sendStatus(403);

  const sessionId = parseCookies(request.headers.cookie).github_rank_session;
  if (sessionId) sessions.delete(sessionId);
  response.setHeader('Set-Cookie', cookie('github_rank_session', '', { maxAge: 0, secure: secureCookies }));
  response.sendStatus(204);
});

app.get('/auth/github', (request, response) => {
  if (!process.env.GITHUB_CLIENT_SECRET) {
    return response.status(503).send('GitHub OAuth 尚未配置：请在 .env.local 中设置 GITHUB_CLIENT_SECRET');
  }

  const state = crypto.randomBytes(24).toString('hex');
  response.setHeader('Set-Cookie', cookie('github_oauth_state', state, {
    maxAge: 600,
    secure: secureCookies
  }));
  const parameters = new URLSearchParams({
    client_id: clientId,
    redirect_uri: callbackUrl,
    scope: 'read:user',
    state
  });
  response.redirect(`https://github.com/login/oauth/authorize?${parameters}`);
});

app.get('/auth/github/callback', async (request, response) => {
  const cookies = parseCookies(request.headers.cookie);
  const state = String(request.query.state || '');
  const code = String(request.query.code || '');
  if (!code || !state || state !== cookies.github_oauth_state) {
    return response.redirect('/?auth_error=state');
  }

  try {
    const tokenResponse = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      dispatcher: githubDispatcher,
      body: JSON.stringify({
        client_id: clientId,
        client_secret: process.env.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: callbackUrl
      })
    });
    const tokenPayload = await tokenResponse.json();
    if (!tokenResponse.ok || !tokenPayload.access_token) {
      const reason = [tokenPayload.error, tokenPayload.error_description].filter(Boolean).join(': ');
      throw oauthFailure('token', `GitHub 令牌交换失败：${reason || `HTTP ${tokenResponse.status}`}`);
    }

    const userResponse = await fetch('https://api.github.com/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${tokenPayload.access_token}`,
        'User-Agent': 'github-daily-rank-dashboard',
        'X-GitHub-Api-Version': '2022-11-28'
      },
      dispatcher: githubDispatcher
    });
    if (!userResponse.ok) {
      throw oauthFailure('user', `GitHub 用户信息请求失败：HTTP ${userResponse.status}`);
    }
    const profile = await userResponse.json();
    const sessionId = crypto.randomBytes(32).toString('hex');
    sessions.set(sessionId, {
      expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000,
      user: {
        id: profile.id,
        login: profile.login,
        name: profile.name || profile.login,
        avatarUrl: profile.avatar_url,
        profileUrl: profile.html_url
      }
    });

    response.setHeader('Set-Cookie', [
      cookie('github_oauth_state', '', { maxAge: 0, secure: secureCookies }),
      cookie('github_rank_session', sessionId, {
        maxAge: 7 * 24 * 60 * 60,
        secure: secureCookies
      })
    ]);
    response.redirect('/');
  } catch (error) {
    console.error(`[GitHub OAuth] ${error.message}`);
    response.setHeader('Set-Cookie', cookie('github_oauth_state', '', {
      maxAge: 0,
      secure: secureCookies
    }));
    response.redirect(`/?auth_error=${error.oauthCode || 'github'}`);
  }
});

app.get('/data/news.json', (_request, response) => {
  response.set('Cache-Control', 'no-store');
  response.sendFile(join(projectRoot, 'public/data/news.json'));
});

app.get('/data/project-categories.json', (_request, response) => {
  response.set('Cache-Control', 'no-store');
  response.sendFile(join(projectRoot, 'public/data/project-categories.json'));
});

app.get('/data/project-scores.json', (_request, response) => {
  response.set('Cache-Control', 'no-store');
  response.sendFile(join(projectRoot, 'public/data/project-scores.json'));
});

app.get('/data/project-images.json', (_request, response) => {
  response.set('Cache-Control', 'no-store');
  response.sendFile(join(projectRoot, 'public/data/project-images.json'));
});

app.get('/data/project-images/:filename', (request, response) => {
  const filename = String(request.params.filename || '');
  if (!/^(?:[a-f0-9]{64}|_default)\.webp$/.test(filename)) return response.sendStatus(404);
  response.set('Cache-Control', 'public, max-age=2592000, immutable');
  response.sendFile(join(projectRoot, 'public/data/project-images', filename));
});

if (isDevelopment) {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  const distDirectory = join(projectRoot, 'dist');
  app.use(express.static(distDirectory, { index: false }));
  app.use((request, response, next) => {
    if (request.method !== 'GET' || !request.accepts('html')) return next();
    response.sendFile(join(distDirectory, 'index.html'));
  });
}

app.listen(port, () => {
  console.log(`GitHub Star 趋势榜已启动：http://localhost:${port}`);
  if (proxyUrl) console.log(`GitHub OAuth 网络代理：${proxyUrl}`);
  startProjectDataScheduler();
  startVectorScheduler();
  startNewsScheduler();
  startProjectCategoryScheduler();
  startProjectImageScheduler();
  startProjectMetricsScheduler();
});
