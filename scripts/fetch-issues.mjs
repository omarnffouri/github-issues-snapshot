import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const GRAPHQL_URL = 'https://api.github.com/graphql';

const ISSUES_QUERY = `
  query OpenIssues($owner: String!, $name: String!, $cursor: String) {
    repository(owner: $owner, name: $name) {
      nameWithOwner
      url
      issues(first: 100, after: $cursor, states: OPEN, orderBy: {field: CREATED_AT, direction: DESC}) {
        totalCount
        pageInfo { hasNextPage endCursor }
        nodes {
          number
          title
          url
          createdAt
          author { login }
          labels(first: 100) {
            totalCount
            nodes { name }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
`;

const LABELS_QUERY = `
  query RemainingLabels($owner: String!, $name: String!, $number: Int!, $cursor: String!) {
    repository(owner: $owner, name: $name) {
      issue(number: $number) {
        labels(first: 100, after: $cursor) {
          totalCount
          nodes { name }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }
`;

class SnapshotChangedError extends Error {}

function repositoryParts(repository) {
  const parts = repository?.split('/');
  if (parts?.length !== 2 || parts.some((part) => !part)) {
    throw new Error('GITHUB_REPOSITORY must have the form owner/name');
  }
  return { owner: parts[0], name: parts[1] };
}

async function graphqlRequest(query, variables, token, fetchImpl) {
  let response;
  try {
    response = await fetchImpl(GRAPHQL_URL, {
      method: 'POST',
      headers: {
        accept: 'application/vnd.github+json',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch {
    throw new Error('GitHub GraphQL request could not be completed');
  }

  if (!response.ok) {
    throw new Error(`GitHub GraphQL request failed (HTTP ${response.status})`);
  }

  let payload;
  try {
    payload = await response.json();
  } catch {
    throw new Error('GitHub GraphQL returned invalid JSON');
  }

  if (payload?.errors?.length) {
    throw new Error(`GitHub GraphQL returned ${payload.errors.length} error(s)`);
  }
  if (!payload?.data) {
    throw new Error('GitHub GraphQL returned no data');
  }
  return payload.data;
}

function checkedConnection(connection, description) {
  if (
    !connection ||
    !Array.isArray(connection.nodes) ||
    !Number.isInteger(connection.totalCount) ||
    connection.totalCount < 0 ||
    typeof connection.pageInfo?.hasNextPage !== 'boolean'
  ) {
    throw new Error(`Invalid ${description} connection from GitHub`);
  }
  return connection;
}

function nextCursor(pageInfo, seenCursors, description) {
  if (!pageInfo.hasNextPage) return null;
  const cursor = pageInfo.endCursor;
  if (typeof cursor !== 'string' || !cursor || seenCursors.has(cursor)) {
    throw new Error(`Invalid or repeated ${description} cursor from GitHub`);
  }
  seenCursors.add(cursor);
  return cursor;
}

function labelNames(connection) {
  return connection.nodes.map((label) => {
    if (typeof label?.name !== 'string') {
      throw new Error('Invalid issue label from GitHub');
    }
    return label.name;
  });
}

async function collectLabels(initial, number, owner, name, token, fetchImpl) {
  const connection = checkedConnection(initial, 'label');
  const expectedCount = connection.totalCount;
  const labels = labelNames(connection);
  const seenCursors = new Set();
  let cursor = nextCursor(connection.pageInfo, seenCursors, 'label');

  while (cursor !== null) {
    const data = await graphqlRequest(
      LABELS_QUERY,
      { owner, name, number, cursor },
      token,
      fetchImpl,
    );
    const page = checkedConnection(data.repository?.issue?.labels, 'label');
    if (page.totalCount !== expectedCount) {
      throw new SnapshotChangedError('Issue labels changed while collecting the snapshot');
    }
    labels.push(...labelNames(page));
    cursor = nextCursor(page.pageInfo, seenCursors, 'label');
  }

  if (labels.length !== expectedCount) {
    throw new SnapshotChangedError('Issue label count changed while collecting the snapshot');
  }
  return labels;
}

async function collectOnce(owner, name, token, fetchImpl, now) {
  const issues = [];
  const seenNumbers = new Set();
  const seenCursors = new Set();
  let cursor = null;
  let expectedCount;
  let repositoryInfo;

  do {
    const data = await graphqlRequest(ISSUES_QUERY, { owner, name, cursor }, token, fetchImpl);
    const repository = data.repository;
    if (typeof repository?.nameWithOwner !== 'string' || typeof repository?.url !== 'string') {
      throw new Error('Repository was not found in the GitHub GraphQL response');
    }
    const page = checkedConnection(repository.issues, 'issue');
    repositoryInfo = { nameWithOwner: repository.nameWithOwner, url: repository.url };

    if (expectedCount === undefined) expectedCount = page.totalCount;
    if (page.totalCount !== expectedCount) {
      throw new SnapshotChangedError('Open issue count changed while collecting the snapshot');
    }

    for (const issue of page.nodes) {
      if (
        !Number.isInteger(issue?.number) ||
        issue.number < 1 ||
        typeof issue.title !== 'string' ||
        typeof issue.url !== 'string' ||
        typeof issue.createdAt !== 'string' ||
        (issue.author !== null &&
          issue.author !== undefined &&
          typeof issue.author.login !== 'string')
      ) {
        throw new Error('Invalid issue in the GitHub GraphQL response');
      }
      if (seenNumbers.has(issue.number)) {
        throw new SnapshotChangedError('Duplicate issue while collecting the snapshot');
      }
      seenNumbers.add(issue.number);

      const labels = await collectLabels(issue.labels, issue.number, owner, name, token, fetchImpl);
      issues.push({
        number: issue.number,
        title: issue.title,
        url: issue.url,
        labels,
        author: issue.author?.login ?? null,
        openedAt: issue.createdAt,
      });
    }

    cursor = nextCursor(page.pageInfo, seenCursors, 'issue');
  } while (cursor !== null);

  if (issues.length !== expectedCount) {
    throw new SnapshotChangedError('Open issue count did not match the pages returned by GitHub');
  }

  return { repository: repositoryInfo, generatedAt: now().toISOString(), issues };
}

export async function collectSnapshot({
  repository,
  token,
  fetchImpl = fetch,
  now = () => new Date(),
}) {
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const { owner, name } = repositoryParts(repository);

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await collectOnce(owner, name, token, fetchImpl, now);
    } catch (error) {
      if (!(error instanceof SnapshotChangedError) || attempt === 1) throw error;
    }
  }
}

export async function writeSnapshotFile(snapshot, outputPath) {
  await mkdir(dirname(outputPath), { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(snapshot, null, 2)}\n`);
    await rename(temporaryPath, outputPath);
  } finally {
    await rm(temporaryPath, { force: true });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const snapshot = await collectSnapshot({
      repository: process.env.GITHUB_REPOSITORY,
      token: process.env.GITHUB_TOKEN,
    });
    const outputPath = fileURLToPath(new URL('../public/issues.json', import.meta.url));
    await writeSnapshotFile(snapshot, outputPath);
    console.log(`Saved ${snapshot.issues.length} open issue(s) to public/issues.json`);
  } catch (error) {
    console.error(`Snapshot generation failed: ${error.message}`);
    process.exitCode = 1;
  }
}
