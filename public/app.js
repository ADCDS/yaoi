// public/app.js — Kimsufi Watch client.
//
// The structural idea: ONE ROW PER CONFIGURATION, datacenters as columns.
//
// The previous build exploded every configuration into one row per datacenter,
// turning 16,689 configurations into tens of thousands of rows — then capped the
// table at 600, so most were unreachable. It also meant the comparison this tool
// exists to make ("in stock in Beauharnois, a day out in Frankfurt") was split
// across rows you could not see at once. As a matrix, the eco set is 4,165 rows,
// no cap is needed, and that comparison is one glance.
//
// Availability logic is imported, never reimplemented. This file used to carry
// its own copies of availMeta() and configMatches(); they drifted silently.

import { availMeta, tierOf, TIERS, isEco, STORAGE_KINDS } from './core/ovh.js';
import { cellMatches, criteriaSummary, CHANNELS } from './core/watches.js';
import { orderLink, apiUrl } from './core/deeplink.js';
import * as T from './transport.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const TIER_META = Object.fromEntries(TIERS.map((t) => [t.key, t]));
const CELL_TEXT = { now: '1h', h24: '24', h72: '72', long: '··', soon: '~', none: '', notSold: '' };
const CHANNEL_LABEL = { browser: 'Browser', telegram: 'Telegram', ntfy: 'ntfy', webhook: 'Discord', email: 'Email' };
const CHANNEL_GLYPH = { browser: 'br', telegram: 'tg', ntfy: 'nt', webhook: 'ds', email: '@' };

const state = {
  meta: {}, dcs: [], ranges: {}, configs: [], byFqn: new Map(),
  watches: [], events: [], channels: [], connected: false,
};

const prefs = T.loadPrefs();
const filters = {
  search: prefs.search || '',
  countries: new Set(prefs.countries || []),
  kinds: new Set(prefs.kinds || []),
  ranges: new Set(prefs.ranges || []),
  tiers: new Set(prefs.tiers || []),
  nonEco: !!prefs.nonEco,
};
let sort = prefs.sort || { key: 'avail', dir: 1 };
let muted = !!prefs.muted;
let theme = prefs.theme || 'auto';
let showHistory = prefs.showHistory !== false;
let showChannels = prefs.showChannels !== false;

function persist() {
  T.savePrefs({
    search: filters.search,
    countries: [...filters.countries], kinds: [...filters.kinds],
    ranges: [...filters.ranges], tiers: [...filters.tiers],
    nonEco: filters.nonEco, sort, muted, theme, showHistory, showChannels,
  });
}

// ===========================================================================
// Rows: one per configuration
// ===========================================================================
function visibleDcs() {
  if (!filters.countries.size) return state.dcs;
  return state.dcs.filter((d) => filters.countries.has(d.country));
}

function buildRows() {
  const cols = visibleDcs();
  const colCodes = cols.map((d) => d.code);
  const q = filters.search.toLowerCase();
  const rows = [];
  let orderable = 0;
  let starred = 0;

  for (const c of state.configs) {
    if (!filters.nonEco && !isEco(c.range)) continue;
    if (filters.ranges.size && !filters.ranges.has(c.range)) continue;
    if (filters.kinds.size && !c.storageKinds.some((k) => filters.kinds.has(k))) continue;
    if (q) {
      const hay = `${c.fqn} ${c.name} ${c.memoryLabel} ${c.storageLabel} ${c.rangeLabel} ${c.planCode}`.toLowerCase();
      if (!hay.includes(q)) continue;
    }

    // One cell per visible datacenter column. A datacenter missing from this
    // configuration's map is "not sold here" — a different fact from
    // out-of-stock, which the old row-per-datacenter table could not express.
    const cells = [];
    let best = Infinity;
    let anyTier = false;
    let rowStarred = false;

    for (const code of colCodes) {
      const has = Object.prototype.hasOwnProperty.call(c.dc, code);
      const avail = has ? c.dc[code] : undefined;
      const tier = has ? tierOf(avail) : 'notSold';
      const am = availMeta(avail);
      if (am.rank < best) best = am.rank;

      let match = false;
      for (const w of state.watches) {
        if (!w.enabled || !w.rule) continue;
        if (cellMatches(c, code, avail, { ...w.rule, ...normRule(w.rule) })) { match = true; break; }
      }
      if (match) { rowStarred = true; starred++; }
      if (filters.tiers.size && filters.tiers.has(tier)) anyTier = true;
      cells.push({ code, tier, avail, label: am.label, match });
    }

    if (filters.tiers.size && !anyTier) continue;
    if (cells.every((x) => x.tier === 'notSold')) continue;

    // By default show only what you could actually buy somewhere. Of the 4,165
    // eco configurations, 2,653 have no stock in any datacenter at all, and
    // listing them by default buries the ones you can have. Click the
    // "out of stock" rung on the ladder to bring them back.
    const buyable = cells.some((x) => x.tier === 'now' || x.tier === 'h24' || x.tier === 'h72' || x.tier === 'long');
    if (!buyable && !filters.tiers.size) continue;

    if (Object.values(c.dc).some((v) => availMeta(v).orderable)) orderable++;
    // How many of the visible datacenters can actually sell this. Used to break
    // ties on the availability sort, so a configuration you can get in six places
    // outranks one locked to a single region — which is the question the matrix
    // exists to answer.
    const reach = cells.filter((x) => x.tier === 'now' || x.tier === 'h24' || x.tier === 'h72' || x.tier === 'long').length;
    rows.push({ c, cells, best, reach, starred: rowStarred });
  }

  sortRows(rows);
  return { rows, cols, orderable, starred };
}

