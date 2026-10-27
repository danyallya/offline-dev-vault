import { createRequire } from 'node:module';
import { readdir, readFile, mkdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(new URL('../manager/package.json', import.meta.url));
const YAML = require('yaml');
const repoRoot = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = process.argv[2];
if (!sourceRoot) throw new Error('Usage: node tools/import-project-catalog.mjs <projects-root>');

const ignored = new Set(['node_modules', '.next', 'dist', 'build', '.git', '.expo', 'coverage']);
const projectAliases = new Map();
function projectAlias(project) {
  if (!projectAliases.has(project)) {
    projectAliases.set(project, `project-${String(projectAliases.size + 1).padStart(3, '0')}`);
  }
  return projectAliases.get(project);
}
async function walk(dir, names, out = []) {
  for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.isDirectory() && ignored.has(entry.name)) continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await walk(path, names, out);
    else if (names.has(entry.name)) out.push(path);
  }
  return out;
}

const npmMap = new Map();
const manifests = await walk(sourceRoot, new Set(['package.json']));
for (const path of manifests) {
  let json;
  try { json = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
  const project = projectAlias(relative(sourceRoot, dirname(path)).split(/[\\/]/)[0] || basename(dirname(path)));
  for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
    for (const [name, spec] of Object.entries(json[section] || {})) {
      const item = npmMap.get(name) || { ecosystem: 'npm', name, category: 'project', enabled: true, keepVersions: 3, sources: [], requestedVersions: [], projectSpecs: {} };
      if (!item.sources.includes(`project:${project}`)) item.sources.push(`project:${project}`);
      item.projectSpecs[project] ||= [];
      if (!item.projectSpecs[project].includes(spec)) item.projectSpecs[project].push(spec);
      npmMap.set(name, item);
    }
  }
}

// Capture exact direct versions from npm lockfiles without downloading anything.
const locks = await walk(sourceRoot, new Set(['package-lock.json']));
for (const path of locks) {
  let lock;
  try { lock = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
  const root = lock.packages?.[''] || {};
  const direct = new Set(Object.keys({ ...(root.dependencies || {}), ...(root.devDependencies || {}), ...(root.optionalDependencies || {}) }));
  for (const name of direct) {
    const version = lock.packages?.[`node_modules/${name}`]?.version;
    if (version && npmMap.has(name) && !npmMap.get(name).requestedVersions.includes(version)) npmMap.get(name).requestedVersions.push(version);
  }
}

const mavenMap = new Map();
const gradleFiles = await walk(sourceRoot, new Set(['build.gradle', 'build.gradle.kts']));
const coordinatePattern = /(?:implementation|api|compileOnly|runtimeOnly|testImplementation|androidTestImplementation|classpath|ksp|annotationProcessor)\s*(?:\(|\s)\s*["']([^"']+:[^"']+)(?:["'])/g;
for (const path of gradleFiles) {
  const raw = await readFile(path, 'utf8');
  const project = projectAlias(relative(sourceRoot, path).split(/[\\/]/)[0]);
  for (const match of raw.matchAll(coordinatePattern)) {
    const parts = match[1].split(':');
    if (parts.length < 2 || parts[0].includes('$')) continue;
    const name = `${parts[0]}:${parts[1]}`;
    const item = mavenMap.get(name) || { ecosystem: 'maven', name, category: 'kotlin', enabled: false, keepVersions: 3, sources: [], requestedVersions: [] };
    if (!item.sources.includes(`project:${project}`)) item.sources.push(`project:${project}`);
    if (parts[2] && !parts[2].includes('$') && !item.requestedVersions.includes(parts[2])) item.requestedVersions.push(parts[2]);
    mavenMap.set(name, item);
  }
}

const catalogDir = join(repoRoot, 'config', 'catalogs');
await mkdir(catalogDir, { recursive: true });
const projectCatalog = { generatedAt: new Date().toISOString(), source: 'local-projects', packages: [...npmMap.values(), ...mavenMap.values()].sort((a, b) => `${a.ecosystem}:${a.name}`.localeCompare(`${b.ecosystem}:${b.name}`)) };
await writeFile(join(catalogDir, 'project-packages.yaml'), YAML.stringify(projectCatalog), 'utf8');

const popular = YAML.parse(await readFile(join(catalogDir, 'popular-150.yaml'), 'utf8'));
if (popular.packages.length !== 150) throw new Error(`popular-150.yaml must contain exactly 150 entries, found ${popular.packages.length}`);

const merged = new Map(projectCatalog.packages.map((item) => [`${item.ecosystem}:${item.name}`, item]));
for (const popularItem of popular.packages) {
  const key = `${popularItem.ecosystem}:${popularItem.name}`;
  const item = merged.get(key) || { ...popularItem, enabled: popularItem.ecosystem === 'npm', keepVersions: 3, sources: [], requestedVersions: [] };
  if (!item.sources.includes('popular-150')) item.sources.push('popular-150');
  if (item.category === 'project') item.category = popularItem.category;
  merged.set(key, item);
}

const projectRefs = projectCatalog.packages.map((item) => `${item.ecosystem}:${item.name}`);
const popularRefs = popular.packages.map((item) => `${item.ecosystem}:${item.name}`);
const allNpmRefs = [...merged.values()].filter((item) => item.ecosystem === 'npm').map((item) => `npm:${item.name}`);
const config = {
  settings: {
    downloadsEnabled: false,
    schedulerEnabled: false,
    missedRunPolicy: 'skip',
    defaultKeepVersions: 3,
    defaultSchedule: { everyDays: 1, time: '03:00', mode: 'check' }
  },
  lists: [
    { id: 'project-packages', name: 'پکیج‌های پروژه‌های محلی', packageRefs: projectRefs, schedule: { enabled: false, everyDays: 1, time: '03:00', mode: 'check', anchorDate: new Date().toISOString().slice(0, 10) } },
    { id: 'popular-150', name: '۱۵۰ پکیج محبوب پیشنهادی', packageRefs: popularRefs, schedule: { enabled: false, everyDays: 7, time: '04:00', mode: 'check', anchorDate: new Date().toISOString().slice(0, 10) } },
    { id: 'all-npm', name: 'تمام پکیج‌های npm', packageRefs: allNpmRefs, schedule: { enabled: false, everyDays: 7, time: '03:30', mode: 'check', anchorDate: new Date().toISOString().slice(0, 10) } }
  ],
  packages: [...merged.values()].sort((a, b) => `${a.ecosystem}:${a.name}`.localeCompare(`${b.ecosystem}:${b.name}`))
};
await writeFile(join(repoRoot, 'config', 'packages.yaml'), YAML.stringify(config), 'utf8');
console.log(JSON.stringify({ manifests: manifests.length, lockfiles: locks.length, gradleFiles: gradleFiles.length, projectPackages: projectCatalog.packages.length, popularPackages: popular.packages.length, mergedPackages: config.packages.length }, null, 2));
