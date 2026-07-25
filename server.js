// server.js — Kimsufi / OVH Eco availability monitor
//
// Zero runtime dependencies. Needs Node >= 18 (global fetch). Run:  node server.js
// Then open http://localhost:4321 in your browser.

import http from 'node:http';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeAvailabilities,
  buildCatalogMap,
  priceForConfig,
  formatMoney,
  availMeta,
  dcInfo,
  DATACENTERS,
  rangeMeta,
} from './lib/ovh.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---- config (env-overridable) ---------------------------------------------
const PORT = Number(process.env.PORT || 4321);
// Safe by default: bind to loopback only. Put a proxy (Tailscale Serve /
// Cloudflare Tunnel / Caddy) in front, or set HOST=0.0.0.0 to bind all NICs.
const HOST = process.env.HOST || '127.0.0.1';
// Optional shared-secret gate. Empty = no auth (rely on localhost/proxy).
const AUTH_TOKEN = process.env.AUTH_TOKEN || '';
const MAX_SSE = Math.max(1, Number(process.env.MAX_SSE || 50));
const MANUAL_REFRESH_MS = 10_000; // min gap between manual /api/refresh calls
const POLL_MS = Math.max(15, Number(process.env.POLL_INTERVAL || 60)) * 1000;
const AVAIL_URL =
  process.env.OVH_AVAIL_URL ||
  'https://eu.api.ovh.com/1.0/dedicated/server/datacenter/availabilities';
const SUBSIDIARY = process.env.OVH_SUBSIDIARY || 'CA';
const CATALOG_HOST =
  process.env.OVH_CATALOG_HOST ||
  ({ CA: 'https://ca.api.ovh.com/1.0', US: 'https://us.api.ovh.com/1.0' }[SUBSIDIARY] ||
    'https://eu.api.ovh.com/1.0');
const CATALOG_URL = `${CATALOG_HOST}/order/catalog/public/eco?ovhSubsidiary=${SUBSIDIARY}`;

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');
const TARGETS_FILE = path.join(DATA_DIR, 'targets.json');

// ---- in-memory state ------------------------------------------------------
let snapshot = {
  configs: [],
  byFqn: new Map(),
  lastPoll: null,
  lastOk: null,
  error: null,
  durationMs: null,
};
let catalogMap = {};
let catalogStatus = { ok: false, count: 0, fetchedAt: null, error: null, url: CATALOG_URL };
let targets = [];
const sseClients = new Set();
const notified = new Set(); // `${targetId}|${fqn}|${dc}` — currently-available & already counted
let firstRun = true;
let polling = false;
let lastManualRefresh = 0;

// ===========================================================================
// Targets
// ===========================================================================
function defaultTargets() {
  return [
    {
      id: randomUUID(),
      name: 'Canada · NVMe · available now',
      enabled: true,
      countries: ['CA'],
      datacenters: [],
      ranges: [],
      storageKinds: ['NVMe'],
      storageContains: '',
      planCodes: [],
      search: '',
      minRamGB: null,
      inStockOnly: false,
      includeComingSoon: false,
      notify: true,
    },
  ];
}

function normalizeTarget(t = {}) {
  return {
    id: t.id || randomUUID(),
    name: (t.name || 'Untitled target').toString().slice(0, 120),
    enabled: t.enabled !== false,
    countries: Array.isArray(t.countries) ? t.countries : [],
    datacenters: Array.isArray(t.datacenters) ? t.datacenters : [],
    ranges: Array.isArray(t.ranges) ? t.ranges : [],
    storageKinds: Array.isArray(t.storageKinds) ? t.storageKinds : [],
    storageContains: (t.storageContains || '').toString(),
    planCodes: Array.isArray(t.planCodes) ? t.planCodes : [],
    search: (t.search || '').toString(),
    minRamGB: t.minRamGB ? Number(t.minRamGB) : null,
    inStockOnly: !!t.inStockOnly,
    includeComingSoon: !!t.includeComingSoon,
    notify: t.notify !== false,
  };
}

