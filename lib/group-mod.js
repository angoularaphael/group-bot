'use strict';

const { normalizePhone, isValidPhoneDigits, jidBare } = require('./phones');

function isAdminParticipant(p) {
  const a = p?.admin;
  return a === 'admin' || a === 'superadmin' || a === true;
}

function parsePromotePhone(text) {
  const rest = String(text || '')
    .replace(/^\.promote\s+/i, '')
    .replace(/@/g, ' ')
    .trim();
  if (!rest) return '';
  const n = normalizePhone(rest);
  return isValidPhoneDigits(n) ? n : '';
}

function samePerson(jidA, jidB) {
  const a = jidBare(jidA);
  const b = jidBare(jidB);
  return Boolean(a && b && a === b);
}

function kickTargets(participants, { botJid: me, senderJids = [] } = {}) {
  const keep = new Set(
    [me, ...senderJids]
      .map((j) => jidBare(j))
      .filter(Boolean)
  );
  return (participants || [])
    .filter((p) => {
      if (isAdminParticipant(p)) return false;
      const id = String(p.id || '');
      if (!id) return false;
      if (keep.has(jidBare(id))) return false;
      return true;
    })
    .map((p) => p.id);
}

function chunk(list, size) {
  const n = Math.max(1, size);
  const out = [];
  for (let i = 0; i < list.length; i += n) out.push(list.slice(i, i + n));
  return out;
}

module.exports = {
  isAdminParticipant,
  parsePromotePhone,
  samePerson,
  kickTargets,
  chunk,
};
