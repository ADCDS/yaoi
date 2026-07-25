/* Kimsufi Watch — client */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];

const state = {
  configs: [],
  byFqn: new Map(),
  meta: {},
  static: { datacenters: {}, countries: {}, ranges: {} },
  targets: [],
};

const filters = {
  search: '',
  countries: new Set(['CA']),
  dcs: new Set(),
  ranges: new Set(),
  kinds: new Set(),
  ram: 0,
  avail: 'orderable',
};

const KINDS = ['NVMe', 'SSD', 'SAS', 'SATA'];
const CAP = 600;
let sort = { key: 'avail', dir: 1 };
let muted = false;
const flashing = new Set(); // fqn recently changed
const notifiedRecently = new Map(); // `${fqn}|${dc}` -> ts
let es = null;

// --------------------------------------------------------------------------
// availability interpretation (mirrors server lib/ovh.js)
// --------------------------------------------------------------------------
function AV(value) {
  const v = String(value || '').trim();
  if (!v || v === 'unavailable') return { state: 'unavailable', orderable: false, inStock: false, rank: Infinity, label: 'Unavailable' };
  if (v === 'unknown') return { state: 'unknown', orderable: false, inStock: false, rank: 90000, label: 'Unknown' };
  if (v === 'comingSoon') return { state: 'comingSoon', orderable: false, inStock: false, rank: 80000, label: 'Coming soon' };
  const m = /^(\d+)H(?:-(low|high))?$/.exec(v);
  if (m) {
    const hours = Number(m[1]);
    const level = m[2];
    const inStock = hours <= 1;
    const rank = hours - (level === 'high' ? 0.5 : level === 'low' ? 0 : 0.25);
    let label;
    if (inStock) label = level ? `In stock (${level})` : 'In stock';
    else if (hours < 48) label = `~${hours}h`;
    else label = `~${Math.round(hours / 24)}d`;
    return { state: inStock ? 'inStock' : 'delayed', orderable: true, inStock, rank, label };
  }
  return { state: 'other', orderable: true, inStock: false, rank: 70000, label: v };
}

const fmtAgo = (ts) => {
  if (!ts) return '—';
  const s = Math.round((Date.now() - ts) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  return `${Math.floor(s / 3600)}h ago`;
};

// --------------------------------------------------------------------------
// data load + live stream
// --------------------------------------------------------------------------
async function loadState() {
  const r = await fetch('/api/state');
  const data = await r.json();
  state.meta = data.meta;
  state.static = data.static;
  state.configs = data.configs;
  state.byFqn = new Map(data.configs.map((c) => [c.fqn, c]));
  state.targets = data.targets;
  buildFilterChips();
  renderTargets();
  render();
  renderStatus();
}

function connectStream() {
  if (es) es.close();
  es = new EventSource('/api/stream');
  es.addEventListener('hello', (e) => {
    state.meta = JSON.parse(e.data).meta;
    renderStatus();
  });
  es.addEventListener('update', (e) => onUpdate(JSON.parse(e.data)));
  es.onopen = () => { state._sse = true; renderStatus(); };
  es.onerror = () => { state._sse = false; renderStatus(); };
}

function onUpdate(msg) {
  state.meta = msg.meta || state.meta;
  if (msg.targets) state.targets = msg.targets;

  if (msg.refetch) { loadState(); return; }

  if (Array.isArray(msg.changes) && msg.changes.length) {
    for (const c of msg.changes) {
      state.byFqn.set(c.fqn, c);
      flashing.add(c.fqn);
    }
    state.configs = [...state.byFqn.values()];
    setTimeout(() => { msg.changes.forEach((c) => flashing.delete(c.fqn)); render(); }, 2600);
  }

  if (Array.isArray(msg.alerts) && msg.alerts.length) handleAlerts(msg.alerts);

  renderTargets();
  render();
  renderStatus();
}

// --------------------------------------------------------------------------
// alerts: toast + OS notification + sound
// --------------------------------------------------------------------------
function handleAlerts(alerts) {
  let played = false;
  for (const a of alerts) {
    const key = `${a.fqn}|${a.dc}`;
    const last = notifiedRecently.get(key) || 0;
    if (Date.now() - last < 60000) continue;
    notifiedRecently.set(key, Date.now());

    toast(
      `${a.flag} ${a.name} available`,
      `${a.memoryLabel} · ${a.storageLabel}<br>${a.dcLabel} — <b>${a.availLabel}</b> · <span class="srv-code">${a.planCode}</span>`,
      a.targetId === 'test' ? 'info' : 'alert',
    );
    osNotify(a);
    if (!played) { beep(); played = true; }
  }
}

function osNotify(a) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(`🟢 ${a.name} — ${a.dcLabel}`, {
    body: `${a.memoryLabel} · ${a.storageLabel}\n${a.availLabel}  ·  ${a.planCode}`,
    tag: `${a.fqn}|${a.dc}`,
    renotify: false,
  });
  n.onclick = () => { window.focus(); n.close(); };
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
      g.gain.exponentialRampToValueAtTime(0.22, t0 + i * 0.16 + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + i * 0.16 + 0.15);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + i * 0.16); o.stop(t0 + i * 0.16 + 0.16);
    });
  } catch { /* ignore */ }
}

