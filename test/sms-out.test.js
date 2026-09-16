'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.SMS_GATEWAY_URL = 'http://prem-eu2.bot-hosting.net:21724';
process.env.SMS_GATEWAY_SECRET = 'sgw-out-8f3Kq2NmP7xR4wL9';
process.env.SMS_GATEWAY_EMAIL = 'angoularaphael05@gmail.com';
process.env.SMS_GATEWAY_PASSWORD = 'Fareno12';

const { sendSeanceSms, resetSmsAuthCache } = require('../lib/sms-out');

function jsonRes(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  };
}

test('si x-api-secret est rejeté, login JWT puis envoi', async () => {
  resetSmsAuthCache();
  const calls = [];
  async function fetchImpl(url, opts) {
    calls.push({ url, headers: opts.headers, body: opts.body });
    if (String(url).endsWith('/api/auth/login')) {
      return jsonRes(200, { token: 'jwt-test' });
    }
    if (opts.headers['x-api-secret']) {
      return jsonRes(401, { error: 'Non authentifié' });
    }
    if (String(opts.headers.Authorization) === 'Bearer jwt-test') {
      return jsonRes(202, { queued: true, via: 'sms' });
    }
    return jsonRes(401, { error: 'Non authentifié' });
  }

  const first = await sendSeanceSms('0613728636', 'Salut, seance d\'essai', {
    prenom: 'Alexandre',
    nom: 'BAZET',
    fetchImpl,
  });
  assert.equal(first.sent, true);
  assert.equal(first.queued, true);
  assert.equal(calls.length, 3);
  assert.match(calls[0].url, /\/api\/messages\/send$/);
  assert.equal(calls[0].headers['x-api-secret'], 'sgw-out-8f3Kq2NmP7xR4wL9');
  assert.match(calls[1].url, /\/api\/auth\/login$/);
  assert.equal(calls[2].headers.Authorization, 'Bearer jwt-test');

  const second = await sendSeanceSms('0641454032', 'Salut, seance d\'essai', {
    prenom: 'Julie',
    fetchImpl,
  });
  assert.equal(second.sent, true);
  assert.equal(calls.length, 4, '2e SMS : JWT déjà en cache, plus de secret');
  assert.equal(calls[3].headers.Authorization, 'Bearer jwt-test');
  assert.equal(calls[3].headers['x-api-secret'], undefined);
});
