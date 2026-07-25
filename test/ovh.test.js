// Parsing and normalisation. Every case here is a defect that shipped.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseStorage, parseMemory, availMeta, tierOf, tierCounts, dcInfo, dcColumns,
  classifyRange, isEco, normalizeAvailabilities, splitCatalogName, buildCatalogMap,
  priceForConfig, formatMoney, STORAGE_KINDS,
} from '../core/ovh.js';

test('storage: media glued to the size (the shape that always worked)', () => {
  const p = parseStorage('softraid-2x450nvme');
  assert.equal(p.kind, 'NVMe');
  assert.equal(p.label, '2×450 GB NVMe');
  assert.equal(p.totalGB, 900);
});

test('storage: dashed media spelling — the shape that silently failed', () => {
  // Was unparsed entirely: kind '—', label showed the raw code.
  const p = parseStorage('hardraid-24x22000-hdd-sas');
  assert.equal(p.kind, 'HDD');
  assert.equal(p.label, '24×22 TB HDD');
  assert.equal(p.totalGB, 528000);
});

test('storage: mixed layout kept only the NVMe group — a 24×22 TB server read as 2×960 GB', () => {
  const p = parseStorage('hardraid-24x22000-hdd-sas-2x960nvme');
  assert.deepEqual(p.kinds, ['NVMe', 'HDD']);
  assert.equal(p.label, '24×22 TB HDD + 2×960 GB NVMe');
  assert.equal(p.totalGB, 528000 + 1920);
});

test('storage: every remaining live shape parses', () => {
  const shapes = [
    'softraid-2x960nvme-pcie-gen5',
    'hybridsoftraid-2x960nvme-pcie-gen5-2x1920nvme-pcie-gen5',
    'softraid-12x22000sas',
    'softraid-2x2000sa',
    'hybridsoftraid-2x6000sa-2x512nvme',
    'noraid-2x480ssd',
    'softraid-36x24000-hdd-sas',
  ];
  for (const s of shapes) {
    assert.notEqual(parseStorage(s).kind, '—', `${s} should parse`);
  }
});

test('storage: HDD is a kind users can filter on', () => {
  assert.ok(STORAGE_KINDS.includes('HDD'));
});

test('storage: noraid-0 is genuinely diskless, not a parse failure', () => {
  const p = parseStorage('noraid-0');
  assert.equal(p.drives.length, 0);
});

test('memory: ECC was reported absent for the ddr / on-die shapes', () => {
  assert.equal(parseMemory('ram-32g-ecc-2133').ecc, true);
  assert.equal(parseMemory('ram-96g-ddr5-ecc-4800').ecc, true);
  assert.equal(parseMemory('ram-64g-on-die-ecc-5600').ecc, true);
  assert.equal(parseMemory('ram-32g-ddr5-on-die-ecc-4800').ecc, true);
  assert.equal(parseMemory('ram-32g-noecc-2133').ecc, false);
});

test('memory: capacity, generation and speed', () => {
  const m = parseMemory('ram-96g-ddr5-ecc-4800');
  assert.equal(m.ramGB, 96);
  assert.equal(m.ddr, 5);
  assert.equal(m.speed, 4800);
  assert.equal(m.label, '96 GB DDR5 ECC 4800');
});

test('datacenters: the feed calls Mumbai ynm, and it was invisible', () => {
  // 1,775 configurations fell to country '??' and no country filter could reach them.
  assert.equal(dcInfo('ynm').country, 'IN');
  assert.equal(dcInfo('ynm').city, 'Mumbai');
  assert.equal(dcInfo('mum').country, 'IN');
});

test('datacenters: an unknown code still yields a column that fits', () => {
  const info = dcInfo('some-very-long-new-code');
  assert.equal(info.country, '??');
  assert.ok(info.short.length <= 5);
});

test('datacenters: columns come from live data, grouped by country', () => {
  const configs = [
    { dc: { bhs: '1H-low', fra: '24H' } },
    { dc: { 'ca-east-tor-a': 'unavailable' } },
  ];
  const cols = dcColumns(configs);
  assert.deepEqual(cols.map((c) => c.code), ['bhs', 'ca-east-tor-a', 'fra']);
  // vin/hil/eri exist in the static map but have no rows, so they must not appear
  assert.ok(!cols.some((c) => ['vin', 'hil', 'eri'].includes(c.code)));
  assert.equal(cols[1].short, 'tor');
});

test('availability: the ordered ladder', () => {
  assert.equal(availMeta('1H-high').inStock, true);
  assert.equal(availMeta('1H-low').inStock, true);
  assert.ok(availMeta('1H-high').rank < availMeta('1H-low').rank);
  assert.ok(availMeta('24H').rank < availMeta('72H').rank);
  assert.equal(availMeta('72H').orderable, true);
  assert.equal(availMeta('comingSoon').orderable, false);
  assert.equal(availMeta('unavailable').orderable, false);
  assert.equal(availMeta(null).state, 'unavailable');
});

