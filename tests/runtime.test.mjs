import test from 'node:test';
import assert from 'node:assert/strict';
import { createRuntime } from '../lib/runtime.mjs';

test('createRuntime 创建互不共享状态的运行实例', () => {
  const first = createRuntime({ environment: {} });
  const second = createRuntime({ environment: {} });

  assert.notEqual(first.sessions, second.sessions);
  assert.notEqual(first.searchRateLimits, second.searchRateLimits);
});

test('createRuntime 不监听端口也不启动 scheduler', () => {
  const runtime = createRuntime({ environment: {} });

  assert.equal(typeof runtime.app, 'function');
  assert.equal(typeof runtime.app.listen, 'function');
  assert.equal(runtime.app.listening, undefined);
});

test('通过 seam 完整验证 /api/me 基础请求', async () => {
  const runtime = createRuntime({ environment: {} });
  const server = runtime.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/me`);
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { user: null });

  await new Promise((resolve) => server.close(resolve));
});

test('未配置语义搜索时 /api/search 返回 503', async () => {
  const runtime = createRuntime({ environment: {}, semanticSearch: null });
  const server = runtime.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'agent tools' })
  });
  const body = await response.json();

  assert.equal(response.status, 503);
  assert.equal(body.code, 'SEMANTIC_SEARCH_NOT_CONFIGURED');

  await new Promise((resolve) => server.close(resolve));
});

test('搜索调用深化后的 semantic-index interface 并返回结果', async () => {
  const calls = [];
  const fakeSearch = {
    async search(query, options) {
      calls.push({ query, options });
      return [{ repo: 'acme/agent-tools', semanticScore: 0.91 }];
    }
  };
  const runtime = createRuntime({ environment: {}, semanticSearch: fakeSearch });
  const server = runtime.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'agent tools', minStars: 1000, maxStars: 9000, limit: 8 })
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.deepEqual(body, { projects: [{ repo: 'acme/agent-tools', semanticScore: 0.91 }], mode: 'semantic' });
  assert.deepEqual(calls, [{
    query: 'agent tools',
    options: { minStars: 1000, maxStars: 9000, limit: 8 }
  }]);

  await new Promise((resolve) => server.close(resolve));
});

test('搜索输入约束：查询过长返回 400', async () => {
  const runtime = createRuntime({ environment: {}, semanticSearch: { async search() { return []; } } });
  const server = runtime.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'x'.repeat(301) })
  });

  assert.equal(response.status, 400);

  await new Promise((resolve) => server.close(resolve));
});

test('搜索错误映射为稳定 502 响应', async () => {
  const fakeSearch = {
    async search() { throw new Error('provider detail'); }
  };
  const runtime = createRuntime({ environment: {}, semanticSearch: fakeSearch });
  const server = runtime.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'agent tools' })
  });
  const body = await response.json();

  assert.equal(response.status, 502);
  assert.equal(body.code, 'SEARCH_UNAVAILABLE');
  assert.equal(body.message, '语义搜索暂时不可用');

  await new Promise((resolve) => server.close(resolve));
});

test('每个客户端的限流使用固定时钟', async () => {
  const fakeSearch = { async search() { return []; } };
  const runtime = createRuntime({
    environment: {},
    semanticSearch: fakeSearch,
    now: () => 1_000_000
  });
  const server = runtime.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const post = () => fetch(`http://127.0.0.1:${port}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: 'agent tools' })
  });

  let limited = null;
  for (let index = 0; index < 21; index += 1) {
    const response = await post();
    if (response.status === 429) {
      limited = response.status;
      break;
    }
  }

  assert.equal(limited, 429);

  await new Promise((resolve) => server.close(resolve));
});

function cookieValue(header, name) {
  const match = header?.match(new RegExp(`(?:^|,?\\s*)${name}=([^;,]*)`));
  return match ? match[1] : null;
}

test('登录成功创建 session 并通过 /api/me 读取当前用户', async () => {
  const githubAdapter = {
    async exchangeToken() {
      return { ok: true, async json() { return { access_token: 'token-1' }; } };
    },
    async fetchUser() {
      return {
        ok: true,
        async json() {
          return { id: 1, login: 'octo', name: 'Octo', avatar_url: 'http://a', html_url: 'http://h' };
        }
      };
    }
  };
  const runtime = createRuntime({
    environment: { GITHUB_CLIENT_SECRET: 'secret' },
    githubAdapter,
    randomBytes: (size) => Buffer.alloc(size, 1)
  });
  const server = runtime.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  const stateResponse = await fetch(`${base}/auth/github`, { redirect: 'manual' });
  const stateHeader = stateResponse.headers.get('set-cookie') || '';
  const state = cookieValue(stateHeader, 'github_oauth_state');

  const callbackResponse = await fetch(`${base}/auth/github/callback?code=c&state=${state}`, {
    redirect: 'manual',
    headers: { cookie: `github_oauth_state=${state}` }
  });
  const sessionHeader = callbackResponse.headers.get('set-cookie') || '';
  const session = cookieValue(sessionHeader, 'github_rank_session');

  assert.equal(callbackResponse.status, 302);
  assert.equal(callbackResponse.headers.get('location'), '/');
  assert.ok(session);

  const meResponse = await fetch(`${base}/api/me`, {
    headers: { cookie: `github_rank_session=${session}` }
  });
  const me = await meResponse.json();
  assert.equal(me.user.login, 'octo');
  assert.equal(me.user.name, 'Octo');

  await new Promise((resolve) => server.close(resolve));
});

