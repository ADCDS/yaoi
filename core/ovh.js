// core/ovh.js
// Normalisation helpers for the OVH "Eco" (Kimsufi / Rise / So you Start / …)
// dedicated-server availability feed.
//
// The single source of truth is the public, no-auth endpoint:
//   GET https://eu.api.ovh.com/1.0/dedicated/server/datacenter/availabilities
// which returns one row per *exact configuration* (fqn = planCode + memory +
// storage) with an availability value per datacenter. That per-config
// granularity is the whole point: the marketing catalogue may advertise a
// config that the order page won't actually sell in a given country — here we
// read the order-level truth directly.
//
// ISOMORPHIC: this module must stay importable by both Node and the browser.
// No `node:` imports, no filesystem, no globals beyond fetch-free pure code.
// The browser imports it to match watches client-side; a second copy of this
// logic living in public/app.js is exactly the drift we are avoiding.

// ---------------------------------------------------------------------------
// Datacenter -> location metadata
// ---------------------------------------------------------------------------
// Codes observed live in the feed, plus other well-known OVH datacenters.
export const DATACENTERS = {
  bhs:            { city: 'Beauharnois',  country: 'CA', countryName: 'Canada',    flag: '🇨🇦', region: 'North America' },
  'ca-east-tor-a':{ city: 'Toronto',      country: 'CA', countryName: 'Canada',    flag: '🇨🇦', region: 'North America' },
  vin:            { city: 'Vint Hill',    country: 'US', countryName: 'USA',       flag: '🇺🇸', region: 'North America' },
  hil:            { city: 'Hillsboro',    country: 'US', countryName: 'USA',       flag: '🇺🇸', region: 'North America' },
  gra:            { city: 'Gravelines',   country: 'FR', countryName: 'France',    flag: '🇫🇷', region: 'Europe' },
  rbx:            { city: 'Roubaix',      country: 'FR', countryName: 'France',    flag: '🇫🇷', region: 'Europe' },
  sbg:            { city: 'Strasbourg',   country: 'FR', countryName: 'France',    flag: '🇫🇷', region: 'Europe' },
  'eu-west-par-a':{ city: 'Paris',        country: 'FR', countryName: 'France',    flag: '🇫🇷', region: 'Europe' },
  'eu-west-par-b':{ city: 'Paris',        country: 'FR', countryName: 'France',    flag: '🇫🇷', region: 'Europe' },
  'eu-west-par-c':{ city: 'Paris',        country: 'FR', countryName: 'France',    flag: '🇫🇷', region: 'Europe' },
  fra:            { city: 'Frankfurt',    country: 'DE', countryName: 'Germany',   flag: '🇩🇪', region: 'Europe' },
  lon:            { city: 'London',       country: 'GB', countryName: 'UK',        flag: '🇬🇧', region: 'Europe' },
  eri:            { city: 'Erith',        country: 'GB', countryName: 'UK',        flag: '🇬🇧', region: 'Europe' },
  waw:            { city: 'Warsaw',       country: 'PL', countryName: 'Poland',    flag: '🇵🇱', region: 'Europe' },
  sgp:            { city: 'Singapore',    country: 'SG', countryName: 'Singapore', flag: '🇸🇬', region: 'Asia-Pacific' },
  syd:            { city: 'Sydney',       country: 'AU', countryName: 'Australia', flag: '🇦🇺', region: 'Asia-Pacific' },
  // The feed reports Mumbai as `ynm`, not `mum`. Evidence: every one of the
  // 1,775 configurations offered there carries a `-mum` plan-code suffix
  // (e.g. 24rise01-v1-mum). Before this mapping existed they all fell through
  // to country '??' and were excluded by every country filter — invisible.
  ynm:            { city: 'Mumbai',       country: 'IN', countryName: 'India',     flag: '🇮🇳', region: 'Asia-Pacific' },
  mum:            { city: 'Mumbai',       country: 'IN', countryName: 'India',     flag: '🇮🇳', region: 'Asia-Pacific' },
};

export function dcInfo(code) {
  return (
    DATACENTERS[code] || {
      city: code,
      country: '??',
      countryName: 'Other',
      flag: '🌐',
      region: 'Other',
    }
  );
}

