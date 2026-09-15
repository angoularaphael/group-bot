'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const {
  isAdminParticipant,
  parsePromotePhone,
  kickTargets,
  chunk,
} = require('../lib/group-mod');

test('.kickall et .promote sont dans le menu et les commandes', () => {
  const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.match(src, /'\.kickall'/);
  assert.match(src, /'\.promote'/);
  assert.match(src, /'\.reset'/);
  assert.match(src, /'\.savecon'/);
  assert.match(src, /'\.sendtest'/);
  assert.match(src, /'\.sendfull'/);
  assert.match(src, /handleKickall/);
  assert.match(src, /handlePromote/);
  assert.match(src, /handleSavecon/);
  assert.match(src, /handleSendtest/);
  assert.match(src, /handleSendfull/);
  assert.match(src, /groupParticipantsUpdate\(groupId, batch, 'remove'\)/);
  assert.match(src, /groupLeave\(groupId\)/);
  assert.match(src, /groupParticipantsUpdate\(groupId, toPromote, 'promote'\)/);
});

test('kickall ne touche pas les admins ni le bot', () => {
  const kicked = kickTargets(
    [
      { id: '111@s.whatsapp.net', admin: null },
      { id: '222@s.whatsapp.net', admin: 'admin' },
      { id: '333@lid', admin: 'superadmin' },
      { id: '444@s.whatsapp.net' },
      { id: 'bot@s.whatsapp.net' },
    ],
    { botJid: 'bot@s.whatsapp.net', senderJids: ['111@s.whatsapp.net'] }
  );
  assert.deepEqual(kicked, ['444@s.whatsapp.net']);
});

test('promote lit un numéro FR', () => {
  assert.equal(parsePromotePhone('.promote 0762641473'), '33762641473');
  assert.equal(parsePromotePhone('.KICKALL'), '');
  assert.equal(parsePromotePhone('.promote'), '');
  assert.equal(isAdminParticipant({ admin: 'superadmin' }), true);
  assert.equal(isAdminParticipant({ admin: null }), false);
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
});

test('numéros test nommés test1…test5', () => {
  const { labeledTestContacts } = require('../lib/contacts');
  const rows = labeledTestContacts();
  assert.equal(rows.length, 5);
  assert.equal(rows[0].label, 'test1');
  assert.equal(rows[4].label, 'test5');
  assert.equal(rows[0].telephone, '33762641473');
  assert.equal(rows[0].jid, '33762641473@s.whatsapp.net');
});