function toast(title, bodyHtml, kind = 'alert') {
  const el = document.createElement('div');
  el.className = `toast ${kind === 'info' ? 'info' : ''}`;
  el.innerHTML = `<div class="tt">${kind === 'info' ? 'ℹ️' : '🔔'} ${esc(title)}</div><div class="tb">${bodyHtml}</div>`;
  $('#toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .4s'; setTimeout(() => el.remove(), 400); }, 9000);
  el.onclick = () => el.remove();
}

// --------------------------------------------------------------------------
// rendering: status
// --------------------------------------------------------------------------
function renderStatus() {
  const m = state.meta || {};
  const pills = [];
  pills.push(state._sse
    ? `<span class="pill ok live"><span class="dot"></span>live</span>`
    : `<span class="pill bad"><span class="dot"></span>offline</span>`);

  if (m.error) pills.push(`<span class="pill bad" title="${esc(m.error)}">poll error</span>`);
  pills.push(`<span class="pill">updated ${fmtAgo(m.lastOk)}</span>`);

  if (m.lastPoll && m.pollMs) {
    const next = Math.max(0, Math.round((m.lastPoll + m.pollMs - Date.now()) / 1000));
    pills.push(`<span class="pill muted">next ${next}s</span>`);
  }
  pills.push(`<span class="pill">${(m.configCount || 0).toLocaleString()} configs</span>`);

  const cat = m.catalog || {};
  pills.push(cat.ok
    ? `<span class="pill" title="${esc(cat.url || '')}">${cat.count} names · ${esc(m.subsidiary || '')}</span>`
    : `<span class="pill muted" title="${esc(cat.error || 'catalogue not loaded')}">derived names</span>`);

  if (m.secured) pills.push('<span class="pill ok" title="Shared-secret token required">🔒 secured</span>');

  $('#status').innerHTML = pills.join('');
}

// --------------------------------------------------------------------------
// rendering: filter chips
// --------------------------------------------------------------------------
function buildFilterChips() {
  // countries (Canada first, then alpha)
  const cs = Object.entries(state.static.countries)
    .filter(([k]) => k && k !== '??')
    .sort((a, b) => (a[0] === 'CA' ? -1 : b[0] === 'CA' ? 1 : a[0].localeCompare(b[0])));
  const cc = $('#f-countries');
  cc.querySelectorAll('.chip').forEach((n) => n.remove());
  for (const [code, info] of cs) {
    cc.appendChild(chip(`${info.flag} ${code}`, filters.countries.has(code), code === 'CA' ? 'ca' : '', () => {
      toggle(filters.countries, code); refreshChips(cc, filters.countries); render();
    }));
  }

  const kc = $('#f-kinds');
  kc.querySelectorAll('.chip').forEach((n) => n.remove());
  for (const k of KINDS) {
    kc.appendChild(chip(k, filters.kinds.has(k), '', () => { toggle(filters.kinds, k); refreshChips(kc, filters.kinds); render(); }));
  }

  const rc = $('#f-ranges');
  rc.querySelectorAll('.chip').forEach((n) => n.remove());
  const ranges = Object.entries(state.static.ranges).sort((a, b) => a[1].label.localeCompare(b[1].label));
  for (const [code, info] of ranges) {
    rc.appendChild(chip(info.label, filters.ranges.has(code), '', () => { toggle(filters.ranges, code); refreshChips(rc, filters.ranges); render(); }));
  }
}

function chip(label, on, extra, onClick) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `chip ${extra} ${on ? 'on' : ''}`;
  b.textContent = label;
  b.dataset.val = label;
  b.onclick = onClick;
  return b;
}
function toggle(set, v) { set.has(v) ? set.delete(v) : set.add(v); }
function refreshChips(container, set) {
  container.querySelectorAll('.chip').forEach((c) => {
    // match by the trailing token (country code / kind / label)
    c.classList.toggle('on', [...set].some((v) => c.dataset.val.endsWith(v) || c.dataset.val === v));
  });
}

