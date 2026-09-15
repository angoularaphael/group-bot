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
  ALL_WA_PATCH_NAMES,
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
const { isTestAddMode, modeLabel, setAddMode } = require('./lib/mode');
const { markPhone, unmarkPhone, clearPhoneMarkers, loadUsed, rememberGroup, stats: usedStats, applySeedSaved } = require('./lib/used');
const { pickUnused, pickUnsaved, pickSavedUnsent, poolStats, displayName, reloadProdCache, testContacts, labeledTestContacts, displayFrPhone, testNumbersLabel, allContactsForAdd, bdDir, loadProdContacts } = require('./lib/contacts');
const { dataDir, dataFile } = require('./lib/paths');
const { isCommandAuthorized, authorizedPhonesList } = require('./lib/auth');
const {
  isAdminParticipant,
  parsePromotePhone,
  samePerson,
  kickTargets,
  chunk,
} = require('./lib/group-mod');
const {
  addStatusCode,
  isAddSuccess,
  shouldTryNextJid,
  shouldInviteAfterFail,
} = require('./lib/add-status');
const { seanceOfferteWhatsAppText, waFirstName, waContactName } = require('./lib/david-wa');
const {
  startJob,
  touchCurrent,
  markOk,
  markFail,
  logDisconnect,
  logReconnect,
  pauseJob,
  finishJob,
  markNotified,
  resumeLines,
  statsLines,
  lastLogLines,
  notifyPausedText,
  loadJob,
  contactLabel,
} = require('./lib/job');
const {
  ingestContacts,
  summarizeBook,
  backfillSavedFromBook,
  lastSavedMarker,
} = require('./lib/wa-book');

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
const ADD_DELAY_MS = Math.max(3000, parseInt(process.env.ADD_DELAY_MS || '3000', 10) || 3000);
const SAVE_BATCH = Math.max(1, parseInt(process.env.SAVE_BATCH || '3000', 10) || 3000);
const SAVE_DELAY_MS = Math.max(400, parseInt(process.env.SAVE_DELAY_MS || '800', 10) || 800);
const MAX_RECONNECT_ATTEMPTS = 6;

const BOT_COMMANDS = new Set([
  '.menu', '.aide', '.help', '.ping', '.stats',
  '.cgroup', '.pp', '.gpp', '.mname', '.add',
  '.savecon', '.sendtest', '.sendfull', '.log', '.count',
  '.mute', '.unmute',
  '.kickall', '.promote', '.reset',
]);

const app = express();
app.use(cors());
app.use(express.json());

if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });
dataDir();
setAddMode('prod');
applySeedSaved();

let sock = null;
let isConnected = false;
let isLinking = false;
let bulkRunning = false;
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
  return authorizedPhonesList({
    mandatoryPhone: MANDATORY_ADMIN_PHONE,
    botPhone: botPhone(),
    extraPhones: botConfig.authorizedPhones,
  });
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
  return isCommandAuthorized({
    fromMe: Boolean(msg?.key?.fromMe),
    senderPhone: resolveSenderPhone(msg),
    botPhone: botPhone(),
    extraPhones: botConfig.authorizedPhones,
    mandatoryPhone: MANDATORY_ADMIN_PHONE,
  });
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

function imageMessageFromMsg(msg) {
  const nested = (node) =>
    node?.imageMessage ||
    node?.viewOnceMessage?.message?.imageMessage ||
    node?.viewOnceMessageV2?.message?.imageMessage ||
    node?.viewOnceMessageV2Extension?.message?.imageMessage ||
    null;
  const direct = nested(msg.message);
  if (direct) return direct;
  const quoted = contextInfo(msg)?.quotedMessage;
  return nested(quoted);
}

function botJid() {
  if (!sock?.user?.id) return '';
  return jidNormalizedUser(sock.user.id);
}

function botPhone() {
  return normalizePhone(botJid());
}

function classifyDisconnect(error) {
  const statusCode = error?.output?.statusCode;
  const msg = String(error?.message || error || '');
  const conflict = /conflict/i.test(msg);
  const restart =
    statusCode === DisconnectReason.restartRequired ||
    statusCode === 515 ||
    /restart required/i.test(msg);
  const replaced =
    statusCode === DisconnectReason.connectionReplaced ||
    statusCode === 440 ||
    conflict;
  const realLogout =
    statusCode === DisconnectReason.loggedOut &&
    !conflict &&
    !replaced &&
    /logged out/i.test(msg);
  return { statusCode, msg, conflict, restart, replaced, realLogout };
}

function isDisconnectError(err) {
  const msg = String(err?.message || err || '');
  return (
    !sock ||
    /déconnecté|null|conflict|restart required|connection closed|connection failure/i.test(msg)
  );
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waAlive() {
  return Boolean(sock && isConnected);
}

async function waitForWhatsApp(timeoutMs = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (waAlive()) return true;
    await sleep(500);
  }
  return waAlive();
}

async function ensureWhatsAppOrPause(contact, timeoutMs = 45000) {
  if (waAlive()) return true;
  logDisconnect('WhatsApp coupé — attente reconnexion');
  const recovered = await waitForWhatsApp(timeoutMs);
  if (recovered) {
    logReconnect();
    return true;
  }
  pauseJob('WhatsApp déconnecté', contact);
  return false;
}

async function sendSafe(jid, content) {
  if (!(await waitForWhatsApp(20000))) {
    console.warn('[BOT] send ignoré (WhatsApp coupé)');
    return false;
  }
  try {
    await sock.sendMessage(jid, content);
    return true;
  } catch (e) {
    console.warn('[BOT] send:', e.message);
    return false;
  }
}