// Watch summaries carry a plain `rule`; cellMatches expects the full watch shape.
function normRule(rule) {
  return {
    countries: rule.countries || [], datacenters: rule.datacenters || [],
    ranges: rule.ranges || [], storageKinds: rule.storageKinds || [],
    storageContains: rule.storageContains || '', planCodes: rule.planCodes || [],
    search: rule.search || '', minRamGB: rule.minRamGB || null,
    inStockOnly: !!rule.inStockOnly, includeComingSoon: !!rule.includeComingSoon,
  };
}

function sortRows(rows) {
  const get = {
    range: (r) => r.c.rangeLabel,
    name: (r) => r.c.model || r.c.name,
    ram: (r) => r.c.ramGB || 0,
    storage: (r) => r.c.storageLabel,
    price: (r) => r.c.price,
    avail: (r) => r.best,
  }[sort.key] || ((r) => r.best);
  rows.sort((a, b) => {
    const va = get(a), vb = get(b);
    const an = va == null || va === Infinity, bn = vb == null || vb === Infinity;
    if (an && bn) return b.reach - a.reach;
    if (an) return 1;          // rows with nothing to offer sink, either direction
    if (bn) return -1;
    let d = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
    if (d === 0) d = a.best - b.best;
    // Widest availability first among equals: a machine you can get in six
    // datacenters is more useful than one locked to a single region.
    if (d === 0) return b.reach - a.reach;
    return d * sort.dir;
  });
}

// ===========================================================================
// Render: the matrix
// ===========================================================================
const COLUMNS = [
  { key: 'range', label: 'Range' },
  { key: 'name', label: 'Server' },
  { key: 'ram', label: 'RAM' },
  { key: 'storage', label: 'Storage' },
  { key: 'price', label: 'Price', cls: 'r' },
];

function renderHead(cols) {
  const arrow = (k) => (sort.key === k ? `<span class="arrow">${sort.dir === 1 ? '▲' : '▼'}</span>` : '');
  const cells = COLUMNS.map((c) =>
    `<th class="sortable ${c.cls || ''}" data-sort="${c.key}">${c.label} ${arrow(c.key)}</th>`);
  const heads = cols.map((d) =>
    `<span title="${esc(d.city)}, ${esc(d.countryName)} — ${esc(d.code)}">${esc(d.short || d.code)}<i>${esc(d.country)}</i></span>`).join('');
  cells.push(`<th class="sortable" data-sort="avail">Availability ${arrow('avail')}<div class="dcgrid dchead">${heads}</div></th>`);
  cells.push('<th></th>');
  $('#head-row').innerHTML = cells.join('');
  $('#head-row').querySelectorAll('th[data-sort]').forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.sort;
      sort = { key: k, dir: sort.key === k ? -sort.dir : 1 };
      persist(); render();
    };
  });
}

function priceCell(c) {
  if (c.priceText) return `<b>${esc(c.priceText)}</b><span class="per">/mo</span>`;
  // Two different reasons for having no price, and the difference matters:
  // non-eco ranges have no public catalogue at all, whereas an eco configuration
  // missing from the catalogue is a gap in OVH's own data.
  if (!isEco(c.range)) {
    return `<span class="none" title="Scale, High Grade, HCI and SDS are not in OVH's public eco catalogue, so there is no price to read.">no public price</span>`;
  }
  return `<span class="none" title="This configuration is not listed in the eco order catalogue, so OVH publishes no price for it.">not priced</span>`;
}

function rowHtml(r) {
  const c = r.c;
  const cells = r.cells.map((x) => {
    const tm = TIER_META[x.tier];
    const title = x.tier === 'notSold'
      ? `${x.code} — not sold here`
      : `${x.code} — ${x.label}`;
    return `<span class="cell t-${x.tier}${x.match ? ' match' : ''}" title="${esc(title)}">${CELL_TEXT[x.tier] || ''}</span>`;
  }).join('');

  const link = orderLink(c, T.subsidiary);
  const actions = [];
  if (link) {
    actions.push(`<a class="linkbtn go" href="${esc(link.url)}" target="_blank" rel="noopener" title="${link.kind === 'model' ? 'OVH order page for this exact model' : 'OVH listing for this range'}">${link.label} ↗</a>`);
  }
  actions.push(`<a class="linkbtn" href="${esc(apiUrl(c))}" target="_blank" rel="noopener" title="Verify against the OVH API">API ↗</a>`);

  return `<tr class="${r.starred ? 'starred' : ''}">
    <td class="rangecell r-${esc(c.range)}">${esc(c.rangeLabel)}</td>
    <td><div class="model">${esc(c.model || c.name)}</div>${c.cpu ? `<div class="cpu">${esc(c.cpu)}</div>` : ''}<div class="pcode">${esc(c.planCode)}</div></td>
    <td class="spec"><b>${c.ramGB || '—'}</b>${c.ramGB ? ' GB' : ''}</td>
    <td class="spec">${esc(c.storageLabel)}</td>
    <td class="price">${priceCell(c)}</td>
    <td><div class="dcgrid">${cells}</div></td>
    <td><div class="rowact">${actions.join('')}</div></td>
  </tr>`;
}