// --------------------------------------------------------------------------
// rendering: results table
// --------------------------------------------------------------------------
function clientMatch(c, dc, avail, rule) {
  if (!rule) return false;
  if (rule.ranges?.length && !rule.ranges.includes(c.range)) return false;
  if (rule.storageKinds?.length && !rule.storageKinds.some((k) => c.storageKinds.includes(k))) return false;
  if (rule.storageContains && !(c.storageRaw || '').toLowerCase().includes(rule.storageContains.toLowerCase())) return false;
  if (rule.planCodes?.length && !rule.planCodes.includes(c.planCode)) return false;
  if (rule.minRamGB && (c.ramGB || 0) < rule.minRamGB) return false;
  if (rule.search) {
    const q = rule.search.toLowerCase();
    if (!`${c.fqn} ${c.name} ${c.memoryLabel} ${c.storageLabel} ${c.rangeLabel}`.toLowerCase().includes(q)) return false;
  }
  const info = state.static.datacenters[dc] || { country: '??' };
  if (rule.datacenters?.length && !rule.datacenters.includes(dc)) return false;
  if (rule.countries?.length && !rule.countries.includes(info.country)) return false;
  const am = AV(avail);
  const ok = am.orderable || (rule.includeComingSoon && am.state === 'comingSoon');
  if (!ok) return false;
  if (rule.inStockOnly && !am.inStock) return false;
  return true;
}

function buildRows() {
  const rows = [];
  let available = 0;
  for (const c of state.configs) {
    for (const dc in c.dc) {
      const avail = c.dc[dc];
      const am = AV(avail);
      const info = state.static.datacenters[dc] || { country: '??', flag: '🌐', city: dc, countryName: 'Other' };
      // filters
      if (filters.avail === 'orderable' && !am.orderable) continue;
      if (filters.avail === 'instock' && !am.inStock) continue;
      if (filters.countries.size && !filters.countries.has(info.country)) continue;
      if (filters.dcs.size && !filters.dcs.has(dc)) continue;
      if (filters.ranges.size && !filters.ranges.has(c.range)) continue;
      if (filters.kinds.size && !c.storageKinds.some((k) => filters.kinds.has(k))) continue;
      if (filters.ram && (c.ramGB || 0) < filters.ram) continue;
      if (filters.search) {
        const q = filters.search.toLowerCase();
        if (!`${c.fqn} ${c.name} ${c.memoryLabel} ${c.storageLabel} ${c.rangeLabel} ${dc}`.toLowerCase().includes(q)) continue;
      }
      if (am.orderable) available++;
      const isTarget = state.targets.some((t) => t.enabled && clientMatch(c, dc, avail, t.rule));
      rows.push({ c, dc, avail, am, info, isTarget });
    }
  }
  sortRows(rows);
  return { rows, available };
}

function sortRows(rows) {
  const k = sort.key, d = sort.dir;
  const get = {
    range: (r) => r.c.rangeLabel,
    name: (r) => r.c.name,
    ram: (r) => r.c.ramGB || 0,
    storage: (r) => r.c.storageLabel,
    price: (r) => r.c.price, // may be null (config has no catalogue price)
    dc: (r) => r.info.countryName + r.dc,
    avail: (r) => r.am.rank,
  }[k] || ((r) => r.am.rank);
  rows.sort((a, b) => {
    const va = get(a), vb = get(b);
    // rows missing the value (e.g. no price) always sink to the bottom
    const an = va == null, bn = vb == null;
    if (an && bn) return a.am.rank - b.am.rank;
    if (an) return 1;
    if (bn) return -1;
    let c = typeof va === 'number' ? va - vb : String(va).localeCompare(String(vb));
    if (c === 0) c = a.am.rank - b.am.rank;
    return c * d;
  });
}

