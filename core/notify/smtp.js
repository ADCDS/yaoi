// core/notify/smtp.js
// A minimal SMTP client, just enough to send one message.
//
// Why hand-rolled: this project ships with no dependencies and the README sells
// "no npm install needed". Pulling in nodemailer to send a stock alert would
// trade that for a dependency tree we cannot audit. SMTP submission is a small,
// stable protocol — EHLO, optional STARTTLS, AUTH, MAIL/RCPT/DATA — and the
// subset below is all that is needed.
//
// Supports implicit TLS (port 465) and STARTTLS upgrade (587/25), AUTH PLAIN and
// AUTH LOGIN. Node-only: needs node:net and node:tls.

import net from 'node:net';
import tls from 'node:tls';

const CRLF = '\r\n';

class SMTPError extends Error {
  constructor(message, code) { super(message); this.name = 'SMTPError'; this.code = code; }
}

/** Read one complete SMTP reply (handles multi-line `250-foo` continuations). */
function readReply(socket, timeoutMs) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const onData = (chunk) => {
      buf += chunk.toString('utf8');
      // A reply is complete when a line is "NNN <text>" with a space, not a dash.
      const lines = buf.split(/\r?\n/).filter(Boolean);
      const last = lines[lines.length - 1];
      if (!last || !/^\d{3}[ ]/.test(last)) return;
      cleanup();
      const code = Number(last.slice(0, 3));
      resolve({ code, text: buf.trim() });
    };
    const onErr = (err) => { cleanup(); reject(err); };
    const timer = setTimeout(() => { cleanup(); reject(new SMTPError('SMTP read timed out')); }, timeoutMs);
    function cleanup() {
      clearTimeout(timer);
      socket.removeListener('data', onData);
      socket.removeListener('error', onErr);
    }
    socket.on('data', onData);
    socket.on('error', onErr);
  });
}

async function send(socket, line, timeoutMs) {
  socket.write(line + CRLF);
  return readReply(socket, timeoutMs);
}

function expect(reply, ...codes) {
  if (!codes.includes(reply.code)) {
    throw new SMTPError(`SMTP expected ${codes.join('/')} but got: ${reply.text}`, reply.code);
  }
  return reply;
}

function connect(opts) {
  return new Promise((resolve, reject) => {
    const socket = opts.secure
      ? tls.connect({ host: opts.host, port: opts.port, servername: opts.host })
      : net.connect({ host: opts.host, port: opts.port });
    const onReady = () => { socket.removeListener('error', onErr); resolve(socket); };
    const onErr = (e) => { socket.destroy(); reject(e); };
    socket.once(opts.secure ? 'secureConnect' : 'connect', onReady);
    socket.once('error', onErr);
  });
}

function upgrade(socket, host) {
  return new Promise((resolve, reject) => {
    const sec = tls.connect({ socket, servername: host }, () => {
      sec.removeListener('error', reject);
      resolve(sec);
    });
    sec.once('error', reject);
  });
}

function encodeHeader(value) {
  // RFC 2047 for non-ASCII subjects, so "≤1h" doesn't arrive as mojibake.
  return /^[\x20-\x7E]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function buildMessage({ from, to, subject, text, html }) {
  const boundary = `kw-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
  const headers = [
    `From: ${from}`,
    `To: ${Array.isArray(to) ? to.join(', ') : to}`,
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString()}`,
    'MIME-Version: 1.0',
  ];
  if (!html) {
    headers.push('Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: 8bit');
    return headers.join(CRLF) + CRLF + CRLF + text;
  }
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  const body = [
    `--${boundary}`,
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '', text, '',
    `--${boundary}`,
    'Content-Type: text/html; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    '', html, '',
    `--${boundary}--`, '',
  ].join(CRLF);
  return headers.join(CRLF) + CRLF + CRLF + body;
}

/** Dot-stuffing: a line that is just "." would otherwise end the DATA block. */
function dotStuff(msg) {
  return msg.replace(/\r?\n/g, CRLF).replace(/^\./gm, '..');
}

/**
 * Send one message. Throws on any protocol or auth failure — the dispatcher
 * catches per channel so a broken mail server cannot take down the run.
 */
export async function sendMail(cfg, { subject, text, html }) {
  const port = Number(cfg.port) || 587;
  const secure = cfg.secure !== undefined ? !!cfg.secure : port === 465;
  const timeoutMs = Number(cfg.timeoutMs) || 20000;
  const host = cfg.host;
  if (!host) throw new SMTPError('SMTP host is not set');

  let socket = await connect({ host, port, secure });
  socket.setTimeout(timeoutMs);
  try {
    expect(await readReply(socket, timeoutMs), 220);
    let ehlo = expect(await send(socket, `EHLO ${cfg.clientName || 'kimsufi-watch'}`, timeoutMs), 250);

    if (!secure && /\bSTARTTLS\b/i.test(ehlo.text)) {
      expect(await send(socket, 'STARTTLS', timeoutMs), 220);
      socket = await upgrade(socket, host);
      socket.setTimeout(timeoutMs);
      ehlo = expect(await send(socket, `EHLO ${cfg.clientName || 'kimsufi-watch'}`, timeoutMs), 250);
    }

    if (cfg.user) {
      if (/AUTH[^\n]*\bPLAIN\b/i.test(ehlo.text)) {
        const token = Buffer.from(`\0${cfg.user}\0${cfg.pass || ''}`, 'utf8').toString('base64');
        expect(await send(socket, `AUTH PLAIN ${token}`, timeoutMs), 235);
      } else if (/AUTH[^\n]*\bLOGIN\b/i.test(ehlo.text)) {
        expect(await send(socket, 'AUTH LOGIN', timeoutMs), 334);
        expect(await send(socket, Buffer.from(cfg.user, 'utf8').toString('base64'), timeoutMs), 334);
        expect(await send(socket, Buffer.from(cfg.pass || '', 'utf8').toString('base64'), timeoutMs), 235);
      } else {
        throw new SMTPError('SMTP server offers neither AUTH PLAIN nor AUTH LOGIN');
      }
    }

    const from = cfg.from || cfg.user;
    const rcpts = Array.isArray(cfg.to) ? cfg.to : String(cfg.to).split(',').map((s) => s.trim()).filter(Boolean);
    if (!from) throw new SMTPError('SMTP from address is not set');
    if (!rcpts.length) throw new SMTPError('SMTP has no recipients');

    // Envelope sender must be a bare address even when the header is "Name <a@b>".
    const bare = (a) => { const m = /<([^>]+)>/.exec(a); return m ? m[1] : a; };
    expect(await send(socket, `MAIL FROM:<${bare(from)}>`, timeoutMs), 250);
    for (const r of rcpts) expect(await send(socket, `RCPT TO:<${bare(r)}>`, timeoutMs), 250, 251);
    expect(await send(socket, 'DATA', timeoutMs), 354);

    const msg = buildMessage({ from, to: rcpts, subject, text, html });
    socket.write(dotStuff(msg) + CRLF + '.' + CRLF);
    expect(await readReply(socket, timeoutMs), 250);

    try { await send(socket, 'QUIT', 3000); } catch { /* server may just close */ }
    return { ok: true, recipients: rcpts.length };
  } finally {
    socket.destroy();
  }
}
