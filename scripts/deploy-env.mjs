import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
export async function prepareDeployment(root, env = process.env) {
  const keys = ['CLOUDFLARE_ACCOUNT_ID','SITE_ORIGIN','ADMIN_EMAILS','ACCESS_TEAM_DOMAIN','R2_BUCKET_NAME','BUILDS_TRIGGER_NAME','GITHUB_OWNER','GITHUB_REPO','GITHUB_BRANCH','POSTS_DIRECTORY'];
  if (!keys.some(key => env[key]?.trim())) return;
  const filename = path.join(root, 'wrangler.jsonc');
  const configFile = path.join(root, 'config/cloudflare.json');
  const worker = JSON.parse(await readFile(filename, 'utf8'));
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  if (env.CLOUDFLARE_ACCOUNT_ID?.trim()) {
    const id = env.CLOUDFLARE_ACCOUNT_ID.trim();
    if (!/^[a-f0-9]{32}$/i.test(id)) throw new Error('CLOUDFLARE_ACCOUNT_ID must be a 32-character account ID.');
    config.accountId = id; worker.account_id = id;
  }
  for (const key of ['SITE_ORIGIN','ADMIN_EMAILS','ACCESS_TEAM_DOMAIN','GITHUB_OWNER','GITHUB_REPO','GITHUB_BRANCH','POSTS_DIRECTORY']) if (env[key]?.trim()) worker.vars[key] = env[key].trim();
  worker.vars.APP_ENV = 'production';
  if (env.R2_BUCKET_NAME?.trim()) worker.r2_buckets.find(bucket => bucket.binding === 'MEDIA').bucket_name = env.R2_BUCKET_NAME.trim();
  if (env.BUILDS_TRIGGER_NAME?.trim()) config.builds.triggerName = env.BUILDS_TRIGGER_NAME.trim();
  if (env.SITE_ORIGIN?.trim()) {
    const site = new URL(worker.vars.SITE_ORIGIN);
    if (site.protocol !== 'https:' || site.username || site.password || site.port || site.pathname !== '/' || site.search || site.hash) throw new Error('SITE_ORIGIN must be an HTTPS origin.');
    if (!site.hostname.endsWith('.workers.dev')) worker.routes = [{ pattern: site.hostname, custom_domain: true }];
    else worker.routes = [];
  }
  await writeFile(filename, JSON.stringify(worker, null, 2) + '\n');
  await writeFile(configFile, JSON.stringify(config, null, 2) + '\n');
}
