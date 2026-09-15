'use strict';

const fs = require('fs');
const path = require('path');
const { normalizePhone, isValidPhoneDigits, phoneToJid } = require('./phones');
const { isBlocked, isContactSaved, loadUsed } = require('./used');
const { isTestAddMode } = require('./mode');

const TEST_NUMBERS = [
  { nom: 'Test', prenom: 'Un', ville: 'test', telephone: '0762641473' },
  { nom: 'Test', prenom: 'Deux', ville: 'test', telephone: '0744977766' },
  { nom: 'Test', prenom: 'Trois', ville: 'test', telephone: '0774865543' },
  { nom: 'Test', prenom: 'Quatre', ville: 'test', telephone: '0767919166' },
  { nom: 'Test', prenom: 'Cinq', ville: 'test', telephone: '0684698028' },
];

let cachedProd = null;

function isBdFileName(name) {
  return /\.(txt|csv)$/i.test(String(name || ''));
}

function dirHasTxt(dir) {
  try {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
    return fs.readdirSync(dir).some((f) => isBdFileName(f));
  } catch (e) {
    return false;
  }
}

function skipWalkName(name) {
  return /^(auth_info_baileys|node_modules|\.git|group-bot-app)$/i.test(name);
}

function walkBdHits(root, depth, maxDepth, out) {
  if (!root || depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (e) {
    return;
  }
  const txt = entries.filter((e) => e.isFile() && isBdFileName(e.name)).length;
  if (txt) out.push({ dir: root, txt });
  for (const e of entries) {
    if (!e.isDirectory() || skipWalkName(e.name)) continue;
    walkBdHits(path.join(root, e.name), depth + 1, maxDepth, out);
  }
}

function bdCandidates() {
  const { dataDir } = require('./paths');
  const data = dataDir();
  const envRaw = String(process.env.BD_TRIEE_DIR || '').trim();
  const env = envRaw ? path.resolve(envRaw) : '';
  const hyphen = env ? env.replace(/bd triee/gi, 'bd-triee') : '';
  const appRoot = path.join(__dirname, '..');
  return [...new Set([
    env,
    hyphen,
    data,
    path.join(data, 'bd-triee'),
    path.join(data, 'bd triee'),
    path.join(appRoot, 'data', 'bd-triee'),
    path.join(appRoot, 'bd-triee'),
    path.join(appRoot, 'bd triee'),
    path.join(appRoot, '..', 'bd-triee'),
    path.join(appRoot, '..', 'bd triee'),
    path.join(appRoot, '..', '..', 'bd-triee'),
    path.join(appRoot, '..', '..', 'bd triee'),
    '/home/container/data',
    '/home/container/data/bd-triee',
    '/home/container/bd-triee',
    '/home/container/bd triee',
  ].filter(Boolean))];
}

function discoverBdDirs() {
  const { dataDir } = require('./paths');
  const data = dataDir();
  const prefer = [];
  walkBdHits(data, 0, 4, prefer);
  if (prefer.length) {
    prefer.sort((a, b) => b.txt - a.txt || a.dir.localeCompare(b.dir));
    return prefer;
  }
  const hits = [];
  const seen = new Set([path.resolve(data)]);
  for (const root of bdCandidates()) {
    const key = path.resolve(root);
    if (seen.has(key)) continue;
    seen.add(key);
    walkBdHits(key, 0, 3, hits);
  }
  hits.sort((a, b) => b.txt - a.txt || a.dir.localeCompare(b.dir));
  return hits;
}

function bdDir() {
  const found = discoverBdDirs();
  if (found.length) return found[0].dir;
  const envRaw = String(process.env.BD_TRIEE_DIR || '').trim();
  if (envRaw) return path.resolve(envRaw.replace(/bd triee/gi, 'bd-triee'));
  return path.join(require('./paths').dataDir(), 'bd-triee');
}

function listNames(dir) {
  try {
    return fs.readdirSync(dir).slice(0, 40).join(', ') || '(vide)';
  } catch (e) {
    return `(inaccessible : ${e.message})`;
  }
}

function missingBdMessage() {
  const data = require('./paths').dataDir();
  return [
    'Dossier bd-triee introuvable (aucun .txt).',
    `data = ${data} → ${listNames(data)}`,
    `Cherché : ${bdCandidates().join(' | ')}`,
  ].join(' ');
}

function collectTxtFiles(dir, depth, maxDepth, files) {
  if (!dir || depth > maxDepth) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && isBdFileName(e.name)) files.push(full);
    else if (e.isDirectory() && !skipWalkName(e.name)) collectTxtFiles(full, depth + 1, maxDepth, files);
  }
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
  const found = discoverBdDirs();
  if (!found.length) {
    throw new Error(missingBdMessage());
  }
  const files = [];
  for (const hit of found) collectTxtFiles(hit.dir, 0, 2, files);
  const uniqueFiles = [...new Set(files)];
  const byPhone = new Map();
  for (const filePath of uniqueFiles) {
    const file = path.basename(filePath);
    let raw;
    try {
      raw = fs.readFileSync(filePath, 'utf8');
    } catch (e) {
      console.warn('[BOT] BD fichier illisible', file, e.message);
      continue;
    }
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
  console.log(`[BOT] BD ${cachedProd.length} numéros depuis ${found[0].dir} (${uniqueFiles.length} fichier(s))`);
  return cachedProd;
}