// ---------------------------------------------------------------------------
// Commercial range, inferred from the planCode (catalogue-independent).
// ---------------------------------------------------------------------------
const RANGE_META = {
  kimsufi:    { label: 'Kimsufi',      eco: true },
  soyoustart: { label: 'So you Start', eco: true },
  rise:       { label: 'Rise',         eco: true },
  advance:    { label: 'Advance',      eco: true },
  scale:      { label: 'Scale',        eco: false },
  hgr:        { label: 'High Grade',   eco: false },
  hci:        { label: 'HCI',          eco: false },
  sds:        { label: 'SDS',          eco: false },
  other:      { label: 'Other',        eco: false },
};

export function rangeMeta(range) {
  return RANGE_META[range] || RANGE_META.other;
}

// Ranges OVH actually sells through the public "eco" catalogue — the only ones
// with an obtainable price and a real order page. Everything else is shown only
// when the user asks for it, and labelled as having no public price.
export const ECO_RANGES = Object.freeze(
  Object.keys(RANGE_META).filter((r) => RANGE_META[r].eco),
);
export function isEco(range) {
  return !!rangeMeta(range).eco;
}

export function classifyRange(planCode) {
  const pc = String(planCode || '').toLowerCase();
  let base = 'other';
  if (/rise/.test(pc)) base = 'rise';
  else if (/sys/.test(pc)) base = 'soyoustart';
  else if (/adv/.test(pc)) base = 'advance';
  else if (/scale/.test(pc)) base = 'scale';
  else if (/hgr|highgrade/.test(pc)) base = 'hgr';
  else if (/hci/.test(pc)) base = 'hci';
  else if (/sds/.test(pc)) base = 'sds';
  else if (/(^|\d)sk|kimsufi|(^|\d)ks/.test(pc)) base = 'kimsufi';
  const game = /game/.test(pc);
  const storage = /stor/.test(pc);
  return { range: base, game, storage };
}

// ---------------------------------------------------------------------------
// Spec parsers (memory / storage codes -> human labels)
// ---------------------------------------------------------------------------
// Memory codes seen live, all five shapes:
//   ram-32g-ecc-2133          ram-96g-ddr5-ecc-4800
//   ram-64g-on-die-ecc-5600   ram-32g-ddr5-on-die-ecc-4800
//   ram-32g-noecc-2133
// The previous parser only understood `ram-Ng-(ecc|noecc)-N`, so the ~2,500
// ddr*/on-die-ecc configurations silently reported ECC as absent. Capacity was
// always right, which is why filtering worked and the bug stayed hidden.
export function parseMemory(code) {
  const raw = String(code || '');
  const cap = /ram-(\d+)g/.exec(raw);
  if (!cap) return { ramGB: 0, label: raw || '—', ecc: false, speed: null, ddr: null };
  const ramGB = Number(cap[1]);
  const noecc = /\bnoecc\b/.test(raw);
  const ecc = !noecc && /\becc\b/.test(raw);
  const onDie = /on-die-ecc/.test(raw);
  const ddrM = /ddr(\d)/.exec(raw);
  const ddr = ddrM ? Number(ddrM[1]) : null;
  const speedM = /-(\d{3,5})$/.exec(raw);
  const speed = speedM ? Number(speedM[1]) : null;

  let label = `${ramGB} GB`;
  if (ddr) label += ` DDR${ddr}`;
  if (ecc) label += onDie ? ' ECC' : ' ECC';
  if (speed) label += ` ${speed}`;
  return { ramGB, label, ecc, onDie, ddr, speed };
}

const MEDIA = {
  nvme: 'NVMe',
  ssd: 'SSD',
  sas: 'SAS',
  sa: 'SATA',
  hdd: 'HDD',
};
// best (most desirable) media wins for the primary "kind"
const MEDIA_RANK = { NVMe: 0, SSD: 1, SAS: 2, SATA: 3, HDD: 4 };

export const STORAGE_KINDS = Object.freeze(['NVMe', 'SSD', 'SAS', 'SATA', 'HDD']);

function fmtSize(gb) {
  if (gb >= 1000) {
    const tb = gb / 1000;
    return `${Number(tb.toFixed(2))} TB`;
  }
  return `${gb} GB`;
}

