// core/watches.js
// A "watch" is a saved description of the server you want, plus how and when to
// be told about it. This module turns watches + a config snapshot into matches
// and into alerts.
//
// ISOMORPHIC: no `node:` imports. The browser runs exactly this code to match
// watches held in localStorage against the published snapshot, so the public
// site and a server deployment can never disagree about what "matches" means.
// (Before this existed, public/app.js carried its own second copy of the
// matching and availability logic with nothing holding the two in sync.)

import { availMeta, dcInfo, rangeMeta, tierOf, isEco } from './ovh.js';

export const CHANNELS = Object.freeze(['browser', 'telegram', 'ntfy', 'webhook', 'email']);

// Guard against a runaway client or a scripted POST filling the store.
export const MAX_WATCHES = 50;

function uuid() {
  // Available in Node >=19 and in browsers on secure origins (and localhost).
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return 'w-' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

// Accepts "23:00", "2300", 23 -> minutes since midnight, or null.
function parseClock(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v).trim();
  const m = /^(\d{1,2})[:h]?(\d{2})?$/.exec(s);
  if (!m) return null;
  const h = Number(m[1]);
  const min = m[2] ? Number(m[2]) : 0;
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/**
 * The starter watch a fresh install (or a first-time visitor) sees.
 *
 * Deliberately generic: it demonstrates what a watch is without encoding
 * anybody's actual shopping list. Nothing personal ships in this repository.
 */
export function defaultWatches() {
  return [
    {
      id: uuid(),
      name: 'Example — NVMe in stock anywhere',
      enabled: true,
      countries: [],
      datacenters: [],
      ranges: [],
      storageKinds: ['NVMe'],
      storageContains: '',
      planCodes: [],
      search: '',
      minRamGB: null,
      inStockOnly: true,
      includeComingSoon: false,
      notify: true,
      channels: ['browser'],
      cooldownMinutes: 30,
      quietFrom: null,
      quietTo: null,
    },
  ];
}

export function normalizeWatch(w = {}) {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string') : []);
  const chans = arr(w.channels).filter((c) => CHANNELS.includes(c));
  return {
    id: typeof w.id === 'string' && w.id ? w.id : uuid(),
    name: (w.name || 'Untitled watch').toString().slice(0, 120),
    enabled: w.enabled !== false,
    countries: arr(w.countries),
    datacenters: arr(w.datacenters),
    ranges: arr(w.ranges),
    storageKinds: arr(w.storageKinds),
    storageContains: (w.storageContains || '').toString().slice(0, 120),
    planCodes: arr(w.planCodes),
    search: (w.search || '').toString().slice(0, 120),
    minRamGB: Number(w.minRamGB) > 0 ? Number(w.minRamGB) : null,
    inStockOnly: !!w.inStockOnly,
    includeComingSoon: !!w.includeComingSoon,
    notify: w.notify !== false,
    // Empty channel list = browser only. A watch never silently notifies
    // through a channel the user did not pick.
    channels: chans.length ? chans : ['browser'],
    cooldownMinutes: Number.isFinite(Number(w.cooldownMinutes)) && Number(w.cooldownMinutes) >= 0
      ? Math.min(Number(w.cooldownMinutes), 1440)
      : 0,
    quietFrom: parseClock(w.quietFrom),
    quietTo: parseClock(w.quietTo),
  };
}

// Quiet hours wrap midnight: 23:00 -> 07:00 is quiet across the boundary.
export function inQuietHours(w, date = new Date()) {
  if (w.quietFrom === null || w.quietTo === null) return false;
  const now = date.getHours() * 60 + date.getMinutes();
  if (w.quietFrom === w.quietTo) return false;
  if (w.quietFrom < w.quietTo) return now >= w.quietFrom && now < w.quietTo;
  return now >= w.quietFrom || now < w.quietTo; // wraps midnight
}

// ===========================================================================
// Matching
// ===========================================================================
export function configMatches(c, w) {
  if (w.ranges.length && !w.ranges.includes(c.range)) return false;
  if (w.storageKinds.length && !w.storageKinds.some((k) => c.storageKinds.includes(k))) return false;
  if (w.storageContains) {
    // Search both storage codes: configurations whose data array is `noraid-0`
    // carry their real disks under systemStorage.
    const hay = `${c.storageRaw} ${c.systemStorageRaw || ''}`.toLowerCase();
    if (!hay.includes(w.storageContains.toLowerCase())) return false;
  }
  if (w.planCodes.length && !w.planCodes.includes(c.planCode)) return false;
  if (w.minRamGB && (c.ramGB || 0) < w.minRamGB) return false;
  if (w.search) {
    const q = w.search.toLowerCase();
    const hay = `${c.fqn} ${c.name} ${c.memoryLabel} ${c.storageLabel} ${c.rangeLabel}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

export function dcAllowed(code, w) {
  if (w.datacenters.length && !w.datacenters.includes(code)) return false;
  if (w.countries.length && !w.countries.includes(dcInfo(code).country)) return false;
  return true;
}

// Does this exact config+datacenter cell satisfy the watch?
export function cellMatches(c, code, avail, w) {
  if (!configMatches(c, w)) return false;
  if (!dcAllowed(code, w)) return false;
  const am = availMeta(avail);
  const ok = am.orderable || (w.includeComingSoon && am.state === 'comingSoon');
  if (!ok) return false;
  if (w.inStockOnly && !am.inStock) return false;
  return true;
}

// Returns matches for a watch, best availability first.
export function matchesForWatch(configs, w) {
  const matches = [];
  for (const c of configs) {
    if (!configMatches(c, w)) continue;
    for (const code in c.dc) {
      const avail = c.dc[code];
      if (!cellMatches(c, code, avail, w)) continue;
      const am = availMeta(avail);
      const info = dcInfo(code);
      matches.push({
        fqn: c.fqn,
        planCode: c.planCode,
        name: c.name,
        model: c.model,
        cpu: c.cpu,
        range: c.range,
        memoryLabel: c.memoryLabel,
        storageLabel: c.storageLabel,
        rangeLabel: c.rangeLabel,
        priceText: c.priceText,
        dc: code,
        dcLabel: `${info.city}, ${info.countryName}`,
        city: info.city,
        flag: info.flag,
        availability: avail,
        availLabel: am.label,
        inStock: am.inStock,
        tier: tierOf(avail),
        rank: am.rank,
      });
    }
  }
  matches.sort((a, b) => a.rank - b.rank);
  return matches;
}

export function criteriaSummary(w) {
  const parts = [];
  if (w.countries.length) parts.push(w.countries.join('/'));
  if (w.datacenters.length) parts.push(w.datacenters.join('/'));
  if (w.ranges.length) parts.push(w.ranges.map((r) => rangeMeta(r).label).join('/'));
  if (w.storageKinds.length) parts.push(w.storageKinds.join('/'));
  if (w.storageContains) parts.push(`storage~"${w.storageContains}"`);
  if (w.minRamGB) parts.push(`≥${w.minRamGB}GB RAM`);
  if (w.planCodes.length) parts.push(w.planCodes.join(','));
  if (w.search) parts.push(`"${w.search}"`);
  parts.push(w.inStockOnly ? 'in-stock only' : 'incl. delayed');
  if (w.quietFrom !== null && w.quietTo !== null) {
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    parts.push(`quiet ${hhmm(w.quietFrom)}–${hhmm(w.quietTo)}`);
  }
  return parts.join(' · ');
}

// ===========================================================================
// Evaluate every watch
// ===========================================================================
// `state` is the serializable alert memory from core/state.js.
//
// withAlerts=false is a pure read, safe for HTTP GETs: it never touches alert
// memory. withAlerts=true edge-detects newly-available cells and forgets cells
// whose stock has gone away, so the same server/datacenter alerts again next
// time stock returns.
//
// state.seeded=false means "first ever run": record what is already available
// without firing, so a cold start (or a stateless cron run, or a first page
// visit) shows current stock instead of a notification storm.
export function runWatches(configs, watches, state, { withAlerts = false, now = Date.now() } = {}) {
  const summaries = [];
  const alerts = [];
  const liveKeys = new Set();
  const seeding = withAlerts && !state?.seeded;

  for (const w of watches) {
    const matches = w.enabled ? matchesForWatch(configs, w) : [];

    if (withAlerts && w.enabled && w.notify) {
      const quiet = inQuietHours(w, new Date(now));
      for (const m of matches) {
        const key = `${w.id}|${m.fqn}|${m.dc}`;
        liveKeys.add(key);
        if (state.has(key)) continue;
        state.add(key, now);
        if (seeding) continue;
        // Cooldown is per watch+cell: suppresses re-announcing stock that flaps
        // out and back in faster than the user wants to hear about.
        if (state.inCooldown(key, now, w.cooldownMinutes)) continue;
        if (quiet) continue;
        state.markAlert(key, now);
        alerts.push({ watchId: w.id, watchName: w.name, channels: w.channels, ...m });
      }
    }

    summaries.push({
      id: w.id,
      name: w.name,
      enabled: w.enabled,
      notify: w.notify,
      channels: w.channels,
      criteria: criteriaSummary(w),
      matchCount: matches.length,
      inStockCount: matches.filter((m) => m.inStock).length,
      ecoMatchCount: matches.filter((m) => isEco(m.range)).length,
      sample: matches.slice(0, 8),
      rule: {
        countries: w.countries,
        datacenters: w.datacenters,
        ranges: w.ranges,
        storageKinds: w.storageKinds,
        storageContains: w.storageContains,
        planCodes: w.planCodes,
        minRamGB: w.minRamGB,
        search: w.search,
        inStockOnly: w.inStockOnly,
        includeComingSoon: w.includeComingSoon,
      },
    });
  }

  if (withAlerts) {
    state.retain(liveKeys);
    state.seeded = true;
  }

  return { summaries, alerts, seeded: seeding };
}
