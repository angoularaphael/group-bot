'use strict';

const fs = require('fs');
const path = require('path');

function dataDir() {
  const raw = process.env.BOT_DATA_DIR || path.join(__dirname, '..', 'data');
  const dir = path.resolve(raw);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function dataFile(name) {
  return path.join(dataDir(), name);
}

module.exports = { dataDir, dataFile };
