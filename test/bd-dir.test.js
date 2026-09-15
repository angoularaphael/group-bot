'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

test('trouve bd-triee même si l’env pointe vers « bd triee »', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bd-dir-'));
  const wrong = path.join(root, 'bd triee');
  const right = path.join(root, 'bd-triee');
  fs.mkdirSync(right);
  fs.writeFileSync(
    path.join(right, 'ville.txt'),
    'nom;prenom;ville;telephone\ndurand;marie;toulouse;0611111111\n',
    'utf8'
  );
  process.env.BOT_DATA_DIR = root;
  process.env.BD_TRIEE_DIR = wrong;
  for (const rel of ['../lib/paths', '../lib/contacts']) {
    delete require.cache[require.resolve(rel)];
  }
  const { bdDir, loadProdContacts, reloadProdCache } = require('../lib/contacts');
  assert.equal(bdDir(), right);
  reloadProdCache();
  const rows = loadProdContacts();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].prenom.toLowerCase(), 'marie');
});