test('availability: labels read as time, not jargon', () => {
  assert.equal(availMeta('24H').label, '~24h');
  assert.equal(availMeta('480H').label, '~20 days');
});

test('tiers: absent datacenter is "not sold", which differs from out of stock', () => {
  assert.equal(tierOf(undefined), 'notSold');
  assert.equal(tierOf('unavailable'), 'none');
  assert.equal(tierOf('1H-low'), 'now');
  assert.equal(tierOf('24H'), 'h24');
  assert.equal(tierOf('72H'), 'h72');
  assert.equal(tierOf('480H'), 'long');
  assert.equal(tierOf('comingSoon'), 'soon');
});

test('tiers: counts are per configuration × datacenter pair', () => {
  const counts = tierCounts([
    { dc: { bhs: '1H-low', gra: '24H' } },
    { dc: { bhs: '1H-high' } },
  ]);
  assert.equal(counts.now, 2);
  assert.equal(counts.h24, 1);
});

test('ranges: eco is the set with a public catalogue', () => {
  assert.equal(classifyRange('24sk202').range, 'kimsufi');
  assert.equal(classifyRange('24rise01-v1').range, 'rise');
  assert.equal(classifyRange('24sys022').range, 'soyoustart');
  assert.equal(classifyRange('24adv05-v3').range, 'advance');
  assert.equal(classifyRange('23scaleamd01-v2').range, 'scale');
  assert.ok(isEco('kimsufi') && isEco('rise') && isEco('soyoustart') && isEco('advance'));
  assert.ok(!isEco('scale') && !isEco('hci') && !isEco('sds') && !isEco('hgr'));
});

test('catalogue names split into model and cpu', () => {
  assert.deepEqual(splitCatalogName('KS-1 | Intel Xeon-D 1520'), { model: 'KS-1', cpu: 'Intel Xeon-D 1520' });
  assert.deepEqual(splitCatalogName('Advance'), { model: 'Advance', cpu: '' });
});

test('normalise: noraid-0 falls back to systemStorage instead of showing the raw code', () => {
  // 920 configurations, 151 of them orderable, displayed the string "noraid-0"
  // and were unreachable by every storage filter.
  const [c] = normalizeAvailabilities([{
    fqn: 'x.1', planCode: '23scaleamd01-v2', memory: 'ram-128g-ecc-2133',
    storage: 'noraid-0', systemStorage: 'softraid-2x960nvme',
    datacenters: [{ datacenter: 'bhs', availability: '1H-low' }],
  }]);
  assert.equal(c.storageLabel, '2×960 GB NVMe');
  assert.deepEqual(c.storageKinds, ['NVMe']);
  assert.equal(c.storageFromSystem, true);
});

test('normalise: rolls up availability across datacenters', () => {
  const [c] = normalizeAvailabilities([{
    fqn: 'x.2', planCode: '24rise02-v1', memory: 'ram-128g-ecc-2933',
    storage: 'softraid-2x512nvme',
    datacenters: [
      { datacenter: 'bhs', availability: '1H-low' },
      { datacenter: 'gra', availability: '24H' },
      { datacenter: 'fra', availability: 'unavailable' },
    ],
  }]);
  assert.equal(c.inStockCount, 1);
  assert.equal(c.orderableCount, 2);
  assert.equal(c.range, 'rise');
  assert.equal(c.eco, true);
});

test('prices: base plus memory and storage deltas', () => {
  const cat = buildCatalogMap({
    locale: { currencyCode: 'CAD' },
    plans: [{
      planCode: '24rise01-v1', invoiceName: 'RISE-1 | Intel Xeon-E 2386G',
      pricings: [{ intervalUnit: 'month', interval: 1, capacities: ['renew'], price: 10000000000 }],
      addonFamilies: [
        { name: 'memory', addons: ['ram-128g-ecc-2933'] },
        { name: 'storage', addons: ['softraid-2x512nvme'] },
      ],
    }],
    addons: [
      { planCode: 'ram-128g-ecc-2933', pricings: [{ intervalUnit: 'month', interval: 1, price: 2000000000 }] },
      { planCode: 'softraid-2x512nvme', pricings: [{ intervalUnit: 'month', interval: 1, price: 500000000 }] },
    ],
  });
  const entry = cat['24rise01-v1'];
  assert.equal(entry.basePrice, 100);
  assert.equal(priceForConfig(entry, 'ram-128g-ecc-2933', 'softraid-2x512nvme'), 125);
  assert.equal(formatMoney(125, 'CAD'), '$125.00 CAD');
});