// Every row is reachable — but they are not all in the DOM at once.
//
// The matrix is 4,165 rows by up to 14 datacenter columns. Rendering all of it
// is 58,000 cells and ~129,000 nodes, which cost 635 ms per sort and made the
// column headers feel broken. Rows are appended as you scroll instead, so the
// old 600-row cap stays gone without paying for a DOM nobody is looking at.
const WINDOW = 250;
let lastRows = [];
let shown = 0;

function appendRows(n) {
  const slice = lastRows.slice(shown, shown + n);
  if (!slice.length) return;
  $('#rows').insertAdjacentHTML('beforeend', slice.map(rowHtml).join(''));
  shown += slice.length;
}

function onGridScroll() {
  const el = $('.tscroll');
  if (shown >= lastRows.length) return;
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 600) appendRows(WINDOW);
}

function render() {
  const { rows, cols, orderable, starred } = buildRows();
  renderHead(cols);
  lastRows = rows;
  shown = 0;
  $('#rows').innerHTML = '';
  appendRows(WINDOW);

  if (!rows.length) {
    $('#empty').innerHTML = `<div class="state">
      <h3>Nothing matches</h3>
      <p>No configuration fits these filters right now. Widen the country, allow longer delivery times, or clear the filters.</p>
      <button class="btn small fix" id="e-clear">Clear filters</button>
    </div>`;
    const b = $('#e-clear'); if (b) b.onclick = resetFilters;
  } else {
    $('#empty').innerHTML = '';
  }

  const legend = ['now', 'h24', 'h72', 'long', 'soon', 'none']
    .filter((k) => k !== 'long' || rows.some((r) => r.cells.some((c) => c.tier === 'long')))
    .map((k) => `<span><i style="background:var(--t-${k})"></i>${esc(TIER_META[k].label)}</span>`).join('');
  $('#tfoot').innerHTML =
    `<span><b>${rows.length.toLocaleString()}</b> configurations · <b>${orderable.toLocaleString()}</b> orderable`
    + (starred ? ` · <span style="color:var(--act)">${starred} cell${starred > 1 ? 's' : ''} match a watch</span>` : '')
    + `</span><div class="legend">${legend}`
    + `<span><i style="background:transparent;box-shadow:inset 0 0 0 1px var(--rule-2)"></i>not sold</span></div>`;

  renderLadder();
  renderStatus();
}

// ===========================================================================
// Render: the delivery ladder
// ===========================================================================
function renderLadder() {
  const counts = filters.nonEco ? (state.meta.tiersAll || {}) : (state.meta.tiers || {});
  // Only rungs the data actually has. Nothing sits at 240H+ in the eco set right
  // now, and a fixed ladder would render dead rungs.
  const present = TIERS.filter((t) => t.key !== 'notSold' && (counts[t.key] || 0) > 0);
  if (!present.length) { $('#ladder').hidden = true; return; }
  $('#ladder').hidden = false;

  const total = present.reduce((s, t) => s + counts[t.key], 0);
  $('#ladder-title').textContent = filters.nonEco ? 'Delivery ladder — all ranges' : 'Delivery ladder — eco';
  $('#ladder-hint').textContent =
    `${total.toLocaleString()} configuration × datacenter pairs · click a rung to filter`;

  $('#ladder-bar').innerHTML = present.map((t) =>
    `<button style="flex:${counts[t.key]} 1 0;background:var(--t-${t.key})" data-tier="${t.key}"
      aria-pressed="${filters.tiers.has(t.key)}"
      title="${esc(t.label)} — ${counts[t.key].toLocaleString()}"
      aria-label="${esc(t.label)}, ${counts[t.key]} pairs"></button>`).join('');

  $('#ladder-rungs').innerHTML = present.map((t) =>
    `<button class="rung" data-tier="${t.key}" aria-pressed="${filters.tiers.has(t.key)}">
      <span class="stripe" style="background:var(--t-${t.key})"></span>
      <span><span class="v">${counts[t.key].toLocaleString()}</span><span class="k">${esc(t.label)}</span><span class="s">${esc(t.sub)}</span></span>
    </button>`).join('');

  document.querySelectorAll('[data-tier]').forEach((el) => {
    el.onclick = () => {
      const k = el.dataset.tier;
      filters.tiers.has(k) ? filters.tiers.delete(k) : filters.tiers.add(k);
      persist(); render();
    };
  });
}

