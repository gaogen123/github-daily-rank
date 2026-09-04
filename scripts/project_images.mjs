import { createHash, randomUUID } from 'node:crypto';
import { access, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { isIP } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const DAY_MS = 86_400_000;

const DEFAULT_FILE = '_default.webp';
const DEFAULT_OPTIONS = Object.freeze({
  maxProcess: 20,
  all: false,
  concurrency: 2,
  quality: 72,
  refreshDays: 30,
  timeout: 25_000
});

function ipv4Number(address) {
  const parts = address.split('.').map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return null;
  return (((parts[0] * 256 + parts[1]) * 256 + parts[2]) * 256 + parts[3]) >>> 0;
}

function inIpv4Range(value, base, prefix) {
  const address = ipv4Number(value);
  const network = ipv4Number(base);
  if (address === null || network === null) return false;
  if (prefix === 0) return true;
  const mask = (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (network & mask);
}

function ipv6Bytes(address) {
  let input = address.toLowerCase().split('%')[0];
  if (input.includes('.')) {
    const lastColon = input.lastIndexOf(':');
    const ipv4 = ipv4Number(input.slice(lastColon + 1));
    if (ipv4 === null) return null;
    input = `${input.slice(0, lastColon)}:${((ipv4 >>> 16) & 0xffff).toString(16)}:${(ipv4 & 0xffff).toString(16)}`;
  }
  if ((input.match(/::/g) || []).length > 1) return null;
  const [left = '', right = ''] = input.split('::');
  const leftParts = left ? left.split(':') : [];
  const rightParts = right ? right.split(':') : [];
  const missing = 8 - leftParts.length - rightParts.length;
  if (missing < 0 || (!input.includes('::') && missing !== 0)) return null;
  const parts = [...leftParts, ...Array(missing).fill('0'), ...rightParts];
  if (parts.length !== 8 || parts.some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return null;
  return Uint8Array.from(parts.flatMap((part) => {
    const value = Number.parseInt(part, 16);
    return [value >>> 8, value & 0xff];
  }));
}

function bytesHavePrefix(bytes, prefix, bits) {
  const fullBytes = Math.floor(bits / 8);
  for (let index = 0; index < fullBytes; index += 1) {
    if (bytes[index] !== prefix[index]) return false;
  }
  const remaining = bits % 8;
  if (!remaining) return true;
  const mask = 0xff << (8 - remaining);
  return (bytes[fullBytes] & mask) === (prefix[fullBytes] & mask);
}

/** Returns true for addresses that must not be contacted by the image pipeline. */
export function isPrivateIp(address) {
  const version = isIP(address);
  if (version === 4) {
    return [
      ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
      ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
      ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
      ['224.0.0.0', 4], ['240.0.0.0', 4]
    ].some(([base, prefix]) => inIpv4Range(address, base, prefix));
  }
  if (version !== 6) return true;

  const bytes = ipv6Bytes(address);
  if (!bytes) return true;
  const mapped = bytes.slice(0, 12).every((byte, index) => byte === (index >= 10 ? 0xff : 0));
  if (mapped) return isPrivateIp(`${bytes[12]}.${bytes[13]}.${bytes[14]}.${bytes[15]}`);

  const blocked = [
    ['::', 128], ['::1', 128], ['100::', 64], ['2001:db8::', 32],
    ['fc00::', 7], ['fe80::', 10], ['fec0::', 10], ['ff00::', 8]
  ];
  return blocked.some(([base, bits]) => bytesHavePrefix(bytes, ipv6Bytes(base), bits));
}

function normalizeLookupResults(result) {
  const values = Array.isArray(result) ? result : [result];
  return values.map((entry) => typeof entry === 'string' ? entry : entry?.address).filter(Boolean);
}

/** Validates protocol, credentials, port, hostname, and every DNS answer. */
export async function validatePublicUrl(value, { lookup = dnsLookup } = {}) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error('URL 格式无效');
  }
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('URL 仅允许 http/https');
  if (url.username || url.password) throw new Error('URL 不允许包含凭据');
  const expectedPort = url.protocol === 'http:' ? '80' : '443';
  if ((url.port || expectedPort) !== expectedPort) throw new Error('URL 仅允许标准 80/443 端口');

  const hostname = url.hostname.replace(/\.$/, '').toLowerCase();
  if (!hostname || hostname === 'localhost' || hostname.endsWith('.localhost')) throw new Error('URL 主机不安全');
  const literal = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
  if (isIP(literal)) {
    if (isPrivateIp(literal)) throw new Error('URL 指向非公网 IP');
    return url;
  }

  let addresses;
  try {
    addresses = normalizeLookupResults(await lookup(hostname, { all: true, verbatim: true }));
  } catch {
    throw new Error('URL DNS 解析失败');
  }
  if (!addresses.length || addresses.some((address) => !isIP(address) || isPrivateIp(address))) {
    throw new Error('URL DNS 未全部解析到公网 IP');
  }
  return url;
}

export function stableImageFilename(repo) {
  return `${createHash('sha256').update(String(repo)).digest('hex')}.webp`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function projectFingerprint(project) {
  const identity = {
    repo: project?.repo || '',
    name: project?.name || '',
    description: project?.description || '',
    url: project?.url || ''
  };
  return createHash('sha256').update(JSON.stringify(canonicalize(identity))).digest('hex');
}

export function shouldProcessProject(project, cached, {
  now = Date.now(), refreshDays = 30, force = false, fileExists = true, failureRetryDays = 1
} = {}) {
  if (force || !cached || !fileExists) return true;
  if (cached.fingerprint !== projectFingerprint(project)) return true;
  const capturedAt = Date.parse(cached.captured_at || '');
  if (!Number.isFinite(capturedAt)) return true;
  const days = cached.source === 'default' || cached.metadata_error ? failureRetryDays : refreshDays;
  return now - capturedAt >= days * DAY_MS;
}

function cacheEntries(cache) {
  return cache?.projects && typeof cache.projects === 'object' ? cache.projects : (cache || {});
}

export function buildManifest(projects, cache, generatedAt = new Date().toISOString()) {
  const entries = cacheEntries(cache);
  const images = {};
  for (const project of projects) {
    const item = entries[project.repo];
    if (!item?.file) continue;
    images[project.repo] = {
      url: `/data/project-images/${item.file}`,
      source: item.source,
      homepage: item.homepage || '',
      updated_at: item.captured_at
    };
  }
  return { version: 1, generated_at: generatedAt, count: Object.keys(images).length, images };
}

export async function atomicWriteJson(path, value, io = {}) {
  const makeDirectory = io.mkdir || mkdir;
  const write = io.writeFile || writeFile;
  const move = io.rename || rename;
  await makeDirectory(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await write(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await move(temporary, path);
  } catch (error) {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(temporary);
    } catch {}
    throw error;
  }
}

export function parseCliArguments(argv) {
  const options = { ...DEFAULT_OPTIONS };
  const names = new Map([
    ['--max-process', 'maxProcess'], ['--concurrency', 'concurrency'], ['--quality', 'quality'],
    ['--refresh-days', 'refreshDays'], ['--timeout', 'timeout']
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--all') {
      options.all = true;
      continue;
    }
    const [flag, inline] = argument.split('=', 2);
    const name = names.get(flag);
    if (!name) throw new Error(`未知参数：${argument}`);
    const raw = inline ?? argv[++index];
    if (raw === undefined || raw.startsWith('--')) throw new Error(`${flag} 缺少数值`);
    const value = Number(raw);
    if (!Number.isFinite(value)) throw new Error(`${flag} 必须是数字`);
    options[name] = value;
  }
  if (!Number.isInteger(options.maxProcess) || options.maxProcess < 0) throw new Error('--max-process 必须是非负整数');
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1) throw new Error('--concurrency 必须是正整数');
  if (!Number.isInteger(options.quality) || options.quality < 1 || options.quality > 100) throw new Error('--quality 必须是 1-100 的整数');
  if (options.refreshDays < 0) throw new Error('--refresh-days 不能为负数');
  if (!Number.isInteger(options.timeout) || options.timeout < 1) throw new Error('--timeout 必须是正整数毫秒数');
  return options;
}

async function loadLocalEnvironment(root) {
  try {
    const content = await readFile(join(root, '.env.local'), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      if (!match || process.env[match[1]]) continue;
      process.env[match[1]] = match[2].replace(/^(['"])(.*)\1$/, '$2');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw new Error(`无法读取 JSON ${path}：${error.message}`);
  }
}

async function fileIsReadable(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function findChromiumExecutable() {
  if (process.env.PLAYWRIGHT_CHROME_PATH) {
    await access(process.env.PLAYWRIGHT_CHROME_PATH, fsConstants.X_OK);
    return process.env.PLAYWRIGHT_CHROME_PATH;
  }
  const base = '/root/.cache/ms-playwright';
  let names = [];
  try {
    names = await readdir(base);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  names.sort().reverse();
  for (const name of names.filter((entry) => entry.startsWith('chromium-'))) {
    const candidate = join(base, name, 'chrome-linux64', 'chrome');
    try {
      await access(candidate, fsConstants.X_OK);
      return candidate;
    } catch {}
  }
  return undefined;
}

function proxyOptions(proxyValue) {
  if (!proxyValue) return undefined;
  const proxy = new URL(proxyValue);
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('HTTPS_PROXY 仅支持 http/https 代理');
  return {
    server: `${proxy.protocol}//${proxy.host}`,
    ...(proxy.username ? { username: decodeURIComponent(proxy.username) } : {}),
    ...(proxy.password ? { password: decodeURIComponent(proxy.password) } : {})
  };
}

async function createFetchDispatcher(proxyValue) {
  if (!proxyValue) return undefined;
  const { ProxyAgent } = await import('undici');
  return new ProxyAgent(proxyValue);
}

async function fetchWithTimeout(url, options, timeout) {
  return fetch(url, { ...options, signal: AbortSignal.timeout(timeout) });
}

function inputRepositoryMetadata(project) {
  return {
    homepage: typeof project?.homepage === 'string' ? project.homepage.trim() : '',
    description: typeof project?.description === 'string' ? project.description.trim() : '',
    stargazers_count: Number(project?.stargazers_count ?? project?.stars) || 0,
    forks_count: Number(project?.forks_count ?? project?.forks) || 0,
    language: typeof project?.language === 'string' ? project.language.trim() : ''
  };
}

async function githubRepositoryMetadata(repo, { token, dispatcher, timeout }) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error('仓库名称无效');
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'github-daily-rank-project-images',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetchWithTimeout(`https://api.github.com/repos/${repo}`, {
    headers, redirect: 'error', ...(dispatcher ? { dispatcher } : {})
  }, timeout);
  if (!response.ok) throw new Error(`GitHub API HTTP ${response.status}`);
  const payload = await response.json();
  return {
    homepage: typeof payload.homepage === 'string' ? payload.homepage.trim() : '',
    description: typeof payload.description === 'string' ? payload.description.trim() : '',
    stargazers_count: Number(payload.stargazers_count) || 0,
    forks_count: Number(payload.forks_count) || 0,
    language: typeof payload.language === 'string' ? payload.language.trim() : ''
  };
}

function truncateText(value, maximum) {
  const characters = Array.from(String(value || '').replace(/\s+/g, ' ').trim());
  return characters.length <= maximum ? characters.join('') : `${characters.slice(0, maximum - 1).join('')}…`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function formatCount(value) {
  const digits = String(Math.max(0, Math.trunc(Number(value) || 0)));
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

export function repositoryPreviewSvg({ repo, description, stargazers_count, forks_count, language } = {}) {
  const safeRepo = escapeXml(truncateText(repo || 'Unknown repository', 54));
  const shortenedDescription = truncateText(description || 'No description available.', 132);
  const descriptionCharacters = Array.from(shortenedDescription);
  const firstLine = escapeXml(descriptionCharacters.slice(0, 66).join(''));
  const secondLine = escapeXml(descriptionCharacters.slice(66).join(''));
  const safeLanguage = escapeXml(truncateText(language || 'Not specified', 28));
  const stars = escapeXml(formatCount(stargazers_count));
  const forks = escapeXml(formatCount(forks_count));
  return `<svg width="1200" height="600" viewBox="0 0 1200 600" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="background" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#0d1117"/><stop offset="1" stop-color="#161b22"/></linearGradient></defs><rect width="1200" height="600" rx="28" fill="url(#background)"/><rect x="54" y="50" width="1092" height="500" rx="20" fill="#0d1117" stroke="#30363d" stroke-width="2"/><circle cx="96" cy="96" r="15" fill="#238636"/><text x="126" y="108" fill="#8b949e" font-family="Arial,sans-serif" font-size="26">Repository Preview</text><text x="92" y="196" fill="#58a6ff" font-family="Arial,sans-serif" font-size="48" font-weight="700">${safeRepo}</text><text x="92" y="274" fill="#c9d1d9" font-family="Arial,sans-serif" font-size="29">${firstLine}</text>${secondLine ? `<text x="92" y="318" fill="#c9d1d9" font-family="Arial,sans-serif" font-size="29">${secondLine}</text>` : ''}<line x1="92" y1="374" x2="1108" y2="374" stroke="#21262d" stroke-width="2"/><circle cx="106" cy="427" r="10" fill="#a371f7"/><text x="130" y="437" fill="#c9d1d9" font-family="Arial,sans-serif" font-size="27">${safeLanguage}</text><text x="490" y="437" fill="#e3b341" font-family="Arial,sans-serif" font-size="27">★ ${stars} Star</text><text x="790" y="437" fill="#8b949e" font-family="Arial,sans-serif" font-size="27">⑂ ${forks} Fork</text><text x="92" y="505" fill="#6e7681" font-family="Arial,sans-serif" font-size="22">Locally generated project summary · Not an official GitHub image</text></svg>`;
}

function defaultSvg() {
  return Buffer.from(`<svg width="1200" height="600" xmlns="http://www.w3.org/2000/svg"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#111827"/><stop offset="1" stop-color="#334155"/></linearGradient></defs><rect width="1200" height="600" fill="url(#g)"/><g fill="none" stroke="#94a3b8" stroke-width="18"><path d="M520 365c-70 48-132-15-101-77l45-79c25-44 91-44 116 0l20 35"/><path d="M680 365c70 48 132-15 101-77l-45-79c-25-44-91-44-116 0l-20 35"/></g><text x="600" y="465" text-anchor="middle" fill="#e2e8f0" font-family="Arial,sans-serif" font-size="42">GitHub Project</text></svg>`);
}

async function writeWebp(sharp, input, destination, quality) {
  await mkdir(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await sharp(input).resize(1200, 600, { fit: 'cover', position: 'centre' }).webp({ quality }).toFile(temporary);
    await rename(temporary, destination);
  } catch (error) {
    try {
      const { unlink } = await import('node:fs/promises');
      await unlink(temporary);
    } catch {}
    throw error;
  }
}

async function ensureDefaultImage(sharp, imageDirectory, quality) {
  const path = join(imageDirectory, DEFAULT_FILE);
  if (!(await fileIsReadable(path))) await writeWebp(sharp, defaultSvg(), path, quality);
}

function createDnsValidator(lookup) {
  const resolutions = new Map();
  return async (value) => {
    let hostname;
    try {
      hostname = new URL(value).hostname.toLowerCase();
    } catch {
      throw new Error('网络请求 URL 无效');
    }
    const cachedLookup = async (host, options) => {
      if (!resolutions.has(host)) resolutions.set(host, Promise.resolve(lookup(host, options)));
      return resolutions.get(host);
    };
    return validatePublicUrl(value, { lookup: cachedLookup });
  };
}

async function createBrowser(playwright, timeout) {
  const executablePath = await findChromiumExecutable();
  const proxy = proxyOptions(process.env.HTTPS_PROXY || process.env.https_proxy);
  return playwright.chromium.launch({
    headless: true,
    ...(executablePath ? { executablePath } : {}),
    ...(proxy ? { proxy } : {}),
    args: ['--disable-quic']
  });
}

async function captureHomepage(browser, homepage, { timeout, lookup = dnsLookup }) {
  const validate = createDnsValidator(lookup);
  const safeHomepage = await validate(homepage);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 720 },
    screen: { width: 1440, height: 720 },
    deviceScaleFactor: 1,
    serviceWorkers: 'block',
    ignoreHTTPSErrors: false
  });
  const page = await context.newPage();
  page.setDefaultTimeout(timeout);
  await page.route('**/*', async (route) => {
    try {
      await validate(route.request().url());
      await route.continue();
    } catch {
      await route.abort('blockedbyclient');
    }
  });
  try {
    const response = await page.goto(safeHomepage.href, { waitUntil: 'domcontentloaded', timeout });
    if (!response || response.status() >= 400) throw new Error(`官网 HTTP ${response?.status() ?? '无响应'}`);
    await validate(page.url());
    await page.waitForTimeout(2_500);
    return await page.screenshot({ type: 'png', fullPage: false, animations: 'disabled' });
  } finally {
    await context.close();
  }
}

async function mapConcurrent(items, concurrency, worker) {
  let next = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      await worker(items[index], index);
    }
  });
  await Promise.all(runners);
}

function shortError(error) {
  return String(error?.message || error || '未知错误').replace(/\s+/g, ' ').slice(0, 500);
}

async function main() {
  const options = parseCliArguments(process.argv.slice(2));
  const paths = {
    input: join(PROJECT_ROOT, 'public', 'data', 'projects.json'),
    cache: join(PROJECT_ROOT, 'storage', 'project-images.json'),
    images: join(PROJECT_ROOT, 'public', 'data', 'project-images'),
    manifest: join(PROJECT_ROOT, 'public', 'data', 'project-images.json')
  };
  const input = await readJson(paths.input);
  if (!Array.isArray(input?.projects)) throw new Error('projects.json 缺少 projects 数组');
  const projects = input.projects.filter((project) => project && typeof project.repo === 'string');
  const loadedCache = await readJson(paths.cache, { version: 1, projects: {} });
  const cache = { version: 1, projects: { ...cacheEntries(loadedCache) } };

  if (options.maxProcess === 0) {
    const manifest = buildManifest(projects, cache);
    await atomicWriteJson(paths.manifest, manifest);
    console.log(JSON.stringify({ total: projects.length, pending: 0, processed: 0, captured: 0, preview: 0, default: 0, failed: 0, exported: manifest.count }));
    return;
  }

  await loadLocalEnvironment(PROJECT_ROOT);
  const [{ chromium }, sharpModule] = await Promise.all([import('playwright'), import('sharp')]);
  const sharp = sharpModule.default;
  await ensureDefaultImage(sharp, paths.images, options.quality);
  const dispatcher = await createFetchDispatcher(process.env.HTTPS_PROXY || process.env.https_proxy);

  const candidateStates = await Promise.all(projects.map(async (project) => {
    const cached = cache.projects[project.repo];
    const fileExists = Boolean(cached?.file) && await fileIsReadable(join(paths.images, cached.file));
    return { project, pending: shouldProcessProject(project, cached, {
      refreshDays: options.refreshDays, force: options.all, fileExists
    }) };
  }));
  const allPending = candidateStates.filter((entry) => entry.pending).map((entry) => entry.project);
  const pending = options.all ? allPending : allPending.slice(0, options.maxProcess);
  const summary = { total: projects.length, pending: allPending.length, processed: 0, captured: 0, preview: 0, default: 0, failed: 0, exported: 0 };
  let browserPromise;
  let checkpointCount = 0;
  let checkpointPromise = Promise.resolve();
  const getBrowser = () => {
    if (!browserPromise) browserPromise = createBrowser({ chromium }, options.timeout);
    return browserPromise;
  };
  const checkpoint = async () => {
    checkpointCount += 1;
    if (checkpointCount % 10 !== 0) return;
    checkpointPromise = checkpointPromise.then(() => atomicWriteJson(paths.cache, cache));
    await checkpointPromise;
  };

  await mapConcurrent(pending, options.concurrency, async (project, index) => {
    const errors = [];
    let metadata = inputRepositoryMetadata(project);
    let metadataError = false;
    let homepage = metadata.homepage;
    let source = 'default';
    let file = DEFAULT_FILE;
    const destinationFile = stableImageFilename(project.repo);
    const destination = join(paths.images, destinationFile);
    try {
      try {
        const apiMetadata = await githubRepositoryMetadata(project.repo, {
          token: process.env.GITHUB_TOKEN,
          dispatcher,
          timeout: options.timeout
        });
        metadata = {
          homepage: apiMetadata.homepage || metadata.homepage,
          description: apiMetadata.description || metadata.description,
          stargazers_count: apiMetadata.stargazers_count || metadata.stargazers_count,
          forks_count: apiMetadata.forks_count || metadata.forks_count,
          language: apiMetadata.language || metadata.language
        };
        homepage = metadata.homepage;
      } catch (error) {
        metadataError = true;
        errors.push(shortError(error));
      }

      if (homepage) {
        try {
          const screenshot = await captureHomepage(await getBrowser(), homepage, { timeout: options.timeout });
          await writeWebp(sharp, screenshot, destination, options.quality);
          source = 'homepage';
          file = destinationFile;
        } catch (error) {
          errors.push(shortError(error));
        }
      } else {
        errors.push('仓库未提供可用官网');
      }

      if (source === 'default') {
        try {
          const preview = repositoryPreviewSvg({ repo: project.repo, ...metadata });
          await writeWebp(sharp, Buffer.from(preview), destination, options.quality);
          source = 'github-preview';
          file = destinationFile;
        } catch (error) {
          errors.push(shortError(error));
        }
      }

      const capturedAt = new Date().toISOString();
      cache.projects[project.repo] = {
        repo: project.repo,
        fingerprint: projectFingerprint(project),
        homepage,
        source,
        file,
        captured_at: capturedAt,
        metadata_error: metadataError,
        error: errors.length ? errors.join('; ').slice(0, 1000) : ''
      };
      summary.processed += 1;
      if (source === 'homepage') summary.captured += 1;
      else if (source === 'github-preview') summary.preview += 1;
      else {
        summary.default += 1;
        summary.failed += 1;
      }
      console.error(`[${index + 1}/${pending.length}] ${project.repo}: ${source}`);
    } catch (error) {
      summary.processed += 1;
      summary.failed += 1;
      summary.default += 1;
      cache.projects[project.repo] = {
        repo: project.repo,
        fingerprint: projectFingerprint(project),
        homepage,
        source: 'default',
        file: DEFAULT_FILE,
        captured_at: new Date().toISOString(),
        metadata_error: metadataError,
        error: [...errors, shortError(error)].join('; ').slice(0, 1000)
      };
      console.error(`[${index + 1}/${pending.length}] ${project.repo}: default`);
    }
    await checkpoint();
  });

  await checkpointPromise;
  if (browserPromise) {
    try {
      const browser = await browserPromise;
      await browser.close();
    } catch {}
  }
  if (dispatcher?.close) await dispatcher.close();
  await atomicWriteJson(paths.cache, cache);
  const manifest = buildManifest(projects, cache);
  await atomicWriteJson(paths.manifest, manifest);
  summary.exported = manifest.count;
  console.log(JSON.stringify(summary));
}

const isEntrypoint = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntrypoint) {
  main().catch((error) => {
    console.error(JSON.stringify({ error: shortError(error) }));
    process.exitCode = 1;
  });
}
