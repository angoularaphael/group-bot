'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isMobileFr, normalizePhone } = require('../lib/phones');

test('garde uniquement 06 / 07 / 336 / 337', () => {
  assert.equal(isMobileFr('0612345678'), true);
  assert.equal(isMobileFr('0712345678'), true);
  assert.equal(isMobileFr('33612345678'), true);
  assert.equal(isMobileFr('33712345678'), true);
  assert.equal(isMobileFr('612345678'), true);
});

test('exclut les fixes 05 / 335 et les autres', () => {
  assert.equal(isMobileFr('0561234567'), false);
  assert.equal(isMobileFr('33561234567'), false);
  assert.equal(isMobileFr('561234567'), false);
  assert.equal(isMobileFr('0145678901'), false);
  assert.equal(isMobileFr('0939036748'), false);
  assert.equal(normalizePhone('0561234567'), '33561234567');
});