function menuText() {
  const mode = modeLabel();
  return [
    '🤖 *Bot groupes WhatsApp*',
    '',
    '`.cgroup Nom du groupe` — créer le groupe',
    '`.pp` — répondre à une photo (ou légende) pour la photo de profil du *bot*',
    '`.gpp` — répondre à une photo *dans le groupe* pour la photo du *groupe*',
    '`.mname Nouveau nom` — changer le nom du *groupe*',
    '`.mute` — seuls les *admins* peuvent écrire',
    '`.unmute` — tout le monde peut écrire',
    '`.add 25` — ajouter 25 personnes (commande *uniquement* dans le groupe)',
    '`.savecon` — enregistrer *3000* contacts (reprend où ça s’est arrêté)',
    '`.sendfull` — message David aux contacts sauvés (reprend aussi)',
    '`.sendtest` — message David aux 5 numéros test',
    '`.log` — dernier contact + logs si WhatsApp s’est coupé',
    '`.count` — combien de contacts BD sont *sur le téléphone*',
    '`.kickall` — retirer tous les *non-admins* du groupe, puis le bot sort',
    '`.promote` — nommer admin (réponds à un message, mention, ou `.promote 06…`)',
    '`.stats` — restants / déjà utilisés / reprise',
    '`.reset` — vider les marqueurs (numéros réutilisables pour `.add`)',
    '`.ping` — test',
    '',
    `📥 \`.add\` : mode *${mode}*`,
    mode === 'TEST'
      ? `_Test : ${testNumbersLabel()}._`
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

function slimAddResult(result) {
  const rows = Array.isArray(result) ? result : [];
  return rows.map((r) => ({
    jid: r?.jid || '',
    status: r?.status != null ? String(r.status) : '',
  }));
}

function matchAddRow(rows, requestedJid, phone) {
  const want = jidNormalizedUser(requestedJid || '') || requestedJid;
  const found = rows.find((r) => {
    const j = r?.jid || '';
    if (!j) return false;
    if (j === requestedJid || jidNormalizedUser(j) === want) return true;
    if (phone && normalizePhone(j) === phone) return true;
    return false;
  });
  return found || null;
}


function isBadRequestError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const status = err?.output?.statusCode || err?.data;
  return msg.includes('bad-request') || msg.includes('bad request') || status === 400 || status === '400';
}

function cleanJid(jid) {
  if (!jid) return '';
  try {
    return jidNormalizedUser(jid) || jid;
  } catch (e) {
    return jid;
  }
}

async function lidForPhone(phone) {
  const pn = phoneToJid(phone);
  try {
    const lid = await sock.signalRepository?.lidMapping?.getLIDForPN(pn);
    return lid ? cleanJid(lid) : '';
  } catch (e) {
    console.warn('[BOT] getLIDForPN', phone, e.message);
    return '';
  }
}

async function jidCandidatesForAdd(phone) {
  const pn = phoneToJid(phone);
  const lid = await lidForPhone(phone);
  const ordered = [];
  // Ajouter avec le numéro (@s.whatsapp.net) : @lid seul → bad-request sur beaucoup de comptes.
  if (pn) ordered.push(pn);
  if (lid && lid !== pn) ordered.push(lid);
  return ordered;
}

async function phonesInGroup(groupId) {
  const meta = await sock.groupMetadata(groupId);
  const phones = new Set();
  const map = sock.signalRepository?.lidMapping;
  for (const p of meta.participants || []) {
    if (p.phoneNumber) phones.add(normalizePhone(p.phoneNumber));
    if (p.id && isPnJid(p.id)) phones.add(normalizePhone(p.id));
    if (p.id && isLidJid(p.id) && map?.getPNForLID) {
      try {
        const pn = await map.getPNForLID(p.id);
        if (pn) phones.add(normalizePhone(pn));
      } catch (e) {
        /* ignore */
      }
    }
  }
  const me = botPhone();
  if (me) phones.add(me);
  return { meta, phones };
}

async function sendGroupInvite(toJid, groupId, subject) {
  if (!(await waitForWhatsApp(20000))) {
    throw new Error('WhatsApp déconnecté');
  }
  const code = await sock.groupInviteCode(groupId);
  if (!code) throw new Error('pas de code d’invitation');
  const expiration = Math.floor(Date.now() / 1000) + 7 * 24 * 3600;
  try {
    await sock.sendMessage(toJid, {
      groupInvite: {
        inviteCode: code,
        inviteExpiration: expiration,
        text: `Invitation au groupe ${subject}`,
        jid: groupId,
        subject,
      },
    });
  } catch (e) {
    console.warn('[BOT] groupInvite msg:', e.message);
    await sock.sendMessage(toJid, {
      text: `Tu es invité(e) au groupe *${subject}*\nhttps://chat.whatsapp.com/${code}`,
    });
  }
  return `https://chat.whatsapp.com/${code}`;
}

async function addParticipantsBatched(groupId, items) {
  const ok = [];
  const fail = [];
  const retries = new Map();
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const contact = item.contact || item;
    touchCurrent(contact, i + 1);
    console.log(`[BOT] .add ${i + 1}/${items.length} ${item.phone} (1 par 1, ${ADD_DELAY_MS / 1000}s)`);
    if (!(await ensureWhatsAppOrPause(contact, 45000))) {
      for (let j = i; j < items.length; j++) {
        fail.push({ ...items[j], code: 503, error: 'WhatsApp déconnecté' });
      }
      break;
    }
    const candidates = [...new Set((item.jids && item.jids.length ? item.jids : [item.jid, item.pnJid]).filter(Boolean).map(cleanJid))];
    let done = false;
    for (const jid of candidates) {
      try {
        if (!waAlive()) throw new Error('WhatsApp déconnecté');
        console.log(`[BOT] add try ${item.phone} → ${jid}`);
        const result = await sock.groupParticipantsUpdate(groupId, [jid], 'add');
        const rows = Array.isArray(result) ? result : [];
        console.log('[BOT] add raw', JSON.stringify(slimAddResult(result)));
        const row = matchAddRow(rows, jid, item.phone) || (rows.length === 1 ? rows[0] : null);
        const code = addStatusCode(row);
        if (isAddSuccess(code)) {
          ok.push({ ...item, jid, code });
          markOk(contact);
          done = true;
          break;
        }
        const failRow = { ...item, jid, code: code || 0, error: row ? `status ${code}` : 'pas de réponse WA' };
        if (shouldTryNextJid(code) && jid !== candidates[candidates.length - 1]) {
          console.warn(`[BOT] add ${item.phone} status ${code} via ${jid} — essai JID suivant`);
          continue;
        }
        fail.push(failRow);
        done = true;
        break;
      } catch (e) {
        console.warn(`[BOT] add ${item.phone} via ${jid}:`, e.message);
        if (isDisconnectError(e) || !sock) {
          if (!(await ensureWhatsAppOrPause(contact, 45000))) {
            fail.push({ ...item, jid, code: 503, error: 'WhatsApp déconnecté' });
            for (let j = i + 1; j < items.length; j++) {
              fail.push({ ...items[j], code: 503, error: 'WhatsApp déconnecté' });
            }
            done = true;
            i = items.length;
            break;
          }
          const nTry = (retries.get(item.phone) || 0) + 1;
          retries.set(item.phone, nTry);
          if (nTry <= 2) i -= 1;
          else {
            markFail(contact, 'WhatsApp déconnecté');
            fail.push({ ...item, jid, code: 503, error: 'WhatsApp déconnecté' });
          }
          done = true;
          break;
        }
        if (isReachoutError(e)) {
          fail.push({ ...item, jid, code: 463, error: e.message });
          done = true;
          break;
        }
        if (isBadRequestError(e) && jid !== candidates[candidates.length - 1]) {
          continue;
        }
        fail.push({
          ...item,
          jid,
          code: isBadRequestError(e) ? 400 : 500,
          error: e.message,
        });
        done = true;
        break;
      }
    }
    if (!done) {
      fail.push({ ...item, code: 400, error: 'bad-request' });
    }
    if (i < items.length - 1 && i >= 0) {
      await sleep(ADD_DELAY_MS);
      if (!(await ensureWhatsAppOrPause(contact, 45000))) {
        for (let j = i + 1; j < items.length; j++) {
          fail.push({ ...items[j], code: 503, error: 'WhatsApp déconnecté' });
        }
        break;
      }
    }
  }
  return { ok, fail };
}

