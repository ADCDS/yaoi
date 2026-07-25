// core/poll.js
// Fetching the OVH feed and the order catalogue.
//
// Node-only (uses no node: builtins today, but it owns network policy and
// belongs on the server side of the line).

import { normalizeAvailabilities, buildCatalogMap } from './ovh.js';

export const AVAIL_URL_DEFAULT =
  'https://eu.api.ovh.com/1.0/dedicated/server/datacenter/availabilities';

// The availability feed has no per-subsidiary variant; the catalogue does.
const CATALOG_HOSTS = { CA: 'https://ca.api.ovh.com/1.0', US: 'https://us.api.ovh.com/1.0' };

export function catalogUrl(subsidiary = 'CA') {
  const host = CATALOG_HOSTS[subsidiary] || 'https://eu.api.ovh.com/1.0';
  return `${host}/order/catalog/public/eco?ovhSubsidiary=${subsidiary}`;
}

/** JSON fetch with a timeout and one retry, to ride out transient blips. */
export async function fetchJSON(url, { tries = 2, timeoutMs = 45000 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, { headers: { accept: 'application/json' }, signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
      return await res.json();
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await new Promise((r) => setTimeout(r, 1500));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

/**
 * Fetch the availability feed and normalise it.
 * The catalogue is separate and optional: it only adds commercial names and
 * prices, so availability monitoring keeps working without it.
 */
export async function fetchAvailability(availUrl = AVAIL_URL_DEFAULT, catalogMap = {}) {
  const started = Date.now();
  const data = await fetchJSON(availUrl, { tries: 2, timeoutMs: 45000 });
  const configs = normalizeAvailabilities(data, catalogMap);
  return { configs, durationMs: Date.now() - started };
}

export async function fetchCatalog(subsidiary = 'CA', url = null) {
  const target = url || catalogUrl(subsidiary);
  const data = await fetchJSON(target, { tries: 2, timeoutMs: 60000 });
  const map = buildCatalogMap(data);
  return { map, count: Object.keys(map).length, url: target };
}

/**
 * Stamp catalogue names and prices onto an existing snapshot in place.
 *
 * Used when the catalogue arrives after the first poll. The original code
 * broadcast a "refetch" flag here, which made every connected client re-download
 * the entire 11.5 MB snapshot at the same moment, every six hours. Returning the
 * list of configs that actually changed lets callers send a delta instead.
 */
export function applyCatalog(configs, catalogMap) {
  const changed = [];
  for (const c of configs) {
    const cat = catalogMap[c.planCode];
    if (!cat) continue;
    const before = `${c.name}|${c.price}`;
    if (cat.name) {
      c.name = cat.name;
      const i = cat.name.indexOf('|');
      c.model = i === -1 ? cat.name.trim() : cat.name.slice(0, i).trim();
      c.cpu = i === -1 ? '' : cat.name.slice(i + 1).trim();
    }
    const base = cat.basePrice;
    if (base != null) {
      const pickDelta = (list, code) => {
        if (!list || !code) return 0;
        const a = list.find((x) => x.code === code || x.code.startsWith(code + '-'));
        return a ? a.delta : 0;
      };
      c.price = base + pickDelta(cat.memory, c.memoryRaw) + pickDelta(cat.storage, c.storageRaw);
      c.currency = cat.currency ?? c.currency;
      const sym = { CAD: '$', USD: '$', AUD: '$', SGD: '$', EUR: '€', GBP: '£' }[c.currency] || '';
      c.priceText = `${sym}${c.price.toFixed(2)}${c.currency ? ' ' + c.currency : ''}`;
    }
    if (`${c.name}|${c.price}` !== before) changed.push(c);
  }
  return changed;
}

/**
 * Which configurations changed availability between two snapshots.
 *
 * Compares datacenter maps key-by-key rather than by JSON string, so a change
 * in key order coming back from the API cannot masquerade as a stock change.
 */
export function diffConfigs(prevByFqn, configs) {
  const changed = [];
  for (const c of configs) {
    const prev = prevByFqn.get(c.fqn);
    if (!prev) { changed.push(c); continue; }
    const a = prev.dc || {};
    const b = c.dc || {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      if (a[k] !== b[k]) { changed.push(c); break; }
    }
  }
  return changed;
}
