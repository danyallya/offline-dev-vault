import Fastify from 'fastify';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import semver from 'semver';
import {
  PACKAGE_NAME, addCachedVersion, atomicJson, atomicYaml, directorySize, discoverVersions, isScheduleDue, prefetchTree,
  readJson, readYaml, selectVersions
} from './lib.js';

const app = Fastify({ logger: true, bodyLimit: 2 * 1024 * 1024 });
const port = Number(process.env.PORT || 7373);
const registry = process.env.REGISTRY_URL || 'http://registry:4873';
const publicRegistry = process.env.PUBLIC_REGISTRY_URL || 'http://localhost:4873';
const packagesFile = process.env.PACKAGES_FILE || '/config/packages.yaml';
const dataDir = process.env.DATA_DIR || '/data';
const storageRoot = process.env.REGISTRY_STORAGE_PATH || '/registry-storage';
const stateFile = join(dataDir, 'state.json');
const jobsFile = join(dataDir, 'jobs.json');
const envDefaultKeep = Math.max(3, Number(process.env.DEFAULT_KEEP_VERSIONS || 3));
const timeoutMs = Number(process.env.NPM_FETCH_TIMEOUT_MS || 120000);
const publicDir = fileURLToPath(new URL('../public/', import.meta.url));
const VALID_TIME = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const VALID_ID = /^[a-z0-9][a-z0-9-]{1,49}$/;

await mkdir(dataDir, { recursive: true });
let state = await readJson(stateFile, { packages: {}, lastSyncAt: null, scheduleSlots: {}, scheduleEvents: {} });
state.scheduleSlots ||= {};
state.scheduleEvents ||= {};
let jobs = await readJson(jobsFile, []);
let activeJob = null;
let activeAbortController = null;

const stamp = () => new Date().toISOString();
const packageRef = (item) => `${item.ecosystem || 'npm'}:${item.name}`;
const packageRuntime = (item) => state.packages[packageRef(item)] || state.packages[item.name] || null;
const persistState = () => atomicJson(stateFile, state);
const persistJobs = () => atomicJson(jobsFile, jobs.slice(0, 50));

async function loadConfig() {
  const config = await readYaml(packagesFile);
  config.settings ||= {};
  config.settings.downloadsEnabled ??= false;
  config.settings.schedulerEnabled ??= false;
  config.settings.missedRunPolicy = 'skip';
  config.settings.defaultKeepVersions = Math.max(3, Number(config.settings.defaultKeepVersions || envDefaultKeep));
  config.settings.defaultSchedule ||= { everyDays: 1, time: '03:00', mode: 'check' };
  config.lists = Array.isArray(config.lists) ? config.lists : [];
  config.packages = config.packages.map((item) => ({ ecosystem: 'npm', enabled: true, keepVersions: config.settings.defaultKeepVersions, sources: [], requestedVersions: [], ...item }));
  return config;
}

function logJob(job, message) {
  job.logs.push({ at: stamp(), message: String(message).slice(0, 2000) });
  if (job.logs.length > 500) job.logs.shift();
  app.log.info({ jobId: job.id }, message);
}

function desiredVersions(item, available, defaultKeep) {
  const latest = selectVersions(available, Math.max(3, Number(item.keepVersions || defaultKeep)), Boolean(item.includePrerelease));
  const requested = (item.requestedVersions || []).filter((version) => semver.valid(version));
  return [...new Set([...latest, ...requested])];
}