// Storage codes come in two spellings for the media, and the old regex
// `(\d+)x(\d+)(nvme|ssd|sas|sa)\b` only understood the first:
//
//   media glued on      softraid-2x450nvme            ✓ parsed before
//   media after a dash  hardraid-24x22000-hdd-sas     ✗ missed entirely
//
// The second form mattered more than it looked. On mixed layouts such as
// `hardraid-24x22000-hdd-sas-2x960nvme` the old regex matched *only* the NVMe
// group, so a 24×22 TB storage server rendered as a 2×960 GB NVMe box — wrong
// data rather than absent data. `-?` plus an optional trailing bus token
// handles both spellings in one pass.
const DRIVE_RE = /(\d+)x(\d+)-?(hdd|nvme|ssd|sas|sa)(?:-(sas|sata|sa))?\b/g;

export function parseStorage(code) {
  const raw = String(code || '');
  const lc = raw.toLowerCase();
  let raid = '';
  if (lc.startsWith('hybridsoftraid')) raid = 'hybrid';
  else if (lc.startsWith('hardraid')) raid = 'HW RAID';
  else if (lc.startsWith('softraid')) raid = 'SW RAID';
  else if (lc.startsWith('noraid')) raid = 'no RAID';

  const drives = [];
  const kinds = new Set();
  DRIVE_RE.lastIndex = 0;
  let mm;
  while ((mm = DRIVE_RE.exec(lc)) !== null) {
    const count = Number(mm[1]);
    const size = Number(mm[2]);
    const media = MEDIA[mm[3]] || mm[3].toUpperCase();
    const bus = mm[4] ? (MEDIA[mm[4]] || mm[4].toUpperCase()) : null;
    drives.push({ count, size, media, bus });
    kinds.add(media);
  }
  if (drives.length === 0) {
    // e.g. "noraid-0" (diskless) or an unknown layout
    return { label: raw || '—', kind: '—', kinds: [], raid, drives: [], totalGB: 0 };
  }
  const kindList = [...kinds].sort((a, b) => (MEDIA_RANK[a] ?? 9) - (MEDIA_RANK[b] ?? 9));
  const primary = kindList[0];
  const totalGB = drives.reduce((s, d) => s + d.count * d.size, 0);
  const label = drives
    .map((d) => `${d.count}×${fmtSize(d.size)} ${d.media}`)
    .join(' + ');
  return { label, kind: primary, kinds: kindList, raid, drives, totalGB };
}

// ---------------------------------------------------------------------------
// Availability interpretation
// ---------------------------------------------------------------------------
// Values seen: 1H-high, 1H-low, 24H, 72H, 240H, 480H, 720H, 1440H,
//              comingSoon, unavailable, unknown, (null)
export function availMeta(value) {
  const v = String(value || '').trim();
  if (!v || v === 'unavailable') return { state: 'unavailable', orderable: false, inStock: false, rank: Infinity, label: 'Unavailable' };
  if (v === 'unknown') return { state: 'unknown', orderable: false, inStock: false, rank: 90000, label: 'Unknown' };
  if (v === 'comingSoon') return { state: 'comingSoon', orderable: false, inStock: false, rank: 80000, label: 'Coming soon' };

  const m = /^(\d+)H(?:-(low|high))?$/.exec(v);
  if (m) {
    const hours = Number(m[1]);
    const level = m[2]; // low | high | undefined
    const inStock = hours <= 1;
    // rank: fewer hours = better; "high" stock slightly ahead of "low"
    const rank = hours - (level === 'high' ? 0.5 : level === 'low' ? 0 : 0.25);
    let label;
    if (inStock) label = level ? `In stock (${level})` : 'In stock';
    else if (hours < 48) label = `~${hours}h`;
    else label = `~${Math.round(hours / 24)} days`;
    return { state: inStock ? 'inStock' : 'delayed', orderable: true, inStock, rank, label, hours, level };
  }
  // Unknown but non-empty token: treat as orderable-ish but rank low.
  return { state: 'other', orderable: true, inStock: false, rank: 70000, label: v };
}

