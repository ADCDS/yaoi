// Channel dispatch, failure isolation, and the hand-written SMTP client.
//
// The SMTP client exists so the project keeps zero dependencies. That is only
// defensible if it is actually exercised, so these tests stand up a real TCP
// server that speaks SMTP back at it and assert on the transcript.

import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import http from 'node:http';
import { sendMail } from '../core/notify/smtp.js';
import { dispatch, channelsFromEnv, channelStatus, testChannel } from '../core/notify/index.js';
import { buildBatch, asText, asTelegramHTML, asWebhookPayload } from '../core/notify/format.js';

const alert = (over = {}) => ({
  watchId: 'w1', watchName: 'Canada NVMe', channels: ['telegram', 'ntfy', 'webhook', 'email'],
  fqn: 'x.1', planCode: '24sys022', name: 'SYS-2 | Intel Xeon-D 2141I', model: 'SYS-2',
  cpu: 'Intel Xeon-D 2141I', range: 'soyoustart', rangeLabel: 'So you Start',
  memoryLabel: '128 GB ECC 2666', storageLabel: '2×1.92 TB NVMe', priceText: '$159.87 CAD',
  dc: 'bhs', dcLabel: 'Beauharnois, Canada', city: 'Beauharnois', flag: '🇨🇦',
  availability: '1H-high', availLabel: 'In stock (high)', inStock: true, tier: 'now', ramGB: 128,
  ...over,
});

