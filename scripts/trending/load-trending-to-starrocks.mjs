import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scrapeTrendingMarkdown, parseTrendingMarkdown } from './crawl-trending.mjs';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// '25,845' -> 25845，'12.3k' -> 12300，'1.2m' -> 1200000，'🔺328' -> 328
function parseCompactNumber(value = '') {
  const normalized = String(value).trim().toLowerCase().replaceAll(',', '').replace(/[^ -~]/g, '');
  const matched = normalized.match(/([\d.]+)\s*([km]?)/);
  if (!matched) return 0;
  const multipliers = { '': 1, k: 1_000, m: 1_000_000 };
  return Math.round(Number(matched[1]) * multipliers[matched[2]]);
}

const STARROCKS = {
  // Stream Load 直接发到 BE HTTP 端口，避免 FE 307 重定向时丢失 Authorization 头
  http: process.env.STARROCKS_HTTP || 'http://localhost:8040',
  user: process.env.STARROCKS_USER || 'root',
  password: process.env.STARROCKS_PASSWORD || '',
  db: process.env.STARROCKS_DB || 'ods'
};

// --since 与目标表名的映射（STARROCKS_TABLE 环境变量可覆盖）
const SINCE_TO_TABLE = {
  daily: 'ods_crawl_day_github_trending_f_1d',
  weekly: 'ods_crawl_week_github_trending_f_1d',
  monthly: 'ods_crawl_mon_github_trending_f_1d'
};

function tableFor(since) {
  return process.env.STARROCKS_TABLE || SINCE_TO_TABLE[since] || SINCE_TO_TABLE.daily;
}

function usage() {
  console.error([
    '用法: node scripts/trending/load-trending-to-starrocks.mjs [选项]',
    '',
    '选项:',
    '  --since <daily|weekly|monthly>  抓取并加载的时间范围，默认 daily',
    '  --from-file <path>              不重新抓取，加载已有抓取结果的 JSON 文件',
    '  --dry-run                       只转换不写入，打印将要加载的行',
    '',
    '环境变量:',
    '  STARROCKS_HTTP      StarRocks BE HTTP 地址（Stream Load 端口），默认 http://localhost:8040',
    '  STARROCKS_USER     用户名，默认 root',
    '  STARROCKS_PASSWORD 密码，默认空',
    '  STARROCKS_DB       库名，默认 ods',
    '  STARROCKS_TABLE    表名，默认 ods_crawl_day_github_trending_f_1d',
    '  （FIRECRAWL_API_KEY 抓取时需要，自动读取 .env.local）'
  ].join('\n'));
}

function parseArgs(argv) {
  const options = { since: 'daily', fromFile: '', dryRun: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--since') options.since = argv[++index];
    else if (arg === '--from-file') options.fromFile = argv[++index];
    else if (arg === '--dry-run') options.dryRun = true;
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

// "2026-08-31T13:40:34.361Z" -> "2026-08-31 13:40:34"（StarRocks DATETIME 格式）
function toDatetime(iso) {
  return String(iso).replace('T', ' ').replace(/\.\d+(Z|[+-]\d{2}:\d{2})?$/, '').slice(0, 19);
}

// 把抓取结果转换为表结构对应的行数组（保持主键 upsert，不清除任何分区）。
function toStarRows(result) {
  const crawledAt = result.crawledAt || new Date().toISOString();
  const dt = crawledAt.slice(0, 10);
  return (result.repositories || []).map((repo) => ({
    dt,
    full_name: repo.fullName,
    rank_num: repo.rank,
    repo_url: repo.url,
    description: repo.description ?? '',
    language: repo.language ?? '',
    total_stars: parseCompactNumber(repo.totalStars),
    stars_today: parseCompactNumber(repo.starsToday),
    crawled_at: toDatetime(crawledAt)
  }));
}

async function streamLoad(rows, table) {
  const base = STARROCKS.http.replace(/\/$/, '');
  const url = `${base}/api/${STARROCKS.db}/${table}/_stream_load`;
  const auth = Buffer.from(`${STARROCKS.user}:${STARROCKS.password}`).toString('base64');
  const label = `trending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  const response = await fetch(url, {
    method: 'PUT',
    headers: {
      Authorization: `Basic ${auth}`,
      label,
      format: 'json',
      strip_outer_array: 'true',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(rows)
  });

  const result = await response.json().catch(() => ({}));
  if (!response.ok || result.Status !== 'Success') {
    throw new Error(`Stream Load 失败：HTTP ${response.status} ${JSON.stringify(result)}`);
  }
  return result;
}

async function obtainResult(options) {
  if (options.fromFile) {
    return JSON.parse(await readFile(resolve(options.fromFile), 'utf8'));
  }
  const markdown = await scrapeTrendingMarkdown({ since: options.since });
  return parseTrendingMarkdown(markdown, options.since);
}

export async function main() {
  const options = parseArgs(process.argv.slice(2));
  const result = await obtainResult(options);
  const rows = toStarRows(result);

  console.log(`抓取结果：${result.source} / since=${result.since} / 共 ${rows.length} 行，dt=${rows[0]?.dt ?? '-'}`);

  if (options.dryRun) {
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  if (!rows.length) {
    console.log('没有可加载的数据');
    return;
  }

  const loadResult = await streamLoad(rows, tableFor(options.since));
  console.log(`Stream Load 成功：Label=${loadResult.Label} ` +
    `总行数=${loadResult.NumberTotalRows} 加载=${loadResult.NumberLoadedRows} 过滤=${loadResult.NumberFilteredRows ?? 0}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

export { toStarRows, streamLoad, toDatetime, STARROCKS };
