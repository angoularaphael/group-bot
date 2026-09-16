'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'group-bot-save-'));
process.env.BOT_DATA_DIR = tmp;
process.env.ADD_MODE = 'prod';

for (const rel of ['../lib/paths', '../lib/used', '../lib/mode', '../lib/contacts']) {
  const id = require.resolve(rel);
  delete require.cache[id];
}

const { markPhone, isContactSaved, isWaSent, stats, applySeedSaved } = require('../lib/used');
const { pickUnsaved, pickSavedUnsent, loadProdContacts } = require('../lib/contacts');

test('un contact sauvé n’est plus repris par .savecon', () => {
  const pool = loadProdContacts();
  assert.ok(pool.length > 10, 'bd triee attendue');
  const first = pool[0];
  const second = pool[1];
  markPhone(first.telephone, { status: 'saved', prenom: first.prenom, nom: first.nom });
  assert.equal(isContactSaved(first.telephone), true);
  assert.equal(isContactSaved(second.telephone), false);
  const batch = pickUnsaved(8);
  assert.equal(batch.length, 8);
  assert.ok(batch.every((c) => c.telephone !== first.telephone));
  assert.ok(batch.some((c) => c.telephone === second.telephone));
});

test('.sendfull cible uniquement les saved, pas les déjà envoyés', () => {
  const pool = loadProdContacts();
  const a = pool[2];
  const b = pool[3];
  markPhone(a.telephone, { status: 'saved', prenom: a.prenom, nom: a.nom });
  markPhone(b.telephone, { status: 'wa_sent', prenom: b.prenom, nom: b.nom });
  const pending = pickSavedUnsent(20);
  assert.ok(pending.some((c) => c.telephone === a.telephone));
  assert.ok(pending.every((c) => c.telephone !== b.telephone));
  assert.equal(isWaSent(b.telephone), true);
  const s = stats();
  assert.ok(s.saved >= 1);
  assert.ok(s.waSent >= 1);
});

test('seed Tiphaine : .savecon reprend après #2103', () => {
  process.env.SEED_SAVED_FILE = path.join(__dirname, '..', 'data', 'seed-saved.json');
  const added = applySeedSaved();
  assert.ok(added >= 1);
  assert.equal(isContactSaved('33781840620'), true);
  const batch = pickUnsaved(1);
  assert.ok(batch.length);
  assert.equal(batch[0].telephone, '33783482626');
  assert.match(`${batch[0].prenom} ${batch[0].nom}`, /G[ée]rard Philippe/i);
  assert.equal(isWaSent('33659038532'), true);
  const smsNext = pickSavedUnsent(1);
  assert.ok(smsNext.length);
  assert.equal(smsNext[0].telephone, '33613728636');
});
