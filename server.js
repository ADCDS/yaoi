// server.js — Kimsufi Watch, long-lived server mode.
//
// This is the local/development and optional self-host mode: a resident process
// that polls every 60s and pushes live updates over SSE, with watches stored
// server-side. The public deployment does not run this — it publishes a static
// snapshot from a scheduled job and matches watches in the browser instead.
//
// All domain logic lives in core/. This file is transport: HTTP, SSE, auth,
// static files.
//
// Zero runtime dependencies. Needs Node >= 18 (global fetch). Run: node server.js

import http from 'node:http';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';

import { dcColumns, tierCounts, isEco, rangeMeta, ECO_RANGES, STORAGE_KINDS } from './core/ovh.js';
import { runWatches, normalizeWatch, MAX_WATCHES, CHANNELS } from './core/watches.js';
import { reseed } from './core/state.js';
import { fetchAvailability, fetchCatalog, applyCatalog, diffConfigs, AVAIL_URL_DEFAULT } from './core/poll.js';
import { diffEvents, closeDurations, openWindows, trim, toPublic } from './core/history.js';
import { dispatch, testChannel, channelStatus } from './core/notify/index.js';
import {
  loadWatches, saveWatches, loadState, saveState, loadEvents, saveEvents,
} from './core/store-node.js';

const gzipAsync = promisify(gzip);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- config (env-overridable) ---------------------------------------------
const PORT = Number(process.env.PORT || 4321);
// Safe by default: loopback only. Put a proxy in front, or set HOST=0.0.0.0.
const HOST = process.env.HOST || '127.0.0.1';
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const MAX_SSE = Math.max(1, Number(process.env.MAX_SSE || 50));
const MANUAL_REFRESH_MS = 10_000;
const POLL_MS = Math.max(15, Number(process.env.POLL_INTERVAL || 60)) * 1000;
const AVAIL_URL = process.env.OVH_AVAIL_URL || AVAIL_URL_DEFAULT;
const SUBSIDIARY = process.env.OVH_SUBSIDIARY || 'CA';

