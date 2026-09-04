// PROTOTYPE ONLY — validates homepage first-fold screenshots and fallback behavior.
import { chromium, request } from 'playwright';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve4, resolve6 } from 'node:dns/promises';
import { join } from 'node:path';

const ROOT = new URL('../../', import.meta.url);
const OUTPUT = new URL('./output/', import.meta.url);
const CHROME = '/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome';
const repos = process.argv.slice(2).length ? process.argv.slice(2) : [
  'Significant-Gravitas/Auto-GPT',
  'All-Hands-AI/OpenHands',
  'microsoft/vscode',
  'AUTOMATIC1111/stable-diffusion-webui'
];

function loadEnv(content) {
  return Object.fromEntries(content.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    return match ? [[match[1], match[2].trim().replace(/^['"]|['"]$/g, '')]] : [];
  }));
}

function privateV4(address) {
  const [a, b] = address.split('.').map(Number);
  return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168);
}

async function isPublicUrl(value, cache) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || !['', '80', '443'].includes(url.port)) return false;
    if (cache.has(url.hostname)) return cache.get(url.hostname);
    const [v4, v6] = await Promise.all([
      resolve4(url.hostname).catch(() => []),
      resolve6(url.hostname).catch(() => [])
    ]);
    const safe = v4.length + v6.length > 0
      && v4.every((ip) => !privateV4(ip))
      && v6.every((ip) => ip !== '::1' && !ip.toLowerCase().startsWith('fc') && !ip.toLowerCase().startsWith('fd') && !ip.toLowerCase().startsWith('fe80'));
    cache.set(url.hostname, safe);
    return safe;
  } catch {
    return false;
  }
}

await mkdir(OUTPUT, { recursive: true });
const outputPath = OUTPUT.pathname;
const defaultImage = join(outputPath, 'default.svg');
await writeFile(defaultImage, `<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="720" viewBox="0 0 1440 720"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop stop-color="#eff4ff"/><stop offset="1" stop-color="#f8fafc"/></linearGradient></defs><rect width="1440" height="720" fill="url(#g)"/><circle cx="1220" cy="120" r="240" fill="#dbeafe" opacity=".7"/><text x="720" y="335" text-anchor="middle" font-family="Arial,sans-serif" font-size="54" font-weight="700" fill="#344054">Open Source AI Project</text><text x="720" y="400" text-anchor="middle" font-family="Arial,sans-serif" font-size="25" fill="#667085">Website preview unavailable</text></svg>`, 'utf8');

const env = loadEnv(await readFile(new URL('.env.local', ROOT), 'utf8'));
const proxy = env.HTTPS_PROXY || env.HTTP_PROXY;
const proxyOptions = proxy ? { proxy: { server: proxy } } : {};
const api = await request.newContext({
  ...proxyOptions,
  extraHTTPHeaders: {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(env.GITHUB_TOKEN ? { Authorization: `Bearer ${env.GITHUB_TOKEN}` } : {})
  }
});
const web = await request.newContext(proxyOptions);
const browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
const dnsCache = new Map();
const results = [];

for (const repo of repos) {
  const safeName = repo.replaceAll('/', '__');
  const screenshotPath = join(outputPath, `${safeName}.png`);
  let homepage = '';
  let source = 'default';
  let reason = '';

  try {
    const metadataResponse = await api.get(`https://api.github.com/repos/${repo}`);
    if (!metadataResponse.ok()) throw new Error(`GitHub API ${metadataResponse.status()}`);
    homepage = String((await metadataResponse.json()).homepage || '').trim();
  } catch (error) {
    reason = `metadata: ${error.message}`;
  }

  if (homepage && await isPublicUrl(homepage, dnsCache)) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 720 }, ...proxyOptions });
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      if (url.startsWith('data:') || url.startsWith('blob:') || await isPublicUrl(url, dnsCache)) await route.continue();
      else await route.abort('blockedbyclient');
    });
    const page = await context.newPage();
    try {
      const response = await page.goto(homepage, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      if (!response || response.status() >= 400) throw new Error(`homepage HTTP ${response?.status() || 'unknown'}`);
      await page.waitForTimeout(2_500);
      await page.screenshot({ path: screenshotPath, type: 'png', animations: 'disabled' });
      source = 'homepage-screenshot';
    } catch (error) {
      reason = `homepage: ${error.message}`;
    } finally {
      await context.close();
    }
  } else if (homepage) {
    reason = 'homepage URL rejected by public-network policy';
  } else if (!reason) {
    reason = 'repository has no homepage';
  }

  if (source !== 'homepage-screenshot') {
    try {
      const previewUrl = `https://opengraph.githubassets.com/website-screenshot-prototype/${repo}`;
      const previewResponse = await web.get(previewUrl, { timeout: 25_000 });
      if (!previewResponse.ok()) throw new Error(`OpenGraph HTTP ${previewResponse.status()}`);
      await writeFile(screenshotPath, await previewResponse.body());
      source = 'github-opengraph';
    } catch (error) {
      reason = `${reason}; preview: ${error.message}`;
      source = 'default';
    }
  }

  results.push({ repo, homepage: homepage || null, source, file: source === 'default' ? 'default.svg' : `${safeName}.png`, reason: source === 'homepage-screenshot' ? null : reason });
  console.log(`${repo}: ${source}${homepage ? ` (${homepage})` : ''}`);
}

await browser.close();
await api.dispose();
await web.dispose();
await writeFile(join(outputPath, 'report.json'), `${JSON.stringify({ viewport: '1440x720', fallbackOrder: ['homepage-screenshot', 'github-opengraph', 'default'], results }, null, 2)}\n`, 'utf8');
console.log(`Report: ${join(outputPath, 'report.json')}`);
