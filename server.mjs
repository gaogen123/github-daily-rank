import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { ProxyAgent } from 'undici';
import { createRuntime } from './lib/runtime.mjs';

const projectRoot = dirname(fileURLToPath(import.meta.url));
const isDevelopment = process.argv.includes('--dev');
const port = Number(process.env.PORT) || 3000;

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

await loadLocalEnvironment();
const proxyUrl = process.env.HTTPS_PROXY || process.env.HTTP_PROXY || (isDevelopment ? 'http://127.0.0.1:7890' : '');
const githubDispatcher = proxyUrl ? new ProxyAgent(proxyUrl) : undefined;

const refresh = {
  runDailyRankIncremental: () => runPythonScript('scripts/rankings/load_daily_rank_incremental.py'),
  runGenerateData: () => runPythonScript('scripts/exports/generate_data_from_starrocks.py'),
  runIndexProjects: () => runNodeScript('scripts/projects/index-projects.mjs', ['--refresh'])
};

const { app, startScheduler } = createRuntime({
  environment: process.env,
  proxyUrl,
  dispatcher: githubDispatcher,
  refresh
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
  startScheduler();
});
