'use strict';

const DEFAULT_SMS_GATEWAY_URL = 'http://prem-eu2.bot-hosting.net:21724';

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

function toE164(phone) {
  let digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.startsWith('0') && digits.length === 10) digits = `33${digits.slice(1)}`;
  if (!digits.startsWith('33')) return '';
  return `+${digits}`;
}

async function sendSeanceSms(phone, message, { prenom = '', nom = '' } = {}) {
  const to = toE164(phone);
  if (!to) return { sent: false, reason: 'numero_invalide' };
  const base = smsGatewayUrl();
  if (!base) return { sent: false, reason: 'sms_not_configured' };
  const secret = smsSecret();
  if (!secret) return { sent: false, reason: 'sms_not_configured' };
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'x-api-secret': secret,
  };
  const res = await fetch(`${base}/api/messages/send`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      telephone: to,
      message,
      prenom,
      nom,
      source: 'seance-offerte',
    }),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    return { sent: false, reason: text.slice(0, 180) || `HTTP ${res.status}` };
  }
  if (!res.ok) return { sent: false, reason: data.error || `HTTP ${res.status}` };
  return { sent: true, via: 'sms', ...data };
}

module.exports = {
  smsGatewayUrl,
  sendSeanceSms,
  toE164,
};
