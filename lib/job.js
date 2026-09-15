'use strict';

const fs = require('fs');
const { dataFile } = require('./paths');
const { normalizePhone } = require('./phones');

function jobFile() {
  return dataFile('job.json');
}

function logFile() {
  return dataFile('job.log');
}

function emptyJob() {
  return {
    command: '',
    status: 'idle',
    chat: '',
    index: 0,
    total: 0,
    done: 0,
    failed: 0,
    current: null,
    lastOk: null,
    stoppedAt: null,
    reason: '',
    notified: false,
    startedAt: '',
    updatedAt: '',
  };
}

function contactFrom(c) {
  if (!c) return null;
  const phone = normalizePhone(c.telephone || c.phone || '');
  const name = [c.prenom, c.nom].filter(Boolean).join(' ').trim()
    || c.name
    || c.fullName
    || c.label
    || '';
  const ville = c.ville || '';
  if (!phone && !name) return null;
  return { phone, name, ville };
}

function contactLabel(c) {
  const row = c && (c.phone || c.name) ? c : contactFrom(c);
  if (!row) return '—';
  const bits = [];
  if (row.name) bits.push(row.name);
  if (row.phone) bits.push('+' + row.phone);
  if (row.ville) bits.push(row.ville);
  return bits.join(' · ') || '—';
}

function loadJob() {
  try {
    if (!fs.existsSync(jobFile())) return emptyJob();
    const parsed = JSON.parse(fs.readFileSync(jobFile(), 'utf8'));
    return { ...emptyJob(), ...parsed };
  } catch (e) {
    console.warn('[job] lecture:', e.message);
    return emptyJob();
  }
}

function saveJob(job) {
  const next = { ...emptyJob(), ...job, updatedAt: new Date().toISOString() };
  fs.writeFileSync(jobFile(), JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function appendLog(line) {
  const stamp = new Date().toISOString();
  const row = `[${stamp}] ${line}`;
  console.log(`[JOB] ${line}`);
  try {
    fs.appendFileSync(logFile(), `${row}\n`, 'utf8');
  } catch (e) {
    console.warn('[job] log:', e.message);
  }
}

function startJob({ command, total, chat }) {
  const job = {
    ...emptyJob(),
    command: command || '',
    status: 'running',
    chat: chat || '',
    total: Math.max(0, parseInt(total, 10) || 0),
    startedAt: new Date().toISOString(),
  };
  saveJob(job);
  appendLog(`${job.command} START total=${job.total}`);
  return job;
}

function touchCurrent(contact, index) {
  const job = loadJob();
  job.status = 'running';
  job.current = contactFrom(contact);
  job.index = index;
  job.reason = '';
  saveJob(job);
  appendLog(`${job.command} ${index}/${job.total} EN COURS ${contactLabel(job.current)}`);
  return job;
}

function markOk(contact) {
  const job = loadJob();
  job.lastOk = contactFrom(contact) || job.current;
  job.done = (job.done || 0) + 1;
  job.current = job.lastOk;
  saveJob(job);
  appendLog(`${job.command} ${job.index}/${job.total} OK ${contactLabel(job.lastOk)} (total OK ${job.done})`);
  return job;
}

function markFail(contact, error) {
  const job = loadJob();
  job.failed = (job.failed || 0) + 1;
  saveJob(job);
  appendLog(
    `${job.command} ${job.index}/${job.total} ECHEC ${contactLabel(contactFrom(contact) || job.current)} — ${error || ''}`
  );
  return job;
}

function logDisconnect(reason) {
  const job = loadJob();
  if (job.status !== 'running' && job.status !== 'paused') return job;
  job.stoppedAt = job.current || job.stoppedAt;
  job.reason = reason || 'WhatsApp déconnecté';
  saveJob(job);
  appendLog(
    `${job.command} WHATSAPP DECONNECTE sur ${contactLabel(job.stoppedAt)} (${job.index}/${job.total}) — dernier OK ${contactLabel(job.lastOk)} — ${job.reason}`
  );
  return job;
}

function pauseJob(reason, contact) {
  const job = loadJob();
  job.status = 'paused';
  job.reason = reason || 'WhatsApp déconnecté';
  job.stoppedAt = contactFrom(contact) || job.current || job.stoppedAt;
  job.notified = false;
  saveJob(job);
  appendLog(
    `${job.command} COUPE sur ${contactLabel(job.stoppedAt)} (${job.index}/${job.total}) — dernier OK ${contactLabel(job.lastOk)} — ${job.reason}`
  );
  return job;
}

function finishJob() {
  const job = loadJob();
  job.status = 'done';
  job.current = null;
  job.reason = '';
  saveJob(job);
  appendLog(`${job.command} FINI OK=${job.done} ECHEC=${job.failed} / ${job.total}`);
  return job;
}

function markNotified() {
  const job = loadJob();
  job.notified = true;
  saveJob(job);
  return job;
}

function logReconnect() {
  const job = loadJob();
  if (job.status !== 'running') return job;
  appendLog(`${job.command} RECONNECTE — on continue ${contactLabel(job.current)} (${job.index}/${job.total})`);
  return job;
}

function resumeLines(command) {
  const job = loadJob();
  if (!job.command) return [];
  if (command && job.command !== command) return [];
  if (!job.lastOk && !job.stoppedAt) return [];
  const lines = ['📌 *Reprise*'];
  if (job.lastOk) lines.push(`Dernier OK : ${contactLabel(job.lastOk)}`);
  if (job.stoppedAt && job.status !== 'done') {
    lines.push(`Arrêté sur : ${contactLabel(job.stoppedAt)} (${job.index}/${job.total})`);
  }
  lines.push('Les déjà marqués sont ignorés — on reprend après.');
  return lines;
}

function statsLines() {
  const job = loadJob();
  if (!job.command) return ['📌 Aucun job enregistré.'];
  const lines = [
    `📌 Dernier job : *${job.command}*`,
    `État : *${job.status}*${job.reason ? ` (${job.reason})` : ''}`,
    `Progression : ${job.done} OK / ${job.failed} échec(s) — ${job.index}/${job.total}`,
  ];
  if (job.lastOk) lines.push(`Dernier OK : ${contactLabel(job.lastOk)}`);
  if (job.stoppedAt && job.status !== 'done') {
    lines.push(`Coupé sur : ${contactLabel(job.stoppedAt)}`);
  }
  if (job.status === 'paused' && job.command) {
    lines.push(`Retape \`${job.command}\` pour reprendre.`);
  }
  return lines;
}

function lastLogLines(n = 20) {
  try {
    if (!fs.existsSync(logFile())) return [];
    const text = fs.readFileSync(logFile(), 'utf8');
    return text.trim().split(/\r?\n/).filter(Boolean).slice(-Math.max(1, n));
  } catch (e) {
    return [];
  }
}

function notifyPausedText() {
  const job = loadJob();
  if (job.status !== 'paused') return '';
  return [
    `⚠️ WhatsApp s’est *coupé* pendant \`${job.command}\``,
    job.stoppedAt ? `Arrêté sur : *${contactLabel(job.stoppedAt)}*` : '',
    job.lastOk ? `Dernier OK : ${contactLabel(job.lastOk)}` : '',
    `Progression : ${job.done} OK — ${job.index}/${job.total}`,
    '',
    `Retape \`${job.command}\` : ça reprend *après* le dernier contact marqué.`,
  ].filter(Boolean).join('\n');
}

module.exports = {
  contactFrom,
  contactLabel,
  loadJob,
  saveJob,
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
  appendLog,
};
