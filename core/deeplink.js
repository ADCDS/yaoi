// core/deeplink.js
// One tap from "it's in stock" to somewhere you can actually buy it.
//
// Every URL shape here was established by probing OVH, not by guessing, and the
// results are not uniform — which is why this resolver is tiered rather than a
// single template.
//
// Tier 1 — eco microsite, exact model page (42 of 42 probed URLs returned 200):
//     https://eco.ovhcloud.com/{locale}/{range}/{slug}/
//   • {range} is our internal range code verbatim: kimsufi | rise | soyoustart.
//     `sys` and `so-you-start` both 404.
//   • {slug} is the model half of the catalogue invoice name, lowercased:
//     "KS-1 | Intel Xeon-D 1520" -> "ks-1".
//   Only these three ranges have per-model pages. Advance does not: all seven
//   eco.ovhcloud.com/en-ca/advance/* URLs 404, as does the advance listing.
//
// Tier 2 — mainstream bare-metal range listing (probed 200):
//     https://www.ovhcloud.com/{locale}/bare-metal/{slug}/
//   Exists for advance, scale, high-grade and storage — range listings only,
//   no per-model pages (bare-metal/advance/advance-1/ 404s). HCI and SDS have
//   no page under this path at all.
//
// Tier 3 — no page: callers show the API verification link instead. Returning
// null is a real answer, not a failure; emitting a URL that 404s would be worse
// than admitting there isn't one.
//
// ISOMORPHIC: no `node:` imports.

import { splitCatalogName } from './ovh.js';

const ECO_HOST = 'https://eco.ovhcloud.com';
const MAIN_HOST = 'https://www.ovhcloud.com';

// Ranges with per-model pages on the eco microsite.
const ECO_SITE_RANGES = new Set(['kimsufi', 'rise', 'soyoustart']);

// Ranges with a listing page under /bare-metal/. Value is the URL slug.
const BAREMETAL_SLUG = { advance: 'advance', scale: 'scale', hgr: 'high-grade' };

// OVH subsidiary -> locale segment.
const LOCALE = {
  CA: 'en-ca', US: 'en', FR: 'fr-fr', GB: 'en-gb', IE: 'en-ie',
  DE: 'de-de', ES: 'es-es', IT: 'it-it', NL: 'nl-nl', PL: 'pl-pl',
  PT: 'pt-pt', FI: 'fi-fi', LT: 'lt-lt', CZ: 'cs-cz', SN: 'fr-sn',
  MA: 'fr-ma', TN: 'fr-tn', AU: 'en-au', SG: 'en-sg', IN: 'en-in',
  QC: 'fr-ca', WE: 'en-ie', WS: 'es-es',
};

export function localeFor(subsidiary) {
  return LOCALE[String(subsidiary || '').toUpperCase()] || 'en-ie';
}

/** Slugify the model designation: "RISE-GAME-1 | AMD Ryzen" -> "rise-game-1". */
export function modelSlug(name) {
  const { model } = splitCatalogName(name);
  if (!model) return null;
  const slug = model.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || null;
}

// The published snapshot ships `model` already split out and drops the joined
// catalogue name, so accept either shape.
function modelOf(config) {
  return config.model ? modelSlug(config.model) : modelSlug(config.name);
}

/**
 * Where to send someone who wants to order this configuration.
 *
 * Returns { url, kind, label } or null when OVH publishes no such page.
 *   kind 'model' — the exact machine's order page
 *   kind 'range' — the range listing; the right machine is one click further
 */
export function orderLink(config, subsidiary = 'CA') {
  if (!config) return null;
  const locale = localeFor(subsidiary);

  if (ECO_SITE_RANGES.has(config.range)) {
    const slug = modelOf(config);
    // A configuration with no catalogue entry falls back to its range label as
    // a name, which would slug to "rise" or "kimsufi" — not a model page.
    if (slug && slug !== config.range) {
      return { url: `${ECO_HOST}/${locale}/${config.range}/${slug}/`, kind: 'model', label: 'Order' };
    }
    return { url: `${ECO_HOST}/${locale}/${config.range}/`, kind: 'range', label: 'Browse' };
  }

  const bm = BAREMETAL_SLUG[config.range];
  if (bm) return { url: `${MAIN_HOST}/${locale}/bare-metal/${bm}/`, kind: 'range', label: 'Browse' };

  return null; // HCI, SDS, Other — no published page
}

/** The public API row for this exact configuration, for verification. */
export function apiUrl(config, dc) {
  const p = new URLSearchParams({ planCode: config.planCode });
  if (dc) p.set('datacenters', dc);
  return `https://eu.api.ovh.com/1.0/dedicated/server/datacenter/availabilities?${p}`;
}