async function inspectPackage(item, job, config) {
  if (job.cancelRequested) throw Object.assign(new Error('Operation cancelled'), { name: 'AbortError' });
  const ref = packageRef(item);
  const current = packageRuntime(item) || {};
  state.packages[ref] = { ...current, status: 'checking', lastAttemptAt: stamp() };
  await persistState();
  logJob(job, `${item.name}: checking metadata (no tarball download)`);
  try {
    const all = await discoverVersions(item.name, registry, timeoutMs, (line) => logJob(job, `${item.name}: ${line}`), activeAbortController?.signal);
    const desired = desiredVersions(item, all, config.settings.defaultKeepVersions);
    if (!desired.length) throw new Error('No valid versions returned by registry');
    const cached = new Set(current.cachedVersions || []);
    const pending = desired.filter((version) => !cached.has(version));
    state.packages[ref] = {
      ...current,
      managedVersions: desired,
      latestAvailable: desired[0],
      pendingVersions: pending,
      updateAvailable: pending.length > 0,
      lastCheckAt: stamp(),
      status: pending.length ? 'update_available' : cached.size ? 'ready' : 'not_cached',
      error: null
    };
    job.results.push({ ref, name: item.name, ok: true, mode: 'check', versions: desired, pendingVersions: pending });
    return { desired, current: state.packages[ref] };
  } catch (error) {
    if (job.cancelRequested || error.name === 'AbortError') {
      state.packages[ref] = { ...current, status: 'cancelled', error: null, lastAttemptAt: stamp() };
      throw error;
    }
    state.packages[ref] = { ...current, status: 'error', error: error.message, lastAttemptAt: stamp() };
    job.results.push({ ref, name: item.name, ok: false, error: error.message });
    logJob(job, `${item.name}: ERROR ${error.message}`);
    return null;
  } finally {
    await persistState();
  }
}

async function syncPackage(item, job, config) {
  const inspected = await inspectPackage(item, job, config);
  if (!inspected) return;
  const ref = packageRef(item);
  const cached = new Set(inspected.current.cachedVersions || []);
  for (const version of inspected.desired.slice().reverse()) {
    if (job.cancelRequested) throw Object.assign(new Error('Operation cancelled'), { name: 'AbortError' });
    if (cached.has(version)) {
      logJob(job, `${item.name}@${version}: already cached`);
      continue;
    }
    logJob(job, `${item.name}@${version}: caching package and dependency tree`);
    try {
      await prefetchTree(item.name, version, registry, timeoutMs, (line) => logJob(job, `${item.name}@${version}: ${line}`), activeAbortController?.signal);
      cached.add(version);
      state.packages[ref] = { ...state.packages[ref], cachedVersions: addCachedVersion([...cached], version), status: 'syncing', lastSyncAt: stamp() };
      await persistState();
    } catch (error) {
      if (job.cancelRequested || error.name === 'AbortError') {
        state.packages[ref] = { ...state.packages[ref], status: 'cancelled', error: null };
        await persistState();
        throw error;
      }
      state.packages[ref] = { ...state.packages[ref], status: 'error', error: error.message };
      const result = job.results.find((entry) => entry.ref === ref);
      if (result) { result.ok = false; result.error = error.message; }
      logJob(job, `${item.name}@${version}: ERROR ${error.message}`);
      await persistState();
      return;
    }
  }
  state.packages[ref] = { ...state.packages[ref], cachedVersions: [...new Set([...inspected.desired, ...cached])], pendingVersions: [], updateAvailable: false, status: 'ready', lastSyncAt: stamp(), error: null };
  const result = job.results.find((entry) => entry.ref === ref);
  if (result) result.mode = 'sync';
  await persistState();
}

