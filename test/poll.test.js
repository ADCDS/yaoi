// The catalogue lives on a regional API cluster, not a geographic one. Sending
// a subsidiary to the wrong cluster is a 400 rather than an error the app
// surfaces loudly — it just falls back to derived names — so pin the mapping.

import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogUrl } from '../core/poll.js';

const hostFor = (subsidiary) => new URL(catalogUrl(subsidiary)).host;

test('catalogue host follows the API cluster that serves the subsidiary', () => {
  assert.equal(hostFor('IN'), 'ca.api.ovh.com');
  assert.equal(hostFor('AU'), 'ca.api.ovh.com');
  assert.equal(hostFor('SG'), 'ca.api.ovh.com');
  assert.equal(hostFor('CA'), 'ca.api.ovh.com');
  assert.equal(hostFor('US'), 'us.api.ovh.com');
  assert.equal(hostFor('IE'), 'eu.api.ovh.com');
  assert.equal(hostFor('fr'), 'eu.api.ovh.com');
  assert.equal(hostFor('in'), 'ca.api.ovh.com'); // lower case is normalised, not sent to eu.api
});

test('the subsidiary is passed through in the query string', () => {
  const url = new URL(catalogUrl('IN'));
  assert.equal(url.pathname, '/1.0/order/catalog/public/eco');
  assert.equal(url.searchParams.get('ovhSubsidiary'), 'IN');
});