function isReachoutError(err) {
  const msg = String(err?.message || err || '').toLowerCase();
  const data = err?.data;
  return (
    msg.includes('reachout') ||
    msg.includes('account_reachout_restricted') ||
    data === 463 ||
    data === '463'
  );
}

async function reachoutSuffix() {
  try {
    const t = await sock.fetchAccountReachoutTimelock();
    if (t?.isActive && t.timeEnforcementEnds) {
      return `\n⏳ Restriction WhatsApp jusqu’à ${t.timeEnforcementEnds.toLocaleString('fr-FR')}.`;
    }
  } catch (e) {
    console.warn('[BOT] reachout timelock:', e.message);
  }
  return '';
}

/** JID réel du message (déjà en conversation) — jamais un numéro « fallback ». */
function senderJidForGroup(msg, adminPhone) {
  const mePhone = botPhone();
  if (adminPhone && adminPhone === mePhone) return '';
  const key = msg.key || {};
  const candidates = [key.remoteJid, key.remoteJidAlt, key.participant, key.participantAlt, key.senderPn];
  for (const jid of candidates) {
    if (!jid || isGroupJid(jid)) continue;
    if (isLidJid(jid)) return jid;
    if (isPnJid(jid) && normalizePhone(jid) !== mePhone) {
      return jidNormalizedUser(jid);
    }
  }
  if (adminPhone && adminPhone !== mePhone) return phoneToJid(adminPhone);
  return '';
}

async function createGroupSafe(name, extraParticipantJid) {
  try {
    return await sock.groupCreate(name, []);
  } catch (e) {
    console.warn('[BOT] groupCreate []:', e.message);
    if (isReachoutError(e) || !extraParticipantJid) throw e;
    console.log('[BOT] retry groupCreate with', extraParticipantJid);
    return await sock.groupCreate(name, [extraParticipantJid]);
  }
}

