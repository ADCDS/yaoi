// Matching, alert edge-detection, cooldown and quiet hours.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeWatch, configMatches, cellMatches, matchesForWatch, runWatches,
  inQuietHours, criteriaSummary, defaultWatches, MAX_WATCHES,
} from '../core/watches.js';
import { AlertState, reseed } from '../core/state.js';

const cfg = (over = {}) => ({
  fqn: 'x.1', planCode: '24sys022', name: 'SYS-2 | Intel Xeon-D 2141I',
  model: 'SYS-2', cpu: 'Intel Xeon-D 2141I', range: 'soyoustart', rangeLabel: 'So you Start',
  ramGB: 128, memoryLabel: '128 GB ECC 2666',
  storageLabel: '2×1.92 TB NVMe', storageKind: 'NVMe', storageKinds: ['NVMe'],
  storageRaw: 'softraid-2x1920nvme', systemStorageRaw: '',
  dc: { bhs: '1H-high', gra: '24H', fra: 'unavailable' },
  ...over,
});

test('an empty body must not become a watch that matches everything', () => {
  // The server used to turn an unparseable body into {}, producing an enabled,
  // notifying watch with every filter blank — 8,380 matching rows.
  const w = normalizeWatch({});
  assert.equal(w.enabled, true);
  assert.deepEqual(w.countries, []);
  // Normalising is not the defence — rejecting the request is. What this pins
  // down is that such a watch would indeed match everything, which is why the
  // HTTP layer answers 400. See server.test.js.
  assert.equal(matchesForWatch([cfg()], w).length, 2);
});

test('normalise: hostile input is coerced, not trusted', () => {
  const w = normalizeWatch({
    name: 'x'.repeat(500), countries: 'CA', channels: ['telegram', 'nope'],
    minRamGB: -5, cooldownMinutes: 99999, quietFrom: '99:99', storageKinds: [1, 'NVMe'],
  });
  assert.equal(w.name.length, 120);
  assert.deepEqual(w.countries, []);          // a string is not a list
  assert.deepEqual(w.channels, ['telegram']); // unknown channel dropped
  assert.equal(w.minRamGB, null);
  assert.equal(w.cooldownMinutes, 1440);      // clamped
  assert.equal(w.quietFrom, null);            // nonsense clock rejected
  assert.deepEqual(w.storageKinds, ['NVMe']);
});

test('normalise: no channels means browser only, never silent escalation', () => {
  assert.deepEqual(normalizeWatch({ channels: [] }).channels, ['browser']);
});

test('match: storage kind, ram floor, range, plan code', () => {
  const c = cfg();
  assert.ok(configMatches(c, normalizeWatch({ storageKinds: ['NVMe'] })));
  assert.ok(!configMatches(c, normalizeWatch({ storageKinds: ['SATA'] })));
  assert.ok(configMatches(c, normalizeWatch({ minRamGB: 128 })));
  assert.ok(!configMatches(c, normalizeWatch({ minRamGB: 256 })));
  assert.ok(configMatches(c, normalizeWatch({ ranges: ['soyoustart'] })));
  assert.ok(!configMatches(c, normalizeWatch({ ranges: ['kimsufi'] })));
  assert.ok(configMatches(c, normalizeWatch({ planCodes: ['24sys022'] })));
  assert.ok(!configMatches(c, normalizeWatch({ planCodes: ['24sk202'] })));
});

test('match: free-text storage search also covers systemStorage', () => {
  // Otherwise the 920 noraid-0 configurations could never be found by "nvme".
  const c = cfg({ storageRaw: 'noraid-0', systemStorageRaw: 'softraid-2x960nvme' });
  assert.ok(configMatches(c, normalizeWatch({ storageContains: 'nvme' })));
});

test('match: country and datacenter scoping', () => {
  const c = cfg();
  assert.ok(cellMatches(c, 'bhs', c.dc.bhs, normalizeWatch({ countries: ['CA'] })));
  assert.ok(!cellMatches(c, 'gra', c.dc.gra, normalizeWatch({ countries: ['CA'] })));
  assert.ok(cellMatches(c, 'gra', c.dc.gra, normalizeWatch({ datacenters: ['gra'] })));
});

