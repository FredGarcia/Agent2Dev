/**
 * Validation des sorties des agents génériques.
 *
 * Deux niveaux, appliqués dans cet ordre :
 *   1. schéma    : forme de l'objet (sous-ensemble volontairement réduit de JSON Schema) ;
 *   2. contrôles : règles de cohérence nommées, déclarées par la fiche.
 * Les erreurs sont renvoyées au moteur pour une nouvelle tentative : c'est la
 * boucle de régulation de premier ordre, sans humain.
 */
export function valider(schema, valeur, chemin = '$') {
  const erreurs = [];
  const type = schema.type;

  if (type === 'object') {
    if (valeur === null || typeof valeur !== 'object' || Array.isArray(valeur)) return [`${chemin} : objet attendu`];
    for (const cle of schema.required ?? []) {
      if (!(cle in valeur)) erreurs.push(`${chemin}.${cle} : champ obligatoire absent`);
    }
    for (const [cle, sousSchema] of Object.entries(schema.properties ?? {})) {
      if (cle in valeur) erreurs.push(...valider(sousSchema, valeur[cle], `${chemin}.${cle}`));
    }
    return erreurs;
  }
  if (type === 'array') {
    if (!Array.isArray(valeur)) return [`${chemin} : liste attendue`];
    if (schema.minItems && valeur.length < schema.minItems) {
      erreurs.push(`${chemin} : au moins ${schema.minItems} élément(s) attendu(s)`);
    }
    if (schema.items) valeur.forEach((v, i) => erreurs.push(...valider(schema.items, v, `${chemin}[${i}]`)));
    return erreurs;
  }
  if (type === 'string') {
    if (typeof valeur !== 'string') return [`${chemin} : texte attendu`];
    if (schema.minLength && valeur.trim().length < schema.minLength) erreurs.push(`${chemin} : texte vide`);
    if (schema.enum && !schema.enum.includes(valeur)) {
      erreurs.push(`${chemin} : valeur « ${valeur} » hors de ${schema.enum.join(' | ')}`);
    }
    return erreurs;
  }
  if (type === 'number' || type === 'integer') {
    if (typeof valeur !== 'number' || (type === 'integer' && !Number.isInteger(valeur))) {
      return [`${chemin} : ${type === 'integer' ? 'entier' : 'nombre'} attendu`];
    }
    return erreurs;
  }
  if (type === 'boolean' && typeof valeur !== 'boolean') return [`${chemin} : booléen attendu`];
  return erreurs;
}

/** Contrôles de cohérence nommés, référencés par les fiches. */
export const controles = {
  /** Chaque critère d'acceptation porte un code unique : le code à modifier s'y rattache. */
  criteresUniques(c) {
    const vus = new Set();
    const erreurs = [];
    for (const ca of (c.us ?? []).flatMap((us) => us.criteres ?? [])) {
      if (vus.has(ca.code)) erreurs.push(`${ca.code} : code de critère en double`);
      vus.add(ca.code);
    }
    return erreurs;
  },

  recommandationConnue(c) {
    const codes = (c.options ?? []).map((o) => o.code);
    const choisie = c.recommandation?.option;
    return codes.includes(choisie)
      ? []
      : [`recommandation.option « ${choisie} » absente des options (${codes.join(', ')})`];
  },

  modificationsNonVides(c) {
    const n = (c.modifications?.length ?? 0) + (c.nouveauxFichiers?.length ?? 0);
    return n > 0 ? [] : ['aucune modification ni aucun nouveau fichier proposé'];
  },

  avantNonVide(c) {
    return (c.modifications ?? [])
      .map((m, i) => (m.avant?.trim() ? null : `modifications[${i}].avant : bloc vide`))
      .filter(Boolean);
  }
};

export function verifierSortie(fiche, contenu) {
  const erreurs = valider(fiche.schema, contenu);
  if (erreurs.length) return erreurs;
  for (const nom of fiche.controles ?? []) {
    const controle = controles[nom];
    if (!controle) throw new Error(`Contrôle inconnu dans la fiche ${fiche.code} : ${nom}`);
    erreurs.push(...controle(contenu));
  }
  return erreurs;
}