const PUBLIC_DIR = path.join(__dirname, 'public');
const CORE_DIR = path.join(__dirname, 'core');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const WATCHES_FILE = process.env.WATCHES_FILE || path.join(DATA_DIR, 'watches.json');
const LEGACY_WATCHES_FILE = path.join(DATA_DIR, 'targets.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const EVENTS_FILE = path.join(DATA_DIR, 'events.jsonl');

// ---- in-memory state ------------------------------------------------------
let snapshot = { configs: [], byFqn: new Map(), lastPoll: null, lastOk: null, error: null, durationMs: null };
let catalogMap = {};
let catalogStatus = { ok: false, count: 0, fetchedAt: null, error: null };
let watches = [];
let alertState = null;
let events = [];
const sseClients = new Set();
let polling = false;
let lastManualRefresh = 0;

// ===========================================================================
// Polling
// ===========================================================================
async function poll() {
  if (polling) return;
  polling = true;
  const started = Date.now();
  try {
    const { configs, durationMs } = await fetchAvailability(AVAIL_URL, catalogMap);
    const changes = diffConfigs(snapshot.byFqn, configs);

    // Record transitions before replacing the snapshot.
    const fresh = diffEvents(snapshot.byFqn, configs, started);
    if (fresh.length) {
      events = closeDurations(trim([...events, ...fresh]));
      saveEvents(EVENTS_FILE, events).catch((e) => log(`event log write failed: ${e.message}`));
    }

    snapshot = {
      configs,
      byFqn: new Map(configs.map((c) => [c.fqn, c])),
      lastPoll: started,
      lastOk: started,
      error: null,
      durationMs,
    };

    const { summaries, alerts, seeded } = runWatches(configs, watches, alertState, { withAlerts: true, now: started });
    await saveState(STATE_FILE, alertState, started);

    if (alerts.length) {
      // Server-side channels go out here; the browser gets its own copy over SSE.
      dispatch(alerts, { subsidiary: SUBSIDIARY })
        .then((out) => {
          for (const s of out.sent) log(`notify ${s.channel}: ${s.ok ? 'sent' : `FAILED — ${s.error}`}`);
          for (const s of out.skipped) log(`notify ${s.channel}: skipped (${s.reason})`);
        })
        .catch((e) => log(`notify failed: ${e.message}`));
    }

    broadcast('update', {
      meta: meta(),
      changes: seeded ? [] : changes, // first poll: clients load the full set from /api/state
      watches: summaries,
      alerts,
      events: fresh.map(toPublic).slice(-40),
    });

    log(`poll ok: ${configs.length} configs, ${changes.length} changed, ${fresh.length} transitions${alerts.length ? `, ${alerts.length} alert(s)` : ''} (${durationMs}ms)`);
  } catch (err) {
    snapshot = { ...snapshot, lastPoll: started, error: String(err.message || err) };
    log(`poll FAILED: ${err.message || err}`);
    broadcast('update', { meta: meta(), changes: [], watches: watchSummaries(), alerts: [] });
  } finally {
    polling = false;
  }
}

function watchSummaries() {
  return runWatches(snapshot.configs, watches, alertState, { withAlerts: false }).summaries;
}

async function refreshCatalog() {
  try {
    const cat = await fetchCatalog(SUBSIDIARY);
    catalogMap = cat.map;
    catalogStatus = { ok: cat.count > 0, count: cat.count, fetchedAt: Date.now(), error: null, url: cat.url };
    log(`catalogue loaded: ${cat.count} plan names (${SUBSIDIARY})`);
    if (snapshot.configs.length && cat.count) {
      // Send only the rows whose name or price actually changed. The original
      // code told every client to re-download the whole 11.5 MB snapshot here,
      // simultaneously, every six hours.
      const changed = applyCatalog(snapshot.configs, catalogMap);
      log(`catalogue enriched ${changed.length} configurations`);
      broadcast('update', { meta: meta(), changes: changed, watches: watchSummaries(), alerts: [] });
    }
  } catch (err) {
    catalogStatus = { ok: false, count: 0, fetchedAt: Date.now(), error: String(err.message || err) };
    log(`catalogue unavailable (using derived names): ${err.message || err}`);
  }
}

// ===========================================================================
// SSE
// ===========================================================================
function broadcast(event, payload) {
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try { res.write(line); } catch { sseClients.delete(res); }
  }
}

function meta() {
  return {
    at: snapshot.lastPoll,
    lastPoll: snapshot.lastPoll,
    lastOk: snapshot.lastOk,
    error: snapshot.error,
    durationMs: snapshot.durationMs,
    subsidiary: SUBSIDIARY,
    secured: !!AUTH_TOKEN,
    catalog: catalogStatus,
    cadence: { kind: 'live', everySeconds: POLL_MS / 1000, note: 'resident server, live stream' },
    counts: {
      all: snapshot.configs.length,
      eco: snapshot.configs.filter((c) => isEco(c.range)).length,
    },
    tiers: tierCounts(snapshot.configs.filter((c) => isEco(c.range))),
    tiersAll: tierCounts(snapshot.configs),
  };
}

/** Static metadata the UI needs to build its controls — from live data only. */
function staticMeta() {
  const dcs = dcColumns(snapshot.configs);
  const countries = {};
  for (const d of dcs) {
    if (!countries[d.country]) countries[d.country] = { name: d.countryName, flag: d.flag, dcs: [] };
    countries[d.country].dcs.push(d.code);
  }
  const ranges = {};
  for (const c of snapshot.configs) {
    if (!ranges[c.range]) ranges[c.range] = { label: c.rangeLabel, eco: !!c.eco, count: 0 };
    ranges[c.range].count++;
  }
  return { dcs, countries, ranges, ecoRanges: ECO_RANGES, storageKinds: STORAGE_KINDS, channels: CHANNELS };
}