async function handleCgroup(msg, text, adminPhone) {
  const name = String(text || '').replace(/^\.cgroup\s+/i, '').trim();
  const chat = msg.key.remoteJid;
  if (!name) {
    await sock.sendMessage(chat, { text: '❌ Format : `.cgroup Nom du groupe`' });
    return;
  }

  const extra = senderJidForGroup(msg, adminPhone);
  console.log(`[BOT] .cgroup me=${botPhone()} extra=${extra || '(aucun — groupe vide)'}`);

  let created;
  try {
    created = await createGroupSafe(name, extra);
  } catch (e) {
    if (isReachoutError(e)) {
      const hint = await reachoutSuffix();
      await sock.sendMessage(chat, {
        text: [
          '❌ WhatsApp refuse d’ajouter un *nouveau* numéro à la création (restriction « reach out »).',
          'Sur le téléphone tu peux créer un groupe avec tes contacts — l’API, elle, n’a pas le droit d’inviter un inconnu.',
          '',
          '*Deux options :*',
          `1. Crée *${name}* à la main sur le téléphone, ouvre-le, tape \`.add 3\` dedans.`,
          '2. Attends que la restriction se lève, puis réessaie `.cgroup` (le bot crée maintenant un groupe *sans* autre membre).',
          hint,
        ].join('\n'),
      });
      return;
    }
    throw e;
  }

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
    '`.kickall` — vider les non-admins',
    '`.promote` — nommer un admin',
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
  const imageMessage = imageMessageFromMsg(msg);
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

async function handleGpp(msg, adminPhone) {
  const chat = msg.key.remoteJid;
  const groupId = resolveTargetGroup(msg, adminPhone);
  if (!groupId || !isGroupJid(groupId)) {
    await sock.sendMessage(chat, {
      text: '❌ `.gpp` s’utilise *dans le groupe* (réponds à une photo, ou envoie la photo avec `.gpp` en légende).',
    });
    return;
  }
  const imageMessage = imageMessageFromMsg(msg);
  if (!imageMessage) {
    await sock.sendMessage(chat, {
      text: '❌ Réponds à une *photo* avec `.gpp`, ou envoie la photo avec `.gpp` en légende.',
    });
    return;
  }
  const buffer = await bufferFromImageMessage(imageMessage);
  if (!buffer.length) throw new Error('Image vide');
  await sock.updateProfilePicture(groupId, buffer);
  const subject = (await groupSubject(groupId)) || 'groupe';
  await sock.sendMessage(chat, { text: `✅ Photo du groupe *${subject}* mise à jour.` });
}

async function handleMname(msg, text, adminPhone) {
  const chat = msg.key.remoteJid;
  const name = String(text || '').replace(/^\.mname\s+/i, '').trim();
  if (!name) {
    await sock.sendMessage(chat, { text: '❌ Format : `.mname Nouveau nom`\nÀ envoyer *dans le groupe*.' });
    return;
  }
  if ([...name].length > 100) {
    await sock.sendMessage(chat, { text: '❌ WhatsApp limite le nom du groupe à 100 caractères.' });
    return;
  }
  const groupId = resolveTargetGroup(msg, adminPhone);
  if (!groupId || !isGroupJid(groupId)) {
    await sock.sendMessage(chat, {
      text: '❌ `.mname` s’utilise *dans le groupe*.',
    });
    return;
  }
  const previous = (await groupSubject(groupId)) || '';
  await sock.groupUpdateSubject(groupId, name);
  rememberGroup(groupId, { name });
  await sock.sendMessage(chat, {
    text: previous && previous !== name
      ? `✅ Groupe renommé : *${previous}* → *${name}*`
      : `✅ Nom du groupe : *${name}*`,
  });
}

async function handleMute(msg, adminPhone, mute) {
  const chat = msg.key.remoteJid;
  const cmd = mute ? '.mute' : '.unmute';
  const groupId = resolveTargetGroup(msg, adminPhone);
  if (!groupId || !isGroupJid(groupId)) {
    await sock.sendMessage(chat, { text: `❌ \`${cmd}\` s’utilise *dans le groupe*.` });
    return;
  }
  let meta;
  try {
    meta = await sock.groupMetadata(groupId);
  } catch (e) {
    await sock.sendMessage(chat, { text: '❌ Impossible de lire le groupe : ' + e.message });
    return;
  }
  if (!botIsGroupAdmin(meta)) {
    await sock.sendMessage(chat, {
      text: `❌ Le bot n’est pas *admin* du groupe. Nomme-le admin, puis retape \`${cmd}\`.`,
    });
    return;
  }
  const already = !!meta.announce;
  if (mute && already) {
    await sock.sendMessage(chat, { text: '🔇 Déjà en sourdine : seuls les *admins* peuvent écrire.' });
    return;
  }
  if (!mute && !already) {
    await sock.sendMessage(chat, { text: '🔊 Tout le monde peut déjà écrire.' });
    return;
  }
  await sock.groupSettingUpdate(groupId, mute ? 'announcement' : 'not_announcement');
  const subject = meta.subject || 'groupe';
  await sock.sendMessage(chat, {
    text: mute
      ? `🔇 *${subject}* : seuls les *admins* peuvent écrire.`
      : `🔊 *${subject}* : tout le monde peut écrire.`,
  });
}

function mentionedJids(msg) {
  const raw = contextInfo(msg)?.mentionedJid;
  return Array.isArray(raw) ? raw.map(cleanJid).filter(Boolean) : [];
}

function quotedParticipantJid(msg) {
  const ctx = contextInfo(msg);
  return cleanJid(ctx?.participant || ctx?.quotedMessage?.key?.participant || '');
}

function botIsGroupAdmin(meta) {
  const me = botJid();
  const mePhone = botPhone();
  return (meta?.participants || []).some((p) => {
    if (!isAdminParticipant(p)) return false;
    if (samePerson(p.id, me)) return true;
    if (p.phoneNumber && normalizePhone(p.phoneNumber) === mePhone) return true;
    if (isPnJid(p.id) && normalizePhone(p.id) === mePhone) return true;
    return false;
  });
}

function participantJidForPhone(meta, phone) {
  const want = normalizePhone(phone);
  if (!want) return '';
  for (const p of meta?.participants || []) {
    if (p.phoneNumber && normalizePhone(p.phoneNumber) === want) return cleanJid(p.id);
    if (p.id && isPnJid(p.id) && normalizePhone(p.id) === want) return cleanJid(p.id);
  }
  return '';
}

async function handleKickall(msg, adminPhone) {
  const chat = msg.key.remoteJid;
  const groupId = resolveTargetGroup(msg, adminPhone);
  if (!groupId || !isGroupJid(groupId) || !isGroupJid(chat)) {
    await sock.sendMessage(chat, { text: '❌ `.kickall` s’utilise *dans le groupe*.' });
    return;
  }
  let meta;
  try {
    meta = await sock.groupMetadata(groupId);
  } catch (e) {
    await sock.sendMessage(chat, { text: '❌ Impossible de lire le groupe : ' + e.message });
    return;
  }
  if (!botIsGroupAdmin(meta)) {
    await sock.sendMessage(chat, {
      text: '❌ Le bot n’est pas *admin* du groupe. Nomme-le admin, puis retape `.kickall`.',
    });
    return;
  }
  const senderKeep = [
    msg.key.participant,
    msg.key.participantAlt,
    senderJidForGroup(msg, adminPhone),
    phoneToJid(adminPhone),
  ].filter(Boolean);
  const targets = kickTargets(meta.participants, {
    botJid: botJid(),
    senderJids: senderKeep,
  });
  const admins = (meta.participants || []).filter(isAdminParticipant).length;
  if (!targets.length) {
    await sock.sendMessage(chat, {
      text: `✅ Personne à retirer — ${admins} admin(s) seulement. Le bot quitte le groupe.`,
    });
    await leaveGroupAfterKickall(groupId);
    return;
  }
  await sock.sendMessage(chat, {
    text: `⏳ Retrait de ${targets.length} non-admin(s) (${admins} admin(s) conservé(s))…`,
  });
  let removed = 0;
  let failed = 0;
  for (const batch of chunk(targets, ADD_BATCH)) {
    try {
      await sock.groupParticipantsUpdate(groupId, batch, 'remove');
      removed += batch.length;
    } catch (e) {
      console.warn('[BOT] kickall:', e.message);
      failed += batch.length;
    }
    await sleep(ADD_DELAY_MS);
  }
  await sock.sendMessage(chat, {
    text: failed
      ? `✅ ${removed} retiré(s), ${failed} échec(s). Admins intacts. Le bot quitte.`
      : `✅ Groupe vidé des non-admins : *${removed}* retiré(s). Le bot quitte.`,
  });
  await leaveGroupAfterKickall(groupId);
}

async function leaveGroupAfterKickall(groupId) {
  await sleep(800);
  try {
    await sock.groupLeave(groupId);
    console.log('[BOT] kickall → groupLeave', groupId);
  } catch (e) {
    console.warn('[BOT] groupLeave:', e.message);
  }
}

async function handlePromote(msg, text, adminPhone) {
  const chat = msg.key.remoteJid;
  const groupId = resolveTargetGroup(msg, adminPhone);
  if (!groupId || !isGroupJid(groupId) || !isGroupJid(chat)) {
    await sock.sendMessage(chat, {
      text: '❌ `.promote` s’utilise *dans le groupe*.\nRéponds au message, mentionne la personne, ou `.promote 06…`.',
    });
    return;
  }
  let meta;
  try {
    meta = await sock.groupMetadata(groupId);
  } catch (e) {
    await sock.sendMessage(chat, { text: '❌ Impossible de lire le groupe : ' + e.message });
    return;
  }
  if (!botIsGroupAdmin(meta)) {
    await sock.sendMessage(chat, {
      text: '❌ Le bot n’est pas *admin* du groupe. Nomme-le admin, puis retape `.promote`.',
    });
    return;
  }

  const candidates = [];
  for (const jid of mentionedJids(msg)) candidates.push(jid);
  const quoted = quotedParticipantJid(msg);
  if (quoted) candidates.push(quoted);
  const phone = parsePromotePhone(text);
  if (phone) {
    const inGroup = participantJidForPhone(meta, phone);
    if (inGroup) candidates.push(inGroup);
    else {
      const extra = await jidCandidatesForAdd(phone);
      candidates.push(...extra);
    }
  }
  const unique = [...new Set(candidates.map(cleanJid).filter(Boolean))];
  if (!unique.length) {
    await sock.sendMessage(chat, {
      text: '❌ Qui nommer admin ? Réponds à son message, mentionne-le, ou `.promote 0612345678`.',
    });
    return;
  }

  const already = [];
  const toPromote = [];
  for (const jid of unique) {
    const p = (meta.participants || []).find((row) => samePerson(row.id, jid));
    if (p && isAdminParticipant(p)) already.push(jid);
    else toPromote.push(jid);
  }
  if (!toPromote.length) {
    await sock.sendMessage(chat, { text: 'ℹ️ Cette personne est déjà admin.' });
    return;
  }

  try {
    await sock.groupParticipantsUpdate(groupId, toPromote, 'promote');
  } catch (e) {
    await sock.sendMessage(chat, { text: '❌ Promote impossible : ' + (e.message || 'erreur WhatsApp') });
    return;
  }
  const who = phone || toPromote.map((j) => jidBare(j)).join(', ');
  await sock.sendMessage(chat, {
    text: already.length
      ? `✅ Admin nommé : *${who}*`
      : `✅ *${who}* est maintenant admin du groupe.`,
  });
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

  let members;
  try {
    members = await phonesInGroup(groupId);
  } catch (e) {
    await sock.sendMessage(chat, { text: '❌ Impossible de lire les membres du groupe : ' + e.message });
    return;
  }

  for (const [phone, row] of Object.entries(loadUsed().phones || {})) {
    if (row.status === 'added' && row.groupId === groupId && !members.phones.has(phone)) {
      console.log('[BOT] faux marquage, on retire', phone);
      unmarkPhone(phone);
    }
  }

  const skipAlready = new Set(members.phones);
  const subjectEarly = members.meta?.subject || '';
  for (const contact of allContactsForAdd()) {
    if (!skipAlready.has(contact.telephone)) continue;
    markPhone(contact.telephone, {
      status: 'added',
      groupId,
      groupName: subjectEarly,
      nom: contact.nom,
      prenom: contact.prenom,
      ville: contact.ville,
    });
  }

  const pool = poolStats();
  const mode = modeLabel();
  const available = Math.max(0, pool.available);
  if (available < 1) {
    await sock.sendMessage(chat, {
      text: `ℹ️ Plus personne de dispo en mode *${mode}* (${pool.pool} dans la base, déjà utilisés ou hors WhatsApp).`,
    });
    return;
  }

  const addResume = resumeLines('.add');
  startJob({ command: '.add', total: n, chat });
  await sock.sendMessage(chat, {
    text: [
      `⏳ Mode *${mode}* — ajout *1 par 1* (${n} pers., 3 s entre chaque)…`,
      ...addResume,
    ].filter(Boolean).join('\n'),
  });

  const subject = members.meta?.subject || (await groupSubject(groupId)) || 'groupe';
  const addedContacts = [];
  const alreadyIn = [];
  const notWa = [];
  const invited = [];
  const failed = [];
  const tried = new Set(skipAlready);
  let safety = 0;
  let groupLink = '';

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

    const mePhone = botPhone();
    const toAdd = [];
    for (const contact of batch) {
      if (skipAlready.has(contact.telephone) || contact.telephone === mePhone) {
        alreadyIn.push(contact);
        continue;
      }
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
      const jids = await jidCandidatesForAdd(contact.telephone);
      toAdd.push({
        contact,
        jid: jids[0],
        jids,
        phone: contact.telephone,
        pnJid: phoneToJid(contact.telephone),
      });
    }
    if (!toAdd.length) continue;

    const { ok, fail } = await addParticipantsBatched(groupId, toAdd);
    await sleep(800);
    let verifiedPhones = skipAlready;
    let verifiedFresh = false;
    try {
      if (await waitForWhatsApp(15000)) {
        const fresh = await phonesInGroup(groupId);
        verifiedPhones = fresh.phones;
        members = fresh;
        verifiedFresh = true;
      }
    } catch (e) {
      console.warn('[BOT] relecture membres:', e.message);
    }

    for (const row of ok) {
      const contact = row.contact;
      if (!contact) continue;
      const inGroup = verifiedPhones.has(contact.telephone);
      const trustWaOk = !verifiedFresh && isAddSuccess(row.code);
      if (inGroup || trustWaOk) {
        if (addedContacts.length < n) {
          addedContacts.push(contact);
          skipAlready.add(contact.telephone);
          markPhone(contact.telephone, {
            status: 'added',
            groupId,
            groupName: subject,
            nom: contact.nom,
            prenom: contact.prenom,
            ville: contact.ville,
          });
        }
      } else {
        fail.push({ ...row, code: row.code === 409 ? 409 : 403, error: 'WA a dit OK mais absent du groupe' });
      }
    }

    for (const row of fail) {
      const contact = row.contact;
      if (!contact) continue;
      if (verifiedPhones.has(contact.telephone)) {
        if (addedContacts.length < n && !addedContacts.some((c) => c.telephone === contact.telephone)) {
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
        continue;
      }
      if (row.code === 463) {
        failed.push({ contact, code: 463, error: row.error });
      } else if (shouldInviteAfterFail(row.code) && waAlive()) {
        try {
          const link = await sendGroupInvite(row.pnJid || row.jid, groupId, subject);
          groupLink = groupLink || link;
          invited.push(contact);
        } catch (e) {
          console.warn('[BOT] invite', contact.telephone, e.message);
          failed.push({ contact, code: row.code || 403, error: e.message });
        }
      } else {
        failed.push({ contact, code: row.code, error: row.error });
      }
    }
  }

  rememberLastGroup(adminPhone, groupId);
  if (!groupLink && waAlive()) {
    try {
      const code = await sock.groupInviteCode(groupId);
      if (code) groupLink = `https://chat.whatsapp.com/${code}`;
    } catch (e) {
      /* ignore */
    }
  }

  const leftover = n - addedContacts.length;
  const lines = [
    addedContacts.length
      ? `✅ *${addedContacts.length}/${n}* vraiment dans *${subject}*`
      : `❌ *0/${n}* ajouté(s) dans *${subject}*`,
    `📥 Mode \`.add\` : *${mode}*`,
  ];
  if (isTestAddMode()) {
    lines.push(`_Numéros test : ${testNumbersLabel()}_`);
  }
  if (addedContacts.length) {
    lines.push('', ...addedContacts.slice(0, 15).map((c, i) => `${i + 1}. ${displayName(c)} (${c.telephone})`));
    if (addedContacts.length > 15) lines.push(`… +${addedContacts.length - 15} autres`);
  }
  if (alreadyIn.length) {
    lines.push('', `ℹ️ ${alreadyIn.length} déjà dans le groupe (ignoré) : ${alreadyIn.map(displayName).join(', ')}`);
  }
  if (invited.length) {
    lines.push(
      '',
      `📩 ${invited.length} invitation(s) envoyée(s) (confidentialité WhatsApp — ils doivent cliquer) :`,
      ...invited.slice(0, 10).map((c) => `• ${displayName(c)} (${c.telephone})`)
    );
  }
  if (notWa.length) lines.push('', `⚠️ ${notWa.length} numéro(s) pas sur WhatsApp (marqués, ignorés ensuite).`);
  if (failed.some((f) => f.code === 503)) {
    const cut = loadJob();
    lines.push(
      '',
      '⚠️ WhatsApp a coupé la session pendant l’ajout.',
      cut.stoppedAt ? `Arrêté sur : *${contactLabel(cut.stoppedAt)}*` : '',
      cut.lastOk ? `Dernier OK : ${contactLabel(cut.lastOk)}` : '',
      leftover > 0 ? `Retape \`.add ${leftover}\` dans ce groupe — ça reprend après les déjà ajoutés.` : ''
    );
  } else if (failed.some((f) => f.code === 463)) {
    lines.push(
      '',
      '❌ WhatsApp bloque l’ajout *direct* de nouveaux numéros (reach out).',
      groupLink ? `Lien du groupe : ${groupLink}` : 'Partage le lien d’invitation du groupe.'
    );
  } else if (failed.length) {
    lines.push(
      '',
      `⚠️ ${failed.length} refus(s) :`,
      ...failed.slice(0, 8).map((f) => `• ${displayName(f.contact)} → ${f.code || '?'} ${f.error || ''}`.trim())
    );
  }
  if (leftover > 0 && !addedContacts.length && invited.length) {
    lines.push('', '_Personne n’est encore dans le groupe tant qu’ils n’ont pas accepté l’invitation._');
  } else if (leftover > 0) {
    const reasons = [];
    if (invited.length) reasons.push(`${invited.length} invitation(s) à accepter`);
    if (failed.length) reasons.push(`${failed.length} refus`);
    if (notWa.length) reasons.push(`${notWa.length} hors WhatsApp`);
    const left = poolStats().available;
    if (reasons.length) {
      lines.push('', `ℹ️ ${leftover} pas encore dans le groupe (${reasons.join(', ')}).`);
    } else {
      lines.push('', `ℹ️ ${leftover} manquant(s) — ${left} encore dispo dans la base.`);
    }
  }
  if (groupLink && (invited.length || failed.length)) {
    lines.push('', `🔗 ${groupLink}`);
  }
  if (loadJob().status === 'paused') markNotified();
  else finishJob();
  await sendSafe(chat, { text: lines.filter(Boolean).join('\n') });
}

function testVcard(label, phone) {
  const intl = `+${phone}`;
  return [
    'BEGIN:VCARD',
    'VERSION:3.0',
    `FN:${label}`,
    `N:${label};;;;`,
    `TEL;type=CELL;type=VOICE;waid=${phone}:${intl}`,
    'END:VCARD',
  ].join('\n');
}

function parseJobCount(text, cmd, fallback = SAVE_BATCH) {
  const m = String(text || '').trim().match(new RegExp(`^\\.${cmd}\\s+(\\d+)`, 'i'));
  if (!m) return fallback;
  const n = parseInt(m[1], 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, SAVE_BATCH);
}

async function handleSavecon(msg, text) {
  const chat = msg.key.remoteJid;
  if (bulkRunning) {
    await sock.sendMessage(chat, { text: '⏳ Un envoi / enregistrement est déjà en cours. Attends la fin.' });
    return;
  }
  const want = parseJobCount(text, 'savecon', SAVE_BATCH);
  let list;
  try {
    list = isTestAddMode() ? labeledTestContacts() : pickUnsaved(want);
  } catch (e) {
    await sock.sendMessage(chat, { text: '❌ BD introuvable : ' + e.message });
    return;
  }
  if (!list.length) {
    await sock.sendMessage(chat, {
      text: 'ℹ️ Plus personne à enregistrer — tous les numéros de la base ont déjà le marqueur `.savecon`.',
    });
    return;
  }
  bulkRunning = true;
  const started = Date.now();
  const saveResume = resumeLines('.savecon');
  startJob({ command: '.savecon', total: list.length, chat });
  await sock.sendMessage(chat, {
    text: [
      `⏳ Enregistrement de *${list.length}* contact(s) BD (1 par 1, ${SAVE_DELAY_MS / 1000} s). Les déjà sauvés sont ignorés.`,
      ...saveResume,
    ].filter(Boolean).join('\n'),
  });
  const ok = [];
  const fail = [];
  let aborted = false;
  const retries = new Map();
  try {
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const name = waContactName(c) || displayFrPhone(c.telephone);
      touchCurrent(c, i + 1);
      if (!c.jid) {
        markFail(c, 'JID invalide');
        fail.push({ ...c, error: 'JID invalide' });
        continue;
      }
      try {
        if (!(await ensureWhatsAppOrPause(c, 20000))) {
          aborted = true;
          break;
        }
        const lid = await lidForPhone(c.telephone);
        await sock.addOrEditContact(c.jid, {
          fullName: name,
          firstName: waFirstName(c) || name,
          pnJid: c.jid,
          ...(lid ? { lidJid: lid } : {}),
          saveOnPrimaryAddressbook: true,
        });
        markPhone(c.telephone, {
          status: 'saved',
          nom: c.nom,
          prenom: c.prenom,
          ville: c.ville,
        });
        markOk(c);
        ok.push(c);
        ingestWaContacts([{ id: c.jid, phoneNumber: c.telephone, name }]);
      } catch (e) {
        console.warn(`[BOT] .savecon ${c.telephone}:`, e.message);
        if (isDisconnectError(e) || !waAlive()) {
          if (!(await ensureWhatsAppOrPause(c, 45000))) {
            aborted = true;
            break;
          }
          const nTry = (retries.get(c.telephone) || 0) + 1;
          retries.set(c.telephone, nTry);
          if (nTry <= 2) {
            i -= 1;
            continue;
          }
        }
        markFail(c, e.message);
        fail.push({ ...c, error: e.message });
      }
      if ((i + 1) % 50 === 0 || i === list.length - 1) {
        await sendSafe(chat, {
          text: `📥 ${ok.length} sauvés / ${fail.length} échecs — ${i + 1}/${list.length}\nDernier : ${contactLabel(c)}`,
        });
      }
      if (i < list.length - 1) {
        await sleep(SAVE_DELAY_MS);
        if (!(await ensureWhatsAppOrPause(c, 45000))) {
          aborted = true;
          break;
        }
      }
    }
  } finally {
    bulkRunning = false;
  }
  if (aborted || loadJob().status === 'paused') {
    markNotified();
    await sendSafe(chat, { text: notifyPausedText() || '⚠️ WhatsApp coupé — retape `.savecon` pour reprendre.' });
    return;
  }
  finishJob();
  const mins = Math.max(1, Math.round((Date.now() - started) / 60000));
  const used = usedStats();
  await sendSafe(chat, {
    text: [
      ok.length
        ? `✅ *${ok.length}/${list.length}* contact(s) enregistrés (${mins} min)`
        : `❌ *0/${list.length}* contact enregistré`,
      fail.length ? `❌ ${fail.length} échec(s) — ils seront retentés au prochain \`.savecon\`.` : '',
      `🔖 Marqueur *saved* : ${used.saved} au total. Ils ne seront plus repris.`,
      ok.length ? `Dernier sauvé : ${contactLabel(ok[ok.length - 1])}` : '',
      '',
      'Ensuite : `.sendfull` pour envoyer le message David à ces contacts.',
    ].filter(Boolean).join('\n'),
  });
}

