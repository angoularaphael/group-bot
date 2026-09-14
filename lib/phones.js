'use strict';

function digitsOnly(input) {
  return String(input || '')
    .split('@')[0]
    .split(':')[0]
    .replace(/\D/g, '');
}

/** FR → international (33…). 0762641473 / 762641473 / 33762641473 → 33762641473 */
function normalizePhone(input) {
  let d = digitsOnly(input);
  if (!d) return '';
  if (d.startsWith('00')) d = d.slice(2);
  if (d.startsWith('0') && d.length === 10) d = '33' + d.slice(1);
  else if (d.length === 9) d = '33' + d;
  return d;
}

function isValidPhoneDigits(d) {
  const n = normalizePhone(d);
  return n.length >= 10 && n.length <= 15;
}

function phoneToJid(phone) {
  const p = normalizePhone(phone);
  return p ? `${p}@s.whatsapp.net` : '';
}

function isGroupJid(jid) {
  return String(jid || '').endsWith('@g.us');
}

function isPnJid(jid) {
  const s = String(jid || '');
  return s.includes('@s.whatsapp.net') || s.endsWith('@c.us');
}

function isLidJid(jid) {
  return String(jid || '').includes('@lid');
}

function jidBare(jid) {
  return String(jid || '').split('@')[0].split(':')[0];
}

module.exports = {
  digitsOnly,
  normalizePhone,
  isValidPhoneDigits,
  phoneToJid,
  isGroupJid,
  isPnJid,
  isLidJid,
  jidBare,
};
