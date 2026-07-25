// bin/snapshot.js
// Build the static payload the GitHub Pages dashboard reads.
//
// Size is the whole design constraint. The server's /api/state is 11.5 MB of
// JSON, which is fine over localhost and absurd to publish and re-fetch every
// five minutes. Two files instead:
//
//   snapshot.json       eco configurations that are orderable somewhere.
//                       Small, fetched on load. Enough for client-side alerting:
//                       a configuration *appearing* in this set is exactly the
//                       unavailable -> available transition a watch fires on.
//
//   snapshot-full.json  everything, including non-eco ranges and rows with no
//                       stock anywhere. Fetched only when the visitor unticks
//                       "orderable only" or asks for non-eco ranges.
//
// Each row keeps its complete datacenter map either way, so the matrix can still
// draw out-of-stock cells and distinguish them from "not sold here".

import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { dcColumns, tierCounts, isEco, availMeta } from '../core/ovh.js';

const EVENT_TAIL = 400; // what the timeline panel shows

/** Only the fields the dashboard and the client-side matcher actually use. */
function slimConfig(c) {
  const row = {
    f: c.fqn,
    p: c.planCode,
    m: c.model,
    c: c.cpu,
    r: c.range,
    g: c.ramGB,
    s: c.storageLabel,
    k: c.storageKind,
    K: c.storageKinds,
    d: c.dc,
  };
  if (c.priceText) row.$ = c.priceText;
  if (c.price != null) row.n = Math.round(c.price * 100) / 100;
  // Raw codes are only needed for free-text storage matching; keep them short.
  if (c.storageRaw) row.R = c.storageRaw;
  if (c.systemStorageRaw) row.S = c.systemStorageRaw;
  if (c.memoryLabel) row.M = c.memoryLabel;
  return row;
}

export function buildSnapshot(configs, { now, subsidiary, catalog, durationMs, events = [] }) {
  const eco = configs.filter((c) => isEco(c.range));
  const orderable = (c) => Object.values(c.dc).some((v) => availMeta(v).orderable);

  const ranges = {};
  for (const c of configs) {
    if (!ranges[c.range]) ranges[c.range] = { label: c.rangeLabel, eco: !!c.eco, count: 0 };
    ranges[c.range].count++;
  }

  const meta = {
    at: now,
    subsidiary,
    catalog,
    durationMs,
    // Stated plainly so the page can be honest about what it is: a scheduled
    // job with a five-minute floor that may be delayed, not a live feed.
    cadence: { kind: 'scheduled', everyMinutes: 5, note: 'GitHub Actions schedule; runs can be delayed or dropped' },
    counts: {
      all: configs.length,
      eco: eco.length,
      ecoOrderable: eco.filter(orderable).length,
    },
    tiers: tierCounts(eco),
    tiersAll: tierCounts(configs),
  };

  return {
    primary: {
      meta,
      dcs: dcColumns(configs),
      ranges,
      configs: eco.filter(orderable).map(slimConfig),
      events: events.slice(-EVENT_TAIL),
    },
    full: {
      meta: { ...meta, full: true },
      dcs: dcColumns(configs),
      ranges,
      configs: configs.map(slimConfig),
    },
  };
}

async function writeOne(dir, name, obj) {
  const file = path.join(dir, name);
  const text = JSON.stringify(obj);
  await writeFile(file, text);
  return { file, bytes: Buffer.byteLength(text), gzip: gzipSync(text).length };
}

export async function writeSnapshot(outDir, snap) {
  await mkdir(outDir, { recursive: true });
  const written = [];
  written.push(await writeOne(outDir, 'snapshot.json', snap.primary));
  written.push(await writeOne(outDir, 'snapshot-full.json', snap.full));
  return written;
}
