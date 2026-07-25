// core/history.js
// The availability event log.
//
// Without this, a missed alert is unrecoverable: you cannot tell whether stock
// lasted four minutes or four hours, and therefore cannot tell whether your
// checking interval is fast enough. Every transition is recorded, and each
// restock is closed out with how long the window stayed open — `heldMs`, the
// number that actually answers that question.
//
// Two scopes, deliberately separate:
//   public  — which configuration/datacenter went in or out of stock. Derived
//             purely from OVH's public feed; safe to publish.
//   private — the same, plus which watch matched and which channels were told.
//             Never published: it reveals what someone is hunting for.
//
// ISOMORPHIC: no `node:` imports. Callers own storage.

import { tierOf } from './ovh.js';

export const MAX_EVENTS_DEFAULT = 50_000;

/**
 * Compare two snapshots and emit transition events.
 *
 * `prevByFqn` may be empty (first ever run), in which case nothing is emitted:
 * a first sighting is not a transition, and treating it as one would write a
 * fake "everything just came in stock" burst into the log.
 */
export function diffEvents(prevByFqn, configs, now = Date.now()) {
  if (!prevByFqn || prevByFqn.size === 0) return [];
  const events = [];
  for (const c of configs) {
    const prev = prevByFqn.get(c.fqn);
    if (!prev) continue; // newly listed configuration, not a stock change
    for (const dc in c.dc) {
      const before = tierOf(prev.dc?.[dc]);
      const after = tierOf(c.dc[dc]);
      if (before === after) continue;
      const gained = rank(after) < rank(before);
      events.push({
        t: now,
        fqn: c.fqn,
        planCode: c.planCode,
        dc,
        from: before,
        to: after,
        dir: gained ? 'up' : 'down',
        model: c.model || c.name,
        ram: c.ramGB,
        storage: c.storageLabel,
        range: c.range,
        price: c.priceText || null,
      });
    }
  }
  return events;
}

// Lower is better, matching the delivery ladder's order.
const TIER_ORDER = { now: 0, h24: 1, h72: 2, long: 3, soon: 4, none: 5, notSold: 6 };
function rank(tier) { return TIER_ORDER[tier] ?? 9; }

/**
 * Fill in `heldMs` on each downward event by pairing it with the most recent
 * matching upward event for the same configuration and datacenter.
 *
 * Runs over the whole log because a stock window can straddle many runs — a
 * server that came in stock nine hours ago and sold out now is one pairing.
 */
export function closeDurations(events) {
  const openedAt = new Map();
  for (const e of events) {
    const key = `${e.fqn}|${e.dc}`;
    if (e.dir === 'up') {
      openedAt.set(key, e.t);
    } else if (openedAt.has(key)) {
      e.heldMs = e.t - openedAt.get(key);
      openedAt.delete(key);
    }
  }
  return events;
}

/**
 * How long each currently-open stock window has been open, for the "open now"
 * reading in the timeline.
 */
export function openWindows(events, now = Date.now()) {
  const open = new Map();
  for (const e of events) {
    const key = `${e.fqn}|${e.dc}`;
    if (e.dir === 'up') open.set(key, e);
    else open.delete(key);
  }
  const out = [];
  for (const e of open.values()) out.push({ ...e, openMs: now - e.t });
  return out;
}

/** Strip an event down to what is safe to publish. */
export function toPublic(e) {
  const { watchId, watchName, channels, ...rest } = e;
  return rest;
}

/** Newest first, capped. */
export function trim(events, max = MAX_EVENTS_DEFAULT) {
  return events.length > max ? events.slice(events.length - max) : events;
}

export function parseJSONL(text) {
  if (!text) return [];
  const out = [];
  for (const line of text.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip a torn trailing write */ }
  }
  return out;
}

export function toJSONL(events) {
  return events.map((e) => JSON.stringify(e)).join('\n') + (events.length ? '\n' : '');
}
