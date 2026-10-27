import { spawn } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import YAML from 'yaml';
import semver from 'semver';

export const PACKAGE_NAME = /^(?:@[a-z0-9][a-z0-9._~-]*\/[a-z0-9][a-z0-9._~-]*|[a-z0-9][a-z0-9._~-]*)$/i;

export async function readYaml(path) {
  const raw = await readFile(path, 'utf8');
  const parsed = YAML.parse(raw) ?? {};
  return { ...parsed, packages: Array.isArray(parsed.packages) ? parsed.packages : [] };
}

export async function atomicYaml(path, value) {
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, YAML.stringify(value), { encoding: 'utf8', flag: 'wx' });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    throw error;
  }
}

export async function atomicJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}

export async function directorySize(path) {
  try {
    const stat = await lstat(path);
    if (stat.isFile()) return stat.size;
    if (!stat.isDirectory()) return 0;
    const entries = await readdir(path, { withFileTypes: true });
    const sizes = await Promise.all(entries.map((entry) => directorySize(join(path, entry.name))));
    return sizes.reduce((sum, size) => sum + size, 0);
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'EACCES') return 0;
    throw error;
  }
}

export function selectVersions(allVersions, count, includePrerelease = false) {
  const valid = allVersions
    .filter((version) => semver.valid(version))
    .filter((version) => includePrerelease || !semver.prerelease(version))
    .sort(semver.rcompare);
  return valid.slice(0, Math.max(3, Number(count) || 3));
}

export function addCachedVersion(cachedVersions, version) {
  return [...new Set([...(Array.isArray(cachedVersions) ? cachedVersions : []), version])];
}

export function isScheduleDue(schedule, currentDate, currentTime) {
  if (!schedule?.enabled || schedule.time !== currentTime) return false;
  const anchor = Date.parse(`${schedule.anchorDate || currentDate}T00:00:00Z`);
  const current = Date.parse(`${currentDate}T00:00:00Z`);
  const days = Number.isFinite(anchor) ? Math.floor((current - anchor) / 86_400_000) : 0;
  return days >= 0 && days % Math.max(1, Number(schedule.everyDays || 1)) === 0;
}

export function run(command, args, { cwd, timeoutMs = 120000, onLine = () => {}, logStdout = true, signal: abortSignal } = {}) {
  return new Promise((resolve, reject) => {
    if (abortSignal?.aborted) return reject(Object.assign(new Error('Operation cancelled'), { name: 'AbortError' }));
    const detached = process.platform !== 'win32';
    const child = spawn(command, args, { cwd, shell: false, detached, env: { ...process.env, NO_UPDATE_NOTIFIER: '1' } });
    let stdout = '';
    let stderr = '';
    const capture = (key) => (chunk) => {
      const text = chunk.toString();
      if (key === 'stdout') stdout += text; else stderr += text;
      if (key === 'stderr' || logStdout) {
        for (const line of text.split(/\r?\n/).filter(Boolean)) onLine(line);
      }
    };
    child.stdout.on('data', capture('stdout'));
    child.stderr.on('data', capture('stderr'));
    const kill = (force = false) => {
      try { if (detached && child.pid) process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); else child.kill(force ? 'SIGKILL' : 'SIGTERM'); } catch {}
    };
    const abort = () => { kill(false); setTimeout(() => kill(true), 2000).unref(); };
    abortSignal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => kill(true), timeoutMs);
    child.on('error', (error) => { clearTimeout(timer); abortSignal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', (code, closeSignal) => {
      clearTimeout(timer);
      abortSignal?.removeEventListener('abort', abort);
      if (abortSignal?.aborted) return reject(Object.assign(new Error('Operation cancelled'), { name: 'AbortError' }));
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code ?? closeSignal}: ${stderr || stdout}`));
    });
  });
}

export async function discoverVersions(name, registry, timeoutMs, onLine, signal) {
  const result = await run('npm', ['view', name, 'versions', '--json', `--registry=${registry}`, '--prefer-online'], { timeoutMs, onLine, logStdout: false, signal });
  const parsed = JSON.parse(result.stdout);
  return Array.isArray(parsed) ? parsed : [parsed];
}

export async function prefetchTree(name, version, registry, timeoutMs, onLine, signal) {
  const work = join(tmpdir(), `vault-${randomUUID()}`);
  await mkdir(work, { recursive: true });
  await writeFile(join(work, 'package.json'), JSON.stringify({ name: 'vault-prefetch', private: true, version: '1.0.0' }));
  try {
    await run('npm', [
      'install', `${name}@${version}`,
      `--registry=${registry}`,
      `--cache=${join(work, '.npm-cache')}`,
      '--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps', '--include=optional', '--save-exact'
    ], { cwd: work, timeoutMs: timeoutMs * 5, onLine, signal });
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
