'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'group-bot-book-'));
process.env.BOT_DATA_DIR = tmp;

for (const rel of ['../lib/paths', '../lib/phones', '../lib/used', '../lib/wa-book']) {
  const id = require.resolve(rel);
  delete require.cache[id];
}

const { ingestContacts, summarizeBook, backfillSavedFromBook } = require('../lib/wa-book');
const { isContactSaved, stats } = require('../lib/used');

test('carnet : compte les numéros BD sauvés sur le téléphone', () => {
  ingestContacts([
    { id: '33611111111@s.whatsapp.net', name: 'Marie Dupont' },
    { id: '33622222222@s.whatsapp.net', name: 'Jean Martin' },
    { id: '33699999999@s.whatsapp.net', name: 'Pas dans la BD' },
    { id: '120363@g.us', name: 'un groupe' },
    { id: '33633333333@s.whatsapp.net', notify: 'push only' },
  ]);
  const prod = [
    { telephone: '33611111111', nom: 'Dupont', prenom: 'Marie', ville: 'Toulouse' },
    { telephone: '33622222222', nom: 'Martin', prenom: 'Jean', ville: 'Balma' },
    { telephone: '33644444444', nom: 'Absent', prenom: 'Tel', ville: 'Blagnac' },
  ];
  const s = summarizeBook(prod);
  assert.equal(s.inBdNamed, 2);
  assert.equal(s.named, 3);
  assert.equal(s.bdSize, 3);
  const n = backfillSavedFromBook(prod);
  assert.equal(n, 2);
  assert.equal(isContactSaved('33611111111'), true);
  assert.equal(isContactSaved('33644444444'), false);
  assert.equal(stats().saved, 2);
});
