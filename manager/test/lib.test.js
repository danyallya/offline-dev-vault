import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PACKAGE_NAME, isScheduleDue, readYaml, run, selectVersions } from '../src/lib.js';

test('selectVersions keeps at least three stable versions newest first', () => {
  assert.deepEqual(selectVersions(['1.0.0', '2.0.0-beta.1', '1.2.0', '1.1.0', '0.9.0'], 2), ['1.2.0', '1.1.0', '1.0.0']);
});
test('selectVersions can include prereleases', () => {
  assert.equal(selectVersions(['1.0.0', '2.0.0-beta.1', '1.1.0', '0.9.0'], 3, true)[0], '2.0.0-beta.1');
});
test('package name validation rejects command-like input', () => {
  assert.ok(PACKAGE_NAME.test('@scope/pkg'));
  assert.ok(PACKAGE_NAME.test('react-dom'));
  assert.ok(!PACKAGE_NAME.test('react; rm -rf /'));
});

test('readYaml preserves settings and lists', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'vault-test-'));
  const path = join(dir, 'config.yaml');
  try {
    await writeFile(path, 'settings:\n  downloadsEnabled: false\nlists:\n  - id: demo\npackages: []\n');
    const config = await readYaml(path);
    assert.equal(config.settings.downloadsEnabled, false);
    assert.equal(config.lists[0].id, 'demo');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('scheduler runs only at the exact slot and never catches up a missed run', () => {
  const schedule = { enabled: true, everyDays: 3, time: '03:00', anchorDate: '2026-08-27' };
  assert.equal(isScheduleDue(schedule, '2026-08-27', '03:00'), true);
  assert.equal(isScheduleDue(schedule, '2026-08-27', '03:01'), false);
  assert.equal(isScheduleDue(schedule, '2026-08-28', '03:00'), false);
  assert.equal(isScheduleDue(schedule, '2026-08-30', '03:00'), true);
});

test('run terminates a child process when cancelled', async () => {
  const controller = new AbortController();
  const pending = run(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { signal: controller.signal });
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending, (error) => error.name === 'AbortError');
});
