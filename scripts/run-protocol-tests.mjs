import { readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

function collectTests(directory) {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTests(fullPath));
      continue;
    }
    if (entry.isFile() && entry.name.endsWith('.test.js')) {
      files.push(fullPath);
    }
  }
  return files;
}

const testsRoot = resolve('.generated/protocol-tests/protocol-tests');
const files = statSync(testsRoot).isDirectory() ? collectTests(testsRoot) : [];

if (files.length === 0) {
  console.error(`No compiled protocol tests found under ${testsRoot}`);
  process.exit(1);
}

const result = spawnSync(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
});

process.exit(result.status ?? 1);
