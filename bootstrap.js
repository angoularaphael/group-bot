#!/usr/bin/env node
/**
 * Bot Hosting — copier ce fichier en /home/container/index.js
 * Startup panel : node index.js
 *
 * 1) charge /home/container/.env
 * 2) git clone/pull https://github.com/angoularaphael/group-bot.git
 * 3) npm install
 * 4) lance index.js du bot
 */
'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const GITHUB_REPO_URL =
  process.env.BOT_GITHUB_REPO ||
  process.env.BOT_REPO_URL ||
  'https://github.com/angoularaphael/group-bot.git';
const BRANCH = process.env.BOT_REPO_BRANCH || 'main';
const APP_DIR_NAME = process.env.BOT_APP_DIR || 'group-bot-app';

const ROOT = __dirname;
const ROOT_ENV = path.join(ROOT, '.env');
const APP_DIR = path.join(ROOT, APP_DIR_NAME);
const DATA_DIR = path.join(ROOT, 'data');
const AUTH_DIR = path.join(DATA_DIR, 'auth_info_baileys');
const BD_DIR = path.join(DATA_DIR, 'bd-triee');

const ENV_KEYS = [
  'PORT',
  'SERVER_PORT',
  'BOT_PUBLIC_HOST',
  'MANDATORY_ADMIN_PHONE',
  'BOT_AUTHORIZED_PHONES',
  'ADD_MODE',
  'BD_TRIEE_DIR',
  'BOT_DATA_DIR',
  'WA_AUTH_DIR',
  'ADD_BATCH',
  'ADD_DELAY_MS',
  'SENDTEST_TEXT',
];

function loadRootEnv() {
  if (!fs.existsSync(ROOT_ENV)) {
    console.warn('[group-bot bootstrap] .env manquant à côté de index.js');
    return;
  }
  for (const line of fs.readFileSync(ROOT_ENV, 'utf8').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    let val = trimmed.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] == null || process.env[key] === '') process.env[key] = val;
  }
}

function run(cmd, cwd = ROOT) {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit', env: process.env, shell: true });
}

function resolvePort() {
  const raw = process.env.SERVER_PORT || process.env.PORT || '';
  const port = String(raw).trim();
  if (!/^\d+$/.test(port)) {
    console.error(
      '[group-bot bootstrap] SERVER_PORT ou PORT manquant — ajoutez-le dans /home/container/.env'
    );
    process.exit(1);
  }
  return port;
}

function buildEnv(port) {
  const lines = ['# Auto-generated bootstrap group-bot'];
  lines.push(`PORT=${port}`);
  lines.push(`SERVER_PORT=${port}`);
  for (const key of ENV_KEYS) {
    if (key === 'PORT' || key === 'SERVER_PORT') continue;
    const val = process.env[key];
    if (val != null && val !== '') {
      lines.push(/[\s#]/.test(val) ? `${key}="${String(val).replace(/"/g, '\\"')}"` : `${key}=${val}`);
    }
  }
  if (!lines.some((l) => l.startsWith('BOT_DATA_DIR='))) {
    lines.push(`BOT_DATA_DIR=${DATA_DIR}`);
  }
  if (!lines.some((l) => l.startsWith('WA_AUTH_DIR='))) {
    lines.push(`WA_AUTH_DIR=${AUTH_DIR}`);
  }
  if (!lines.some((l) => l.startsWith('BD_TRIEE_DIR='))) {
    lines.push(`BD_TRIEE_DIR=${BD_DIR}`);
  }
  if (!lines.some((l) => l.startsWith('ADD_MODE='))) {
    lines.push('ADD_MODE=test');
  }
  return `${lines.join('\n')}\n`;
}

function cloneOrUpdate() {
  const gitDir = path.join(APP_DIR, '.git');
  if (!fs.existsSync(gitDir)) {
    if (fs.existsSync(APP_DIR)) fs.rmSync(APP_DIR, { recursive: true, force: true });
    console.log(`[group-bot bootstrap] clone ${GITHUB_REPO_URL} (${BRANCH})`);
    run(`git clone --depth 1 --branch ${BRANCH} ${GITHUB_REPO_URL} "${APP_DIR_NAME}"`);
    return;
  }
  console.log('[group-bot bootstrap] mise à jour repo…');
  try {
    run('git fetch origin', APP_DIR);
    run(`git reset --hard origin/${BRANCH}`, APP_DIR);
  } catch (err) {
    console.warn('[group-bot bootstrap] git update ignoré:', err.message);
  }
}

function syncEnv(port) {
  const dest = path.join(APP_DIR, '.env');
  if (fs.existsSync(ROOT_ENV)) {
    fs.copyFileSync(ROOT_ENV, dest);
    console.log('[group-bot bootstrap] .env copié vers l’app');
    return;
  }
  fs.writeFileSync(dest, buildEnv(port), 'utf8');
  console.log('[group-bot bootstrap] .env généré depuis variables panneau');
}

loadRootEnv();
const BOT_PORT = resolvePort();
process.env.PORT = BOT_PORT;
process.env.SERVER_PORT = process.env.SERVER_PORT || BOT_PORT;
process.env.BOT_DATA_DIR = process.env.BOT_DATA_DIR || DATA_DIR;
process.env.WA_AUTH_DIR = process.env.WA_AUTH_DIR || AUTH_DIR;
process.env.BD_TRIEE_DIR = process.env.BD_TRIEE_DIR || BD_DIR;

fs.mkdirSync(AUTH_DIR, { recursive: true });
fs.mkdirSync(BD_DIR, { recursive: true });
fs.mkdirSync(path.join(DATA_DIR), { recursive: true });

console.log('=== GROUP-BOT — BOTHOSTING ===');
console.log(`repo    ${GITHUB_REPO_URL}#${BRANCH}`);
console.log(`app     ${APP_DIR}`);
console.log(`port    ${BOT_PORT}`);
console.log(`session ${process.env.WA_AUTH_DIR}`);
console.log(`data    ${process.env.BOT_DATA_DIR}`);
console.log(`bd      ${process.env.BD_TRIEE_DIR}`);
console.log(`add     ${process.env.ADD_MODE || 'test'}`);

try {
  const https = require('https');
  https.get('https://api.ipify.org', (res) => {
    let data = '';
    res.on('data', (c) => {
      data += c;
    });
    res.on('end', () => {
      const host = String(process.env.BOT_PUBLIC_HOST || '').trim();
      console.log('\n🌍 ==================================================');
      console.log('🌍 QR / statut bot :');
      if (host) console.log(`🌍   http://${host}:${BOT_PORT}`);
      console.log(`🌍   http://${data.trim()}:${BOT_PORT}`);
      console.log('🌍 ==================================================\n');
    });
  }).on('error', () => {});
} catch {
  /* ignore */
}

cloneOrUpdate();
syncEnv(BOT_PORT);

if (!fs.existsSync(path.join(APP_DIR, 'index.js'))) {
  console.error('[group-bot bootstrap] index.js introuvable après clone');
  process.exit(1);
}

run('npm install --omit=dev', APP_DIR);

console.log('[group-bot bootstrap] démarrage…');
process.chdir(APP_DIR);
require(path.join(APP_DIR, 'index.js'));
