import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, copyFile, symlink, lstat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { watch } from 'node:fs';
import { promisify } from 'node:util';
import os from 'node:os';
import path from 'node:path';
const run = promisify(execFile);
const temporary: string[] = [];
const source = path.resolve('scripts/build.mjs');
async function fixture(mode = 'auto', outputDirectory = 'dist') {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mob-build-test-'));
  temporary.push(root);
  await mkdir(path.join(root, 'scripts'));
  await mkdir(path.join(root, 'frontend'));
  await copyFile(source, path.join(root, 'scripts/build.mjs'));
  await writeFile(path.join(root, 'mob.config.json'), JSON.stringify({ schemaVersion: 1, frontend: { mode, installCommand: null, buildCommand: ['node', 'build.mjs'], outputDirectory } }));
  return root;
}
afterEach(async () => {
  for (const target of temporary.splice(0)) {
    const relative = path.relative(os.tmpdir(), target);
    if (!relative.startsWith('mob-build-test-') || relative.includes(path.sep)) throw new Error('Unsafe test cleanup.');
    await rm(target, { recursive: true, force: true });
  }
});
describe('repository-controlled frontend builds', () => {
  it('rebuilds under an active asset-root watcher, removes stale files and preserves the root directory', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'frontend/index.html'), 'before');
    await writeFile(path.join(root, 'frontend/stale.js'), 'old asset');
    await run(process.execPath, [path.join(root, 'scripts/build.mjs')]);
    const output = path.join(root, 'dist/client');
    const before = await lstat(output);
    const watcher = watch(output, () => {});
    try {
      await writeFile(path.join(root, 'frontend/index.html'), 'after');
      await rm(path.join(root, 'frontend/stale.js'));
      await run(process.execPath, [path.join(root, 'scripts/build.mjs')]);
      const after = await lstat(output);
      expect(after.ino).toBe(before.ino);
      expect(after.birthtimeMs).toBe(before.birthtimeMs);
      expect(await readFile(path.join(output, 'index.html'), 'utf8')).toBe('after');
      await expect(readFile(path.join(output, 'stale.js'))).rejects.toThrow();
    } finally { watcher.close(); }
  });
  it('copies raw frontend assets and excludes documentation and secrets', async () => {
    const root = await fixture();
    await writeFile(path.join(root, 'frontend/index.html'), '<main>fixture</main>');
    await writeFile(path.join(root, 'frontend/README.md'), 'not public');
    await writeFile(path.join(root, 'frontend/.env'), 'not public');
    await run(process.execPath, [path.join(root, 'scripts/build.mjs')]);
    expect(await readFile(path.join(root, 'dist/client/index.html'), 'utf8')).toContain('fixture');
    await expect(readFile(path.join(root, 'dist/client/.env'))).rejects.toThrow();
    await expect(readFile(path.join(root, 'dist/client/README.md'))).rejects.toThrow();
  });
  it('uses repository build command and selected output directory', async () => {
    const root = await fixture('build', 'export');
    await writeFile(path.join(root, 'frontend/package.json'), '{}');
    await writeFile(path.join(root, 'frontend/build.mjs'), "import {mkdir,writeFile} from 'node:fs/promises'; await mkdir('export'); await writeFile('export/index.html','compiled-fixture');");
    await run(process.execPath, [path.join(root, 'scripts/build.mjs')]);
    expect(await readFile(path.join(root, 'dist/client/index.html'), 'utf8')).toBe('compiled-fixture');
    await expect(readFile(path.join(root, 'dist/client/package.json'))).rejects.toThrow();
  });
  it('rejects output paths outside frontend before executing build', async () => {
    const root = await fixture('build', '../../');
    await writeFile(path.join(root, 'frontend/package.json'), '{}');
    await expect(run(process.execPath, [path.join(root, 'scripts/build.mjs')])).rejects.toThrow();
  });
  it('fails when a requested framework build does not produce assets', async () => {
    const root = await fixture('build');
    await writeFile(path.join(root, 'frontend/package.json'), '{}');
    await writeFile(path.join(root, 'frontend/build.mjs'), '/* no output */');
    await expect(run(process.execPath, [path.join(root, 'scripts/build.mjs')])).rejects.toThrow();
  });
});
