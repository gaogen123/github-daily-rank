import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  atomicWriteJson,
  buildManifest,
  isPrivateIp,
  projectFingerprint,
  repositoryPreviewSvg,
  shouldProcessProject,
  stableImageFilename,
  validatePublicUrl
} from '../scripts/projects/project_images.mjs';

const publicLookup = async () => [{ address: '93.184.216.34', family: 4 }];

test('识别 IPv4 与 IPv6 私网、环回、链路本地及保留地址', () => {
  for (const address of [
    '127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.1',
    '169.254.10.2', '100.64.0.1', '192.0.2.10', '198.51.100.3', '203.0.113.8',
    '::', '::1', 'fc00::1', 'fd12:3456::1', 'fe80::1', 'fec0::1', '2001:db8::1',
    '::ffff:127.0.0.1', '::ffff:192.168.1.1'
  ]) assert.equal(isPrivateIp(address), true, address);

  for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) {
    assert.equal(isPrivateIp(address), false, address);
  }
});

test('URL 验证仅接受标准端口且 DNS 的所有结果均须为公网地址', async () => {
  const valid = await validatePublicUrl('https://example.com/path?q=1', { lookup: publicLookup });
  assert.equal(valid.href, 'https://example.com/path?q=1');
  await assert.rejects(validatePublicUrl('ftp://example.com/a', { lookup: publicLookup }), /http\/https/);
  await assert.rejects(validatePublicUrl('https://user:secret@example.com', { lookup: publicLookup }), /凭据/);
  await assert.rejects(validatePublicUrl('https://example.com:8443', { lookup: publicLookup }), /80\/443/);
  await assert.rejects(validatePublicUrl('http://localhost', { lookup: publicLookup }), /主机不安全/);
  await assert.rejects(validatePublicUrl('http://127.0.0.1'), /非公网/);
  await assert.rejects(validatePublicUrl('https://[::1]'), /非公网/);
  await assert.rejects(validatePublicUrl('https://mixed.example', {
    lookup: async () => [
      { address: '93.184.216.34', family: 4 },
      { address: '10.0.0.1', family: 4 }
    ]
  }), /未全部解析到公网/);
  await assert.rejects(validatePublicUrl('https://missing.example', { lookup: async () => [] }), /未全部解析到公网/);
});

test('稳定文件名使用仓库字符串的 SHA256', () => {
  assert.equal(
    stableImageFilename('owner/repo'),
    '65e817eec8cd71edae741f73b5aa07d98e8f79c623a5f05014f1a88f89fb089c.webp'
  );
  assert.equal(stableImageFilename('owner/repo'), stableImageFilename('owner/repo'));
  assert.notEqual(stableImageFilename('owner/repo'), stableImageFilename('owner/other'));
});

test('本地仓库预览 SVG 转义 XML、展示元数据并截断长字段', () => {
  const description = `Build <fast> & "safe" 'tools' ${'很长的项目说明'.repeat(30)} END-MARKER`;
  const svg = repositoryPreviewSvg({
    repo: 'owner/<unsafe>&repo',
    description,
    stargazers_count: 1234567,
    forks_count: 4321,
    language: 'TypeScript & XML'
  });

  assert.match(svg, /^<svg width="1200" height="600"/);
  assert.match(svg, /Repository Preview/);
  assert.match(svg, /Not an official GitHub image/);
  assert.match(svg, /owner\/&lt;unsafe&gt;&amp;repo/);
  assert.match(svg, /Build &lt;fast&gt; &amp; &quot;safe&quot; &apos;tools&apos;/);
  assert.match(svg, /1,234,567 Star/);
  assert.match(svg, /4,321 Fork/);
  assert.match(svg, /TypeScript &amp; XML/);
  assert.match(svg, /…/);
  assert.doesNotMatch(svg, /END-MARKER/);
  assert.doesNotMatch(svg, /<unsafe>/);
});

