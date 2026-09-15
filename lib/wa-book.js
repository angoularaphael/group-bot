'use strict';

const fs = require('fs');
const { normalizePhone, isValidPhoneDigits, isGroupJid, isPnJid } = require('./phones');
const { dataFile } = require('./paths');
const { markPhone, isContactSaved, isWaSent, loadUsed, stats } = require('./used');

function bookFile() {
  return dataFile('wa-book.json');
}

function emptyBook() {
  return { byPhone: {}, updatedAt: '' };
}

let cached = null;
let saveTimer = null;

function loadBook() {
  if (cached) return cached;
  try {
    if (!fs.existsSync(bookFile())) {
      cached = emptyBook();
      return cached;
    }
    const parsed = JSON.parse(fs.readFileSync(bookFile(), 'utf8'));
    cached = {
      byPhone: parsed.byPhone && typeof parsed.byPhone === 'object' ? parsed.byPhone : {},
      updatedAt: parsed.updatedAt || '',
    };
    return cached;
  } catch (e) {
    console.warn('[wa-book] lecture:', e.message);
    cached = emptyBook();
    return cached;
  }
}

function persistNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  const book = loadBook();
  book.updatedAt = new Date().toISOString();
  try {
    fs.writeFileSync(bookFile(), JSON.stringify(book), 'utf8');
  } catch (e) {
    console.warn('[wa-book] écriture:', e.message);
  }
}

function persistSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    persistNow();
  }, 500);
  if (typeof saveTimer.unref === 'function') saveTimer.unref();
}

function phoneFromContact(c, resolvePhone) {
  if (!c) return '';
  const direct = normalizePhone(c.phoneNumber || c.telephone || '');
  if (direct && isValidPhoneDigits(direct)) return direct;
  if (c.id && isPnJid(c.id)) {
    const fromId = normalizePhone(c.id);
    if (fromId && isValidPhoneDigits(fromId)) return fromId;
  }
  if (typeof resolvePhone === 'function') {
    const mapped = normalizePhone(resolvePhone(c.id || c.lid || ''));
    if (mapped && isValidPhoneDigits(mapped)) return mapped;
  }
  return '';
}

function ingestContacts(list, resolvePhone) {
  const book = loadBook();
  let added = 0;
  for (const c of list || []) {
    if (!c) continue;
    if (c.id && isGroupJid(c.id)) continue;
    const phone = phoneFromContact(c, resolvePhone);
    if (!phone) continue;
    const prev = book.byPhone[phone] || {};
    const name = String(c.name || prev.name || '').trim();
    const notify = String(c.notify || prev.notify || '').trim();
    book.byPhone[phone] = {
      phone,
      jid: c.id || prev.jid || '',
      name,
      notify,
      saved: Boolean(name),
      at: new Date().toISOString(),
    };
    added += 1;
  }
  if (added) persistSoon();
  return added;
}

function summarizeBook(prodContacts) {
  persistNow();
  const book = loadBook();
  const bd = new Set((prodContacts || []).map((c) => c.telephone).filter(Boolean));
  const rows = Object.values(book.byPhone || {});
  let named = 0;
  let inBd = 0;
  let inBdNamed = 0;
  const samples = [];
  for (const row of rows) {
    if (row.name) named += 1;
    if (!bd.has(row.phone)) continue;
    inBd += 1;
    if (row.name) {
      inBdNamed += 1;
      if (samples.length < 8) samples.push(row);
    }
  }
  const used = stats();
  const marked = used.saved + used.waSent;
  return {
    synced: rows.length,
    named,
    inBd,
    inBdNamed,
    bdSize: bd.size,
    marked,
    saved: used.saved,
    waSent: used.waSent,
    samples,
    updatedAt: loadBook().updatedAt || '',
  };
}

function backfillSavedFromBook(prodContacts) {
  persistNow();
  const byPhone = new Map((prodContacts || []).map((c) => [c.telephone, c]));
  const book = loadBook();
  let n = 0;
  for (const [phone, row] of Object.entries(book.byPhone || {})) {
    if (!row?.name) continue;
    const contact = byPhone.get(phone);
    if (!contact) continue;
    if (isContactSaved(phone) || isWaSent(phone)) continue;
    markPhone(phone, {
      status: 'saved',
      nom: contact.nom,
      prenom: contact.prenom,
      ville: contact.ville,
      source: 'phone-sync',
    });
    n += 1;
  }
  return n;
}

function lastSavedMarker() {
  const phones = Object.values(loadUsed().phones || {}).filter(
    (p) => p && (p.status === 'saved' || p.status === 'wa_sent')
  );
  phones.sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
  return phones[0] || null;
}

module.exports = {
  loadBook,
  ingestContacts,
  summarizeBook,
  backfillSavedFromBook,
  lastSavedMarker,
};
