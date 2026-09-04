import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  atomicWriteJson,
  containsChinese,
  needsProcessing,
  normalizeDescription,
  parseDeepSeekResult,
  projectFingerprint
} from '../scripts/enrich-descriptions.mjs';

test('中文检测覆盖常用汉字', () => {
  assert.equal(containsChinese('AI 编程助手'), true);
  assert.equal(containsChinese('AI coding assistant'), false);
});

test('描述规范化为简短单句并拒绝空泛或非中文内容', () => {
  assert.equal(normalizeDescription('  面向开发者的 AI 编程助手。\n'), '面向开发者的 AI 编程助手');
  assert.equal(normalizeDescription('`本地优先`的知识管理工具'), '本地优先的知识管理工具');
  for (const value of [
    '',
    'A useful developer tool',
    '这是一个有潜力的项目',
    '该项目具体功能暂不清楚',
    '短',
    '这是一个用于开发者团队的工具。它还能管理任务。',
    '超'.repeat(51)
  ]) assert.throws(() => normalizeDescription(value));
});

test('DeepSeek 结果必须完整、唯一且只包含规定字段', () => {
  const content = JSON.stringify({ projects: [
    { repo: 'a/one', description: '用于构建高性能接口的 Python 框架' },
    { repo: 'b/two', description: '本地运行的跨平台 Markdown 编辑器' }
  ] });
  assert.deepEqual(parseDeepSeekResult(content, ['a/one', 'b/two']), {
    'a/one': '用于构建高性能接口的 Python 框架',
    'b/two': '本地运行的跨平台 Markdown 编辑器'
  });
  assert.throws(() => parseDeepSeekResult('```json\n' + content + '\n```', ['a/one', 'b/two']));
  assert.throws(() => parseDeepSeekResult(JSON.stringify({ projects: [{ repo: 'a/one', description: '用于开发的工具', extra: true }] }), ['a/one']));
  assert.throws(() => parseDeepSeekResult(JSON.stringify({ projects: [{ repo: 'a/one', description: '用于开发的工具' }] }), ['a/one', 'b/two']));
});

test('描述缓存按项目原始内容指纹增量复用', () => {
  const project = { repo: 'owner/repo', name: 'Demo', description: 'An AI tool', stars: 10 };
  const fingerprint = projectFingerprint(project);
  assert.equal(projectFingerprint({ ...project, stars: 999 }), fingerprint);
  assert.equal(needsProcessing(project, { fingerprint, description: '面向开发者的人工智能工具' }), false);
  assert.equal(needsProcessing({ ...project, description: 'Changed' }, { fingerprint, description: '面向开发者的人工智能工具' }), true);
  assert.equal(needsProcessing(project, { fingerprint, description: 'English only' }), true);
  assert.equal(needsProcessing(project, null), true);
});

test('JSON 缓存采用原子写入且不残留临时文件', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'project-descriptions-'));
  const destination = join(directory, 'nested', 'descriptions.json');
  try {
    await atomicWriteJson(destination, { 'owner/repo': { description: '简洁准确的项目描述' } });
    assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), {
      'owner/repo': { description: '简洁准确的项目描述' }
    });
    assert.deepEqual(await readdir(join(directory, 'nested')), ['descriptions.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
