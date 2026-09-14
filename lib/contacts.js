'use strict';

const fs = require('fs');
const path = require('path');
const { normalizePhone, isValidPhoneDigits } = require('./phones');
const { isBlocked, loadUsed } = require('./used');
const { isTestAddMode } = require('./mode');

const TEST_NUMBERS = [
  { nom: 'Test', prenom: 'Un', ville: 'test', telephone: '0762641473' },
  { nom: 'Test', prenom: 'Deux', ville: 'test', telephone: '0744977766' },
  { nom: 'Test', prenom: 'Trois', ville: 'test', telephone: '0774865543' },
];

let cachedProd = null;

function bdDir() {
  if (process.env.BD_TRIEE_DIR) return path.resolve(process.env.BD_TRIEE_DIR);
  const { dataDir } = require('./paths');
  const hosted = path.join(dataDir(), 'bd-triee');
  const local = path.join(__dirname, '..', '..', 'bd triee');
  if (fs.existsSync(hosted)) return hosted;
  if (fs.existsSync(local)) return local;
  return hosted;
}

function toContact(row, source) {
  const phone = normalizePhone(row.telephone);
  if (!isValidPhoneDigits(phone)) return null;
  return {
    nom: String(row.nom || '').trim(),
    prenom: String(row.prenom || '').trim(),
    ville: String(row.ville || '').trim(),
    email: String(row.email || '').trim(),
    telephone: phone,
    source: source || '',
  };
}

function parseLine(line, headerIndex) {
  const parts = String(line || '').split(';');
  if (parts.length < 4) return null;
  return {
    nom: parts[headerIndex.nom] || '',
    prenom: parts[headerIndex.prenom] || '',
    ville: parts[headerIndex.ville] || '',
    telephone: parts[headerIndex.telephone] || '',
    email: parts[headerIndex.email] || '',
  };
}

function headerIndexFromLine(line) {
  const cols = String(line || '')
    .split(';')
    .map((c) => c.trim().toLowerCase());
  const idx = (name, fallback) => {
    const i = cols.indexOf(name);
    return i >= 0 ? i : fallback;
  };
  return {
    nom: idx('nom', 0),
    prenom: idx('prenom', 1),
    ville: idx('ville', 2),
    telephone: idx('telephone', 3),
    email: idx('email', 4),
  };
}

function loadProdContacts() {
  if (cachedProd) return cachedProd;
  const dir = bdDir();
  if (!fs.existsSync(dir)) {
    throw new Error(`Dossier bd triee introuvable : ${dir}`);
  }
  const files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.txt'));
  const byPhone = new Map();
  for (const file of files) {
    const raw = fs.readFileSync(path.join(dir, file), 'utf8');
    const lines = raw.split(/\r?\n/).filter((l) => l.trim());
    if (!lines.length) continue;
    const header = headerIndexFromLine(lines[0]);
    const start = /telephone/i.test(lines[0]) ? 1 : 0;
    for (let i = start; i < lines.length; i++) {
      const parsed = parseLine(lines[i], header);
      if (!parsed) continue;
      const contact = toContact(parsed, file);
      if (!contact) continue;
      if (!byPhone.has(contact.telephone)) byPhone.set(contact.telephone, contact);
    }
  }
  cachedProd = [...byPhone.values()];
  return cachedProd;
}

function testContacts() {
  return TEST_NUMBERS.map((row) => toContact(row, 'test')).filter(Boolean);
}

function allContactsForAdd() {
  return isTestAddMode() ? testContacts() : loadProdContacts();
}

function displayName(contact) {
  return `${contact.prenom || ''} ${contact.nom || ''}`.trim() || contact.telephone;
}

function pickUnused(count, extraSkip = new Set()) {
  const n = Math.max(0, parseInt(count, 10) || 0);
  const state = loadUsed();
  const skip = new Set(
    [...extraSkip].map((p) => normalizePhone(p)).filter(Boolean)
  );
  const picked = [];
  for (const contact of allContactsForAdd()) {
    if (picked.length >= n) break;
    if (skip.has(contact.telephone)) continue;
    if (isBlocked(contact.telephone, state)) continue;
    picked.push(contact);
    skip.add(contact.telephone);
  }
  return picked;
}

function poolStats() {
  const pool = allContactsForAdd();
  const state = loadUsed();
  const available = pool.filter((c) => !isBlocked(c.telephone, state)).length;
  return {
    mode: isTestAddMode() ? 'test' : 'prod',
    pool: pool.length,
    available,
    usedInPool: pool.length - available,
    bdDir: bdDir(),
  };
}

function reloadProdCache() {
  cachedProd = null;
  return loadProdContacts().length;
}

module.exports = {
  TEST_NUMBERS,
  bdDir,
  loadProdContacts,
  testContacts,
  allContactsForAdd,
  displayName,
  pickUnused,
  poolStats,
  reloadProdCache,
};