test('登录 state 缺失时跳转回 auth_error', async () => {
  const runtime = createRuntime({ environment: { GITHUB_CLIENT_SECRET: 'secret' } });
  const server = runtime.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/auth/github/callback?code=c`, {
    redirect: 'manual'
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/?auth_error=state');

  await new Promise((resolve) => server.close(resolve));
});

test('退出清除 session', async () => {
  const runtime = createRuntime({ environment: {} });
  runtime.sessions.set('session-1', {
    expiresAt: Date.now() + 1000,
    user: { login: 'octo' }
  });
  const server = runtime.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/logout`, {
    method: 'POST',
    headers: { cookie: 'github_rank_session=session-1' }
  });

  assert.equal(response.status, 204);
  assert.equal(runtime.sessions.has('session-1'), false);

  await new Promise((resolve) => server.close(resolve));
});

test('过期 session 通过 /api/me 读取为 null', async () => {
  const now = 1_000;
  const runtime = createRuntime({ environment: {}, now: () => now });
  runtime.sessions.set('expired', {
    expiresAt: now - 1,
    user: { login: 'octo' }
  });
  const server = runtime.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/api/me`, {
    headers: { cookie: 'github_rank_session=expired' }
  });
  const body = await response.json();

  assert.equal(body.user, null);
  assert.equal(runtime.sessions.has('expired'), false);

  await new Promise((resolve) => server.close(resolve));
});

test('provider 令牌失败不泄漏细节', async () => {
  const githubAdapter = {
    async exchangeToken() {
      return {
        ok: false,
        status: 400,
        async json() { return { error: 'bad_verification_code', error_description: 'secret detail' }; }
      };
    },
    async fetchUser() { throw new Error('should not be called'); }
  };
  const runtime = createRuntime({ environment: { GITHUB_CLIENT_SECRET: 'secret' }, githubAdapter });
  const server = runtime.app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();

  const response = await fetch(`http://127.0.0.1:${port}/auth/github/callback?code=c&state=s`, {
    redirect: 'manual',
    headers: { cookie: 'github_oauth_state=s' }
  });

  assert.equal(response.status, 302);
  assert.equal(response.headers.get('location'), '/?auth_error=token');

  await new Promise((resolve) => server.close(resolve));
});

test('refreshVectorIndex 按顺序执行三个刷新步骤', async () => {
  const order = [];
  const refresh = {
    runDailyRankIncremental: async () => { order.push('daily'); },
    runGenerateData: async () => { order.push('generate'); },
    runIndexProjects: async () => { order.push('index'); }
  };
  const runtime = createRuntime({ environment: {}, refresh });

  await runtime.refreshVectorIndex();

  assert.deepEqual(order, ['daily', 'generate', 'index']);
});

test('刷新进行中再次触发会跳过', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let dailyCalls = 0;
  const refresh = {
    runDailyRankIncremental: async () => { dailyCalls += 1; await gate; },
    runGenerateData: async () => {},
    runIndexProjects: async () => {}
  };
  const runtime = createRuntime({ environment: {}, refresh });

  const first = runtime.refreshVectorIndex();
  const second = runtime.refreshVectorIndex();
  release();
  await Promise.all([first, second]);

  assert.equal(dailyCalls, 1);
});

test('刷新失败后状态复位', async () => {
  let fail = true;
  let generateCalls = 0;
  const refresh = {
    runDailyRankIncremental: async () => { if (fail) throw new Error('boom'); },
    runGenerateData: async () => { generateCalls += 1; },
    runIndexProjects: async () => {}
  };
  const runtime = createRuntime({ environment: {}, refresh });

  await runtime.refreshVectorIndex();
  fail = false;
  await runtime.refreshVectorIndex();

  assert.equal(generateCalls, 1);
});

test('无效 cron 配置不调度', () => {
  let scheduled = false;
  const scheduler = {
    validate: () => false,
    schedule: () => { scheduled = true; }
  };
  const runtime = createRuntime({
    environment: {
      SILICONFLOW_API_KEY: 'k',
      QDRANT_URL: 'u',
      QDRANT_API_KEY: 'k',
      ENABLE_VECTOR_SCHEDULER: 'true',
      VECTOR_INDEX_CRON: 'invalid'
    },
    scheduler
  });

  runtime.startScheduler();

  assert.equal(scheduled, false);
});

test('有效 cron 配置调度刷新', () => {
  let scheduled = null;
  const scheduler = {
    validate: () => true,
    schedule: (expression, fn, options) => { scheduled = { expression, fn, options }; }
  };
  const runtime = createRuntime({
    environment: {
      SILICONFLOW_API_KEY: 'k',
      QDRANT_URL: 'u',
      QDRANT_API_KEY: 'k',
      ENABLE_VECTOR_SCHEDULER: 'true',
      VECTOR_INDEX_CRON: '0 1 * * *'
    },
    scheduler
  });

  runtime.startScheduler();

  assert.equal(scheduled.expression, '0 1 * * *');
  assert.equal(typeof scheduled.fn, 'function');
});
