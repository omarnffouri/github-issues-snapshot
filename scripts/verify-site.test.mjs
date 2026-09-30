import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { verifySite } from './verify-site.mjs';

const TOKEN = 'example-workflow-token';
const SNAPSHOT = {
  repository: { nameWithOwner: 'new-owner/new-name', url: 'https://github.com/new-owner/new-name' },
  generatedAt: '2026-10-01T12:00:00Z',
  issues: [],
};

async function fixture(baseHref, snapshot = SNAPSHOT) {
  const outputDir = await mkdtemp(join(tmpdir(), 'verify-issue-site-'));
  await writeFile(
    join(outputDir, 'index.html'),
    `<html><head><base href="${baseHref}"></head></html>`,
  );
  await writeFile(join(outputDir, 'issues.json'), JSON.stringify(snapshot));
  await writeFile(join(outputDir, 'main.js'), 'console.log("site ready")');
  return outputDir;
}

for (const [basePath, baseHref] of [
  ['', '/'],
  ['/renamed-repo', '/renamed-repo/'],
]) {
  test(`accepts a complete site under ${baseHref}`, async () => {
    const outputDir = await fixture(baseHref);
    try {
      const result = await verifySite({ outputDir, token: TOKEN, basePath });
      assert.equal(result.fileCount, 3);
      assert.equal(result.baseHref, baseHref);
      assert.equal(
        new URL('issues.json', `https://example.test${baseHref}`).pathname,
        `${baseHref}issues.json`,
      );
    } finally {
      await rm(outputDir, { recursive: true, force: true });
    }
  });
}

test('rejects a token in any published file', async () => {
  const outputDir = await fixture('/project/');
  try {
    await writeFile(join(outputDir, 'main.js'), `const value = "${TOKEN}";`);
    await assert.rejects(
      verifySite({ outputDir, token: TOKEN, basePath: '/project' }),
      /token found in published site files/i,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('rejects a base href that points to another repository', async () => {
  const outputDir = await fixture('/old-name/');
  try {
    await assert.rejects(
      verifySite({ outputDir, token: TOKEN, basePath: '/new-name' }),
      /base href does not match/,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('rejects a site that still has the placeholder snapshot', async () => {
  const outputDir = await fixture('/', { repository: null, generatedAt: null, issues: [] });
  try {
    await assert.rejects(
      verifySite({ outputDir, token: TOKEN, basePath: '' }),
      /Invalid repository/,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});
