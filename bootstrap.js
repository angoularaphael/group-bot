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
  'SAVE_BATCH',
  'SAVE_DELAY_MS',
  'SMS_DELAY_MS',
  'PROGRESS_EVERY_MS',
  'SMS_GATEWAY_URL',
  'SMS_GATEWAY_SECRET',
  'SMS_GATEWAY_EMAIL',
  'SMS_GATEWAY_PASSWORD',
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
    lines.push('ADD_MODE=prod');
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

function dirHasTxt(dir) {
  try {
    if (!dir || !fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return false;
    return fs.readdirSync(dir).some((f) => f.toLowerCase().endsWith('.txt'));
  } catch (e) {
    return false;
  }
}

function firstBdWithFiles() {
  const opts = [
    process.env.BD_TRIEE_DIR,
    DATA_DIR,
    BD_DIR,
    path.join(ROOT, 'bd-triee'),
    path.join(ROOT, 'bd triee'),
    path.join(ROOT, 'data', 'bd-triee'),
    '/home/container/data',
    '/home/container/bd-triee',
    '/home/container/bd triee',
    '/home/container/data/bd-triee',
  ];
  const seen = new Set();
  for (const raw of opts) {
    if (!raw) continue;
    const dir = path.resolve(raw);
    if (seen.has(dir)) continue;
    seen.add(dir);
    if (dirHasTxt(dir)) return dir;
    try {
      const kids = fs.readdirSync(dir, { withFileTypes: true });
      for (const k of kids) {
        if (!k.isDirectory()) continue;
        const sub = path.join(dir, k.name);
        if (dirHasTxt(sub)) return sub;
      }
    } catch (e) {
      /* ignore */
    }
  }
  return BD_DIR;
}

function patchEnvFile(file, updates) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  for (const [key, val] of Object.entries(updates)) {
    const escaped = /[\s#]/.test(val) ? `"${String(val).replace(/"/g, '\\"')}"` : val;
    const line = `${key}=${escaped}`;
    const re = new RegExp(`^${key}=.*$`, 'm');
    if (re.test(text)) text = text.replace(re, line);
    else text += `${text.endsWith('\n') || !text ? '' : '\n'}${line}\n`;
  }
  fs.writeFileSync(file, text);
}

function syncEnv(port) {
  const dest = path.join(APP_DIR, '.env');
  if (fs.existsSync(ROOT_ENV)) {
    fs.copyFileSync(ROOT_ENV, dest);
    console.log('[group-bot bootstrap] .env copié vers l’app');
  } else {
    fs.writeFileSync(dest, buildEnv(port), 'utf8');
    console.log('[group-bot bootstrap] .env généré depuis variables panneau');
  }
  const bd = firstBdWithFiles();
  process.env.BD_TRIEE_DIR = bd;
  process.env.BOT_DATA_DIR = process.env.BOT_DATA_DIR || DATA_DIR;
  process.env.WA_AUTH_DIR = process.env.WA_AUTH_DIR || AUTH_DIR;
  patchEnvFile(dest, {
    BOT_DATA_DIR: process.env.BOT_DATA_DIR,
    WA_AUTH_DIR: process.env.WA_AUTH_DIR,
    BD_TRIEE_DIR: bd,
  });
  console.log(`[group-bot bootstrap] BD_TRIEE_DIR=${bd}`);
}

function syncBdFromRepo() {
  const from = path.join(APP_DIR, 'data', 'bd-triee');
  if (!fs.existsSync(from)) {
    console.warn('[group-bot bootstrap] pas de data/bd-triee dans le repo');
    return;
  }
  fs.mkdirSync(BD_DIR, { recursive: true });
  let n = 0;
  for (const name of fs.readdirSync(from)) {
    if (!/\.(txt|csv)$/i.test(name)) continue;
    fs.copyFileSync(path.join(from, name), path.join(BD_DIR, name));
    n += 1;
  }
  process.env.BD_TRIEE_DIR = BD_DIR;
  console.log(`[group-bot bootstrap] ${n} fichier(s) BD copiés vers ${BD_DIR}`);
}

function syncSeedFromRepo() {
  const from = path.join(APP_DIR, 'data', 'seed-saved.json');
  if (!fs.existsSync(from)) return;
  const to = path.join(DATA_DIR, 'seed-saved.json');
  fs.copyFileSync(from, to);
  console.log(`[group-bot bootstrap] seed-saved.json copié vers ${to}`);
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
syncBdFromRepo();
syncSeedFromRepo();

if (!fs.existsSync(path.join(APP_DIR, 'index.js'))) {
  console.error('[group-bot bootstrap] index.js introuvable après clone');
  process.exit(1);
}

run('npm install --omit=dev', APP_DIR);

console.log('[group-bot bootstrap] démarrage…');
process.chdir(APP_DIR);
require(path.join(APP_DIR, 'index.js'));
