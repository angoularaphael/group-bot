'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

test('la page QR pointe vers le serveur Bothosting et poll /api/status', () => {
  const html = fs.readFileSync(path.join(__dirname, '../public/index.html'), 'utf8');
  assert.match(html, /prem-eu2\.bot-hosting\.net:21774/);
  assert.match(html, /\/api\/status/);
  assert.match(html, /\/api\/start/);
  assert.match(html, /Appareils connectés/);
});

test('le bot sert public/index.html et le port 21774', () => {
  const src = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  assert.match(src, /public['"], 'index\.html'|public[\\/]index\.html|public', 'index\.html/);
  assert.match(src, /21774/);
  assert.match(src, /prem-eu2\.bot-hosting\.net/);
});
