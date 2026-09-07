// Execute the same source contracts with Node, without starting the P2P runtime.
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(root, 'src/lib');
const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'harmolyn-contracts-'));
const tests = [];
async function compile(folder) {
  for (const entry of await fs.readdir(folder, { withFileTypes: true })) {
    const fileName = path.join(folder, entry.name);
    if (entry.isDirectory()) { await compile(fileName); continue; }
    if (!fileName.endsWith('.ts')) continue;
    let source = await fs.readFile(fileName, 'utf8');
    source = source.replace("from 'vitest'", "from 'node:test'").replace(/from '(\.{1,2}\/[^']+)'/g, "from '$1.mjs'");
    const result = ts.transpileModule(source, { fileName, compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.ESNext }, reportDiagnostics: true });
    const errors = (result.diagnostics ?? []).filter(item => item.category === ts.DiagnosticCategory.Error);
    if (errors.length) throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, { getCanonicalFileName: file => file, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
    const output = path.join(directory, path.relative(sourceRoot, fileName).replace(/\.ts$/, '.mjs'));
    await fs.mkdir(path.dirname(output), { recursive: true });
    await fs.writeFile(output, result.outputText);
    if (fileName.endsWith('.test.ts')) tests.push(output);
  }
}
try {
  await compile(path.join(sourceRoot, 'stabilization'));
  await compile(path.join(sourceRoot, 'appearance'));
  const result = spawnSync(process.execPath, ['--test', ...tests], { stdio: 'inherit' });
  process.exitCode = result.status ?? 1;
} finally {
  await fs.rm(directory, { recursive: true, force: true });
}
