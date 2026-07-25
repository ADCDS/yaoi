// public/transport.js
// Where the page gets its data, and where a watch is stored.
//
// Two modes behind one interface:
//
//   server  — a resident process. Data from /api/state, live updates over SSE,
//             watches stored server-side and shared by every browser that opens
//             it. This is local development and self-hosting.
//
//   static  — GitHub Pages. Data from a snapshot.json refreshed by a scheduled
//             job. There is no backend, so watches live in *this browser's*
//             localStorage and matching runs here, using the same core/ modules
//             the server uses. That is what makes the public site multi-user
//             without accounts: nothing is shared, so nothing can collide.
//
// Mode comes from config.js, not from probing. Asking for /api/state on Pages
// returns a 404 HTML page, which is indistinguishable from a broken server.

import { normalizeWatch, defaultWatches, runWatches, MAX_WATCHES } from './core/watches.js';
import { AlertState, reseed } from './core/state.js';

const MODE = (window.__YAOI && window.__YAOI.mode) || 'server';
const SUBSIDIARY = (window.__YAOI && window.__YAOI.subsidiary) || 'CA';
const SNAPSHOT = (window.__YAOI && window.__YAOI.snapshot) || './snapshot.json';
const FULL_SNAPSHOT = (window.__YAOI && window.__YAOI.snapshotFull) || './snapshot-full.json';

// A visitor coming back after a while should not be told about every server that
// appeared while the tab was shut — that is a summary, not thirty alerts.
const STALE_MS = 30 * 60 * 1000;
const LS = { watches: 'yaoi.watches', state: 'yaoi.alertstate', prefs: 'yaoi.prefs' };

export const mode = MODE;
export const subsidiary = SUBSIDIARY;
export const isStatic = MODE === 'static';

// ---------------------------------------------------------------------------
// The published snapshot uses short keys to stay small. Expand to the shape
// core/ and the UI expect.
// ---------------------------------------------------------------------------
const RANGE_LABEL = {
  kimsufi: 'Kimsufi', rise: 'Rise', soyoustart: 'So you Start', advance: 'Advance',
  scale: 'Scale', hgr: 'High Grade', hci: 'HCI', sds: 'SDS', other: 'Other',
};
const ECO = new Set(['kimsufi', 'rise', 'soyoustart', 'advance']);

function expand(row) {
  return {
    fqn: row.f,
    planCode: row.p,
    model: row.m,
    cpu: row.c,
    name: row.c ? `${row.m} | ${row.c}` : row.m,
    range: row.r,
    rangeLabel: RANGE_LABEL[row.r] || row.r,
    eco: ECO.has(row.r),
    ramGB: row.g,
    memoryLabel: row.M || (row.g ? `${row.g} GB` : ''),
    storageLabel: row.s,
    storageKind: row.k,
    storageKinds: row.K || [],
    storageRaw: row.R || '',
    systemStorageRaw: row.S || '',
    priceText: row.$ || null,
    price: row.n ?? null,
    dc: row.d || {},
  };
}

// ---------------------------------------------------------------------------
// Preferences (filters, sort, theme, sound) — the app previously kept none, so
// every reload threw away your filters.
// ---------------------------------------------------------------------------
export function loadPrefs() {
  try { return JSON.parse(localStorage.getItem(LS.prefs)) || {}; } catch { return {}; }
}
export function savePrefs(prefs) {
  try { localStorage.setItem(LS.prefs, JSON.stringify(prefs)); } catch { /* private mode */ }
}

// ---------------------------------------------------------------------------
// Watch stores
// ---------------------------------------------------------------------------
class ServerWatchStore {
  constructor() { this.summaries = []; }

  async list() {
    const r = await fetch('/api/watches');
    this.summaries = await r.json();
    return this.summaries;
  }

  async create(body) { return this.#send('/api/watches', 'POST', body); }
  async update(id, body) { return this.#send(`/api/watches/${id}`, 'PUT', body); }
  async remove(id) { return this.#send(`/api/watches/${id}`, 'DELETE'); }

  async #send(url, method, body) {
    const res = await fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
    if (data.watches) this.summaries = data.watches;
    return data;
  }

  /** The server already evaluated the watches; it sends summaries with updates. */
  evaluate() { return { summaries: this.summaries, alerts: [] }; }
  absorb(summaries) { if (summaries) this.summaries = summaries; }
}

class LocalWatchStore {
  constructor() {
    this.watches = this.#read();
    this.state = this.#readState();
    this.summaries = [];
    this.missed = null; // set when a stale return is summarised instead of alerted
  }

  #read() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS.watches));
      if (Array.isArray(raw)) return raw.map(normalizeWatch);
    } catch { /* fall through */ }
    return [];
  }