// ---------------------------------------------------------------------------
// The delivery ladder
// ---------------------------------------------------------------------------
// Availability is not a boolean: it is a position on an ordered time-to-delivery
// scale. These tiers are the rungs. `notSold` is deliberately separate from
// `none`: a datacenter absent from a configuration's map is not selling that
// configuration at all, which is a different fact from being out of stock.
export const TIERS = Object.freeze([
  { key: 'now',     label: 'in stock',    sub: 'ready in ≤1h',      max: 1 },
  { key: 'h24',     label: '24 hours',    sub: 'next-day build',    max: 24 },
  { key: 'h72',     label: '72 hours',    sub: 'three-day wait',    max: 72 },
  { key: 'long',    label: 'long wait',   sub: '10 days or more',   max: Infinity },
  { key: 'soon',    label: 'coming soon', sub: 'not orderable yet', max: null },
  { key: 'none',    label: 'out of stock',sub: 'nothing to buy',    max: null },
  { key: 'notSold', label: 'not sold',    sub: 'not offered here',  max: null },
]);

export function tierOf(value) {
  if (value === undefined || value === null) return 'notSold';
  const am = availMeta(value);
  if (am.state === 'comingSoon') return 'soon';
  if (!am.orderable) return 'none';
  if (am.hours === undefined) return 'none';
  if (am.hours <= 1) return 'now';
  if (am.hours <= 24) return 'h24';
  if (am.hours <= 72) return 'h72';
  return 'long';
}

/**
 * The datacenter columns for the matrix, grouped by country.
 *
 * Built from live data only: the static map lists datacenters (vin, hil, eri)
 * that currently have no rows at all, and offering them as filters produced
 * controls that could only ever return nothing. Order is stable across runs so
 * the layout does not reshuffle when a datacenter briefly empties out.
 */
export function dcColumns(configs) {
  const live = new Set();
  for (const c of configs) for (const code in c.dc) live.add(code);
  const known = Object.keys(DATACENTERS);
  return [...live]
    .sort((a, b) => {
      const ia = dcInfo(a), ib = dcInfo(b);
      if (ia.country !== ib.country) return ia.country.localeCompare(ib.country);
      return known.indexOf(a) - known.indexOf(b);
    })
    .map((code) => ({ code, ...dcInfo(code) }));
}