async function runJob(job, selection) {
  if (job.cancelRequested || job.status === 'cancelled') return;
  activeJob = job;
  activeAbortController = new AbortController();
  job.status = 'running';
  job.startedAt = stamp();
  await persistJobs();
  try {
    const config = await loadConfig();
    let refs = selection.refs;
    if (selection.listId) {
      const list = config.lists.find((entry) => entry.id === selection.listId);
      if (!list) throw new Error('List not found');
      refs = list.packageRefs;
    }
    const manualSelection = !selection.listId && Array.isArray(selection.refs) && selection.refs.length > 0;
    const wanted = refs?.length ? new Set(refs) : null;
    const selectedItems = config.packages.filter((item) => (manualSelection || item.enabled !== false) && (!wanted || wanted.has(packageRef(item)) || wanted.has(item.name)));
    if (!selectedItems.length) throw new Error('No enabled packages selected');
    const unsupportedItems = selectedItems.filter((item) => item.ecosystem !== 'npm');
    const items = selectedItems.filter((item) => item.ecosystem === 'npm');
    job.total = selectedItems.length;
    for (const item of unsupportedItems) {
      if (job.cancelRequested) throw Object.assign(new Error('Operation cancelled'), { name: 'AbortError' });
      job.current += 1;
      job.currentPackage = item.name;
      const error = 'Maven/Kotlin is catalog-only; metadata checks and downloads currently support npm packages only.';
      job.results.push({ ref: packageRef(item), name: item.name, ok: false, error });
      logJob(job, `${item.name}: ${error}`);
      await persistJobs();
    }
    for (let index = 0; index < items.length; index++) {
      if (job.cancelRequested) throw Object.assign(new Error('Operation cancelled'), { name: 'AbortError' });
      job.current = unsupportedItems.length + index + 1;
      job.currentPackage = items[index].name;
      if (job.mode === 'sync') await syncPackage(items[index], job, config);
      else await inspectPackage(items[index], job, config);
      await persistJobs();
    }
    if (job.mode === 'sync') state.lastSyncAt = stamp(); else state.lastCheckAt = stamp();
    job.status = job.results.some((result) => !result.ok) ? 'completed_with_errors' : 'completed';
  } catch (error) {
    if (job.cancelRequested || error.name === 'AbortError') {
      job.status = 'cancelled';
      job.error = null;
      logJob(job, 'Operation cancelled by user');
    } else {
      job.status = 'failed';
      job.error = error.message;
      logJob(job, `JOB ERROR: ${error.message}`);
    }
  } finally {
    job.finishedAt = stamp();
    job.currentPackage = null;
    activeJob = null;
    activeAbortController = null;
    await Promise.all([persistJobs(), persistState()]);
  }
}

async function enqueue(selection = {}, source = 'manual', mode = 'check') {
  if (activeJob) return { conflict: true, job: activeJob };
  const config = await loadConfig();
  if (mode === 'sync' && !config.settings.downloadsEnabled) return { locked: true };
  const job = { id: crypto.randomUUID(), source, mode, listId: selection.listId || null, status: 'queued', createdAt: stamp(), total: 0, current: 0, results: [], logs: [] };
  jobs.unshift(job);
  void persistJobs().then(() => runJob(job, selection));
  return { job };
}

async function storageReport() {
  const config = await loadConfig();
  const npmItems = config.packages.filter((item) => item.ecosystem === 'npm');
  const rows = await Promise.all(npmItems.map(async (item) => ({ ref: packageRef(item), name: item.name, bytes: await directorySize(join(storageRoot, ...item.name.split('/'))) })));
  const totalBytes = await directorySize(storageRoot);
  return { totalBytes, packageBytes: Object.fromEntries(rows.map((row) => [row.ref, row.bytes])), topPackages: rows.filter((row) => row.bytes > 0).sort((a, b) => b.bytes - a.bytes).slice(0, 20), measuredAt: stamp() };
}

app.get('/api/health', async () => ({ ok: true, activeJob: activeJob?.id || null, registry }));
app.get('/api/settings', async () => ({ ...(await loadConfig()).settings, registryUrl: publicRegistry }));
app.patch('/api/settings', async (request, reply) => {
  const config = await loadConfig();
  const body = request.body || {};
  if ('downloadsEnabled' in body) config.settings.downloadsEnabled = Boolean(body.downloadsEnabled);
  if ('schedulerEnabled' in body) config.settings.schedulerEnabled = Boolean(body.schedulerEnabled);
  if ('defaultKeepVersions' in body) config.settings.defaultKeepVersions = Math.max(3, Math.min(20, Number(body.defaultKeepVersions) || 3));
  if (body.defaultSchedule) {
    const everyDays = Math.max(1, Math.min(365, Number(body.defaultSchedule.everyDays) || 1));
    const time = String(body.defaultSchedule.time || '03:00');
    if (!VALID_TIME.test(time)) return reply.code(400).send({ error: 'Invalid schedule time' });
    config.settings.defaultSchedule = { everyDays, time, mode: body.defaultSchedule.mode === 'sync' ? 'sync' : 'check' };
  }
  await atomicYaml(packagesFile, config);
  return config.settings;
});

