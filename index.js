'use strict';

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');
const qrcode = require('qrcode');
const pino = require('pino');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  downloadContentFromMessage,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');

require('dotenv').config({ path: path.join(__dirname, '.env') });

const {
  normalizePhone,
  isValidPhoneDigits,
  phoneToJid,
  isGroupJid,
  isPnJid,
  isLidJid,
  jidBare,
} = require('./lib/phones');
const { isTestAddMode, modeLabel } = require('./lib/mode');
const { markPhone, rememberGroup, stats: usedStats } = require('./lib/used');
const { pickUnused, poolStats, displayName, reloadProdCache } = require('./lib/contacts');
const { dataDir, dataFile } = require('./lib/paths');

const PORT = parseInt(process.env.PORT || process.env.SERVER_PORT || '21774', 10) || 21774;
const PUBLIC_HOST = String(process.env.BOT_PUBLIC_HOST || 'prem-eu2.bot-hosting.net').trim();
const AUTH_DIR = process.env.WA_AUTH_DIR
  ? path.resolve(process.env.WA_AUTH_DIR)
  : path.join(__dirname, 'auth_info_baileys');
const CONFIG_FILE = process.env.BOT_CONFIG_FILE
  ? path.resolve(process.env.BOT_CONFIG_FILE)
  : dataFile('bot_config.json');
const MANDATORY_ADMIN_PHONE = normalizePhone(process.env.MANDATORY_ADMIN_PHONE || '33762641473');
const ADD_BATCH = Math.max(1, parseInt(process.env.ADD_BATCH || '5', 10) || 5);
const ADD_DELAY_MS = Math.max(400, parseInt(process.env.ADD_DELAY_MS || '1800', 10) || 1800);
const MAX_RECONNECT_ATTEMPTS = 6;

const BOT_COMMANDS = new Set([
  '.menu', '.aide', '.help', '.ping', '.stats',
  '.cgroup', '.pp', '.add',
]);

const app = express();
app.use(cors());
app.use(express.json());

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
dataDir();

let sock = null;
let isConnected = false;
let isLinking = false;
let currentQrBase64 = null;
let pairingCode = null;
let qrError = null;
let reconnectTimer = null;
let reconnectAttempts = 0;
const lidPhoneCache = new Map();
const lastGroupByAdmin = new Map();

let botConfig = { authorizedPhones: [], lastGroups: {} };

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig, null, 2));
  } catch (e) {
    console.warn('[BOT] saveConfig:', e.message);
  }
}

function loadConfig() {
  const extraEnv = String(process.env.BOT_AUTHORIZED_PHONES || '')
    .split(',')
    .map(normalizePhone)
    .filter((p) => p && p !== MANDATORY_ADMIN_PHONE && isValidPhoneDigits(p));
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      botConfig.authorizedPhones = Array.isArray(parsed.authorizedPhones)
        ? parsed.authorizedPhones.map(normalizePhone).filter(Boolean)
        : [];
      botConfig.lastGroups = parsed.lastGroups && typeof parsed.lastGroups === 'object'
        ? parsed.lastGroups
        : {};
    } catch (e) {
      console.warn('[BOT] bot_config.json:', e.message);
    }
  }
  extraEnv.forEach((p) => {
    if (!botConfig.authorizedPhones.includes(p)) botConfig.authorizedPhones.push(p);
  });
  Object.entries(botConfig.lastGroups || {}).forEach(([phone, gid]) => {
    lastGroupByAdmin.set(phone, gid);
  });
  saveConfig();
}

loadConfig();

function getAllAuthorizedPhones() {
  const extra = (botConfig.authorizedPhones || [])
    .map(normalizePhone)
    .filter((p) => p && p !== MANDATORY_ADMIN_PHONE);
  return [...new Set([MANDATORY_ADMIN_PHONE, ...extra].filter(Boolean))];
}

function storeLidMapping(lid, pn) {
  const lidKey = jidBare(lid);
  const phone = normalizePhone(pn);
  if (lidKey && phone && isValidPhoneDigits(phone)) lidPhoneCache.set(lidKey, phone);
}