// ===========================================================================
// Render: status rail
// ===========================================================================
function fmtAgo(ts) {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function renderStatus() {
  const m = state.meta || {};
  const led = $('#led');
  led.className = `led ${m.error ? 'bad' : state.connected ? 'live' : ''}`;
  led.title = m.error ? 'The last check failed' : state.connected ? 'Connected' : 'Not connected';

  $('#s-checked').innerHTML = m.error
    ? `<span class="bad">check failed</span> · showing data from <b>${fmtAgo(m.lastOk || m.at)}</b>`
    : `checked <b>${fmtAgo(m.lastOk || m.at)}</b>`;

  const cad = m.cadence || {};
  if (cad.kind === 'live' && m.lastPoll) {
    const next = Math.max(0, Math.round((m.lastPoll + cad.everySeconds * 1000 - Date.now()) / 1000));
    $('#s-next').innerHTML = `next in <b>${next}s</b>`;
  } else if (cad.kind === 'scheduled') {
    // Honest about what a scheduled job is. Implying a live feed would be worse
    // than admitting the floor: a monitor that silently isn't monitoring is
    // worse than no monitor.
    $('#s-next').innerHTML = `refreshed every <b>~${cad.everyMinutes}m</b>`;
    $('#s-next').className = 'stat hide-sm warn';
    $('#s-next').title = cad.note || '';
  } else {
    $('#s-next').textContent = '';
  }

  const counts = m.counts || {};
  $('#s-count').innerHTML = `<b>${(filters.nonEco ? counts.all : counts.eco || counts.all || 0).toLocaleString()}</b> configurations`;
  $('#s-cadence').innerHTML = m.catalog?.ok
    ? `names <b>${m.catalog.count}/${esc(m.subsidiary || '')}</b>`
    : `<span title="${esc(m.catalog?.error || 'catalogue not loaded')}">derived names</span>`;

  const on = state.channels.filter((c) => c.configured && c.channel !== 'browser').map((c) => CHANNEL_LABEL[c.channel]);
  $('#s-channels').innerHTML = on.length
    ? `${on.join(' · ')} armed`
    : (T.isStatic ? 'browser alerts only' : '');
}

// ===========================================================================
// Render: watch cards
// ===========================================================================
function renderWatches() {
  const el = $('#watches');
  if (!state.watches.length) {
    el.innerHTML = `<div class="state" style="grid-column:1/-1">
      <h3>No watches yet</h3>
      <p>A watch describes the server you want and tells you the moment it appears. Start with a country and a disk type.</p>
      <button class="btn primary fix" id="w-first">Create your first watch</button>
    </div>`;
    $('#w-first').onclick = () => openModal(null);
    return;
  }

  el.innerHTML = state.watches.map((w) => {
    const hot = w.inStockCount > 0;
    const chans = CHANNELS.map((c) => {
      const on = (w.channels || []).includes(c);
      return `<span class="chip-ch ${on ? 'on' : ''}" title="${esc(CHANNEL_LABEL[c])}${on ? '' : ' — off for this watch'}">${esc(CHANNEL_GLYPH[c])}</span>`;
    }).join('');
    const peek = (w.sample || []).slice(0, 3).map((m) =>
      `<div class="row"><i style="background:var(--t-${m.tier || tierOf(m.availability)})"></i><b>${esc(m.model || m.name)}</b><span>${esc((m.storageLabel || '').split(' + ')[0])}</span><span>${esc(m.dc)}</span></div>`).join('');
    const more = w.matchCount > 3 ? `<span class="more">+ ${(w.matchCount - 3).toLocaleString()} more</span>` : '';
    // A watch can legitimately match rows the table is currently hiding — the
    // count would otherwise look like it disagrees with the grid.
    const hidden = !filters.nonEco && w.ecoMatchCount != null && w.matchCount > w.ecoMatchCount
      ? `<span class="more" title="Turn on “Show non-eco ranges” to see these in the table">${(w.matchCount - w.ecoMatchCount).toLocaleString()} of these are non-eco and hidden below</span>`
      : '';
    return `<div class="watch ${hot ? 'hit' : ''} ${w.enabled ? '' : 'off'}">
      <div class="watch-head">
        <h3>${esc(w.name)}</h3>
        <button class="iconbtn" data-act="toggle" data-id="${esc(w.id)}" title="${w.enabled ? 'Pause this watch' : 'Resume this watch'}">${w.enabled ? '⏸' : '▶'}</button>
        <button class="iconbtn" data-act="edit" data-id="${esc(w.id)}" title="Edit this watch">✎</button>
        <button class="iconbtn" data-act="delete" data-id="${esc(w.id)}" title="Delete this watch">🗑</button>
      </div>
      <div class="crit">${esc(w.criteria)}</div>
      <div class="counts">
        <div class="fig"><span class="v ${w.matchCount ? '' : 'zero'}">${w.matchCount.toLocaleString()}</span><span class="k lab">matches</span></div>
        <div class="fig"><span class="v ${hot ? 'hot' : 'zero'}">${w.inStockCount.toLocaleString()}</span><span class="k lab">in stock</span></div>
        <div class="chans">${chans}</div>
      </div>
      <div class="peek">${w.enabled ? (peek || '<span class="more">nothing matches right now</span>') : '<span class="more">paused — not being checked</span>'} ${more} ${hidden}</div>
    </div>`;
  }).join('');

  el.querySelectorAll('[data-act]').forEach((b) => {
    const w = state.watches.find((x) => x.id === b.dataset.id);
    if (!w) return;
    if (b.dataset.act === 'toggle') b.onclick = () => mutate(() => T.store.update(w.id, { enabled: !w.enabled }));
    if (b.dataset.act === 'edit') b.onclick = () => openModal(w);
    if (b.dataset.act === 'delete') b.onclick = () => {
      if (confirm(`Delete the watch “${w.name}”?`)) mutate(() => T.store.remove(w.id));
    };
  });
}

async function mutate(fn) {
  try {
    await fn();
    await syncWatches();
  } catch (err) {
    toast('That did not save', esc(err.message || err), 'bad');
  }
}

async function syncWatches() {
  if (T.isStatic) {
    const res = T.store.evaluate(state.configs);
    state.watches = res.summaries;
  } else {
    state.watches = await T.store.list();
  }
  renderWatches();
  render();
}

// ===========================================================================
// Render: history
// ===========================================================================
function fmtDur(ms) {
  if (ms == null) return '';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  return `${Math.floor(h / 24)}d ${h % 24}h`;
}

function renderHistory() {
  const panel = $('#history-panel');
  if (!state.events.length) { panel.hidden = true; return; }
  panel.hidden = false;
  $('#hist-body').hidden = !showHistory;
  $('#b-hist-toggle').textContent = showHistory ? 'Hide' : 'Show';

  const ups = state.events.filter((e) => e.dir === 'up').length;
  $('#hist-summary').innerHTML = `<b>${state.events.length.toLocaleString()}</b> events · ${ups.toLocaleString()} came into stock`;

  const rows = state.events.slice(0, 60).map((e) => {
    const when = new Date(e.t);
    const time = when.toTimeString().slice(0, 8);
    const dcName = (state.dcs.find((d) => d.code === e.dc) || {}).city || e.dc;
    let verb, dur = '';
    if (e.dir === 'alert') {
      verb = `alerted <b>${esc(e.watchName || 'a watch')}</b> about <b>${esc(e.model)}</b> in ${esc(dcName)}`;
      dur = (e.channels || []).join(', ');
    } else if (e.dir === 'up') {
      verb = `<b>${esc(e.model)}</b> became available in ${esc(dcName)}`;
      dur = e.to === 'now' ? 'in stock' : TIER_META[e.to]?.label || e.to;
    } else {
      verb = `<b>${esc(e.model)}</b> ${e.to === 'none' ? 'sold out' : `slipped to ${esc(TIER_META[e.to]?.label || e.to)}`} in ${esc(dcName)}`;
      dur = e.heldMs != null ? `held ${fmtDur(e.heldMs)}` : '';
    }
    return `<div class="tl-row">
      <span class="tl-t">${time}</span>
      <span class="tl-m ${esc(e.dir)}"></span>
      <span class="tl-b">${verb} <span class="pc">${esc(e.planCode)}${e.storage ? ` · ${esc(e.storage)}` : ''}</span></span>
      <span class="tl-d ${e.heldMs != null ? 'held' : ''}">${esc(dur)}</span>
    </div>`;
  }).join('');
  $('#hist-body').innerHTML = rows;
}

// ===========================================================================
// Render: notification channels
// ===========================================================================
function renderChannels() {
  $('#chan-body').hidden = !showChannels;
  $('#chan-note').hidden = !showChannels;
  $('#b-chan-toggle').textContent = showChannels ? 'Hide' : 'Show';

  const on = state.channels.filter((c) => c.configured).length;
  $('#chan-summary').innerHTML = `<b>${on}</b> of ${state.channels.length} on`;

  $('#chan-body').innerHTML = state.channels.map((c) => `
    <div class="chan ${c.configured ? 'ok' : ''}">
      <span class="glyph">${esc(CHANNEL_GLYPH[c.channel] || '?')}</span>
      <span>
        <span class="nm">${esc(CHANNEL_LABEL[c.channel] || c.channel)}</span>
        <span class="st ${c.configured ? 'good' : ''}" data-st="${esc(c.channel)}">${esc(c.detail || 'Not set up — add its settings to turn this on')}</span>
      </span>
      <span>${c.configured ? `<button class="btn quiet small" data-test="${esc(c.channel)}">Send test</button>` : ''}</span>
    </div>`).join('');

  $('#chan-body').querySelectorAll('[data-test]').forEach((b) => {
    b.onclick = async () => {
      const name = b.dataset.test;
      b.disabled = true; b.textContent = 'Sending…';
      if (name === 'browser') {
        notifyBrowser({
          model: 'SYS-2', city: 'Beauharnois', flag: '🇨🇦', memoryLabel: '128 GB ECC 2666',
          storageLabel: '2×1.92 TB NVMe', availLabel: 'In stock (high)', planCode: '24sys022',
          priceText: '$159.87 CAD', watchName: 'Test', range: 'soyoustart', name: 'SYS-2 | Intel Xeon-D 2141I',
        });
        beep();
      }
      const r = await T.testChannel(name);
      const st = $(`[data-st="${name}"]`);
      if (st) {
        st.textContent = r.ok ? 'Test delivered just now' : `Test failed — ${r.error || 'no reason given'}`;
        st.className = `st ${r.ok ? 'good' : 'bad'}`;
      }
      b.disabled = false; b.textContent = 'Send test';
    };
  });

  $('#chan-note').innerHTML = T.isStatic
    ? `<b>This page alerts you only while a tab is open.</b> It is a published snapshot on static
       hosting, so there is no server here to push to your phone — and no account, which is also why
       your watches stay in this browser and are visible to nobody else.
       For alerts that reach you with the tab closed, run your own copy: fork the repository, add
       your Telegram, ntfy, Discord or email settings as repository secrets, and enable the scheduled
       job. See <code>docs/deploy-your-own.md</code>.`
    : `<b>Channels are configured by environment variables, never in this page</b>, so no token is
       ever stored in the repository. Set them and restart to turn a channel on. Each watch chooses
       which of them it uses.`;
}

// ===========================================================================
// Alerts: toast, browser notification, sound
// ===========================================================================
const recentlyNotified = new Map();

function handleAlerts(alerts) {
  let played = false;
  for (const a of alerts) {
    const key = `${a.fqn}|${a.dc}`;
    if (Date.now() - (recentlyNotified.get(key) || 0) < 60_000) continue;
    recentlyNotified.set(key, Date.now());

    const link = orderLink(a, T.subsidiary);
    toast(
      `${a.flag || ''} ${a.model || a.name} available`,
      `${esc(a.memoryLabel)} · ${esc(a.storageLabel)}<br>${esc(a.city || a.dcLabel)} — <b>${esc(a.availLabel)}</b>`
      + (a.priceText ? ` · <b>${esc(a.priceText)}</b>` : '')
      + (link ? `<br><a href="${esc(link.url)}" target="_blank" rel="noopener">${link.kind === 'model' ? 'Order this now ↗' : 'Browse this range ↗'}</a>` : ''),
      a.watchId === 'test' ? 'info' : 'alert',
    );
    notifyBrowser(a);
    if (!played) { beep(); played = true; }
  }
}

function notifyBrowser(a) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const link = orderLink(a, T.subsidiary);
  const n = new Notification(`${a.model || a.name} — ${a.city || a.dcLabel}`, {
    body: `${a.memoryLabel} · ${a.storageLabel}\n${a.availLabel}${a.priceText ? ` · ${a.priceText}` : ''}`,
    tag: `${a.fqn}|${a.dc}`,
  });
  n.onclick = () => { window.focus(); if (link) window.open(link.url, '_blank', 'noopener'); n.close(); };
}

