// core/notify/format.js
// One alert batch -> the text each channel sends.
//
// Alerts are batched per run, not sent one per server: a five-minute window can
// surface dozens at once and nobody wants dozens of buzzes. The body is capped
// and the remainder summarised, so a flood degrades into one honest line
// instead of a truncated wall.

import { orderLink } from '../deeplink.js';

const MAX_LINES = 12;

function line(a, subsidiary) {
  const link = orderLink(a, subsidiary);
  const bits = [a.model || a.name];
  if (a.ram) bits.push(`${a.ram} GB`);
  return {
    head: `${a.flag} ${a.model || a.name} — ${a.city}`,
    spec: [a.memoryLabel, a.storageLabel].filter(Boolean).join(' · '),
    price: a.priceText,
    avail: a.availLabel,
    code: a.planCode,
    url: link?.url || null,
    urlKind: link?.kind || null,
  };
}

/**
 * Build the shared shape every channel renders from.
 * `alerts` are the objects runWatches() produced.
 */
export function buildBatch(alerts, { subsidiary = 'CA' } = {}) {
  const shown = alerts.slice(0, MAX_LINES).map((a) => line(a, subsidiary));
  const overflow = alerts.length - shown.length;
  const inStock = alerts.filter((a) => a.inStock).length;

  const title = alerts.length === 1
    ? `${alerts[0].model || alerts[0].name} available in ${alerts[0].city}`
    : `${alerts.length} servers available`;

  const subtitle = inStock === alerts.length
    ? 'in stock now'
    : `${inStock} in stock now, ${alerts.length - inStock} on a delivery delay`;

  return { title, subtitle, lines: shown, overflow, count: alerts.length, watchNames: [...new Set(alerts.map((a) => a.watchName))] };
}

/** Plain text — used by ntfy and as the email fallback part. */
export function asText(batch) {
  const out = [`${batch.title} (${batch.subtitle})`, ''];
  for (const l of batch.lines) {
    out.push(`${l.head}`);
    out.push(`  ${[l.spec, l.price, l.avail].filter(Boolean).join(' · ')}`);
    out.push(`  ${l.code}${l.url ? `  ${l.url}` : ''}`);
  }
  if (batch.overflow > 0) out.push('', `…and ${batch.overflow} more.`);
  out.push('', `Matched: ${batch.watchNames.join(', ')}`);
  return out.join('\n');
}

/** Telegram HTML (a deliberately small subset: b, i, a, code). */
export function asTelegramHTML(batch) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const out = [`<b>${esc(batch.title)}</b>`, `<i>${esc(batch.subtitle)}</i>`, ''];
  for (const l of batch.lines) {
    const head = l.url ? `<a href="${esc(l.url)}">${esc(l.head)}</a>` : `<b>${esc(l.head)}</b>`;
    out.push(head);
    out.push(esc([l.spec, l.price, l.avail].filter(Boolean).join(' · ')));
    out.push(`<code>${esc(l.code)}</code>`);
    out.push('');
  }
  if (batch.overflow > 0) out.push(`…and ${batch.overflow} more.`);
  out.push(`<i>Matched: ${esc(batch.watchNames.join(', '))}</i>`);
  return out.join('\n');
}

/** Minimal HTML email. Inline styles only — mail clients strip stylesheets. */
export function asEmailHTML(batch) {
  const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const rows = batch.lines.map((l) => `
    <tr><td style="padding:12px 0;border-bottom:1px solid #dfe6ec">
      <div style="font:600 15px system-ui,sans-serif;color:#16222e">${esc(l.head)}</div>
      <div style="font:13px system-ui,sans-serif;color:#4e6373;margin-top:3px">${esc([l.spec, l.price, l.avail].filter(Boolean).join(' · '))}</div>
      <div style="font:12px ui-monospace,monospace;color:#74889a;margin-top:3px">${esc(l.code)}</div>
      ${l.url ? `<a href="${esc(l.url)}" style="display:inline-block;margin-top:8px;font:600 12px system-ui,sans-serif;color:#5b48d4;text-decoration:none">${l.urlKind === 'model' ? 'Order this now →' : 'Browse this range →'}</a>` : ''}
    </td></tr>`).join('');
  return `<div style="max-width:560px;margin:0 auto;padding:20px">
    <div style="font:700 20px system-ui,sans-serif;color:#16222e">${esc(batch.title)}</div>
    <div style="font:13px system-ui,sans-serif;color:#4e6373;margin-top:4px">${esc(batch.subtitle)}</div>
    <table style="width:100%;border-collapse:collapse;margin-top:14px">${rows}</table>
    ${batch.overflow > 0 ? `<div style="font:13px system-ui,sans-serif;color:#4e6373;margin-top:12px">…and ${batch.overflow} more.</div>` : ''}
    <div style="font:12px system-ui,sans-serif;color:#74889a;margin-top:18px">Matched: ${esc(batch.watchNames.join(', '))}</div>
  </div>`;
}

/** Discord embeds / Slack attachments. */
export function asWebhookPayload(batch, flavour) {
  if (flavour === 'slack') {
    const text = asText(batch);
    return { text: `*${batch.title}*\n${batch.subtitle}`, blocks: [
      { type: 'section', text: { type: 'mrkdwn', text: `*${batch.title}*\n_${batch.subtitle}_` } },
      { type: 'section', text: { type: 'mrkdwn', text: '```' + text + '```' } },
    ] };
  }
  // Discord
  return {
    embeds: [{
      title: batch.title.slice(0, 250),
      description: batch.subtitle,
      color: 0x55e0a0,
      fields: batch.lines.slice(0, 10).map((l) => ({
        name: l.head.slice(0, 250),
        value: [
          [l.spec, l.price, l.avail].filter(Boolean).join(' · '),
          l.url ? `[${l.urlKind === 'model' ? 'Order' : 'Browse'}](${l.url}) · \`${l.code}\`` : `\`${l.code}\``,
        ].join('\n').slice(0, 1000),
      })),
      footer: { text: `Matched: ${batch.watchNames.join(', ')}`.slice(0, 2000) },
    }],
  };
}
