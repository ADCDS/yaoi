// core/state.js
// Serializable alert memory.
//
// The original monitor kept this as an in-process Set, which was fine for a
// long-lived server and impossible for anything else. Two deployments need it
// to survive process death:
//   • a cron run, which starts fresh every five minutes;
//   • a browser tab, which starts fresh on every page load.
// Both would otherwise re-announce everything currently in stock as though it
// had just appeared.
//
// ISOMORPHIC: no `node:` imports. Callers supply persistence — the server and
// the cron write JSON to disk, the browser writes to localStorage.

const MAX_ALERT_AGE_MS = 25 * 60 * 60 * 1000; // a little over the longest cooldown (24h)

export class AlertState {
  constructor(data = {}) {
    // live cells: `${watchId}|${fqn}|${dc}` -> first seen (ms)
    this.live = new Map(Object.entries(data.live || {}));
    // last time we actually sent an alert for a cell, for cooldown
    this.alerts = new Map(Object.entries(data.alerts || {}));
    // false = never run before; seed silently instead of announcing everything
    this.seeded = !!data.seeded;
    // when this state was last written, so a returning browser can tell how
    // stale it is and summarise rather than storm
    this.savedAt = data.savedAt || null;
  }

  has(key) { return this.live.has(key); }
  add(key, now) { if (!this.live.has(key)) this.live.set(key, now); }

  /** Drop cells that are no longer available, so they alert again on return. */
  retain(liveKeys) {
    for (const key of [...this.live.keys()]) if (!liveKeys.has(key)) this.live.delete(key);
  }

  markAlert(key, now) { this.alerts.set(key, now); }

  /** True when this cell was alerted recently enough to stay quiet about. */
  inCooldown(key, now, cooldownMinutes) {
    if (!cooldownMinutes) return false;
    const last = this.alerts.get(key);
    if (!last) return false;
    return now - last < cooldownMinutes * 60_000;
  }

  /** Age of the persisted state in ms, or null if it was never saved. */
  ageMs(now = Date.now()) {
    return this.savedAt ? Math.max(0, now - this.savedAt) : null;
  }

  toJSON(now = Date.now()) {
    // Prune alert timestamps past any usable cooldown so the file cannot grow
    // without bound across months of runs.
    const alerts = {};
    for (const [k, t] of this.alerts) if (now - t < MAX_ALERT_AGE_MS) alerts[k] = t;
    return {
      seeded: this.seeded,
      savedAt: now,
      live: Object.fromEntries(this.live),
      alerts,
    };
  }

  static fromJSON(data) { return new AlertState(data || {}); }
}

/**
 * Reset alert memory after the watch list changes.
 *
 * Editing a watch changes what matches, so every match looks new. Without this
 * a single edit fires an alert for everything the edited watch now covers.
 * Re-seeding keeps the alert timestamps (so cooldowns still apply) but forgets
 * which cells were live and marks the state unseeded.
 */
export function reseed(state) {
  state.live.clear();
  state.seeded = false;
  return state;
}