async function loadTargets() {
  try {
    const raw = await readFile(TARGETS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    targets = Array.isArray(parsed) && parsed.length ? parsed.map(normalizeTarget) : defaultTargets();
  } catch {
    targets = defaultTargets();
    await saveTargets();
  }
}

async function saveTargets() {
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(TARGETS_FILE, JSON.stringify(targets, null, 2));
}

// ===========================================================================
// Matching
// ===========================================================================
function configMatches(c, t) {
  if (t.ranges.length && !t.ranges.includes(c.range)) return false;
  if (t.storageKinds.length && !t.storageKinds.some((k) => c.storageKinds.includes(k))) return false;
  if (t.storageContains && !c.storageRaw.toLowerCase().includes(t.storageContains.toLowerCase())) return false;
  if (t.planCodes.length && !t.planCodes.includes(c.planCode)) return false;
  if (t.minRamGB && (c.ramGB || 0) < t.minRamGB) return false;
  if (t.search) {
    const q = t.search.toLowerCase();
    const hay = `${c.fqn} ${c.name} ${c.memoryLabel} ${c.storageLabel} ${c.rangeLabel}`.toLowerCase();
    if (!hay.includes(q)) return false;
  }
  return true;
}

function dcAllowed(code, t) {
  if (t.datacenters.length && !t.datacenters.includes(code)) return false;
  if (t.countries.length && !t.countries.includes(dcInfo(code).country)) return false;
  return true;
}

// Returns matches for a target: [{fqn, planCode, name, memoryLabel, storageLabel,
//   rangeLabel, dc, dcLabel, flag, availability, availLabel, inStock, rank}]
function matchesForTarget(configs, t) {
  const matches = [];
  for (const c of configs) {
    if (!configMatches(c, t)) continue;
    for (const [code, avail] of Object.entries(c.dc)) {
      if (!dcAllowed(code, t)) continue;
      const am = availMeta(avail);
      const ok = am.orderable || (t.includeComingSoon && am.state === 'comingSoon');
      if (!ok) continue;
      if (t.inStockOnly && !am.inStock) continue;
      const info = dcInfo(code);
      matches.push({
        fqn: c.fqn,
        planCode: c.planCode,
        name: c.name,
        memoryLabel: c.memoryLabel,
        storageLabel: c.storageLabel,
        rangeLabel: c.rangeLabel,
        dc: code,
        dcLabel: `${info.city}, ${info.countryName}`,
        flag: info.flag,
        availability: avail,
        availLabel: am.label,
        inStock: am.inStock,
        rank: am.rank,
      });
    }
  }
  matches.sort((a, b) => a.rank - b.rank);
  return matches;
}

// Evaluate every target. Returns {summaries, alerts}.
// With withAlerts=false this is a pure read (safe for HTTP GETs): it does NOT
// touch notification state. With withAlerts=true (the poll path) it edge-detects
// newly-available matches and prunes stock that has gone away.
// First run seeds `notified` without firing alerts, so the UI shows what's
// already available without a notification storm on startup.
function runTargets(configs, withAlerts = false) {
  const summaries = [];
  const alerts = [];
  const liveKeys = new Set();

  for (const t of targets) {
    const matches = t.enabled ? matchesForTarget(configs, t) : [];

    if (withAlerts && t.enabled && t.notify) {
      for (const m of matches) {
        const key = `${t.id}|${m.fqn}|${m.dc}`;
        liveKeys.add(key);
        if (!notified.has(key)) {
          notified.add(key);
          if (!firstRun) alerts.push({ targetId: t.id, targetName: t.name, ...m });
        }
      }
    }

    summaries.push({
      id: t.id,
      name: t.name,
      enabled: t.enabled,
      notify: t.notify,
      criteria: criteriaSummary(t),
      matchCount: matches.length,
      inStockCount: matches.filter((m) => m.inStock).length,
      sample: matches.slice(0, 16),
      rule: {
        countries: t.countries,
        datacenters: t.datacenters,
        ranges: t.ranges,
        storageKinds: t.storageKinds,
        storageContains: t.storageContains,
        planCodes: t.planCodes,
        minRamGB: t.minRamGB,
        search: t.search,
        inStockOnly: t.inStockOnly,
        includeComingSoon: t.includeComingSoon,
      },
    });
  }

  if (withAlerts) {
    // Forget keys no longer live, so they alert again next time stock returns.
    for (const key of [...notified]) if (!liveKeys.has(key)) notified.delete(key);
  }

  return { summaries, alerts };
}

function criteriaSummary(t) {
  const parts = [];
  if (t.countries.length) parts.push(t.countries.join('/'));
  if (t.datacenters.length) parts.push(t.datacenters.join('/'));
  if (t.ranges.length) parts.push(t.ranges.map((r) => rangeMeta(r).label).join('/'));
  if (t.storageKinds.length) parts.push(t.storageKinds.join('/'));
  if (t.storageContains) parts.push(`storage~"${t.storageContains}"`);
  if (t.minRamGB) parts.push(`≥${t.minRamGB}GB RAM`);
  if (t.planCodes.length) parts.push(t.planCodes.join(','));
  if (t.search) parts.push(`"${t.search}"`);
  parts.push(t.inStockOnly ? 'in-stock only' : 'incl. delayed');
  return parts.join(' · ');
}

// ===========================================================================
// Polling
// ===========================================================================
// fetch JSON with a timeout and one retry, to ride out transient network blips.
async function fetchJSON(url, { tries = 2, timeoutMs = 45000 } = {}) {
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

async function poll() {
  if (polling) return;
  polling = true;
  const started = Date.now();
  try {
    const data = await fetchJSON(AVAIL_URL, { tries: 2, timeoutMs: 45000 });
    const configs = normalizeAvailabilities(data, catalogMap);

    // diff vs previous snapshot to find changed configs
    const changes = [];
    for (const c of configs) {
      const prev = snapshot.byFqn.get(c.fqn);
      if (!prev || JSON.stringify(prev.dc) !== JSON.stringify(c.dc)) changes.push(c);
    }

    const byFqn = new Map(configs.map((c) => [c.fqn, c]));
    snapshot = {
      configs,
      byFqn,
      lastPoll: started,
      lastOk: started,
      error: null,
      durationMs: Date.now() - started,
    };

    const { summaries, alerts } = runTargets(configs, true);
    const wasFirst = firstRun;
    firstRun = false;

    broadcast('update', {
      meta: meta(),
      changes: wasFirst ? [] : changes, // first poll: clients load full set via /api/state
      targets: summaries,
      alerts,
    });

    const stockMsg = alerts.length ? `, ${alerts.length} new alert(s)` : '';
    log(`poll ok: ${configs.length} configs, ${changes.length} changed${stockMsg} (${snapshot.durationMs}ms)`);
  } catch (err) {
    snapshot = { ...snapshot, lastPoll: started, error: String(err.message || err) };
    log(`poll FAILED: ${err.message || err}`);
    broadcast('update', { meta: meta(), changes: [], targets: targetSummaries(), alerts: [] });
  } finally {
    polling = false;
  }
}

function targetSummaries() {
  return runTargets(snapshot.configs, false).summaries;
}

async function refreshCatalog() {
  try {
    const data = await fetchJSON(CATALOG_URL, { tries: 2, timeoutMs: 60000 });
    catalogMap = buildCatalogMap(data);
    const count = Object.keys(catalogMap).length;
    catalogStatus = { ok: count > 0, count, fetchedAt: Date.now(), error: null, url: CATALOG_URL };
    log(`catalog loaded: ${count} plan names (${SUBSIDIARY})`);
    // stamp commercial names / prices onto the current snapshot in place
    if (snapshot.configs.length && count) {
      for (const c of snapshot.configs) {
        const cat = catalogMap[c.planCode];
        if (!cat) continue;
        if (cat.name) c.name = cat.name;
        const price = priceForConfig(cat, c.memoryRaw, c.storageRaw);
        c.price = price;
        c.currency = cat.currency ?? c.currency;
        c.priceText = price != null ? formatMoney(price, cat.currency) : c.priceText;
      }
      broadcast('update', { meta: meta(), changes: [], targets: targetSummaries(), alerts: [], refetch: true });
    }
  } catch (err) {
    catalogStatus = { ok: false, count: 0, fetchedAt: Date.now(), error: String(err.message || err), url: CATALOG_URL };
    log(`catalog unavailable (using derived names): ${err.message || err}`);
  }
}

// ===========================================================================
// SSE
// ===========================================================================
function broadcast(event, payload) {
  const line = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(line);
    } catch {
      sseClients.delete(res);
    }
  }
}