// Count config×datacenter pairs per tier. The UI builds its ladder from this,
// so rungs with no live data are never rendered — right now nothing sits at
// 240H or 480H, and a hardcoded ladder would show two dead rungs.
export function tierCounts(configs) {
  const counts = {};
  for (const c of configs) {
    for (const dc in c.dc) {
      const t = tierOf(c.dc[dc]);
      counts[t] = (counts[t] || 0) + 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Top-level: raw feed -> array of normalised config records
// ---------------------------------------------------------------------------
export function normalizeAvailabilities(rows, catalogMap = {}) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (!r || !r.fqn) continue;
    const { range, game, storage } = classifyRange(r.planCode);
    const mem = parseMemory(r.memory);
    const dataStor = parseStorage(r.storage);
    const sysStor = r.systemStorage ? parseStorage(r.systemStorage) : null;
    // `noraid-0` means "no data array" — the machine's actual disks are then
    // reported under systemStorage instead. 920 configurations (151 orderable)
    // are like this, and reading only `storage` displayed the literal string
    // "noraid-0" and left them unreachable by every storage-kind filter, even
    // though their real disks (2×960 GB NVMe, …) were known all along.
    const stor = dataStor.drives.length ? dataStor : (sysStor?.drives.length ? sysStor : dataStor);

    const dc = {};
    let best = Infinity;
    let orderableCount = 0;
    let inStockCount = 0;
    for (const d of r.datacenters || []) {
      if (!d || !d.datacenter) continue;
      dc[d.datacenter] = d.availability;
      const am = availMeta(d.availability);
      if (am.rank < best) best = am.rank;
      if (am.orderable) orderableCount++;
      if (am.inStock) inStockCount++;
    }

    const cat = catalogMap[r.planCode];
    const rm = rangeMeta(range);
    const name = cat?.name || `${rm.label}${game ? ' Game' : ''}${storage ? ' Storage' : ''}`;
    const price = priceForConfig(cat, r.memory, r.storage);
    const currency = cat?.currency ?? null;

    out.push({
      fqn: r.fqn,
      planCode: r.planCode,
      server: r.server,
      range,
      rangeLabel: rm.label,
      eco: !!rm.eco,
      game,
      storageServer: storage,
      name,
      // The model designation on its own ("KS-1"), split from the CPU half of
      // the catalogue name ("KS-1 | Intel Xeon-D 1520"). Both halves are shown
      // separately in the table, and the model is what the order deep-link
      // slug is built from.
      model: splitCatalogName(name).model,
      cpu: splitCatalogName(name).cpu,
      price,
      priceText: price != null ? formatMoney(price, currency) : null,
      currency,
      ramGB: mem.ramGB,
      memoryRaw: r.memory || '',
      memoryLabel: mem.label,
      storageKind: stor.kind,
      storageKinds: stor.kinds,
      storageLabel: stor.drives.length ? stor.label : 'Diskless',
      storageRaw: r.storage || '',
      systemStorageRaw: r.systemStorage || '',
      // True when the disks shown come from systemStorage because the data
      // array is `noraid-0`. Free-text storage matching searches both codes so
      // a watch for "nvme" still finds these.
      storageFromSystem: !dataStor.drives.length && !!sysStor?.drives.length,
      systemStorageLabel: sysStor?.label || null,
      dc,
      bestRank: best,
      orderableCount,
      inStockCount,
    });
  }
  return out;
}

// Catalogue invoice names look like "KS-1 | Intel Xeon-D 1520". The half before
// the pipe is the model designation; the half after is the CPU.
export function splitCatalogName(name) {
  const s = String(name || '');
  const i = s.indexOf('|');
  if (i === -1) return { model: s.trim(), cpu: '' };
  return { model: s.slice(0, i).trim(), cpu: s.slice(i + 1).trim() };
}

// Build a planCode -> {name, price, currency} map from an OVH order catalogue.
export function buildCatalogMap(catalog) {
  const map = {};
  const plans = catalog?.plans;
  if (!Array.isArray(plans)) return map;
  const fallbackCur = catalog?.locale?.currencyCode || null;

  // Index every addon's recurring monthly price (these are DELTAS over base).
  const addonDelta = {};
  for (const a of catalog.addons || []) {
    if (!a?.planCode) continue;
    addonDelta[a.planCode] = monthlyPricing(a.pricings)?.value || 0;
  }

  for (const p of plans) {
    if (!p?.planCode) continue;
    const base = monthlyPricing(p.pricings || p.prices);
    let currency = fallbackCur;
    if (base?.formatted) { const cm = /\b([A-Z]{3})\b/.exec(base.formatted); if (cm) currency = cm[1]; }
    const fams = { memory: [], storage: [] };
    for (const af of p.addonFamilies || []) {
      if (af.name !== 'memory' && af.name !== 'storage') continue;
      for (const code of af.addons || []) fams[af.name].push({ code, delta: addonDelta[code] ?? 0 });
    }
    map[p.planCode] = {
      name: p.invoiceName || p.planCode,
      basePrice: base ? base.value : null,
      currency,
      memory: fams.memory,
      storage: fams.storage,
    };
  }
  return map;
}

// Pull the recurring 1-month "renew" price out of a pricings array.
// The raw `price` field is in 1e-8 units, so the value is /1e8.
function monthlyPricing(pricings) {
  const list = pricings || [];
  const m =
    list.find((p) => p.intervalUnit === 'month' && p.interval === 1 && (p.capacities || []).includes('renew')) ||
    list.find((p) => p.intervalUnit === 'month' && p.interval === 1) ||
    list.find((p) => p.intervalUnit === 'month');
  if (!m) return null;
  let value = null;
  if (typeof m.price === 'number') value = m.price / 1e8;
  else if (m.price && typeof m.price === 'object') value = m.price.value ?? null;
  else if (typeof m.priceInUcents === 'number') value = m.priceInUcents / 1e8;
  return { value, formatted: m.formattedPrice || null };
}

function pickDelta(list, code) {
  if (!list || !code) return 0;
  const a = list.find((x) => x.code === code || x.code.startsWith(code + '-'));
  return a ? a.delta : 0;
}

// Real monthly price for ONE exact config = base + memory delta + storage delta.
export function priceForConfig(entry, memoryCode, storageCode) {
  if (!entry || entry.basePrice == null) return null;
  return entry.basePrice + pickDelta(entry.memory, memoryCode) + pickDelta(entry.storage, storageCode);
}

const CURRENCY_SYMBOL = { CAD: '$', USD: '$', AUD: '$', SGD: '$', EUR: '€', GBP: '£' };
export function formatMoney(value, currency) {
  if (value == null) return null;
  const sym = CURRENCY_SYMBOL[currency] || '';
  return `${sym}${value.toFixed(2)}${currency ? ' ' + currency : ''}`;
}
