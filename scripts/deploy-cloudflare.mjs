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

try {
  if (process.argv.length > 2) throw new Error('This deployment command does not accept arguments. Use cloudflare-sync.mjs --dry-run to preview configuration.');
  const syncToken = process.env.CLOUDFLARE_SYNC_TOKEN?.trim() || process.env.CLOUDFLARE_API_TOKEN?.trim();
  if (!syncToken) throw new Error('Set CLOUDFLARE_SYNC_TOKEN as a build secret before running deploy:cloudflare. Local sessions may use CLOUDFLARE_API_TOKEN instead.');
  await Promise.all([access(sync), access(build), access(wrangler)]);
  const syncEnvironment = { ...process.env, CLOUDFLARE_API_TOKEN: syncToken };
  await step('Apply R2 and Access configuration', sync, ['--apply', '--resources-only'], syncEnvironment);
  // Workers Builds does not automatically honor Wrangler custom builds.
  // Run the repository's frontend pipeline explicitly, then skip duplicate builds.
  await step('Build frontend assets from repository configuration', build, []);
  // Keep the platform-provided deployment token/OAuth environment unchanged.
  await step('Deploy Worker and frontend assets', wrangler, ['deploy', '--no-build']);
  await step('Apply Workers Builds configuration', sync, ['--apply'], syncEnvironment);
  console.log('Cloudflare resources, Worker and Builds configuration are synchronized.');
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Cloudflare deployment failed.');
  process.exitCode = 1;
}