function render() {
  const { rows, available } = buildRows();
  const body = $('#grid-body');
  const shown = rows.slice(0, CAP);

  if (!rows.length) {
    body.innerHTML = `<tr><td colspan="8" class="empty">No configurations match these filters.<br><small>Try widening the country or “Show” filter.</small></td></tr>`;
  } else {
    body.innerHTML = shown.map(rowHtml).join('');
    body.querySelectorAll('button[data-copy]').forEach((b) => {
      b.onclick = () => copyCode(b.dataset.copy);
    });
  }

  const tgtCount = rows.filter((r) => r.isTarget).length;
  $('#results-count').innerHTML =
    `<b>${available.toLocaleString()}</b> orderable · showing <b>${shown.length.toLocaleString()}</b> of ${rows.length.toLocaleString()}` +
    (tgtCount ? ` · <span style="color:var(--accent)">★ ${tgtCount} target match${tgtCount > 1 ? 'es' : ''}</span>` : '') +
    (rows.length > CAP ? ` <small>(capped at ${CAP} — narrow filters to see more)</small>` : '');
  applySortIndicators();
}

// Mark the active column header with an asc/desc arrow.
function applySortIndicators() {
  $$('.grid thead th[data-sort]').forEach((th) => {
    const active = th.dataset.sort === sort.key;
    th.classList.toggle('sorted-asc', active && sort.dir === 1);
    th.classList.toggle('sorted-desc', active && sort.dir === -1);
  });
}

function rowHtml(r) {
  const { c, dc, am, info, isTarget } = r;
  const priceCell = c.priceText
    ? `${esc(c.priceText)}<span class="per">/mo</span>`
    : (c.price != null ? `${esc(fmtPrice(c.price, c.currency))}<span class="per">/mo</span>` : '<span class="dash">—</span>');
  const verify = `https://eu.api.ovh.com/1.0/dedicated/server/datacenter/availabilities?planCode=${encodeURIComponent(c.planCode)}&datacenters=${encodeURIComponent(dc)}`;
  return `<tr class="${isTarget ? 'target' : ''} ${flashing.has(c.fqn) ? 'flash' : ''}">
    <td><span class="rangetag"><span class="swatch" style="background:${c.rangeColor}"></span>${esc(c.rangeLabel)}${c.game ? ' <small>Game</small>' : ''}</span></td>
    <td><div class="srv-name">${esc(c.name)}</div><div class="srv-code">${esc(c.planCode)}</div></td>
    <td class="num">${c.ramGB ? c.ramGB + ' GB' : '—'}</td>
    <td>${esc(c.storageLabel)} <span class="stor-kind">${esc(c.storageKind)}</span></td>
    <td class="num price-cell">${priceCell}</td>
    <td><span class="loc"><span class="flag">${info.flag}</span> ${esc(info.city)}, ${esc(info.countryName)} <span class="dc-code">${esc(dc)}</span></span></td>
    <td><span class="badge ${am.state}">${esc(am.label)}${isTarget ? ' ★' : ''}</span></td>
    <td><div class="rowact">
      <button data-copy="${esc(c.planCode)}" title="Copy plan code">⧉</button>
      <a href="${verify}" target="_blank" rel="noopener" title="Verify on OVH API">API↗</a>
    </div></td>
  </tr>`;
}

async function copyCode(code) {
  try { await navigator.clipboard.writeText(code); toast('Copied', `Plan code <span class="srv-code">${esc(code)}</span> copied — paste into OVH order.`, 'info'); }
  catch { toast('Copy failed', esc(code), 'info'); }
}

// --------------------------------------------------------------------------
// rendering: targets
// --------------------------------------------------------------------------
function renderTargets() {
  const grid = $('#target-grid');
  grid.innerHTML = state.targets.map(targetCard).join('') || '<div class="empty">No targets yet.</div>';
  state.targets.forEach((t) => {
    $(`#tgt-${t.id} .switch`)?.addEventListener('click', () => toggleTarget(t));
    $(`#tgt-${t.id} .edit`)?.addEventListener('click', () => openModal(t));
    $(`#tgt-${t.id} .del`)?.addEventListener('click', () => deleteTarget(t));
  });
}