function cacheLidFromMessage(key) {
  if (!key) return;
  const primary = key.participant || key.remoteJid;
  const alt = key.participantAlt || key.remoteJidAlt;
  if (primary && alt && (isLidJid(primary) || !isPnJid(primary)) && isPnJid(alt)) {
    storeLidMapping(primary, alt);
  }
}

function resolveSenderPhone(msg) {
  const key = msg.key || {};
  if (msg.key.fromMe) {
    return sock?.user?.id ? normalizePhone(jidNormalizedUser(sock.user.id)) : '';
  }
  for (const altJid of [key.participantAlt, key.remoteJidAlt, key.senderPn]) {
    if (altJid && isPnJid(altJid)) {
      const phone = normalizePhone(altJid);
      if (isValidPhoneDigits(phone)) return phone;
    }
  }
  const primary = key.participant || key.remoteJid || '';
  if (primary && isPnJid(primary)) {
    const phone = normalizePhone(primary);
    if (isValidPhoneDigits(phone)) return phone;
  }
  const lidKey = jidBare(primary);
  if (lidKey && lidPhoneCache.has(lidKey)) return lidPhoneCache.get(lidKey);
  if (isValidPhoneDigits(lidKey) && !isLidJid(primary) && String(lidKey).length <= 13) {
    return normalizePhone(lidKey);
  }
  return '';
}

function isSenderAuthorized(msg) {
  const phone = resolveSenderPhone(msg);
  if (!phone) return false;
  return getAllAuthorizedPhones().includes(phone);
}

function extractText(msg) {
  if (!msg?.message) return '';
  const type = getContentType(msg.message);
  if (type === 'conversation') return msg.message.conversation || '';
  if (type === 'extendedTextMessage') return msg.message.extendedTextMessage?.text || '';
  if (type === 'imageMessage') return msg.message.imageMessage?.caption || '';
  if (type === 'videoMessage') return msg.message.videoMessage?.caption || '';
  if (type === 'buttonsResponseMessage') return msg.message.buttonsResponseMessage?.selectedButtonId || '';
  return '';
}

function contextInfo(msg) {
  const m = msg?.message || {};
  const type = getContentType(m);
  return m[type]?.contextInfo || m.extendedTextMessage?.contextInfo || null;
}

