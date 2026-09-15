'use strict';

function addStatusCode(row) {
  if (row == null) return 0;
  const raw = row.status ?? row.error;
  if (raw == null || raw === '') return 0;
  const n = Number(raw);
  return Number.isFinite(n) ? n : 0;
}

function isAddSuccess(code) {
  return code === 200 || code === 409;
}

/** Échecs où un autre JID (LID) peut encore marcher. */
function shouldTryNextJid(code) {
  return code === 400 || code === 403 || code === 404 || code === 408 || code === 451;
}

/** WhatsApp refuse l’ajout direct → envoyer le lien d’invitation. */
function shouldInviteAfterFail(code) {
  if (code === 503) return false;
  return (
    code === 0 ||
    code === 400 ||
    code === 401 ||
    code === 403 ||
    code === 404 ||
    code === 408 ||
    code === 451 ||
    code === 500
  );
}

module.exports = {
  addStatusCode,
  isAddSuccess,
  shouldTryNextJid,
  shouldInviteAfterFail,
};