async function handleSendfull(msg, text) {
  const chat = msg.key.remoteJid;
  if (bulkRunning) {
    await sock.sendMessage(chat, { text: '⏳ Un envoi / enregistrement est déjà en cours. Attends la fin.' });
    return;
  }
  const want = parseJobCount(text, 'sendfull', SAVE_BATCH);
  let list;
  try {
    list = pickSavedUnsent(want);
  } catch (e) {
    await sock.sendMessage(chat, { text: '❌ BD introuvable : ' + e.message });
    return;
  }
  if (!list.length) {
    await sock.sendMessage(chat, {
      text: 'ℹ️ Aucun contact *saved* en attente. Lance d’abord `.savecon`.',
    });
    return;
  }
  bulkRunning = true;
  const started = Date.now();
  const sendResume = resumeLines('.sendfull');
  startJob({ command: '.sendfull', total: list.length, chat });
  await sock.sendMessage(chat, {
    text: [
      `⏳ Message David à *${list.length}* contact(s) sauvés, 1 par 1 (${ADD_DELAY_MS / 1000} s), avec le prénom…`,
      ...sendResume,
    ].filter(Boolean).join('\n'),
  });
  const ok = [];
  const fail = [];
  let aborted = false;
  const retries = new Map();
  try {
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const body = seanceOfferteWhatsAppText(c);
      touchCurrent(c, i + 1);
      try {
        if (!(await ensureWhatsAppOrPause(c, 45000))) {
          aborted = true;
          break;
        }
        await sock.sendMessage(c.jid, { text: body }, { linkPreview: false });
        markPhone(c.telephone, {
          status: 'wa_sent',
          nom: c.nom,
          prenom: c.prenom,
          ville: c.ville,
        });
        markOk(c);
        ok.push(c);
      } catch (e) {
        console.warn(`[BOT] .sendfull ${c.telephone}:`, e.message);
        if (isDisconnectError(e) || !waAlive()) {
          if (!(await ensureWhatsAppOrPause(c, 45000))) {
            aborted = true;
            break;
          }
          const nTry = (retries.get(c.telephone) || 0) + 1;
          retries.set(c.telephone, nTry);
          if (nTry <= 2) {
            i -= 1;
            continue;
          }
        }
        markFail(c, e.message);
        fail.push({ ...c, error: e.message });
      }
      if ((i + 1) % 25 === 0 || i === list.length - 1) {
        await sendSafe(chat, {
          text: `📤 ${ok.length} envoyés / ${fail.length} échecs — ${i + 1}/${list.length}\nDernier : ${contactLabel(c)}`,
        });
      }
      if (i < list.length - 1) {
        await sleep(ADD_DELAY_MS);
        if (!(await ensureWhatsAppOrPause(c, 45000))) {
          aborted = true;
          break;
        }
      }
    }
  } finally {
    bulkRunning = false;
  }
  if (aborted || loadJob().status === 'paused') {
    markNotified();
    await sendSafe(chat, { text: notifyPausedText() || '⚠️ WhatsApp coupé — retape `.sendfull` pour reprendre.' });
    return;
  }
  finishJob();
  const mins = Math.max(1, Math.round((Date.now() - started) / 60000));
  const used = usedStats();
  await sendSafe(chat, {
    text: [
      ok.length
        ? `✅ *${ok.length}/${list.length}* messages David envoyés (${mins} min)`
        : `❌ *0/${list.length}* message envoyé`,
      fail.length ? `❌ ${fail.length} échec(s) — statut *saved* conservé, retente \`.sendfull\`.` : '',
      `📩 Déjà envoyés (marqueur) : *${used.waSent}*`,
      ok.length ? `Dernier envoyé : ${contactLabel(ok[ok.length - 1])}` : '',
      `_Privé, personnalisé, pas de groupe._`,
    ].filter(Boolean).join('\n'),
  });
}