// ===========================================================================
// HTTP
// ===========================================================================
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

/**
 * JSON reply, gzipped when the client accepts it.
 *
 * /api/state was 11.5 MB uncompressed on every page load.
 */
async function sendJSON(req, res, code, obj) {
  const body = JSON.stringify(obj);
  const accepts = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
  if (accepts && body.length > 1024) {
    const buf = await gzipAsync(body);
    res.writeHead(code, {
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'gzip',
      'content-length': buf.length,
      vary: 'accept-encoding',
    });
    res.end(buf);
    return;
  }
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  });
  res.end(body);
}

/**
 * Read a JSON body, strictly.
 *
 * The original returned `{}` for anything it could not parse, so a cross-site
 * form POST with a text/plain body created a fully-enabled, notifying watch with
 * every filter empty — one that matched 8,380 rows. Unparseable is now a 400,
 * and the content type has to say JSON.
 */
async function readJSONBody(req) {
  const ctype = String(req.headers['content-type'] || '');
  if (!/^application\/json\b/.test(ctype)) {
    return { error: 'content-type must be application/json' };
  }
  const chunks = [];
  let size = 0;
  for await (const ch of req) {
    size += ch.length;
    if (size > 64 * 1024) return { error: 'body too large' };
    chunks.push(ch);
  }
  if (!size) return { error: 'empty body' };
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return { error: 'body must be a JSON object' };
    }
    return { value };
  } catch {
    return { error: 'body is not valid JSON' };
  }
}

/**
 * Same-origin check for state-changing requests.
 *
 * There are no credentials here and the data is public, so the risk is not
 * disclosure — it is another site quietly editing your watches or making your
 * IP hammer OVH.
 */
function sameOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return true; // curl and non-browser clients send none
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

async function serveStatic(req, res, pathname) {
  let baseDir = PUBLIC_DIR;
  let rel = pathname === '/' ? '/index.html' : pathname;
  // The browser imports the same domain modules the server uses, so core/ is
  // served as-is rather than duplicated into public/.
  if (rel.startsWith('/core/')) {
    baseDir = CORE_DIR;
    rel = rel.slice('/core'.length);
  }
  const filePath = path.join(baseDir, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(baseDir)) {
    res.writeHead(403).end('forbidden');
    return;
  }
  try {
    const buf = await readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, { 'content-type': MIME[ext] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404).end('not found');
  }
}

