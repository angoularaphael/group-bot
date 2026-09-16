'use strict';

const fs = require('fs');
const { normalizePhone } = require('./phones');
const { dataFile } = require('./paths');

function usedFile() {
  return dataFile('used.json');
}

function emptyState() {
  return { phones: {}, groups: {} };
}

function loadUsed() {
  try {
    const file = usedFile();
    if (!fs.existsSync(file)) return emptyState();
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      phones: parsed.phones && typeof parsed.phones === 'object' ? parsed.phones : {},
      groups: parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
    };
  } catch (e) {
    console.warn('[used] lecture:', e.message);
    return emptyState();
  }
}

function saveUsed(state) {
  fs.writeFileSync(usedFile(), JSON.stringify(state, null, 2), 'utf8');
}

function seedSavedCandidates() {
  const path = require('path');
  if (process.env.SEED_SAVED_FILE) return [process.env.SEED_SAVED_FILE];
  return [
    dataFile('seed-saved.json'),
    path.join(__dirname, '..', 'data', 'seed-saved.json'),
  ];
}

function applySeedSaved() {
  const file = seedSavedCandidates().find((f) => f && fs.existsSync(f));
  if (!file) return 0;
  let seed;
  try {
    seed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn('[used] seed-saved:', e.message);
    return 0;
  }
  const rows = Array.isArray(seed?.phones) ? seed.phones : [];
  if (!rows.length) return 0;
  const state = loadUsed();
  const at = seed.until?.at || new Date().toISOString();
  let n = 0;
  for (const row of rows) {
    const key = normalizePhone(row.telephone || row.phone);
    if (!key) continue;
    const existing = state.phones[key];
    const want = row.status === 'wa_sent' ? 'wa_sent' : 'saved';
    if (existing?.status === 'wa_sent') continue;
    if (existing?.status === 'saved' && want === 'saved') continue;
    state.phones[key] = {
      ...(existing || {}),
      phone: key,
      status: want,
      nom: row.nom || existing?.nom || '',
      prenom: row.prenom || existing?.prenom || '',
      ville: row.ville || existing?.ville || '',
      source: want === 'wa_sent' ? 'seed-wa-sent' : 'seed-saved',
      at: existing?.at || at,
    };
    n += 1;
  }
  if (n) saveUsed(state);
  const until = seed.until || {};
  const who = [until.prenom, until.nom].filter(Boolean).join(' ') || until.telephone || '';
  console.log(
    `[BOT] reprise .savecon : ${n} nouveau(x) marqueur(s), ${rows.length} déjà sur le tel jusqu’à ${who} (#${until.index || rows.length})`
  );
  return n;
}

function isBlocked(phone, state = loadUsed()) {
  const key = normalizePhone(phone);
  if (!key) return true;
  const row = state.phones[key];
  if (!row) return false;
  return row.status === 'added' || row.status === 'not_whatsapp';
}

function markPhone(phone, payload) {
  const key = normalizePhone(phone);
  if (!key) return;
  const state = loadUsed();
  state.phones[key] = {
    ...(state.phones[key] || {}),
    phone: key,
    ...payload,
    at: new Date().toISOString(),
  };
  if (payload.status === 'added' && payload.groupId) {
    const g = state.groups[payload.groupId] || {
      name: payload.groupName || '',
      added: [],
    };
    if (!g.added.includes(key)) g.added.push(key);
    if (payload.groupName) g.name = payload.groupName;
    state.groups[payload.groupId] = g;
  }
  saveUsed(state);
  return state;
}

function rememberGroup(groupId, info) {
  if (!groupId) return;
  const state = loadUsed();
  state.groups[groupId] = {
    ...(state.groups[groupId] || { added: [] }),
    ...info,
    id: groupId,
  };
  saveUsed(state);
  return state;
}

function stats(state = loadUsed()) {
  const phones = Object.values(state.phones);
  return {
    added: phones.filter((p) => p.status === 'added').length,
    saved: phones.filter((p) => p.status === 'saved').length,
    waSent: phones.filter((p) => p.status === 'wa_sent').length,
    notWhatsapp: phones.filter((p) => p.status === 'not_whatsapp').length,
    groups: Object.keys(state.groups).length,
  };
}

function isContactSaved(phone, state = loadUsed()) {
  const key = normalizePhone(phone);
  if (!key) return true;
  const row = state.phones[key];
  if (!row) return false;
  return row.status === 'saved' || row.status === 'wa_sent';
}

function isWaSent(phone, state = loadUsed()) {
  const key = normalizePhone(phone);
  const row = state.phones[key];
  return Boolean(row && row.status === 'wa_sent');
}

function unmarkPhone(phone) {
  const key = normalizePhone(phone);
  if (!key) return;
  const state = loadUsed();
  if (!state.phones[key]) return;
  delete state.phones[key];
  for (const g of Object.values(state.groups)) {
    if (Array.isArray(g.added)) g.added = g.added.filter((p) => p !== key);
  }
  saveUsed(state);
}

function clearPhoneMarkers() {
  const state = loadUsed();
  const n = Object.keys(state.phones || {}).length;
  state.phones = {};
  for (const g of Object.values(state.groups || {})) {
    if (Array.isArray(g.added)) g.added = [];
  }
  saveUsed(state);
  return n;
}

module.exports = {
  loadUsed,
  saveUsed,
  isBlocked,
  isContactSaved,
  isWaSent,
  markPhone,
  unmarkPhone,
  clearPhoneMarkers,
  rememberGroup,
  stats,
  applySeedSaved,
};
