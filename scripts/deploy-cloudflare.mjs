import { prepareDeployment } from './deploy-env.mjs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const sync = path.join(root, 'scripts', 'cloudflare-sync.mjs');
const build = path.join(root, 'scripts', 'build.mjs');
const wrangler = path.join(root, 'node_modules', 'wrangler', 'bin', 'wrangler.js');

async function step(label, filename, args, env = process.env) {
  console.log(label);
  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [filename, ...args], {
      cwd: root,
      env,
      stdio: 'inherit',
      shell: false,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(label + ' failed (' + (signal ?? code) + '). Subsequent deployment steps were stopped.'));
    });
  });
}

let secretDirectory;
try {
  if (process.argv.length > 2) throw new Error('This deployment command does not accept arguments. Use cloudflare-sync.mjs --dry-run to preview configuration.');
  const syncToken = process.env.CLOUDFLARE_SYNC_TOKEN?.trim() || process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!syncToken) throw new Error('Set CLOUDFLARE_SYNC_TOKEN as a build secret before running deploy:cloudflare. Local sessions may use CLOUDFLARE_API_TOKEN instead.');
  if (process.env.WORKERS_CI && !process.env.WORKER_GITHUB_TOKEN?.trim()) throw new Error('Add WORKER_GITHUB_TOKEN as a Build Secret for GitHub article access.');
  await prepareDeployment(root);
  await Promise.all([access(sync), access(build), access(wrangler)]);
  const syncEnvironment = { ...process.env, CLOUDFLARE_API_TOKEN: syncToken };
  await step('Apply R2 and Access configuration', sync, ['--apply', '--resources-only'], syncEnvironment);
  // Workers Builds does not automatically honor Wrangler custom builds.
  // Run the repository's frontend pipeline explicitly, then skip duplicate builds.
  await step('Build frontend assets from repository configuration', build, []);
  // Keep the platform-provided deployment token/OAuth environment unchanged.
  const deployArgs = ['deploy', '--no-build'];
  if (process.env.WORKER_GITHUB_TOKEN?.trim()) {
    secretDirectory = await mkdtemp(path.join(tmpdir(), 'mob-runtime-secrets-'));
    const secretFile = path.join(secretDirectory, 'secrets.json');
    await writeFile(secretFile, JSON.stringify({ GITHUB_TOKEN: process.env.WORKER_GITHUB_TOKEN }), { mode: 0o600 });
    deployArgs.push('--secrets-file', secretFile);
  }
  await step('Deploy Worker and frontend assets', wrangler, deployArgs);
  await step('Apply Workers Builds configuration', sync, ['--apply'], syncEnvironment);
  console.log('Cloudflare resources, Worker and Builds configuration are synchronized.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Cloudflare deployment failed.');
  process.exitCode = 1;
} finally {
  if (secretDirectory) {
    const resolved = path.resolve(secretDirectory);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('mob-runtime-secrets-')) throw new Error('Unsafe secret cleanup path.');
    await rm(resolved, { recursive: true, force: true });
  }
}
