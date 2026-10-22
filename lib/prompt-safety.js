// ============================================================
// MONDECO — neutralisation des textes externes insérés dans le prompt
// lib/prompt-safety.js
// ============================================================

// Une seule ligne, sans séparateurs de section ni guillemets de bornage,
// longueur plafonnée : un texte externe (ex. paramètre « ref » d'un lien
// publicitaire, que n'importe qui peut écrire) ne peut pas se faire passer
// pour une nouvelle section d'instructions.
function promptDataField(value, maxLength = 300) {
  const text = String(value ?? '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/[=]{3,}|[-]{3,}|[#]{2,}/g, ' ')
    .replace(/[«»]/g, '"')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

module.exports = { promptDataField };
