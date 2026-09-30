import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { collectSnapshot, writeSnapshotFile } from './fetch-issues.mjs';

const TOKEN = 'test-token-that-must-not-be-published';
const REPOSITORY = 'someone/project';
const REPOSITORY_DATA = {
  nameWithOwner: REPOSITORY,
  url: 'https://github.com/someone/project',
};

function issue(number, labels = ['bug']) {
  return {
    number,
    title: `Issue ${number}`,
    url: `https://github.com/someone/project/issues/${number}`,
    createdAt: '2026-10-01T10:00:00Z',
    author: { login: 'reporter' },
    labels: {
      totalCount: labels.length,
      nodes: labels.map((name) => ({ name })),
      pageInfo: { hasNextPage: false, endCursor: null },
    },
  };
}

function success(data) {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function fakeIssuesApi(total) {
  const cursors = [];
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://api.github.com/graphql');
    assert.equal(options.headers.authorization, `Bearer ${TOKEN}`);
    const { query, variables } = JSON.parse(options.body);
    assert.match(query, /states: OPEN/);
    assert.equal(variables.owner, 'someone');
    assert.equal(variables.name, 'project');

    const start = variables.cursor === null ? 0 : Number(variables.cursor);
    const end = Math.min(start + 100, total);
    cursors.push(variables.cursor);
    return success({
      repository: {
        ...REPOSITORY_DATA,
        issues: {
          totalCount: total,
          nodes: Array.from({ length: end - start }, (_, index) => issue(start + index + 1)),
          pageInfo: { hasNextPage: end < total, endCursor: end ? String(end) : null },
        },
      },
    });
  };
  return { fetchImpl, cursors };
}

for (const total of [0, 100, 101, 237]) {
  test(`collects all ${total} open issues`, async () => {
    const api = fakeIssuesApi(total);
    const snapshot = await collectSnapshot({
      repository: REPOSITORY,
      token: TOKEN,
      fetchImpl: api.fetchImpl,
      now: () => new Date('2026-10-01T12:00:00Z'),
    });

    assert.equal(snapshot.issues.length, total);
    assert.equal(new Set(snapshot.issues.map((item) => item.number)).size, total);
    assert.equal(snapshot.generatedAt, '2026-10-01T12:00:00.000Z');
    assert.deepEqual(snapshot.repository, REPOSITORY_DATA);
    assert.equal(api.cursors.length, Math.max(1, Math.ceil(total / 100)));
    assert.equal(api.cursors[0], null);
    if (total > 100) assert.equal(api.cursors[1], '100');
    if (total > 200) assert.equal(api.cursors[2], '200');
    assert.equal(JSON.stringify(snapshot).includes(TOKEN), false);
  });
}

test('fetches remaining label pages for an issue', async () => {
  const firstLabels = Array.from({ length: 100 }, (_, index) => `label-${index + 1}`);
  const fetchImpl = async (_url, options) => {
    const { query, variables } = JSON.parse(options.body);
    if (query.includes('RemainingLabels')) {
      assert.equal(variables.number, 1);
      assert.equal(variables.cursor, 'label-100');
      return success({
        repository: {
          issue: {
            labels: {
              totalCount: 101,
              nodes: [{ name: 'label-101' }],
              pageInfo: { hasNextPage: false, endCursor: 'label-101' },
            },
          },
        },
      });
    }
    const item = issue(1, firstLabels);
    item.labels.totalCount = 101;
    item.labels.pageInfo = { hasNextPage: true, endCursor: 'label-100' };
    return success({
      repository: {
        ...REPOSITORY_DATA,
        issues: {
          totalCount: 1,
          nodes: [item],
          pageInfo: { hasNextPage: false, endCursor: 'issue-1' },
        },
      },
    });
  };

  const snapshot = await collectSnapshot({ repository: REPOSITORY, token: TOKEN, fetchImpl });
  assert.equal(snapshot.issues[0].labels.length, 101);
  assert.equal(snapshot.issues[0].labels.at(-1), 'label-101');
});

test('retries once if the open issue count changes during collection', async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return success({
      repository: {
        ...REPOSITORY_DATA,
        issues: {
          totalCount: 2,
          nodes: calls === 1 ? [issue(1)] : [issue(1), issue(2)],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      },
    });
  };

  const snapshot = await collectSnapshot({ repository: REPOSITORY, token: TOKEN, fetchImpl });
  assert.equal(calls, 2);
  assert.equal(snapshot.issues.length, 2);
});

test('rejects a stalled cursor instead of writing a partial list', async () => {
  const fetchImpl = async () =>
    success({
      repository: {
        ...REPOSITORY_DATA,
        issues: {
          totalCount: 101,
          nodes: [issue(1)],
          pageInfo: { hasNextPage: true, endCursor: null },
        },
      },
    });
  await assert.rejects(
    collectSnapshot({ repository: REPOSITORY, token: TOKEN, fetchImpl }),
    /Invalid or repeated issue cursor/,
  );
});

test('does not expose GraphQL error contents or write the token', async () => {
  const fetchImpl = async () =>
    new Response(
      JSON.stringify({
        errors: [{ message: `secret ${TOKEN}` }],
      }),
      { status: 200 },
    );
  await assert.rejects(
    collectSnapshot({ repository: REPOSITORY, token: TOKEN, fetchImpl }),
    (error) => !error.message.includes(TOKEN) && /GraphQL returned 1 error/.test(error.message),
  );

  const directory = await mkdtemp(join(tmpdir(), 'issue-snapshot-'));
  try {
    const outputPath = join(directory, 'issues.json');
    const snapshot = await collectSnapshot({
      repository: REPOSITORY,
      token: TOKEN,
      fetchImpl: fakeIssuesApi(101).fetchImpl,
    });
    await writeSnapshotFile(snapshot, outputPath);
    const saved = await readFile(outputPath, 'utf8');
    assert.equal(JSON.parse(saved).issues.length, 101);
    assert.equal(saved.includes(TOKEN), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
