'use strict';

const DEFAULT_SMS_GATEWAY_URL = 'http://prem-eu2.bot-hosting.net:21724';
const DEFAULT_SMS_EMAIL = 'angoularaphael05@gmail.com';
const DEFAULT_SMS_PASSWORD = 'Fareno12';

let cachedToken = null;
let cachedTokenAt = 0;
let secretRejected = false;

function resetSmsAuthCache() {
  cachedToken = null;
  cachedTokenAt = 0;
  secretRejected = false;
}

function smsGatewayUrl() {
  const raw = process.env.SMS_GATEWAY_URL || DEFAULT_SMS_GATEWAY_URL;
  let url = String(raw || '').trim().replace(/\/$/, '');
  if (!url) return '';
  if (!/^https?:\/\//i.test(url)) url = `http://${url}`;
  return url;
}

function smsSecret() {
  return String(process.env.SMS_GATEWAY_SECRET || process.env.OUTBOUND_API_SECRET || '').trim();
}

function smsAdminEmail() {
  return String(
    process.env.SMS_GATEWAY_EMAIL || process.env.ADMIN_EMAIL || DEFAULT_SMS_EMAIL
  ).trim();
}

function smsAdminPassword() {
  return String(
    process.env.SMS_GATEWAY_PASSWORD || process.env.ADMIN_PASSWORD || DEFAULT_SMS_PASSWORD
  ).trim();
}

function toE164(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0') && digits.length === 10) digits = `33${digits.slice(1)}`;
  if (!digits.startsWith('33')) return '';
  return `+${digits}`;
}

function isUnauthError(status, error) {
  if (status === 401) return true;
  return /non authentifi/i.test(String(error || ''));
}

async function parseJsonResponse(res) {
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    return {
      ok: res.ok,
      status: res.status,
      data: {},
      error: text.slice(0, 180) || `HTTP ${res.status}`,
    };
  }
  return {
    ok: res.ok,
    status: res.status,
    data,
    error: data.error || `HTTP ${res.status}`,
  };
}

async function postJson(base, path, body, headers, fetchImpl) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetchImpl(`${base}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        ...headers,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return parseJsonResponse(res);
  } finally {
    clearTimeout(timer);
  }
}

async function smsGatewayToken(base, fetchImpl) {
  if (cachedToken && Date.now() - cachedTokenAt < 50 * 60 * 1000) return cachedToken;
  const email = smsAdminEmail();
  const password = smsAdminPassword();
  if (!email || !password) throw new Error('sms_login_missing');
  const result = await postJson(base, '/api/auth/login', { email, password }, {}, fetchImpl);
  if (!result.ok || !result.data?.token) {
    throw new Error(result.error || 'sms_login_failed');
  }
  cachedToken = result.data.token;
  cachedTokenAt = Date.now();
  return cachedToken;
}

async function sendWithBearer(base, payload, fetchImpl) {
  const token = await smsGatewayToken(base, fetchImpl);
  return postJson(
    base,
    '/api/messages/send',
    payload,
    { Authorization: `Bearer ${token}` },
    fetchImpl
  );
}

async function sendSeanceSms(phone, message, { prenom = '', nom = '', fetchImpl = fetch } = {}) {
  const to = toE164(phone);
  if (!to) return { sent: false, reason: 'numero_invalide' };
  const base = smsGatewayUrl();
  if (!base) return { sent: false, reason: 'sms_not_configured' };
  const payload = {
    telephone: to,
    message,
    prenom,
    nom,
    source: 'seance-offerte',
  };

  const secret = smsSecret();
  if (secret && !secretRejected) {
    const first = await postJson(
      base,
      '/api/messages/send',
      payload,
      { 'x-api-secret': secret },
      fetchImpl
    );
    if (first.ok) return { sent: true, via: 'sms', ...first.data };
    if (!isUnauthError(first.status, first.error)) {
      return { sent: false, reason: first.error };
    }
    secretRejected = true;
  }

  try {
    const second = await sendWithBearer(base, payload, fetchImpl);
    if (!second.ok) return { sent: false, reason: second.error };
    return { sent: true, via: 'sms', ...second.data };
  } catch (e) {
    return { sent: false, reason: e.message || 'sms_login_failed' };
  }
}

module.exports = {
  smsGatewayUrl,
  sendSeanceSms,
  toE164,
  resetSmsAuthCache,
};
