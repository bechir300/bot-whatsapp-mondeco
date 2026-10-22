// ============================================================
// MONDECO — allègement des données publicitaires (adReferral)
// lib/ad-referral.js
//
// Mesuré en production (octobre 2026) : adReferral représentait 92,5 Mo
// sur les 135 Mo de conversation-state.json (38 435 conversations), dont :
// - raw (44,6 Mo) : copie brute du referral Meta, jamais relue par le code ;
// - mediaUrl (14,4 Mo) : lien Meta qui expire, inutile une fois l'image
//   copiée localement (storedMediaUrl), que l'interface affiche en priorité.
// Le fichier étant réécrit et resynchronisé dans SQLite à chaque écriture
// groupée, ce poids bloquait l'application plusieurs secondes.
// ============================================================

function slimAdReferral(ad) {
  if (!ad || typeof ad !== 'object' || Array.isArray(ad)) return ad;
  const hasStoredMedia = Boolean(String(ad.storedMediaUrl || '').trim());
  if (!('raw' in ad) && !(hasStoredMedia && 'mediaUrl' in ad)) return ad;

  const { raw, ...rest } = ad;
  if (hasStoredMedia) delete rest.mediaUrl;
  return rest;
}

// Renvoie le même objet si rien ne change (aucune copie inutile), sinon un
// nouvel objet d'état avec adReferral allégé.
function slimConversationState(state) {
  if (!state || typeof state !== 'object' || !state.adReferral) return state;
  const slim = slimAdReferral(state.adReferral);
  return slim === state.adReferral ? state : { ...state, adReferral: slim };
}

module.exports = { slimAdReferral, slimConversationState };
