// The published bundle: isomorphism, snapshot shape, and the privacy guarantee.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { buildSnapshot } from '../bin/snapshot.js';
import { normalizeAvailabilities } from '../core/ovh.js';

const run = promisify(execFile);
const ROOT = path.join(import.meta.dirname, '..');

// Modules the browser imports. If any of these grows a node: import, the public
// page breaks with a module resolution error and the server keeps working — the
// failure would show up only in production, so it is pinned here instead.
const ISOMORPHIC = ['ovh.js', 'watches.js', 'state.js', 'history.js', 'deeplink.js'];

test('the browser-facing core uses no node: builtins', async () => {
  for (const f of ISOMORPHIC) {
    const src = await readFile(path.join(ROOT, 'core', f), 'utf8');
    const hits = src.match(/from\s+['"]node:[^'"]+['"]/g);
    assert.equal(hits, null, `core/${f} imports ${hits?.join(', ')}`);
  }
});

test('the browser-facing core imports only from within itself', async () => {
  for (const f of ISOMORPHIC) {
    const src = await readFile(path.join(ROOT, 'core', f), 'utf8');
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = path.basename(m[1]);
      assert.ok(ISOMORPHIC.includes(target), `core/${f} imports ${m[1]}, which is not shipped to the browser`);
    }
  }
});

test('the client imports core with relative paths', async () => {
  // GitHub Pages serves a project site from a subpath, where /core/… would 404.
  for (const f of ['app.js', 'transport.js']) {
    const src = await readFile(path.join(ROOT, 'public', f), 'utf8');
    for (const m of src.matchAll(/from\s+['"]([^'"]+)['"]/g)) {
      assert.ok(m[1].startsWith('./'), `public/${f} imports ${m[1]}; must be relative`);
    }
  }
});

const rows = [
  {
    fqn: 'a.1', planCode: '24rise01-v1', memory: 'ram-128g-ecc-2933', storage: 'softraid-2x1920nvme',
    datacenters: [{ datacenter: 'bhs', availability: '1H-low' }, { datacenter: 'gra', availability: '24H' }],
  },
  {
    fqn: 'b.1', planCode: '23scaleamd01-v2', memory: 'ram-128g-ecc-2133', storage: 'noraid-0',
    systemStorage: 'softraid-2x960nvme',
    datacenters: [{ datacenter: 'bhs', availability: '1H-low' }],
  },
  {
    fqn: 'c.1', planCode: '24sk102', memory: 'ram-32g-ecc-2133', storage: 'softraid-2x2000sa',
    datacenters: [{ datacenter: 'lon', availability: 'unavailable' }],
  },
];

function snap() {
  const configs = normalizeAvailabilities(rows, {});
  return buildSnapshot(configs, { now: 1_700_000_000_000, subsidiary: 'CA', catalog: { ok: true, count: 98 }, durationMs: 2000, events: [] });
}

test('the primary snapshot is eco-only and orderable-only', () => {
  const s = snap();
  // Scale is non-eco; the Kimsufi row has no stock anywhere.
  assert.deepEqual(s.primary.configs.map((c) => c.p), ['24rise01-v1']);
  // The full file keeps everything for browsing.
  assert.equal(s.full.configs.length, 3);
});

test('a row keeps its complete datacenter map, so the matrix can draw every state', () => {
  const [row] = snap().primary.configs;
  assert.deepEqual(row.d, { bhs: '1H-low', gra: '24H' });
});

test('the snapshot states its cadence rather than implying a live feed', () => {
  const { cadence } = snap().primary.meta;
  assert.equal(cadence.kind, 'scheduled');
  assert.equal(cadence.everyMinutes, 5);
  assert.match(cadence.note, /delayed or dropped/);
});

test('datacenter columns are grouped and carry short labels', () => {
  const cols = snap().primary.dcs;
  assert.deepEqual(cols.map((c) => c.code), ['bhs', 'gra', 'lon']);
  assert.ok(cols.every((c) => c.short && c.short.length <= 5));
});

test('the snapshot contains nothing about any watch', () => {
  // The privacy guarantee, asserted rather than assumed.
  const text = JSON.stringify(snap());
  for (const forbidden of ['watch', 'Watch', 'channel', 'telegram', 'notify', 'quiet', 'cooldown']) {
    assert.ok(!text.includes(forbidden), `snapshot leaks "${forbidden}"`);
  }
});

test('the static build ships the client and the browser core, and nothing server-side', async () => {
  const out = await mkdtemp(path.join(tmpdir(), 'kw-build-'));
  try {
    await run(process.execPath, [path.join(ROOT, 'bin', 'build-static.js'), '--out', out]);
    const files = await readdir(out);
    for (const f of ['index.html', 'app.js', 'transport.js', 'styles.css', 'config.js', '.nojekyll']) {
      assert.ok(files.includes(f), `missing ${f}`);
    }
    const core = await readdir(path.join(out, 'core'));
    assert.deepEqual(core.sort(), [...ISOMORPHIC].sort());
    // Server-side code must never reach a public bundle.
    assert.ok(!core.includes('notify'));
    assert.ok(!core.includes('store-node.js'));
    assert.ok(!core.includes('poll.js'));

    const cfg = await readFile(path.join(out, 'config.js'), 'utf8');
    assert.match(cfg, /"mode":"static"/);
  } finally {
    await rm(out, { recursive: true, force: true });
  }
});
