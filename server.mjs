import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import cron from 'node-cron';
import { ProxyAgent } from 'undici';
import {
  createSemanticProjectSearch,
  vectorSearchConfigured
} from './lib/vector-search.mjs';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const isDevelopment = process.argv.includes('--dev');
const port = Number(process.env.PORT) || 3000;
const defaultClientId = 'Iv23lipOXPUiR5ZQFSTr';
const sessions = new Map();
const searchRateLimits = new Map();
let vectorIndexRunning = false;

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

function runPythonScript(script, arguments_ = []) {
  return runCommand('python3', [join(projectRoot, script), ...arguments_], `${script} `);
}

async function refreshVectorIndex() {
  if (vectorIndexRunning) {
    console.warn('[向量定时任务] 上一次任务仍在运行，本次已跳过');
    return;
  }

  vectorIndexRunning = true;
  const startedAt = Date.now();
  console.log('[向量定时任务] 开始拉取远程更新并检测向量变化');
  try {
    // 连库版：增量更新日榜到 StarRocks，再重新生成前端数据与向量索引
    await runPythonScript('scripts/rankings/load_daily_rank_incremental.py');
    await runPythonScript('scripts/exports/generate_data_from_starrocks.py');
    await runNodeScript('scripts/projects/index-projects.mjs', ['--refresh']);
    console.log(`[向量定时任务] 完成，耗时 ${Math.round((Date.now() - startedAt) / 1000)} 秒`);
  } catch (error) {
    console.error(`[向量定时任务] 失败：${error.message}`);
  } finally {
    vectorIndexRunning = false;
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

  const expression = process.env.VECTOR_INDEX_CRON || '0 10 * * *';
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
const semanticProjectSearch = vectorSearchConfigured()
  ? createSemanticProjectSearch({ environment: process.env, proxyUrl, dispatcher: githubDispatcher })
  : null;
const app = express();
app.disable('x-powered-by');
app.use(express.json());

app.post('/api/search', async (request, response) => {
  if (!semanticProjectSearch) {
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
    const projects = await semanticProjectSearch.search(query, {
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

if (isDevelopment) {
  const { createServer } = await import('vite');
  const vite = await createServer({ server: { middlewareMode: true }, appType: 'spa' });
  app.use(vite.middlewares);
} else {
  const distDirectory = join(projectRoot, 'dist');
  const publicDataDirectory = join(projectRoot, 'public', 'data');
  // 榜单数据在运行时由 generate_data_from_starrocks.py 生成到 public/data，前端从这里读取
  app.use('/data', express.static(publicDataDirectory, { index: false }));
  app.use(express.static(distDirectory, { index: false }));
  app.use((request, response, next) => {
    if (request.method !== 'GET' || !request.accepts('html')) return next();
    response.sendFile(join(distDirectory, 'index.html'));
  });
}

app.listen(port, () => {
  console.log(`GitHub Star 趋势榜已启动：http://localhost:${port}`);
  if (proxyUrl) console.log(`GitHub OAuth 网络代理：${proxyUrl}`);
  startVectorScheduler();
});
