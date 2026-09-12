import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function evaluateResults(cases, results) {
  if (cases.length !== 20 || new Set(cases.map(item => item.query)).size !== 20 || cases.some(item => !item.query || !Array.isArray(item.expectedRepos) || !item.expectedRepos.length || item.expectedRepos.some(repo => typeof repo !== 'string' || !repo.includes('/')))) {
    throw new Error('需要20条不重复、经人工核查且含 expectedRepos 的查询');
  }
  let hits = 0;
  const queries = cases.map(item => {
    const projects = results[item.query];
    if (!Array.isArray(projects)) throw new Error(`缺少查询结果：${item.query}`);
    const expected = new Set(item.expectedRepos.map(repo => repo.toLowerCase()));
    const top5 = projects.slice(0, 5).map(project => project.repo.toLowerCase());
    const hit = top5.some(repo => expected.has(repo));
    if (hit) hits++;
    return { query: item.query, expectedRepos: [...expected].sort(), hit, top5 };
  });
  return { total: cases.length, hits, hitRateAt5: hits / cases.length, passed: hits / cases.length >= 0.8, queries };
}

async function main() {
  const args = process.argv.slice(2);
  const option = (key, fallback) => args.find(arg => arg.startsWith(`--${key}=`))?.slice(key.length + 3) || fallback;
  const cases = JSON.parse(await readFile(option('cases', 'config/project-search-evaluation.json'), 'utf8')).cases;
  // Validate annotations before sending any query (and consuming embedding calls).
  evaluateResults(cases, Object.fromEntries(cases.map(item => [item.query, []])));
  const base = option('base-url', 'http://127.0.0.1:3000').replace(/\/$/, '');
  const responses = {};
  for (const item of cases) {
    const response = await fetch(`${base}/api/search`, { method: 'POST', signal: AbortSignal.timeout(60_000),
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query: item.query, minStars: 0, maxStars: null, limit: 5 }) });
    if (!response.ok) throw new Error(`搜索失败 HTTP ${response.status}: ${item.query}`);
    responses[item.query] = (await response.json()).projects;
  }
  const report = evaluateResults(cases, responses);
  const baselineFile = option('baseline');
  if (baselineFile) {
    const baseline = JSON.parse(await readFile(baselineFile, 'utf8'));
    if (baseline.queries.length !== cases.length || baseline.queries.some((item, i) => item.query !== cases[i].query || JSON.stringify(item.expectedRepos) !== JSON.stringify(report.queries[i].expectedRepos))) {
      throw new Error('基线必须使用相同的查询集和标注');
    }
    report.baselineHitRateAt5 = baseline.hitRateAt5;
    report.delta = report.hitRateAt5 - baseline.hitRateAt5;
  }
  await writeFile(option('output', '/tmp/project-profile-search-evaluation.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ total: report.total, hitRateAt5: report.hitRateAt5, passed: report.passed, delta: report.delta }));
  if (!report.passed) process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