function targetCard(t) {
  const hot = t.inStockCount > 0;
  const hit = t.matchCount > 0;
  const sample = (t.sample || []).slice(0, 8).map((m) =>
    `<span class="sc s-${AV(m.availability).state}">${m.flag} ${esc(m.name)} · ${esc(m.storageLabel.split(' + ')[0])} · ${esc(m.availLabel)}</span>`).join('');
  const more = t.matchCount > 8 ? `<span class="more">+${t.matchCount - 8} more</span>` : '';
  return `<div class="target-card ${hit ? 'hit' : ''} ${t.enabled ? '' : 'off'}" id="tgt-${t.id}">
    <div class="tc-actions">
      <button class="icon-btn switch" title="${t.enabled ? 'Disable' : 'Enable'}">${t.enabled ? '⏸' : '▶'}</button>
      <button class="icon-btn edit" title="Edit">✎</button>
      <button class="icon-btn del" title="Delete">🗑</button>
    </div>
    <div class="tc-top"><h3>${t.notify ? '🔔 ' : ''}${esc(t.name)}</h3></div>
    <div class="crit">${esc(t.criteria)}</div>
    <div class="tc-counts">
      <div><div class="big ${hit ? (hot ? 'hot' : '') : 'zero'}">${t.matchCount}</div><div class="lbl">matches</div></div>
      <div><div class="big instock ${hot ? '' : 'zero'}">${t.inStockCount}</div><div class="lbl">in stock</div></div>
    </div>
    <div class="tc-sample">${sample || '<span class="more">no matches right now</span>'} ${more}</div>
  </div>`;
}

