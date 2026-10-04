/**
 * Rapporteur node:test de la recette : du flux d'événements aux enregistrements
 * de campagne, une ligne JSON par test, avec ses opérations.
 *
 *   node --test \
 *     --test-reporter=./tests/outils/rapporteur-recette.mjs --test-reporter-destination=campagne.jsonl \
 *     tests/test_*.mjs
 *
 * Ce que le flux contient (Node 22), et ce qu'on en retient :
 *   test:start       ordre de rapport ; donne la pile des suites de chaque fichier
 *   test:pass/fail   un test (details.type = 'test') ou une suite ('suite') a fini ;
 *                    skip et todo y sont portés, l'erreur dans details.error
 *   test:diagnostic  les opérations : « 7E:ETAPE {json} » (tests/outils/etapes.mjs),
 *                    émis juste après le test, avec son nom complet ; les autres
 *                    diagnostics d'un fichier servent de contexte à son échec
 * Les fichiers tournent en parallèle, chacun dans son processus : leurs
 * événements s'entrelacent, d'où une pile de suites par fichier.
 *
 * Les enregistrements sont écrits à la fin du flux, quand chaque test a reçu
 * toutes ses opérations. Le lanceur (recette/lancer.mjs) les charge ensuite
 * dans PostgreSQL d'un seul tenant (recette/charger.mjs) : le rapporteur ne
 * dépend pas de la base, et une campagne sans base laisse son fichier JSONL.
 *
 * Enregistrement d'un test :
 *   { type: 'test', origine: 'fichier', fichier, nom_complet, suite, libelle,
 *     statut: reussi | echoue | erreur | omis | a_faire, motif, duree_ms,
 *     etapes: [{ ordre, libelle, statut, entree, attendu, obtenu, message, duree_ms }] }
 * puis un dernier enregistrement { type: 'resume', ... } qui compte le tout.
 */

import { isAbsolute, relative } from 'node:path';

import { MAX_OPERATIONS, PREFIXE_ETAPE } from './etapes.mjs';

const SEPARATEUR = ' > ';
const TAILLE_MOTIF = 4000;

/** État du rapporteur : piles de suites, tests vus, diagnostics libres par fichier. */
export function nouvelEtat(racine = process.cwd()) {
  return { racine, piles: new Map(), tests: [], parCle: new Map(), libres: new Map(), orphelines: [] };
}

const cle = (fichier, nom) => `${fichier}\u0000${nom}`;
const tronquer = (texte, n = TAILLE_MOTIF) => (texte && texte.length > n ? `${texte.slice(0, n)}…` : texte);

function cheminRelatif(etat, fichier) {
  if (!fichier) return null;
  const r = isAbsolute(fichier) ? relative(etat.racine, fichier) : fichier;
  return r.split('\\').join('/');
}

/** Le message utile d'une erreur de test : la cause d'origine, sinon l'enveloppe. */
function messageErreur(erreur) {
  if (!erreur) return null;
  const cause = erreur.cause && typeof erreur.cause === 'object' ? erreur.cause : null;
  const message = cause?.message ?? erreur.message ?? String(erreur);
  return tronquer(String(message));
}

/** Échec d'assertion (« echoue ») ou exception inattendue (« erreur ») ? */
function statutEchec(erreur) {
  const cause = erreur?.cause && typeof erreur.cause === 'object' ? erreur.cause : null;
  const assertion = cause?.code === 'ERR_ASSERTION' || cause?.name === 'AssertionError';
  return erreur?.failureType === 'testCodeFailure' && assertion ? 'echoue' : 'erreur';
}

