'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  addStatusCode,
  isAddSuccess,
  shouldTryNextJid,
  shouldInviteAfterFail,
} = require('../lib/add-status');

test('451 et 403 : essayer un autre JID puis inviter', () => {
  assert.equal(addStatusCode({ status: '451' }), 451);
  assert.equal(isAddSuccess(200), true);
  assert.equal(isAddSuccess(451), false);
  assert.equal(shouldTryNextJid(451), true);
  assert.equal(shouldTryNextJid(403), true);
  assert.equal(shouldInviteAfterFail(451), true);
  assert.equal(shouldInviteAfterFail(403), true);
  assert.equal(shouldInviteAfterFail(409), false);
});