test('内容指纹稳定且任意项目内容变化会立即进入待处理', () => {
  const project = { repo: 'owner/repo', name: 'Demo', description: 'AI tool', url: 'https://github.com/owner/repo', stars: 10 };
  const reordered = { stars: 999, url: 'https://github.com/owner/repo', description: 'AI tool', name: 'Demo', repo: 'owner/repo' };
  assert.equal(projectFingerprint(project), projectFingerprint(reordered));

  const now = Date.parse('2026-08-24T00:00:00.000Z');
  const fresh = {
    fingerprint: projectFingerprint(project),
    source: 'homepage',
    captured_at: '2026-08-20T00:00:00.000Z',
    file: 'x.webp'
  };
  assert.equal(shouldProcessProject(project, fresh, { now, refreshDays: 30 }), false);
  assert.equal(shouldProcessProject({ ...project, stars: 11 }, fresh, { now, refreshDays: 30 }), false);
  assert.equal(shouldProcessProject({ ...project, description: 'Changed AI tool' }, fresh, { now, refreshDays: 30 }), true);
  assert.equal(shouldProcessProject(project, fresh, { now, force: true }), true);
  assert.equal(shouldProcessProject(project, fresh, { now, fileExists: false }), true);
});

test('正常缓存按刷新周期处理，默认图或元数据失败缓存可在一天后重试', () => {
  const project = { repo: 'owner/repo', description: 'demo' };
  const fingerprint = projectFingerprint(project);
  const now = Date.parse('2026-08-24T12:00:00.000Z');
  assert.equal(shouldProcessProject(project, {
    fingerprint, source: 'homepage', captured_at: '2026-07-26T12:00:01.000Z'
  }, { now, refreshDays: 30 }), false);
  assert.equal(shouldProcessProject(project, {
    fingerprint, source: 'homepage', captured_at: '2026-07-25T12:00:00.000Z'
  }, { now, refreshDays: 30 }), true);
  assert.equal(shouldProcessProject(project, {
    fingerprint, source: 'default', captured_at: '2026-08-23T12:00:01.000Z'
  }, { now, refreshDays: 30 }), false);
  assert.equal(shouldProcessProject(project, {
    fingerprint, source: 'default', captured_at: '2026-08-23T12:00:00.000Z'
  }, { now, refreshDays: 30 }), true);
  assert.equal(shouldProcessProject(project, {
    fingerprint, source: 'github-preview', metadata_error: true, captured_at: '2026-08-23T12:00:01.000Z'
  }, { now, refreshDays: 30 }), false);
  assert.equal(shouldProcessProject(project, {
    fingerprint, source: 'github-preview', metadata_error: true, captured_at: '2026-08-23T12:00:00.000Z'
  }, { now, refreshDays: 30 }), true);
});

test('清单结构只导出输入项目中的有效缓存并保持规定字段', () => {
  const projects = [{ repo: 'a/one' }, { repo: 'b/two' }, { repo: 'c/three' }];
  const manifest = buildManifest(projects, {
    version: 1,
    projects: {
      'a/one': {
        file: 'a.webp', source: 'homepage', homepage: 'https://a.example', captured_at: '2026-08-24T01:00:00.000Z'
      },
      'b/two': {
        file: 'b.webp', source: 'github-preview', homepage: '', captured_at: '2026-08-24T02:00:00.000Z'
      },
      'removed/repo': {
        file: 'old.webp', source: 'github-preview', homepage: '', captured_at: '2026-08-24T03:00:00.000Z'
      }
    }
  }, '2026-08-24T04:00:00.000Z');

  assert.deepEqual(manifest, {
    version: 1,
    generated_at: '2026-08-24T04:00:00.000Z',
    count: 2,
    images: {
      'a/one': {
        url: '/data/project-images/a.webp',
        source: 'homepage',
        homepage: 'https://a.example',
        updated_at: '2026-08-24T01:00:00.000Z'
      },
      'b/two': {
        url: '/data/project-images/b.webp',
        source: 'github-preview',
        homepage: '',
        updated_at: '2026-08-24T02:00:00.000Z'
      }
    }
  });
});

test('JSON 原子输出完成后无临时文件残留', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'project-images-'));
  const destination = join(directory, 'nested', 'manifest.json');
  try {
    await atomicWriteJson(destination, { version: 1, count: 0, images: {} });
    assert.deepEqual(JSON.parse(await readFile(destination, 'utf8')), { version: 1, count: 0, images: {} });
    assert.deepEqual(await readdir(join(directory, 'nested')), ['manifest.json']);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