let audioCtx = null;
function beep() {
  if (muted) return;
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = audioCtx.currentTime;
    [880, 1175].forEach((freq, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + i * 0.16);
      g.gain.exponentialRampToValueAtTime(0.2, t0 + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.16 + 0.15);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + i * 0.16); o.stop(t0 + i * 0.16 + 0.16);
    });
  } catch { /* autoplay policy — the toast still shows */ }
}

function toast(title, bodyHtml, kind = 'alert') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'info' ? 'info' : kind === 'bad' ? 'bad' : ''}`;
  el.innerHTML = `<div class="tt">${esc(title)}</div><div class="tb">${bodyHtml}</div>`;
  $('#toasts').appendChild(el);
  const life = setTimeout(() => {
    el.style.transition = 'opacity .4s'; el.style.opacity = '0';
    setTimeout(() => el.remove(), 420);
  }, kind === 'alert' ? 12000 : 8000);
  el.onclick = (e) => { if (e.target.tagName !== 'A') { clearTimeout(life); el.remove(); } };
}

// ===========================================================================
// Filters + controls
// ===========================================================================
function chip(label, on, title) {
  return `<button class="chip" aria-pressed="${on}" ${title ? `title="${esc(title)}"` : ''}>${esc(label)}</button>`;
}

function buildFilterChips() {
  // Built from live data only. The static datacenter map lists locations (vin,
  // hil, eri) that currently have no rows at all, and offering them as filters
  // produced controls that could only ever return nothing.
  const countries = [];
  const seen = new Set();
  for (const d of state.dcs) {
    if (seen.has(d.country)) continue;
    seen.add(d.country);
    countries.push(d);
  }
  $('#f-countries').innerHTML = countries.map((d) =>
    chip(`${d.flag} ${d.country}`, filters.countries.has(d.country), `${d.countryName} — also narrows the datacenter columns`)).join('');
  bind('#f-countries', countries.map((d) => d.country), filters.countries);

  const kinds = STORAGE_KINDS.filter((k) => state.configs.some((c) => c.storageKinds.includes(k)));
  $('#f-kinds').innerHTML = kinds.map((k) => chip(k, filters.kinds.has(k))).join('');
  bind('#f-kinds', kinds, filters.kinds);

  const ranges = Object.entries(state.ranges)
    .filter(([r, info]) => filters.nonEco || info.eco)
    .sort((a, b) => a[1].label.localeCompare(b[1].label));
  $('#f-ranges').innerHTML = ranges.map(([r, info]) =>
    chip(info.label, filters.ranges.has(r), `${info.count.toLocaleString()} configurations`)).join('');
  bind('#f-ranges', ranges.map(([r]) => r), filters.ranges);
}

/** Chip state is driven by the VALUE, not by matching against the label.
 *  The previous build compared a chip's label to the filter's code — so
 *  "So you Start".endsWith("soyoustart") was false and every range chip looked
 *  unselected even while it was filtering. */
function bind(sel, values, set) {
  const chips = $(sel).querySelectorAll('.chip');
  chips.forEach((el, i) => {
    const v = values[i];
    el.onclick = () => {
      set.has(v) ? set.delete(v) : set.add(v);
      el.setAttribute('aria-pressed', String(set.has(v)));
      persist();
      render();
    };
  });
}

function resetFilters() {
  filters.search = ''; filters.countries.clear(); filters.kinds.clear();
  filters.ranges.clear(); filters.tiers.clear();
  $('#f-search').value = '';
  persist(); buildFilterChips(); render();
}

function applyTheme() {
  const root = document.documentElement;
  if (theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  $('#b-theme').title = `Theme: ${theme}. Click to change.`;
}

function measureChrome() {
  const root = document.documentElement;
  const rail = $('#rail'), f = $('#filters');
  if (rail) root.style.setProperty('--topbar-h', `${rail.offsetHeight}px`);
  if (f) root.style.setProperty('--filters-h', `${f.offsetHeight}px`);
}

function wire() {
  $('#b-refresh').onclick = async () => {
    const r = await T.refresh();
    if (!r.ok) toast('Cannot check now', esc(r.error || 'try again in a moment'), 'info');
  };
  if (T.isStatic) {
    $('#b-refresh').title = 'This is a published snapshot — it refreshes on its own schedule';
  }

  $('#b-sound').onclick = () => {
    muted = !muted;
    $('#b-sound').textContent = muted ? '🔇' : '🔊';
    $('#b-sound').title = muted ? 'Unmute the alert sound' : 'Mute the alert sound';
    persist();
  };

  $('#b-theme').onclick = () => {
    theme = theme === 'auto' ? 'dark' : theme === 'dark' ? 'light' : 'auto';
    applyTheme(); persist();
  };

  $('#b-alerts').onclick = async () => {
    if (!('Notification' in window)) {
      toast('Not available here', 'This browser has no notification support.', 'info');
      return;
    }
    const p = await Notification.requestPermission();
    updateAlertButton();
    if (p === 'granted') toast('Browser alerts on', 'You will be told when a watch matches, while this tab is open.', 'info');
    else toast('Browser alerts blocked', 'Your browser refused. Toasts and the sound still work.', 'info');
  };

  let dt;
  $('#f-search').value = filters.search;
  $('#f-search').oninput = (e) => {
    clearTimeout(dt);
    dt = setTimeout(() => { filters.search = e.target.value.trim(); persist(); render(); }, 150);
  };

  $('#f-noneco').checked = filters.nonEco;
  $('#f-noneco').onchange = async (e) => {
    filters.nonEco = e.target.checked;
    persist();
    if (filters.nonEco && !T.hasFull()) {
      // Non-eco rows live in the larger snapshot, fetched only when asked for.
      toast('Loading every range', 'Fetching the full set, including servers with no public price.', 'info');
      try {
        const data = await T.loadState({ full: true });
        absorb(data);
      } catch (err) {
        toast('Could not load them', esc(err.message || err), 'bad');
        filters.nonEco = false; $('#f-noneco').checked = false;
      }
    }
    buildFilterChips(); render();
  };

  $('#f-reset').onclick = resetFilters;
  $('#b-hist-toggle').onclick = () => { showHistory = !showHistory; persist(); renderHistory(); };
  $('#b-chan-toggle').onclick = () => { showChannels = !showChannels; persist(); renderChannels(); };

  $('#b-close').onclick = closeModal;
  $('#b-cancel').onclick = closeModal;
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };
  $('#watch-form').onsubmit = submitWatch;
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  $('.tscroll').addEventListener('scroll', onGridScroll, { passive: true });

  setInterval(renderStatus, 1000);
  window.addEventListener('resize', measureChrome);
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(measureChrome);
    ro.observe($('#rail')); ro.observe($('#filters'));
  }
}

function updateAlertButton() {
  const b = $('#b-alerts');
  if (!('Notification' in window)) { b.hidden = true; return; }
  const p = Notification.permission;
  b.classList.toggle('on', p === 'granted');
  b.textContent = p === 'granted' ? '🔔' : '🔕';
  b.title = p === 'granted' ? 'Browser alerts are on' : 'Turn on browser alerts';
}

// ===========================================================================
// Watch editor
// ===========================================================================
const editor = { id: null, sel: null };

function editorChips(container, values, labels, set) {
  $(container).innerHTML = values.map((v, i) => chip(labels[i], set.has(v))).join('');
  $(container).querySelectorAll('.chip').forEach((el, i) => {
    el.onclick = () => {
      const v = values[i];
      set.has(v) ? set.delete(v) : set.add(v);
      el.setAttribute('aria-pressed', String(set.has(v)));
    };
  });
}

function hhmm(mins) {
  if (mins == null) return '';
  return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
}

function openModal(w) {
  const rule = w?.rule || {};
  editor.id = w?.id || null;
  editor.sel = {
    countries: new Set(rule.countries || []),
    kinds: new Set(rule.storageKinds || []),
    ranges: new Set(rule.ranges || []),
    channels: new Set(w?.channels || ['browser']),
  };
  $('#modal-title').textContent = w ? 'Edit watch' : 'New watch';
  $('#w-name').value = w?.name || '';
  $('#w-ram').value = rule.minRamGB || '';
  $('#w-cool').value = w?.cooldownMinutes || '';
  $('#w-q1').value = hhmm(w?.quietFrom ?? null);
  $('#w-q2').value = hhmm(w?.quietTo ?? null);
  $('#w-storage').value = rule.storageContains || '';
  $('#w-plans').value = (rule.planCodes || []).join(', ');
  $('#w-instock').checked = !!rule.inStockOnly;
  $('#w-soon').checked = !!rule.includeComingSoon;
  $('#w-enabled').checked = w ? w.enabled !== false : true;
  $('#b-delete').hidden = !w;
  $('#b-delete').onclick = () => {
    if (w && confirm(`Delete the watch “${w.name}”?`)) { mutate(() => T.store.remove(w.id)); closeModal(); }
  };

  const countries = [...new Set(state.dcs.map((d) => d.country))];
  editorChips('#w-countries', countries, countries.map((c) => {
    const d = state.dcs.find((x) => x.country === c);
    return `${d.flag} ${c}`;
  }), editor.sel.countries);
  editorChips('#w-kinds', STORAGE_KINDS, STORAGE_KINDS, editor.sel.kinds);
  const ranges = Object.keys(state.ranges).sort();
  editorChips('#w-ranges', ranges, ranges.map((r) => state.ranges[r].label), editor.sel.ranges);

  const avail = T.isStatic ? ['browser'] : state.channels.filter((c) => c.configured).map((c) => c.channel);
  editorChips('#w-channels', avail, avail.map((c) => CHANNEL_LABEL[c]), editor.sel.channels);
  $('#w-channels-help').textContent = T.isStatic
    ? 'This page can only alert this browser, while a tab is open.'
    : 'Only channels that are set up appear here.';

  $('#modal').hidden = false;
  $('#w-name').focus();
}

function closeModal() { $('#modal').hidden = true; editor.id = null; }

function clockToMinutes(v) {
  if (!v) return null;
  const [h, m] = v.split(':').map(Number);
  return Number.isFinite(h) ? h * 60 + (m || 0) : null;
}

async function submitWatch(e) {
  e.preventDefault();
  const body = {
    name: $('#w-name').value.trim() || 'Untitled watch',
    countries: [...editor.sel.countries],
    storageKinds: [...editor.sel.kinds],
    ranges: [...editor.sel.ranges],
    channels: [...editor.sel.channels],
    storageContains: $('#w-storage').value.trim(),
    planCodes: $('#w-plans').value.split(',').map((s) => s.trim()).filter(Boolean),
    minRamGB: $('#w-ram').value ? Number($('#w-ram').value) : null,
    cooldownMinutes: $('#w-cool').value ? Number($('#w-cool').value) : 0,
    quietFrom: clockToMinutes($('#w-q1').value),
    quietTo: clockToMinutes($('#w-q2').value),
    inStockOnly: $('#w-instock').checked,
    includeComingSoon: $('#w-soon').checked,
    enabled: $('#w-enabled').checked,
    notify: true,
  };
  try {
    if (editor.id) await T.store.update(editor.id, body);
    else await T.store.create(body);
    await syncWatches();
    closeModal();
    toast('Watch saved', esc(body.name), 'info');
  } catch (err) {
    toast('That did not save', esc(err.message || err), 'bad');
  }
}

// ===========================================================================
// Boot
// ===========================================================================
function absorb(data) {
  state.meta = data.meta || state.meta;
  if (data.dcs) state.dcs = data.dcs;
  if (data.ranges) state.ranges = data.ranges;
  if (data.configs) {
    state.configs = data.configs;
    state.byFqn = new Map(data.configs.map((c) => [c.fqn, c]));
  }
  if (data.events) state.events = [...data.events].reverse();
  if (data.watches) { T.store.absorb(data.watches); state.watches = data.watches; }
}

function applyUpdate(msg) {
  // Server mode sends deltas; static mode hands over a whole fresh snapshot.
  if (msg.configs) {
    absorb(msg);
  } else {
    state.meta = msg.meta || state.meta;
    if (Array.isArray(msg.changes) && msg.changes.length) {
      for (const c of msg.changes) state.byFqn.set(c.fqn, c);
      state.configs = [...state.byFqn.values()];
    }
    if (msg.watches) { T.store.absorb(msg.watches); state.watches = msg.watches; }
    if (Array.isArray(msg.events) && msg.events.length) {
      state.events = [...msg.events.reverse(), ...state.events].slice(0, 400);
    }
  }

  if (T.isStatic) {
    const res = T.store.evaluate(state.configs);
    state.watches = res.summaries;
    if (res.alerts.length) handleAlerts(res.alerts);
    reportMissed();
  } else if (Array.isArray(msg.alerts) && msg.alerts.length) {
    handleAlerts(msg.alerts);
  }

  renderWatches();
  renderHistory();
  render();
}

function reportMissed() {
  const m = T.store.missed;
  if (!m) return;
  T.store.missed = null;
  if (!m.count) return;
  toast(
    'While you were away',
    `<b>${m.count}</b> matching server${m.count > 1 ? 's' : ''} appeared in the last ${fmtDur(m.sinceMs)}.`
    + ' They are in the table now — you were not notified one by one.',
    'info',
  );
}

(async function init() {
  applyTheme();
  wire();
  updateAlertButton();
  $('#b-sound').textContent = muted ? '🔇' : '🔊';

  try {
    const data = await T.loadState({ full: filters.nonEco });
    absorb(data);

    if (T.isStatic) {
      // A first-time visitor gets one worked example rather than an empty page.
      // It is a generic starting point, not anyone's real watch.
      if (T.store.seedDefaults()) T.store.evaluate(state.configs);
      const res = T.store.evaluate(state.configs);
      state.watches = res.summaries;
      reportMissed();
    }

    state.channels = (await T.loadChannels()).channels || [];
    if (!T.isStatic) {
      const h = await T.loadHistory();
      if (h) state.events = h.events;
    }

    buildFilterChips();
    renderWatches();
    renderHistory();
    renderChannels();
    render();
    measureChrome();
  } catch (err) {
    $('#empty').innerHTML = `<div class="state">
      <h3>Could not load the data</h3>
      <p>${esc(err.message || err)}</p>
      <button class="btn small fix" onclick="location.reload()">Try again</button>
    </div>`;
  }

  T.subscribe({
    onUpdate: applyUpdate,
    onStatus: (s) => { state.connected = !!s.connected; if (s.meta) state.meta = s.meta; renderStatus(); },
  });
})();
