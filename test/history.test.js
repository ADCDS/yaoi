// The event log: transitions, held durations, and what may be published.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  diffEvents, closeDurations, openWindows, toPublic, trim, parseJSONL, toJSONL,
} from '../core/history.js';

const cfg = (dc, over = {}) => ({
  fqn: 'x.1', planCode: '24sys022', model: 'SYS-2', ramGB: 128,
  storageLabel: '2×1.92 TB NVMe', range: 'soyoustart', priceText: '$159.87 CAD', dc, ...over,
});
const T0 = 1_700_000_000_000;

test('a first run records no transitions', () => {
  // Otherwise every configuration currently in stock is written to the log as
  // though it had just appeared.
  assert.deepEqual(diffEvents(new Map(), [cfg({ bhs: '1H-low' })], T0), []);
});

test('detects both directions and labels them', () => {
  const prev = new Map([['x.1', cfg({ bhs: 'unavailable', gra: '24H' })]]);
  const events = diffEvents(prev, [cfg({ bhs: '1H-low', gra: 'unavailable' })], T0);
  const byDc = Object.fromEntries(events.map((e) => [e.dc, e]));
  assert.equal(byDc.bhs.dir, 'up');
  assert.equal(byDc.bhs.from, 'none');
  assert.equal(byDc.bhs.to, 'now');
  assert.equal(byDc.gra.dir, 'down');
});

test('a slip from in-stock to a delayed build counts as downward', () => {
  const prev = new Map([['x.1', cfg({ bhs: '1H-low' })]]);
  const [e] = diffEvents(prev, [cfg({ bhs: '24H' })], T0);
  assert.equal(e.dir, 'down');
  assert.equal(e.to, 'h24');
});

test('reordered datacenter keys are not a change', () => {
  // The previous implementation compared JSON.stringify of the map, so a change
  // in key order coming back from the API looked like a stock change.
  const prev = new Map([['x.1', cfg({ bhs: '24H', gra: '1H-low' })]]);
  assert.deepEqual(diffEvents(prev, [{ ...cfg({ gra: '1H-low', bhs: '24H' }) }], T0), []);
});

test('a newly listed configuration is not a stock change', () => {
  const prev = new Map([['other.1', cfg({ bhs: '1H-low' })]]);
  assert.deepEqual(diffEvents(prev, [cfg({ bhs: '1H-low' })], T0), []);
});

test('held duration pairs a sell-out with its restock', () => {
  // This is the number that says whether a five-minute interval is fast enough.
  const up = diffEvents(new Map([['x.1', cfg({ bhs: 'unavailable' })]]), [cfg({ bhs: '1H-low' })], T0);
  const down = diffEvents(new Map([['x.1', cfg({ bhs: '1H-low' })]]), [cfg({ bhs: 'unavailable' })], T0 + 372_000);
  const events = closeDurations([...up, ...down]);
  assert.equal(events.find((e) => e.dir === 'down').heldMs, 372_000);
});

test('held duration spans many runs', () => {
  const events = closeDurations([
    { fqn: 'a', dc: 'bhs', dir: 'up', t: T0 },
    { fqn: 'b', dc: 'gra', dir: 'up', t: T0 + 1000 },
    { fqn: 'b', dc: 'gra', dir: 'down', t: T0 + 5000 },
    { fqn: 'a', dc: 'bhs', dir: 'down', t: T0 + 9 * 3600_000 },
  ]);
  assert.equal(events[2].heldMs, 4000);
  assert.equal(events[3].heldMs, 9 * 3600_000);
});

test('still-open windows report how long they have been open', () => {
  const open = openWindows([
    { fqn: 'a', dc: 'bhs', dir: 'up', t: T0 },
    { fqn: 'b', dc: 'gra', dir: 'up', t: T0 },
    { fqn: 'b', dc: 'gra', dir: 'down', t: T0 + 1000 },
  ], T0 + 60_000);
  assert.equal(open.length, 1);
  assert.equal(open[0].fqn, 'a');
  assert.equal(open[0].openMs, 60_000);
});

test('the public form drops everything about who was watching', () => {
  const pub = toPublic({
    t: T0, fqn: 'x.1', dc: 'bhs', dir: 'up', model: 'SYS-2',
    watchId: 'w1', watchName: 'my secret shopping list', channels: ['telegram'],
  });
  assert.equal(pub.watchId, undefined);
  assert.equal(pub.watchName, undefined);
  assert.equal(pub.channels, undefined);
  assert.equal(pub.model, 'SYS-2');
});

test('the log is bounded and keeps the newest', () => {
  const many = Array.from({ length: 100 }, (_, i) => ({ t: i }));
  const kept = trim(many, 10);
  assert.equal(kept.length, 10);
  assert.equal(kept[9].t, 99);
});

test('jsonl survives a round trip and tolerates a torn final write', () => {
  const events = [{ t: 1, fqn: 'a' }, { t: 2, fqn: 'b' }];
  assert.deepEqual(parseJSONL(toJSONL(events)), events);
  assert.deepEqual(parseJSONL('{"t":1}\n{"t":2}\n{"t":3'), [{ t: 1 }, { t: 2 }]);
  assert.deepEqual(parseJSONL(''), []);
});
