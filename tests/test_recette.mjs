/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  test_recette.mjs : recette de l'outillage de recette
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  La recette s'éprouve elle-même : ce qu'elle enregistre doit être ce que
 *  les suites ont fait, et ses gardes (16 opérations, lecture seule, jeton des
 *  formulaires) doivent tenir. Huit sections ; le pilotage (workflows,
 *  demandes, exécuteur) a sa propre suite, test_pilotage.mjs :
 *
 *     1. Rapporteur        flux d'événements → enregistrements, sur des
 *                          événements construits à la main
 *     2. Rapporteurs réels node --test sur une suite d'essai : JSONL et console
 *     3. Tests définis     comparaisons, liste blanche, validation, la graine
 *                          recette/tests-definis.yaml
 *     4. Infrastructure    compose, Dockerfile, scripts, variables, migrations
 *     5. PostgreSQL        migrations, contraintes (16 opérations…), chargeur,
 *                          comparaison, vues donnees, rôle de lecture, capacité
 *     6. Interface         pages, accessibilité structurelle, sûreté, édition
 *     7. Bout en bout      échange YAML aller-retour, import des seuls nouveaux
 *     8. Lanceur           interruption (SIGINT, SIGTERM), campagne créée sous
 *                          son verrou
 *
 *  Les sections 5 à 7 exigent la base (RECETTE_PG_URL, et RECETTE_PG_LECTURE_URL
 *  pour le rôle de lecture), comme le second test de la section 8 : sans elle,
 *  ils sont omis avec leur motif.
 *  Elles n'écrivent rien de durable : tout passe dans des transactions annulées,
 *  sauf l'édition par l'interface, qui nettoie ce qu'elle crée. Les campagnes
 *  d'essai prennent des numéros négatifs : la numérotation des vraies
 *  campagnes reste continue.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { after, before, describe, test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { parse, stringify } from 'yaml';

import { fermer, joignable, migrationsDisponibles, migrer, ouvrir } from '../recette/base.mjs';
import { charger, totaux } from '../recette/charger.mjs';
import {
  COMPARAISONS, FONCTIONS, LIGNES_MAX, absents, executerOperation, executerRequete, executerTest, exporter, importer,
  jsonComplet, normaliserLignes, validerDefinitions, validerOperation, verifier,
} from '../recette/definis.mjs';
import { assainir, textePropre } from '../recette/base.mjs';
import { chargerDocuments } from '../recette/documents.mjs';
import { creerApplication, demarrer } from '../interface/serveur.mjs';
import { CLE_CAMPAGNE, cloreOrphelines, creerCampagne, garderInterruption, main as lancer } from '../recette/lancer.mjs';
import { conclure, nouvelEtat, traiter } from './outils/rapporteur-recette.mjs';
import { decompte, lignesFichier } from './outils/rapporteur-console.mjs';
import { MAX_OPERATIONS, PREFIXE_ETAPE, scenario, table } from './outils/etapes.mjs';
import { RACINE } from './outils/depot.mjs';
import { trouve } from './outils/environnement.mjs';
import { defautsAccessibilite } from './outils/pages.mjs';

const lire = (relatif) => readFileSync(join(RACINE, relatif), 'utf8');
const SEMENCE = lire('recette/tests-definis.yaml');

// ── La base, si elle est là ──────────────────────────────────────────────────
let POOLS = null;
let SANS_BASE = 'RECETTE_PG_URL absente : à exécuter dans la VM de recette (ou avec une base locale)';
if (process.env.RECETTE_PG_URL) {
  try {
    POOLS = ouvrir({ nom: 'recette-7e-tests' });
    SANS_BASE = (await joignable(POOLS.principal)) ? false : 'PostgreSQL injoignable à RECETTE_PG_URL';
    if (!SANS_BASE) await migrer(POOLS.principal);
  } catch (e) {
    SANS_BASE = `base inutilisable : ${e.message}`;
  }
}
const SANS_LECTURE = SANS_BASE || (POOLS?.lectureDediee ? false : 'RECETTE_PG_LECTURE_URL absente : le rôle de lecture n’est pas éprouvé');
after(async () => { if (POOLS) await fermer(POOLS); });

/** Exécute fn(client) dans une transaction toujours annulée : rien ne reste en base. */
async function enEssai(fn) {
  const client = await POOLS.principal.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
  }
}

/** Le code d'erreur PostgreSQL d'une promesse qui doit échouer. */
async function codeErreur(promesse) {
  try {
    await promesse;
    return 'aucune erreur';
  } catch (e) {
    return e.code ?? e.message;
  }
}

// Campagnes d'essai : identifiants négatifs, sans toucher à la séquence
let prochaineCampagne = -1000 - (process.pid % 1000) * 10;
const campagneEssai = async (c, libelle = 'essai') => {
  prochaineCampagne -= 1;
  const { rows: [{ id }] } = await c.query('INSERT INTO recette.campagne (id, libelle) OVERRIDING SYSTEM VALUE VALUES ($1, $2) RETURNING id', [prochaineCampagne, libelle]);
  return id;
};

