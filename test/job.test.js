'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'group-bot-job-'));
process.env.BOT_DATA_DIR = tmp;

for (const rel of ['../lib/paths', '../lib/phones', '../lib/job']) {
  const id = require.resolve(rel);
  delete require.cache[id];
}

const {
  contactLabel,
  startJob,
  touchCurrent,
  markOk,
  pauseJob,
  loadJob,
  resumeLines,
  lastLogLines,
} = require('../lib/job');

test('checkpoint : dernier OK + contact de coupure', () => {
  startJob({ command: '.savecon', total: 3000, chat: '336@s.whatsapp.net' });
  touchCurrent({ prenom: 'Marie', nom: 'Dupont', telephone: '0612345678', ville: 'Toulouse' }, 12);
  markOk({ prenom: 'Marie', nom: 'Dupont', telephone: '0612345678', ville: 'Toulouse' });
  touchCurrent({ prenom: 'Jean', nom: 'Martin', telephone: '0698765432', ville: 'Balma' }, 13);
  pauseJob('WhatsApp déconnecté', { prenom: 'Jean', nom: 'Martin', telephone: '0698765432', ville: 'Balma' });

  const job = loadJob();
  assert.equal(job.status, 'paused');
  assert.equal(job.lastOk.phone, '33612345678');
  assert.equal(job.stoppedAt.phone, '33698765432');
  assert.match(contactLabel(job.stoppedAt), /Jean Martin/);
  const lines = resumeLines('.savecon');
  assert.ok(lines.some((l) => /Marie Dupont/.test(l)));
  assert.ok(lines.some((l) => /Jean Martin/.test(l)));
  const logs = lastLogLines(10).join('\n');
  assert.match(logs, /COUPE sur/);
  assert.match(logs, /33698765432/);
});
