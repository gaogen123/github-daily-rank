import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// 与 enrich-descriptions.mjs / index-projects.mjs 保持一致：读取项目根目录的 .env.local。
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

// 模块加载时即读取 .env.local，确保下面的 FIRE 配置能拿到 key。
await loadLocalEnvironment();

const FIRE = {
  // 云端 API 默认地址；自托管时用 FIRECRAWL_API_URL 指向 http://localhost:3002
  baseUrl: process.env.FIRECRAWL_API_URL || 'https://api.firecrawl.dev',
  // 云端需要 API key（fc- 开头）；自托管（USE_DB_AUTHENTICATION=false）时可留空
  apiKey: process.env.FIRECRAWL_API_KEY || ''
};

const TRENDING_SCHEMA = {
  type: 'object',
  properties: {
    repositories: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          rank: { type: 'number', description: '榜单排名，从 1 开始' },
          fullName: { type: 'string', description: '仓库完整名，格式 owner/name' },
          url: { type: 'string', description: '仓库地址 https://github.com/owner/name' },
          description: { type: 'string', description: '项目描述，可为空字符串' },
          language: { type: 'string', description: '主要编程语言，可为空字符串' },
          totalStars: { type: 'string', description: '总 star 数（如 12.3k）' },
          starsToday: { type: 'string', description: '今日新增 star 数（如 1,234）' }
        },
        required: ['fullName', 'url']
      }
    }
  },
  required: ['repositories']
};

function usage() {
  console.error([
    '用法: node scripts/trending/crawl-trending.mjs [选项]',
    '',
    '选项:',
    '  --since <daily|weekly|monthly>  抓取时间范围，默认 daily',
    '  --markdown                     抓取原始 markdown（无需 LLM，适合自托管）',
    '  --out <path>                   结果写入文件，默认打印到 stdout',
    '',
    '环境变量（也可写入项目根目录 .env.local，脚本会自动读取）:',
    '  FIRECRAWL_API_KEY  Firecrawl 云端 API key（fc- 开头，https://firecrawl.dev 获取）',
    '  FIRECRAWL_API_URL  自托管地址，默认 https://api.firecrawl.dev'
  ].join('\n'));
}

function parseArgs(argv) {
  const options = { since: 'daily', markdown: false, out: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--since') options.since = argv[++index];
    else if (arg === '--markdown') options.markdown = true;
    else if (arg === '--out') options.out = argv[++index];
    else if (arg === '--help' || arg === '-h') { usage(); process.exit(0); }
    else { console.error(`未知参数: ${arg}`); usage(); process.exit(2); }
  }
  if (!['daily', 'weekly', 'monthly'].includes(options.since)) {
    console.error(`非法 --since: ${options.since}`);
    usage();
    process.exit(2);
  }
  return options;
}

function trendingUrl(since) {
  return `https://github.com/trending?since=${since}`;
}

async function firecrawlRequest(path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (FIRE.apiKey) headers.Authorization = `Bearer ${FIRE.apiKey}`;

  const response = await fetch(`${FIRE.baseUrl.replace(/\/$/, '')}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`Firecrawl 请求失败：HTTP ${response.status} ${detail.slice(0, 300)}`);
  }

  const payload = await response.json();
  if (!payload.success) {
    throw new Error(`Firecrawl 抓取失败：${payload.error || JSON.stringify(payload)}`);
  }
  return payload;
}

// 结构化提取：POST /v2/scrape + json 格式（LLM 按 schema 提取）
async function extractTrending({ since }) {
  const payload = await firecrawlRequest('/v2/scrape', {
    url: trendingUrl(since),
    formats: [
      {
        type: 'json',
        prompt: '提取 GitHub Trending 榜单中的所有仓库，包括排名、仓库名、地址、描述、语言、总 star 数与今日新增 star 数。',
        schema: TRENDING_SCHEMA
      }
    ],
    onlyMainContent: true,
    timeout: 60_000
  });
  return payload.data?.json ?? {};
}

// Markdown 抓取：POST /v2/scrape（无需 LLM，适合自托管）
async function scrapeTrendingMarkdown({ since }) {
  const payload = await firecrawlRequest('/v2/scrape', {
    url: trendingUrl(since),
    formats: ['markdown'],
    onlyMainContent: false,
    timeout: 60_000
  });
  return payload.data?.markdown ?? '';
}

function normalizeExtract(extract, since) {
  const repositories = extract?.repositories ?? [];
  return {
    source: 'github-trending',
    since,
    crawledAt: new Date().toISOString(),
    count: repositories.length,
    repositories: repositories.map((repo, index) => ({
      rank: repo.rank ?? index + 1,
      fullName: repo.fullName,
      url: repo.url,
      description: repo.description ?? '',
      language: repo.language ?? '',
      totalStars: repo.totalStars ?? '',
      starsToday: repo.starsToday ?? ''
    }))
  };
}

// 自托管（无 LLM）时的降级解析：从 markdown 里尽量提取仓库链接与描述。
function parseTrendingMarkdown(markdown, since) {
  const blocks = markdown.split(/^##\s+\[/m).slice(1);
  const repositories = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const head = lines[0]?.match(/\]\((https:\/\/github\.com\/([\w.-]+)\/([\w.-]+))\)/);
    if (!head) continue;

    const starLine = lines.find((line) => line.includes('/stargazers')) ?? '';
    const langMatch = starLine.match(/^\s*([^[\]]+)\[([\d,]+)\]\([^)]*?\/stargazers\)/);
    const starsMatch = block.match(/([\d,]+)\s+stars?\s+(today|this week|this month)/);

    const starIdx = lines.findIndex((line) => line.includes('/stargazers'));
    const description = lines
      .slice(1, starIdx < 0 ? lines.length : starIdx)
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ')
      .trim();

    repositories.push({
      rank: repositories.length + 1,
      fullName: `${head[2]}/${head[3]}`,
      url: head[1],
      description,
      language: langMatch ? (langMatch[1] ?? '').trim() : '',
      totalStars: langMatch?.[2] ?? '',
      starsToday: starsMatch?.[1] ?? ''
    });
  }
  return { source: 'github-trending', since, crawledAt: new Date().toISOString(), count: repositories.length, repositories };
}

export async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = options.markdown
    ? parseTrendingMarkdown(await scrapeTrendingMarkdown(options), options.since)
    : normalizeExtract(await extractTrending(options), options.since);

  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (options.out) {
    const target = resolve(options.out);
    await writeFile(target, json, 'utf8');
    console.log(`已写入 ${target}`);
  } else {
    process.stdout.write(json);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export { extractTrending, scrapeTrendingMarkdown, normalizeExtract, parseTrendingMarkdown, TRENDING_SCHEMA };
