/**
 * Tests définis en base : leurs opérations, leur exécution, leur échange en YAML.
 *
 * Un test défini en base porte au plus seize opérations, de deux natures :
 *   sql       une requête, une seule instruction, exécutée sous le rôle
 *             recette_lecture, en transaction en lecture seule, avec délai ;
 *             le protocole étendu de PostgreSQL refuse toute seconde instruction ;
 *   fonction  l'appel d'une fonction de la liste blanche ci-dessous (fonctions
 *             pures du résolveur, jq sans accès à l'environnement, assertions
 *             du modèle) : aucun texte n'est jamais évalué comme du code.
 *
 * Chaque opération compare ce qu'elle obtient à l'attendu :
 *   egal           égalité profonde (JSON)
 *   contient       l'attendu est inclus (sous-texte, éléments, sous-table)
 *   nombre_lignes  le nombre de lignes rendues (ou d'éléments d'une liste)
 *   vide, non_vide aucune ligne, au moins une
 *   tolerance      |obtenu − attendu| ≤ tolérance
 *
 * Forme du résultat d'une requête : une colonne et une ligne donnent la valeur
 * seule, une colonne et plusieurs lignes la liste des valeurs, plusieurs
 * colonnes la liste des lignes (objets). `SELECT count(*) …` se compare donc à 35.
 *
 * Échange : recette/tests-definis.yaml se charge par « lancer.mjs importer » et
 * se réécrit par « exporter » ; il se versionne avec le dépôt (le catalogue des
 * tests est un Élément du système, comme le modèle).
 */

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { parse, stringify } from 'yaml';

import {
  Resultat, agreger, arrondi, champPresent, combiner, echapperEre, extrait, fixe, formatG, present, quote,
} from '../resolveur7e.mjs';
import { MAX_OPERATIONS, serialisable } from '../tests/outils/etapes.mjs';
import { RACINE, assainir, jsonPourPg, textePropre } from './base.mjs';

export const COMPARAISONS = ['egal', 'contient', 'nombre_lignes', 'vide', 'non_vide', 'tolerance'];
export const DELAI_MS = Number(process.env.RECETTE_DELAI_SQL_MS) > 0 ? Number(process.env.RECETTE_DELAI_SQL_MS) : 5000;
const SANS_ATTENDU = new Set(['vide', 'non_vide']);

const estTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const liste = (v) => (Array.isArray(v) ? v : []);

/** Bornes d'un résultat de requête : au-delà, l'opération est en erreur, sans tout charger. */
export const LIGNES_MAX = 1000;
export const OCTETS_MAX = 10_000_000;

/**
 * Valeur JSON complète, celle que l'on compare : les nombres non finis
 * deviennent leur texte, les entiers longs aussi. Jamais tronquée : seul
 * l'enregistrement en base l'est (serialisable, 2 000 caractères).
 */
export function jsonComplet(v) {
  const texte = JSON.stringify(v ?? null, (_, x) => (typeof x === 'bigint' || (typeof x === 'number' && !Number.isFinite(x)) ? String(x) : x));
  return texte === undefined ? null : JSON.parse(texte);
}
/** Valeur à enregistrer : bornée en taille, texte assaini. */
const pourEnregistrer = (v) => assainir(JSON.parse(JSON.stringify(serialisable(v) ?? null)));