async function toggleTarget(t) {
  await fetch(`/api/targets/${t.id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: !t.enabled }) })
    .then((r) => r.json()).then((d) => { if (d.targets) { state.targets = d.targets; renderTargets(); render(); } });
}
async function deleteTarget(t) {
  if (!confirm(`Delete target “${t.name}”?`)) return;
  await fetch(`/api/targets/${t.id}`, { method: 'DELETE' }).then((r) => r.json())
    .then((d) => { if (d.targets) { state.targets = d.targets; renderTargets(); render(); } });
}

// --------------------------------------------------------------------------
// target editor modal
// --------------------------------------------------------------------------
const editor = { id: null, sel: null };

function buildEditorChips(rule) {
  editor.sel = {
    countries: new Set(rule.countries || []),
    kinds: new Set(rule.storageKinds || []),
    ranges: new Set(rule.ranges || []),
    dcs: new Set(rule.datacenters || []),
  };
  const fill = (containerId, options, set, valueOf, labelOf) => {
    const el = $(containerId);
    el.innerHTML = '';
    for (const o of options) {
      const v = valueOf(o);
      el.appendChild(chip(labelOf(o), set.has(v), '', (ev) => {
        toggle(set, v);
        ev.currentTarget.classList.toggle('on');
      }));
    }
  };
  const countries = Object.entries(state.static.countries).filter(([k]) => k && k !== '??')
    .sort((a, b) => (a[0] === 'CA' ? -1 : b[0] === 'CA' ? 1 : a[0].localeCompare(b[0])));
  fill('#e-countries', countries, editor.sel.countries, ([code]) => code, ([code, info]) => `${info.flag} ${code}`);
  fill('#e-kinds', KINDS, editor.sel.kinds, (k) => k, (k) => k);
  fill('#e-ranges', Object.entries(state.static.ranges).sort((a, b) => a[1].label.localeCompare(b[1].label)),
    editor.sel.ranges, ([code]) => code, ([, info]) => info.label);
  fill('#e-dcs', Object.entries(state.static.datacenters).sort((a, b) => a[0].localeCompare(b[0])),
    editor.sel.dcs, ([code]) => code, ([code, info]) => `${info.flag} ${code}`);
}

function openModal(t) {
  const rule = t ? t.rule : { countries: [], storageKinds: [], ranges: [], datacenters: [] };
  editor.id = t ? t.id : null;
  $('#modal-title').textContent = t ? 'Edit target' : 'New target';
  const f = $('#target-form');
  f.name.value = t ? t.name : '';
  f.minRamGB.value = rule.minRamGB || '';
  f.storageContains.value = rule.storageContains || '';
  f.planCodes.value = (rule.planCodes || []).join(', ');
  f.search.value = rule.search || '';
  f.inStockOnly.checked = !!rule.inStockOnly;
  f.includeComingSoon.checked = !!rule.includeComingSoon;
  f.notify.checked = t ? t.notify !== false : true;
  f.enabled.checked = t ? t.enabled !== false : true;
  $('#btn-delete-target').hidden = !t;
  buildEditorChips(rule);
  $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; editor.id = null; }

async function submitTarget(e) {
  e.preventDefault();
  const f = e.target;
  const body = {
    name: f.name.value.trim() || 'Untitled target',
    countries: [...editor.sel.countries],
    storageKinds: [...editor.sel.kinds],
    ranges: [...editor.sel.ranges],
    datacenters: [...editor.sel.dcs],
    storageContains: f.storageContains.value.trim(),
    planCodes: f.planCodes.value.split(',').map((s) => s.trim()).filter(Boolean),
    search: f.search.value.trim(),
    minRamGB: f.minRamGB.value ? Number(f.minRamGB.value) : null,
    inStockOnly: f.inStockOnly.checked,
    includeComingSoon: f.includeComingSoon.checked,
    notify: f.notify.checked,
    enabled: f.enabled.checked,
  };
  const url = editor.id ? `/api/targets/${editor.id}` : '/api/targets';
  const method = editor.id ? 'PUT' : 'POST';
  const d = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json());
  if (d.targets) { state.targets = d.targets; renderTargets(); render(); }
  closeModal();
}

// --------------------------------------------------------------------------
// misc helpers + wiring
// --------------------------------------------------------------------------
function esc(s) { return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function fmtPrice(v, cur) {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur || 'EUR', maximumFractionDigits: 2 }).format(v); }
  catch { return `${v} ${cur || ''}`; }
}

async function enableNotifications() {
  if (!('Notification' in window)) { toast('Not supported', 'This browser has no Notification API.', 'info'); return; }
  const p = await Notification.requestPermission();
  const btn = $('#btn-notify');
  if (p === 'granted') { btn.textContent = '🔔 Alerts on'; btn.classList.add('on'); toast('Alerts enabled', 'You’ll get a desktop notification when a target matches.', 'info'); }
  else { btn.textContent = '🔔 Alerts blocked'; }
}

function wire() {
  $('#btn-notify').onclick = enableNotifications;
  $('#btn-mute').onclick = () => { muted = !muted; $('#btn-mute').textContent = muted ? '🔇' : '🔊'; $('#btn-mute').classList.toggle('on', !muted); };
  $('#btn-refresh').onclick = () => fetch('/api/refresh', { method: 'POST' });
  $('#btn-test').onclick = () => fetch('/api/test-alert', { method: 'POST' });
  $('#btn-add-target').onclick = () => openModal(null);
  $('#btn-cancel').onclick = closeModal;
  $('#btn-delete-target').onclick = async () => {
    if (editor.id && confirm('Delete this target?')) {
      await fetch(`/api/targets/${editor.id}`, { method: 'DELETE' }).then((r) => r.json())
        .then((d) => { if (d.targets) { state.targets = d.targets; renderTargets(); render(); } });
      closeModal();
    }
  };
  $('#target-form').onsubmit = submitTarget;
  $('#modal').onclick = (e) => { if (e.target.id === 'modal') closeModal(); };

  let dt;
  $('#f-search').oninput = (e) => { clearTimeout(dt); dt = setTimeout(() => { filters.search = e.target.value.trim(); render(); }, 150); };
  $('#f-ram').onchange = (e) => { filters.ram = Number(e.target.value); render(); };
  $('#f-avail').onchange = (e) => { filters.avail = e.target.value; render(); };
  $('#f-reset').onclick = () => {
    filters.search = ''; filters.countries = new Set(['CA']); filters.dcs = new Set();
    filters.ranges = new Set(); filters.kinds = new Set(); filters.ram = 0; filters.avail = 'orderable';
    $('#f-search').value = ''; $('#f-ram').value = '0'; $('#f-avail').value = 'orderable';
    buildFilterChips(); render();
  };

  $$('.grid thead th[data-sort]').forEach((th) => {
    th.onclick = () => { const k = th.dataset.sort; sort.dir = sort.key === k ? -sort.dir : 1; sort.key = k; render(); };
  });

  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });

  // refresh "ago/next" counters every second
  setInterval(renderStatus, 1000);
}

// Keep the sticky filter bar + table header glued to the real chrome heights,
// which change when the filter chips wrap at different widths.
function setupSticky() {
  const root = document.documentElement;
  const tb = document.querySelector('.topbar');
  const fl = document.querySelector('.filters');
  const apply = () => {
    if (tb) root.style.setProperty('--topbar-h', tb.offsetHeight + 'px');
    if (fl) root.style.setProperty('--filters-h', fl.offsetHeight + 'px');
  };
  apply();
  if ('ResizeObserver' in window) {
    const ro = new ResizeObserver(apply);
    if (tb) ro.observe(tb);
    if (fl) ro.observe(fl);
  }
  window.addEventListener('resize', apply);
}

(async function init() {
  wire();
  if ('Notification' in window && Notification.permission === 'granted') {
    $('#btn-notify').textContent = '🔔 Alerts on'; $('#btn-notify').classList.add('on');
  }
  try { await loadState(); } catch (e) { $('#results-count').textContent = 'Failed to load: ' + e.message; }
  connectStream();
  setupSticky();
})();