test('match: in-stock-only excludes delayed builds; comingSoon is opt-in', () => {
  const c = cfg({ dc: { bhs: '24H', gra: 'comingSoon' } });
  assert.ok(!cellMatches(c, 'bhs', '24H', normalizeWatch({ inStockOnly: true })));
  assert.ok(cellMatches(c, 'bhs', '24H', normalizeWatch({ inStockOnly: false })));
  assert.ok(!cellMatches(c, 'gra', 'comingSoon', normalizeWatch({})));
  assert.ok(cellMatches(c, 'gra', 'comingSoon', normalizeWatch({ includeComingSoon: true })));
});

test('match: unavailable never matches', () => {
  const c = cfg();
  assert.ok(!cellMatches(c, 'fra', 'unavailable', normalizeWatch({ includeComingSoon: true })));
});

test('matches are ordered best-availability first', () => {
  const m = matchesForWatch([cfg()], normalizeWatch({}));
  assert.deepEqual(m.map((x) => x.dc), ['bhs', 'gra']);
  assert.equal(m[0].tier, 'now');
});

test('alerts: a first run records current stock without announcing it', () => {
  // A cold start, a stateless cron run and a first page visit are all this case.
  const state = new AlertState();
  const w = [normalizeWatch({ name: 'w' })];
  const first = runWatches([cfg()], w, state, { withAlerts: true });
  assert.equal(first.alerts.length, 0);
  assert.equal(first.seeded, true);
  assert.equal(state.seeded, true);

  // Nothing changed, so still nothing to say.
  assert.equal(runWatches([cfg()], w, state, { withAlerts: true }).alerts.length, 0);
});

test('alerts: fire on the transition into availability', () => {
  const state = new AlertState();
  const w = [normalizeWatch({ name: 'w' })];
  const gone = cfg({ dc: { bhs: 'unavailable', gra: 'unavailable' } });
  runWatches([gone], w, state, { withAlerts: true });          // seed: nothing available
  const res = runWatches([cfg()], w, state, { withAlerts: true });
  assert.equal(res.alerts.length, 2);
  assert.equal(res.alerts[0].dc, 'bhs');
  assert.equal(res.alerts[0].watchName, 'w');
});

test('alerts: stock that goes away is forgotten, so its return alerts again', () => {
  const state = new AlertState();
  const w = [normalizeWatch({ name: 'w' })];
  runWatches([cfg({ dc: { bhs: 'unavailable' } })], w, state, { withAlerts: true });
  assert.equal(runWatches([cfg({ dc: { bhs: '1H-low' } })], w, state, { withAlerts: true }).alerts.length, 1);
  runWatches([cfg({ dc: { bhs: 'unavailable' } })], w, state, { withAlerts: true });
  assert.equal(runWatches([cfg({ dc: { bhs: '1H-low' } })], w, state, { withAlerts: true }).alerts.length, 1);
});

test('alerts: cooldown suppresses stock that flaps', () => {
  const state = new AlertState();
  const w = [normalizeWatch({ name: 'w', cooldownMinutes: 30 })];
  const t0 = 1_700_000_000_000;
  runWatches([cfg({ dc: { bhs: 'unavailable' } })], w, state, { withAlerts: true, now: t0 });
  assert.equal(runWatches([cfg({ dc: { bhs: '1H-low' } })], w, state, { withAlerts: true, now: t0 + 1000 }).alerts.length, 1);
  // out and back within the cooldown window: stay quiet
  runWatches([cfg({ dc: { bhs: 'unavailable' } })], w, state, { withAlerts: true, now: t0 + 2000 });
  assert.equal(runWatches([cfg({ dc: { bhs: '1H-low' } })], w, state, { withAlerts: true, now: t0 + 3000 }).alerts.length, 0);
  // after the window it speaks up again
  runWatches([cfg({ dc: { bhs: 'unavailable' } })], w, state, { withAlerts: true, now: t0 + 31 * 60_000 });
  assert.equal(runWatches([cfg({ dc: { bhs: '1H-low' } })], w, state, { withAlerts: true, now: t0 + 32 * 60_000 }).alerts.length, 1);
});

