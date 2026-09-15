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
    notWhatsapp: phones.filter((p) => p.status === 'not_whatsapp').length,
    groups: Object.keys(state.groups).length,
  };
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
  markPhone,
  unmarkPhone,
  clearPhoneMarkers,
  rememberGroup,
  stats,
};