function testContacts() {
  return TEST_NUMBERS.map((row) => {
    let telephone = String(row.telephone || '').replace(/\D/g, '');
    if (telephone.startsWith('0') && telephone.length === 9) telephone = `${telephone}0`;
    return toContact({ ...row, telephone }, 'test');
  }).filter(Boolean);
}

function displayFrPhone(phone) {
  const d = normalizePhone(phone);
  if (!d) return '';
  return d.startsWith('33') ? `0${d.slice(2)}` : d;
}

function labeledTestContacts() {
  return testContacts().map((c, i) => ({
    ...c,
    label: `test${i + 1}`,
    jid: phoneToJid(c.telephone),
  }));
}

function testNumbersLabel() {
  return labeledTestContacts()
    .map((c) => `${c.label} ${displayFrPhone(c.telephone)}`)
    .join(' · ');
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

function withJid(contact) {
  return {
    ...contact,
    jid: phoneToJid(contact.telephone),
  };
}

function pickUnsaved(count, extraSkip = new Set()) {
  const n = Math.max(0, parseInt(count, 10) || 0);
  const state = loadUsed();
  const skip = new Set(
    [...extraSkip].map((p) => normalizePhone(p)).filter(Boolean)
  );
  const picked = [];
  for (const contact of loadProdContacts()) {
    if (picked.length >= n) break;
    if (skip.has(contact.telephone)) continue;
    if (isContactSaved(contact.telephone, state)) continue;
    picked.push(withJid(contact));
    skip.add(contact.telephone);
  }
  return picked;
}

function pickSavedUnsent(count) {
  const n = Math.max(0, parseInt(count, 10) || 0);
  const state = loadUsed();
  const byPhone = new Map(loadProdContacts().map((c) => [c.telephone, c]));
  const rows = Object.values(state.phones || {})
    .filter((p) => p && p.status === 'saved')
    .sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')));
  const picked = [];
  for (const row of rows) {
    if (picked.length >= n) break;
    const phone = normalizePhone(row.phone || row.telephone);
    if (!phone) continue;
    const fromBd = byPhone.get(phone);
    picked.push(
      withJid({
        nom: fromBd?.nom || row.nom || '',
        prenom: fromBd?.prenom || row.prenom || '',
        ville: fromBd?.ville || row.ville || '',
        email: fromBd?.email || row.email || '',
        telephone: phone,
        source: fromBd?.source || 'saved',
      })
    );
  }
  return picked;
}

function poolStats() {
  const pool = allContactsForAdd();
  const state = loadUsed();
  const available = pool.filter((c) => !isBlocked(c.telephone, state)).length;
  const unsaved = isTestAddMode()
    ? 0
    : loadProdContacts().filter((c) => !isContactSaved(c.telephone, state)).length;
  return {
    mode: isTestAddMode() ? 'test' : 'prod',
    pool: pool.length,
    available,
    usedInPool: pool.length - available,
    unsaved,
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
  bdCandidates,
  dirHasTxt,
  discoverBdDirs,
  loadProdContacts,
  testContacts,
  labeledTestContacts,
  displayFrPhone,
  allContactsForAdd,
  displayName,
  pickUnused,
  pickUnsaved,
  pickSavedUnsent,
  poolStats,
  reloadProdCache,
  testNumbersLabel,
};
