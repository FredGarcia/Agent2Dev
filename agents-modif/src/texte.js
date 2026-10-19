const VIDES = new Set([
  'dans', 'pour', 'avec', 'sans', 'doit', 'etre', 'cette', 'celle', 'lors', 'quand', 'sont',
  'nous', 'vous', 'plus', 'tout', 'tous', 'toute', 'toutes', 'fait', 'faire', 'comme', 'mais',
  'donc', 'alors', 'elle', 'elles', 'leur', 'leurs', 'entre', 'depuis', 'afin', 'ainsi', 'rien',
  'chaque', 'aucun', 'aucune', 'uniquement', 'lorsque', 'dont', 'avoir', 'faut', 'ceux'
]);

export function normaliser(texte) {
  return String(texte ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function decamel(texte) {
  return String(texte ?? '').replace(/([a-z0-9])([A-Z])/g, '$1 $2');
}

/** Termes significatifs d'un texte, sans accents, dédoublonnés. */
export function termes(texte) {
  const mots = normaliser(decamel(texte))
    .split(/[^a-z0-9]+/)
    .filter((m) => m.length >= 4 && !VIDES.has(m));
  return [...new Set(mots)];
}

/** Racine grossière (6 caractères) : « renommage » et « renommer » se rejoignent. */
export function racines(texte) {
  return [...new Set(termes(texte).map((t) => t.slice(0, 6)))];
}

export function occurrences(texte, motif) {
  if (!motif) return 0;
  return String(texte).split(motif).length - 1;
}

export function court(texte, n = 120) {
  const t = String(texte ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

/** Extrait le premier objet JSON d'une réponse de moteur (clôtures ``` tolérées). */
export function extraireJson(texte) {
  const propre = String(texte ?? '').replace(/```(?:json)?/g, '').trim();
  const debut = propre.indexOf('{');
  const fin = propre.lastIndexOf('}');
  if (debut < 0 || fin <= debut) throw new Error('aucun objet JSON dans la réponse');
  return JSON.parse(propre.slice(debut, fin + 1));
}
