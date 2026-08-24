import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findReports, parseReport } from './generate-data.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const cachePath = join(projectRoot, 'public', 'data', 'descriptions.json');
const requestedDate = process.argv.find((argument) => argument.startsWith('--date='))?.split('=')[1];
const requestedMonth = process.argv.find((argument) => argument.startsWith('--month='))?.split('=')[1];

async function loadLocalEnvironment() {
  try {
    const content = await readFile(join(projectRoot, '.env.local'), 'utf8');
    for (const line of content.split(/\r?\n/)) {
      const matched = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!matched || process.env[matched[1]]) continue;
      process.env[matched[1]] = matched[2].replace(/^['"]|['"]$/g, '');
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

async function readCache() {
  try {
    return JSON.parse(await readFile(cachePath, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return {};
    throw error;
  }
}

function containsChinese(value) {
  return /[\u3400-\u9fff]/u.test(value);
}

async function fetchReadme(repo) {
  const rawResponse = await fetch(`https://raw.githubusercontent.com/${repo}/HEAD/README.md`);
  if (rawResponse.ok) return (await rawResponse.text()).slice(0, 12_000);

  const headers = {
    Accept: 'application/vnd.github.raw+json',
    'User-Agent': 'github-daily-rank-dashboard'
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const response = await fetch(`https://api.github.com/repos/${repo}/readme`, { headers });
  if (response.ok) return (await response.text()).slice(0, 12_000);
  if (response.status !== 404) throw new Error(`GitHub README 请求失败（${repo}）：HTTP ${response.status}`);

  const metadataResponse = await fetch(`https://api.github.com/repos/${repo}`, { headers });
  if (!metadataResponse.ok) return '';
  return (await metadataResponse.json()).description?.trim() ?? '';
}

async function askDeepSeek({ repo, description, readme }) {
  const hasDescription = Boolean(description);
  const source = hasDescription ? description : readme;
  const task = !hasDescription
    ? '根据 README 或仓库简介，用一句话说明它是什么工具、平台、框架或资源。'
    : containsChinese(description)
      ? '将现有中文描述压缩为一句话，只说明它是什么。'
      : '将英文描述准确翻译为一句简短中文，只说明它是什么。';

  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.DEEPSEEK_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: process.env.DEEPSEEK_MODEL || 'deepseek-chat',
      temperature: 0.1,
      max_tokens: 80,
      messages: [
        {
          role: 'system',
          content: '你是开源项目编辑。只输出一句简体中文名词性描述，控制在12至30个汉字内，直接说明它是什么，例如“Cursor插件规范及官方插件”“本地多智能体测试框架”。不写功能清单，不使用“该项目”“这是一个”等空泛开头，不使用Markdown，不编造信息。'
        },
        {
          role: 'user',
          content: `仓库：${repo}\n任务：${task}\n内容：\n${source}`
        }
      ]
    })
  });

  if (!response.ok) throw new Error(`DeepSeek 请求失败（${repo}）：HTTP ${response.status}`);
  const payload = await response.json();
  const result = payload.choices?.[0]?.message?.content
    ?.replace(/[`*_#]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!result) throw new Error(`DeepSeek 未返回项目描述（${repo}）`);
  return result;
}

async function main() {
  await loadLocalEnvironment();
  if (!process.env.DEEPSEEK_API_KEY) {
    throw new Error('缺少 DEEPSEEK_API_KEY，请通过环境变量或 .env.local 配置新密钥');
  }

  const reportPaths = await findReports(projectRoot);
  const targetPaths = requestedDate
    ? reportPaths.filter((path) => basename(path) === `${requestedDate.replaceAll('-', '')}.md`)
    : requestedMonth
      ? reportPaths.filter((path) => basename(path).startsWith(requestedMonth.replaceAll('-', '')))
      : [reportPaths.at(-1)];
  if (!targetPaths.length) throw new Error(`没有找到 ${requestedDate || requestedMonth} 的日报`);

  const projectMap = new Map();
  for (const targetPath of targetPaths) {
    const source = relative(projectRoot, targetPath).replaceAll('\\', '/');
    const report = parseReport(await readFile(targetPath, 'utf8'), source);
    for (const project of report.projects) {
      const existing = projectMap.get(project.repo);
      if (!existing || (!existing.description && project.description)) projectMap.set(project.repo, project);
    }
  }

  const cache = await readCache();
  const pending = [...projectMap.values()].filter((project) => {
    if (cache[project.repo]?.description) return false;
    return !containsChinese(project.description) || project.description.length > 30;
  });

  const scope = requestedDate || requestedMonth || basename(targetPaths[0], '.md');
  console.log(`准备补全 ${scope} 的 ${pending.length} 个项目描述，已有缓存不会重复请求`);
  for (const [index, project] of pending.entries()) {
    try {
      const readme = project.description ? '' : await fetchReadme(project.repo);
      if (!project.description && !readme) {
        console.warn(`[${index + 1}/${pending.length}] ${project.repo} 没有可读取的 README，已跳过`);
        continue;
      }

      const description = await askDeepSeek({
        repo: project.repo,
        description: project.description,
        readme
      });
      cache[project.repo] = {
        description,
        source: !project.description
          ? 'readme-summary'
          : containsChinese(project.description) ? 'condensed' : 'translation',
        updatedAt: new Date().toISOString()
      };
      await writeFile(cachePath, `${JSON.stringify(cache, null, 2)}\n`, 'utf8');
      console.log(`[${index + 1}/${pending.length}] 已补全 ${project.repo}`);
    } catch (error) {
      console.error(`[${index + 1}/${pending.length}] ${error.message}`);
    }
  }

  console.log('描述缓存已更新，请运行 npm run generate:data 重新生成榜单数据');
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
