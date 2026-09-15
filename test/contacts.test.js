'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'group-bot-used-'));
process.env.BOT_DATA_DIR = tmp;
process.env.ADD_MODE = 'test';

const { testContacts, testNumbersLabel, TEST_NUMBERS } = require('../lib/contacts');
const { markPhone, isBlocked, clearPhoneMarkers, loadUsed } = require('../lib/used');

test('pool test inclut 0767919166 et 068498028', () => {
  const phones = TEST_NUMBERS.map((r) => r.telephone);
  assert.ok(phones.includes('0767919166'));
  assert.ok(phones.includes('068498028'));
  const contacts = testContacts();
  const tels = contacts.map((c) => c.telephone);
  assert.ok(tels.includes('33767919166'));
  assert.ok(tels.includes('33684980280'));
  assert.equal(contacts.length, 5);
  assert.match(testNumbersLabel(), /0767919166/);
  assert.match(testNumbersLabel(), /0684980280/);
});

test('clearPhoneMarkers débloque les numéros', () => {
  markPhone('0767919166', { status: 'added', groupId: 'g@g.us' });
  assert.equal(isBlocked('0767919166'), true);
  const n = clearPhoneMarkers();
  assert.equal(n, 1);
  assert.equal(isBlocked('0767919166'), false);
  assert.equal(Object.keys(loadUsed().phones).length, 0);
});