// ---- optional shared-secret auth (no-op unless AUTH_TOKEN is set) ----
function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function providedToken(req, url) {
  const cookie = parseCookies(req.headers.cookie || '').kw_token;
  const auth = req.headers.authorization || '';
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  return url.searchParams.get('token') || req.headers['x-auth-token'] || bearer || cookie || '';
}
function tokenOk(provided) {
  if (!AUTH_TOKEN) return true;
  if (!provided) return false;
  const a = Buffer.from(String(provided));
  const b = Buffer.from(AUTH_TOKEN);
  return a.length === b.length && timingSafeEqual(a, b);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;
  const mutating = req.method !== 'GET' && req.method !== 'HEAD';

  try {
    if (AUTH_TOKEN) {
      if (!tokenOk(providedToken(req, url))) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('Unauthorized. Append ?token=YOUR_TOKEN to the URL once.');
        return;
      }
      if (url.searchParams.get('token')) {
        const proto = req.headers['x-forwarded-proto'] || (req.socket.encrypted ? 'https' : 'http');
        const secure = proto === 'https' ? '; Secure' : '';
        const cookie = `kw_token=${encodeURIComponent(AUTH_TOKEN)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`;
        if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
          url.searchParams.delete('token');
          res.writeHead(302, { 'Set-Cookie': cookie, Location: url.pathname + (url.search || '') });
          res.end();
          return;
        }
        res.setHeader('Set-Cookie', cookie);
      }
    }

    if (mutating && !sameOrigin(req)) {
      return sendJSON(req, res, 403, { ok: false, error: 'cross-origin request refused' });
    }

    // --- API ---
    if (pathname === '/api/state') {
      const full = url.searchParams.get('full') === '1';
      const configs = full ? snapshot.configs : snapshot.configs.filter((c) => isEco(c.range));
      return sendJSON(req, res, 200, {
        meta: meta(), static: staticMeta(), configs, watches: watchSummaries(), full,
      });
    }

    if (pathname === '/api/meta') {
      return sendJSON(req, res, 200, { meta: meta(), static: staticMeta() });
    }

    if (pathname === '/api/history') {
      const limit = Math.min(2000, Number(url.searchParams.get('limit')) || 300);
      const watchId = url.searchParams.get('watchId');
      let list = events;
      if (watchId) list = list.filter((e) => e.watchId === watchId);
      return sendJSON(req, res, 200, {
        events: list.slice(-limit).reverse(),
        open: openWindows(events).length,
        total: events.length,
      });
    }

    if (pathname === '/api/channels') {
      return sendJSON(req, res, 200, { channels: channelStatus() });
    }

    const tc = pathname.match(/^\/api\/channels\/([a-z]+)\/test$/);
    if (tc && req.method === 'POST') {
      const r = await testChannel(tc[1], { subsidiary: SUBSIDIARY });
      if (r.channel === 'browser') {
        // Prove the browser path too, by pushing a real alert down the stream.
        broadcast('update', {
          meta: meta(), changes: [], watches: watchSummaries(),
          alerts: [{
            watchId: 'test', watchName: 'Test', channels: ['browser'],
            fqn: 'test.config', planCode: '24sys022', name: 'SYS-2 | Intel Xeon-D 2141I',
            model: 'SYS-2', cpu: 'Intel Xeon-D 2141I', range: 'soyoustart',
            memoryLabel: '128 GB ECC 2666', storageLabel: '2×1.92 TB NVMe', rangeLabel: 'So you Start',
            priceText: '$159.87 CAD', dc: 'bhs', dcLabel: 'Beauharnois, Canada', city: 'Beauharnois',
            flag: '🇨🇦', availability: '1H-high', availLabel: 'In stock (high)', inStock: true, tier: 'now',
          }],
        });
      }
      return sendJSON(req, res, r.ok ? 200 : 502, r);
    }

    if (pathname === '/api/stream') {
      if (sseClients.size >= MAX_SSE) {
        res.writeHead(503, { 'content-type': 'text/plain' });
        res.end('too many streams');
        return;
      }
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      res.write('retry: 3000\n\n');
      res.write(`event: hello\ndata: ${JSON.stringify({ meta: meta() })}\n\n`);
      sseClients.add(res);
      const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch { /* ignore */ } }, 25000);
      req.on('close', () => { clearInterval(ping); sseClients.delete(res); });
      return;
    }

    if (pathname === '/api/watches') {
      if (req.method === 'GET') return sendJSON(req, res, 200, watchSummaries());
      if (req.method === 'POST') {
        if (watches.length >= MAX_WATCHES) {
          return sendJSON(req, res, 409, { ok: false, error: `at most ${MAX_WATCHES} watches` });
        }
        const { value, error } = await readJSONBody(req);
        if (error) return sendJSON(req, res, 400, { ok: false, error });
        const w = normalizeWatch(value);
        watches.push(w);
        await saveWatches(WATCHES_FILE, watches);
        await afterWatchChange();
        return sendJSON(req, res, 201, { ok: true, watch: w, watches: watchSummaries() });
      }
    }

    const wm = pathname.match(/^\/api\/watches\/([\w-]+)$/);
    if (wm) {
      const id = wm[1];
      const idx = watches.findIndex((w) => w.id === id);
      if (idx === -1) return sendJSON(req, res, 404, { ok: false, error: 'no such watch' });
      if (req.method === 'PUT') {
        const { value, error } = await readJSONBody(req);
        if (error) return sendJSON(req, res, 400, { ok: false, error });
        watches[idx] = normalizeWatch({ ...watches[idx], ...value, id });
        await saveWatches(WATCHES_FILE, watches);
        await afterWatchChange();
        return sendJSON(req, res, 200, { ok: true, watches: watchSummaries() });
      }
      if (req.method === 'DELETE') {
        watches.splice(idx, 1);
        await saveWatches(WATCHES_FILE, watches);
        await afterWatchChange();
        return sendJSON(req, res, 200, { ok: true, watches: watchSummaries() });
      }
    }

    if (pathname === '/api/refresh' && req.method === 'POST') {
      const now = Date.now();
      if (now - lastManualRefresh < MANUAL_REFRESH_MS) {
        return sendJSON(req, res, 429, { ok: false, error: 'refreshing too often' });
      }
      lastManualRefresh = now;
      poll();
      return sendJSON(req, res, 202, { ok: true });
    }

    // Mode flag. The static build ships its own copy declaring mode:'static';
    // shipping it from both sides means the client never has to guess (probing
    // would misfire on GitHub Pages, whose 404 is an HTML page).
    if (pathname === '/config.js') {
      const body = `window.__KW = ${JSON.stringify({ mode: 'server', apiBase: '', subsidiary: SUBSIDIARY })};\n`;
      res.writeHead(200, { 'content-type': MIME['.js'], 'cache-control': 'no-cache' });
      res.end(body);
      return;
    }

    if (pathname === '/favicon.ico') { res.writeHead(204).end(); return; }

    return serveStatic(req, res, pathname);
  } catch (err) {
    log(`request error: ${err.stack || err}`);
    if (!res.headersSent) return sendJSON(req, res, 500, { ok: false, error: String(err.message || err) });
  }
});

