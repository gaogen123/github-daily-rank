import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findLatestReport, parseCompactNumber, parseReport, parseStarSnapshot } from '../scripts/generate-data.mjs';

const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

test('解析带单位的 Star 数量', () => {
  assert.equal(parseCompactNumber('16.4k'), 16_400);
  assert.equal(parseCompactNumber('1.2m'), 1_200_000);
  assert.equal(parseCompactNumber('16,405'), 16_405);
});

test('从早期表格日报解析完整单日榜单', async () => {
  const source = join(projectRoot, '2024', '01', '20240118.md');
  const content = await readFile(source, 'utf8');
  const snapshot = parseStarSnapshot(content, source);
  const report = parseReport(content, source);

  assert.equal(snapshot.date, '2024-01-18');
  assert.equal(snapshot.projects.length, 20);
  assert.equal(report.projects.length, 20);
  assert.equal(report.projects[0].repo, 'linexjlin/GPTs');
  assert.equal(report.projects[0].stars, 23_200);
  assert.equal(report.projects[0].dailyGrowth, 328);
  assert.equal(report.projects[0].weeklyGrowth, 1_480);
});

test('解析最新日报及其增长指标', async () => {
  const reportPath = await findLatestReport(projectRoot);
  const content = await readFile(reportPath, 'utf8');
  const report = parseReport(content, reportPath);

  assert.match(report.date, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(report.projects.length > 0);
  assert.ok(report.projects.every((project) => project.repo && project.stars > 0));
  assert.ok(report.projects.every((project) => project.dailyGrowth >= 0));
  assert.ok(report.projects.every((project) => Number.isFinite(project.dailyRate)));
});