  #readState() {
    try { return AlertState.fromJSON(JSON.parse(localStorage.getItem(LS.state)) || {}); }
    catch { return new AlertState(); }
  }

  #persist() {
    try {
      localStorage.setItem(LS.watches, JSON.stringify(this.watches));
      localStorage.setItem(LS.state, JSON.stringify(this.state.toJSON()));
    } catch { /* private mode: watches simply won't survive the reload */ }
  }

  async list() { return this.summaries; }

  async create(body) {
    if (this.watches.length >= MAX_WATCHES) throw new Error(`at most ${MAX_WATCHES} watches`);
    const w = normalizeWatch(body);
    this.watches.push(w);
    this.#afterChange();
    return { ok: true, watch: w };
  }

  async update(id, body) {
    const i = this.watches.findIndex((w) => w.id === id);
    if (i === -1) throw new Error('no such watch');
    this.watches[i] = normalizeWatch({ ...this.watches[i], ...body, id });
    this.#afterChange();
    return { ok: true };
  }

  async remove(id) {
    this.watches = this.watches.filter((w) => w.id !== id);
    this.#afterChange();
    return { ok: true };
  }

  #afterChange() {
    // Editing changes what matches, so everything it now covers looks new.
    // Re-seed so one edit doesn't fire an alert per newly-matched row.
    reseed(this.state);
    this.#persist();
  }

  /**
   * Match against the current snapshot and decide what to announce.
   *
   * Three cases, and the difference between them is the whole point:
   *   • first ever visit — record silently, announce nothing;
   *   • stale return — record silently, hand back a count to summarise;
   *   • normal tick — announce what actually just changed.
   */
  evaluate(configs) {
    const now = Date.now();
    const age = this.state.ageMs(now);
    const stale = age !== null && age > STALE_MS;
    if (stale) {
      const before = new Set(this.state.live.keys());
      reseed(this.state);
      const res = runWatches(configs, this.watches, this.state, { withAlerts: true, now });
      const appeared = [...this.state.live.keys()].filter((k) => !before.has(k));
      this.summaries = res.summaries;
      this.missed = { count: appeared.length, sinceMs: age };
      this.#persist();
      return { summaries: res.summaries, alerts: [] };
    }
    const res = runWatches(configs, this.watches, this.state, { withAlerts: true, now });
    this.summaries = res.summaries;
    this.#persist();
    return { summaries: res.summaries, alerts: res.alerts };
  }

  absorb() { /* nothing to absorb: this browser is the source of truth */ }

  seedDefaults() {
    if (this.watches.length) return false;
    this.watches = defaultWatches();
    reseed(this.state);
    this.#persist();
    return true;
  }
}

export const store = MODE === 'static' ? new LocalWatchStore() : new ServerWatchStore();

// ---------------------------------------------------------------------------
// Data loading
// ---------------------------------------------------------------------------
let fullLoaded = false;

export async function loadState({ full = false } = {}) {
  if (MODE === 'static') {
    const url = full ? FULL_SNAPSHOT : SNAPSHOT;
    const r = await fetch(`${url}?t=${Date.now()}`, { cache: 'no-store' });
    if (!r.ok) throw new Error(`snapshot unavailable (${r.status})`);
    const snap = await r.json();
    if (full) fullLoaded = true;
    return {
      meta: snap.meta,
      dcs: snap.dcs,
      ranges: snap.ranges,
      configs: (snap.configs || []).map(expand),
      events: snap.events || [],
      watches: null,
      full,
    };
  }

  const r = await fetch(`/api/state${full ? '?full=1' : ''}`);
  if (!r.ok) throw new Error(`server returned ${r.status}`);
  const data = await r.json();
  if (full) fullLoaded = true;
  return {
    meta: data.meta,
    dcs: data.static.dcs,
    ranges: data.static.ranges,
    countries: data.static.countries,
    configs: data.configs,
    watches: data.watches,
    events: null,
    full,
  };
}

export const hasFull = () => fullLoaded;

export async function loadHistory(limit = 300) {
  if (MODE === 'static') return null; // the snapshot already carries its event tail
  const r = await fetch(`/api/history?limit=${limit}`);
  if (!r.ok) return null;
  return r.json();
}

export async function loadChannels() {
  if (MODE === 'static') {
    // No server, so no server-side channel can exist here. Saying "browser only"
    // is the honest answer; rendering a mail or Telegram row would imply a
    // capability this deployment does not have.
    return {
      channels: [{ channel: 'browser', configured: true, detail: 'this browser, while a tab is open' }],
    };
  }
  const r = await fetch('/api/channels');
  if (!r.ok) return { channels: [] };
  return r.json();
}

export async function testChannel(name) {
  if (MODE === 'static') return { channel: name, ok: name === 'browser' };
  const r = await fetch(`/api/channels/${name}/test`, { method: 'POST' });
  return r.json().catch(() => ({ channel: name, ok: false, error: 'no response' }));
}

export async function refresh() {
  if (MODE === 'static') return { ok: false, error: 'this is a published snapshot' };
  const r = await fetch('/api/refresh', { method: 'POST' });
  return r.json().catch(() => ({ ok: false }));
}

/**
 * Subscribe to updates.
 *
 * Server mode gets a real event stream. Static mode re-fetches the snapshot on a
 * timer, which is all a static host can offer — and the page says so rather than
 * implying a live connection.
 */
export function subscribe({ onUpdate, onStatus }) {
  if (MODE === 'static') {
    const period = 60_000;
    let timer = null;
    const tick = async () => {
      try {
        const data = await loadState({ full: fullLoaded });
        onStatus({ connected: true });
        onUpdate(data);
      } catch (err) {
        onStatus({ connected: false, error: String(err.message || err) });
      }
    };
    timer = setInterval(tick, period);
    onStatus({ connected: true });
    return () => clearInterval(timer);
  }

  let es = new EventSource('/api/stream');
  es.addEventListener('hello', (e) => onStatus({ connected: true, ...JSON.parse(e.data) }));
  es.addEventListener('update', (e) => onUpdate(JSON.parse(e.data)));
  es.onopen = () => onStatus({ connected: true });
  es.onerror = () => onStatus({ connected: false });
  return () => es.close();
}
