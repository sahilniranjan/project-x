import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseScanHistoryLine } from '../lib/scan-history-columns.mjs';
import { describeSpawn } from './helpers/describe-spawn.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const URL = 'https://boards.example.com/fixture/close-date';
const PATH_VARS = [
  'PROJECT_X_PORTALS',
  'PROJECT_X_PROFILE',
  'PROJECT_X_PIPELINE',
  'PROJECT_X_SCAN_HISTORY',
  'PROJECT_X_ROOT',
  'PROJECT_X_DATA_DIR',
  'PROJECT_X_TRACKER',
  'FIXTURE_CLOSES_AT',
];

const PORTALS = `title_filter:
  positive:
    - "Strategic Finance"
tracked_companies:
  - name: Fixture Defense
    careers_url: https://boards.example.com/fixture
    parser:
      command: node
      script: tests/fixtures/close-date-board.mjs
`;

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'project-x-close-refresh-'));
  mkdirSync(join(dir, 'data'));
  writeFileSync(join(dir, 'data', 'applications.md'), '# Applications\n');
  writeFileSync(join(dir, 'portals.yml'), PORTALS);
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function childEnv(dir, closesAt) {
  const env = { ...process.env, PROJECT_X_ROOT: dir, PROJECT_X_HTTP_CACHE: '0' };
  for (const name of PATH_VARS) delete env[name];
  env.PROJECT_X_ROOT = dir;
  if (closesAt) env.FIXTURE_CLOSES_AT = closesAt;
  return env;
}

function runScan(dir, closesAt) {
  return spawnSync(process.execPath, [join(ROOT, 'scan.mjs')], {
    cwd: dir,
    encoding: 'utf-8',
    env: childEnv(dir, closesAt),
  });
}

function dataRows(dir) {
  const text = readFileSync(join(dir, 'data', 'scan-history.tsv'), 'utf-8');
  return text.split('\n').filter((line) => line.startsWith('https://')).map(parseScanHistoryLine);
}

test('a new posting records its close day, and a later scan does not rewrite it', () => {
  const box = sandbox();
  try {
    const first = runScan(box.dir, '2026-10-03');
    assert.equal(first.status, 0, describeSpawn(first));
    const added = dataRows(box.dir);
    assert.equal(added.length, 1);
    assert.equal(added[0].status, 'added');
    assert.equal(added[0].closes_at, '2026-10-03');

    const second = runScan(box.dir, '2026-12-01');
    assert.equal(second.status, 0, describeSpawn(second));
    const rows = dataRows(box.dir);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'added');
    assert.equal(rows[0].closes_at, '2026-10-03');
  } finally {
    box.cleanup();
  }
});
