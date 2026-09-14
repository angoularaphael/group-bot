'use strict';

const fs = require('fs');
const { dataFile } = require('./paths');

function modeFile() {
  return dataFile('mode.json');
}

function envMode() {
  const v = String(process.env.ADD_MODE || '').trim().toLowerCase();
  if (v === 'prod' || v === 'production') return 'prod';
  if (v === 'test') return 'test';
  return null;
}

function readStoredMode() {
  try {
    if (!fs.existsSync(modeFile())) return null;
    const parsed = JSON.parse(fs.readFileSync(modeFile(), 'utf8'));
    const m = String(parsed.addMode || parsed.mode || '').trim().toLowerCase();
    if (m === 'prod' || m === 'production') return 'prod';
    if (m === 'test') return 'test';
  } catch (e) {
    console.warn('[mode] lecture:', e.message);
  }
  return null;
}

/** Fichier data/mode.json prioritaire (bascule « passe en prod »), sinon ADD_MODE, sinon test. */
function getAddMode() {
  return readStoredMode() || envMode() || 'test';
}

function isTestAddMode() {
  return getAddMode() === 'test';
}

function setAddMode(mode) {
  const next = String(mode || '').trim().toLowerCase() === 'prod' ? 'prod' : 'test';
  fs.writeFileSync(modeFile(), JSON.stringify({ addMode: next, updatedAt: new Date().toISOString() }, null, 2));
  return next;
}

function modeLabel() {
  return isTestAddMode() ? 'TEST' : 'PROD';
}

module.exports = {
  getAddMode,
  isTestAddMode,
  setAddMode,
  modeLabel,
};