/** Un entier dans ses bornes, ou une erreur qui le dit. */
function borne(valeur, min, max, nom) {
  const n = Number(valeur);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${nom} : un entier de ${min} à ${max} est attendu (reçu ${JSON.stringify(valeur)})`);
  return n;
}
function texteBorne(valeur, nom, max = 1_000_000) {
  const t = String(valeur);
  if (t.length > max) throw new Error(`${nom} : ${max} caractères au plus`);
  return t;
}
function listeBornee(valeur, nom, max = 10_000) {
  const l = liste(valeur);
  if (l.length > max) throw new Error(`${nom} : ${max} éléments au plus`);
  return l;
}

// ── La liste blanche ─────────────────────────────────────────────────────────
let modeleLu = null;
const modele = () => (modeleLu ??= parse(readFileSync(join(RACINE, 'modele-executif-12f-7e.yaml'), 'utf8')));

/** La contrat_version du modèle du dépôt (versionnage.contrat_version), comme le résolveur. */
function contratDuModele() {
  const [majeure, mineure] = String(modele().modele.version).split('.');
  return majeure === '0' ? `0.${mineure}` : majeure;
}

/** L'assertion jq d'un contrôle du modèle (le premier du type donné). */
function assertionDuModele(cid, type) {
  const M = modele();
  const tous = [...M.termes.flatMap((t) => t.criteres), ...M.second_ordre.criteres];
  const c = tous.find((x) => String(x.id) === String(cid));
  if (!c) throw new Error(`critère inconnu du modèle : ${cid}`);
  const k = c.controles.find((x) => x.type === type && typeof x.assertion === 'string');
  if (!k) throw new Error(`le critère ${cid} n’a pas d’assertion de type ${type}`);
  return k.assertion;
}

/**
 * jq, isolé du lanceur :
 *   - environnement réduit à PATH : env et $ENV ne voient aucune URL de
 *     connexion ni aucun mot de passe ;
 *   - import et include refusés : jq lirait sinon tout fichier .json lisible ;
 *   - processus asynchrone, délai de 5 s, sortie bornée à 10 Mo : un jq qui
 *     boucle ou déborde est tué sans geler le serveur.
 */
const DIRECTIVE_JQ = /(^|[^\w$])(import|include)\s*"/;
function jqSur(expression, donnees = null, contexte = {}) {
  const texte = texteBorne(expression, 'expression jq', 10_000);
  if (DIRECTIVE_JQ.test(texte)) return Promise.reject(new Error('jq : import et include sont refusés (aucun accès aux fichiers)'));
  const { m = {}, requis = [], contrat = contratDuModele() } = estTable(contexte) ? contexte : {};
  const entree = JSON.stringify(donnees ?? null);
  if (entree.length > OCTETS_MAX) return Promise.reject(new Error(`jq : données de plus de ${OCTETS_MAX} octets`));
  return new Promise((ok, ko) => {
    const enfant = spawn('jq', ['-c', '--argjson', 'm', JSON.stringify(m ?? {}), '--argjson', 'requis', JSON.stringify(requis ?? []),
      '--arg', 'contrat', String(contrat ?? ''), texte], {
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let sortie = '';
    let erreurs = '';
    let motif = null;
    const arreter = (m) => { if (!motif) { motif = m; enfant.kill('SIGKILL'); } };
    const minuterie = setTimeout(() => arreter('délai dépassé (5 s)'), 5000);
    enfant.stdout.setEncoding('utf8').on('data', (d) => { sortie += d; if (sortie.length > OCTETS_MAX) arreter(`sortie de plus de ${OCTETS_MAX} octets`); });
    enfant.stderr.setEncoding('utf8').on('data', (d) => { if (erreurs.length < 10_000) erreurs += d; });
    enfant.on('error', (e) => { clearTimeout(minuterie); ko(new Error(`jq : ${e.message}`)); });
    enfant.on('close', (code) => {
      clearTimeout(minuterie);
      if (motif) return ko(new Error(`jq : ${motif}`));
      if (code !== 0) return ko(new Error(`jq : ${erreurs.trim() || `code ${code}`}`));
      try {
        const valeurs = sortie.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
        return ok(valeurs.length === 0 ? null : valeurs.length === 1 ? valeurs[0] : valeurs);
      } catch (e) {
        return ko(new Error(`jq : sortie illisible (${e.message})`));
      }
    });
    enfant.stdin.on('error', () => {}); // jq peut se terminer avant d'avoir tout lu
    enfant.stdin.end(entree);
  });
}

const resultatDe = (r) => new Resultat(String(r?.type ?? 'commande'), String(r?.resultat), String(r?.constat ?? ''), {
  cause: r?.cause ?? null, heuristique: r?.heuristique === true,
});

/** Les fonctions qu'une opération peut appeler, avec leur mode d'emploi (affiché dans l'interface). */
export const FONCTIONS = Object.freeze({
  arrondi: { signature: 'arrondi(x, chiffres = 2)', aide: 'Arrondi au pair sur la valeur décimale exacte, celui des moyennes du journal.', appeler: (x, f = 2) => arrondi(Number(x), borne(f, 0, 15, 'chiffres')) },
  fixe: { signature: 'fixe(x, chiffres)', aide: 'Texte à chiffres fixes, arrondi au pair (format f de Python).', appeler: (x, f) => fixe(Number(x), borne(f, 0, 20, 'chiffres')) },
  formatG: { signature: 'formatG(x, précision = 6)', aide: 'Format g de Python, celui des constats.', appeler: (x, p = 6) => formatG(Number(x), borne(p, 1, 17, 'précision')) },
  echapperEre: { signature: 'echapperEre(texte)', aide: 'Échappe un texte pour une expression régulière étendue (grep -E).', appeler: (t) => echapperEre(texteBorne(t, 'texte')) },
  quote: { signature: 'quote(texte)', aide: 'Cite un texte pour le shell.', appeler: (t) => quote(texteBorne(t, 'texte')) },
  extrait: { signature: 'extrait(texte, n = 240)', aide: 'Début d’une sortie d’outil, séquences ANSI retirées.', appeler: (t, n = 240) => extrait(texteBorne(t, 'texte'), borne(n, 0, 10_000, 'n')) },
  present: { signature: 'present(valeur)', aide: 'Vrai si une valeur de manifeste est renseignée (ni vide, ni nulle).', appeler: (v) => present(v) },
  champPresent: { signature: 'champPresent(manifeste, chemin)', aide: 'Vrai si un chemin « requiert » est renseigné ; <nom> vaut toute clé.', appeler: (m, c) => champPresent(m, texteBorne(c, 'chemin', 1000)) },
  agreger: { signature: 'agreger(résultats, en_ci = false)', aide: 'Score d’un critère depuis ses résultats de contrôle (echelle.agregation).', appeler: (rs, enCi = false) => agreger(listeBornee(rs, 'résultats').map(resultatDe), enCi === true) },
  combiner: { signature: 'combiner(type, résultats)', aide: 'Résultat d’un contrôle pour_chaque, depuis ceux de ses éléments.', appeler: (type, rs) => combiner(String(type), listeBornee(rs, 'résultats').map(resultatDe)).versJournal() },
  jq: { signature: 'jq(expression, données, { m, requis, contrat })', aide: 'Évalue une expression jq, avec $m, $requis et $contrat (par défaut, celui du modèle), sans accès à l’environnement.', appeler: (e, d = null, c = {}) => jqSur(e, d, c) },
  assertion: { signature: 'assertion(critère, type, données, { m, requis, contrat })', aide: 'Évalue l’assertion jq d’un contrôle du modèle sur des données choisies.', appeler: (cid, type, d = null, c = {}) => jqSur(assertionDuModele(cid, type), d, c) },
  viabilite: { signature: 'viabilite(entrées)', aide: 'Juge la viabilité (finalite.viabilite) d’une suite d’entrées de journal.', appeler: (entrees) => jqSur(modele().finalite.viabilite.assertion, listeBornee(entrees, 'entrées')) },
});

// ── Comparaisons ─────────────────────────────────────────────────────────────
function contient(obtenu, attendu) {
  if (typeof obtenu === 'string') return typeof attendu === 'string' && obtenu.includes(attendu);
  if (Array.isArray(obtenu)) {
    const voulus = Array.isArray(attendu) ? attendu : [attendu];
    return voulus.every((v) => obtenu.some((o) => isDeepStrictEqual(o, v) || (estTable(o) && estTable(v) && contient(o, v))));
  }
  if (estTable(obtenu) && estTable(attendu)) {
    return Object.entries(attendu).every(([k, v]) => Object.hasOwn(obtenu, k) && (isDeepStrictEqual(obtenu[k], v) || contient(obtenu[k], v)));
  }
  return isDeepStrictEqual(obtenu, attendu);
}

const apercu = (v) => { const t = JSON.stringify(v); return t && t.length > 120 ? `${t.slice(0, 120)}…` : t; };

/** Lève une AssertionError si l'obtenu ne convient pas. `lignes` : lignes rendues ou éléments. */
export function verifier({ comparaison = 'egal', attendu = null, tolerance = null }, obtenu, lignes) {
  switch (comparaison) {
    case 'egal':
      assert.deepStrictEqual(obtenu, attendu);
      return;
    case 'contient':
      assert.ok(contient(obtenu, attendu), `${apercu(obtenu)} ne contient pas ${apercu(attendu)}`);
      return;
    case 'nombre_lignes':
      assert.ok(lignes === Number(attendu), `${lignes} ligne(s) ; ${attendu} attendue(s)`);
      return;
    case 'vide':
      assert.ok(lignes === 0, `${lignes} ligne(s) ; aucune attendue`);
      return;
    case 'non_vide':
      assert.ok(lignes > 0, 'aucune ligne ; au moins une attendue');
      return;
    case 'tolerance': {
      const ecart = Math.abs(Number(obtenu) - Number(attendu));
      assert.ok(Number.isFinite(ecart) && ecart <= Number(tolerance), `|${apercu(obtenu)} − ${apercu(attendu)}| > ${tolerance}`);
      return;
    }
    default:
      throw new Error(`comparaison inconnue : ${comparaison}`);
  }
}

/** Forme comparable du résultat d'une requête (voir l'en-tête). */
export function normaliserLignes(rows, fields) {
  if (fields.length === 1) {
    const valeurs = rows.map((r) => r[fields[0].name]);
    return valeurs.length === 1 ? valeurs[0] : valeurs;
  }
  return rows;
}

// ── Exécution ────────────────────────────────────────────────────────────────
/** Une requête de lecture commence par l'un de ces mots (après commentaires et parenthèses). */
const LECTURE = /^(?:\s|--[^\n]*\n|\/\*[\s\S]*?\*\/|\()*(select|with|values|table)\b/i;

/**
 * Une requête, seule, en lecture seule, sous délai, sur le pool de lecture :
 *   1. BEGIN READ ONLY et délai, en un aller-retour (texte fixe) ;
 *   2. la requête devient un curseur (DECLARE … CURSOR FOR, protocole étendu :
 *      une seule instruction ; un curseur n'admet qu'une lecture) ;
 *   3. FETCH de 1 001 lignes au plus : au-delà de 1 000, ou de 10 Mo,
 *      l'opération est en erreur, sans charger le reste ;
 *   4. ROLLBACK, et libération des verrous consultatifs qu'une requête aurait
 *      pris (pg_advisory_lock survit au ROLLBACK, la connexion retourne au pool).
 */
export async function executerRequete(lecture, requete, delaiMs = DELAI_MS) {
  const texte = String(requete).trim().replace(/;\s*$/, '');
  if (!LECTURE.test(texte)) throw new Error('une opération SQL est une requête de lecture : SELECT, WITH, VALUES ou TABLE');
  const client = await lecture.connect();
  let perdue = null;
  try {
    await client.query(`BEGIN READ ONLY; SET LOCAL statement_timeout = ${Math.max(1, Math.trunc(delaiMs))}`);
    await client.query({ text: `DECLARE operation NO SCROLL CURSOR FOR ${texte}`, queryMode: 'extended' });
    const r = await client.query(`FETCH ${LIGNES_MAX + 1} FROM operation`);
    if (r.rows.length > LIGNES_MAX) throw new Error(`plus de ${LIGNES_MAX} lignes : restreindre la requête (agrégat, LIMIT, condition)`);
    const valeur = normaliserLignes(r.rows, r.fields ?? []);
    if (JSON.stringify(valeur).length > OCTETS_MAX) throw new Error(`résultat de plus de ${OCTETS_MAX} octets`);
    return { lignes: r.rows.length, valeur };
  } finally {
    try {
      await client.query('ROLLBACK; SELECT pg_advisory_unlock_all()');
    } catch (e) {
      perdue = e;
    }
    client.release(perdue ?? undefined);
  }
}

/** Ce que rend une opération, avant comparaison : { valeur, lignes }. */
export async function obtenir(op, { lecture, delaiMs = DELAI_MS } = {}) {
  if (op.nature === 'sql') return executerRequete(lecture, op.requete, delaiMs);
  if (op.nature === 'fonction') {
    const f = Object.hasOwn(FONCTIONS, op.fonction) ? FONCTIONS[op.fonction] : null;
    if (!f) throw new Error(`fonction hors de la liste blanche : ${op.fonction}`);
    const valeur = await f.appeler(...liste(op.arguments));
    return { valeur, lignes: Array.isArray(valeur) ? valeur.length : valeur === null || valeur === undefined ? 0 : 1 };
  }
  throw new Error(`nature d’opération non exécutable ici : ${op.nature}`);
}

/** Exécute une opération ; rend l'enregistrement d'étape (même forme que tests/outils/etapes.mjs). */
export async function executerOperation(op, contexte = {}) {
  const debut = performance.now();
  const entree = op.nature === 'sql'
    ? { sql: op.requete, comparaison: op.comparaison }
    : { fonction: op.fonction, arguments: op.arguments ?? [], comparaison: op.comparaison };
  if (op.comparaison === 'tolerance') entree.tolerance = Number(op.tolerance);
  const base = (statut, obtenu, message) => ({
    ordre: op.ordre, libelle: op.libelle, statut, entree: pourEnregistrer(entree),
    attendu: SANS_ATTENDU.has(op.comparaison) ? null : pourEnregistrer(op.attendu),
    obtenu: obtenu === null ? null : pourEnregistrer(obtenu), message, duree_ms: Math.round((performance.now() - debut) * 1000) / 1000,
  });
  let r;
  try {
    r = await obtenir(op, contexte);
  } catch (e) {
    return base('erreur', null, e?.message ?? String(e));
  }
  // La comparaison porte sur la valeur complète ; seul l'enregistrement est borné
  const obtenu = jsonComplet(r.valeur);
  try {
    verifier({ comparaison: op.comparaison, attendu: op.attendu ?? null, tolerance: op.tolerance ?? null }, obtenu, r.lignes);
    return base('reussie', obtenu, null);
  } catch (e) {
    return base(e instanceof assert.AssertionError ? 'echouee' : 'erreur', obtenu, e.message);
  }
}

/** Exécute un test défini en base : toutes ses opérations, dans l'ordre, même après un échec. */
export async function executerTest(test, operations, contexte = {}) {
  const debut = performance.now();
  const etapes = [];
  for (const op of operations.slice(0, MAX_OPERATIONS)) etapes.push(await executerOperation(op, contexte));
  const echecs = etapes.filter((e) => e.statut !== 'reussie');
  let statut = 'reussi';
  if (!etapes.length) statut = 'omis';
  else if (etapes.some((e) => e.statut === 'echouee')) statut = 'echoue';
  else if (echecs.length) statut = 'erreur';
  return {
    type: 'test', origine: 'base', test_id: test.id, fichier: null,
    nom_complet: test.nom_complet, suite: null, libelle: test.libelle, statut,
    motif: !etapes.length ? 'aucune opération définie' : echecs.length ? `${echecs.length} opération(s) en échec sur ${etapes.length} : ${echecs.map((e) => `#${e.ordre}`).join(', ')}` : null,
    duree_ms: Math.round((performance.now() - debut) * 1000) / 1000,
    etapes,
  };
}

/**
 * Exécute tous les tests actifs définis en base ; rend leurs enregistrements,
 * dans l'ordre des noms. Les tests s'exécutent `parallele` par `parallele` (les
 * opérations d'un même test restent séquentielles) : quelques centaines de
 * tests à seize requêtes tiennent en quelques secondes.
 */
export async function executerTestsDefinis({ principal, lecture, delaiMs = DELAI_MS, parallele = 4 }) {
  const { rows: tests } = await principal.query(
    "SELECT id, nom_complet, libelle FROM recette.test WHERE origine = 'base' AND actif ORDER BY nom_complet",
  );
  const { rows: ops } = await principal.query(
    `SELECT o.* FROM recette.operation o JOIN recette.test t ON t.id = o.test_id
     WHERE t.origine = 'base' AND t.actif ORDER BY o.test_id, o.ordre`,
  );
  const parTest = new Map();
  for (const o of ops) {
    if (!parTest.has(o.test_id)) parTest.set(o.test_id, []);
    parTest.get(o.test_id).push(o);
  }
  const enregistrements = new Array(tests.length);
  let suivant = 0;
  const ouvrier = async () => {
    while (suivant < tests.length) {
      const i = suivant++;
      enregistrements[i] = await executerTest(tests[i], parTest.get(tests[i].id) ?? [], { lecture, delaiMs });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(parallele, tests.length)) }, ouvrier));
  return enregistrements;
}

// ── Échange en YAML ──────────────────────────────────────────────────────────
/**
 * Valide une opération saisie (YAML ou interface) et la rend sous sa forme de
 * base : { libelle, nature, requete, fonction, arguments, comparaison, attendu,
 * tolerance }. Rend { operation } ou { erreurs: { champ: message } }.
 */
export function validerOperation(o) {
  const erreurs = {};
  const libelle = typeof o?.libelle === 'string' ? textePropre(o.libelle).trim() : '';
  if (!libelle) erreurs.libelle = 'Le libellé est obligatoire.';
  else if (libelle.length > 500) erreurs.libelle = 'Le libellé dépasse 500 caractères.';
  const aSql = typeof o?.sql === 'string' && o.sql.trim() !== '';
  const aFonction = typeof o?.fonction === 'string' && o.fonction.trim() !== '';
  if (aSql === aFonction) erreurs.nature = 'Une opération est soit une requête SQL, soit un appel de fonction.';
  if (aFonction && !Object.hasOwn(FONCTIONS, o.fonction.trim())) erreurs.fonction = `Fonction hors de la liste blanche : ${o.fonction}.`;
  if (o?.arguments !== undefined && o.arguments !== null && !Array.isArray(o.arguments)) erreurs.arguments = 'Les arguments forment une liste JSON, par exemple [1.125, 2].';
  const comparaison = o?.comparaison ?? 'egal';
  if (!COMPARAISONS.includes(comparaison)) erreurs.comparaison = `Comparaison inconnue : ${comparaison}.`;
  if (!SANS_ATTENDU.has(comparaison) && !(o && Object.hasOwn(o, 'attendu'))) erreurs.attendu = 'L’attendu est obligatoire pour cette comparaison.';
  if (comparaison === 'tolerance' && !(typeof o?.tolerance === 'number' && o.tolerance >= 0)) erreurs.tolerance = 'La tolérance est un nombre positif ou nul.';
  if (comparaison !== 'tolerance' && o?.tolerance !== undefined && o.tolerance !== null) erreurs.tolerance = 'Une tolérance ne sert qu’à la comparaison « tolerance ».';
  if (Object.keys(erreurs).length) return { erreurs };
  return {
    operation: {
      libelle,
      nature: aSql ? 'sql' : 'fonction',
      requete: aSql ? textePropre(o.sql).trim() : null,
      fonction: aFonction ? o.fonction.trim() : null,
      arguments: aFonction ? assainir(o.arguments ?? []) : null,
      comparaison,
      attendu: SANS_ATTENDU.has(comparaison) ? null : assainir(o.attendu),
      tolerance: comparaison === 'tolerance' ? o.tolerance : null,
    },
  };
}

/** Valide un fichier de tests définis ; rend { tests } ou { erreurs: [textes] }. */
export function validerDefinitions(texte) {
  let doc;
  try {
    doc = parse(texte);
  } catch (e) {
    return { erreurs: [`YAML illisible : ${e.message}`] };
  }
  if (!estTable(doc) || !Array.isArray(doc.tests)) return { erreurs: ['le fichier doit porter une liste « tests »'] };
  const erreurs = [];
  const noms = new Set();
  const tests = [];
  for (const [i, t] of doc.tests.entries()) {
    const ou = `tests[${i}]`;
    const nom = typeof t?.nom === 'string' ? textePropre(t.nom).trim() : '';
    if (!nom) { erreurs.push(`${ou} : nom obligatoire`); continue; }
    if (nom.length > 500) erreurs.push(`${ou} (${nom.slice(0, 40)}…) : nom de plus de 500 caractères`);
    if (noms.has(nom)) erreurs.push(`${ou} (${nom}) : nom en double`);
    noms.add(nom);
    const ops = Array.isArray(t.operations) ? t.operations : [];
    if (ops.length > MAX_OPERATIONS) erreurs.push(`${ou} (${nom}) : ${ops.length} opérations, ${MAX_OPERATIONS} au plus`);
    const operations = [];
    for (const [j, o] of ops.slice(0, MAX_OPERATIONS).entries()) {
      const v = validerOperation(o);
      if (v.erreurs) erreurs.push(...Object.values(v.erreurs).map((m) => `${ou} (${nom}), opération ${j + 1} : ${m}`));
      else operations.push({ ...v.operation, ordre: j + 1 });
    }
    tests.push({ nom, description: typeof t.description === 'string' ? textePropre(t.description).trim() : null, actif: t.actif !== false, operations });
  }
  return erreurs.length ? { erreurs } : { tests };
}

/**
 * Remplace les opérations d'un test défini en base, rang par rang (les
 * résultats passés restent reliés à leur rang), dans la transaction du client.
 */
export async function remplacerOperations(client, testId, operations) {
  const lot = jsonPourPg(operations.map((o, i) => ({ ...o, ordre: i + 1, attendu: o.attendu === undefined ? null : o.attendu })));
  // Le rang est différable : la mise à jour et l'ajout se vérifient en fin d'instruction
  await client.query(
    `UPDATE recette.operation o SET libelle = x.libelle, nature = x.nature, requete = x.requete, fonction = x.fonction,
            arguments = x.arguments, comparaison = x.comparaison, tolerance = x.tolerance,
            attendu = CASE WHEN x.comparaison IN ('vide', 'non_vide') THEN x.attendu ELSE coalesce(x.attendu, 'null'::jsonb) END
     FROM jsonb_to_recordset($2::jsonb) AS x(ordre smallint, libelle text, nature text, requete text, fonction text,
                                             arguments jsonb, comparaison text, attendu jsonb, tolerance numeric)
     WHERE o.test_id = $1 AND o.ordre = x.ordre`,
    [testId, lot],
  );
  await client.query(
    `INSERT INTO recette.operation (test_id, ordre, libelle, nature, requete, fonction, arguments, comparaison, attendu, tolerance)
     SELECT $1, x.ordre, x.libelle, x.nature, x.requete, x.fonction, x.arguments, x.comparaison,
            CASE WHEN x.comparaison IN ('vide', 'non_vide') THEN x.attendu ELSE coalesce(x.attendu, 'null'::jsonb) END, x.tolerance
     FROM jsonb_to_recordset($2::jsonb) AS x(ordre smallint, libelle text, nature text, requete text, fonction text,
                                             arguments jsonb, comparaison text, attendu jsonb, tolerance numeric)
     WHERE NOT EXISTS (SELECT 1 FROM recette.operation o WHERE o.test_id = $1 AND o.ordre = x.ordre)`,
    [testId, lot],
  );
  await client.query('DELETE FROM recette.operation WHERE test_id = $1 AND ordre > $2', [testId, operations.length]);
}

/**
 * Importe des tests définis (texte YAML) dans la transaction du client : les
 * tests de même nom sont mis à jour. `remplacer` retire en plus les tests
 * définis en base absents du fichier ; `nouveaux` n'ajoute que les tests que la
 * base n'a pas, sans toucher aux autres (et rend leurs noms dans `ajoutes`).
 * Rend { importes, retires } ou lève avec la liste des erreurs.
 */
export async function importer(client, texte, { remplacer = false, nouveaux = false } = {}) {
  if (remplacer && nouveaux) throw new Error('remplacer et nouveaux s’excluent');
  const v = validerDefinitions(texte);
  if (v.erreurs) throw new Error(`tests définis invalides :\n  ${v.erreurs.join('\n  ')}`);
  if (nouveaux) {
    // Seulement les tests absents de la base : ceux qu'elle a restent tels quels
    const ajoutes = [];
    for (const t of v.tests) {
      const { rows } = await client.query(
        `INSERT INTO recette.test (origine, fichier, nom_complet, libelle, description, actif)
         VALUES ('base', NULL, $1, $1, $2, $3)
         ON CONFLICT ON CONSTRAINT test_unique DO NOTHING
         RETURNING id`,
        [t.nom, t.description, t.actif],
      );
      if (!rows.length) continue;
      await remplacerOperations(client, rows[0].id, t.operations);
      ajoutes.push(t.nom);
    }
    return { importes: ajoutes.length, retires: 0, ajoutes };
  }
  for (const t of v.tests) {
    const { rows: [{ id }] } = await client.query(
      `INSERT INTO recette.test (origine, fichier, nom_complet, libelle, description, actif)
       VALUES ('base', NULL, $1, $1, $2, $3)
       ON CONFLICT ON CONSTRAINT test_unique
       DO UPDATE SET description = EXCLUDED.description, actif = EXCLUDED.actif, modifie_le = now()
       RETURNING id`,
      [t.nom, t.description, t.actif],
    );
    await remplacerOperations(client, id, t.operations);
  }
  let retires = 0;
  if (remplacer) {
    const r = await client.query("DELETE FROM recette.test WHERE origine = 'base' AND NOT (nom_complet = ANY($1::text[]))", [v.tests.map((t) => t.nom)]);
    retires = r.rowCount;
  }
  return { importes: v.tests.length, retires };
}

/** Les noms des tests du texte que la base n'a pas. */
export async function absents(client, texte) {
  const v = validerDefinitions(texte);
  if (v.erreurs) throw new Error(`tests définis invalides :\n  ${v.erreurs.join('\n  ')}`);
  const { rows } = await client.query("SELECT nom_complet FROM recette.test WHERE origine = 'base'");
  const presents = new Set(rows.map((r) => r.nom_complet));
  return v.tests.map((t) => t.nom).filter((nom) => !presents.has(nom));
}

const ENTETE_YAML = `# Tests définis en base de la recette (recette/definis.mjs)
#
# Importés par « node recette/lancer.mjs importer », édités dans l'interface,
# réécrits par « node recette/lancer.mjs exporter ». Seize opérations au plus
# par test ; chacune est une requête SQL (sql, en lecture seule) ou un appel de
# fonction de la liste blanche (fonction + arguments), comparé à l'attendu.
# Comparaisons : egal (défaut), contient, nombre_lignes, vide, non_vide,
# tolerance (avec tolerance). Les requêtes lisent les schémas donnees (fichiers
# YAML du dépôt) et recette (campagnes).
`;

/** Les tests définis en base, en texte YAML (forme de validerDefinitions). */
export async function exporter(client) {
  const { rows: tests } = await client.query("SELECT id, nom_complet, description, actif FROM recette.test WHERE origine = 'base' ORDER BY nom_complet");
  const { rows: ops } = await client.query(
    "SELECT o.* FROM recette.operation o JOIN recette.test t ON t.id = o.test_id WHERE t.origine = 'base' ORDER BY o.test_id, o.ordre",
  );
  const doc = {
    version: 1,
    tests: tests.map((t) => {
      const sortie = { nom: t.nom_complet };
      if (t.description) sortie.description = t.description;
      if (!t.actif) sortie.actif = false;
      sortie.operations = ops.filter((o) => o.test_id === t.id).map((o) => {
        const x = { libelle: o.libelle };
        if (o.nature === 'sql') x.sql = o.requete;
        else { x.fonction = o.fonction; x.arguments = o.arguments ?? []; }
        if (o.comparaison !== 'egal') x.comparaison = o.comparaison;
        if (!SANS_ATTENDU.has(o.comparaison)) x.attendu = o.attendu;
        if (o.comparaison === 'tolerance') x.tolerance = Number(o.tolerance);
        return x;
      });
      return sortie;
    }),
  };
  return ENTETE_YAML + stringify(doc, { lineWidth: 0 });
}
