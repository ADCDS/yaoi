// core/notify/index.js
// Channel dispatch.
//
// Two rules shape this file:
//
//  1. Unconfigured is not an error. The public GitHub Actions job runs with no
//     channel secrets at all and must exit green — it publishes a snapshot and
//     notifies nobody. So a missing channel is simply "off", never a failure.
//
//  2. One broken channel must not silence the others or fail the run. Each send
//     is isolated and its outcome reported, so a dead SMTP server still lets the
//     Telegram message through and the log says exactly what happened.
//
// Configuration comes only from the environment. Nothing is ever written to the
// repository: this project is public.

import { buildBatch, asText, asTelegramHTML, asEmailHTML, asWebhookPayload } from './format.js';
import { sendMail } from './smtp.js';

const TIMEOUT_MS = 15000;

async function postJSON(url, body, headers = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`);
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read channel configuration out of the environment.
 * Returns only channels that are actually usable.
 */
export function channelsFromEnv(env = process.env) {
  const chans = {};

  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    chans.telegram = { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
  }

  if (env.NTFY_TOPIC || env.NTFY_URL) {
    chans.ntfy = {
      base: (env.NTFY_URL || 'https://ntfy.sh').replace(/\/+$/, ''),
      topic: env.NTFY_TOPIC || '',
      token: env.NTFY_TOKEN || '',
    };
    // A base URL that already includes the topic path is a common way to write
    // this; accept it rather than sending to /<empty>.
    if (!chans.ntfy.topic) {
      const m = /^(https?:\/\/[^/]+)\/(.+)$/.exec(chans.ntfy.base);
      if (m) { chans.ntfy.base = m[1]; chans.ntfy.topic = m[2]; }
      else delete chans.ntfy;
    }
  }

  if (env.WEBHOOK_URL) {
    const url = env.WEBHOOK_URL;
    const flavour = /hooks\.slack\.com/.test(url) ? 'slack' : 'discord';
    chans.webhook = { url, flavour };
  }

  if (env.SMTP_HOST && env.SMTP_TO) {
    chans.email = {
      host: env.SMTP_HOST,
      port: env.SMTP_PORT ? Number(env.SMTP_PORT) : 587,
      secure: env.SMTP_SECURE ? env.SMTP_SECURE !== 'false' : undefined,
      user: env.SMTP_USER || '',
      pass: env.SMTP_PASS || '',
      from: env.SMTP_FROM || env.SMTP_USER || '',
      to: env.SMTP_TO,
    };
  }

  return chans;
}

// ---- individual senders ---------------------------------------------------

async function sendTelegram(cfg, batch) {
  await postJSON(`https://api.telegram.org/bot${cfg.token}/sendMessage`, {
    chat_id: cfg.chatId,
    text: asTelegramHTML(batch),
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  });
}

async function sendNtfy(cfg, batch) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const headers = {
      Title: batch.title.replace(/[^\x20-\x7E]/g, ''), // ntfy headers are latin-1
      Priority: batch.lines.some((l) => /in stock/i.test(l.avail || '')) ? 'high' : 'default',
      Tags: 'satellite',
    };
    const firstUrl = batch.lines.find((l) => l.url)?.url;
    if (firstUrl) headers.Click = firstUrl;
    if (cfg.token) headers.Authorization = `Bearer ${cfg.token}`;
    const res = await fetch(`${cfg.base}/${cfg.topic}`, {
      method: 'POST', headers, body: asText(batch), signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);
  } finally {
    clearTimeout(timer);
  }
}

async function sendWebhook(cfg, batch) {
  await postJSON(cfg.url, asWebhookPayload(batch, cfg.flavour));
}

async function sendEmail(cfg, batch) {
  await sendMail(cfg, {
    subject: batch.title,
    text: asText(batch),
    html: asEmailHTML(batch),
  });
}

const SENDERS = { telegram: sendTelegram, ntfy: sendNtfy, webhook: sendWebhook, email: sendEmail };

/**
 * Deliver one batch of alerts.
 *
 * Only channels that are both configured and requested by at least one of the
 * alerts' watches are used. `browser` is not handled here: it is delivered by
 * the page itself over SSE or from the client-side matcher.
 *
 * Returns one result per attempted channel. Never throws.
 */
export async function dispatch(alerts, { channels = null, env = process.env, subsidiary = 'CA' } = {}) {
  if (!alerts || !alerts.length) return { sent: [], skipped: [], batch: null };
  const configured = channels || channelsFromEnv(env);

  // Union of channels the matching watches asked for, minus the browser.
  const wanted = new Set();
  for (const a of alerts) for (const c of a.channels || []) if (c !== 'browser') wanted.add(c);

  const batch = buildBatch(alerts, { subsidiary });
  const results = [];
  const skipped = [];

  for (const name of wanted) {
    if (!configured[name]) { skipped.push({ channel: name, reason: 'not configured' }); continue; }
    try {
      await SENDERS[name](configured[name], batch);
      results.push({ channel: name, ok: true });
    } catch (err) {
      // Isolated on purpose: a failing channel is reported, not propagated.
      results.push({ channel: name, ok: false, error: String(err?.message || err) });
    }
  }

  return { sent: results, skipped, batch };
}

/** Send a test message on one channel, for the notifications screen. */
export async function testChannel(name, { env = process.env, subsidiary = 'CA' } = {}) {
  const configured = channelsFromEnv(env);
  if (name !== 'browser' && !configured[name]) {
    return { channel: name, ok: false, error: 'not configured' };
  }
  const sample = [{
    watchId: 'test', watchName: 'Test', channels: [name],
    fqn: 'test.config', planCode: '24sys022', name: 'SYS-2 | Intel Xeon-D 2141I',
    model: 'SYS-2', cpu: 'Intel Xeon-D 2141I', range: 'soyoustart',
    memoryLabel: '128 GB ECC 2666', storageLabel: '2×1.92 TB NVMe', rangeLabel: 'So you Start',
    priceText: '$159.87 CAD', dc: 'bhs', dcLabel: 'Beauharnois, Canada', city: 'Beauharnois',
    flag: '🇨🇦', availability: '1H-high', availLabel: 'In stock (high)', inStock: true,
    tier: 'now', rank: 0.5, ram: 128,
  }];
  if (name === 'browser') return { channel: 'browser', ok: true, note: 'delivered by the page' };
  try {
    await SENDERS[name](configured[name], buildBatch(sample, { subsidiary }));
    return { channel: name, ok: true };
  } catch (err) {
    return { channel: name, ok: false, error: String(err?.message || err) };
  }
}

/** What the notifications screen shows: which channels exist and are usable. */
export function channelStatus(env = process.env) {
  const configured = channelsFromEnv(env);
  const describe = {
    telegram: (c) => `chat ${String(c.chatId).slice(0, 4)}…`,
    ntfy: (c) => `${c.base.replace(/^https?:\/\//, '')}/${c.topic}`,
    webhook: (c) => c.flavour,
    email: (c) => c.to,
  };
  return ['browser', 'telegram', 'ntfy', 'webhook', 'email'].map((name) => {
    if (name === 'browser') return { channel: name, configured: true, detail: 'this browser, while a tab is open' };
    const c = configured[name];
    return { channel: name, configured: !!c, detail: c ? describe[name](c) : null };
  });
}
