import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';

let fixture: string;
const baseEnvironment = {
  ...process.env,
  CLOUDFLARE_API_TOKEN: 'fixture-deployment-token',
  CLOUDFLARE_SYNC_TOKEN: 'fixture-management-token',
  GITHUB_BOOTSTRAP_TOKEN: 'fixture-github-readonly',
  FAIL_STEP: '',
};
const traceScript = String.raw`
import fs from 'node:fs';
const file = process.argv[1].replaceAll('\\', '/');
const step = file.endsWith('cloudflare-sync.mjs')
  ? (process.argv.includes('--resources-only') ? 'resources' : 'builds')
  : 'build';
fs.appendFileSync('trace.jsonl', JSON.stringify({
  step, args: process.argv.slice(2), cwd: process.cwd(),
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
  githubToken: process.env.GITHUB_BOOTSTRAP_TOKEN,
}) + '\n');
if (process.env.FAIL_STEP === step) process.exit(13);
`;
const wranglerScript = String.raw`
const fs = require('node:fs');
fs.appendFileSync('trace.jsonl', JSON.stringify({
  step: 'deploy', args: process.argv.slice(2), cwd: process.cwd(),
  apiToken: process.env.CLOUDFLARE_API_TOKEN,
  githubToken: process.env.GITHUB_BOOTSTRAP_TOKEN,
}) + '\n');
if (process.env.FAIL_STEP === 'deploy') process.exit(13);
`;
async function trace() {
  return (await readFile(path.join(fixture, 'trace.jsonl'), 'utf8'))
    .trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
function run(env = baseEnvironment, args: string[] = []) {
  return spawnSync(process.execPath, ['scripts/deploy-cloudflare.mjs', ...args], {
    cwd: fixture, env, encoding: 'utf8', timeout: 30000,
  });
}

describe('declarative deployment subprocess pipeline', () => {
  beforeEach(async () => {
    fixture = await mkdtemp(path.join(tmpdir(), 'mob-deploy-'));
    await mkdir(path.join(fixture, 'scripts'), { recursive: true });
    await mkdir(path.join(fixture, 'node_modules/wrangler/bin'), { recursive: true });
    await writeFile(path.join(fixture, 'package.json'), '{"type":"module"}');
    await writeFile(path.join(fixture, 'trace.jsonl'), '');
    await copyFile(path.resolve('scripts/deploy-cloudflare.mjs'), path.join(fixture, 'scripts/deploy-cloudflare.mjs'));
    await writeFile(path.join(fixture, 'scripts/cloudflare-sync.mjs'), traceScript);
    await writeFile(path.join(fixture, 'scripts/build.mjs'), traceScript);
    await writeFile(path.join(fixture, 'node_modules/wrangler/bin/wrangler.js'), wranglerScript);
  });
  afterEach(async () => {
    const resolved = path.resolve(fixture);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith('mob-deploy-')) {
      throw new Error('Unsafe deployment fixture cleanup target.');
    }
    await rm(resolved, { recursive: true, force: true });
  });

  it('applies resources, explicitly builds, deploys once, then updates Builds; isolates API token mapping', async () => {
    const result = run();
    expect(result.status, result.stdout + result.stderr).toBe(0);
    const calls = await trace();
    expect(calls.map(call => call.step)).toEqual(['resources', 'build', 'deploy', 'builds']);
    expect(calls.map(call => call.apiToken)).toEqual([
      'fixture-management-token', 'fixture-deployment-token',
      'fixture-deployment-token', 'fixture-management-token',
    ]);
    expect(calls.map(call => call.githubToken)).toEqual(Array(4).fill('fixture-github-readonly'));
    expect(calls.map(call => call.cwd)).toEqual(Array(4).fill(fixture));
    expect(calls.map(call => call.args)).toEqual([
      ['--apply', '--resources-only'], [], ['deploy', '--no-build'], ['--apply'],
    ]);
    expect(result.stdout + result.stderr).not.toContain('fixture-management-token');
    expect(result.stdout + result.stderr).not.toContain('fixture-deployment-token');
  });

  it.each(['resources', 'build', 'deploy', 'builds'])('stops all later changes after %s fails', async failure => {
    const result = run({ ...baseEnvironment, FAIL_STEP: failure });
    expect(result.status).toBe(1);
    const sequence = ['resources', 'build', 'deploy', 'builds'];
    expect((await trace()).map(call => call.step)).toEqual(sequence.slice(0, sequence.indexOf(failure) + 1));
    expect(result.stderr).toContain('Subsequent deployment steps were stopped');
  });

  it('accepts a local API-token fallback without modifying the Wrangler environment', async () => {
    const result = run({ ...baseEnvironment, CLOUDFLARE_SYNC_TOKEN: '' });
    expect(result.status).toBe(0);
    expect((await trace()).map(call => call.apiToken)).toEqual(Array(4).fill('fixture-deployment-token'));
  });

  it('rejects missing credentials before invoking any subprocess', async () => {
    const result = run({ ...baseEnvironment, CLOUDFLARE_API_TOKEN: '', CLOUDFLARE_SYNC_TOKEN: '' });
    expect(result.status).toBe(1);
    expect(await trace()).toEqual([]);
    expect(result.stderr).toContain('Set CLOUDFLARE_SYNC_TOKEN');
  });

  it('rejects unsupported arguments before modifying infrastructure', async () => {
    const result = run(baseEnvironment, ['--unexpected']);
    expect(result.status).toBe(1);
    expect(await trace()).toEqual([]);
  });
});