/** Traite un événement du flux. */
export function traiter(etat, { type, data = {} }) {
  const fichier = cheminRelatif(etat, data.file);

  if (type === 'test:start') {
    if (!etat.piles.has(fichier)) etat.piles.set(fichier, []);
    const pile = etat.piles.get(fichier);
    pile.length = data.nesting;
    pile[data.nesting] = data.name;
    return;
  }

  if (type === 'test:diagnostic') {
    const message = String(data.message ?? '');
    if (message.startsWith(PREFIXE_ETAPE)) {
      let etape;
      try {
        etape = JSON.parse(message.slice(PREFIXE_ETAPE.length));
      } catch {
        return;
      }
      const cible = etat.parCle.get(cle(fichier, etape.test))?.at(-1);
      const { test: _, ...donnees } = etape;
      if (cible) cible.etapes.push(donnees);
      else etat.orphelines.push({ fichier, ...etape });
    } else if (fichier) {
      if (!etat.libres.has(fichier)) etat.libres.set(fichier, []);
      etat.libres.get(fichier).push(message);
    }
    return;
  }

  if (type !== 'test:pass' && type !== 'test:fail') return;
  const details = data.details ?? {};
  const erreur = details.error;
  // Une suite n'est enregistrée que si elle est omise ou « à faire » (ses tests
  // ne s'exécutent pas : sans elle, ils disparaîtraient du rapport), ou si elle
  // échoue d'elle-même (exception dans describe, crochet en échec) : l'échec de
  // ses tests est déjà compté.
  const marquee = (data.skip !== undefined && data.skip !== false) || (data.todo !== undefined && data.todo !== false);
  if (details.type === 'suite' && !marquee && (type === 'test:pass' || erreur?.failureType === 'subtestsFailed')) return;

  const pile = etat.piles.get(fichier) ?? [];
  const ancetres = pile.slice(0, data.nesting);
  const nomComplet = [...ancetres, data.name].join(SEPARATEUR);
  let statut;
  let motif = null;
  if (data.todo !== undefined && data.todo !== false) {
    statut = 'a_faire';
    motif = [typeof data.todo === 'string' ? data.todo : 'à faire', type === 'test:pass' ? 'réussi désormais : retirer la mention « à faire »' : null].filter(Boolean).join(' ; ');
  } else if (data.skip !== undefined && data.skip !== false) {
    statut = 'omis';
    motif = typeof data.skip === 'string' ? data.skip : 'omis';
  } else if (type === 'test:pass') {
    statut = 'reussi';
  } else {
    statut = statutEchec(erreur);
    motif = messageErreur(erreur);
  }

  const enregistrement = {
    type: 'test',
    origine: 'fichier',
    fichier,
    nom_complet: nomComplet,
    suite: ancetres.length ? ancetres.join(SEPARATEUR) : null,
    libelle: data.name,
    statut,
    motif,
    duree_ms: typeof details.duration_ms === 'number' ? Math.round(details.duration_ms * 1000) / 1000 : null,
    niveau: data.nesting,
    etapes: [],
  };
  const k = cle(fichier, nomComplet);
  if (!etat.parCle.has(k)) etat.parCle.set(k, []);
  etat.parCle.get(k).push(enregistrement);
  etat.tests.push(enregistrement);
}

/**
 * Les enregistrements, dans l'ordre de rapport. Un nom complet répété dans un
 * même fichier est numéroté (« [2] ») : la base exige des noms uniques. Les
 * diagnostics libres d'un fichier dont le chargement a échoué s'ajoutent au motif.
 */
export function conclure(etat) {
  const vus = new Map();
  const lignes = [];
  for (const t of etat.tests) {
    const k = cle(t.fichier, t.nom_complet);
    const n = (vus.get(k) ?? 0) + 1;
    vus.set(k, n);
    const libres = etat.libres.get(t.fichier) ?? [];
    const echecDeFichier = t.niveau === 0 && t.fichier && t.libelle === t.fichier.split('/').pop() && t.statut === 'erreur';
    const { niveau: _, ...sansNiveau } = t;
    lignes.push({
      ...sansNiveau,
      nom_complet: n > 1 ? `${t.nom_complet} [${n}]` : t.nom_complet,
      libelle: n > 1 ? `${t.libelle} [${n}]` : t.libelle,
      motif: echecDeFichier && libres.length ? tronquer([t.motif, ...libres].filter(Boolean).join('\n')) : t.motif,
      etapes: t.etapes.slice(0, MAX_OPERATIONS),
    });
  }
  const compter = (s) => lignes.filter((l) => l.statut === s).length;
  lignes.push({
    type: 'resume',
    tests: lignes.length,
    reussis: compter('reussi'),
    echoues: compter('echoue'),
    erreurs: compter('erreur'),
    omis: compter('omis'),
    a_faire: compter('a_faire'),
    operations: lignes.reduce((n, l) => n + l.etapes.length, 0),
    operations_orphelines: etat.orphelines.length,
  });
  return lignes;
}

/** Le rapporteur lui-même : node:test lui passe le flux, il rend des lignes JSON. */
export default async function* rapporteurRecette(source) {
  const etat = nouvelEtat();
  for await (const evenement of source) traiter(etat, evenement);
  for (const ligne of conclure(etat)) yield `${JSON.stringify(ligne)}\n`;
}