app.get('/api/packages', async () => {
  const config = await loadConfig();
  const memberships = new Map();
  for (const list of config.lists) for (const ref of list.packageRefs || []) { const value = memberships.get(ref) || []; value.push(list.id); memberships.set(ref, value); }
  return { packages: config.packages.map((item) => ({ ...item, ref: packageRef(item), listIds: memberships.get(packageRef(item)) || [], runtime: packageRuntime(item) })), lists: config.lists, lastSyncAt: state.lastSyncAt, lastCheckAt: state.lastCheckAt };
});
app.post('/api/packages', async (request, reply) => {
  const { name, ecosystem = 'npm', category = 'custom', keepVersions, enabled = true, includePrerelease = false } = request.body || {};
  if (!['npm', 'maven'].includes(ecosystem)) return reply.code(400).send({ error: 'Unsupported ecosystem' });
  if (typeof name !== 'string' || (ecosystem === 'npm' ? !PACKAGE_NAME.test(name) : !/^[\w.-]+:[\w.-]+$/.test(name))) return reply.code(400).send({ error: 'Invalid package name' });
  const config = await loadConfig();
  if (config.packages.some((item) => packageRef(item) === `${ecosystem}:${name}`)) return reply.code(409).send({ error: 'Package already exists' });
  config.packages.push({ ecosystem, name, category: String(category).slice(0, 40), keepVersions: Math.max(3, Number(keepVersions || config.settings.defaultKeepVersions)), enabled: Boolean(enabled), includePrerelease: Boolean(includePrerelease), sources: ['manual'], requestedVersions: [] });
  await atomicYaml(packagesFile, config);
  return reply.code(201).send({ ok: true });
});
app.patch('/api/packages/bulk', async (request, reply) => {
  const body = request.body || {};
  const refs = Array.isArray(body.refs) ? [...new Set(body.refs.filter((ref) => typeof ref === 'string'))] : [];
  if (!refs.length || refs.length > 5000 || typeof body.enabled !== 'boolean') return reply.code(400).send({ error: 'Provide 1–5000 package refs and a boolean enabled value' });
  const config = await loadConfig();
  const byRef = new Map(config.packages.map((item) => [packageRef(item), item]));
  const missing = refs.filter((ref) => !byRef.has(ref));
  if (missing.length) return reply.code(404).send({ error: `Unknown package refs: ${missing.slice(0, 10).join(', ')}` });
  for (const ref of refs) byRef.get(ref).enabled = body.enabled;
  await atomicYaml(packagesFile, config);
  return { ok: true, updated: refs.length, enabled: body.enabled };
});
app.patch('/api/packages/:ref', async (request, reply) => {
  const value = decodeURIComponent(request.params.ref);
  const config = await loadConfig();
  const item = config.packages.find((entry) => packageRef(entry) === value || entry.name === value);
  if (!item) return reply.code(404).send({ error: 'Package not found' });
  if ('enabled' in request.body) item.enabled = Boolean(request.body.enabled);
  if ('keepVersions' in request.body) item.keepVersions = Math.max(3, Math.min(20, Number(request.body.keepVersions) || config.settings.defaultKeepVersions));
  if ('includePrerelease' in request.body) item.includePrerelease = Boolean(request.body.includePrerelease);
  await atomicYaml(packagesFile, config);
  return { ok: true };
});
app.delete('/api/packages/:ref', async (request, reply) => {
  const value = decodeURIComponent(request.params.ref);
  const config = await loadConfig();
  const item = config.packages.find((entry) => packageRef(entry) === value || entry.name === value);
  if (!item) return reply.code(404).send({ error: 'Package not found' });
  const ref = packageRef(item);
  config.packages = config.packages.filter((entry) => packageRef(entry) !== ref);
  for (const list of config.lists) list.packageRefs = (list.packageRefs || []).filter((entry) => entry !== ref);
  await atomicYaml(packagesFile, config);
  return { ok: true, note: 'Removed from catalog; cached files were preserved.' };
});

