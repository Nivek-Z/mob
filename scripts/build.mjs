import { cp, lstat, mkdir, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = await realpath(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const frontend = path.join(root, 'frontend');
const dist = path.join(root, 'dist');
const target = path.join(dist, 'client');

function inside(parent, child, allowEqual = false) {
  const relative = path.relative(parent, child);
  return (allowEqual && relative === '') || (relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative));
}
async function info(filename) {
  try { return await lstat(filename); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function assertPlainPath(filename, parent) {
  if (!inside(parent, filename, true)) throw new Error('Path must stay inside ' + parent);
  let current = parent;
  for (const segment of path.relative(parent, filename).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    const stat = await info(current);
    if (stat?.isSymbolicLink()) throw new Error('Symbolic links and directory junctions are not supported: ' + current);
    if (stat && current !== filename && !stat.isDirectory()) throw new Error('Expected directory: ' + current);
  }
}
function excluded(name) {
  return name.startsWith('.') || name.toLowerCase() === 'node_modules' || /^(?:readme|agents)(?:\..*)?$/i.test(name);
}
async function copyTree(source, destination) {
  let count = 0;
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (excluded(entry.name)) continue;
    const input = path.join(source, entry.name);
    const output = path.join(destination, entry.name);
    const stat = await lstat(input);
    if (stat.isSymbolicLink()) throw new Error('Refusing to publish a symbolic link or directory junction: ' + input);
    if (stat.isDirectory()) {
      await mkdir(output, { recursive: true });
      count += await copyTree(input, output);
    } else if (stat.isFile()) {
      await cp(input, output, { dereference: false });
      count++;
    } else throw new Error('Only regular static files may be published: ' + input);
  }
  return count;
}

function command(value, label, nullable = false) {
  if (nullable && value === null) return null;
  if (!Array.isArray(value) || !value.length || value.some(item => typeof item !== 'string' || !item || item.includes('\0'))) {
    throw new Error(label + ' must be an array of command + arguments' + (nullable ? ', or null' : '') + '.');
  }
  return value;
}
async function resolveNpmCli(name) {
  const basename = name.toLowerCase().startsWith('npx') ? 'npx-cli.js' : 'npm-cli.js';
  const candidates = [];
  if (process.env.npm_execpath) candidates.push(path.join(path.dirname(process.env.npm_execpath), basename));
  candidates.push(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', basename));
  for (const entry of (process.env.PATH ?? process.env.Path ?? '').split(path.delimiter).filter(Boolean)) {
    candidates.push(path.join(entry, 'node_modules', 'npm', 'bin', basename));
  }
  for (const filename of candidates) if ((await info(filename))?.isFile()) return filename;
  throw new Error('Cannot locate ' + basename + '. Install Node.js with npm or use an explicit node + CLI.js command in mob.config.json.');
}
async function runCommand(value, label) {
  if (!value) return;
  let [executable, ...args] = value;
  if (process.platform === 'win32' && /^(?:npm|npx)(?:\.cmd)?$/i.test(executable)) {
    args = [await resolveNpmCli(executable), ...args];
    executable = process.execPath;
  } else if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    throw new Error('Use an executable or node + CLI.js instead of a batch command for ' + label + '.');
  }
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: frontend, stdio: 'inherit', shell: false });
    child.once('error', reject);
    child.once('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(label + ' failed (' + (signal ?? code) + ').')));
  });
}

await assertPlainPath(path.join(root, 'mob.config.json'), root);
const config = JSON.parse(await readFile(path.join(root, 'mob.config.json'), 'utf8'));
if (config.schemaVersion !== 1 || !config.frontend || typeof config.frontend !== 'object') {
  throw new Error('mob.config.json must contain schemaVersion: 1 and a frontend object.');
}
const { mode = 'auto', outputDirectory = 'dist' } = config.frontend;
if (!['auto', 'raw', 'build'].includes(mode)) throw new Error('frontend.mode must be auto, raw, or build.');
await assertPlainPath(frontend, root);
if (!(await info(frontend))?.isDirectory()) throw new Error('Create the frontend/ directory before building.');
const packagePath = path.join(frontend, 'package.json');
await assertPlainPath(packagePath, root);
const packageStat = await info(packagePath);
let source = frontend;

if (mode === 'build' || (mode === 'auto' && packageStat)) {
  if (!packageStat?.isFile()) throw new Error('Build mode requires a regular frontend/package.json.');
  if (typeof outputDirectory !== 'string' || !outputDirectory || path.isAbsolute(outputDirectory)) {
    throw new Error('frontend.outputDirectory must be relative to frontend/.');
  }
  source = path.resolve(frontend, outputDirectory);
  if (!inside(frontend, source)) throw new Error('frontend.outputDirectory must be a subdirectory of frontend/.');
  if (excluded(path.relative(frontend, source).split(path.sep)[0])) throw new Error('Output cannot be a hidden directory or node_modules.');
  await assertPlainPath(source, root);
  for (const filename of ['package-lock.json', 'npm-shrinkwrap.json']) await assertPlainPath(path.join(frontend, filename), root);
  const locked = Boolean(await info(path.join(frontend, 'package-lock.json'))) || Boolean(await info(path.join(frontend, 'npm-shrinkwrap.json')));
  let install = command(config.frontend.installCommand, 'frontend.installCommand', true);
  // The checked-in npm ci default also supports a newly added package without a lock.
  if (!locked && install && /^(?:npm|npm\.cmd)$/i.test(install[0]) && install[1] === 'ci') install = [install[0], 'install', ...install.slice(2)];
  await runCommand(install, 'Frontend install');
  await runCommand(command(config.frontend.buildCommand, 'frontend.buildCommand'), 'Frontend build');
  await assertPlainPath(source, root);
  if (!(await info(source))?.isDirectory()) throw new Error('Frontend build did not create ' + source);
}

