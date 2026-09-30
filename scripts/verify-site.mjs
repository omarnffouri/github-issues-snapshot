import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

function exactKeys(value, keys, description) {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())
  ) {
    throw new Error(`Invalid ${description} in published issues.json`);
  }
}

function verifySnapshot(snapshot) {
  exactKeys(snapshot, ['repository', 'generatedAt', 'issues'], 'snapshot');
  exactKeys(snapshot.repository, ['nameWithOwner', 'url'], 'repository');
  if (
    typeof snapshot.repository.nameWithOwner !== 'string' ||
    typeof snapshot.repository.url !== 'string' ||
    typeof snapshot.generatedAt !== 'string' ||
    !Number.isFinite(Date.parse(snapshot.generatedAt)) ||
    !Array.isArray(snapshot.issues)
  ) {
    throw new Error('Invalid snapshot values in published issues.json');
  }

  for (const issue of snapshot.issues) {
    exactKeys(issue, ['number', 'title', 'url', 'labels', 'author', 'openedAt'], 'issue');
    if (
      !Number.isInteger(issue.number) ||
      issue.number < 1 ||
      typeof issue.title !== 'string' ||
      typeof issue.url !== 'string' ||
      !Array.isArray(issue.labels) ||
      !issue.labels.every((label) => typeof label === 'string') ||
      (issue.author !== null && typeof issue.author !== 'string') ||
      typeof issue.openedAt !== 'string'
    ) {
      throw new Error('Invalid issue values in published issues.json');
    }
  }
}

async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error('Published site contains a symbolic link');
    }
    if (entry.isDirectory()) files.push(...(await filesIn(path)));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

export async function verifySite({ outputDir, token, basePath }) {
  if (!token) throw new Error('GITHUB_TOKEN is required for the published file check');
  if (typeof basePath !== 'string' || (basePath && !basePath.startsWith('/'))) {
    throw new Error('Invalid GitHub Pages base path');
  }

  const expectedBaseHref = `${basePath.replace(/\/+$/, '')}/`;
  const html = await readFile(join(outputDir, 'index.html'), 'utf8');
  const actualBaseHref = html.match(/<base\s+href=["']([^"']+)["']/i)?.[1];
  if (actualBaseHref !== expectedBaseHref) {
    throw new Error(`Angular base href does not match GitHub Pages path: ${expectedBaseHref}`);
  }

  const snapshot = JSON.parse(await readFile(join(outputDir, 'issues.json'), 'utf8'));
  verifySnapshot(snapshot);

  const tokenBytes = Buffer.from(token);
  const files = await filesIn(outputDir);
  for (const path of files) {
    if ((await readFile(path)).includes(tokenBytes)) {
      throw new Error('Workflow token found in published site files');
    }
  }
  return { fileCount: files.length, baseHref: expectedBaseHref };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const outputDir = fileURLToPath(new URL('../dist/site/browser/', import.meta.url));
    const result = await verifySite({
      outputDir,
      token: process.env.GITHUB_TOKEN,
      basePath: process.env.PAGES_BASE_PATH,
    });
    console.log(`Checked ${result.fileCount} site files for ${result.baseHref}`);
  } catch (error) {
    console.error(`Site verification failed: ${error.message}`);
    process.exitCode = 1;
  }
}
