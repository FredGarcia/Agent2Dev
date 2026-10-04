/**
 * Étapes de test : le grain d'enregistrement de la recette.
 *
 * Chaque test déclare ses opérations par `scenario(t).etape(...)`. Une étape :
 *   1. exécute une fonction (synchrone ou asynchrone) ;
 *   2. compare ce qu'elle rend à l'attendu (`attendu`), ou le soumet à une
 *      vérification libre (`verifier`) ;
 *   3. se rapporte par un diagnostic structuré `7E:ETAPE {json}`.
 *
 * Le rapporteur de la recette (tests/outils/rapporteur-recette.mjs) lit ces
 * diagnostics et les joint à leur test ; le lanceur (recette/lancer.mjs) range
 * ensuite chaque étape dans la table recette.resultat (recette/charger.mjs).
 * Sans PostgreSQL, le rapporteur par défaut de `node --test` les affiche sous
 * le test : les tests restent lisibles et exécutables partout.
 *
 * Capacité : 16 opérations au plus par test (contrainte de la base, reprise ici
 * pour échouer tôt). Un test qui en déclare davantage échoue à la 17e.
 */

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';

export const MAX_OPERATIONS = 16;
export const PREFIXE_ETAPE = '7E:ETAPE ';

/** Taille au-delà de laquelle une valeur rapportée est tronquée (en caractères JSON). */
const TAILLE_MAX = 2000;

/**
 * Rend une valeur sérialisable en JSON, sans jamais lever : undefined, BigInt,
 * erreurs, Map, Set, fonctions et références circulaires ont chacun leur forme.
 */
export function serialisable(valeur) {
  const vus = new WeakSet();
  const convertir = (v) => {
    if (v === undefined) return { '§': 'undefined' };
    if (typeof v === 'bigint') return { '§': 'bigint', valeur: v.toString() };
    if (typeof v === 'function') return { '§': 'fonction', nom: v.name || '(anonyme)' };
    if (typeof v === 'number' && !Number.isFinite(v)) return { '§': 'nombre', valeur: String(v) };
    if (typeof v === 'number' && Object.is(v, -0)) return { '§': 'nombre', valeur: '-0' };
    if (v === null || typeof v !== 'object') return v;
    if (vus.has(v)) return { '§': 'circulaire' };
    vus.add(v);
    if (v instanceof Error) return { '§': 'erreur', nom: v.name, message: v.message };
    if (v instanceof Map) return { '§': 'map', entrees: [...v].map(([k, x]) => [convertir(k), convertir(x)]) };
    if (v instanceof Set) return { '§': 'set', valeurs: [...v].map(convertir) };
    if (Array.isArray(v)) return v.map(convertir);
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, convertir(x)]));
  };
  const brut = convertir(valeur);
  const texte = JSON.stringify(brut);
  if (texte !== undefined && texte.length > TAILLE_MAX) {
    return { '§': 'tronque', taille: texte.length, apercu: texte.slice(0, TAILLE_MAX) };
  }
  return brut;
}

/**
 * Ouvre le scénario d'un test. Usage :
 *
 *   test('tous conformes hors CI', (t) => {
 *     const s = scenario(t);
 *     s.etape('deux conformes, hors CI', () => agreger([R('conforme'), R('conforme')], false), { attendu: 2 });
 *   });
 *
 * Options d'une étape :
 *   attendu   valeur comparée par égalité profonde stricte (assert.deepStrictEqual)
 *   verifier  fonction (obtenu) => void qui lève si l'obtenu ne convient pas
 *   entree    description des entrées, rapportée telle quelle
 * Sans attendu ni verifier, l'étape réussit si la fonction ne lève pas.
 */
export function scenario(t) {
  let ordre = 0;
  const nomComplet = t.fullName ?? t.name;

  const rapporter = (donnees) => {
    t.diagnostic(PREFIXE_ETAPE + JSON.stringify({ test: nomComplet, ...donnees }));
  };

  const etape = (libelle, fn, options = {}) => {
    ordre += 1;
    const n = ordre;
    if (n > MAX_OPERATIONS) {
      throw new Error(`${MAX_OPERATIONS} opérations au plus par test : « ${libelle} » serait la ${n}e`);
    }
    const debut = performance.now();
    const aAttendu = Object.hasOwn(options, 'attendu');
    const base = () => ({
      ordre: n,
      libelle,
      entree: Object.hasOwn(options, 'entree') ? serialisable(options.entree) : null,
      attendu: aAttendu ? serialisable(options.attendu) : null,
      duree_ms: Math.round((performance.now() - debut) * 1000) / 1000,
    });

    // Comparaison de l'obtenu ; un échec de comparaison est « echouee »
    const conclure = (obtenu) => {
      try {
        if (aAttendu) assert.deepStrictEqual(obtenu, options.attendu);
        else if (options.verifier) options.verifier(obtenu);
      } catch (e) {
        rapporter({ ...base(), statut: 'echouee', obtenu: serialisable(obtenu), message: e.message });
        throw e;
      }
      rapporter({ ...base(), statut: 'reussie', obtenu: serialisable(obtenu), message: null });
      return obtenu;
    };

    // Exception levée par la fonction elle-même : une assertion interne est un
    // échec (« echouee »), toute autre exception une erreur (« erreur »)
    const lever = (e) => {
      const statut = e instanceof assert.AssertionError ? 'echouee' : 'erreur';
      rapporter({ ...base(), statut, obtenu: null, message: e?.message ?? String(e) });
      throw e;
    };

    let resultat;
    try {
      resultat = fn();
    } catch (e) {
      return lever(e);
    }
    if (resultat && typeof resultat.then === 'function') return resultat.then(conclure, lever);
    return conclure(resultat);
  };

  return {
    etape,
    /** Nombre d'étapes déjà déclarées dans ce test. */
    get nombre() { return ordre; },
  };
}

/**
 * Déroule une table de cas, une étape par cas : la forme la plus courante des
 * tests de la recette. Chaque cas est [libellé, fonction, attendu].
 *
 * Les cas d'une table sont indépendants : un cas en échec n'arrête pas les
 * suivants, pour que la campagne enregistre toutes les opérations du test.
 * Le test échoue à la fin, sur le premier échec s'il est seul, sinon sur un
 * récapitulatif qui nomme chaque étape en échec. Un cas asynchrone (fonction
 * qui rend une promesse) est attendu avant le suivant : l'ordre est conservé.
 */
export function table(t, cas) {
  const s = scenario(t);
  const echecs = [];
  const noter = (i, erreur) => echecs.push({ ordre: i + 1, libelle: cas[i][0], erreur });

  const conclure = () => {
    if (echecs.length === 1) throw echecs[0].erreur;
    if (echecs.length > 1) {
      const liste = echecs.map((x) => `  #${x.ordre} ${x.libelle}`).join('\n');
      throw new assert.AssertionError({
        message: `${echecs.length} étapes en échec sur ${cas.length} :\n${liste}\n\nPremier échec : ${echecs[0].erreur?.message ?? echecs[0].erreur}`,
      });
    }
    return s;
  };

  const derouler = (depart) => {
    for (let i = depart; i < cas.length; i += 1) {
      const [libelle, fn, attendu] = cas[i];
      let r;
      try {
        r = s.etape(libelle, fn, { attendu });
      } catch (e) {
        noter(i, e);
        continue;
      }
      if (r && typeof r.then === 'function') {
        return r.then(() => derouler(i + 1), (e) => { noter(i, e); return derouler(i + 1); });
      }
    }
    return conclure();
  };

  return derouler(0);
}