// --------------------------------------------------------------------------
// A stub SMTP server. Records the transcript so we can assert the client
// really performed the handshake rather than merely not throwing.
// --------------------------------------------------------------------------
function smtpStub({ authMech = 'PLAIN', failAt = null } = {}) {
  const transcript = [];
  const server = net.createServer((sock) => {
    let inData = false;
    sock.write('220 stub ESMTP ready\r\n');
    sock.on('data', (buf) => {
      for (const raw of buf.toString('utf8').split(/\r\n/)) {
        if (raw === '' && !inData) continue;
        if (inData) {
          transcript.push(`DATA:${raw}`);
          if (raw === '.') { inData = false; sock.write('250 queued\r\n'); }
          continue;
        }
        const line = raw;
        if (!line) continue;
        transcript.push(line);
        const verb = line.split(' ')[0].toUpperCase();
        if (failAt && verb === failAt) { sock.write('550 refused for the test\r\n'); continue; }
        if (verb === 'EHLO') sock.write(`250-stub\r\n250 AUTH ${authMech}\r\n`);
        else if (verb === 'AUTH') {
          if (/^AUTH LOGIN$/i.test(line)) sock.write('334 VXNlcm5hbWU6\r\n');
          else sock.write('235 authenticated\r\n');
        } else if (/^[A-Za-z0-9+/=]+$/.test(line) && !verb.match(/^(MAIL|RCPT|DATA|QUIT|EHLO|AUTH)$/)) {
          // base64 continuation of AUTH LOGIN
          sock.write(transcript.filter((l) => /^[A-Za-z0-9+/=]+$/.test(l)).length >= 2 ? '235 authenticated\r\n' : '334 UGFzc3dvcmQ6\r\n');
        } else if (verb === 'MAIL' || verb === 'RCPT') sock.write('250 ok\r\n');
        else if (verb === 'DATA') { inData = true; sock.write('354 go ahead\r\n'); }
        else if (verb === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
        else sock.write('250 ok\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, transcript }));
  });
}

test('smtp: completes a full submission with AUTH PLAIN', async () => {
  const { server, port, transcript } = await smtpStub({ authMech: 'PLAIN' });
  try {
    const r = await sendMail(
      { host: '127.0.0.1', port, secure: false, user: 'me', pass: 'pw', from: 'a@b.test', to: 'c@d.test' },
      { subject: 'In stock', text: 'plain body', html: '<p>rich body</p>' },
    );
    assert.equal(r.ok, true);
    assert.equal(r.recipients, 1);
    assert.ok(transcript.some((l) => l.startsWith('EHLO')));
    assert.ok(transcript.some((l) => l.startsWith('AUTH PLAIN')));
    assert.ok(transcript.includes('MAIL FROM:<a@b.test>'));
    assert.ok(transcript.includes('RCPT TO:<c@d.test>'));
    assert.ok(transcript.includes('DATA'));
    assert.ok(transcript.includes('DATA:.'), 'message must be terminated with a lone dot');
  } finally { server.close(); }
});

test('smtp: AUTH LOGIN is supported for servers that offer only that', async () => {
  const { server, port, transcript } = await smtpStub({ authMech: 'LOGIN' });
  try {
    await sendMail({ host: '127.0.0.1', port, secure: false, user: 'me', pass: 'pw', from: 'a@b.test', to: 'c@d.test' },
      { subject: 'x', text: 'y' });
    assert.ok(transcript.includes('AUTH LOGIN'));
  } finally { server.close(); }
});

test('smtp: multipart when html is supplied, and both parts are present', async () => {
  const { server, port, transcript } = await smtpStub();
  try {
    await sendMail({ host: '127.0.0.1', port, secure: false, from: 'a@b.test', to: 'c@d.test' },
      { subject: 'x', text: 'THE-TEXT-PART', html: '<b>THE-HTML-PART</b>' });
    const body = transcript.filter((l) => l.startsWith('DATA:')).join('\n');
    assert.match(body, /multipart\/alternative/);
    assert.match(body, /THE-TEXT-PART/);
    assert.match(body, /THE-HTML-PART/);
  } finally { server.close(); }
});

test('smtp: a non-ASCII subject is encoded rather than mangled', async () => {
  const { server, port, transcript } = await smtpStub();
  try {
    await sendMail({ host: '127.0.0.1', port, secure: false, from: 'a@b.test', to: 'c@d.test' },
      { subject: 'ready in ≤1h', text: 'x' });
    const body = transcript.filter((l) => l.startsWith('DATA:')).join('\n');
    assert.match(body, /Subject: =\?UTF-8\?B\?/);
  } finally { server.close(); }
});

test('smtp: a line consisting of a single dot cannot end the message early', async () => {
  const { server, port, transcript } = await smtpStub();
  try {
    await sendMail({ host: '127.0.0.1', port, secure: false, from: 'a@b.test', to: 'c@d.test' },
      { subject: 'x', text: 'before\n.\nafter' });
    const body = transcript.filter((l) => l.startsWith('DATA:'));
    assert.ok(body.includes('DATA:..'), 'the dot must be stuffed');
    assert.ok(body.some((l) => l === 'DATA:after'), 'text after the dot must survive');
  } finally { server.close(); }
});

test('smtp: a refusal is reported, not swallowed', async () => {
  const { server, port } = await smtpStub({ failAt: 'RCPT' });
  try {
    await assert.rejects(
      () => sendMail({ host: '127.0.0.1', port, secure: false, from: 'a@b.test', to: 'c@d.test' }, { subject: 'x', text: 'y' }),
      /550/,
    );
  } finally { server.close(); }
});

test('smtp: multiple recipients each get an RCPT', async () => {
  const { server, port, transcript } = await smtpStub();
  try {
    const r = await sendMail({ host: '127.0.0.1', port, secure: false, from: 'a@b.test', to: 'c@d.test, e@f.test' },
      { subject: 'x', text: 'y' });
    assert.equal(r.recipients, 2);
    assert.ok(transcript.includes('RCPT TO:<c@d.test>'));
    assert.ok(transcript.includes('RCPT TO:<e@f.test>'));
  } finally { server.close(); }
});

// --------------------------------------------------------------------------
// Environment reading
// --------------------------------------------------------------------------
test('env: nothing configured means nothing enabled, and that is not an error', () => {
  // This is exactly the public GitHub Actions job.
  assert.deepEqual(channelsFromEnv({}), {});
});

test('env: each channel needs its full set before it counts as usable', () => {
  assert.equal(channelsFromEnv({ TELEGRAM_BOT_TOKEN: 't' }).telegram, undefined);
  assert.ok(channelsFromEnv({ TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }).telegram);
  assert.equal(channelsFromEnv({ SMTP_HOST: 'h' }).email, undefined);
  assert.ok(channelsFromEnv({ SMTP_HOST: 'h', SMTP_TO: 'a@b' }).email);
});

test('env: a webhook is routed by its host', () => {
  assert.equal(channelsFromEnv({ WEBHOOK_URL: 'https://hooks.slack.com/services/x' }).webhook.flavour, 'slack');
  assert.equal(channelsFromEnv({ WEBHOOK_URL: 'https://discord.com/api/webhooks/x' }).webhook.flavour, 'discord');
});

test('env: an ntfy URL that already contains the topic is accepted', () => {
  const c = channelsFromEnv({ NTFY_URL: 'https://ntfy.example/kimsufi' });
  assert.equal(c.ntfy.base, 'https://ntfy.example');
  assert.equal(c.ntfy.topic, 'kimsufi');
});

test('status: reports what is on without inventing capability', () => {
  const st = channelStatus({});
  assert.equal(st.find((c) => c.channel === 'browser').configured, true);
  assert.equal(st.find((c) => c.channel === 'email').configured, false);
  assert.equal(st.find((c) => c.channel === 'email').detail, null);
});

// --------------------------------------------------------------------------
// Dispatch
// --------------------------------------------------------------------------
test('dispatch: no alerts, no work', async () => {
  const r = await dispatch([], { env: {} });
  assert.deepEqual(r.sent, []);
});

test('dispatch: unconfigured channels are skipped cleanly, never thrown', async () => {
  const r = await dispatch([alert()], { env: {} });
  assert.equal(r.sent.length, 0);
  assert.equal(r.skipped.length, 4);
  assert.ok(r.skipped.every((s) => s.reason === 'not configured'));
});

test('dispatch: browser is never sent server-side', async () => {
  const r = await dispatch([alert({ channels: ['browser'] })], { env: {} });
  assert.equal(r.sent.length, 0);
  assert.equal(r.skipped.length, 0);
});

test('dispatch: one broken channel does not silence the others', async () => {
  // A webhook that always 500s, alongside a working one.
  const bad = http.createServer((req, res) => { res.writeHead(500).end('nope'); });
  const good = http.createServer((req, res) => { req.resume(); res.writeHead(200).end('{}'); });
  await new Promise((r) => bad.listen(0, '127.0.0.1', r));
  await new Promise((r) => good.listen(0, '127.0.0.1', r));
  try {
    const r = await dispatch([alert({ channels: ['webhook', 'ntfy'] })], {
      env: {
        WEBHOOK_URL: `http://127.0.0.1:${bad.address().port}/hook`,
        NTFY_URL: `http://127.0.0.1:${good.address().port}`, NTFY_TOPIC: 't',
      },
    });
    const byName = Object.fromEntries(r.sent.map((s) => [s.channel, s]));
    assert.equal(byName.webhook.ok, false);
    assert.match(byName.webhook.error, /500/);
    assert.equal(byName.ntfy.ok, true, 'the healthy channel must still deliver');
  } finally { bad.close(); good.close(); }
});

test('dispatch: only channels the matching watches asked for are used', async () => {
  const seen = [];
  const srv = http.createServer((req, res) => { seen.push(req.url); req.resume(); res.writeHead(200).end('{}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = srv.address().port;
    await dispatch([alert({ channels: ['ntfy'] })], {
      env: { NTFY_URL: `http://127.0.0.1:${port}`, NTFY_TOPIC: 'topic', WEBHOOK_URL: `http://127.0.0.1:${port}/hook` },
    });
    assert.deepEqual(seen, ['/topic']);
  } finally { srv.close(); }
});

test('testChannel: reports failure for a channel that is not set up', async () => {
  const r = await testChannel('telegram', { env: {} });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'not configured');
});

// --------------------------------------------------------------------------
// Formatting
// --------------------------------------------------------------------------
test('format: one alert names the machine and the city', () => {
  const b = buildBatch([alert()]);
  assert.match(b.title, /SYS-2 available in Beauharnois/);
  assert.equal(b.subtitle, 'in stock now');
});

test('format: many alerts are batched and the overflow is stated, not truncated silently', () => {
  const many = Array.from({ length: 30 }, (_, i) => alert({ fqn: `x.${i}` }));
  const b = buildBatch(many);
  assert.equal(b.count, 30);
  assert.equal(b.lines.length, 12);
  assert.equal(b.overflow, 18);
  assert.match(asText(b), /and 18 more/);
});

test('format: a mixed batch says how many are actually in stock', () => {
  const b = buildBatch([alert(), alert({ fqn: 'x.2', inStock: false, availLabel: '~24h' })]);
  assert.equal(b.subtitle, '1 in stock now, 1 on a delivery delay');
});

test('format: every message carries the verified order link', () => {
  const b = buildBatch([alert()]);
  assert.equal(b.lines[0].url, 'https://eco.ovhcloud.com/en-ca/soyoustart/sys-2/');
  assert.match(asText(b), /eco\.ovhcloud\.com/);
  assert.match(asTelegramHTML(b), /href="https:\/\/eco\.ovhcloud\.com/);
});

test('format: telegram html escapes the fields it interpolates', () => {
  const b = buildBatch([alert({ model: '<script>x</script>' })]);
  const html = asTelegramHTML(b);
  assert.ok(!html.includes('<script>'));
  assert.match(html, /&lt;script&gt;/);
});

test('format: slack and discord get their own shapes', () => {
  const b = buildBatch([alert()]);
  assert.ok(asWebhookPayload(b, 'slack').blocks);
  assert.ok(asWebhookPayload(b, 'discord').embeds);
});
