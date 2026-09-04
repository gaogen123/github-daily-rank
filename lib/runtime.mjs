import crypto from 'node:crypto';
import express from 'express';
import cron from 'node-cron';
import { createSemanticProjectSearch, vectorSearchConfigured } from './vector-search.mjs';

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

function defaultGithubAdapter({ dispatcher }) {
  return {
    async exchangeToken({ code, clientId, clientSecret, redirectUri }) {
      return fetch('https://github.com/login/oauth/access_token', {
        method: 'POST',
        headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
        dispatcher,
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          redirect_uri: redirectUri
        })
      });
    },
    async fetchUser({ accessToken }) {
      return fetch('https://api.github.com/user', {
        headers: {
          Accept: 'application/vnd.github+json',
          Authorization: `Bearer ${accessToken}`,
          'User-Agent': 'github-daily-rank-dashboard',
          'X-GitHub-Api-Version': '2022-11-28'
        },
        dispatcher
      });
    }
  };
}

export function createRuntime({
  environment = process.env,
  now = Date.now,
  randomBytes = crypto.randomBytes,
  dispatcher,
  semanticSearch,
  githubAdapter,
  refresh = {
    async runDailyRankIncremental() {},
    async runGenerateData() {},
    async runIndexProjects() {}
  },
  scheduler = { validate: cron.validate, schedule: cron.schedule },
  proxyUrl = environment.HTTPS_PROXY || environment.HTTP_PROXY || '',
  defaultClientId = 'Iv23lipOXPUiR5ZQFSTr'
} = {}) {
  const sessions = new Map();
  const searchRateLimits = new Map();

  const clientId = environment.GITHUB_CLIENT_ID || defaultClientId;
  const callbackUrl = environment.GITHUB_CALLBACK_URL || `http://localhost:${Number(environment.PORT) || 3000}/auth/github/callback`;
  const secureCookies = callbackUrl.startsWith('https://');

  const search = semanticSearch ?? (vectorSearchConfigured(environment)
    ? createSemanticProjectSearch({ environment, proxyUrl, dispatcher })
    : null);

  const github = githubAdapter ?? defaultGithubAdapter({ dispatcher });

  function currentUser(request) {
    const sessionId = parseCookies(request.headers.cookie).github_rank_session;
    const session = sessions.get(sessionId);
    if (!session) return null;
    if (session.expiresAt < now()) {
      sessions.delete(sessionId);
      return null;
    }
    return session.user;
  }

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  app.post('/api/search', async (request, response) => {
    if (!search) {
      return response.status(503).json({
        code: 'SEMANTIC_SEARCH_NOT_CONFIGURED',
        message: '语义搜索服务尚未配置'
      });
    }

    const clientKey = request.ip;
    const rate = searchRateLimits.get(clientKey);
    const timestamp = now();
    if (!rate || timestamp - rate.startedAt >= 60_000) {
      searchRateLimits.set(clientKey, { startedAt: timestamp, count: 1 });
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
      const projects = await search.search(query, { minStars, maxStars, limit });
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
    if (!environment.GITHUB_CLIENT_SECRET) {
      return response.status(503).send('GitHub OAuth 尚未配置：请在 .env.local 中设置 GITHUB_CLIENT_SECRET');
    }

    const state = randomBytes(24).toString('hex');
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
      const tokenResponse = await github.exchangeToken({
        code,
        clientId,
        clientSecret: environment.GITHUB_CLIENT_SECRET,
        redirectUri: callbackUrl
      });
      const tokenPayload = await tokenResponse.json();
      if (!tokenResponse.ok || !tokenPayload.access_token) {
        const reason = [tokenPayload.error, tokenPayload.error_description].filter(Boolean).join(': ');
        throw oauthFailure('token', `GitHub 令牌交换失败：${reason || `HTTP ${tokenResponse.status}`}`);
      }

      const userResponse = await github.fetchUser({ accessToken: tokenPayload.access_token });
      if (!userResponse.ok) {
        throw oauthFailure('user', `GitHub 用户信息请求失败：HTTP ${userResponse.status}`);
      }
      const profile = await userResponse.json();
      const sessionId = randomBytes(32).toString('hex');
      sessions.set(sessionId, {
        expiresAt: now() + 7 * 24 * 60 * 60 * 1000,
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

  let vectorIndexRunning = false;

  async function refreshVectorIndex() {
    if (vectorIndexRunning) {
      console.warn('[向量定时任务] 上一次任务仍在运行，本次已跳过');
      return;
    }

    vectorIndexRunning = true;
    const startedAt = now();
    console.log('[向量定时任务] 开始拉取远程更新并检测向量变化');
    try {
      await refresh.runDailyRankIncremental();
      await refresh.runGenerateData();
      await refresh.runIndexProjects();
      console.log(`[向量定时任务] 完成，耗时 ${Math.round((now() - startedAt) / 1000)} 秒`);
    } catch (error) {
      console.error(`[向量定时任务] 失败：${error.message}`);
    } finally {
      vectorIndexRunning = false;
    }
  }

  function startScheduler() {
    if (environment.ENABLE_VECTOR_SCHEDULER === 'false') {
      console.log('[向量定时任务] 已通过环境变量禁用');
      return;
    }
    if (!vectorSearchConfigured(environment)) {
      console.log('[向量定时任务] 向量服务配置不完整，未启用');
      return;
    }

    const expression = environment.VECTOR_INDEX_CRON || '0 10 * * *';
    const timezone = environment.VECTOR_INDEX_TIMEZONE || 'Asia/Shanghai';
    if (!scheduler.validate(expression)) {
      console.error(`[向量定时任务] Cron 表达式无效：${expression}`);
      return;
    }

    try {
      scheduler.schedule(expression, refreshVectorIndex, { timezone });
      console.log(`[向量定时任务] 已启用：${expression}（${timezone}）`);
    } catch (error) {
      console.error(`[向量定时任务] 启动失败：${error.message}`);
    }
  }

  return { app, sessions, searchRateLimits, semanticSearch: search, refreshVectorIndex, startScheduler };
}