app.get('/api/lists', async () => ({ lists: (await loadConfig()).lists, scheduleEvents: state.scheduleEvents }));
app.post('/api/lists', async (request, reply) => {
  const config = await loadConfig();
  const body = request.body || {};
  const slug = String(body.id || body.name || '').toLowerCase().trim().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);
  const id = VALID_ID.test(slug) ? slug : `list-${Date.now().toString(36)}`;
  if (config.lists.some((list) => list.id === id)) return reply.code(409).send({ error: 'List already exists' });
  const validRefs = new Set(config.packages.map(packageRef));
  const refs = [...new Set((body.packageRefs || []).filter((ref) => validRefs.has(ref)))];
  const time = String(body.schedule?.time || config.settings.defaultSchedule.time);
  if (!VALID_TIME.test(time)) return reply.code(400).send({ error: 'Invalid schedule time' });
  const list = { id, name: String(body.name || id).slice(0, 100), packageRefs: refs, schedule: { enabled: Boolean(body.schedule?.enabled), everyDays: Math.max(1, Math.min(365, Number(body.schedule?.everyDays || 1))), time, mode: body.schedule?.mode === 'sync' ? 'sync' : 'check', anchorDate: body.schedule?.anchorDate || new Date().toISOString().slice(0, 10) } };
  config.lists.push(list);
  await atomicYaml(packagesFile, config);
  return reply.code(201).send(list);
});
app.patch('/api/lists/:id', async (request, reply) => {
  const config = await loadConfig();
  const list = config.lists.find((entry) => entry.id === request.params.id);
  if (!list) return reply.code(404).send({ error: 'List not found' });
  const body = request.body || {};
  if ('name' in body) list.name = String(body.name).slice(0, 100);
  if (Array.isArray(body.packageRefs)) { const valid = new Set(config.packages.map(packageRef)); list.packageRefs = [...new Set(body.packageRefs.filter((ref) => valid.has(ref)))]; }
  if (body.schedule) {
    const time = String(body.schedule.time ?? list.schedule.time);
    if (!VALID_TIME.test(time)) return reply.code(400).send({ error: 'Invalid schedule time' });
    list.schedule = { ...list.schedule, enabled: body.schedule.enabled ?? list.schedule.enabled, everyDays: Math.max(1, Math.min(365, Number(body.schedule.everyDays ?? list.schedule.everyDays))), time, mode: (body.schedule.mode ?? list.schedule.mode) === 'sync' ? 'sync' : 'check', anchorDate: body.schedule.anchorDate || list.schedule.anchorDate };
  }
  await atomicYaml(packagesFile, config);
  return list;
});
app.delete('/api/lists/:id', async (request, reply) => {
  const config = await loadConfig();
  const count = config.lists.length;
  config.lists = config.lists.filter((entry) => entry.id !== request.params.id);
  if (config.lists.length === count) return reply.code(404).send({ error: 'List not found' });
  await atomicYaml(packagesFile, config);
  return { ok: true };
});
app.post('/api/lists/:id/run', async (request, reply) => {
  const mode = request.body?.mode === 'sync' ? 'sync' : 'check';
  const result = await enqueue({ listId: request.params.id }, 'manual-list', mode);
  if (result.locked) return reply.code(423).send({ error: 'Downloads are disabled in settings' });
  return reply.code(result.conflict ? 409 : 202).send(result.conflict ? { error: 'A job is already running', job: result.job } : result.job);
});

