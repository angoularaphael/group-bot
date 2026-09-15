'use strict';

const { normalizePhone } = require('./phones');

function isCommandAuthorized({
  fromMe = false,
  senderPhone = '',
  botPhone = '',
  extraPhones = [],
  mandatoryPhone = '',
} = {}) {
  if (fromMe) return true;
  const sender = normalizePhone(senderPhone);
  if (!sender) return false;
  const bot = normalizePhone(botPhone);
  if (bot && sender === bot) return true;
  const allowed = new Set(
    [mandatoryPhone, ...extraPhones].map(normalizePhone).filter(Boolean)
  );
  return allowed.has(sender);
}

function authorizedPhonesList({ mandatoryPhone = '', botPhone = '', extraPhones = [] } = {}) {
  const extra = (extraPhones || [])
    .map(normalizePhone)
    .filter((p) => p && p !== normalizePhone(mandatoryPhone) && p !== normalizePhone(botPhone));
  return [...new Set([normalizePhone(mandatoryPhone), normalizePhone(botPhone), ...extra].filter(Boolean))];
}

module.exports = { isCommandAuthorized, authorizedPhonesList };
