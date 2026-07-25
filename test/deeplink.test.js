// Order links.
//
// Every URL shape here was confirmed against OVH by probing. The failures are
// as important as the successes: eco.ovhcloud.com has per-model pages only for
// kimsufi/rise/soyoustart, /bare-metal/ has range listings only, and HCI/SDS
// have no page at all. Returning null is the correct answer in that last case —
// a control that 404s is worse than no control.

import test from 'node:test';
import assert from 'node:assert/strict';
import { orderLink, modelSlug, localeFor, apiUrl } from '../core/deeplink.js';

const c = (over) => ({ range: 'kimsufi', name: 'KS-1 | Intel Xeon-D 1520', planCode: '24sk102', ...over });

test('slug is the model half of the catalogue name', () => {
  assert.equal(modelSlug('KS-1 | Intel Xeon-D 1520'), 'ks-1');
  assert.equal(modelSlug('RISE-GAME-1 | AMD Ryzen 5 5600X'), 'rise-game-1');
  assert.equal(modelSlug('ADVANCE-5 | AMD EPYC 8224P'), 'advance-5');
  assert.equal(modelSlug(''), null);
});

test('eco ranges get the exact model page', () => {
  assert.equal(orderLink(c(), 'CA').url, 'https://eco.ovhcloud.com/en-ca/kimsufi/ks-1/');
  assert.equal(orderLink(c(), 'CA').kind, 'model');
  assert.equal(
    orderLink(c({ range: 'rise', name: 'RISE-1 | Intel Xeon-E 2386G' }), 'CA').url,
    'https://eco.ovhcloud.com/en-ca/rise/rise-1/',
  );
  // The URL segment is our internal code verbatim: `sys` and `so-you-start` 404.
  assert.equal(
    orderLink(c({ range: 'soyoustart', name: 'SYS-2 | Intel Xeon-D 2141I' }), 'CA').url,
    'https://eco.ovhcloud.com/en-ca/soyoustart/sys-2/',
  );
});

test('a snapshot row carrying only `model` resolves the same way', () => {
  const link = orderLink({ range: 'rise', model: 'RISE-1', planCode: '24rise01-v1' }, 'CA');
  assert.equal(link.url, 'https://eco.ovhcloud.com/en-ca/rise/rise-1/');
});

test('no catalogue name means no model page, so fall back to the range listing', () => {
  // A derived name is the range label, which would slug to "kimsufi" — not a page.
  const link = orderLink(c({ name: 'Kimsufi' }), 'CA');
  assert.equal(link.kind, 'range');
  assert.equal(link.url, 'https://eco.ovhcloud.com/en-ca/kimsufi/');
});

test('advance has no eco page at all — it lives under bare-metal', () => {
  // All seven eco.ovhcloud.com/en-ca/advance/* URLs return 404, listing included.
  const link = orderLink({ range: 'advance', name: 'ADVANCE-5 | AMD EPYC 8224P' }, 'CA');
  assert.equal(link.url, 'https://www.ovhcloud.com/en-ca/bare-metal/advance/');
  assert.equal(link.kind, 'range');
});

test('scale and high grade map to their bare-metal listings', () => {
  assert.equal(orderLink({ range: 'scale', name: 'Scale' }, 'CA').url, 'https://www.ovhcloud.com/en-ca/bare-metal/scale/');
  assert.equal(orderLink({ range: 'hgr', name: 'High Grade' }, 'CA').url, 'https://www.ovhcloud.com/en-ca/bare-metal/high-grade/');
});

test('ranges OVH publishes no page for return null', () => {
  assert.equal(orderLink({ range: 'hci', name: 'HCI' }, 'CA'), null);
  assert.equal(orderLink({ range: 'sds', name: 'SDS' }, 'CA'), null);
  assert.equal(orderLink({ range: 'other', name: 'Other' }, 'CA'), null);
  assert.equal(orderLink(null, 'CA'), null);
});

test('locale follows the subsidiary, with a sane fallback', () => {
  assert.equal(localeFor('CA'), 'en-ca');
  assert.equal(localeFor('FR'), 'fr-fr');
  assert.equal(localeFor('GB'), 'en-gb');
  assert.equal(localeFor('DE'), 'de-de');
  assert.equal(localeFor('ZZ'), 'en-ie');
  assert.equal(localeFor(undefined), 'en-ie');
  assert.match(orderLink(c(), 'FR').url, /^https:\/\/eco\.ovhcloud\.com\/fr-fr\//);
});

test('the api link verifies one exact configuration', () => {
  const u = apiUrl({ planCode: '24sk102' }, 'bhs');
  assert.match(u, /planCode=24sk102/);
  assert.match(u, /datacenters=bhs/);
});