// Theme source/output declares only static routes and bounded editable files.
const themeRegistrationPath = path.join(source, 'themes.json');
if ((await info(themeRegistrationPath))?.isFile()) {
  const registration = JSON.parse(await readFile(themeRegistrationPath, 'utf8'));
  const safe = value => typeof value === 'string' && value.split('/').every(part => /^[a-zA-Z0-9_-][a-zA-Z0-9_.-]*$/.test(part) && !['.', '..'].includes(part));
  if (registration.schemaVersion !== 1 || typeof registration.allowVisitorSwitch !== 'boolean' || !Array.isArray(registration.themes) || !registration.themes.length || registration.themes.length > 8 || !registration.themes.some(theme => theme.id === registration.defaultTheme && theme.enabled)) throw new Error('Invalid theme registry or default theme.');
  const ids = new Set(); let configCount = 0;
  for (const theme of registration.themes) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(theme.id) || ids.has(theme.id) || theme.root !== 'themes/' + theme.id || typeof theme.enabled !== 'boolean') throw new Error('Invalid or duplicate theme.');
    ids.add(theme.id); const themeRoot = path.join(source, theme.root);
    await assertPlainPath(themeRoot, source);
    const definitionPath = path.join(themeRoot, 'theme.json'); await assertPlainPath(definitionPath, source);
    const declaration = JSON.parse(await readFile(definitionPath, 'utf8'));
    if (declaration.schemaVersion !== 1 || declaration.id !== theme.id || !declaration.routes?.['/'] || !declaration.routes?.['/admin/'] || !Array.isArray(declaration.configs) || declaration.configs.length > 8) throw new Error('Missing home, admin or config declaration for ' + theme.id);
    for (const [route, targetPath] of Object.entries(declaration.routes)) {
      if (!/^\/(?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_.-]*$/.test(route) || route.split('/').some(part => ['.', '..'].includes(part)) || /^\/(api|media|themes|theme-media)(\/|$)/.test(route) || !safe(targetPath) || !targetPath.endsWith('.html') || /^\/admin(?:\/|$)/.test(route) !== targetPath.startsWith('admin/')) throw new Error('Unsafe theme route: ' + route);
      const filename = path.join(themeRoot, targetPath); await assertPlainPath(filename, source);
      if (!(await info(filename))?.isFile()) throw new Error('Missing theme route asset: ' + targetPath);
    }
    const configIds = new Set(); const configPaths = new Set();
    for (const document of declaration.configs) {
      configCount++;
      if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(document.id) || configIds.has(document.id) || configPaths.has(document.path) || !safe(document.path) || !/^config\/.+\.json$/.test(document.path) || /\.(default|schema|references)\.json$/.test(document.path)) throw new Error('Unsafe or duplicate theme config.');
      configIds.add(document.id); configPaths.add(document.path);
      for (const relative of [document.path, document.defaultPath, document.schemaPath].filter(Boolean)) {
        if (!safe(relative) || !relative.startsWith('config/') || !relative.endsWith('.json')) throw new Error('Unsafe theme default or schema.');
        const filename = path.join(themeRoot, relative); await assertPlainPath(filename, source);
        if (relative === document.path && !(await info(filename)) && document.defaultPath) continue;
        const bytes = await readFile(filename); if (bytes.length > 512 * 1024) throw new Error('Theme configuration exceeds 512 KiB.'); JSON.parse(bytes.toString('utf8'));
      }
    }
    for (const document of declaration.configs) if (configPaths.has(document.defaultPath) || configPaths.has(document.schemaPath)) throw new Error('An editable config overlaps its defaults or schema.');
    for (const media of declaration.bundledMedia || []) {
      if (!safe(media.path) || !media.path.startsWith('assets/images/') || !/^[a-f0-9]{64}$/.test(media.sha256)) throw new Error('Invalid bundled media seed.');
      await assertPlainPath(path.join(themeRoot, media.path), source);
      const bytes = await readFile(path.join(themeRoot, media.path));
      const { createHash } = await import('node:crypto');
      if (bytes.length > 16 * 1024 * 1024 || createHash('sha256').update(bytes).digest('hex') !== media.sha256) throw new Error('Theme media seed digest mismatch.');
    }
  }
  if (configCount > 31) throw new Error('Declare at most 31 theme config documents across installed themes.');
}

if (target !== path.resolve(root, 'dist', 'client') || !inside(dist, target)) throw new Error('Unsafe output directory.');
await assertPlainPath(dist, root);
await assertPlainPath(target, root);
await mkdir(dist, { recursive: true });
if (await realpath(dist) !== dist) throw new Error('dist/ must be a real directory in this repository.');
await mkdir(target, { recursive: true });
// Preserve the asset root: Windows dev watchers may keep this directory open.
for (const entry of await readdir(target, { withFileTypes: true })) {
  const child = path.resolve(target, entry.name);
  if (!inside(target, child)) throw new Error("Unsafe asset cleanup target.");
  await assertPlainPath(child, root);
  await rm(child, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
const count = await copyTree(source, target);
if (!count) {
  await writeFile(path.join(target, 'frontend-not-installed.txt'), 'Frontend is not installed. Place static assets in frontend/ and rebuild.\n', 'utf8');
}
console.log('Frontend assets: ' + count + ' file(s) copied to dist/client' + (!count ? ' (placeholder text asset only).' : '.'));