async function bufferFromImageMessage(imageMessage) {
  const stream = await downloadContentFromMessage(imageMessage, 'image');
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function botJid() {
  if (!sock?.user?.id) return '';
  return jidNormalizedUser(sock.user.id);
}

function botPhone() {
  return normalizePhone(botJid());
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function menuText() {
  const mode = modeLabel();
  return [
    '🤖 *Bot groupes WhatsApp*',
    '',
    '`.cgroup Nom du groupe` — créer le groupe',
    '`.pp` — répondre à une photo (ou légende) pour la photo de profil du *bot*',
    '`.add 25` — ajouter 25 personnes (commande *uniquement* dans le groupe)',
    '`.stats` — restants / déjà utilisés',
    '`.ping` — test',
    '',
    `📥 \`.add\` : mode *${mode}*`,
    mode === 'TEST'
      ? '_Test : seulement 0762641473, 0744977766, 0774865543._'
      : '_Prod : bd triee, une personne = un seul groupe._',
  ].join('\n');
}

async function reactToCommand(msg) {
  try {
    await sock.sendMessage(msg.key.remoteJid, { react: { text: '✅', key: msg.key } });
  } catch (e) {
    /* ignore */
  }
}

function rememberLastGroup(adminPhone, groupId) {
  if (!adminPhone || !groupId) return;
  lastGroupByAdmin.set(adminPhone, groupId);
  botConfig.lastGroups = botConfig.lastGroups || {};
  botConfig.lastGroups[adminPhone] = groupId;
  saveConfig();
}

function resolveTargetGroup(msg, adminPhone) {
  const chat = msg.key.remoteJid;
  if (isGroupJid(chat)) return chat;
  return lastGroupByAdmin.get(adminPhone) || botConfig.lastGroups?.[adminPhone] || '';
}

async function groupSubject(gid) {
  try {
    const meta = await sock.groupMetadata(gid);
    return meta?.subject || '';
  } catch (e) {
    return '';
  }
}

function parseAddCount(text) {
  const m = String(text || '').trim().match(/^\.add\s+(\d+)/i);
  if (!m) return null;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1) return null;
  return Math.min(n, 1000);
}

async function onWhatsAppExists(jids) {
  if (!jids.length) return [];
  try {
    const result = await sock.onWhatsApp(...jids);
    return Array.isArray(result) ? result : [];
  } catch (e) {
    console.warn('[BOT] onWhatsApp:', e.message);
    return jids.map((jid) => ({ jid, exists: true }));
  }
}

function statusFromAddResult(result, jid) {
  if (!result) return 200;
  const failCodes = new Set([400, 401, 403, 404, 405, 406, 408, 429, 500]);
  const pick = (row) => {
    if (row == null) return null;
    if (typeof row === 'number' || typeof row === 'string') return Number(row);
    if (row.status != null) return Number(row.status);
    return null;
  };
  if (result.status && typeof result.status === 'object' && !Array.isArray(result.status)) {
    const row = result.status[jid] || result.status[jid.split('@')[0]];
    const code = pick(row);
    if (code != null) return failCodes.has(code) ? code : 200;
  }
  if (result[jid] || result[jid.split('@')[0]]) {
    const code = pick(result[jid] || result[jid.split('@')[0]]);
    if (code != null) return failCodes.has(code) ? code : 200;
  }
  if (Array.isArray(result)) {
    const row = result.find((r) => r.jid === jid || r === jid);
    const code = pick(row);
    if (code != null) return failCodes.has(code) ? code : 200;
  }
  return 200;
}

async function addParticipantsBatched(groupId, jids) {
  const ok = [];
  const fail = [];
  for (let i = 0; i < jids.length; i += ADD_BATCH) {
    const batch = jids.slice(i, i + ADD_BATCH);
    try {
      const result = await sock.groupParticipantsUpdate(groupId, batch, 'add');
      for (const jid of batch) {
        const code = statusFromAddResult(result, jid);
        if (code === 200 || code === 409) ok.push({ jid, code });
        else fail.push({ jid, code });
      }
    } catch (e) {
      console.warn('[BOT] add batch:', e.message);
      for (const jid of batch) fail.push({ jid, code: 500, error: e.message });
    }
    if (i + ADD_BATCH < jids.length) await sleep(ADD_DELAY_MS);
  }
  return { ok, fail };
}

async function handleCgroup(msg, text, adminPhone) {
  const name = String(text || '').replace(/^\.cgroup\s+/i, '').trim();
  const chat = msg.key.remoteJid;
  if (!name) {
    await sock.sendMessage(chat, { text: '❌ Format : `.cgroup Nom du groupe`' });
    return;
  }
  const participants = [];
  const me = botPhone();
  if (adminPhone && adminPhone !== me) participants.push(phoneToJid(adminPhone));
  if (!participants.length) {
    const fallback = getAllAuthorizedPhones().find((p) => p !== me);
    if (fallback) participants.push(phoneToJid(fallback));
  }
  if (!participants.length) {
    await sock.sendMessage(chat, {
      text: '❌ WhatsApp exige au moins 1 membre en plus du bot pour créer un groupe.',
    });
    return;
  }
  const created = await sock.groupCreate(name, participants);
  const gid = created?.id || created?.gid;
  if (!gid) throw new Error('Groupe créé sans id');
  rememberLastGroup(adminPhone, gid);
  rememberGroup(gid, { name, createdAt: new Date().toISOString(), createdBy: adminPhone });
  let link = '';
  try {
    const code = await sock.groupInviteCode(gid);
    if (code) link = `https://chat.whatsapp.com/${code}`;
  } catch (e) {
    console.warn('[BOT] invite:', e.message);
  }
  const lines = [
    `✅ Groupe *${name}* créé.`,
    '',
    'Ensuite, *dans ce groupe* :',
    '`.add 25` — nombre de personnes à ajouter',
  ];
  if (link) lines.push('', `🔗 ${link}`);
  await sock.sendMessage(chat, { text: lines.join('\n') });
  if (isGroupJid(chat) && chat !== gid) {
    await sock.sendMessage(gid, { text: `👋 Groupe *${name}* prêt. Tape \`.add 3\` pour tester.` });
  } else if (!isGroupJid(chat)) {
    try {
      await sock.sendMessage(gid, { text: `👋 Groupe *${name}* prêt. Tape \`.add N\` ici pour ajouter des membres.` });
    } catch (e) {
      /* ignore */
    }
  }
}

async function handlePp(msg) {
  const chat = msg.key.remoteJid;
  let imageMessage = msg.message?.imageMessage || null;
  const ctx = contextInfo(msg);
  const quoted = ctx?.quotedMessage;
  if (!imageMessage && quoted?.imageMessage) imageMessage = quoted.imageMessage;
  if (!imageMessage && quoted?.viewOnceMessage?.message?.imageMessage) {
    imageMessage = quoted.viewOnceMessage.message.imageMessage;
  }
  if (!imageMessage) {
    await sock.sendMessage(chat, {
      text: '❌ Réponds à une *photo* avec `.pp`, ou envoie la photo avec `.pp` en légende.',
    });
    return;
  }
  const buffer = await bufferFromImageMessage(imageMessage);
  if (!buffer.length) throw new Error('Image vide');
  const me = botJid();
  if (!me) throw new Error('Bot non connecté');
  await sock.updateProfilePicture(me, buffer);
  await sock.sendMessage(chat, { text: '✅ Photo de profil du bot mise à jour.' });
}

async function handleAdd(msg, text, adminPhone) {
  const chat = msg.key.remoteJid;
  const n = parseAddCount(text);
  if (!n) {
    await sock.sendMessage(chat, { text: '❌ Format : `.add 25`\nÀ envoyer *dans le groupe*.' });
    return;
  }
  const groupId = resolveTargetGroup(msg, adminPhone);
  if (!groupId || !isGroupJid(groupId)) {
    await sock.sendMessage(chat, {
      text: '❌ `.add` s’utilise *dans le groupe* (après `.cgroup`).',
    });
    return;
  }

  const pool = poolStats();
  const mode = modeLabel();
  if (pool.available < 1) {
    await sock.sendMessage(chat, {
      text: `ℹ️ Plus personne de dispo en mode *${mode}* (${pool.pool} dans la base, déjà utilisés ou hors WhatsApp).`,
    });
    return;
  }

  await sock.sendMessage(chat, {
    text: `⏳ Mode *${mode}* — recherche de ${n} personne(s) (${pool.available} dispo)…`,
  });

  const subject = (await groupSubject(groupId)) || 'groupe';
  const addedContacts = [];
  const notWa = [];
  const failed = [];
  const tried = new Set();
  let safety = 0;

  while (addedContacts.length < n && safety < n + 400) {
    safety += 1;
    const need = n - addedContacts.length;
    const batch = pickUnused(Math.max(need, 1), tried);
    if (!batch.length) break;
    batch.forEach((c) => tried.add(c.telephone));

    const jids = batch.map((c) => phoneToJid(c.telephone));
    const check = await onWhatsAppExists(jids);
    const existsByPhone = new Map();
    for (const row of check) {
      const phone = normalizePhone(row.jid);
      if (phone) existsByPhone.set(phone, row.exists !== false);
    }
    const byPhone = new Map(batch.map((c) => [c.telephone, c]));
    const toAdd = [];
    for (const contact of batch) {
      const jid = phoneToJid(contact.telephone);
      if (existsByPhone.has(contact.telephone) && existsByPhone.get(contact.telephone) === false) {
        notWa.push(contact);
        markPhone(contact.telephone, {
          status: 'not_whatsapp',
          nom: contact.nom,
          prenom: contact.prenom,
          ville: contact.ville,
        });
        continue;
      }
      toAdd.push({ contact, jid });
    }
    if (!toAdd.length) continue;

    const { ok, fail } = await addParticipantsBatched(groupId, toAdd.map((x) => x.jid));
    const okSet = new Set(ok.map((r) => normalizePhone(r.jid)));
    for (const { contact, jid } of toAdd) {
      if (okSet.has(contact.telephone) && addedContacts.length < n) {
        addedContacts.push(contact);
        markPhone(contact.telephone, {
          status: 'added',
          groupId,
          groupName: subject,
          nom: contact.nom,
          prenom: contact.prenom,
          ville: contact.ville,
        });
      }
    }
    for (const row of fail) {
      const phone = normalizePhone(row.jid);
      const contact = byPhone.get(phone);
      if (contact) failed.push({ contact, code: row.code });
    }
  }

  rememberLastGroup(adminPhone, groupId);
  const leftover = n - addedContacts.length;
  const lines = [
    `✅ *${addedContacts.length}/${n}* ajouté(s) dans *${subject}*`,
    `📥 Mode \`.add\` : *${mode}*`,
  ];
  if (isTestAddMode()) {
    lines.push('_Numéros test : 0762641473 · 0744977766 · 0774865543_');
  }
  if (addedContacts.length) {
    lines.push('', ...addedContacts.slice(0, 15).map((c, i) => `${i + 1}. ${displayName(c)} (${c.telephone})`));
    if (addedContacts.length > 15) lines.push(`… +${addedContacts.length - 15} autres`);
  }
  if (notWa.length) lines.push('', `⚠️ ${notWa.length} numéro(s) pas sur WhatsApp (marqués, ignorés ensuite).`);
  if (failed.length) lines.push(`⚠️ ${failed.length} refus(s) WhatsApp (confidentialité / limite) — *non marqués*.`);
  if (leftover > 0) {
    const left = poolStats().available;
    lines.push('', `ℹ️ ${leftover} manquant(s) — ${left} encore dispo dans la base.`);
  }
  await sock.sendMessage(chat, { text: lines.join('\n') });
}

async function handleIncomingMessages(m) {
  if (m.type && m.type !== 'notify') return;
  if (!m.messages?.length) return;

  for (const msg of m.messages) {
    try {
      if (!msg.message) continue;
      cacheLidFromMessage(msg.key);

      const text = extractText(msg);
      if (!text) continue;
      const clean = text.trim();
      const cleanLower = clean.toLowerCase();
      if (!cleanLower.startsWith('.')) continue;

      const cmd = cleanLower.split(/\s+/)[0];
      if (!BOT_COMMANDS.has(cmd)) continue;
      if (msg.key.fromMe && cmd !== '.ping') {
        /* le compte bot peut être le même que l’admin */
      }

      await reactToCommand(msg);
      const chat = msg.key.remoteJid;

      if (cmd === '.menu' || cmd === '.aide' || cmd === '.help') {
        await sock.sendMessage(chat, { text: menuText() });
        continue;
      }

      if (!isSenderAuthorized(msg)) {
        console.log(`[BOT] refusé ${resolveSenderPhone(msg) || chat}: ${clean}`);
        await sock.sendMessage(chat, { text: '⛔ Numéro non autorisé. Tape `.menu`.' });
        continue;
      }

      const adminPhone = resolveSenderPhone(msg);
      console.log(`[BOT] ${adminPhone}: ${clean}`);

      if (cmd === '.ping') {
        await sock.sendMessage(chat, {
          text: `🏓 Pong — WhatsApp OK\n📥 .add = *${modeLabel()}*`,
        });
        continue;
      }

      if (cmd === '.stats') {
        const pool = poolStats();
        const used = usedStats();
        await sock.sendMessage(chat, {
          text: [
            '📊 *Stats*',
            `Mode .add : *${modeLabel()}*`,
            `Base : ${pool.pool} numéros`,
            `Dispo (pas encore dans un groupe) : *${pool.available}*`,
            `Déjà ajoutés : ${used.added}`,
            `Pas sur WhatsApp : ${used.notWhatsapp}`,
            `Groupes suivis : ${used.groups}`,
            pool.mode === 'prod' ? `Dossier BD : ${pool.bdDir}` : 'Pool test : 3 numéros',
          ].join('\n'),
        });
        continue;
      }

      if (cmd === '.cgroup') {
        await handleCgroup(msg, clean, adminPhone);
        continue;
      }

      if (cmd === '.pp') {
        await handlePp(msg);
        continue;
      }

      if (cmd === '.add') {
        await handleAdd(msg, clean, adminPhone);
        continue;
      }
    } catch (e) {
      console.error('[BOT] commande:', e);
      try {
        await sock.sendMessage(msg.key.remoteJid, {
          text: '❌ Erreur : ' + (e.message || 'inconnue'),
        });
      } catch (err) {
        /* ignore */
      }
    }
  }
}

function hasRegisteredSession() {
  return fs.existsSync(path.join(AUTH_DIR, 'creds.json'));
}

function clearAuthSession() {
  if (fs.existsSync(AUTH_DIR)) fs.rmSync(AUTH_DIR, { recursive: true, force: true });
  fs.mkdirSync(AUTH_DIR, { recursive: true });
}

async function destroySocket() {
  const old = sock;
  sock = null;
  if (!old) return;
  try {
    old.ev.removeAllListeners();
    await old.end(undefined);
  } catch (e) {
    console.warn('[BOT] end:', e.message);
  }
}

function cancelScheduledReconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect(method, phoneNumber, delayMs, { clearAuth = false } = {}) {
  cancelScheduledReconnect();
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    isLinking = false;
    qrError = 'Trop de tentatives. Relancez via /api/start.';
    return;
  }
  reconnectAttempts += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToWhatsApp(method, phoneNumber, { force: true, clearAuth });
  }, delayMs);
}

