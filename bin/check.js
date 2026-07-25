#!/usr/bin/env node
// bin/check.js — one poll, then exit.
//
// This is what runs on a schedule where nothing stays resident: GitHub Actions,
// cron, a container job. It does the same work the long-lived server does per
// tick, but every scrap of memory it needs between runs is on disk.
//
// Two shapes, chosen by flags rather than by which secrets happen to be present,
// so a misconfigured run fails loudly instead of quietly not notifying anyone:
//
//   --snapshot-only   poll, write the public snapshot and the public event log.
//                     No watches, no notifications, no alert memory. This is the
//                     public deployment: it must exit 0 with no secrets set.
//
//   (default)         the above, plus evaluate watches and send notifications.
//                     This is what a private fork runs.
//
// Usage:
//   node bin/check.js --snapshot-only --out dist
//   node bin/check.js --out dist
//   node bin/check.js --test-channel telegram

import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { fetchAvailability, fetchCatalog, AVAIL_URL_DEFAULT } from '../core/poll.js';
import { runWatches } from '../core/watches.js';
import { diffEvents, closeDurations, toPublic, trim } from '../core/history.js';
import { dispatch, testChannel, channelStatus } from '../core/notify/index.js';
import {
  loadWatches, loadState, saveState, loadPrevious, savePrevious, loadEvents, saveEvents,
} from '../core/store-node.js';
import { buildSnapshot, writeSnapshot } from './snapshot.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  const next = process.argv[i + 1];
  return next && !next.startsWith('--') ? next : true;
}
const has = (name) => process.argv.includes(`--${name}`);

function log(msg) {
  console.log(`[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`);
}

async function main() {
  const snapshotOnly = has('snapshot-only');
  const dataDir = String(arg('data', path.join(ROOT, 'data')));
  const outDir = String(arg('out', path.join(ROOT, 'dist')));
  const subsidiary = process.env.OVH_SUBSIDIARY || 'CA';
  const availUrl = process.env.OVH_AVAIL_URL || AVAIL_URL_DEFAULT;

  // One-off: prove a channel works, then stop.
  const which = arg('test-channel');
  if (which && which !== true) {
    const r = await testChannel(String(which), { subsidiary });
    log(`test ${r.channel}: ${r.ok ? 'sent' : `FAILED — ${r.error}`}`);
    process.exit(r.ok ? 0 : 1);
  }
  if (has('channels')) {
    for (const c of channelStatus()) {
      log(`${c.channel.padEnd(9)} ${c.configured ? 'on ' : 'off'} ${c.detail || ''}`);
    }
    return;
  }

  const stateFile = path.join(dataDir, 'state.json');
  const prevFile = path.join(dataDir, 'previous.json');
  const eventsFile = path.join(dataDir, 'events.jsonl');

  // Catalogue first, so the very first snapshot already has names and prices
  // rather than publishing derived placeholders for five minutes.
  let catalogMap = {};
  let catalogInfo = { ok: false, count: 0, error: null };
  try {
    const cat = await fetchCatalog(subsidiary);
    catalogMap = cat.map;
    catalogInfo = { ok: cat.count > 0, count: cat.count, error: null, url: cat.url };
    log(`catalogue: ${cat.count} plan names (${subsidiary})`);
  } catch (err) {
    catalogInfo = { ok: false, count: 0, error: String(err.message || err) };
    log(`catalogue unavailable, using derived names: ${err.message || err}`);
  }

  const { configs, durationMs } = await fetchAvailability(availUrl, catalogMap);
  log(`feed: ${configs.length} configurations in ${durationMs}ms`);
  if (!configs.length) throw new Error('feed returned no configurations — refusing to publish an empty snapshot');

  const now = Date.now();

  // --- history: transitions since the previous run -------------------------
  const prev = await loadPrevious(prevFile);
  const fresh = diffEvents(prev.byFqn, configs, now);
  const existing = await loadEvents(eventsFile);
  const events = closeDurations(trim([...existing, ...fresh]));
  if (prev.byFqn.size === 0) log('no previous snapshot — seeding, no transitions recorded');
  else log(`transitions: ${fresh.length} (${fresh.filter((e) => e.dir === 'up').length} came into stock)`);

  // --- watches + notifications -------------------------------------------
  let summaries = [];
  if (!snapshotOnly) {
    const { watches, source } = await loadWatches({
      file: path.join(dataDir, 'watches.json'),
      legacyFile: path.join(dataDir, 'targets.json'),
    });
    log(`watches: ${watches.length} from ${source}`);
    const state = await loadState(stateFile);
    const res = runWatches(configs, watches, state, { withAlerts: true, now });
    summaries = res.summaries;
    if (res.seeded) {
      log('first run for these watches — recorded current stock without notifying');
    } else if (res.alerts.length) {
      const out = await dispatch(res.alerts, { subsidiary });
      for (const s of out.sent) {
        log(`notify ${s.channel}: ${s.ok ? 'sent' : `FAILED — ${s.error}`}`);
      }
      for (const s of out.skipped) log(`notify ${s.channel}: skipped (${s.reason})`);
      // Attribute the alert to its watch in the private log only.
      for (const a of res.alerts) {
        events.push({
          t: now, fqn: a.fqn, planCode: a.planCode, dc: a.dc, dir: 'alert',
          model: a.model || a.name, range: a.range, storage: a.storageLabel, ram: a.ramGB ?? null,
          watchId: a.watchId, watchName: a.watchName, channels: a.channels,
        });
      }
      log(`alerts: ${res.alerts.length}`);
    } else {
      log('alerts: none');
    }
    await saveState(stateFile, state, now);
  } else {
    log('snapshot-only: no watches evaluated, no notifications sent');
  }

  // --- persist + publish --------------------------------------------------
  await saveEvents(eventsFile, events);
  await savePrevious(prevFile, configs, now);

  const publicEvents = events.filter((e) => e.dir !== 'alert').map(toPublic);
  const snap = buildSnapshot(configs, {
    now, subsidiary, catalog: catalogInfo, durationMs, events: publicEvents,
  });
  await mkdir(outDir, { recursive: true });
  const written = await writeSnapshot(outDir, snap, publicEvents);
  for (const w of written) log(`wrote ${path.relative(ROOT, w.file)} (${(w.bytes / 1024).toFixed(0)} KB, ${(w.gzip / 1024).toFixed(0)} KB gzipped)`);

  if (summaries.length) {
    for (const s of summaries) log(`  watch "${s.name}": ${s.matchCount} matches, ${s.inStockCount} in stock`);
  }
}

main().catch((err) => {
  console.error(`[fatal] ${err.stack || err}`);
  process.exit(1);
});