async function handleSendtest(msg) {
  const chat = msg.key.remoteJid;
  const list = labeledTestContacts();
  if (!list.length) {
    await sock.sendMessage(chat, { text: '❌ Aucun numéro test.' });
    return;
  }
  await sock.sendMessage(chat, {
    text: `⏳ Message David (séance offerte) en privé, 1 par 1, avec le prénom (${ADD_DELAY_MS / 1000} s entre chaque)…`,
  });
  const ok = [];
  const fail = [];
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    const body = seanceOfferteWhatsAppText(c);
    console.log(`[BOT] .sendtest ${i + 1}/${list.length} ${c.label} ${waFirstName(c) || c.telephone}`);
    try {
      if (!(await waitForWhatsApp(45000))) throw new Error('WhatsApp déconnecté');
      await sock.sendMessage(c.jid, { text: body }, { linkPreview: false });
      ok.push(c);
    } catch (e) {
      console.warn(`[BOT] .sendtest ${c.label}:`, e.message);
      fail.push({ ...c, error: e.message });
    }
    if (i < list.length - 1) {
      await sleep(ADD_DELAY_MS);
      if (!waAlive()) await waitForWhatsApp(45000);
    }
  }
  const lines = [
    ok.length
      ? `✅ *${ok.length}/${list.length}* message(s) David envoyé(s)`
      : `❌ *0/${list.length}* message envoyé`,
    '_Privé, personnalisé, pas de groupe._',
    '',
    ...list.map((c) => {
      const who = waFirstName(c) || c.label;
      const hit = ok.find((x) => x.telephone === c.telephone);
      const miss = fail.find((x) => x.telephone === c.telephone);
      if (hit) return `✅ *${c.label}* ${who} — ${displayFrPhone(c.telephone)}`;
      return `❌ *${c.label}* ${who} — ${displayFrPhone(c.telephone)}${miss?.error ? ` — ${miss.error}` : ''}`;
    }),
  ];
  await sendSafe(chat, { text: lines.join('\n') });
}