/**
 * Editing a watch changes what matches, so everything it now covers looks new.
 * Re-seed alert memory (keeping cooldown timestamps) so one edit doesn't fire a
 * notification for every row the edited watch suddenly matches.
 */
async function afterWatchChange() {
  reseed(alertState);
  const { summaries } = runWatches(snapshot.configs, watches, alertState, { withAlerts: true });
  await saveState(STATE_FILE, alertState);
  broadcast('update', { meta: meta(), changes: [], watches: summaries, alerts: [] });
}

function log(msg) {
  console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`);
}

// ===========================================================================
// Boot
// ===========================================================================
async function main() {
  const loaded = await loadWatches({ file: WATCHES_FILE, legacyFile: LEGACY_WATCHES_FILE });
  watches = loaded.watches;
  alertState = await loadState(STATE_FILE);
  events = closeDurations(await loadEvents(EVENTS_FILE));

  server.listen(PORT, HOST, () => {
    log(`Kimsufi Watch on http://${HOST}:${PORT}  (polling every ${POLL_MS / 1000}s)`);
    log(`bind: ${HOST} · auth: ${AUTH_TOKEN ? 'token required' : 'none (loopback/proxy)'} · max SSE: ${MAX_SSE}`);
    log(`watches: ${watches.length} from ${loaded.source} · history: ${events.length} events`);
    const on = channelStatus().filter((c) => c.configured && c.channel !== 'browser').map((c) => c.channel);
    log(`channels: ${on.length ? on.join(', ') : 'browser only (no server-side channels configured)'}`);
  });

  refreshCatalog(); // best-effort enrichment; don't block the first poll
  await poll();
  setInterval(poll, POLL_MS);
  setInterval(refreshCatalog, 6 * 60 * 60 * 1000);
}

main().catch((err) => {
  log(`fatal: ${err.stack || err}`);
  process.exit(1);
});