function meta() {
  return {
    lastPoll: snapshot.lastPoll,
    lastOk: snapshot.lastOk,
    error: snapshot.error,
    durationMs: snapshot.durationMs,
    pollMs: POLL_MS,
    configCount: snapshot.configs.length,
    source: AVAIL_URL,
    subsidiary: SUBSIDIARY,
    secured: !!AUTH_TOKEN,
    catalog: catalogStatus,
  };
}

// Static metadata the UI needs to build filter controls.
function staticMeta() {
  const dcs = {};
  for (const [code, info] of Object.entries(DATACENTERS)) dcs[code] = info;
  // also include any live datacenters not in the static map
  for (const c of snapshot.configs) {
    for (const code of Object.keys(c.dc)) if (!dcs[code]) dcs[code] = dcInfo(code);
  }
  const countries = {};
  for (const info of Object.values(dcs)) countries[info.country] = { name: info.countryName, flag: info.flag };
  const ranges = {};
  for (const c of snapshot.configs) ranges[c.range] = { label: c.rangeLabel, color: c.rangeColor };
  return { datacenters: dcs, countries, ranges };
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

function sendJSON(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

async function readBody(req) {
  const chunks = [];
  for await (const ch of req) chunks.push(ch);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    return {};
  }
}

async function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(PUBLIC_DIR, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(PUBLIC_DIR)) {
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

  try {
    // optional shared-secret gate
    if (AUTH_TOKEN) {
      if (!tokenOk(providedToken(req, url))) {
        res.writeHead(401, { 'content-type': 'text/plain' });
        res.end('Unauthorized. Append ?token=YOUR_TOKEN to the URL once.');
        return;
      }
      // persist a valid ?token= as a cookie so fetch()/EventSource authenticate,
      // and strip it from the address bar on page loads
      if (url.searchParams.get('token')) {
        const cookie = `kw_token=${encodeURIComponent(AUTH_TOKEN)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000`;
        if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
          url.searchParams.delete('token');
          res.writeHead(302, { 'Set-Cookie': cookie, Location: url.pathname + (url.search || '') });
          res.end();
          return;
        }
        res.setHeader('Set-Cookie', cookie);
      }
    }

    // --- API ---
    if (pathname === '/api/state') {
      return sendJSON(res, 200, {
        meta: meta(),
        static: staticMeta(),
        configs: snapshot.configs,
        targets: targetSummaries(),
      });
    }

    if (pathname === '/api/meta') {
      return sendJSON(res, 200, { meta: meta(), static: staticMeta() });
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
      const ping = setInterval(() => {
        try { res.write(': ping\n\n'); } catch { /* ignore */ }
      }, 25000);
      req.on('close', () => {
        clearInterval(ping);
        sseClients.delete(res);
      });
      return;
    }

    if (pathname === '/api/targets') {
      if (req.method === 'GET') return sendJSON(res, 200, targetSummaries());
      if (req.method === 'POST') {
        const body = await readBody(req);
        const t = normalizeTarget(body);
        targets.push(t);
        await saveTargets();
        afterTargetChange();
        return sendJSON(res, 201, { ok: true, target: t, targets: targetSummaries() });
      }
    }

    const tm = pathname.match(/^\/api\/targets\/([\w-]+)$/);
    if (tm) {
      const id = tm[1];
      const idx = targets.findIndex((t) => t.id === id);
      if (idx === -1) return sendJSON(res, 404, { ok: false, error: 'no such target' });
      if (req.method === 'PUT') {
        const body = await readBody(req);
        targets[idx] = normalizeTarget({ ...targets[idx], ...body, id });
        await saveTargets();
        afterTargetChange();
        return sendJSON(res, 200, { ok: true, targets: targetSummaries() });
      }
      if (req.method === 'DELETE') {
        targets.splice(idx, 1);
        await saveTargets();
        afterTargetChange();
        return sendJSON(res, 200, { ok: true, targets: targetSummaries() });
      }
    }

    if (pathname === '/api/refresh' && req.method === 'POST') {
      const now = Date.now();
      if (now - lastManualRefresh < MANUAL_REFRESH_MS) {
        return sendJSON(res, 429, { ok: false, error: 'refreshing too often' });
      }
      lastManualRefresh = now;
      poll();
      return sendJSON(res, 202, { ok: true });
    }

    if (pathname === '/api/test-alert' && req.method === 'POST') {
      broadcast('update', {
        meta: meta(),
        changes: [],
        targets: targetSummaries(),
        alerts: [{
          targetId: 'test', targetName: 'Test alert', fqn: 'test.config',
          planCode: 'TEST', name: 'Test server', memoryLabel: '32 GB', storageLabel: '2×450 GB NVMe',
          rangeLabel: 'Kimsufi', dc: 'bhs', dcLabel: 'Beauharnois, Canada', flag: '🇨🇦',
          availability: '1H-low', availLabel: 'In stock (low)', inStock: true,
        }],
      });
      return sendJSON(res, 200, { ok: true });
    }

    if (pathname === '/favicon.ico') {
      res.writeHead(204).end();
      return;
    }

    // --- static ---
    return serveStatic(req, res, pathname);
  } catch (err) {
    log(`request error: ${err.stack || err}`);
    if (!res.headersSent) sendJSON(res, 500, { ok: false, error: String(err.message || err) });
  }
});