// ════════════════════════════════════════════════════════════════════════════
describe('1. Rapporteur de la recette : des événements aux enregistrements', () => {
  const RACINE_ESSAI = '/depot';
  const F = `${RACINE_ESSAI}/tests/test_a.mjs`;
  const G = `${RACINE_ESSAI}/tests/test_b.mjs`;
  const assertion = (message) => ({ failureType: 'testCodeFailure', cause: { code: 'ERR_ASSERTION', name: 'AssertionError', message } });
  const exception = (message) => ({ failureType: 'testCodeFailure', cause: { name: 'TypeError', message } });
  const etape = (test, ordre, statut = 'reussie') => ({ type: 'test:diagnostic', data: { file: F, nesting: 2, message: PREFIXE_ETAPE + JSON.stringify({ test, ordre, libelle: `étape ${ordre}`, entree: null, attendu: 1, duree_ms: 0.1, statut, obtenu: 1, message: null }) } });
  const ev = (type, file, nesting, name, extra = {}) => ({ type, data: { file, nesting, name, ...extra } });
  const FLUX = [
    ev('test:start', F, 0, 'S'), ev('test:start', F, 1, 'T'), ev('test:start', F, 2, 'x'),
    ev('test:pass', F, 2, 'x', { details: { type: 'test', duration_ms: 1.23456 } }),
    etape('S > T > x', 1), etape('S > T > x', 2, 'echouee'),
    ev('test:start', F, 2, 'y'), ev('test:pass', F, 2, 'y', { skip: 'pas ici', details: { type: 'test', duration_ms: 0 } }),
    ev('test:start', F, 2, 'z'), ev('test:fail', F, 2, 'z', { todo: 'plus tard', details: { type: 'test', duration_ms: 1, error: assertion('1 !== 2') } }),
    ev('test:pass', F, 1, 'T', { details: { type: 'suite', duration_ms: 3 } }),
    ev('test:start', F, 1, 'w'), ev('test:fail', F, 1, 'w', { details: { type: 'test', duration_ms: 2, error: assertion('attendu 3') } }),
    ev('test:fail', F, 0, 'S', { details: { type: 'suite', duration_ms: 5, error: { failureType: 'subtestsFailed', message: '1 subtest failed' } } }),
    ev('test:start', F, 0, 'haut'), ev('test:fail', F, 0, 'haut', { details: { type: 'test', duration_ms: 1, error: exception('boum') } }),
    ev('test:start', G, 0, 'b1'), ev('test:pass', G, 0, 'b1', { details: { type: 'test', duration_ms: 1 } }),
    { type: 'test:diagnostic', data: { file: G, nesting: 0, message: 'Error: chargement raté' } },
    ev('test:start', G, 0, 'test_b.mjs'), ev('test:fail', G, 0, 'test_b.mjs', { details: { type: 'test', duration_ms: 1, error: { failureType: 'testCodeFailure', message: 'test failed' } } }),
    { type: 'test:diagnostic', data: { nesting: 0, message: 'tests 7' } },
  ];
  const lignes = (() => { const e = nouvelEtat(RACINE_ESSAI); for (const x of FLUX) traiter(e, x); return conclure(e); })();
  const parNom = (n) => lignes.find((l) => l.nom_complet === n);

  test('noms complets, suites, fichiers relatifs', (t) => table(t, [
    ['un enregistrement par test, plus le résumé', () => lignes.map((l) => l.type === 'resume' ? 'resume' : l.nom_complet), ['S > T > x', 'S > T > y', 'S > T > z', 'S > w', 'haut', 'b1', 'test_b.mjs', 'resume']],
    ['la suite qui échoue par ses tests n’est pas enregistrée', () => parNom('S'), undefined],
    ['suite englobante et libellé', () => [parNom('S > T > x').suite, parNom('S > T > x').libelle], ['S > T', 'x']],
    ['test de premier niveau : sans suite', () => parNom('haut').suite, null],
    ['fichier relatif à la racine', () => parNom('b1').fichier, 'tests/test_b.mjs'],
    ['durée arrondie au millième de milliseconde', () => parNom('S > T > x').duree_ms, 1.235],
    ['origine : fichier', () => new Set(lignes.filter((l) => l.type === 'test').map((l) => l.origine)), new Set(['fichier'])],
  ]));

  test('statuts : réussi, omis, à faire, en échec, en erreur', (t) => table(t, [
    ['réussi', () => parNom('S > T > x').statut, 'reussi'],
    ['omis, avec son motif', () => [parNom('S > T > y').statut, parNom('S > T > y').motif], ['omis', 'pas ici']],
    ['à faire, avec son motif', () => [parNom('S > T > z').statut, parNom('S > T > z').motif], ['a_faire', 'plus tard']],
    ['échec d’assertion : en échec, message d’origine', () => [parNom('S > w').statut, parNom('S > w').motif], ['echoue', 'attendu 3']],
    ['exception inattendue : en erreur', () => [parNom('haut').statut, parNom('haut').motif], ['erreur', 'boum']],
    ['échec de chargement d’un fichier : en erreur, diagnostics joints', () => [parNom('test_b.mjs').statut, parNom('test_b.mjs').motif], ['erreur', 'test failed\nError: chargement raté']],
  ]));

  test('opérations rattachées à leur test, résumé', (t) => table(t, [
    ['les étapes du test x', () => parNom('S > T > x').etapes.map((e) => [e.ordre, e.statut]), [[1, 'reussie'], [2, 'echouee']]],
    ['le nom du test n’est pas répété dans l’étape', () => Object.hasOwn(parNom('S > T > x').etapes[0], 'test'), false],
    ['les autres tests n’ont pas d’étape', () => parNom('S > w').etapes, []],
    ['résumé', () => lignes.at(-1), { type: 'resume', tests: 7, reussis: 2, echoues: 1, erreurs: 2, omis: 1, a_faire: 1, operations: 2, operations_orphelines: 0 }],
  ]));

  test('cas limites : noms répétés, étapes orphelines, plafond de 16', (t) => {
    const e = nouvelEtat('/r');
    for (const n of [1, 2]) {
      traiter(e, ev('test:start', '/r/f.mjs', 0, 'même'));
      traiter(e, ev('test:pass', '/r/f.mjs', 0, 'même', { details: { type: 'test', duration_ms: n } }));
    }
    for (let i = 1; i <= 18; i += 1) traiter(e, { type: 'test:diagnostic', data: { file: '/r/f.mjs', nesting: 0, message: PREFIXE_ETAPE + JSON.stringify({ test: 'même', ordre: i, statut: 'reussie' }) } });
    traiter(e, { type: 'test:diagnostic', data: { file: '/r/f.mjs', nesting: 0, message: PREFIXE_ETAPE + JSON.stringify({ test: 'inconnu', ordre: 1 }) } });
    traiter(e, { type: 'test:diagnostic', data: { file: '/r/f.mjs', nesting: 0, message: `${PREFIXE_ETAPE}{json illisible` } });
    const l = conclure(e);
    return table(t, [
      ['un nom répété est numéroté', () => l.filter((x) => x.type === 'test').map((x) => x.nom_complet), ['même', 'même [2]']],
      ['les étapes vont au dernier test de ce nom', () => [l[0].etapes.length, l[1].etapes.length], [0, MAX_OPERATIONS]],
      ['seize opérations au plus par enregistrement', () => Math.max(...l.filter((x) => x.type === 'test').map((x) => x.etapes.length)), MAX_OPERATIONS],
      ['une étape sans test connu est comptée orpheline', () => l.at(-1).operations_orphelines, 1],
      ['un diagnostic illisible est ignoré sans lever', () => l.length, 3],
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('2. Rapporteurs sur une vraie exécution de node --test', () => {
  const rep = mkdtempSync(join(tmpdir(), 'r7e-rapport-'));
  after(() => rmSync(rep, { recursive: true, force: true }));
  const etapesUrl = pathToFileURL(join(RACINE, 'tests', 'outils', 'etapes.mjs')).href;
  writeFileSync(join(rep, 'essai.test.mjs'), `
import { describe, test } from 'node:test';
import { scenario, table } from ${JSON.stringify(etapesUrl)};
describe('Groupe', () => {
  test('deux étapes réussies', (t) => table(t, [['un', () => 1, 1], ['deux', () => 2, 2]]));
  test('une étape en échec', (t) => table(t, [['bonne', () => 'a', 'a'], ['mauvaise', () => 3, 4]]));
  test('omis ici', { skip: 'motif d’essai' }, () => {});
  test('à faire', { todo: 'plus tard' }, (t) => table(t, [['pas encore', () => false, true]]));
});
test('erreur inattendue', (t) => { scenario(t).etape('lève', () => { throw new TypeError('boum'); }); });
`);
  const jsonl = join(rep, 'rapport.jsonl');
  const r = spawnSync(process.execPath, [
    '--test', `--test-reporter=${join(RACINE, 'tests', 'outils', 'rapporteur-recette.mjs')}`, `--test-reporter-destination=${jsonl}`,
    `--test-reporter=${join(RACINE, 'tests', 'outils', 'rapporteur-console.mjs')}`, '--test-reporter-destination=stdout',
    'essai.test.mjs',
  ], { cwd: rep, encoding: 'utf8', timeout: 60000, env: { ...process.env, NODE_TEST_CONTEXT: undefined } });
  const lignes = (() => { try { return readFileSync(jsonl, 'utf8').trim().split('\n').map((l) => JSON.parse(l)); } catch { return []; } })();
  const parNom = (n) => lignes.find((l) => l.nom_complet === n) ?? {};

  test('le rapport JSONL de la recette', (t) => table(t, [
    ['node --test signale l’échec (code 1)', () => r.status, 1],
    ['cinq tests, puis le résumé', () => lignes.length, 6],
    ['fichier relatif au répertoire courant', () => parNom('Groupe > deux étapes réussies').fichier, 'essai.test.mjs'],
    ['réussi, deux opérations réussies', () => [parNom('Groupe > deux étapes réussies').statut, parNom('Groupe > deux étapes réussies').etapes.map((e) => e.statut)], ['reussi', ['reussie', 'reussie']]],
    ['en échec : l’opération fautive et ses valeurs', () => { const e = parNom('Groupe > une étape en échec').etapes[1]; return [parNom('Groupe > une étape en échec').statut, e.statut, e.attendu, e.obtenu]; }, ['echoue', 'echouee', 4, 3]],
    ['omis, avec son motif', () => [parNom('Groupe > omis ici').statut, parNom('Groupe > omis ici').motif], ['omis', 'motif d’essai']],
    ['à faire, opération consignée', () => [parNom('Groupe > à faire').statut, parNom('Groupe > à faire').etapes.length], ['a_faire', 1]],
    ['exception : en erreur, opération en erreur', () => [parNom('erreur inattendue').statut, parNom('erreur inattendue').etapes[0]?.statut], ['erreur', 'erreur']],
    ['résumé', () => lignes.at(-1), { type: 'resume', tests: 5, reussis: 1, echoues: 1, erreurs: 1, omis: 1, a_faire: 1, operations: 6, operations_orphelines: 0 }],
  ]));

  test('le rapporteur console', (t) => table(t, [
    ['une ligne pour le fichier, en échec', () => /^✖ essai\.test\.mjs : 1 réussi · 1 en échec · 1 en erreur · 1 omis · 1 à faire · 6 opérations · \d+,\d s$/m.test(r.stdout), true],
    ['le détail de l’échec : rang, libellé, attendu et obtenu', () => [r.stdout.includes('#2 mauvaise (echouee)'), r.stdout.includes('attendu 4 ; obtenu 3')], [true, true]],
    ['l’erreur et son message', () => r.stdout.includes('✖ erreur : erreur inattendue'), true],
    ['omis et à faire, avec leurs motifs', () => [r.stdout.includes('○ omis : Groupe > omis ici (motif d’essai)'), r.stdout.includes('◌ à faire : Groupe > à faire (plus tard)')], [true, true]],
    ['le bilan final', () => /✖ Recette : 5 tests · 1 réussi · 1 en échec · 1 en erreur · 1 omis · 1 à faire · 6 opérations/.test(r.stdout), true],
    ['décompte en mots, sans zéro superflu', () => decompte([{ statut: 'reussi', etapes: [{}, {}] }]), '1 réussi · 2 opérations'],
    ['lignes d’un fichier sans échec', () => lignesFichier('f.mjs', [{ statut: 'reussi', etapes: [] }], 1500), ['✔ f.mjs : 1 réussi · 0 opération · 1,5 s']],
  ]));
});

// ════════════════════════════════════════════════════════════════════════════
describe('3. Tests définis en base : comparaisons, liste blanche, validation', () => {
  const echec = (fn) => { try { fn(); return 'aucun échec'; } catch (e) { return e instanceof assert.AssertionError ? 'échec' : `erreur : ${e.message}`; } };
  const essai = (o) => validerOperation(o).erreurs ?? null;

  test('comparaisons (verifier)', (t) => table(t, [
    ['égal : profond, ordre des clés indifférent', () => echec(() => verifier({ comparaison: 'egal', attendu: { a: 1, b: [2] } }, { b: [2], a: 1 }, 1)), 'aucun échec'],
    ['égal : 35 ≠ "35"', () => echec(() => verifier({ comparaison: 'egal', attendu: 35 }, '35', 1)), 'échec'],
    ['contient : sous-texte', () => echec(() => verifier({ comparaison: 'contient', attendu: 'lecture' }, 'rôle de lecture', 1)), 'aucun échec'],
    ['contient : éléments d’une liste', () => echec(() => verifier({ comparaison: 'contient', attendu: [2, 3] }, [1, 2, 3], 3)), 'aucun échec'],
    ['contient : sous-table d’une ligne', () => echec(() => verifier({ comparaison: 'contient', attendu: [{ id: '1.1' }] }, [{ id: '1.1', terme: 'elements' }], 1)), 'aucun échec'],
    ['contient : absent', () => echec(() => verifier({ comparaison: 'contient', attendu: [4] }, [1, 2, 3], 3)), 'échec'],
    ['nombre de lignes', () => [echec(() => verifier({ comparaison: 'nombre_lignes', attendu: 2 }, [], 2)), echec(() => verifier({ comparaison: 'nombre_lignes', attendu: 2 }, [], 3))], ['aucun échec', 'échec']],
    ['vide et non vide', () => [echec(() => verifier({ comparaison: 'vide' }, [], 0)), echec(() => verifier({ comparaison: 'vide' }, ['x'], 1)), echec(() => verifier({ comparaison: 'non_vide' }, ['x'], 1)), echec(() => verifier({ comparaison: 'non_vide' }, [], 0))], ['aucun échec', 'échec', 'aucun échec', 'échec']],
    ['tolérance', () => [echec(() => verifier({ comparaison: 'tolerance', attendu: 1.12, tolerance: 0.01 }, 1.125, 1)), echec(() => verifier({ comparaison: 'tolerance', attendu: 1.12, tolerance: 0.001 }, 1.13, 1))], ['aucun échec', 'échec']],
    ['comparaison inconnue : erreur, pas échec', () => echec(() => verifier({ comparaison: 'environ' }, 1, 1)), 'erreur : comparaison inconnue : environ'],
    ['les six comparaisons, celles de la base', () => COMPARAISONS, ['egal', 'contient', 'nombre_lignes', 'vide', 'non_vide', 'tolerance']],
  ]));

  test('forme des résultats SQL (normaliserLignes)', (t) => table(t, [
    ['une colonne, une ligne : la valeur', () => normaliserLignes([{ count: 35 }], [{ name: 'count' }]), 35],
    ['une colonne, plusieurs lignes : la liste des valeurs', () => normaliserLignes([{ id: 'a' }, { id: 'b' }], [{ name: 'id' }]), ['a', 'b']],
    ['une colonne, aucune ligne : liste vide', () => normaliserLignes([], [{ name: 'id' }]), []],
    ['plusieurs colonnes : la liste des lignes', () => normaliserLignes([{ a: 1, b: 2 }], [{ name: 'a' }, { name: 'b' }]), [{ a: 1, b: 2 }]],
  ]));

  test('liste blanche : fonctions pures, jq sans environnement', async (t) => {
    const ancien = process.env.RECETTE_PG_URL_TEMOIN;
    process.env.RECETTE_PG_URL_TEMOIN = 'postgres://secret:secret@base/recette';
    try {
      return await table(t, [
        ['treize fonctions, chacune documentée', () => [Object.keys(FONCTIONS).length, Object.values(FONCTIONS).every((f) => f.signature && f.aide && typeof f.appeler === 'function')], [13, true]],
        ['valeur complète pour comparer, jamais tronquée', () => jsonComplet({ n: Infinity, l: Array.from({ length: 600 }, (_, i) => i) }).l.length, 600],
        ['arrondi au pair (parité Python)', () => [FONCTIONS.arrondi.appeler(1.125, 2), FONCTIONS.arrondi.appeler(2.675, 2)], [1.12, 2.67]],
        ['agrégation depuis des objets simples', () => FONCTIONS.agreger.appeler([{ resultat: 'conforme' }], true), 3],
        ['combinaison : un résultat de journal', () => FONCTIONS.combiner.appeler('commande', [{ resultat: 'conforme' }, { resultat: 'absent', constat: 'x' }]), { type: 'commande', resultat: 'partiel', constat: '1/2 conformes ; x' }],
        ['assertion du modèle : IN.1 sur un manifeste choisi', () => FONCTIONS.assertion.appeler('IN.1', 'manifeste', { invariants: ['axiome', 'cycle', 'contrats'] }), true],
        ['assertion d’un critère inconnu : erreur claire', () => { try { FONCTIONS.assertion.appeler('9.9', 'manifeste', {}); return null; } catch (e) { return e.message; } }, 'critère inconnu du modèle : 9.9'],
        ['jq ne voit que PATH (aucune URL de connexion)', () => FONCTIONS.jq.appeler('env | keys'), ['PATH']],
        ['jq : une expression fausse lève', async () => { try { await FONCTIONS.jq.appeler('.['); return null; } catch (e) { return e.message.startsWith('jq :'); } }, true],
        ['jq : import et include refusés (aucun accès aux fichiers)', async () => { try { await FONCTIONS.jq.appeler('import "etc/passwd" as $f {search: "/"}; $f'); return null; } catch (e) { return e.message; } }, 'jq : import et include sont refusés (aucun accès aux fichiers)'],
        ['jq : une boucle sans fin est coupée au délai', async () => { const debut = Date.now(); try { await FONCTIONS.jq.appeler('def f: f; f'); return null; } catch (e) { return [e.message, Date.now() - debut < 8000]; } }, ['jq : délai dépassé (5 s)', true]],
        ['bornes des arguments : fixe(1, 1e8) refusé sans calcul', () => { try { FONCTIONS.fixe.appeler(1, 1e8); return null; } catch (e) { return e.message; } }, 'chiffres : un entier de 0 à 20 est attendu (reçu 100000000)'],
      ]);
    } finally {
      if (ancien === undefined) delete process.env.RECETTE_PG_URL_TEMOIN; else process.env.RECETTE_PG_URL_TEMOIN = ancien;
    }
  });

  test('exécution d’opérations et de tests sans base', async (t) => {
    const op = (x) => ({ ordre: 1, libelle: 'essai', nature: 'fonction', comparaison: 'egal', ...x });
    return table(t, [
      ['réussie', async () => (await executerOperation(op({ fonction: 'arrondi', arguments: [1.125, 2], attendu: 1.12 }))).statut, 'reussie'],
      ['en échec : obtenu consigné', async () => { const r = await executerOperation(op({ fonction: 'arrondi', arguments: [1.125, 2], attendu: 1.13 })); return [r.statut, r.obtenu, r.attendu]; }, ['echouee', 1.12, 1.13]],
      ['en erreur : fonction hors liste', async () => { const r = await executerOperation(op({ fonction: 'eval', arguments: ['1'] })); return [r.statut, r.message]; }, ['erreur', 'fonction hors de la liste blanche : eval']],
      ['une étape est inexécutable ici', async () => (await executerOperation(op({ nature: 'etape' }))).statut, 'erreur'],
      ['l’entrée décrit l’appel', async () => (await executerOperation(op({ fonction: 'quote', arguments: ['a b'], attendu: "'a b'" }))).entree, { fonction: 'quote', arguments: ['a b'], comparaison: 'egal' }],
      ['un test va au bout de ses opérations après un échec', async () => {
        const r = await executerTest({ id: 1, nom_complet: 'n', libelle: 'n' }, [op({ ordre: 1, fonction: 'present', arguments: [0], attendu: false }), op({ ordre: 2, fonction: 'present', arguments: [0], attendu: true })]);
        return [r.statut, r.etapes.map((e) => e.statut), r.motif];
      }, ['echoue', ['echouee', 'reussie'], '1 opération(s) en échec sur 2 : #1']],
      ['un test sans opération est omis', async () => (await executerTest({ id: 1, nom_complet: 'n', libelle: 'n' }, [])).statut, 'omis'],
      ['un grand obtenu se compare entier, puis s’enregistre borné', async () => { const r = await executerOperation(op({ fonction: 'jq', arguments: ['[range(0;600)]'], attendu: Array.from({ length: 600 }, (_, i) => i) })); return [r.statut, r.obtenu?.['§']]; }, ['reussie', 'tronque']],
      ['l’enregistrement a la forme du rapporteur (origine base)', async () => Object.keys(await executerTest({ id: 7, nom_complet: 'n', libelle: 'n' }, [])), ['type', 'origine', 'test_id', 'fichier', 'nom_complet', 'suite', 'libelle', 'statut', 'motif', 'duree_ms', 'etapes']],
    ]);
  });

  test('validation d’une opération saisie', (t) => table(t, [
    ['valide : requête', () => validerOperation({ libelle: 'l', sql: 'SELECT 1', attendu: 1 }).operation, { libelle: 'l', nature: 'sql', requete: 'SELECT 1', fonction: null, arguments: null, comparaison: 'egal', attendu: 1, tolerance: null }],
    ['libellé obligatoire', () => essai({ sql: 'SELECT 1', attendu: 1 }).libelle, 'Le libellé est obligatoire.'],
    ['requête et fonction : l’une ou l’autre', () => [essai({ libelle: 'l', attendu: 1 }).nature, essai({ libelle: 'l', sql: 'x', fonction: 'arrondi', attendu: 1 }).nature].every(Boolean), true],
    ['fonction hors liste', () => essai({ libelle: 'l', fonction: 'exec', attendu: 1 }).fonction, 'Fonction hors de la liste blanche : exec.'],
    ['arguments : une liste', () => Boolean(essai({ libelle: 'l', fonction: 'arrondi', arguments: { x: 1 }, attendu: 1 }).arguments), true],
    ['attendu obligatoire, sauf vide et non vide', () => [Boolean(essai({ libelle: 'l', sql: 'x' })?.attendu), essai({ libelle: 'l', sql: 'x', comparaison: 'vide' })], [true, null]],
    ['attendu null permis', () => validerOperation({ libelle: 'l', fonction: 'agreger', arguments: [[]], attendu: null }).operation?.attendu, null],
    ['tolérance : nombre positif, et seulement pour « tolerance »', () => [Boolean(essai({ libelle: 'l', sql: 'x', comparaison: 'tolerance', attendu: 1 })?.tolerance), Boolean(essai({ libelle: 'l', sql: 'x', attendu: 1, tolerance: 0.1 })?.tolerance)], [true, true]],
  ]));

  test('validation d’un fichier de tests définis', (t) => {
    const fichier = (tests) => stringify({ version: 1, tests });
    const op = (i) => ({ libelle: `op ${i}`, sql: `SELECT ${i}`, attendu: i });
    return table(t, [
      ['seize opérations : accepté', () => validerDefinitions(fichier([{ nom: 'seize', operations: Array.from({ length: 16 }, (_, i) => op(i)) }])).tests[0].operations.length, 16],
      ['dix-sept : refusé', () => validerDefinitions(fichier([{ nom: 'dix-sept', operations: Array.from({ length: 17 }, (_, i) => op(i)) }])).erreurs, ['tests[0] (dix-sept) : 17 opérations, 16 au plus']],
      ['aucune opération : accepté (un test tout juste créé s’exporte ainsi)', () => validerDefinitions(fichier([{ nom: 'vide', operations: [] }])).tests?.[0].operations, []],
      ['nom de plus de 500 caractères : refusé', () => validerDefinitions(fichier([{ nom: 'n'.repeat(501), operations: [op(1)] }])).erreurs?.length, 1],
      ['nom en double : refusé', () => validerDefinitions(fichier([{ nom: 'n', operations: [op(1)] }, { nom: 'n', operations: [op(1)] }])).erreurs, ['tests[1] (n) : nom en double']],
      ['erreur d’opération située', () => validerDefinitions(fichier([{ nom: 'n', operations: [{ libelle: 'l', fonction: 'exec', attendu: 1 }] }])).erreurs, ['tests[0] (n), opération 1 : Fonction hors de la liste blanche : exec.']],
      ['YAML illisible', () => validerDefinitions('tests: [').erreurs.length, 1],
      ['sans liste « tests »', () => validerDefinitions('version: 1').erreurs, ['le fichier doit porter une liste « tests »']],
      ['rangs attribués dans l’ordre', () => validerDefinitions(fichier([{ nom: 'n', operations: [op(1), op(2)] }])).tests[0].operations.map((o) => o.ordre), [1, 2]],
      ['actif par défaut', () => validerDefinitions(fichier([{ nom: 'n', operations: [op(1)] }])).tests[0].actif, true],
    ]);
  });

  test('la graine recette/tests-definis.yaml', (t) => {
    const v = validerDefinitions(SEMENCE);
    const doc = parse(SEMENCE);
    return table(t, [
      ['valide', () => v.erreurs ?? [], []],
      ['au moins vingt tests', () => v.tests.length >= 20, true],
      ['seize opérations au plus par test', () => Math.max(...v.tests.map((x) => x.operations.length)) <= MAX_OPERATIONS, true],
      ['des requêtes SQL et des appels de fonction', () => [...new Set(v.tests.flatMap((x) => x.operations.map((o) => o.nature)))].sort(), ['fonction', 'sql']],
      ['chaque fonction appelée est de la liste blanche', () => v.tests.flatMap((x) => x.operations).filter((o) => o.fonction && !FONCTIONS[o.fonction]).length, 0],
      ['les requêtes ne lisent que donnees et recette', () => v.tests.flatMap((x) => x.operations).filter((o) => o.requete && /\b(?:pg_catalog|information_schema|public)\./i.test(o.requete)).length, 0],
      ['aucune requête n’écrit (mots clés d’écriture)', () => v.tests.flatMap((x) => x.operations).filter((o) => o.requete && /\b(?:insert|update|delete|drop|alter|create|truncate|grant)\b/i.test(o.requete)).map((o) => o.libelle), []],
      ['les tris de texte sont indépendants de la collation', () => v.tests.flatMap((x) => x.operations).filter((o) => o.requete && /array_agg\(\s*(critere|id)\s+ORDER BY\s+\1\s*\)/i.test(o.requete)).length, 0],
      ['format g : attendus cités (sinon YAML les lit en nombres)', () => doc.tests.flatMap((x) => x.operations).filter((o) => o.fonction === 'formatG').every((o) => typeof o.attendu === 'string'), true],
      ['les fonctions de référence redonnent les attendus', async () => {
        const ops = v.tests.flatMap((x) => x.operations).filter((o) => o.nature === 'fonction' && o.comparaison === 'egal');
        const ecarts = [];
        for (const o of ops) {
          try { assert.deepStrictEqual(jsonComplet(await FONCTIONS[o.fonction].appeler(...o.arguments)), o.attendu); } catch { ecarts.push(o.libelle); }
        }
        return ecarts;
      }, []],
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('4. Infrastructure : compose, image, scripts, variables', () => {
  const compose = parse(lire('compose.recette.yaml'), { merge: true });
  const dockerfile = lire('Dockerfile.recette');
  const exemple = lire('.env.recette.example');
  const variablesExemple = new Set([...exemple.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
  const variablesCompose = new Set([...lire('compose.recette.yaml').matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));

  test('compose.recette.yaml', (t) => table(t, [
    ['quatre services : base, interface, executeur, recette', () => Object.keys(compose.services), ['base', 'interface', 'executeur', 'recette']],
    ['PostgreSQL 16 épinglé à la version mineure', () => /^postgres:16\.\d+-\w+$/.test(compose.services.base.image), true],
    ['aucun port publié pour la base', () => compose.services.base.ports, undefined],
    ['les rôles créés au premier démarrage', () => compose.services.base.volumes.includes('./recette/initdb:/docker-entrypoint-initdb.d:ro'), true],
    ['l’interface n’écoute que sur 127.0.0.1 de la VM', () => compose.services.interface.ports.every((p) => p.startsWith('127.0.0.1:')), true],
    ['l’interface : utilisateur non root, système de fichiers en lecture seule', () => [compose.services.interface.user, compose.services.interface.read_only], ['node', true]],
    ['le dépôt monté en lecture seule', () => ['interface', 'executeur', 'recette'].map((s) => compose.services[s].volumes[0]), ['.:/depot:ro', '.:/depot:ro', '.:/depot:ro']],
    ['le socket Docker : au lanceur et à l’exécuteur, jamais à l’interface', () => Object.keys(compose.services).filter((s) => (compose.services[s].volumes ?? []).some((v) => v.includes('docker.sock'))), ['executeur', 'recette']],
    ['le lanceur, à la demande (profil outils)', () => compose.services.recette.profiles, ['outils']],
    ['bilans de santé : base, interface, exécuteur', () => ['base', 'interface', 'executeur'].map((s) => Boolean(compose.services[s].healthcheck)), [true, true, true]],
    ['l’interface et l’exécuteur attendent une base saine', () => ['interface', 'executeur'].map((s) => compose.services[s].depends_on.base.condition), ['service_healthy', 'service_healthy']],
    ['chaque variable de compose est documentée dans .env.recette.example', () => [...variablesCompose].filter((v) => !variablesExemple.has(v)), []],
    ['mots de passe obligatoires (${…:?…})', () => ['PG_MOT_DE_PASSE_ADMIN', 'RECETTE_MOT_DE_PASSE', 'RECETTE_LECTURE_MOT_DE_PASSE'].every((v) => new RegExp(`\\$\\{${v}:\\?`).test(lire('compose.recette.yaml'))), true],
    ['docker compose accepte le fichier', () => {
      if (!trouve('docker') || spawnSync('docker', ['compose', 'version']).status !== 0) return 'docker compose absent : non vérifié';
      const r = spawnSync('docker', ['compose', '-f', 'compose.recette.yaml', '--env-file', '.env.recette.example', '--profile', 'outils', 'config', '--quiet'], { cwd: RACINE, encoding: 'utf8' });
      return r.status === 0 ? 'valide' : r.stderr.trim();
    }, trouve('docker') && spawnSync('docker', ['compose', 'version']).status === 0 ? 'valide' : 'docker compose absent : non vérifié'],
  ]));

  test('Dockerfile.recette et son contexte', (t) => {
    const ignore = lire('Dockerfile.recette.dockerignore').split('\n').filter((l) => l && !l.startsWith('#'));
    const copies = [...dockerfile.matchAll(/^COPY (?:--\S+ )*(.+?) \S+$/gm)].flatMap((m) => m[1].split(/\s+/));
    const versionGitleaks = (texte) => /gitleaks(?:_|\/releases\/download\/v|_VERSION=)(\d+\.\d+\.\d+)/i.exec(texte)?.[1];
    return table(t, [
      ['image de base épinglée : node 22, version complète', () => /^FROM node:22\.\d+\.\d+-\S+$/m.test(dockerfile), true],
      ['même majeure de Node que l’image du résolveur', () => /^FROM node:22[-.]/m.test(lire('Dockerfile')), true],
      ['même gitleaks que l’image du résolveur', () => versionGitleaks(dockerfile), versionGitleaks(lire('Dockerfile'))],
      ['gitleaks vérifié par une empreinte épinglée, par architecture', () => [/ARG GITLEAKS_SHA256_AMD64=[0-9a-f]{64}/.test(dockerfile), /ARG GITLEAKS_SHA256_ARM64=[0-9a-f]{64}/.test(dockerfile), /sha256sum -c/.test(dockerfile), /checksums\.txt/.test(dockerfile)], [true, true, true, false]],
      ['client Docker depuis le dépôt apt officiel, clé signée', () => [/download\.docker\.com\/linux\/debian/.test(dockerfile), /Signed-By: \/etc\/apt\/keyrings\/docker\.asc/.test(dockerfile)], [true, true]],
      ['dépendances depuis le verrou (npm ci)', () => /npm ci\b/.test(dockerfile), true],
      ['point d’entrée : recette/entree.sh', () => /^ENTRYPOINT \["recette-entree"\]$/m.test(dockerfile), true],
      ['le contexte n’envoie que les fichiers copiés', () => [ignore[0], copies.filter((c) => !ignore.includes(`!${c}`))], ['*', []]],
    ]);
  });

  test('scripts : syntaxe, garde-fous, ShellCheck', (t) => {
    const vm = lire('vm/preparer-vm.sh');
    const shellcheck = trouve('shellcheck');
    return table(t, [
      ['entree.sh et 10-roles.sh : sh les accepte', () => ['recette/entree.sh', 'recette/initdb/10-roles.sh'].filter((f) => spawnSync('sh', ['-n', join(RACINE, f)]).status !== 0), []],
      ['preparer-vm.sh : bash l’accepte', () => spawnSync('bash', ['-n', join(RACINE, 'vm/preparer-vm.sh')]).status, 0],
      ['ShellCheck sans avertissement', () => (shellcheck ? spawnSync('shellcheck', ['-x', 'vm/preparer-vm.sh', 'recette/entree.sh', 'recette/initdb/10-roles.sh'], { cwd: RACINE, encoding: 'utf8' }).stdout.trim() : 'shellcheck absent'), shellcheck ? '' : 'shellcheck absent'],
      ['preparer-vm.sh : mode strict', () => vm.includes('set -euo pipefail'), true],
      ['dépôt apt de Docker au format deb822, clé signée', () => [vm.includes('/etc/apt/sources.list.d/docker.sources'), vm.includes('Signed-By: /etc/apt/keyrings/docker.asc')], [true, true]],
      ['paquets en conflit retirés (liste de la documentation Docker)', () => ['docker.io', 'docker-compose', 'docker-compose-v2', 'docker-doc', 'docker-buildx', 'podman-docker', 'containerd', 'runc'].every((p) => vm.includes(p)), true],
      ['.env.recette jamais écrasé', () => /if \[ -f "\$ENV_RECETTE" \]; then\n\s+echo "\.env\.recette existe : conservé tel quel\."/.test(vm), true],
      ['option inconnue : code 2, sans rien faire', () => spawnSync('bash', [join(RACINE, 'vm/preparer-vm.sh'), '--inconnue'], { encoding: 'utf8' }).status, 2],
      ['entree.sh ne recopie jamais les secrets', () => lire('recette/entree.sh').includes("--exclude=./.env.recette"), true],
      ['entree.sh lance l’exécuteur ; preparer-vm.sh le démarre', () => [/executeur\)\n\s+shift\n\s+exec node recette\/executeur\.mjs/.test(lire('recette/entree.sh')), vm.includes('up -d --wait base interface executeur')], [true, true]],
      ['relancé, il ne réimporte ni ne relance par-dessus l’existant', () => [vm.includes('importer --si-vide'), vm.includes('campagne --si-premiere')], [true, true]],
      ['le démon interrogé lui-même (docker info) ; systemd seulement s’il ne répond pas (WSL2)', () => [vm.includes('if ! docker info >/dev/null 2>&1; then'), vm.includes('systemctl is-active')], [true, false]],
    ]);
  });

  test('variables, secrets, scripts npm, migrations', (t) => {
    const migrations = readdirSync(join(RACINE, 'recette', 'sql')).filter((f) => f.endsWith('.sql')).sort();
    const paquet = JSON.parse(lire('package.json'));
    return table(t, [
      ['.env.recette n’est jamais versionné', () => lire('.gitignore').split('\n').includes('.env.recette'), true],
      ['l’exemple ne porte aucun vrai mot de passe', () => [...exemple.matchAll(/^(\w*MOT_DE_PASSE\w*)=(.*)$/gm)].filter(([, , v]) => v && v !== 'a-remplacer').map(([, k]) => k), []],
      ['scripts npm : test, recette, interface', () => [paquet.scripts.test, paquet.scripts.recette, paquet.scripts.interface], ['node --test tests/test_*.mjs', 'node recette/lancer.mjs campagne', 'node interface/serveur.mjs']],
      ['pg : dépendance de développement (l’image du résolveur s’en passe)', () => [Boolean(paquet.devDependencies?.pg), Boolean(paquet.dependencies?.pg)], [true, false]],
      ['migrations numérotées sans trou, à partir de 001', () => migrations.map((f) => f.slice(0, 3)), migrations.map((_, i) => String(i + 1).padStart(3, '0'))],
      ['migrations découvertes par le lanceur', () => migrationsDisponibles().map((m) => m.nom), migrations],
      ['aucune migration ne détruit', () => migrations.filter((f) => /\bDROP\s+(TABLE|SCHEMA|VIEW)\b/i.test(lire(`recette/sql/${f}`))), []],
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('5. PostgreSQL : la base de recette', { skip: SANS_BASE }, () => {
  test('migrations appliquées, empreintes intactes, idempotentes', async (t) => table(t, [
    ['chaque migration du dépôt est appliquée', async () => (await POOLS.principal.query('SELECT nom FROM recette.migration ORDER BY version')).rows.map((r) => r.nom), migrationsDisponibles().map((m) => m.nom)],
    ['empreintes identiques aux fichiers', async () => { const enBase = new Map((await POOLS.principal.query('SELECT nom, empreinte FROM recette.migration')).rows.map((r) => [r.nom, r.empreinte])); return migrationsDisponibles().filter((m) => enBase.get(m.nom) !== m.empreinte).map((m) => m.nom); }, []],
    ['migrer une seconde fois n’applique rien', async () => migrer(POOLS.principal), []],
    ['les deux schémas', async () => (await POOLS.principal.query("SELECT array_agg(nspname::text ORDER BY nspname::text COLLATE \"C\") FROM pg_namespace WHERE nspname IN ('recette', 'donnees')")).rows[0].array_agg, ['donnees', 'recette']],
    ['sessions sans JIT, principale et de lecture (une base neuve le déclencherait pour rien)', async () => [(await POOLS.principal.query('SHOW jit')).rows[0].jit, (await POOLS.lecture.query('SHOW jit')).rows[0].jit], ['off', 'off']],
  ]));

  test('seize opérations par test, garanties par la base', async (t) => enEssai(async (c) => {
    const { rows: [{ id }] } = await c.query("INSERT INTO recette.test (origine, nom_complet, libelle) VALUES ('base', 'essai seize', 'essai seize') RETURNING id");
    const ajout = (ordre, extra = "'sql', 'SELECT 1', 'egal', '1'") => c.query(`SAVEPOINT p; INSERT INTO recette.operation (test_id, ordre, libelle, nature, requete, comparaison, attendu) VALUES (${id}, ${ordre}, 'op', ${extra}); RELEASE SAVEPOINT p`);
    const refus = async (promesse) => { const code = await codeErreur(promesse); await c.query('ROLLBACK TO SAVEPOINT p').catch(() => {}); return code; };
    return table(t, [
      ['seize opérations acceptées', async () => { for (let i = 1; i <= 16; i += 1) await ajout(i); return Number((await c.query('SELECT count(*) FROM recette.operation WHERE test_id = $1', [id])).rows[0].count); }, 16],
      ['la 17e refusée (rang de 1 à 16)', async () => refus(ajout(17)), '23514'],
      ['un rang en double refusé', async () => refus(ajout(3)), '23505'],
      ['le rang 0 refusé', async () => refus(ajout(0)), '23514'],
      ['une étape refusée sur un test défini en base', async () => refus(c.query(`SAVEPOINT p; DELETE FROM recette.operation WHERE test_id = ${id} AND ordre = 16; INSERT INTO recette.operation (test_id, ordre, libelle, nature) VALUES (${id}, 16, 'e', 'etape')`)), '23514'],
      ['une requête sans texte refusée', async () => refus(c.query(`SAVEPOINT p; DELETE FROM recette.operation WHERE test_id = ${id} AND ordre = 16; INSERT INTO recette.operation (test_id, ordre, libelle, nature, comparaison, attendu) VALUES (${id}, 16, 'e', 'sql', 'egal', '1')`)), '23514'],
      ['un attendu manquant refusé (sauf vide, non vide)', async () => refus(c.query(`SAVEPOINT p; DELETE FROM recette.operation WHERE test_id = ${id} AND ordre = 16; INSERT INTO recette.operation (test_id, ordre, libelle, nature, requete, comparaison) VALUES (${id}, 16, 'e', 'sql', 'SELECT 1', 'egal')`)), '23514'],
      ['une tolérance hors comparaison « tolerance » refusée', async () => refus(c.query(`SAVEPOINT p; UPDATE recette.operation SET tolerance = 0.1 WHERE test_id = ${id} AND ordre = 1`)), '23514'],
      ['échange de deux rangs en une instruction (contrainte différable)', async () => { await c.query('UPDATE recette.operation SET ordre = CASE WHEN ordre = 1 THEN 2 ELSE 1 END WHERE test_id = $1 AND ordre IN (1, 2)', [id]); return (await c.query('SELECT count(DISTINCT ordre) FROM recette.operation WHERE test_id = $1', [id])).rows[0].count; }, 16],
      ['suppression puis renumérotation en une instruction', async () => { await c.query('DELETE FROM recette.operation WHERE test_id = $1 AND ordre = 5', [id]); await c.query('UPDATE recette.operation SET ordre = ordre - 1 WHERE test_id = $1 AND ordre > 5', [id]); return (await c.query('SELECT array_agg(ordre ORDER BY ordre) FROM recette.operation WHERE test_id = $1', [id])).rows[0].array_agg; }, Array.from({ length: 15 }, (_, i) => i + 1)],
    ]);
  }));

  test('une étape n’appartient qu’à un test de fichier', async (t) => enEssai(async (c) => {
    const { rows: [{ id }] } = await c.query("INSERT INTO recette.test (origine, fichier, nom_complet, libelle) VALUES ('fichier', 'tests/essai.mjs', 'f', 'f') RETURNING id");
    return table(t, [
      ['étape acceptée', async () => (await c.query("INSERT INTO recette.operation (test_id, ordre, libelle, nature) VALUES ($1, 1, 'e', 'etape') RETURNING nature", [id])).rows[0].nature, 'etape'],
      ['requête refusée, avec un message clair', async () => { try { await c.query("SAVEPOINT p; INSERT INTO recette.operation (test_id, ordre, libelle, nature, requete, attendu) VALUES ($1, 2, 'r', 'sql', 'SELECT 1', '1')".replace('$1', id)); return 'acceptée'; } catch (e) { await c.query('ROLLBACK TO SAVEPOINT p'); return [e.code, /ne porte que des étapes/.test(e.message)]; } }, ['23514', true]],
      ['un test de fichier exige son fichier', async () => { await c.query('SAVEPOINT q'); const code = await codeErreur(c.query("INSERT INTO recette.test (origine, nom_complet, libelle) VALUES ('fichier', 'g', 'g')")); await c.query('ROLLBACK TO SAVEPOINT q'); return code; }, '23514'],
      ['un nom unique par origine et fichier', async () => { await c.query('SAVEPOINT q'); const code = await codeErreur(c.query("INSERT INTO recette.test (origine, fichier, nom_complet, libelle) VALUES ('fichier', 'tests/essai.mjs', 'f', 'f')")); await c.query('ROLLBACK TO SAVEPOINT q'); return code; }, '23505'],
      ['deux tests définis en base de même nom : refusé (NULLS NOT DISTINCT)', async () => { await c.query("INSERT INTO recette.test (origine, nom_complet, libelle) VALUES ('base', 'unique', 'unique')"); await c.query('SAVEPOINT q'); const code = await codeErreur(c.query("INSERT INTO recette.test (origine, nom_complet, libelle) VALUES ('base', 'unique', 'unique')")); await c.query('ROLLBACK TO SAVEPOINT q'); return code; }, '23505'],
    ]);
  }));

  test('le chargeur : tests, catalogue d’étapes, exécutions, résultats', async (t) => enEssai(async (c) => {
    const campagne = await campagneEssai(c);
    const etape = (ordre, statut = 'reussie', libelle = `étape ${ordre}`) => ({ ordre, libelle, statut, entree: null, attendu: ordre, obtenu: ordre, message: null, duree_ms: 0.5 });
    const fichierTest = (nom, statut, etapes) => ({ type: 'test', origine: 'fichier', fichier: 'tests/essai_chargeur.mjs', nom_complet: `S > ${nom}`, suite: 'S', libelle: nom, statut, motif: null, duree_ms: 3, etapes });
    const premier = [fichierTest('a', 'reussi', [etape(1), etape(2), etape(3)]), fichierTest('b', 'echoue', [etape(1), etape(2, 'echouee')]), fichierTest('c', 'omis', [])];
    const r1 = await charger(c, campagne, premier);
    const catalogue = async (nom) => (await c.query("SELECT array_agg(o.ordre || ':' || o.libelle ORDER BY o.ordre) AS l FROM recette.operation o JOIN recette.test t ON t.id = o.test_id WHERE t.nom_complet = $1 AND t.fichier = 'tests/essai_chargeur.mjs'", [`S > ${nom}`])).rows[0].l;
    return table(t, [
      ['décompte du chargement', () => r1, { tests: 3, executions: 3, resultats: 5, operations: 5 }],
      ['totaux de campagne', () => totaux(premier), { tests: 3, reussis: 1, echoues: 1, erreurs: 0, omis: 1, a_faire: 0, operations: 5, base: 0 }],
      ['chaque résultat relié à son opération du catalogue', async () => (await c.query('SELECT count(*) FILTER (WHERE r.operation_id IS NULL) AS sans FROM recette.resultat r JOIN recette.execution e ON e.id = r.execution_id WHERE e.campagne_id = $1', [campagne])).rows[0].sans, 0],
      ['statuts des exécutions', async () => (await c.query('SELECT array_agg(statut ORDER BY statut) AS s FROM recette.execution WHERE campagne_id = $1', [campagne])).rows[0].s, ['echoue', 'omis', 'reussi']],
      ['valeurs JSON conservées (attendu, obtenu)', async () => (await c.query('SELECT r.attendu, r.obtenu FROM recette.resultat r JOIN recette.execution e ON e.id = r.execution_id WHERE e.campagne_id = $1 AND r.ordre = 2 AND r.statut = $2', [campagne, 'echouee'])).rows[0], { attendu: 2, obtenu: 2 }],
      ['réussi avec moins d’étapes : catalogue raccourci et renommé', async () => {
        const autre = await campagneEssai(c);
        await charger(c, autre, [fichierTest('a', 'reussi', [etape(1), etape(2, 'reussie', 'renommée')]), fichierTest('b', 'echoue', [etape(1, 'echouee')])]);
        return [await catalogue('a'), await catalogue('b')];
      }, [['1:étape 1', '2:renommée'], ['1:étape 1', '2:étape 2']]],
      ['un test omis ne touche pas au catalogue', async () => (await catalogue('c')), null],
      ['vu_le mis à jour à chaque chargement', async () => (await c.query("SELECT bool_and(vu_le IS NOT NULL) AS v FROM recette.test WHERE fichier = 'tests/essai_chargeur.mjs'")).rows[0].v, true],
      ['NUL et moitié de paire de substitution : chargés, remplacés par U+FFFD', async () => {
        const autre = await campagneEssai(c);
        const etrange = { ...etape(1), message: 'a\u0000b\uD83D', obtenu: { 'clé\u0000': 'x\uDE00' } };
        await charger(c, autre, [fichierTest('d', 'reussi', [etrange])]);
        return (await c.query("SELECT r.message, r.obtenu FROM recette.resultat r JOIN recette.execution e ON e.id = r.execution_id WHERE e.campagne_id = $1", [autre])).rows[0];
      }, { message: 'a\uFFFDb\uFFFD', obtenu: { 'clé\uFFFD': 'x\uFFFD' } }],
    ]);
  }));

  test('campagne orpheline : close comme interrompue, jamais une campagne vivante', async (t) => {
    const id = -900000 - (process.pid % 10000);
    const db = POOLS.principal;
    // Bornée à sa campagne d'essai : celles des autres suites, lancées en parallèle, ne la concernent pas
    const clore = async () => (await cloreOrphelines(db, { ids: [id] })).includes(id);
    await db.query('DELETE FROM recette.campagne WHERE id = $1', [id]);
    const vivante = await db.connect();
    const examen = await db.connect();
    try {
      // Créée sous son verrou, comme le fait le lanceur : jamais visible sans lui
      await creerCampagne(vivante, { libelle: 'essai orpheline', ctx: {}, id });
      return await table(t, [
        ['verrou tenu : la campagne vit, rien n’est clos', clore, false],
        ['verrou relâché, un autre examen au même instant : close quand même', async () => {
          await vivante.query('SELECT pg_advisory_unlock($1, $2::int)', [CLE_CAMPAGNE, id]);
          await examen.query('SELECT pg_advisory_lock_shared($1, $2::int)', [CLE_CAMPAGNE, id]);
          try { return await clore(); } finally { await examen.query('SELECT pg_advisory_unlock_shared($1, $2::int)', [CLE_CAMPAGNE, id]); }
        }, true],
        ['statut, fin et motif enregistrés', async () => (await db.query("SELECT statut, fin IS NOT NULL AS close, totaux->>'erreur' AS motif FROM recette.campagne WHERE id = $1", [id])).rows[0], { statut: 'interrompue', close: true, motif: 'lanceur arrêté sans clore la campagne' }],
      ]);
    } finally {
      await vivante.query('SELECT pg_advisory_unlock($1, $2::int)', [CLE_CAMPAGNE, id]).catch(() => {});
      vivante.release();
      examen.release();
      await db.query('DELETE FROM recette.campagne WHERE id = $1', [id]);
    }
  });

  test('rechargements des documents : un à la fois, le second attend le premier', async (t) => {
    const a = await POOLS.principal.connect();
    const b = await POOLS.principal.connect();
    let second = null;
    let fini = false;
    try {
      await a.query('BEGIN');
      await b.query('BEGIN');
      // Rien n'est validé : les deux transactions sont annulées, les documents de la campagne restent
      return await table(t, [
        ['le premier recharge, sa transaction ouverte', async () => (await chargerDocuments(a, RACINE)).modele, 1],
        ['le second attend son tour', async () => {
          second = chargerDocuments(b, RACINE).then((n) => { fini = true; return n; });
          await new Promise((ok) => setTimeout(ok, 300));
          return fini;
        }, false],
        ['le premier fini, le second recharge à son tour', async () => { await a.query('ROLLBACK'); return (await second).modele; }, 1],
      ]);
    } finally {
      await a.query('ROLLBACK').catch(() => {});
      await second?.catch(() => {});
      await b.query('ROLLBACK').catch(() => {});
      a.release();
      b.release();
    }
  });

  test('comparer deux campagnes', async (t) => enEssai(async (c) => {
    const [a, b] = [await campagneEssai(c, 'a'), await campagneEssai(c, 'b')];
    const ids = {};
    for (const n of ['reste', 'regresse', 'corrige', 'nouveau', 'disparu', 'omis']) {
      ids[n] = (await c.query("INSERT INTO recette.test (origine, nom_complet, libelle) VALUES ('base', $1, $1) RETURNING id", [`comparaison ${n}`])).rows[0].id;
    }
    const exec = (campagne, n, statut) => c.query('INSERT INTO recette.execution (campagne_id, test_id, statut) VALUES ($1, $2, $3)', [campagne, ids[n], statut]);
    await exec(a, 'reste', 'reussi'); await exec(b, 'reste', 'reussi');
    await exec(a, 'regresse', 'reussi'); await exec(b, 'regresse', 'erreur');
    await exec(a, 'corrige', 'echoue'); await exec(b, 'corrige', 'reussi');
    await exec(b, 'nouveau', 'reussi');
    await exec(a, 'disparu', 'reussi');
    await exec(a, 'omis', 'reussi'); await exec(b, 'omis', 'omis');
    const { rows } = await c.query('SELECT nom_complet, changement FROM recette.comparer($1, $2) ORDER BY nom_complet', [a, b]);
    const de = (n) => rows.find((r) => r.nom_complet === `comparaison ${n}`)?.changement;
    return table(t, [
      ['inchangé', () => de('reste'), 'identique'],
      ['réussi → erreur : régression', () => de('regresse'), 'regression'],
      ['échec → réussi : correction', () => de('corrige'), 'correction'],
      ['absent de la première : nouveau', () => de('nouveau'), 'nouveau'],
      ['absent de la seconde : disparu', () => de('disparu'), 'disparu'],
      ['réussi → omis : changement', () => de('omis'), 'changement'],
      ['totaux par campagne (v_campagne)', async () => (await c.query('SELECT tests, reussis, erreurs, omis FROM recette.v_campagne WHERE id = $1', [b])).rows[0], { tests: 5, reussis: 3, erreurs: 1, omis: 1 }],
    ]);
  }));

  test('les fichiers YAML en tables : documents et vues donnees', async (t) => enEssai(async (c) => {
    const compte = await chargerDocuments(c, RACINE, null);
    const un = async (sql) => (await c.query(sql)).rows[0];
    return table(t, [
      ['un modèle, au moins un manifeste et deux entrées', () => [compte.modele, compte.manifeste >= 1, compte.journal >= 2], [1, true, true]],
      ['35 critères, 27 aux termes, dans l’ordre du modèle', async () => un("SELECT count(*) AS n, count(*) FILTER (WHERE terme <> 'second_ordre') AS termes, (array_agg(id ORDER BY ordre))[1] AS premier, (array_agg(id ORDER BY ordre DESC))[1] AS dernier FROM donnees.critere"), { n: 35, termes: 27, premier: '1.1', dernier: 'FR.1' }],
      ['12 facteurs', async () => (await un('SELECT count(DISTINCT n) AS n FROM donnees.facteur')).n, 12],
      ['les contrôles consignés du journal se lisent en lignes', async () => (await un("SELECT count(*) > 0 AS v FROM donnees.controle_consigne WHERE instance = 'meta-12f-7e'")).v, true],
      ['synthèse recalculée en SQL, arrondi au pair : aucun écart', async () => (await un(`
        SELECT count(*) AS n FROM donnees.synthese s
        LEFT JOIN (SELECT sc.instance, sc.numero, c.terme, donnees.arrondi_pair(avg(sc.score), 2) AS m
                   FROM donnees.score sc JOIN donnees.critere c ON c.id = sc.critere WHERE sc.score IS NOT NULL GROUP BY 1, 2, 3) r
          ON r.instance = s.instance AND r.numero = s.numero AND r.terme = s.terme
        WHERE s.moyenne IS DISTINCT FROM r.m`)).n, 0],
      ['arrondi au pair : égalités exactes', async () => un('SELECT donnees.arrondi_pair(1.125, 2) AS a, donnees.arrondi_pair(1.135, 2) AS b, donnees.arrondi_pair(0.125, 2) AS c, donnees.arrondi_pair(-1.125, 2) AS d, donnees.arrondi_pair(2.5, 0) AS e, donnees.arrondi_pair(3.5, 0) AS f'), { a: 1.12, b: 1.14, c: 0.12, d: -1.12, e: 2, f: 4 }],
      ['une valeur mal typée devient NULL, sans lever', async () => un(`SELECT donnees.entier('"3"'::jsonb) AS a, donnees.nombre('true'::jsonb) AS b, donnees.horodatage('"pas une date"'::jsonb) AS c, donnees.booleen('1'::jsonb) AS d`), { a: null, b: null, c: null, d: null }],
      ['un document illisible est chargé avec son erreur', async () => {
        await c.query("INSERT INTO donnees.document (nature, chemin, contenu, empreinte) VALUES ('journal', 'journal/x/9999.yaml', '{\"erreur\": \"YAML illisible\"}', 'x')");
        return (await un("SELECT count(*) AS n FROM donnees.entree WHERE chemin = 'journal/x/9999.yaml' AND numero IS NULL")).n;
      }, 1],
    ]);
  }));

  test('rôle de lecture : lecture seule, une instruction, délai', { skip: SANS_LECTURE }, async (t) => table(t, [
    ['une requête de lecture', async () => executerRequete(POOLS.lecture, 'SELECT count(*) FROM donnees.document'), { lignes: 1, valeur: (await POOLS.principal.query('SELECT count(*)::int AS n FROM donnees.document')).rows[0].n }],
    ['sous le rôle recette_lecture', async () => (await executerRequete(POOLS.lecture, 'SELECT current_user')).valeur, 'recette_lecture'],
    ['écrire est refusé avant même la base', async () => codeErreur(executerRequete(POOLS.lecture, 'DELETE FROM recette.test')), 'une opération SQL est une requête de lecture : SELECT, WITH, VALUES ou TABLE'],
    ['une écriture cachée dans un WITH : refusée par la base', async () => codeErreur(executerRequete(POOLS.lecture, 'WITH x AS (DELETE FROM recette.test RETURNING 1) SELECT * FROM x')), '0A000'],
    ['plus de 1 000 lignes : refusé sans tout charger', async () => codeErreur(executerRequete(POOLS.lecture, 'SELECT generate_series(1, 5000)')), `plus de ${LIGNES_MAX} lignes : restreindre la requête (agrégat, LIMIT, condition)`],
    ['un verrou consultatif pris par une requête est libéré', async () => { await executerRequete(POOLS.lecture, 'SELECT pg_advisory_lock(424242)'); return (await POOLS.principal.query("SELECT count(*) AS n FROM pg_locks WHERE locktype = 'advisory' AND objid = 424242")).rows[0].n; }, 0],
    ['le point-virgule final est permis', async () => (await executerRequete(POOLS.lecture, 'SELECT 1;  ')).valeur, 1],
    ['même hors transaction explicite : le rôle est en lecture seule', async () => codeErreur(POOLS.lecture.query("UPDATE recette.test SET libelle = libelle WHERE false")), '25006'],
    ['deux instructions sont refusées', async () => codeErreur(executerRequete(POOLS.lecture, 'SELECT 1; SELECT 2')), '42601'],
    ['le délai coupe une requête trop longue', async () => codeErreur(executerRequete(POOLS.lecture, 'SELECT pg_sleep(2)', 200)), '57014'],
    ['aucun droit d’écriture accordé', async () => (await POOLS.principal.query("SELECT count(*) AS n FROM information_schema.role_table_grants WHERE grantee = 'recette_lecture' AND privilege_type <> 'SELECT'")).rows[0].n, 0],
    ['opération SQL : réussie, en échec, en erreur', async () => {
      const op = (x) => ({ ordre: 1, libelle: 'l', nature: 'sql', comparaison: 'egal', ...x });
      return [
        (await executerOperation(op({ requete: 'SELECT 35', attendu: 35 }), { lecture: POOLS.lecture })).statut,
        (await executerOperation(op({ requete: 'SELECT 35', attendu: 36 }), { lecture: POOLS.lecture })).statut,
        (await executerOperation(op({ requete: 'SELECT * FROM table_inexistante', attendu: 1 }), { lecture: POOLS.lecture })).statut,
      ];
    }, ['reussie', 'echouee', 'erreur']],
  ]));

  test('capacité : 300 tests à 16 requêtes SQL, importés, exécutés, chargés', { skip: SANS_LECTURE, timeout: 180000 }, async (t) => enEssai(async (c) => {
    const N = 300;
    const s = scenario(t);
    const doc = { version: 1, tests: Array.from({ length: N }, (_, i) => ({ nom: `capacité ${String(i).padStart(3, '0')}`, operations: Array.from({ length: MAX_OPERATIONS }, (_, j) => ({ libelle: `requête ${j + 1}`, sql: `SELECT count(*) FROM donnees.document WHERE id > ${-j}`, comparaison: 'nombre_lignes', attendu: 1 })) })) };
    const mesures = {};
    let enregistrements = [];
    const chronometre = async (cle, fn) => { const debut = performance.now(); const r = await fn(); mesures[cle] = Math.round(performance.now() - debut); return r; };
    await s.etape('import : 300 tests, 4 800 opérations', () => chronometre('import', async () => {
      await importer(c, stringify(doc));
      return Number((await c.query("SELECT count(*) AS n FROM recette.operation o JOIN recette.test t ON t.id = o.test_id WHERE t.origine = 'base' AND t.nom_complet LIKE 'capacité ___'")).rows[0].n);
    }), { attendu: N * MAX_OPERATIONS });
    await s.etape('exécution : 4 800 requêtes en lecture seule, quatre tests à la fois, toutes réussies', async () => {
      const { rows: tests } = await c.query("SELECT id, nom_complet, libelle FROM recette.test WHERE origine = 'base' AND nom_complet LIKE 'capacité ___' ORDER BY nom_complet");
      const { rows: ops } = await c.query("SELECT o.* FROM recette.operation o JOIN recette.test t ON t.id = o.test_id WHERE t.origine = 'base' AND t.nom_complet LIKE 'capacité ___' ORDER BY o.test_id, o.ordre");
      const parTest = Map.groupBy(ops, (o) => o.test_id);
      return chronometre('execution', async () => {
        enregistrements = new Array(tests.length);
        let k = 0;
        await Promise.all([0, 1, 2, 3].map(async () => { while (k < tests.length) { const i = k++; enregistrements[i] = await executerTest(tests[i], parTest.get(tests[i].id), { lecture: POOLS.lecture }); } }));
        return [enregistrements.length, enregistrements.filter((e) => e.statut === 'reussi').length, enregistrements.reduce((n, e) => n + e.etapes.length, 0)];
      });
    }, { attendu: [N, N, N * MAX_OPERATIONS] });
    await s.etape('chargement : 4 800 résultats en une transaction', async () => {
      const campagne = await campagneEssai(c, 'capacité');
      const r = await chronometre('chargement', () => charger(c, campagne, enregistrements));
      return [r.executions, r.resultats];
    }, { attendu: [N, N * MAX_OPERATIONS] });
    await s.etape('durées en millisecondes ; le tout en moins d’une minute', () => ({ ...mesures, total: mesures.import + mesures.execution + mesures.chargement }), {
      verifier: (m) => assert.ok(m.total < 60000, `${m.total} ms pour 300 tests à 16 requêtes`),
    });
  }));
});

// ════════════════════════════════════════════════════════════════════════════
describe('6. Interface : pages, accessibilité, sûreté, édition', { skip: SANS_BASE }, () => {
  let serveur;
  let base;
  let csrf;
  const crees = [];
  before(async () => {
    const { createServer } = await import('node:http');
    serveur = createServer(creerApplication({ principal: POOLS.principal, lecture: POOLS.lecture, csrf: 'jeton-essai-0123456789abcdef' }));
    await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${serveur.address().port}`;
    csrf = 'jeton-essai-0123456789abcdef';
  });
  after(async () => {
    for (const id of crees) await POOLS.principal.query("DELETE FROM recette.test WHERE id = $1 AND origine = 'base'", [id]).catch(() => {});
    await new Promise((ok) => (serveur ? serveur.close(ok) : ok()));
  });
  const lirePage = async (chemin, options = {}) => { const r = await fetch(base + chemin, { redirect: 'manual', ...options }); return { code: r.status, texte: await r.text(), entetes: r.headers }; };
  const poster = (chemin, champs, entetes = {}) => lirePage(chemin, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', ...entetes }, body: new URLSearchParams(champs).toString() });

  test('chaque page répond, accessible dans sa structure', async (t) => {
    const { rows: [premierBase] } = await POOLS.principal.query("SELECT id FROM recette.test WHERE origine = 'base' ORDER BY id LIMIT 1");
    const { rows: [premierFichier] } = await POOLS.principal.query("SELECT id FROM recette.test WHERE origine = 'fichier' ORDER BY id LIMIT 1");
    const pages = ['/', '/workflows', '/declencheurs', '/suivi', '/suivi/demandes', '/campagnes', '/tests', '/tests?origine=base', '/tests/nouveau', '/comparer', '/donnees', '/echange',
      ...(premierBase ? [`/tests/${premierBase.id}`, `/tests/${premierBase.id}/supprimer`] : []), ...(premierFichier ? [`/tests/${premierFichier.id}`] : [])];
    const resultats = {};
    for (const p of pages) { const r = await lirePage(p); resultats[p] = { code: r.code, defauts: defautsAccessibilite(r.texte) }; }
    return table(t, [
      ['toutes en 200', () => Object.entries(resultats).filter(([, r]) => r.code !== 200).map(([p, r]) => `${p} : ${r.code}`), []],
      ['aucun défaut structurel d’accessibilité', () => Object.entries(resultats).flatMap(([p, r]) => r.defauts.map((d) => `${p} : ${d}`)), []],
      ['page absente : 404 accessible', async () => { const r = await lirePage('/inexistante'); return [r.code, defautsAccessibilite(r.texte)]; }, [404, []]],
      ['méthode non permise : 405 et Allow', async () => { const r = await lirePage('/operations/essayer'); return [r.code, r.entetes.get('allow')]; }, [405, 'POST']],
      ['santé : JSON', async () => { const r = await lirePage('/sante'); return [r.code, JSON.parse(r.texte)]; }, [200, { statut: 'ok' }]],
      ['feuille de style servie', async () => { const r = await lirePage('/style.css'); return [r.code, r.entetes.get('content-type')]; }, [200, 'text/css; charset=utf-8']],
    ]);
  });

  test('sûreté : en-têtes, jeton, origine, authentification', async (t) => table(t, [
    ['politique de contenu sans script', async () => (await lirePage('/')).entetes.get('content-security-policy'), "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"],
    ['nosniff, aucun cadre, aucun référent', async () => { const e = (await lirePage('/')).entetes; return [e.get('x-content-type-options'), e.get('x-frame-options'), e.get('referrer-policy')]; }, ['nosniff', 'DENY', 'no-referrer']],
    ['formulaire sans jeton : refusé', async () => (await poster('/tests', { nom: 'x' })).code, 403],
    ['jeton faux : refusé', async () => (await poster('/tests', { _csrf: 'faux', nom: 'x' })).code, 403],
    ['autre origine : refusée', async () => (await poster('/tests', { _csrf: csrf, nom: 'x' }, { Origin: 'http://ailleurs.exemple' })).code, 403],
    ['requête d’un autre site : refusée', async () => (await poster('/tests', { _csrf: csrf, nom: 'x' }, { 'Sec-Fetch-Site': 'cross-site' })).code, 403],
    ['format inattendu : 415', async () => (await lirePage('/tests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).code, 415],
    ['rebond DNS : un hôte non permis est refusé (421), localhost permis', async () => {
      const { request } = await import('node:http');
      const statut = (hote) => new Promise((ok, ko) => { const r = request({ host: '127.0.0.1', port: serveur.address().port, path: '/', headers: { Host: hote } }, (res) => { res.resume(); ok(res.statusCode); }); r.on('error', ko); r.end(); });
      return [await statut('rebond.attaquant.exemple:8080'), await statut(`localhost:${serveur.address().port}`), await statut(`[::1]:${serveur.address().port}`)];
    }, [421, 200, 200]],
    ['authentification incomplète : l’interface refuse de démarrer', async () => {
      const avant = { u: process.env.INTERFACE_UTILISATEUR, m: process.env.INTERFACE_MOT_DE_PASSE };
      process.env.INTERFACE_UTILISATEUR = 'fred';
      delete process.env.INTERFACE_MOT_DE_PASSE;
      try {
        const lance = await demarrer({ hote: '127.0.0.1', port: 0 });
        await new Promise((ok) => lance.serveur.close(ok));
        return 'démarrée sans mot de passe';
      } catch (e) {
        return e.message;
      } finally {
        if (avant.u === undefined) delete process.env.INTERFACE_UTILISATEUR; else process.env.INTERFACE_UTILISATEUR = avant.u;
        if (avant.m !== undefined) process.env.INTERFACE_MOT_DE_PASSE = avant.m;
      }
    }, 'INTERFACE_UTILISATEUR et INTERFACE_MOT_DE_PASSE vont ensemble : renseigner les deux, ou aucune'],
    ['authentification HTTP facultative : 401 sans, 200 avec', async () => {
      const { createServer } = await import('node:http');
      const s = createServer(creerApplication({ principal: POOLS.principal, identifiants: { utilisateur: 'fred', motDePasse: 'secret' } }));
      await new Promise((ok) => s.listen(0, '127.0.0.1', ok));
      const u = `http://127.0.0.1:${s.address().port}/`;
      try {
        return [(await fetch(u)).status, (await fetch(u, { headers: { Authorization: `Basic ${Buffer.from('fred:secret').toString('base64')}` } })).status, (await fetch(`${u}sante`)).status];
      } finally { await new Promise((ok) => s.close(ok)); }
    }, [401, 200, 200]],
  ]));

  test('édition d’un test défini en base, de bout en bout', async (t) => {
    const nom = `essai interface ${process.pid}-${Date.now()}`;
    let id;
    const operations = async () => (await POOLS.principal.query('SELECT array_agg(libelle ORDER BY ordre) AS l FROM recette.operation WHERE test_id = $1', [id])).rows[0].l ?? [];
    return table(t, [
      ['création : redirection vers sa fiche', async () => { const r = await poster('/tests', { _csrf: csrf, nom, description: 'créé par test_recette.mjs', actif: '1' }); id = Number(/\/tests\/(\d+)/.exec(r.entetes.get('location') ?? '')?.[1]); crees.push(id); return [r.code, Number.isInteger(id)]; }, [303, true]],
      ['nom en double : 422 et message', async () => { const r = await poster('/tests', { _csrf: csrf, nom }); return [r.code, r.texte.includes('porte déjà ce nom')]; }, [422, true]],
      ['seize opérations ajoutées', async () => { for (let i = 1; i <= MAX_OPERATIONS; i += 1) { const r = await poster(`/tests/${id}/operations`, { _csrf: csrf, libelle: `op ${i}`, nature: 'sql', requete: `SELECT ${i}`, comparaison: 'egal', attendu: String(i) }); if (r.code !== 303) return r.code; } return (await operations()).length; }, MAX_OPERATIONS],
      ['la 17e refusée, avec son motif', async () => { const r = await poster(`/tests/${id}/operations`, { _csrf: csrf, libelle: 'op 17', nature: 'sql', requete: 'SELECT 17', comparaison: 'egal', attendu: '17' }); return [r.code, r.texte.includes(`déjà ${MAX_OPERATIONS} opérations`)]; }, [409, true]],
      ['le formulaire d’ajout aussi, à 16', async () => (await lirePage(`/tests/${id}/operations/nouvelle`)).code, 409],
      ['saisie erronée : 422, toutes les erreurs reliées aux champs', async () => { const r = await poster(`/tests/${id}/operations`, { _csrf: csrf, libelle: '', nature: 'fonction', fonction: 'exec', arguments: '{', comparaison: 'egal', attendu: 'pas du json' }); return [r.code, ['#op-libelle', '#op-fonction', '#op-arguments', '#op-attendu'].every((a) => r.texte.includes(`href="${a}"`))]; }, [422, true]],
      ['essai en lecture seule : obtenu et verdict', async () => { const r = await poster('/operations/essayer', { _csrf: csrf, test_id: String(id), libelle: 'e', nature: 'sql', requete: 'SELECT count(*) FROM donnees.critere', comparaison: 'egal', attendu: '35', action: 'essayer' }); return [r.code, r.texte.includes('statut-reussie')]; }, [200, true]],
      ['essai d’écriture : refusé', async () => (await poster('/operations/essayer', { _csrf: csrf, test_id: String(id), libelle: 'e', nature: 'sql', requete: 'DELETE FROM recette.test', comparaison: 'vide', action: 'essayer' })).texte.includes('requête de lecture'), true],
      ['essai sans attendu, arguments illisibles laissés dans le champ : pas d’erreur 500', async () => (await poster('/operations/essayer', { _csrf: csrf, test_id: String(id), libelle: 'e', nature: 'sql', requete: 'SELECT 1', arguments: '{', comparaison: 'egal', attendu: '', action: 'essayer' })).code, 200],
      ['essayer et adopter : l’obtenu devient l’attendu', async () => /<textarea id="op-attendu"[^>]*>1\.12<\/textarea>/.test((await poster('/operations/essayer', { _csrf: csrf, test_id: String(id), libelle: 'e', nature: 'fonction', fonction: 'arrondi', arguments: '[1.125, 2]', comparaison: 'egal', action: 'adopter' })).texte), true],
      ['descendre la première opération', async () => { const { rows: [o] } = await POOLS.principal.query('SELECT id FROM recette.operation WHERE test_id = $1 AND ordre = 1', [id]); await poster(`/operations/${o.id}/deplacer`, { _csrf: csrf, sens: 'bas' }); return (await operations()).slice(0, 2); }, ['op 2', 'op 1']],
      ['supprimer une opération : les suivantes renumérotées', async () => { const { rows: [o] } = await POOLS.principal.query('SELECT id FROM recette.operation WHERE test_id = $1 AND ordre = 2', [id]); await poster(`/operations/${o.id}/supprimer`, { _csrf: csrf }); return [(await operations()).length, (await POOLS.principal.query('SELECT max(ordre) AS m FROM recette.operation WHERE test_id = $1', [id])).rows[0].m]; }, [15, 15]],
      ['modifier une opération en appel de fonction à tolérance', async () => { const { rows: [o] } = await POOLS.principal.query('SELECT id FROM recette.operation WHERE test_id = $1 AND ordre = 1', [id]); await poster(`/operations/${o.id}`, { _csrf: csrf, libelle: 'arrondi', nature: 'fonction', fonction: 'arrondi', arguments: '[1.125, 2]', comparaison: 'tolerance', attendu: '1.12', tolerance: '0,001' }); return (await POOLS.principal.query('SELECT nature, fonction, arguments, comparaison, attendu, tolerance FROM recette.operation WHERE id = $1', [o.id])).rows[0]; }, { nature: 'fonction', fonction: 'arrondi', arguments: [1.125, 2], comparaison: 'tolerance', attendu: 1.12, tolerance: 0.001 }],
      ['un test de suite ne se modifie pas ici', async () => { const { rows: [f] } = await POOLS.principal.query("SELECT id FROM recette.test WHERE origine = 'fichier' LIMIT 1"); return f ? (await poster(`/tests/${f.id}`, { _csrf: csrf, nom: 'x' })).code : 409; }, 409],
      ['suppression du test : puis 404', async () => { const r = await poster(`/tests/${id}/supprimer`, { _csrf: csrf }); return [r.code, (await lirePage(`/tests/${id}`)).code]; }, [303, 404]],
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('7. Bout en bout : échange des tests définis', { skip: SANS_BASE }, () => {
  test('import puis export : aller-retour sans perte', async (t) => enEssai(async (c) => {
    const tri = (l) => [...l].sort((a, b) => (a.nom < b.nom ? -1 : 1));
    let export1;
    return table(t, [
      ['import de la graine', async () => (await importer(c, SEMENCE)).importes, validerDefinitions(SEMENCE).tests.length],
      ['l’export se relit en tests valides', async () => { export1 = await exporter(c); return validerDefinitions(export1).erreurs ?? []; }, []],
      ['les tests de la graine s’y retrouvent à l’identique', () => { const noms = new Set(validerDefinitions(SEMENCE).tests.map((x) => x.nom)); return tri(validerDefinitions(export1).tests.filter((x) => noms.has(x.nom))); }, tri(validerDefinitions(SEMENCE).tests)],
      ['réimporter l’export ne change rien', async () => { await importer(c, export1); return (await exporter(c)) === export1; }, true],
      ['remplacer retire les tests absents du fichier', async () => { await c.query("INSERT INTO recette.test (origine, nom_complet, libelle) VALUES ('base', 'à retirer', 'à retirer')"); return (await importer(c, SEMENCE, { remplacer: true })).retires >= 1; }, true],
      ['un fichier invalide ne touche à rien', async () => { const avant = await exporter(c); try { await importer(c, 'tests: [{ nom: x, operations: [{ libelle: l, fonction: exec, attendu: 1 }] }]'); } catch { /* attendu */ } return (await exporter(c)) === avant; }, true],
    ]);
  }));

  test('nouveaux seulement : les tests absents ajoutés, ceux de la base intacts', async (t) => enEssai(async (c) => {
    const [premier, second] = validerDefinitions(SEMENCE).tests;
    const description = (nom) => c.query("SELECT description FROM recette.test WHERE origine = 'base' AND nom_complet = $1", [nom]).then((r) => r.rows[0]?.description);
    return table(t, [
      ['la graine importée, un test modifié, un autre supprimé : seul celui-ci manque', async () => {
        await importer(c, SEMENCE);
        await c.query("UPDATE recette.test SET description = 'modifiée dans l’interface' WHERE origine = 'base' AND nom_complet = $1", [premier.nom]);
        await c.query("DELETE FROM recette.test WHERE origine = 'base' AND nom_complet = $1", [second.nom]);
        return absents(c, SEMENCE);
      }, [second.nom]],
      ['nouveaux : seul le test manquant est ajouté', async () => (await importer(c, SEMENCE, { nouveaux: true })).ajoutes, [second.nom]],
      ['le test modifié reste tel quel', () => description(premier.nom), 'modifiée dans l’interface'],
      ['le test ajouté porte toutes ses opérations', async () => Number((await c.query("SELECT count(*) AS n FROM recette.operation o JOIN recette.test t ON t.id = o.test_id WHERE t.origine = 'base' AND t.nom_complet = $1", [second.nom])).rows[0].n), second.operations.length],
      ['relancé : rien à ajouter', async () => (await importer(c, SEMENCE, { nouveaux: true })).importes, 0],
      ['nouveaux et remplacer s’excluent', async () => { try { await importer(c, SEMENCE, { nouveaux: true, remplacer: true }); return 'accepté'; } catch (e) { return e.message; } }, 'remplacer et nouveaux s’excluent'],
      ['le lanceur refuse --nouveaux avec --si-vide : usage, code 2', () => lancer(['importer', '--nouveaux', '--si-vide']), 2],
    ]);
  }));
});

// ════════════════════════════════════════════════════════════════════════════
describe('8. Lanceur : interruption, campagne sous verrou', () => {
  test('interruption : node --test arrêté une fois, la campagne dite interrompue', (t) => {
    const cible = new EventEmitter();
    const dits = [];
    const signaux = [];
    const g = garderInterruption({ cible, dire: (m) => dits.push(m) });
    return table(t, [
      ['à l’écoute de SIGINT et de SIGTERM', () => [cible.listenerCount('SIGINT'), cible.listenerCount('SIGTERM')], [1, 1]],
      ['sans signal : rien d’interrompu', () => { g.suivre({ kill: (s) => signaux.push(s) }); g.verifier(); return [g.interrompue, signaux]; }, [false, []]],
      ['SIGTERM : node --test reçoit SIGTERM, la campagne est interrompue', () => { cible.emit('SIGTERM'); return [g.interrompue, signaux, dits.length]; }, [true, ['SIGTERM'], 1]],
      ['les signaux suivants n’y changent rien', () => { cible.emit('SIGINT'); cible.emit('SIGTERM'); return [signaux.length, dits.length]; }, [1, 1]],
      ['vérifier lève : la campagne sera close comme interrompue', () => { try { g.verifier(); return 'rien'; } catch (e) { return e.message; } }, 'campagne interrompue'],
      ['un enfant lancé après l’interruption est arrêté aussitôt', () => { const tard = []; g.suivre({ kill: (s) => tard.push(s) }); return tard; }, ['SIGTERM']],
      ['un enfant déjà fini : son kill qui lève reste sans effet', () => {
        const autre = new EventEmitter();
        const g2 = garderInterruption({ cible: autre, dire: () => {} });
        g2.suivre({ kill: () => { throw new Error('ESRCH'); } });
        autre.emit('SIGTERM');
        g2.lever();
        return g2.interrompue;
      }, true],
      ['verrou perdu : la raison dite, node --test arrêté', () => {
        const dites = [];
        const tues = [];
        const g3 = garderInterruption({ cible: new EventEmitter(), dire: (m) => dites.push(m) });
        g3.suivre({ kill: (s) => tues.push(s) });
        g3.interrompre('Verrou de la campagne perdu');
        g3.lever();
        return [g3.interrompue, dites[0].includes('Verrou de la campagne perdu'), tues];
      }, [true, true, ['SIGTERM']]],
      ['lever : plus aucun gestionnaire', () => { g.lever(); return [cible.listenerCount('SIGINT'), cible.listenerCount('SIGTERM')]; }, [0, 0]],
    ]);
  });

  test('campagne créée sous son verrou : jamais vue sans lui', { skip: SANS_BASE }, async (t) => {
    const id = -910000 - (process.pid % 10000);
    const db = POOLS.principal;
    await db.query('DELETE FROM recette.campagne WHERE id = $1', [id]);
    const tenant = await db.connect();
    const autre = await db.connect();
    try {
      return await table(t, [
        ['créée : son numéro rendu', () => creerCampagne(tenant, { libelle: 'essai sous verrou', motifs: ['tests/test_x.mjs'], ctx: {}, id }), id],
        ['visible, en cours', async () => (await db.query('SELECT statut, fichiers FROM recette.campagne WHERE id = $1', [id])).rows[0], { statut: 'en_cours', fichiers: ['tests/test_x.mjs'] }],
        ['son verrou déjà tenu : nul autre ne le prend', async () => (await autre.query('SELECT pg_try_advisory_lock($1, $2::int) AS libre', [CLE_CAMPAGNE, id])).rows[0].libre, false],
        ['jamais prise pour orpheline', async () => (await cloreOrphelines(db, { ids: [id] })).includes(id), false],
        ['un numéro déjà pris : la création lève, rien ne reste ouvert', async () => {
          const c = await db.connect();
          try { await creerCampagne(c, { libelle: 'doublon', ctx: {}, id }); c.release(); return 'créée'; } catch (e) { c.release(e); return e.code; }
        }, '23505'],
      ]);
    } finally {
      await tenant.query('SELECT pg_advisory_unlock($1, $2::int)', [CLE_CAMPAGNE, id]).catch(() => {});
      tenant.release();
      autre.release();
      await db.query('DELETE FROM recette.campagne WHERE id = $1', [id]);
    }
  });
});
