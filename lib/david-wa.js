'use strict';

/** Lien nu, sans ?src= ni utm — un lien tracké ressemble à une campagne. */
const SEANCE_OFFERTE_URL = 'https://seance-offerte.boxingcenter.fr/';

function titleCaseName(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return raw
    .split(/([\s'-]+)/)
    .map((part, i) => {
      if (i % 2 === 1 || !part) return part;
      return part.charAt(0).toUpperCase() + part.slice(1).toLowerCase();
    })
    .join('');
}

function waFirstName(contact = {}) {
  const prenom = titleCaseName(contact.prenom);
  if (prenom && !/^test$/i.test(prenom)) return prenom;
  const nom = titleCaseName(String(contact.nom || '').split(/\s+/)[0]);
  if (nom && !/^test$/i.test(nom)) return nom;
  return '';
}

function variantIndex(contact) {
  const digits = String(contact.telephone || contact.phone || '').replace(/\D/g, '');
  const n = parseInt(digits.slice(-2), 10);
  return Number.isFinite(n) ? n % 3 : 0;
}

/**
 * Version WhatsApp du mail David (séance offerte).
 * Même voix, plus court, prénom unique, pas de tracking — pour rester un message perso.
 */
function seanceOfferteWhatsAppText(contact = {}) {
  const who = waFirstName(contact);
  const hi = who ? `Salut ${who},` : 'Salut,';
  const v = variantIndex(contact);
  const offer = [
    'Je t’offre ta séance d’essai au club.',
    'Je t’offre ta séance d’essai au Boxing Center.',
    'Je voulais t’offrir ta séance d’essai au club.',
  ][v];
  const share = [
    'Si tu es déjà inscrit(e) ou pas dispo en ce moment, tu peux aussi la passer à quelqu’un autour de toi.',
    'Si tu es déjà inscrit(e), ou si ce n’est pas le bon moment, tu peux simplement la filer à quelqu’un de ton entourage.',
    'Déjà inscrit(e) ou pas dispo là ? Tu peux aussi l’offrir à quelqu’un autour de toi.',
  ][v];
  return [
    hi,
    '',
    'C’est David du Boxing Center.',
    '',
    offer,
    '',
    share,
    '',
    SEANCE_OFFERTE_URL,
    '',
    'À bientôt,',
    'David',
  ].join('\n');
}

module.exports = {
  SEANCE_OFFERTE_URL,
  waFirstName,
  seanceOfferteWhatsAppText,
};