async function handleJobRequest(request, reply, mode) {
  const refs = Array.isArray(request.body?.refs) ? request.body.refs.filter((ref) => typeof ref === 'string') : Array.isArray(request.body?.names) ? request.body.names : null;
  const result = await enqueue({ refs }, 'manual', mode);
  if (result.locked) return reply.code(423).send({ error: 'Downloads are disabled in settings' });
  return reply.code(result.conflict ? 409 : 202).send(result.conflict ? { error: 'A job is already running', job: result.job } : result.job);
}
app.post('/api/check', (request, reply) => handleJobRequest(request, reply, 'check'));
app.post('/api/sync', (request, reply) => handleJobRequest(request, reply, 'sync'));
app.get('/api/jobs', async () => ({ activeJob, jobs: jobs.slice(0, 20) }));
app.get('/api/jobs/:id', async (request, reply) => jobs.find((entry) => entry.id === request.params.id) || reply.code(404).send({ error: 'Job not found' }));
app.post('/api/jobs/:id/cancel', async (request, reply) => {
  const requested = jobs.find((entry) => entry.id === request.params.id);
  if (!requested) return reply.code(404).send({ error: 'Job not found' });
  if (!activeJob || activeJob.id !== request.params.id) {
    if (requested.status === 'queued') {
      requested.cancelRequested = true;
      requested.status = 'cancelled';
      requested.finishedAt = stamp();
      logJob(requested, 'Queued operation cancelled by user');
      await persistJobs();
      return reply.code(202).send({ ok: true, status: 'cancelled' });
    }
    return reply.code(409).send({ error: 'Job is not running', status: requested.status });
  }
  if (activeJob.cancelRequested) return reply.code(202).send({ ok: true, status: 'cancelling' });
  activeJob.cancelRequested = true;
  activeJob.status = 'cancelling';
  logJob(activeJob, 'Cancellation requested by user');
  activeAbortController?.abort();
  await persistJobs();
  return reply.code(202).send({ ok: true, status: 'cancelling' });
});
app.get('/api/storage', storageReport);

app.get('/', async (_request, reply) => reply.type('text/html').send(await readFile(join(publicDir, 'index.html'), 'utf8')));
app.get('/app.js', async (_request, reply) => reply.type('application/javascript').send(await readFile(join(publicDir, 'app.js'), 'utf8')));
app.get('/style.css', async (_request, reply) => reply.type('text/css').send(await readFile(join(publicDir, 'style.css'), 'utf8')));

setInterval(async () => {
  if (activeJob) return;
  try {
    const config = await loadConfig();
    if (!config.settings.schedulerEnabled) return;
    const now = new Date();
    const date = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const time = now.toTimeString().slice(0, 5);
    for (const list of config.lists) {
      const schedule = list.schedule || {};
      if (!isScheduleDue(schedule, date, time)) continue;
      const slot = `${date}T${time}`;
      if (state.scheduleSlots[list.id] === slot) continue;
      state.scheduleSlots[list.id] = slot;
      if (schedule.mode === 'sync' && !config.settings.downloadsEnabled) {
        state.scheduleEvents[list.id] = { at: stamp(), status: 'skipped', reason: 'downloads_disabled' };
        await persistState();
        continue;
      }
      state.scheduleEvents[list.id] = { at: stamp(), status: 'triggered', mode: schedule.mode || 'check' };
      await persistState();
      await enqueue({ listId: list.id }, `schedule:${list.id}`, schedule.mode || 'check');
      break;
    }
  } catch (error) { app.log.error(error, 'scheduler tick failed'); }
}, 30_000).unref();

await app.listen({ port, host: '0.0.0.0' });