function resolveBookPhone(jid) {
  const key = jidBare(jid);
  if (key && lidPhoneCache.has(key)) return lidPhoneCache.get(key);
  return '';
}

function ingestWaContacts(list) {
  return ingestContacts(list, resolveBookPhone);
}

async function handleCount(msg) {
  const chat = msg.key.remoteJid;
  await sock.sendMessage(chat, {
    text: '⏳ Je compte les contacts *sur le téléphone* (sync WhatsApp, ~10 s)…',
  });
  try {
    if (typeof sock.resyncAppState === 'function') {
      await sock.resyncAppState(ALL_WA_PATCH_NAMES, false);
    }
  } catch (e) {
    console.warn('[BOT] resync carnet:', e.message);
  }
  await sleep(8000);
  let prod = [];
  try {
    prod = loadProdContacts();
  } catch (e) {
    await sendSafe(chat, { text: '❌ BD introuvable : ' + e.message });
    return;
  }
  const filled = backfillSavedFromBook(prod);
  const s = summarizeBook(prod);
  const last = lastSavedMarker();
  const lastLine = last
    ? `Dernier marqueur : ${[last.prenom, last.nom].filter(Boolean).join(' ') || ''} +${last.phone} (${last.status})`
    : '';
  await sendSafe(chat, {
    text: [
      '📱 *Carnet WhatsApp (téléphone)*',
      `Contacts avec un nom (sauvés) : *${s.named}*`,
      `Dont numéros de la BD : *${s.inBdNamed}* / ${s.bdSize}`,
      s.synced ? `Fiches sync reçues : ${s.synced}` : 'Aucune fiche sync pour l’instant.',
      '',
      '🔖 *Marqueurs du bot*',
      `Enregistrés (saved) : *${s.saved}*`,
      `Messages déjà envoyés : *${s.waSent}*`,
      `Total déjà traités : *${s.marked}*`,
      lastLine,
      filled ? `\n🔁 ${filled} numéro(s) trouvés sur le tel et marqués *saved* pour la reprise.` : '',
      '',
      s.inBdNamed || s.marked
        ? `Prochain \`.savecon\` ignore les déjà marqués et continue après.`
        : 'Carnet vide pour l’instant — laisse le bot connecté 1 min puis retape `.count`.',
    ].filter(Boolean).join('\n'),
  });
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

      const adminPhone = resolveSenderPhone(msg) || botPhone();
      console.log(`[BOT] ${adminPhone}: ${clean}`);

      if (cmd === '.ping') {
        await sock.sendMessage(chat, {
          text: `🏓 Pong — WhatsApp OK\n📥 .add = *${modeLabel()}*`,
        });
        continue;
      }

      if (cmd === '.log') {
        const logs = lastLogLines(18).map((l) => l.slice(-220));
        await sock.sendMessage(chat, {
          text: [
            ...statsLines(),
            '',
            logs.length ? '*Derniers logs :*' : 'Aucun log de job.',
            ...logs,
          ].join('\n'),
        });
        continue;
      }

      if (cmd === '.count') {
        await handleCount(msg);
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
            `Déjà ajoutés (groupe) : ${used.added}`,
            `Contacts WhatsApp sauvés : ${used.saved}`,
            `Messages David envoyés : ${used.waSent}`,
            `Pas sur WhatsApp : ${used.notWhatsapp}`,
            `Groupes suivis : ${used.groups}`,
            pool.mode === 'prod' ? `Dossier BD : ${pool.bdDir}` : `Pool test : ${pool.pool} numéros`,
            '',
            ...statsLines(),
            '',
            '_Tape `.count` pour compter le carnet du téléphone._',
          ].join('\n'),
        });
        continue;
      }

      if (cmd === '.reset') {
        const n = clearPhoneMarkers();
        const pool = poolStats();
        await sock.sendMessage(chat, {
          text: [
            '♻️ *Marqueurs vidés*',
            `${n} numéro(s) à nouveau utilisable(s) pour \`.add\`.`,
            `Dispo : *${pool.available}* / ${pool.pool}`,
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

      if (cmd === '.gpp') {
        await handleGpp(msg, adminPhone);
        continue;
      }

      if (cmd === '.mname') {
        await handleMname(msg, clean, adminPhone);
        continue;
      }

      if (cmd === '.mute') {
        await handleMute(msg, adminPhone, true);
        continue;
      }

      if (cmd === '.unmute') {
        await handleMute(msg, adminPhone, false);
        continue;
      }

      if (cmd === '.add') {
        await handleAdd(msg, clean, adminPhone);
        continue;
      }

      if (cmd === '.savecon') {
        await handleSavecon(msg, clean);
        continue;
      }

      if (cmd === '.sendtest') {
        await handleSendtest(msg);
        continue;
      }

      if (cmd === '.sendfull') {
        await handleSendfull(msg, clean);
        continue;
      }

      if (cmd === '.kickall') {
        await handleKickall(msg, adminPhone);
        continue;
      }

      if (cmd === '.promote') {
        await handlePromote(msg, clean, adminPhone);
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
        const { statusCode, conflict, restart, replaced, realLogout } = classifyDisconnect(error);
        console.warn(
          `[BOT] close code=${statusCode} msg=${error?.message || ''} conflict=${conflict} restart=${restart}`
        );
        if (bulkRunning || loadJob().status === 'running') {
          logDisconnect(`connexion close code=${statusCode}`);
        }
        await destroySocket();
        if (realLogout) {
          isLinking = false;
          currentQrBase64 = null;
          pairingCode = null;
          reconnectAttempts = 0;
          clearAuthSession();
          console.log('[BOT] Session invalidée (logout réel). Rescanne le QR sur la page du bot.');
          return;
        }
        const delay = restart ? 1500 : conflict || replaced ? 3000 : 5000;
        console.warn('[BOT] Coupure temporaire — reconnexion sans effacer la session');
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
        const paused = loadJob();
        if (paused.status === 'paused' && paused.chat && !paused.notified) {
          const note = notifyPausedText();
          if (note) {
            markNotified();
            sendSafe(paused.chat, { text: note }).catch(() => {});
          }
        } else if (bulkRunning) {
          logReconnect();
        }
        setTimeout(() => {
          sock?.resyncAppState?.(ALL_WA_PATCH_NAMES, false).catch((e) => {
            console.warn('[BOT] resync carnet:', e.message);
          });
        }, 4000);
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
    sock.ev.on('contacts.upsert', (list) => {
      ingestWaContacts(list);
    });
    sock.ev.on('contacts.update', (list) => {
      ingestWaContacts(list);
    });
    sock.ev.on('messaging-history.set', (payload) => {
      if (payload?.contacts?.length) ingestWaContacts(payload.contacts);
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
    job: loadJob(),
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
  console.log(`[BOT] .add mode=${modeLabel()} | .savecon ${SAVE_BATCH} | .sendfull`);
  try {
    if (isTestAddMode()) {
      const cleared = clearPhoneMarkers();
      console.log(`[BOT] marqueurs vidés: ${cleared}`);
      const n = testContacts().length;
      console.log(`[BOT] pool TEST: ${n} numéros (${testNumbersLabel()})`);
    } else {
      const n = reloadProdCache();
      console.log(`[BOT] pool PROD: ${n} numéros`);
      console.log(`[BOT] BD : ${bdDir()}`);
    }
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