function afterTargetChange() {
  // re-seed notification state so editing targets doesn't fire a storm, then
  // push fresh summaries to all clients.
  notified.clear();
  firstRun = true;
  const { summaries } = runTargets(snapshot.configs, true); // re-seed notified, no alerts
  firstRun = false;
  broadcast('update', { meta: meta(), changes: [], targets: summaries, alerts: [] });
}

function log(msg) {
  const t = new Date().toISOString().replace('T', ' ').slice(0, 19);
  console.log(`[${t}] ${msg}`);
}

// ===========================================================================
// Boot
// ===========================================================================
async function main() {
  await mkdir(DATA_DIR, { recursive: true });
  await loadTargets();
  server.listen(PORT, HOST, () => {
    log(`Kimsufi monitor on http://${HOST}:${PORT}  (polling every ${POLL_MS / 1000}s)`);
    log(`bind: ${HOST} · auth: ${AUTH_TOKEN ? 'token required' : 'none (loopback/proxy)'} · max SSE: ${MAX_SSE}`);
    log(`source: ${AVAIL_URL}`);
  });
  // catalogue is best-effort enrichment; don't block first poll on it
  refreshCatalog();
  await poll();
  setInterval(poll, POLL_MS);
  setInterval(refreshCatalog, 6 * 60 * 60 * 1000);
}

main().catch((err) => {
  log(`fatal: ${err.stack || err}`);
  process.exit(1);
});