test('quiet hours wrap midnight', () => {
  const w = normalizeWatch({ quietFrom: '23:00', quietTo: '07:00' });
  const at = (h, m = 0) => new Date(2026, 0, 1, h, m);
  assert.equal(inQuietHours(w, at(23, 30)), true);
  assert.equal(inQuietHours(w, at(3)), true);
  assert.equal(inQuietHours(w, at(6, 59)), true);
  assert.equal(inQuietHours(w, at(7)), false);
  assert.equal(inQuietHours(w, at(12)), false);
  assert.equal(inQuietHours(normalizeWatch({}), at(3)), false);
});

test('quiet hours hold the alert but still record the stock', () => {
  const state = new AlertState();
  const w = [normalizeWatch({ name: 'w', quietFrom: '00:00', quietTo: '23:59' })];
  const night = new Date(2026, 0, 1, 3, 0).getTime();
  runWatches([cfg({ dc: { bhs: 'unavailable' } })], w, state, { withAlerts: true, now: night });
  const res = runWatches([cfg({ dc: { bhs: '1H-low' } })], w, state, { withAlerts: true, now: night });
  assert.equal(res.alerts.length, 0);
  assert.ok(state.has(`${w[0].id}|x.1|bhs`)); // remembered, so it won't shout at 07:00
});

test('a disabled watch matches nothing', () => {
  const state = new AlertState();
  const w = [normalizeWatch({ name: 'w', enabled: false })];
  const res = runWatches([cfg()], w, state, { withAlerts: true });
  assert.equal(res.summaries[0].matchCount, 0);
  assert.equal(res.alerts.length, 0);
});

test('summaries separate eco matches, so the count can be reconciled with the grid', () => {
  const state = new AlertState();
  const res = runWatches(
    [cfg(), cfg({ fqn: 'x.2', range: 'scale', rangeLabel: 'Scale' })],
    [normalizeWatch({ name: 'w' })], state,
  );
  assert.equal(res.summaries[0].matchCount, 4);
  assert.equal(res.summaries[0].ecoMatchCount, 2);
});

test('editing a watch re-seeds instead of firing for everything it now covers', () => {
  const state = new AlertState();
  const w = [normalizeWatch({ name: 'w' })];
  runWatches([cfg()], w, state, { withAlerts: true });
  reseed(state);
  assert.equal(state.seeded, false);
  assert.equal(runWatches([cfg()], w, state, { withAlerts: true }).alerts.length, 0);
});

test('alert state survives a round trip through JSON', () => {
  const state = new AlertState();
  runWatches([cfg()], [normalizeWatch({ name: 'w' })], state, { withAlerts: true });
  const revived = AlertState.fromJSON(JSON.parse(JSON.stringify(state.toJSON())));
  assert.equal(revived.seeded, true);
  assert.equal(revived.live.size, state.live.size);
  assert.ok(revived.ageMs() !== null);
});

test('criteria read as a sentence a person can check', () => {
  const s = criteriaSummary(normalizeWatch({
    countries: ['CA'], storageKinds: ['NVMe'], minRamGB: 64, quietFrom: '23:00', quietTo: '07:00',
  }));
  assert.match(s, /CA/);
  assert.match(s, /NVMe/);
  assert.match(s, /≥64GB RAM/);
  assert.match(s, /quiet 23:00–07:00/);
});

test('the shipped default is generic, not anyone’s real watch', () => {
  const [d] = defaultWatches();
  assert.match(d.name, /^Example/);
  assert.deepEqual(d.countries, []);
  assert.ok(MAX_WATCHES >= 1);
});