async function connectToWhatsApp(method = 'qr', phoneNumber = '', options = {}) {
  const { force = false, clearAuth = false } = options;
  if (isConnected && sock && !force) return;
  if (isLinking && !force) return;

  cancelScheduledReconnect();
  isLinking = true;
  if (force) qrError = null;
  await destroySocket();

  if (clearAuth) {
    clearAuthSession();
    currentQrBase64 = null;
    pairingCode = null;
  }

  console.log(`[BOT] Connexion (${method})…`);

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
    let version = [2, 3000, 1015901307];
    try {
      const latest = await fetchLatestBaileysVersion();
      version = latest.version;
    } catch (e) {
      console.warn('[BOT] version WA par défaut');
    }

    sock = makeWASocket({
      version,
      auth: state,
      logger: pino({ level: 'silent' }),
      browser: ['Windows', 'Chrome', '120.0.0.0'],
      qrTimeout: 60000,
      connectTimeoutMs: 60000,
    });

    if (method === 'pairing_code' && phoneNumber && !sock.authState.creds.me) {
      setTimeout(async () => {
        if (!sock || isConnected) return;
        try {
          const code = await sock.requestPairingCode(phoneNumber);
          pairingCode = code?.match(/.{1,4}/g)?.join('-') || code;
          console.log(`[BOT] Code d’association : ${pairingCode}`);
        } catch (err) {
          qrError = 'Code association impossible.';
          isLinking = false;
        }
      }, 3000);
    }

    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;
      if (qr && method === 'qr') {
        try {
          currentQrBase64 = await qrcode.toDataURL(qr);
          const term = await qrcode.toString(qr, { type: 'terminal', small: true });
          console.log('\nScanne ce QR avec WhatsApp → Appareils connectés\n');
          console.log(term);
          qrError = null;
          reconnectAttempts = 0;
        } catch (err) {
          console.error('[BOT] QR:', err.message);
        }
      }

      if (connection === 'close') {
        isConnected = false;
        const error = lastDisconnect?.error;
        const statusCode = error?.output?.statusCode;
        const loggedOut = statusCode === DisconnectReason.loggedOut;
        await destroySocket();
        if (loggedOut) {
          isLinking = false;
          currentQrBase64 = null;
          pairingCode = null;
          reconnectAttempts = 0;
          clearAuthSession();
          console.log('[BOT] Déconnecté (session). Relance npm start puis /api/start.');
          return;
        }
        const delay = statusCode === DisconnectReason.restartRequired ? 1500 : 5000;
        scheduleReconnect(method, phoneNumber, delay, { clearAuth: false });
      } else if (connection === 'open') {
        console.log('[BOT] WhatsApp connecté');
        isConnected = true;
        isLinking = false;
        currentQrBase64 = null;
        pairingCode = null;
        qrError = null;
        reconnectAttempts = 0;
        cancelScheduledReconnect();
        console.log(`[BOT] .add mode=${modeLabel()} | admin=${MANDATORY_ADMIN_PHONE}`);
      }
    });

    sock.ev.on('creds.update', saveCreds);
    sock.ev.on('lid-mapping.update', (update) => {
      if (!update || typeof update !== 'object') return;
      if (Array.isArray(update)) {
        update.forEach((e) => {
          if (e?.lid && e?.pn) storeLidMapping(e.lid, e.pn);
        });
      } else {
        Object.entries(update).forEach(([lid, pn]) => storeLidMapping(lid, pn));
      }
    });
    sock.ev.on('messages.upsert', (m) => {
      handleIncomingMessages(m).catch((e) => console.error('[BOT] upsert:', e));
    });
  } catch (error) {
    console.error('[BOT] Init:', error);
    isLinking = false;
    qrError = error.message || 'Erreur connexion';
    await destroySocket();
  }
}

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/status', (_req, res) => {
  res.json({
    connected: isConnected,
    connecting: isLinking && !isConnected,
    qr: currentQrBase64,
    pairingCode,
    qrError,
    addMode: modeLabel(),
    ...poolStats(),
    used: usedStats(),
    authorizedPhones: getAllAuthorizedPhones(),
  });
});

