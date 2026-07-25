// lib/ovh.js
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
  kimsufi:    { label: 'Kimsufi',      color: '#2dd4bf' },
  soyoustart: { label: 'So you Start', color: '#c084fc' },
  rise:       { label: 'Rise',         color: '#60a5fa' },
  advance:    { label: 'Advance',      color: '#818cf8' },
  scale:      { label: 'Scale',        color: '#94a3b8' },
  hgr:        { label: 'High Grade',   color: '#f472b6' },
  hci:        { label: 'HCI',          color: '#fb923c' },
  sds:        { label: 'SDS',          color: '#fbbf24' },
  game:       { label: 'Game',         color: '#34d399' },
  other:      { label: 'Other',        color: '#64748b' },
};

export function rangeMeta(range) {
  return RANGE_META[range] || RANGE_META.other;
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
export function parseMemory(code) {
  const m = /ram-(\d+)g(?:-(ecc|noecc))?(?:-(\d+))?/.exec(String(code || ''));
  if (!m) return { ramGB: 0, label: code || '—', ecc: false };
  const ramGB = Number(m[1]);
  const ecc = m[2] === 'ecc';
  const speed = m[3] ? Number(m[3]) : null;
  const label = `${ramGB} GB${ecc ? ' ECC' : ''}${speed ? ` ${speed}` : ''}`;
  return { ramGB, label, ecc, speed };
}

const MEDIA = {
  nvme: 'NVMe',
  ssd: 'SSD',
  sas: 'SAS',
  sa: 'SATA',
};
// best (most desirable) media wins for the primary "kind"
const MEDIA_RANK = { NVMe: 0, SSD: 1, SAS: 2, SATA: 3 };

function fmtSize(gb) {
  if (gb >= 1000) {
    const tb = gb / 1000;
    return `${Number(tb.toFixed(2))} TB`;
  }
  return `${gb} GB`;
}

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
  const re = /(\d+)x(\d+)(nvme|ssd|sas|sa)\b/g;
  let mm;
  while ((mm = re.exec(lc)) !== null) {
    const count = Number(mm[1]);
    const size = Number(mm[2]);
    const media = MEDIA[mm[3]] || mm[3].toUpperCase();
    drives.push({ count, size, media });
    kinds.add(media);
  }
  if (drives.length === 0) {
    // e.g. "noraid-0" (diskless) or unknown layout
    return {
      label: raw || '—',
      kind: '—',
      kinds: [],
      raid,
      drives: [],
      totalGB: 0,
    };
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
// Top-level: raw feed -> array of normalised config records
// ---------------------------------------------------------------------------
export function normalizeAvailabilities(rows, catalogMap = {}) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const r of rows) {
    if (!r || !r.fqn) continue;
    const { range, game, storage } = classifyRange(r.planCode);
    const mem = parseMemory(r.memory);
    const stor = parseStorage(r.storage);
    const sysStor = r.systemStorage ? parseStorage(r.systemStorage) : null;

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
      rangeColor: rm.color,
      game,
      storageServer: storage,
      name,
      price,
      priceText: price != null ? formatMoney(price, currency) : null,
      currency,
      ramGB: mem.ramGB,
      memoryRaw: r.memory || '',
      memoryLabel: mem.label,
      storageKind: stor.kind,
      storageKinds: stor.kinds,
      storageLabel: stor.label,
      storageRaw: r.storage || '',
      systemStorageLabel: sysStor?.label || null,
      dc,
      bestRank: best,
      orderableCount,
      inStockCount,
    });
  }
  return out;
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
