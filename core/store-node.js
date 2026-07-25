// core/store-node.js
// Filesystem persistence for the server and the cron job.
//
// Node-only, deliberately named so: the isomorphic modules (ovh, watches, state,
// history, deeplink) must never import this, or they stop working in a browser.

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import path from 'node:path';
import { AlertState } from './state.js';
import { normalizeWatch, defaultWatches, MAX_WATCHES } from './watches.js';
import { parseJSONL, toJSONL, trim, MAX_EVENTS_DEFAULT } from './history.js';

/** Write via a temp file + rename so a crash mid-write cannot truncate state. */
async function writeAtomic(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  await writeFile(tmp, text);
  await rename(tmp, file);
}

async function readJSON(file, fallback = null) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch { return fallback; }
}

// ---- watches --------------------------------------------------------------

/**
 * Load watches, in priority order:
 *   1. WATCHES_JSON env — how a private fork supplies them without committing.
 *   2. the watches file (gitignored).
 *   3. a legacy data/targets.json, so an existing install migrates rather than
 *      silently losing the filter it has been running.
 *   4. one sensible default.
 */
export async function loadWatches({ file, legacyFile, env = process.env } = {}) {
  if (env.WATCHES_JSON) {
    try {
      const parsed = JSON.parse(env.WATCHES_JSON);
      if (Array.isArray(parsed) && parsed.length) {
        return { watches: parsed.slice(0, MAX_WATCHES).map(normalizeWatch), source: 'WATCHES_JSON' };
      }
    } catch {
      throw new Error('WATCHES_JSON is set but is not valid JSON');
    }
  }
  const own = await readJSON(file);
  if (Array.isArray(own) && own.length) {
    return { watches: own.slice(0, MAX_WATCHES).map(normalizeWatch), source: file };
  }
  if (legacyFile) {
    const legacy = await readJSON(legacyFile);
    if (Array.isArray(legacy) && legacy.length) {
      const watches = legacy.slice(0, MAX_WATCHES).map(normalizeWatch);
      await saveWatches(file, watches); // migrate forward once
      return { watches, source: `${legacyFile} (migrated)` };
    }
  }
  const watches = defaultWatches();
  await saveWatches(file, watches);
  return { watches, source: 'default' };
}

export async function saveWatches(file, watches) {
  await writeAtomic(file, JSON.stringify(watches, null, 2));
}

// ---- alert state ----------------------------------------------------------

export async function loadState(file) {
  return AlertState.fromJSON(await readJSON(file, {}));
}

export async function saveState(file, state, now = Date.now()) {
  await writeAtomic(file, JSON.stringify(state.toJSON(now)));
}

// ---- previous snapshot (for diffing between runs) -------------------------

/**
 * The cron job has no memory of the last poll, so the availability map from the
 * previous run is persisted and reloaded. Only fqn -> datacenter map is kept:
 * that is all diffing needs, and it keeps the file an order of magnitude
 * smaller than a full snapshot.
 */
export async function loadPrevious(file) {
  const data = await readJSON(file, null);
  const map = new Map();
  if (data && data.dc) for (const [fqn, dc] of Object.entries(data.dc)) map.set(fqn, { fqn, dc });
  return { byFqn: map, at: data?.at || null };
}

export async function savePrevious(file, configs, now = Date.now()) {
  const dc = {};
  for (const c of configs) dc[c.fqn] = c.dc;
  await writeAtomic(file, JSON.stringify({ at: now, dc }));
}

// ---- event log -----------------------------------------------------------

export async function loadEvents(file) {
  try { return parseJSONL(await readFile(file, 'utf8')); } catch { return []; }
}

export async function saveEvents(file, events, max = MAX_EVENTS_DEFAULT) {
  await writeAtomic(file, toJSONL(trim(events, max)));
}
