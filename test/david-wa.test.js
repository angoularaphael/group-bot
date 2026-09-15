'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { seanceOfferteWhatsAppText, waFirstName, SEANCE_OFFERTE_URL } = require('../lib/david-wa');

test('prénom : Salut Marie, comme le mail David', () => {
  assert.equal(waFirstName({ prenom: 'marie', nom: 'durand' }), 'Marie');
  const text = seanceOfferteWhatsAppText({ prenom: 'marie', telephone: '33600000001' });
  assert.match(text, /^Salut Marie,/);
  assert.match(text, /C’est David du Boxing Center/);
  assert.match(text, /t’offre ta séance d’essai/);
  assert.match(text, /entourage|autour de toi/);
  assert.match(text, /À bientôt,/);
  assert.match(text, /David/);
  assert.ok(text.includes(SEANCE_OFFERTE_URL));
});

test('message WhatsApp : pas de tracking, pas de HTML, pas de promo criée', () => {
  const text = seanceOfferteWhatsAppText({ prenom: 'camille', telephone: '33612345678' });
  assert.doesNotMatch(text, /src=|utm_|html|<a /i);
  assert.doesNotMatch(text, /GRATUIT|OFFRE LIMITÉE|clique ici|d’une valeur de 10/i);
  assert.doesNotMatch(text, /\*/);
});

test('deux numéros → textes un peu différents (anti-copie identique)', () => {
  const a = seanceOfferteWhatsAppText({ prenom: 'lea', telephone: '33611111111' });
  const b = seanceOfferteWhatsAppText({ prenom: 'marc', telephone: '33611111122' });
  assert.notEqual(a, b);
  assert.match(a, /^Salut Lea,/);
  assert.match(b, /^Salut Marc,/);
});
