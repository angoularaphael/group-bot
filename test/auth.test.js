'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isCommandAuthorized, authorizedPhonesList } = require('../lib/auth');

test('le numéro du bot est autorisé sans être dans la liste', () => {
  assert.equal(
    isCommandAuthorized({
      fromMe: false,
      senderPhone: '0611223344',
      botPhone: '0611223344',
      extraPhones: [],
      mandatoryPhone: '33762641473',
    }),
    true
  );
  assert.equal(
    isCommandAuthorized({
      fromMe: true,
      senderPhone: '',
      botPhone: '0611223344',
      extraPhones: [],
      mandatoryPhone: '33762641473',
    }),
    true
  );
  assert.equal(
    isCommandAuthorized({
      fromMe: false,
      senderPhone: '0699999999',
      botPhone: '0611223344',
      extraPhones: [],
      mandatoryPhone: '33762641473',
    }),
    false
  );
});

test('la liste d’admins inclut le numéro connecté au bot', () => {
  assert.deepEqual(
    authorizedPhonesList({
      mandatoryPhone: '33762641473',
      botPhone: '0611223344',
      extraPhones: ['0744977766'],
    }),
    ['33762641473', '33611223344', '33744977766']
  );
});