app.post('/api/start', async (req, res) => {
  const { method, phone } = req.body || {};
  if (isConnected) return res.json({ success: true, message: 'Already connected' });
  cancelScheduledReconnect();
  reconnectAttempts = 0;
  qrError = null;
  const useMethod = method || 'qr';
  await connectToWhatsApp(useMethod, phone || '', {
    force: true,
    clearAuth: useMethod === 'qr' || useMethod === 'pairing_code' || !hasRegisteredSession(),
  });
  res.json({ success: true, message: 'Connection started' });
});

app.post('/api/logout', async (_req, res) => {
  cancelScheduledReconnect();
  reconnectAttempts = 0;
  isLinking = false;
  if (sock) {
    try {
      await sock.logout();
    } catch (e) {
      console.warn('[BOT] logout:', e.message);
    }
  }
  await destroySocket();
  isConnected = false;
  currentQrBase64 = null;
  pairingCode = null;
  clearAuthSession();
  res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[BOT] QR : http://${PUBLIC_HOST}:${PORT}`);
  console.log(`[BOT] http://localhost:${PORT}`);
  console.log(`[BOT] .add mode=${modeLabel()}`);
  try {
    const n = isTestAddMode() ? 3 : reloadProdCache();
    console.log(`[BOT] pool ${modeLabel()}: ${n} numéros`);
  } catch (e) {
    console.warn('[BOT] BD:', e.message);
  }
  setTimeout(() => {
    if (hasRegisteredSession()) {
      console.log('[BOT] Session détectée — reconnexion…');
      connectToWhatsApp('qr');
    } else {
      console.log('[BOT] Pas de session — QR…');
      connectToWhatsApp('qr');
    }
  }, 800);
});
