/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  test_resolveur7e.mjs : recette du résolveur du modèle exécutif 12 facteurs × 7E
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Ce fichier remplace test_resolveur7e.py, sorti du dépôt avec le résolveur
 *  Python. Il vérifie resolveur7e.mjs fonction par fonction, puis phase par
 *  phase, puis de bout en bout, en citant chaque fois la règle du modèle qu'il
 *  éprouve (modele-executif-12f-7e.yaml).
 *
 *  Organisation : une section par responsabilité, dans l'ordre du résolveur
 *     1. Nombres            parité avec round() et format() de Python
 *     2. Textes             extraits, lignes, valeurs écrites dans les constats
 *     3. Échappements       ERE et shell, vérifiés par grep et sh eux-mêmes
 *     4. Manifeste          présence d'un champ (requiert), lecture d'une valeur
 *     5. Exécution          lancer : codes, délais, signaux, flux
 *     6. Contexte           outils, CI, seuils requis, versions, compose,
 *                           placeholders, jq, journal
 *     7. Contrôles          les neuf types, un par un
 *     8. Précédences        sans objet automatique, requiert, pour_chaque
 *     9. Agrégation         echelle.agregation : cas, puis propriétés
 *    10. Combinaison        pour_chaque : tous, une partie, aucun
 *    11. Blocage, synthèse  boucle.blocage, moyennes et écarts par terme
 *    12. Phases             Évaluer, Élaborer, Examiner, Évoluer, Équilibrer
 *    13. Cycle et journal   écriture, gardes, comparabilité, format YAML
 *    14. Ligne de commande  codes de retour, sorties, refus, point d'entrée
 *
 *  Conventions
 *    - Chaque test déclare ses opérations par scenario(t).etape() ou table(t, …),
 *      16 au plus (tests/outils/etapes.mjs). La recette les range dans
 *      PostgreSQL, une ligne par opération (recette.resultat).
 *    - Aucun test ne touche au dépôt du méta-projet : chacun crée son dépôt Git
 *      jetable (tests/outils/depot.mjs) et le détruit.
 *    - L'environnement est neutralisé au chargement : hors CI, sans variable du
 *      résolveur héritée. Chaque fichier de test tourne dans son propre processus.
 *    - Les tests qui exigent le démon Docker sont omis hors de la VM de recette,
 *      avec leur motif : un test omis n'est jamais compté comme réussi.
 *
 *  Lancer : npm test (toutes les suites) ou node --test tests/test_resolveur7e.mjs
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, test } from 'node:test';
import { parse, stringify } from 'yaml';

import {
  NOMS_PHASES, NOMS_TERMES, PHASES, Contexte, ErreurControle, Refus, Resultat,
  agreger, arrondi, bloquer, champPresent, combiner, contexte, cycle, decoderEntete, echapperEre, elaborer,
  equilibrer, evaluer, evoluer, examiner, executerControle, extrait, fixe, formatG, interne,
  main, maintenant, present, quote, synthese,
} from '../resolveur7e.mjs';
import { MAX_OPERATIONS, scenario, table } from './outils/etapes.mjs';
import { CHEMIN_MODELE, MODELE, RACINE, TICKET, avecDepot, contexteSur, criteresDuModele, depotJetable, manifesteMinimal, ticketEssai } from './outils/depot.mjs';
import { DOCKER, NEUTRE, SANS_COMPOSE, SANS_DEMON, avecEnv, capturer, jetable, pathAvec, pathSans } from './outils/environnement.mjs';

// Environnement neutre pour tout le fichier (processus dédié) : hors CI, sans
// configuration du résolveur héritée de la machine qui lance la recette.
for (const k of Object.keys(NEUTRE)) delete process.env[k];

/** Un résultat de contrôle réduit à ce que lisent agreger et combiner. */
const R = (resultat, type = 'commande', heuristique = false) => new Resultat(type, resultat, `constat ${resultat}`, { heuristique });

/** Exécute un contrôle sur un dépôt jetable ; rend le résultat et le contexte. */
function controler(depot, ctl, { cid = 'X.0', avant } = {}) {
  const ctx = contexteSur(depot, avant);
  const r = executerControle(ctl, ctx, cid);
  return { r, ctx };
}

/** Générateur pseudo-aléatoire à graine fixe (mulberry32) : des propriétés reproductibles. */
function aleatoire(graine) {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

/** Écrit une entrée de journal (objet) dans un dépôt jetable. */
function ecrireEntree(depot, instance, numero, entree) {
  depot.ecrire(`journal/${instance}/${String(numero).padStart(4, '0')}.yaml`, stringify(entree));
}

/** Une entrée de journal minimale, close ou ouverte. */
function entreeMinimale({ id = 'essai-0000', numero = 0, fin = '2026-10-01T10:00:00Z', contrat = '0.2', scores = {} } = {}) {
  return {
    cycle: { id, numero, instance: 'essai', niveau: 'instance', modele_version: '0.2.1', contrat_version: contrat, en_ci: false, debut: '2026-10-01T09:59:00Z', fin },
    release: 'abc123def456',
    plan: [],
    phases: {},
    scores,
    synthese: {},
  };
}

// ════════════════════════════════════════════════════════════════════════════
//  1. NOMBRES
//  Les moyennes du journal ont été arrondies par round(x, 2) de Python au
//  cycle 0 : au pair, sur la valeur décimale exacte du flottant. Les constats
//  des métriques suivent f"{x:g}". Le résolveur Node doit écrire les mêmes
//  chiffres, sinon deux cycles ne se comparent plus (finalite.viabilite).
// ════════════════════════════════════════════════════════════════════════════
describe('1. Nombres : parité avec round() et format() de Python', () => {
  test('arrondi : une égalité exacte va au chiffre pair', (t) => table(t, [
    ['0,125 → 0,12', () => arrondi(0.125), 0.12],
    ['0,375 → 0,38', () => arrondi(0.375), 0.38],
    ['0,625 → 0,62', () => arrondi(0.625), 0.62],
    ['0,875 → 0,88', () => arrondi(0.875), 0.88],
    ['1,125 → 1,12', () => arrondi(1.125), 1.12],
    ['−0,125 → −0,12', () => arrondi(-0.125), -0.12],
    ['0,5 à l’unité → 0', () => arrondi(0.5, 0), 0],
    ['1,5 à l’unité → 2', () => arrondi(1.5, 0), 2],
    ['2,5 à l’unité → 2', () => arrondi(2.5, 0), 2],
    ['3,5 à l’unité → 4', () => arrondi(3.5, 0), 4],
    ['−2,5 à l’unité → −2', () => arrondi(-2.5, 0), -2],
  ]));

  test('arrondi : une valeur proche d’une égalité suit sa valeur binaire exacte', (t) => table(t, [
    // 2,675 s'écrit 2,67499999999999982236431605997495353221893310546875 en binaire
    ['2,675 → 2,67', () => arrondi(2.675), 2.67],
    ['1,005 → 1', () => arrondi(1.005), 1],
    ['0,285 → 0,28', () => arrondi(0.285), 0.28],
    ['1,015 → 1,01', () => arrondi(1.015), 1.01],
    // 2,345 vaut 2,34500000000000019984… : au-dessus de l'égalité
    ['2,345 → 2,35', () => arrondi(2.345), 2.35],
    ['0,155 → 0,15', () => arrondi(0.155), 0.15],
  ]));

  test('arrondi : moyennes de scores sur 1 à 8 critères', (t) => table(t, [
    ['4/3 → 1,33', () => arrondi(4 / 3), 1.33],
    ['5/3 → 1,67', () => arrondi(5 / 3), 1.67],
    ['6/5 → 1,2', () => arrondi(6 / 5), 1.2],
    ['7/6 → 1,17', () => arrondi(7 / 6), 1.17],
    ['9/8 → 1,12 (égalité exacte)', () => arrondi(9 / 8), 1.12],
    ['11/8 → 1,38', () => arrondi(11 / 8), 1.38],
    ['13/8 → 1,62', () => arrondi(13 / 8), 1.62],
    ['15/8 → 1,88', () => arrondi(15 / 8), 1.88],
    ['5/4 → 1,25', () => arrondi(5 / 4), 1.25],
    ['7/4 → 1,75', () => arrondi(7 / 4), 1.75],
    ['3/7 → 0,43', () => arrondi(3 / 7), 0.43],
    ['10/7 → 1,43', () => arrondi(10 / 7), 1.43],
  ]));

  test('arrondi : zéro négatif, entiers, très grands nombres', (t) => table(t, [
    ['−0,001 → −0 (le signe est gardé, comme Python)', () => arrondi(-0.001), -0],
    ['0 → 0', () => arrondi(0), 0],
    ['5 → 5', () => arrondi(5), 5],
    ['123 456 789,125 → 123 456 789,12', () => arrondi(123456789.125), 123456789.12],
    ['1e21 → 1e21', () => arrondi(1e21), 1e21],
    ['−1,005 → −1', () => arrondi(-1.005), -1],
  ]));

  test('fixe : f décimales au pair, comme format() de Python', (t) => table(t, [
    ['1,5 à 0 → "2"', () => fixe(1.5, 0), '2'],
    ['2,5 à 0 → "2"', () => fixe(2.5, 0), '2'],
    ['0,5 à 0 → "0"', () => fixe(0.5, 0), '0'],
    ['1,25 à 1 → "1.2"', () => fixe(1.25, 1), '1.2'],
    ['1,35 à 1 → "1.4"', () => fixe(1.35, 1), '1.4'],
    ['−0 à 2 → "-0.00"', () => fixe(-0, 2), '-0.00'],
    ['−0,004 à 2 → "-0.00"', () => fixe(-0.004, 2), '-0.00'],
    ['0,1 à 20 → la valeur binaire exacte', () => fixe(0.1, 20), '0.10000000000000000555'],
    ['plus petit sous-normal à 3 → "0.000"', () => fixe(5e-324, 3), '0.000'],
    ['2,675 à 2 → "2.67"', () => fixe(2.675, 2), '2.67'],
    ['1e16 à 1 → "10000000000000000.0"', () => fixe(1e16, 1), '10000000000000000.0'],
    ['−1,005 à 2 → "-1.00"', () => fixe(-1.005, 2), '-1.00'],
    ['+∞ → "inf"', () => fixe(Infinity, 2), 'inf'],
    ['−∞ → "-inf"', () => fixe(-Infinity, 2), '-inf'],
    ['NaN → "nan"', () => fixe(NaN, 2), 'nan'],
  ]));

  test('formatG : six chiffres significatifs, zéros finaux retirés', (t) => table(t, [
    ['24 → "24"', () => formatG(24), '24'],
    ['0,5 → "0.5"', () => formatG(0.5), '0.5'],
    ['1 234 567 → "1.23457e+06"', () => formatG(1234567), '1.23457e+06'],
    ['123 456 → "123456"', () => formatG(123456), '123456'],
    ['100 000 → "100000"', () => formatG(100000), '100000'],
    ['1e6 → "1e+06"', () => formatG(1e6), '1e+06'],
    ['0,0001 → "0.0001"', () => formatG(0.0001), '0.0001'],
    ['0,00001 → "1e-05"', () => formatG(0.00001), '1e-05'],
    ['0,000123456789 → "0.000123457"', () => formatG(0.000123456789), '0.000123457'],
    ['999 999,5 → "1e+06" (la retenue change l’exposant)', () => formatG(999999.5), '1e+06'],
    ['9,9999996 → "10"', () => formatG(9.9999996), '10'],
    ['−3,5 → "-3.5"', () => formatG(-3.5), '-3.5'],
    ['0 → "0"', () => formatG(0), '0'],
    ['−0 → "-0"', () => formatG(-0), '-0'],
    ['0,1 + 0,2 → "0.3"', () => formatG(0.1 + 0.2), '0.3'],
    ['π approché → "3.14159"', () => formatG(3.14159265358979), '3.14159'],
  ]));

  test('formatG : égalités au sixième chiffre, exposants, précision choisie', (t) => table(t, [
    ['1024,125 → "1024.12" (égalité, au pair)', () => formatG(1024.125), '1024.12'],
    ['1024,375 → "1024.38"', () => formatG(1024.375), '1024.38'],
    ['123 456,5 → "123456"', () => formatG(123456.5), '123456'],
    ['123 457,5 → "123458"', () => formatG(123457.5), '123458'],
    ['1,0000005 → "1"', () => formatG(1.0000005), '1'],
    ['1e-7 → "1e-07"', () => formatG(1e-7), '1e-07'],
    ['1,23…e19 → "1.23457e+19"', () => formatG(12345678901234567890), '1.23457e+19'],
    ['2,5e-5 → "2.5e-05"', () => formatG(2.5e-5), '2.5e-05'],
    ['+∞ → "inf"', () => formatG(Infinity), 'inf'],
    ['−∞ → "-inf"', () => formatG(-Infinity), '-inf'],
    ['NaN → "nan"', () => formatG(NaN), 'nan'],
    ['1234,5678 à 3 chiffres → "1.23e+03"', () => formatG(1234.5678, 3), '1.23e+03'],
  ]));

  test('versFlottant : ce que la mesure d’une métrique accepte comme nombre', (t) => table(t, [
    ['"12" → 12', () => interne.versFlottant('12'), 12],
    ['" 12 " → 12 (espaces tolérés)', () => interne.versFlottant(' 12 '), 12],
    ['"+1.5" → 1,5', () => interne.versFlottant('+1.5'), 1.5],
    ['"-2e3" → −2000', () => interne.versFlottant('-2e3'), -2000],
    ['".5" → 0,5', () => interne.versFlottant('.5'), 0.5],
    ['"5." → 5', () => interne.versFlottant('5.'), 5],
    ['"  -.5e-3 " → −0,0005', () => interne.versFlottant('  -.5e-3 '), -0.0005],
    ['"inf" → +∞', () => interne.versFlottant('inf'), Infinity],
    ['"-Infinity" → −∞', () => interne.versFlottant('-Infinity'), -Infinity],
    ['"NaN" → NaN', () => interne.versFlottant('NaN'), NaN],
    ['"" → refusé', () => interne.versFlottant(''), null],
    ['"0x10" → refusé (Python le refuse aussi)', () => interne.versFlottant('0x10'), null],
    ['"12abc" → refusé', () => interne.versFlottant('12abc'), null],
    ['"1,5" → refusé (virgule décimale)', () => interne.versFlottant('1,5'), null],
    // Écart assumé : float('1_000') vaut 1000 en Python ; une mesure n'imprime pas de séparateur
    ['"1_000" → refusé (écart assumé avec Python)', () => interne.versFlottant('1_000'), null],
    ['"infini" → refusé', () => interne.versFlottant('infini'), null],
  ]));

  test('propriétés sur 2 000 flottants tirés au hasard (graine fixe)', (t) => {
    const s = scenario(t);
    const tirer = aleatoire(7);
    const valeurs = Array.from({ length: 2000 }, (_, i) => (tirer() * 2 - 1) * 10 ** ((i % 16) - 6));
    s.etape('arrondi(x) = Number(fixe(x, 2)) pour chaque valeur', () => valeurs.filter((x) => !Object.is(arrondi(x), Number(fixe(x, 2)))).length, { attendu: 0 });
    s.etape('|arrondi(x) − x| ≤ 0,005 (à un écart de représentation près)', () => valeurs.filter((x) => Math.abs(arrondi(x) - x) > 0.005 + Math.abs(x) * 1e-15).length, { attendu: 0 });
    s.etape('arrondi est idempotent', () => valeurs.filter((x) => arrondi(arrondi(x)) !== arrondi(x)).length, { attendu: 0 });
    s.etape('arrondi est symétrique : arrondi(−x) = −arrondi(x)', () => valeurs.filter((x) => arrondi(-x) !== -arrondi(x)).length, { attendu: 0 });
    s.etape('formatG garde six chiffres significatifs au plus', () => valeurs.filter((x) => formatG(x).replace(/^-/, '').split('e')[0].replace('.', '').replace(/^0+/, '').length > 6).length, { attendu: 0 });
    s.etape('formatG relu reste à 5e-6 près en valeur relative', () => valeurs.filter((x) => x !== 0 && Math.abs(Number(formatG(x)) - x) / Math.abs(x) > 5e-6).length, { attendu: 0 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  2. TEXTES
//  Les constats sont lus par des personnes et comparés d'un cycle à l'autre :
//  espaces réduits, couleurs des outils retirées, longueur bornée.
// ════════════════════════════════════════════════════════════════════════════
describe('2. Textes : extraits, lignes et valeurs des constats', () => {
  // le sujet d'un ticket MHTML (RFC 2047) : mots encodés adjacents joints, octets mis bout à bout
  test('decoderEntete : sujets encodés', (t) => {
    const b = Buffer.from('Évolution : connexion', 'utf8');
    const mot = (o, jeu = 'utf-8') => `=?${jeu}?B?${Buffer.from(o).toString('base64')}?=`;
    return table(t, [
      ['texte simple', () => decoderEntete('Ticket APP-12'), 'Ticket APP-12'],
      ['un mot encodé dans du texte', () => decoderEntete(`Re: ${mot('écran')} suite`), 'Re: écran suite'],
      ['deux mots adjacents : sans l’espace qui les sépare', () => decoderEntete(`${mot('conne')} ${mot('xion')}`), 'connexion'],
      ['un caractère UTF-8 coupé entre deux mots', () => decoderEntete(`${mot(b.subarray(0, 1))}\r\n ${mot(b.subarray(1))}`), 'Évolution : connexion'],
      ['Q en latin-1', () => decoderEntete('=?iso-8859-1?Q?caf=E9_cr=E8me?= ok'), 'café crème ok'],
    ]);
  });

  test('extrait : espaces réduits à un seul, bords retirés', (t) => table(t, [
    ['espaces, tabulation, saut de ligne', () => extrait('a  b\n\tc'), 'a b c'],
    ['bords retirés', () => extrait('   texte   '), 'texte'],
    ['texte vide', () => extrait(''), ''],
    ['nombre converti en texte', () => extrait(42), '42'],
  ]));

  test('extrait : les séquences des terminaux sont retirées', (t) => table(t, [
    ['couleurs CSI (sortie de gitleaks)', () => extrait('\x1b[90m11:24AM\x1b[0m \x1b[32mINF\x1b[0m aucune fuite'), '11:24AM INF aucune fuite'],
    ['lien OSC 8', () => extrait('\x1b]8;;https://exemple.org\x07lien\x1b]8;;\x07'), 'lien'],
    ['échappement à deux caractères', () => extrait('\x1bMtexte'), 'texte'],
    ['séquence de style composée', () => extrait('\x1b[1;31;4mrouge\x1b[0m'), 'rouge'],
  ]));

  test('extrait : coupe à n signes, avec points de suspension', (t) => table(t, [
    ['6 signes à 4 → 3 signes et …', () => extrait('abcdef', 4), 'abc…'],
    ['4 signes à 4 → intact', () => extrait('abcd', 4), 'abcd'],
    ['par points de code : 5 émojis à 3', () => extrait('😀😀😀😀😀', 3), '😀😀…'],
    ['300 signes, longueur par défaut 240', () => Array.from(extrait('x'.repeat(300))).length, 240],
    ['la coupe se fait après la réduction des espaces', () => extrait('a          b', 3), 'a b'],
  ]));

  test('lignesDe : coupe comme str.splitlines() de Python, lignes vides écartées', (t) => table(t, [
    ['\\r\\n, \\r et \\n', () => interne.lignesDe('a\r\nb\rc\nd'), ['a', 'b', 'c', 'd']],
    ['tabulation verticale et saut de page', () => interne.lignesDe('a\vb\fc'), ['a', 'b', 'c']],
    ['séparateurs de fichier, de groupe, d’enregistrement', () => interne.lignesDe('a\x1cb\x1dc\x1ed'), ['a', 'b', 'c', 'd']],
    ['NEL, séparateurs de ligne et de paragraphe Unicode', () => interne.lignesDe('a\x85b\u2028c\u2029d'), ['a', 'b', 'c', 'd']],
    ['lignes vides écartées', () => interne.lignesDe('a\n\n\nb\n'), ['a', 'b']],
    ['texte vide', () => interne.lignesDe(''), []],
  ]));

  test('texteDe : une valeur du manifeste insérée dans une commande', (t) => table(t, [
    ['null → ""', () => interne.texteDe(null), ''],
    ['undefined → ""', () => interne.texteDe(undefined), ''],
    ['texte', () => interne.texteDe('web'), 'web'],
    ['nombre', () => interne.texteDe(3), '3'],
    ['booléen', () => interne.texteDe(true), 'true'],
    ['table → JSON', () => interne.texteDe({ a: 1 }), '{"a":1}'],
    ['liste → JSON', () => interne.texteDe([1, 2]), '[1,2]'],
  ]));

  test('texteAssertion : la valeur d’une assertion jq dans un constat', (t) => table(t, [
    ['vrai', () => interne.texteAssertion(true), 'vrai'],
    ['faux', () => interne.texteAssertion(false), 'faux'],
    ['texte tel quel', () => interne.texteAssertion('essai'), 'essai'],
    ['nombre', () => interne.texteAssertion(2), '2'],
    ['null', () => interne.texteAssertion(null), 'null'],
    ['liste', () => interne.texteAssertion([1, 2]), '[1,2]'],
    ['table', () => interne.texteAssertion({ viable: true }), '{"viable":true}'],
  ]));

  test('maintenant : horodatage UTC à la seconde, suffixe Z', (t) => {
    const s = scenario(t);
    const h = s.etape('forme AAAA-MM-JJTHH:MM:SSZ', () => maintenant(), { verifier: (v) => assert.match(v, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/) });
    s.etape('à moins de deux secondes de l’horloge', () => Math.abs(Date.parse(h) - Date.now()) < 2000, { attendu: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  3. ÉCHAPPEMENTS
//  types_de_controle.regles.insertion : une valeur du manifeste insérée dans une
//  expression régulière y est échappée. Les options compose passent par le
//  shell : elles sont citées comme shlex.quote. Chaque propriété est vérifiée
//  par l'outil lui-même (grep -E, sh), pas par une réimplémentation.
// ════════════════════════════════════════════════════════════════════════════
describe('3. Échappements : ERE et shell', () => {
  test('echapperEre : chacun des 14 caractères spéciaux est échappé', (t) => {
    const s = scenario(t);
    for (const c of ['\\', '.', '[', ']', '{', '}', '(', ')', '*', '+', '?', '^', '$', '|']) {
      s.etape(`« ${c} » → « \\${c} »`, () => echapperEre(c), { attendu: `\\${c}` });
    }
  });

  test('echapperEre : le texte ordinaire passe tel quel', (t) => table(t, [
    ['lettres, chiffres, tirets', () => echapperEre('web-1_a'), 'web-1_a'],
    ['barres, deux-points, arobase', () => echapperEre('a/b:c@d'), 'a/b:c@d'],
    ['accents et espaces', () => echapperEre('été à'), 'été à'],
    ['mélange', () => echapperEre('DATABASE.URL'), 'DATABASE\\.URL'],
  ]));

  test('echapperEre : grep -E -x reconnaît le littéral, et lui seul', (t) => {
    const s = scenario(t);
    const correspond = (motif, texte) => spawnSync('grep', ['-Ex', '-e', motif], { input: `${texte}\n` }).status === 0;
    const cas = [['a.b', 'axb'], ['x[1]', 'x1'], ['(groupe)', 'groupe'], ['a+b?', 'aab'], ['^début$', 'début'], ['a|b', 'a'], ['c:\\temp', 'c:temp'], ['{{ x }}', '{ x }']];
    for (const [litteral, voisin] of cas) {
      s.etape(`« ${litteral} » se reconnaît, « ${voisin} » non`, () => [correspond(echapperEre(litteral), litteral), correspond(echapperEre(litteral), voisin)], { attendu: [true, false] });
    }
  });

  test('quote : comme shlex.quote de Python', (t) => table(t, [
    ['texte vide → \'\'', () => quote(''), "''"],
    ['mot sûr, intact', () => quote('compose.prod.yml'), 'compose.prod.yml'],
    ['tous les signes sûrs', () => quote('a-b_c.d/e:f,g@h%i+j=k'), 'a-b_c.d/e:f,g@h%i+j=k'],
    ['espace → entre apostrophes', () => quote('mon fichier'), "'mon fichier'"],
    ['apostrophe → fermée, citée, rouverte', () => quote("d'autres"), `'d'"'"'autres'`],
    ['non ASCII → cité (\\w ASCII, comme re.ASCII)', () => quote('été'), "'été'"],
    ['variable shell → citée', () => quote('$HOME'), "'$HOME'"],
    ['joker → cité', () => quote('*'), "'*'"],
    ['nombre converti', () => quote(42), '42'],
  ]));

  test('quote : sh relit exactement le texte d’origine', (t) => {
    const s = scenario(t);
    const relu = (texte) => spawnSync('sh', ['-c', `printf %s ${quote(texte)}`], { encoding: 'utf8' }).stdout;
    for (const texte of ['', 'simple', 'deux mots', "d'autres", '"guillemets"', '$HOME', '`date`', '\\', '*', 'a;b', 'été à', '\t tab', "fin'", "'''", '!histoire', '{a,b}']) {
      s.etape(`relu : ${JSON.stringify(texte)}`, () => relu(texte), { attendu: texte });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  4. MANIFESTE
//  types_de_controle.regles.requiert : un champ cité et non déclaré donne
//  « partiel ». « <nom> » vaut chaque entrée d'une table ; dans une liste, le
//  champ vaut s'il est porté par un élément.
// ════════════════════════════════════════════════════════════════════════════
describe('4. Manifeste : présence et lecture des champs', () => {
  test('present : ce qui compte comme absent', (t) => table(t, [
    ['null', () => present(null), false],
    ['undefined', () => present(undefined), false],
    ['texte vide', () => present(''), false],
    ['liste vide', () => present([]), false],
    ['table vide', () => present({}), false],
  ]));

  test('present : ce qui compte comme présent, même « faux »', (t) => table(t, [
    ['zéro', () => present(0), true],
    ['false', () => present(false), true],
    ['"0"', () => present('0'), true],
    ['espace', () => present(' '), true],
    ['liste d’un élément nul', () => present([0]), true],
    ['table à valeur nulle', () => present({ a: null }), true],
  ]));

  test('champPresent : chemins simples et imbriqués', (t) => {
    const m = { instance: { id: 'essai', nom: '' }, journal: 'journal', liste: [] };
    table(t, [
      ['champ de premier niveau', () => champPresent(m, 'journal'), true],
      ['champ imbriqué', () => champPresent(m, 'instance.id'), true],
      ['champ imbriqué vide', () => champPresent(m, 'instance.nom'), false],
      ['champ inconnu', () => champPresent(m, 'release'), false],
      ['liste vide', () => champPresent(m, 'liste'), false],
      ['au travers d’un texte', () => champPresent(m, 'journal.sous'), false],
      ['clé de prototype « constructor »', () => champPresent(m, 'constructor'), false],
      ['clé « __proto__ »', () => champPresent(m, '__proto__'), false],
    ]);
  });

  test('champPresent : <nom> exige chaque entrée de la table', (t) => table(t, [
    ['une entrée sur deux porte le champ', () => champPresent({ environnements: { dev: { r: 'x' }, production: {} } }, 'environnements.<nom>.r'), false],
    ['toutes les entrées le portent', () => champPresent({ environnements: { dev: { r: 'x' }, production: { r: 'y' } } }, 'environnements.<nom>.r'), true],
    ['table vide', () => champPresent({ environnements: {} }, 'environnements.<nom>.r'), false],
    ['entrée vide', () => champPresent({ environnements: { dev: null } }, 'environnements.<nom>.r'), false],
  ]));

  test('champPresent : un champ de liste vaut s’il est porté par un élément', (t) => table(t, [
    ['un élément sur deux', () => champPresent({ consomme: [{ type: 'service', via: 'DATABASE_URL' }, { type: 'bibliotheque' }] }, 'consomme.via'), true],
    ['aucun élément', () => champPresent({ consomme: [{ type: 'bibliotheque' }] }, 'consomme.via'), false],
    ['la liste elle-même', () => champPresent({ consomme: [{ type: 'service' }] }, 'consomme'), true],
    ['liste dans une liste', () => champPresent({ a: [[{ b: 1 }]] }, 'a.b'), true],
  ]));

  test('valeur : lecture d’un champ, ChampAbsent préfixé sinon', (t) => {
    const s = scenario(t);
    const m = { tests: { fumee: 'curl -fsS http://x/sante' }, vide: '' };
    s.etape('champ imbriqué', () => interne.valeur(m, 'tests.fumee'), { attendu: 'curl -fsS http://x/sante' });
    s.etape('champ absent → ChampAbsent', () => assert.throws(() => interne.valeur(m, 'tests.session'), interne.ChampAbsent));
    s.etape('le message porte le chemin préfixé', () => { try { interne.valeur({}, 'nom', 'item.'); return null; } catch (e) { return e.message; } }, { attendu: 'item.nom' });
    s.etape('champ vide → ChampAbsent', () => assert.throws(() => interne.valeur(m, 'vide'), interne.ChampAbsent));
    s.etape('au travers d’un texte → ChampAbsent', () => assert.throws(() => interne.valeur(m, 'tests.fumee.x'), interne.ChampAbsent));
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  5. EXÉCUTION
//  lancer() est le seul point d'appel des outils : son contrat de codes est
//  celui du modèle (types_de_controle.regles.erreur) : 127 outil absent, 124
//  délai dépassé, code du processus sinon.
// ════════════════════════════════════════════════════════════════════════════
describe('5. Exécution : lancer et le délai des contrôles', () => {
  const rep = mkdtempSync(join(tmpdir(), 'r7e-lancer-'));

  test('code, sortie standard et sortie d’erreur', (t) => table(t, [
    ['code 3, out et err séparés', () => interne.lancer(['sh', '-c', 'echo sortie; echo erreur >&2; exit 3'], rep), { code: 3, out: 'sortie\n', err: 'erreur\n' }],
    ['réussite', () => interne.lancer(['true'], rep).code, 0],
    ['répertoire de travail respecté', () => interne.lancer(['pwd'], rep).out.trim(), realpathSync(rep)],
    ['entrée standard fermée : cat rend la main', () => interne.lancer(['cat'], rep), { code: 0, out: '', err: '' }],
    ['entrée fournie', () => interne.lancer(['cat'], rep, { entree: 'abc' }).out, 'abc'],
  ]));

  test('outil absent : 127, que le shell le dise ou non', (t) => table(t, [
    ['exécutable introuvable (ENOENT)', () => interne.lancer(['commande_introuvable_7e'], rep), { code: 127, out: '', err: 'commande_introuvable_7e : introuvable' }],
    ['commande introuvable dans sh', () => interne.lancer(['sh', '-c', 'commande_introuvable_7e'], rep).code, 127],
  ]));

  test('délai dépassé : 124, le processus est tué', (t) => {
    const s = scenario(t);
    const debut = Date.now();
    s.etape('DELAI_CONTROLE_7E=1, sleep 5', () => avecEnv({ DELAI_CONTROLE_7E: '1' }, () => interne.lancer(['sh', '-c', 'sleep 5'], rep)), { attendu: { code: 124, out: '', err: 'délai dépassé' } });
    s.etape('rendu en moins de 4 secondes', () => Date.now() - debut < 4000, { attendu: true });
    s.etape('l’option delai prime sur la variable', () => interne.lancer(['sh', '-c', 'sleep 5'], rep, { delai: 1 }).code, { attendu: 124 });
    // regles.delai (0.5.0) : seul le processus lancé est tué ; sa sortie partielle reste au constat
    s.etape('la sortie partielle est gardée', () => interne.lancer(['sh', '-c', 'echo debut; sleep 5'], rep, { delai: 1 }), { attendu: { code: 124, out: 'debut\n', err: 'délai dépassé' } });
  });

  test('flux : signal, grosse sortie, entrée non lue', (t) => table(t, [
    ['tué par SIGTERM → 128 + 15', () => interne.lancer(['sh', '-c', 'kill -TERM $$'], rep).code, 143],
    ['3 Mo de sortie lus en entier', () => interne.lancer(['sh', '-c', 'head -c 3000000 /dev/zero | tr "\\0" a'], rep).out.length, 3000000],
    // EPIPE : le processus sort sans lire 5 Mo d'entrée ; son propre code fait foi
    ['5 Mo d’entrée non lus : le code du processus', () => interne.lancer(['sh', '-c', 'exit 3'], rep, { entree: 'x'.repeat(5 * 1024 * 1024) }).code, 3],
  ]));

  test('delaiControle : un entier de secondes, sinon refus', (t) => {
    const s = scenario(t);
    const delai = (v) => avecEnv({ DELAI_CONTROLE_7E: v }, () => interne.delaiControle());
    s.etape('défaut : 600', () => avecEnv({ DELAI_CONTROLE_7E: undefined }, () => interne.delaiControle()), { attendu: 600 });
    s.etape('" 30 " → 30', () => delai(' 30 '), { attendu: 30 });
    s.etape('"+5" → 5', () => delai('+5'), { attendu: 5 });
    s.etape('"" → refus', () => assert.throws(() => delai(''), Refus));
    s.etape('"abc" → refus', () => assert.throws(() => delai('abc'), Refus));
    s.etape('"0" → refus', () => assert.throws(() => delai('0'), Refus));
    s.etape('"1.5" → refus', () => assert.throws(() => delai('1.5'), Refus));
    s.etape('"-3" → refus', () => assert.throws(() => delai('-3'), Refus));
  });

  test('trouver : un outil exécutable dans le PATH', (t) => {
    const s = scenario(t);
    s.etape('sh est trouvé', () => interne.trouver('sh'), { attendu: true });
    s.etape('un outil absent ne l’est pas', () => interne.trouver('commande_introuvable_7e'), { attendu: false });
    s.etape('un exécutable simulé est trouvé', () => avecEnv({ PATH: pathAvec({ outil_simule_7e: 'exit 0' }) }, () => interne.trouver('outil_simule_7e')), { attendu: true });
    s.etape('PATH vide : rien n’est trouvé', () => avecEnv({ PATH: '' }, () => interne.trouver('sh')), { attendu: false });
  });

  // Sous Windows, spawnSync (libuv) lance git.exe pour « git », jamais un fichier sans
  // extension : trouver() doit dire la même chose (le résolveur déclarait git absent
  // alors qu'il venait de lire la release avec lui).
  test('trouver sous Windows : .com puis .exe, comme spawnSync', (t) => {
    const s = scenario(t);
    const exe = mkdtempSync(join(tmpdir(), 'r7e-win-exe-'));
    const nu = mkdtempSync(join(tmpdir(), 'r7e-win-nu-'));
    writeFileSync(join(exe, 'git.exe'), '');       // sans bit d'exécution : Windows n'en a pas
    writeFileSync(join(exe, 'jq.com'), '');
    writeFileSync(join(nu, 'docker'), '#!/bin/sh\n', { mode: 0o755 });
    const win = (outil, chemin) => interne.trouver(outil, { plateforme: 'win32', chemin, separateur: ';' });
    s.etape('git.exe → git trouvé', () => win('git', exe), { attendu: true });
    s.etape('jq.com → jq trouvé', () => win('jq', exe), { attendu: true });
    s.etape('fichier sans extension → non trouvé (spawnSync ne le lance pas)', () => win('docker', nu), { attendu: false });
    s.etape('séparateur ; et répertoire vide ignorés', () => win('git', `;${nu};${exe}`), { attendu: true });
    s.etape('sous POSIX, git.exe ne vaut pas git', () => interne.trouver('git', { plateforme: 'linux', chemin: exe, separateur: ':' }), { attendu: false });
    s.etape('sous POSIX, le nom tel quel, exécutable', () => interne.trouver('docker', { plateforme: 'linux', chemin: nu, separateur: ':' }), { attendu: true });
    rmSync(exe, { recursive: true, force: true });
    rmSync(nu, { recursive: true, force: true });
  });

  after(() => rmSync(rep, { recursive: true, force: true }));
});

// ════════════════════════════════════════════════════════════════════════════
//  6. CONTEXTE
//  Le contexte rassemble ce qu'Évaluer collecte : modèle, manifeste, outils,
//  CI, seuils requis (EX.2), version du contrat, et les accès que partagent les
//  contrôles (fichiers versionnés, compose, placeholders, jq, journal).
// ════════════════════════════════════════════════════════════════════════════
describe('6. Contexte d’un cycle', () => {
  test('identité : instance, numéro, identifiant de cycle', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    const ctx = contexteSur(depot);
    s.etape('instance lue dans le manifeste', () => ctx.instance, { attendu: 'essai' });
    s.etape('numéro 0 à la création', () => ctx.numero, { attendu: 0 });
    s.etape('cycle essai-0000', () => ctx.cycleId, { attendu: 'essai-0000' });
    s.etape('numéro 12 → essai-0012', () => { ctx.numero = 12; return ctx.cycleId; }, { attendu: 'essai-0012' });
    s.etape('release inconnue avant Évaluer', () => ctx.release, { attendu: null });
    s.etape('35 critères dans l’ordre du modèle', () => ctx.criteres.map(([id]) => id), { attendu: criteresDuModele().map(([id]) => id) });
  }));

  test('identité : manifeste sans instance, manifeste vide', (t) => {
    const s = scenario(t);
    s.etape('sans section instance → « instance »', () => avecDepot({ manifeste: { journal: 'journal' } }, (d) => contexteSur(d).instance), { attendu: 'instance' });
    s.etape('fichier vide → manifeste {}', () => avecDepot({ manifeste: '' }, (d) => contexteSur(d).m), { attendu: {} });
  });

  test('lecture : modèle ou manifeste qui ne sont pas des tables', (t) => {
    const s = scenario(t);
    s.etape('manifeste en liste → refus', () => avecDepot({ manifeste: '- a\n- b\n' }, (d) => assert.throws(() => contexteSur(d), /le manifeste doit être une table YAML/)));
    s.etape('modèle en texte → refus', () => avecDepot({ modele: 'texte seul\n' }, (d) => assert.throws(() => contexteSur(d), /le modèle doit être une table YAML/)));
    s.etape('YAML invalide → refus « YAML illisible »', () => avecDepot({ manifeste: 'a: [1, 2\n' }, (d) => assert.throws(() => contexteSur(d), /YAML illisible/)));
    s.etape('clé en double → refus (YAML strict)', () => avecDepot({ manifeste: 'a: 1\na: 2\n' }, (d) => assert.throws(() => contexteSur(d), Refus)));
  });

  test('outils : détectés dans le PATH, simulés ou masqués', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    s.etape('les sept outils sont recensés, dans l’ordre', () => Object.keys(contexteSur(depot).outils), { attendu: ['sh', 'git', 'jq', 'grep', 'docker', 'gitleaks', 'trivy'] });
    s.etape('sh, git, jq et grep présents', () => { const o = contexteSur(depot).outils; return [o.sh, o.git, o.jq, o.grep]; }, { attendu: [true, true, true, true] });
    s.etape('gitleaks et trivy simulés → présents', () => avecEnv({ PATH: pathAvec({ gitleaks: 'exit 0', trivy: 'exit 0' }) }, () => { const o = contexteSur(depot).outils; return [o.gitleaks, o.trivy]; }), { attendu: [true, true] });
    s.etape('jq et docker masqués → absents', () => avecEnv({ PATH: pathSans(['jq', 'docker']) }, () => { const o = contexteSur(depot).outils; return [o.jq, o.docker]; }), { attendu: [false, false] });
  }));

  test('CI : détectée par CI, GITEA_ACTIONS ou GITHUB_ACTIONS', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    const enCi = (vars) => avecEnv({ CI: undefined, GITEA_ACTIONS: undefined, GITHUB_ACTIONS: undefined, ...vars }, () => contexteSur(depot).enCi);
    s.etape('aucune variable → hors CI', () => enCi({}), { attendu: false });
    s.etape('CI=true', () => enCi({ CI: 'true' }), { attendu: true });
    s.etape('CI=1', () => enCi({ CI: '1' }), { attendu: true });
    s.etape('CI=TRUE (casse ignorée)', () => enCi({ CI: 'TRUE' }), { attendu: true });
    s.etape('CI=false', () => enCi({ CI: 'false' }), { attendu: false });
    s.etape('CI=yes (seuls true et 1 comptent)', () => enCi({ CI: 'yes' }), { attendu: false });
    s.etape('GITEA_ACTIONS=true', () => enCi({ GITEA_ACTIONS: 'true' }), { attendu: true });
    s.etape('GITHUB_ACTIONS=1', () => enCi({ GITHUB_ACTIONS: '1' }), { attendu: true });
  }));

  test('seuils requis ($requis, EX.2) : métriques des critères applicables, plus la revue', (t) => {
    const s = scenario(t);
    const requis = (sansObjet) => avecDepot({ manifeste: manifesteMinimal(sansObjet ? { sans_objet: sansObjet } : {}) }, (d) => contexteSur(d).requis);
    s.etape('aucun critère sans objet', () => requis(null), { attendu: ['delai_commit_production_h', 'periode_revue_cycles', 'temps_demarrage_s'] });
    s.etape('9.1 sans objet : temps_demarrage_s n’est plus requis', () => requis({ '9.1': 'aucun processus long' }), { attendu: ['delai_commit_production_h', 'periode_revue_cycles'] });
    s.etape('9.1 et 10.2 sans objet : la revue seule', () => requis({ '9.1': 'x', '10.2': 'y' }), { attendu: ['periode_revue_cycles'] });
    s.etape('trié par ordre alphabétique', () => { const r = requis(null); return [...r].sort(); }, { attendu: ['delai_commit_production_h', 'periode_revue_cycles', 'temps_demarrage_s'] });
  });

  test('version du contrat (versionnage.contrat_version)', (t) => {
    const s = scenario(t);
    const version = (v) => avecDepot({ modele: readFileSync(CHEMIN_MODELE, 'utf8').replace(/^  version: .+$/m, `  version: ${v}`) }, (d) => contexteSur(d).contratVersion);
    s.etape('0.2.1 → « 0.2 »', () => version('0.2.1'), { attendu: '0.2' });
    s.etape('0.10.3 → « 0.10 »', () => version('0.10.3'), { attendu: '0.10' });
    s.etape('1.4.2 → « 1 »', () => version('1.4.2'), { attendu: '1' });
    s.etape('2.0.0 → « 2 »', () => version('2.0.0'), { attendu: '2' });
  });

  test('journalDir : <journal>/<instance>', (t) => {
    const s = scenario(t);
    s.etape('défaut', () => avecDepot({}, (d) => contexteSur(d).journalDir().slice(d.chemin.length)), { attendu: '/journal/essai' });
    s.etape('répertoire déclaré « historique »', () => avecDepot({ manifeste: manifesteMinimal({ journal: 'historique' }) }, (d) => contexteSur(d).journalDir().slice(d.chemin.length)), { attendu: '/historique/essai' });
    // regles.exclusion (0.4.0) : une seule forme normalisée, relative à la racine
    const relatif = (j) => avecDepot({}, (d) => contexteSur(d, (c) => { c.m.journal = typeof j === 'function' ? j(d) : j; }).journalRelatif());
    s.etape('./journal, journal/, journal// et le chemin absolu → « journal »', () => ['./journal', 'journal/', 'journal//', (d) => join(d.chemin, 'journal')].map(relatif), { attendu: ['journal', 'journal', 'journal', 'journal'] });
    s.etape('sous-répertoire normalisé : ./a//b/ → « a/b »', () => relatif('./a//b/'), { attendu: 'a/b' });
    s.etape('journal absent ou vide : le défaut « journal »', () => [relatif(undefined), relatif('')], { attendu: ['journal', 'journal'] });
  });

  test('fichiersVersionnes : git ls-files, noms d’espace et d’accent compris', (t) => avecDepot({ fichiers: { 'src/mon fichier.js': 'x', 'docs/été.md': 'y', '.gitignore': 'local/\n' } }, (depot) => {
    const s = scenario(t);
    depot.ecrire('non-versionne.txt', 'z');
    const ctx = contexteSur(depot);
    const fichiers = s.etape('liste lue', () => ctx.fichiersVersionnes(), { verifier: (f) => assert.ok(f.length >= 4) });
    s.etape('nom avec espace', () => fichiers.includes('src/mon fichier.js'), { attendu: true });
    s.etape('nom accentué (lu avec -z, sans échappement)', () => fichiers.includes('docs/été.md'), { attendu: true });
    s.etape('fichier non versionné absent', () => fichiers.includes('non-versionne.txt'), { attendu: false });
    s.etape('liste mémorisée pour le cycle', () => { depot.ecrire('plus-tard.txt', 'a'); depot.commit(); return ctx.fichiersVersionnes().includes('plus-tard.txt'); }, { attendu: false });
  }));

  test('fichiersVersionnes : hors d’un dépôt Git, erreur d’exécution', (t) => {
    const s = scenario(t);
    const rep = mkdtempSync(join(tmpdir(), 'r7e-sans-git-'));
    writeFileSync(join(rep, 'modele-executif-12f-7e.yaml'), readFileSync(CHEMIN_MODELE, 'utf8'));
    writeFileSync(join(rep, '7e-instance.yaml'), stringify(manifesteMinimal()));
    const ctx = new Contexte(rep, join(rep, 'modele-executif-12f-7e.yaml'), join(rep, '7e-instance.yaml'));
    s.etape('ErreurControle de cause execution', () => { try { ctx.fichiersVersionnes(); return null; } catch (e) { return [e instanceof ErreurControle, e.causeControle]; } }, { attendu: [true, 'execution'] });
    rmSync(rep, { recursive: true, force: true });
  });

  test('optionsCompose : options d’un environnement, citées pour le shell', (t) => {
    const m = manifesteMinimal({
      environnements: {
        dev: { fichiers: ['compose.yaml'] },
        production: { fichiers: ['compose.yaml', 'compose.prod.yaml'], env_file: '.env.prod' },
        espace: { fichiers: ['mon compose.yaml'] },
        texte: { fichiers: 'compose.yaml' },
        vide: { fichiers: [] },
      },
      environnement_test: 'dev',
    });
    avecDepot({ manifeste: m }, (depot) => {
      const s = scenario(t);
      const ctx = contexteSur(depot);
      s.etape('dev', () => ctx.optionsCompose('dev'), { attendu: '-f compose.yaml' });
      s.etape('production, fichier d’environnement compris', () => ctx.optionsCompose('production'), { attendu: '-f compose.yaml -f compose.prod.yaml --env-file .env.prod' });
      s.etape('test : environnement_test et projet éphémère', () => ctx.optionsCompose('test'), { attendu: '-p 7e-essai-0000 -f compose.yaml' });
      s.etape('depot : la config du seul dépôt (.env.example)', () => ctx.optionsCompose('depot'), { attendu: '-p 7e-essai-0000 -f compose.yaml --env-file .env.example' });
      s.etape('nom de fichier avec espace, cité', () => ctx.optionsCompose('espace'), { attendu: "-f 'mon compose.yaml'" });
      s.etape('fichiers en texte seul, pris comme une liste', () => ctx.optionsCompose('texte'), { attendu: '-f compose.yaml' });
      s.etape('liste vide → HorsCompose', () => assert.throws(() => ctx.optionsCompose('vide'), interne.HorsCompose));
      s.etape('environnement inconnu → ChampAbsent', () => { try { ctx.optionsCompose('recette'); return null; } catch (e) { return [e instanceof interne.ChampAbsent, e.message]; } }, { attendu: [true, 'environnements.recette'] });
    });
  });

  test('optionsCompose : nom du projet éphémère assaini, environnement_test exigé', (t) => {
    const s = scenario(t);
    const m = manifesteMinimal({ instance: { id: 'Essai Été', niveau: 'instance' }, environnements: { dev: { fichiers: ['c.yaml'] } }, environnement_test: 'dev' });
    s.etape('minuscules, caractères hors [a-z0-9_-] remplacés', () => avecDepot({ manifeste: m }, (d) => contexteSur(d).optionsCompose('test')), { attendu: '-p 7e-essai--t--0000 -f c.yaml' });
    const sansTest = manifesteMinimal({ environnements: { dev: { fichiers: ['c.yaml'] } } });
    s.etape('environnement_test absent → ChampAbsent', () => avecDepot({ manifeste: sansTest }, (d) => { try { contexteSur(d).optionsCompose('test'); return null; } catch (e) { return e.message; } }), { attendu: 'environnement_test' });
  });

  test('resoudre : chaque forme de placeholder', (t) => {
    const m = manifesteMinimal({ expose: { contrat: 'api.v1.yaml', port: 8080, options: { a: 1 } }, environnements: { dev: { fichiers: ['compose.yaml'] } }, environnement_test: 'dev' });
    avecDepot({ manifeste: m }, (depot) => {
      const s = scenario(t);
      const ctx = contexteSur(depot);
      s.etape('{{ manifeste.instance.id }}', () => ctx.resoudre('id={{ manifeste.instance.id }}'), { attendu: 'id=essai' });
      s.etape('sans espaces : {{manifeste.instance.id}}', () => ctx.resoudre('{{manifeste.instance.id}}'), { attendu: 'essai' });
      s.etape('nombre du manifeste', () => ctx.resoudre('{{ manifeste.expose.port }}'), { attendu: '8080' });
      s.etape('table du manifeste → JSON', () => ctx.resoudre('{{ manifeste.expose.options }}'), { attendu: '{"a":1}' });
      s.etape('en expression régulière : échappé', () => ctx.resoudre('^{{ manifeste.expose.contrat }}$', null, true), { attendu: '^api\\.v1\\.yaml$' });
      s.etape('{{ item }} texte', () => ctx.resoudre('img={{ item }}', 'nginx:1.27'), { attendu: 'img=nginx:1.27' });
      s.etape('{{ item.service }}', () => ctx.resoudre('{{ item.service }}', { service: 'web' }), { attendu: 'web' });
      s.etape('{{ item.service }} sur un texte → ChampAbsent item.service', () => { try { ctx.resoudre('{{ item.service }}', 'web'); return null; } catch (e) { return e.message; } }, { attendu: 'item.service' });
      s.etape('{{ cycle.id }}', () => ctx.resoudre('{{ cycle.id }}'), { attendu: 'essai-0000' });
      s.etape('{{ cycle.release }} avant Évaluer → vide', () => ctx.resoudre('[{{ cycle.release }}]'), { attendu: '[]' });
      s.etape('{{ cycle.release }} après Évaluer', () => { ctx.release = 'v1.2.3'; return ctx.resoudre('{{ cycle.release }}'); }, { attendu: 'v1.2.3' });
      s.etape('{{ compose.dev }} : options, jamais échappées', () => ctx.resoudre('{{ compose.dev }}', null, true), { attendu: '-f compose.yaml' });
      s.etape('champ absent → ChampAbsent instance.absent', () => { try { ctx.resoudre('{{ manifeste.instance.absent }}'); return null; } catch (e) { return e.message; } }, { attendu: 'instance.absent' });
      s.etape('placeholder inconnu → erreur d’exécution', () => { try { ctx.resoudre('{{ autre.chose }}'); return null; } catch (e) { return [e.causeControle, e.message]; } }, { attendu: ['execution', 'placeholder inconnu : autre.chose'] });
      s.etape('texte sans placeholder intact', () => ctx.resoudre('git rev-parse HEAD'), { attendu: 'git rev-parse HEAD' });
    });
  });

  test('jq : assertion sur des données, avec $m et $requis', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    const ctx = contexteSur(depot);
    s.etape('valeur simple', () => ctx.jq('.a', { a: 1 }), { attendu: 1 });
    s.etape('$m : le manifeste', () => ctx.jq('$m.instance.id', null), { attendu: 'essai' });
    s.etape('$requis : les seuils exigés', () => ctx.jq('$requis | length', null), { attendu: 3 });
    s.etape('aucune sortie (empty) → null', () => ctx.jq('empty', {}), { attendu: null });
    s.etape('deux valeurs → erreur « une seule valeur »', () => { try { ctx.jq('.a, .b', { a: 1, b: 2 }); return null; } catch (e) { return [e.causeControle, e.message.startsWith('jq : une seule valeur JSON attendue')]; } }, { attendu: ['execution', true] });
    s.etape('syntaxe invalide → erreur d’exécution', () => { try { ctx.jq('.[', {}); return null; } catch (e) { return e.causeControle; } }, { attendu: 'execution' });
    s.etape('jq masqué → outil absent', () => avecEnv({ PATH: pathSans(['jq']) }, () => { try { contexteSur(depot).jq('.', {}); return null; } catch (e) { return [e.causeControle, e.message]; } }), { attendu: ['outil_absent', 'jq introuvable'] });
    s.etape('5 Mo de données passent', () => ctx.jq('length', 'x'.repeat(5 * 1024 * 1024)), { attendu: 5 * 1024 * 1024 });
  }));

  test('journal : entrées triées par nom, fichiers parasites écartés', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    ecrireEntree(depot, 'essai', 1, entreeMinimale({ id: 'essai-0001', numero: 1 }));
    ecrireEntree(depot, 'essai', 0, entreeMinimale());
    depot.ecrire('journal/essai/.cache.yaml', 'cycle: {}\n');
    depot.ecrire('journal/essai/notes.txt', 'note');
    const ctx = contexteSur(depot);
    s.etape('deux entrées, dans l’ordre des noms', () => ctx.journal().map(([, e]) => e.cycle.id), { attendu: ['essai-0000', 'essai-0001'] });
    s.etape('pas de répertoire → aucune entrée', () => avecDepot({}, (d) => contexteSur(d).journal()), { attendu: [] });
  }));

  test('journal : une entrée illisible arrête le cycle', (t) => {
    const s = scenario(t);
    s.etape('YAML invalide → refus', () => avecDepot({ fichiers: { 'journal/essai/0000.yaml': 'cycle: [\n' } }, (d) => assert.throws(() => contexteSur(d).journal(), /YAML illisible/)));
    s.etape('sans section cycle → refus', () => avecDepot({ fichiers: { 'journal/essai/0000.yaml': 'release: x\n' } }, (d) => assert.throws(() => contexteSur(d).journal(), /sans section cycle/)));
  });

  test('journalClos : entrées closes seulement, triées par fin', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    ecrireEntree(depot, 'essai', 0, entreeMinimale({ id: 'essai-0000', fin: '2026-10-02T10:00:00Z' }));
    ecrireEntree(depot, 'essai', 1, entreeMinimale({ id: 'essai-0001', numero: 1, fin: '2026-10-01T10:00:00Z' }));
    ecrireEntree(depot, 'essai', 2, entreeMinimale({ id: 'essai-0002', numero: 2, fin: null }));
    s.etape('l’entrée ouverte est écartée, l’ordre suit la fin', () => contexteSur(depot).journalClos().map((e) => e.cycle.id), { attendu: ['essai-0001', 'essai-0000'] });
  }));
});

// ════════════════════════════════════════════════════════════════════════════
//  7. CONTRÔLES
//  types_de_controle.types : les neuf types, chacun avec ses paramètres et ses
//  cinq résultats possibles (conforme, partiel, absent, sans_objet, erreur).
// ════════════════════════════════════════════════════════════════════════════
describe('7. Contrôles', () => {
  describe('commande', () => {
    test('code de retour et sortie attendue', (t) => avecDepot({}, (depot) => {
      const s = scenario(t);
      const c = (ctl) => { const { r } = controler(depot, { type: 'commande', ...ctl }); return [r.resultat, r.constat]; };
      s.etape('true → conforme, détail « code 0 »', () => c({ commande: 'true' }), { attendu: ['conforme', 'true → code 0'] });
      s.etape('false → absent', () => c({ commande: 'false' }), { attendu: ['absent', 'false → code 1'] });
      s.etape('sortie non vide attendue et obtenue', () => c({ commande: 'echo bonjour', attendu: 'sortie_non_vide' }), { attendu: ['conforme', 'echo bonjour → bonjour'] });
      s.etape('sortie non vide attendue, sortie vide', () => c({ commande: 'true', attendu: 'sortie_non_vide' })[0], { attendu: 'absent' });
      s.etape('sortie vide attendue et obtenue', () => c({ commande: 'printf ""', attendu: 'sortie_vide' })[0], { attendu: 'conforme' });
      s.etape('sortie vide attendue, sortie obtenue', () => c({ commande: 'echo x', attendu: 'sortie_vide' })[0], { attendu: 'absent' });
      s.etape('sortie présente mais code 2 → absent', () => c({ commande: 'echo x; exit 2', attendu: 'sortie_non_vide' })[0], { attendu: 'absent' });
      s.etape('détail tiré de la sortie d’erreur', () => c({ commande: 'echo oups >&2; exit 1' }), { attendu: ['absent', 'echo oups >&2; exit 1 → oups'] });
      s.etape('détail borné à 120 signes', () => Array.from(c({ commande: 'printf "%0300d" 0' })[1].split(' → ')[1]).length, { attendu: 120 });
    }));

    test('erreurs : outil absent, délai dépassé, placeholder non déclaré', (t) => avecDepot({}, (depot) => {
      const s = scenario(t);
      const c = (ctl) => { const { r } = controler(depot, { type: 'commande', ...ctl }); return [r.resultat, r.cause, r.constat]; };
      s.etape('commande introuvable → erreur outil_absent', () => c({ commande: 'commande_introuvable_7e' }).slice(0, 2), { attendu: ['erreur', 'outil_absent'] });
      s.etape('le constat nomme la commande', () => c({ commande: 'commande_introuvable_7e' })[2].startsWith('commande_introuvable_7e : '), { attendu: true });
      s.etape('délai dépassé → erreur execution', () => avecEnv({ DELAI_CONTROLE_7E: '1' }, () => c({ commande: 'sleep 5' })), { attendu: ['erreur', 'execution', 'sleep 5 : délai dépassé'] });
      s.etape('code 124 rendu par la commande : traité comme délai', () => c({ commande: 'exit 124' }).slice(0, 2), { attendu: ['erreur', 'execution'] });
      s.etape('placeholder résolu', () => c({ commande: 'echo {{ manifeste.instance.id }}', attendu: 'sortie_non_vide' }), { attendu: ['conforme', null, 'echo essai → essai'] });
      s.etape('placeholder non déclaré → partiel', () => c({ commande: 'echo {{ manifeste.tests.fumee }}' }), { attendu: ['partiel', null, 'champ non déclaré : tests.fumee'] });
    }));
  });

  // regles.fichiers_temporaires (0.5.0) : TMPDIR sur le temp du cycle ; hors cycle, un temp jetable
  test('commandes : TMPDIR sur le temp du cycle', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    const sansCycle = controler(depot, { type: 'commande', commande: 'echo "${TMPDIR:-hérité}"' }).r.constat.split(' → ')[1];
    s.etape('hors cycle, sans temp posé : le TMPDIR hérité', () => sansCycle === (process.env.TMPDIR ?? 'hérité'), { attendu: true });
    const { r, ctx } = controler(depot, { type: 'commande', commande: 'echo "$TMPDIR"; mktemp -d' }, { avant: (c) => { c.temp = mkdtempSync(join(tmpdir(), 'r7e-essai-temp-')); } });
    const [tmp, cree] = r.constat.split(' → ')[1].split(' ');
    s.etape('TMPDIR = le temp du contexte', () => tmp === ctx.temp && ctx.temp !== null, { attendu: true });
    s.etape('mktemp crée dans ce temp, et rien ne l’efface', () => [cree.startsWith(`${ctx.temp}/`), existsSync(cree)], { attendu: [true, true] });
    rmSync(ctx.temp, { recursive: true, force: true });
  }));

  describe('fichier', () => {
    test('versionne : au moins un fichier versionné correspond', (t) => avecDepot({ fichiers: { 'README.md': '#', 'api.v1.yaml': 'x', 'apiXv1Xyaml': 'y' }, manifeste: manifesteMinimal({ expose: { contrat: 'api.v1.yaml' } }) }, (depot) => {
      const s = scenario(t);
      const c = (ctl) => { const { r } = controler(depot, { type: 'fichier', ...ctl }); return [r.resultat, r.constat]; };
      s.etape('README versionné', () => c({ versionne: '^README\\.md$' }), { attendu: ['conforme', 'versionné : README.md'] });
      s.etape('aucun fichier', () => c({ versionne: '^absent$' }), { attendu: ['absent', 'versionné : aucun fichier pour ^absent$'] });
      s.etape('placeholder échappé : le point reste un point', () => c({ versionne: '^{{ manifeste.expose.contrat }}$' }), { attendu: ['conforme', 'versionné : api.v1.yaml'] });
      s.etape('trois fichiers au plus dans le constat', () => c({ versionne: '\\.(md|yaml)$|Xyaml$' })[1].split(', ').length, { attendu: 3 });
      s.etape('expression invalide → erreur execution', () => { const { r } = controler(depot, { type: 'fichier', versionne: '(' }); return [r.resultat, r.cause]; }, { attendu: ['erreur', 'execution'] });
    }));

    test('ignore : Git doit ignorer le chemin', (t) => {
      const s = scenario(t);
      s.etape('.env ignoré', () => avecDepot({ fichiers: { '.gitignore': '.env\n' } }, (d) => { const { r } = controler(d, { type: 'fichier', ignore: '.env' }); return [r.resultat, r.constat]; }), { attendu: ['conforme', '.env ignoré par Git'] });
      s.etape('.env non ignoré', () => avecDepot({}, (d) => { const { r } = controler(d, { type: 'fichier', ignore: '.env' }); return [r.resultat, r.constat]; }), { attendu: ['absent', '.env non ignoré par Git'] });
      s.etape('versionne et ignore : deux constats', () => avecDepot({ fichiers: { '.gitignore': '.env\n', '.env.example': 'A=1' } }, (d) => { const { r } = controler(d, { type: 'fichier', versionne: '^\\.env\\.example$', ignore: '.env' }); return [r.resultat, r.constat]; }), { attendu: ['conforme', 'versionné : .env.example ; .env ignoré par Git'] });
      s.etape('l’un des deux en défaut → absent', () => avecDepot({ fichiers: { '.env.example': 'A=1' } }, (d) => controler(d, { type: 'fichier', versionne: '^\\.env\\.example$', ignore: '.env' }).r.resultat), { attendu: 'absent' });
    });

    test('paires : chaque manifeste de dépendances a son verrou, dans son répertoire', (t) => {
      const s = scenario(t);
      const paires = [{ si: 'package.json', alors_un_de: ['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml'] }];
      const c = (fichiers, ctl = {}) => avecDepot({ fichiers }, (d) => { const { r } = controler(d, { type: 'fichier', paires, ...ctl }); return [r.resultat, r.constat]; });
      s.etape('package.json et son verrou', () => c({ 'package.json': '{}', 'package-lock.json': '{}' }), { attendu: ['conforme', '1 manifeste(s) de dépendances, chacun verrouillé'] });
      s.etape('verrou yarn accepté', () => c({ 'package.json': '{}', 'yarn.lock': '' })[0], { attendu: 'conforme' });
      s.etape('package.json sans verrou', () => c({ 'package.json': '{}' }), { attendu: ['absent', 'package.json sans verrou (package-lock.json ou yarn.lock ou pnpm-lock.yaml)'] });
      s.etape('sous-répertoire : le verrou de la racine ne compte pas', () => c({ 'package.json': '{}', 'package-lock.json': '{}', 'app/package.json': '{}' }), { attendu: ['absent', 'app/package.json sans verrou (package-lock.json ou yarn.lock ou pnpm-lock.yaml)'] });
      s.etape('deux manifestes verrouillés', () => c({ 'package.json': '{}', 'package-lock.json': '{}', 'app/package.json': '{}', 'app/pnpm-lock.yaml': '' }), { attendu: ['conforme', '2 manifeste(s) de dépendances, chacun verrouillé'] });
      s.etape('aucun manifeste concerné → sans objet', () => c({ 'README.md': '#' }), { attendu: ['sans_objet', 'aucun manifeste de dépendances concerné'] });
      // Le sans objet ne vaut que si paires est le seul paramètre (comme en Python)
      s.etape('aucun manifeste, autre paramètre présent → conforme, constat vide', () => c({ 'README.md': '#' }, { heuristique: true }), { attendu: ['conforme', ''] });
    });
  });

  describe('motif', () => {
    test('attendu absent : conforme sans occurrence, absent avec', (t) => avecDepot({ fichiers: { 'src/a.js': 'const x = 1;\nconsole.log(x);\n', 'src/b.js': 'export default 2;\n' } }, (depot) => {
      const s = scenario(t);
      const c = (ctl) => { const { r } = controler(depot, { type: 'motif', fichiers: '^src/.*\\.js$', attendu: 'absent', ...ctl }); return [r.resultat, r.constat]; };
      s.etape('aucune occurrence dans 2 fichiers', () => c({ motif: 'eval\\(' }), { attendu: ['conforme', 'aucune occurrence dans 2 fichier(s)'] });
      s.etape('une occurrence, préfixée du fichier', () => c({ motif: 'console\\.log' }), { attendu: ['absent', '1 occurrence(s) : src/a.js:2:console.log(x);'] });
      s.etape('un seul fichier lu : grep n’imprime pas son nom', () => c({ fichiers: '^src/a\\.js$', motif: 'console\\.log' }), { attendu: ['absent', '1 occurrence(s) : 2:console.log(x);'] });
      s.etape('aucun fichier à lire → sans objet', () => c({ fichiers: '\\.py$', motif: 'x' }), { attendu: ['sans_objet', 'aucun fichier à lire'] });
      s.etape('motif invalide → erreur execution', () => { const { r } = controler(depot, { type: 'motif', fichiers: '\\.js$', motif: '(' }); return [r.resultat, r.cause]; }, { attendu: ['erreur', 'execution'] });
    }));

    test('attendu present : conforme si trouvé, absent sinon', (t) => avecDepot({ fichiers: { '.env.example': 'DATABASE_URL=postgres://db\nPORT=8080\n' } }, (depot) => {
      const s = scenario(t);
      const c = (ctl) => { const { r } = controler(depot, { type: 'motif', fichiers: '^\\.env\\.example$', attendu: 'present', ...ctl }); return [r.resultat, r.constat]; };
      s.etape('trouvé', () => c({ motif: '^PORT=' }), { attendu: ['conforme', 'trouvé : 2:PORT=8080'] });
      s.etape('non trouvé', () => c({ motif: '^REDIS_URL=' }), { attendu: ['absent', 'motif absent de 1 fichier(s)'] });
      s.etape('aucun fichier à lire → absent, pas sans objet', () => c({ fichiers: '\\.py$', motif: 'x' }), { attendu: ['absent', 'aucun fichier à lire pour \\.py$'] });
    }));

    test('placeholder échappé dans le motif', (t) => avecDepot({ fichiers: { '.env.example': 'DBXURL=a\n' } }, (depot) => {
      const s = scenario(t);
      const c = (via) => controler(depot, { type: 'motif', fichiers: '^\\.env\\.example$', attendu: 'present', motif: '^{{ item.via }}=', pour_chaque: '.consomme[]?' }, { avant: (ctx) => { ctx.m.consomme = [{ via }]; } }).r.resultat;
      s.etape('« DB.URL » ne reconnaît pas « DBXURL » (point échappé)', () => c('DB.URL'), { attendu: 'absent' });
      s.etape('« DBXURL » se reconnaît', () => c('DBXURL'), { attendu: 'conforme' });
    }));

    test('fichiers lus : exclure, exclusion globale, versionnés et présents', (t) => avecDepot({
      fichiers: {
        'src/a.js': 'TODO\n', 'tests/a.test.js': 'TODO\n',
        'modele-executif-copie.yaml': 'TODO\n', 'config/app.yaml': 'ok\n', 'supprime.js': 'TODO\n',
        'journal/essai/0000.yaml': 'constat: TODO\n',
      },
      // le manifeste lui-même contient le motif : l'exclusion globale doit l'écarter
      manifeste: `${stringify(manifesteMinimal())}note: TODO\n`,
    }, (depot) => {
      const s = scenario(t);
      depot.supprimer('supprime.js');
      depot.ecrire('src/non-versionne.js', 'TODO\n');
      const c = (ctl) => controler(depot, { type: 'motif', attendu: 'absent', motif: 'TODO', ...ctl }).r.constat;
      s.etape('exclure écarte tests/ ; un seul fichier lu, sans son nom', () => c({ fichiers: '\\.js$', exclure: '(^|/)tests/' }), { attendu: '1 occurrence(s) : 1:TODO' });
      s.etape('ni le modèle, ni le manifeste, ni le journal ne se détectent eux-mêmes', () => c({ fichiers: '\\.ya?ml$' }), { attendu: 'aucune occurrence dans 1 fichier(s)' });
      s.etape('le journal suit manifeste.journal, inséré échappé : « jour.al » n’écarte pas journal/', () => controler(depot, { type: 'motif', attendu: 'absent', motif: 'TODO', fichiers: '\\.ya?ml$' }, { avant: (ctx) => { ctx.m.journal = 'jour.al'; } }).r.constat, { attendu: '1 occurrence(s) : journal/essai/0000.yaml:1:constat: TODO' });
      s.etape('un fichier supprimé du disque n’est pas lu', () => c({ fichiers: '^supprime\\.js$' }), { attendu: 'aucun fichier à lire' });
      s.etape('un fichier non versionné n’est pas lu', () => c({ fichiers: 'non-versionne' }), { attendu: 'aucun fichier à lire' });
    }));

    test('exclusion du journal : le chemin normalisé, quelle que soit sa graphie', (t) => avecDepot({ fichiers: { 'journal/essai/0000.yaml': 'constat: TODO\n', 'src/a.yaml': 'cle: valeur\n' } }, (depot) => {
      const s = scenario(t);
      const ctl = { type: 'motif', attendu: 'absent', motif: 'TODO', fichiers: '\\.ya?ml$' };
      const avec = (j) => controler(depot, ctl, { avant: (c) => { c.m.journal = j; } }).r.constat;
      for (const j of ['journal', './journal', 'journal/', 'journal//']) {
        s.etape(`journal: ${j} → l’entrée n’est pas lue`, () => avec(j), { attendu: 'aucune occurrence dans 1 fichier(s)' });
      }
      s.etape('chemin absolu → l’entrée n’est pas lue', () => avec(join(depot.chemin, 'journal')), { attendu: 'aucune occurrence dans 1 fichier(s)' });
      s.etape('manifeste sans journal : le défaut, sans exception', () => controler(depot, ctl, { avant: (c) => { delete c.m.journal; } }).r.constat, { attendu: 'aucune occurrence dans 1 fichier(s)' });
    }));

    test('fichiers binaires ignorés, lecture par lots de 200', (t) => {
      const s = scenario(t);
      const fichiers = {};
      for (let i = 0; i < 450; i += 1) fichiers[`lot/f${String(i).padStart(3, '0')}.txt`] = i === 437 ? 'AIGUILLE\n' : 'foin\n';
      avecDepot({ fichiers }, (depot) => {
        s.etape('450 fichiers lus en 3 lots, l’occurrence du 437e trouvée', () => controler(depot, { type: 'motif', fichiers: '^lot/', attendu: 'present', motif: 'AIGUILLE' }).r.constat, { attendu: 'trouvé : lot/f437.txt:1:AIGUILLE' });
        s.etape('compte des fichiers lus', () => controler(depot, { type: 'motif', fichiers: '^lot/', attendu: 'absent', motif: 'ABSENT' }).r.constat, { attendu: 'aucune occurrence dans 450 fichier(s)' });
      });
      avecDepot({ fichiers: { 'image.bin': Buffer.from([0, 1, 2, 0x41, 0x49, 0x47, 0x0a, 0]) } }, (depot) => {
        s.etape('fichier binaire : jamais une occurrence (-I)', () => controler(depot, { type: 'motif', fichiers: '\\.bin$', attendu: 'absent', motif: 'AIG' }).r.resultat, { attendu: 'conforme' });
      });
    });
  });

  describe('manifeste et journal', () => {
    test('manifeste : une assertion jq sur le manifeste', (t) => avecDepot({}, (depot) => {
      const s = scenario(t);
      const c = (assertion) => { const { r } = controler(depot, { type: 'manifeste', assertion }); return [r.resultat, r.constat]; };
      s.etape('true → conforme', () => c('true'), { attendu: ['conforme', 'assertion sur le manifeste : vrai'] });
      s.etape('false → absent', () => c('false'), { attendu: ['absent', 'assertion sur le manifeste : faux'] });
      s.etape('null → sans objet', () => c('null'), { attendu: ['sans_objet', "l'assertion ne s'applique pas"] });
      s.etape('valeur non booléenne → absent, valeur citée', () => c('.instance.id'), { attendu: ['absent', 'assertion sur le manifeste : essai'] });
      s.etape('liste → absent, JSON cité', () => c('[1, 2]'), { attendu: ['absent', 'assertion sur le manifeste : [1,2]'] });
      s.etape('$requis disponible', () => c('$requis | index("periode_revue_cycles") != null')[0], { attendu: 'conforme' });
      s.etape('syntaxe invalide → erreur execution', () => { const { r } = controler(depot, { type: 'manifeste', assertion: '.[' }); return [r.resultat, r.cause]; }, { attendu: ['erreur', 'execution'] });
    }));

    test('journal : une assertion sur les entrées closes, triées par fin', (t) => avecDepot({}, (depot) => {
      const s = scenario(t);
      const c = (assertion) => { const { r } = controler(depot, { type: 'journal', assertion }); return [r.resultat, r.constat]; };
      const deux = 'if length < 2 then null else true end';
      s.etape('aucune entrée → historique insuffisant', () => c(deux), { attendu: ['sans_objet', 'historique insuffisant'] });
      ecrireEntree(depot, 'essai', 0, entreeMinimale({ id: 'essai-0000', fin: '2026-10-02T10:00:00Z' }));
      ecrireEntree(depot, 'essai', 1, entreeMinimale({ id: 'essai-0001', numero: 1, fin: null }));
      s.etape('une close, une ouverte → une seule lue', () => c(deux)[0], { attendu: 'sans_objet' });
      ecrireEntree(depot, 'essai', 1, entreeMinimale({ id: 'essai-0001', numero: 1, fin: '2026-10-01T10:00:00Z' }));
      s.etape('deux closes → conforme', () => c(deux), { attendu: ['conforme', 'assertion sur le journal : vrai'] });
      s.etape('ordre de lecture : par fin, pas par nom', () => c('map(.cycle.id)'), { attendu: ['absent', 'assertion sur le journal : ["essai-0001","essai-0000"]'] });
    }));

    // EV.1 (0.5.0) : les entrées closes se comparent d'un contrat à l'autre ; depuis le
    // contrat 0.5, une entrée d'instance cite le ticket de sa demande. _lus dit ce qui est là.
    test('journal : $contrat, _lus et EV.1 d’un contrat à l’autre', (t) => avecDepot({}, (depot) => {
      const s = scenario(t);
      const ev1 = MODELE.second_ordre.criteres.find((c) => c.id === 'EV.1').controles[0];
      const lire = () => controler(depot, ev1).r.resultat;
      const courant = contexteSur(depot).contratVersion;
      const entree = (n, contrat, extra = {}) => ecrireEntree(depot, 'essai', n, { ...entreeMinimale({ id: `essai-000${n}`, numero: n, fin: `2026-10-0${n + 1}T10:00:00Z`, contrat }), mesures: [], incidents: [], ...extra });
      s.etape('$contrat = contrat du modèle exécuté', () => controler(depot, { type: 'journal', assertion: '$contrat' }).r.constat, { attendu: `assertion sur le journal : ${courant}` });
      entree(0, '0.2'); entree(1, '0.3');
      s.etape('deux entrées complètes de contrats différents : comparées, conforme', () => lire(), { attendu: 'conforme' });
      entree(2, '0.5');
      s.etape('contrat 0.5, rang instance, sans ticket cité : absent', () => lire(), { attendu: 'absent' });
      depot.ecrire('journal/essai/0002/jira.mhtml', 'x');
      entree(2, '0.5', { demande: { lien: '0002/jira.mhtml', empreinte: 'ab' }, fichiers: [{ lien: '0002/temp/absent', octets: 0, nombre: 0, empreinte: 'cd' }] });
      s.etape('ticket cité : conforme', () => lire(), { attendu: 'conforme' });
      s.etape('_lus : le ticket est là, le fichier cité ne l’est plus', () => controler(depot, { type: 'journal', assertion: '.[-1]._lus' }).r.constat, { attendu: 'assertion sur le journal : {"demande":true,"fichiers":[false]}' });
      s.etape('_lus ne sort pas du répertoire de l’instance', () => { entree(3, '0.5', { demande: { lien: '../../7e-instance.yaml', empreinte: 'ab' } }); return controler(depot, { type: 'journal', assertion: '.[-1]._lus.demande' }).r.constat; }, { attendu: 'assertion sur le journal : faux' });
    }));
  });

  describe('compose', () => {
    const composeValide = 'services:\n  web:\n    image: nginx:1.27\n  cache:\n    image: redis:7.4\n';
    const manifesteCompose = (envs) => manifesteMinimal({ environnements: envs, environnement_test: 'dev' });

    test('sans fichiers compose : sans objet, sans même appeler docker', (t) => {
      const s = scenario(t);
      const c = (envs, environnement) => avecDepot({ manifeste: manifesteCompose(envs) }, (d) => avecEnv({ PATH: pathSans(['docker']) }, () => { const { r } = controler(d, { type: 'compose', environnement, assertion: 'true' }); return [r.resultat, r.constat]; }));
      s.etape('production sans fichiers', () => c({ production: { fichiers: [] } }, 'production'), { attendu: ['sans_objet', 'aucun fichier compose pour production'] });
      s.etape('tous, aucun environnement composé', () => c({ dev: {}, production: { fichiers: [] } }, 'tous'), { attendu: ['sans_objet', 'aucun fichier compose pour tous'] });
      s.etape('environnement non déclaré → partiel', () => c({ dev: {} }, 'production'), { attendu: ['partiel', 'champ non déclaré : environnements.production'] });
    });

    test('config résolue par docker compose, puis assertion', { skip: SANS_COMPOSE }, (t) => avecDepot({ fichiers: { 'compose.yaml': composeValide, 'compose.prod.yaml': 'services:\n  web:\n    image: nginx:latest\n' }, manifeste: manifesteCompose({ dev: { fichiers: ['compose.yaml'] }, production: { fichiers: ['compose.yaml', 'compose.prod.yaml'] } }) }, (depot) => {
      const s = scenario(t);
      const c = (environnement, assertion) => { const { r } = controler(depot, { type: 'compose', environnement, assertion }); return [r.resultat, r.constat]; };
      const sansLatest = '[.services[].image] | all(test(":latest$") | not)';
      s.etape('dev : aucune image :latest → conforme', () => c('dev', sansLatest), { attendu: ['conforme', 'assertion sur la config de dev : vrai'] });
      s.etape('production surcharge web en :latest → absent', () => c('production', sansLatest), { attendu: ['absent', 'assertion sur la config de production : faux'] });
      s.etape('tous : la liste {env, config}', () => c('tous', 'map(.env) | sort == ["dev", "production"]')[0], { attendu: 'conforme' });
      s.etape('null → sans objet', () => c('dev', 'null'), { attendu: ['sans_objet', "l'assertion ne s'applique pas"] });
      s.etape('$m dans l’assertion', () => c('dev', '$m.instance.id == "essai"')[0], { attendu: 'conforme' });
    }));

    test('erreurs : docker absent, fichier compose invalide', (t) => {
      const s = scenario(t);
      const m = manifesteCompose({ dev: { fichiers: ['compose.yaml'] } });
      s.etape('docker masqué → outil absent', () => avecDepot({ fichiers: { 'compose.yaml': composeValide }, manifeste: m }, (d) => avecEnv({ PATH: pathSans(['docker']) }, () => { const { r } = controler(d, { type: 'compose', environnement: 'dev', assertion: 'true' }); return [r.resultat, r.cause, r.constat]; })), { attendu: ['erreur', 'outil_absent', 'docker introuvable'] });
      if (DOCKER.compose) {
        s.etape('compose invalide → erreur execution', () => avecDepot({ fichiers: { 'compose.yaml': 'services: [\n' }, manifeste: m }, (d) => { const { r } = controler(d, { type: 'compose', environnement: 'dev', assertion: 'true' }); return [r.resultat, r.cause]; }), { attendu: ['erreur', 'execution'] });
      }
    });
  });

  describe('scénario', () => {
    const m = manifesteMinimal({ environnements: { dev: { fichiers: ['compose.yaml'] }, recette: { fichiers: [] } }, environnement_test: 'dev' });

    /** Un docker simulé qui répond à « info » et consigne chaque appel. */
    const dockerSimule = (journal, info = 0) => pathAvec({ docker: `echo "$@" >> "${journal}"\ncase "$1" in info) exit ${info} ;; esac\nexit 0` });

    test('hors compose, sans environnement de test, sans démon', (t) => {
      const s = scenario(t);
      const horsCompose = manifesteMinimal({ environnements: { dev: { fichiers: [] } }, environnement_test: 'dev' });
      s.etape('environnement de test sans compose → erreur hors_compose', () => avecDepot({ manifeste: horsCompose }, (d) => { const { r } = controler(d, { type: 'scenario', script: 'true' }); return [r.resultat, r.cause, r.constat]; }), { attendu: ['erreur', 'hors_compose', 'environnement sans fichiers compose (dev)'] });
      s.etape('environnement_test absent → partiel', () => avecDepot({}, (d) => { const { r } = controler(d, { type: 'scenario', script: 'true' }); return [r.resultat, r.constat]; }), { attendu: ['partiel', 'champ non déclaré : environnement_test'] });
      s.etape('docker masqué → outil absent', () => avecDepot({ manifeste: m }, (d) => avecEnv({ PATH: pathSans(['docker']) }, () => { const { r } = controler(d, { type: 'scenario', script: 'true' }); return [r.resultat, r.cause, r.constat]; })), { attendu: ['erreur', 'outil_absent', 'démon Docker injoignable'] });
      const journal = join(jetable('r7e-docker-'), 'appels.log');
      s.etape('client présent, « docker info » en échec → outil absent', () => avecDepot({ manifeste: m }, (d) => avecEnv({ PATH: dockerSimule(journal, 1) }, () => controler(d, { type: 'scenario', script: 'true' }).r.cause)), { attendu: 'outil_absent' });
    });

    test('enveloppe : le code du script, puis le nettoyage compose (démon simulé)', (t) => {
      const s = scenario(t);
      const rep = jetable('r7e-docker-');
      const journal = join(rep, 'appels.log');
      avecDepot({ manifeste: m }, (depot) => avecEnv({ PATH: dockerSimule(journal) }, () => {
        const c = (script) => { const { r } = controler(depot, { type: 'scenario', script }); return [r.resultat, r.cause, r.constat]; };
        s.etape('script réussi → conforme', () => c('true'), { attendu: ['conforme', null, 'scénario réussi'] });
        s.etape('code 3 conservé par le piège → absent', () => c('echo raté >&2; exit 3'), { attendu: ['absent', null, 'scénario en échec (code 3) : raté'] });
        s.etape('set -e : arrêt au premier échec', () => c('false\necho jamais'), { attendu: ['absent', null, 'scénario en échec (code 1) : '] });
        s.etape('commande introuvable dans le script → outil absent', () => c('commande_introuvable_7e').slice(0, 2), { attendu: ['erreur', 'outil_absent'] });
        s.etape('placeholders résolus dans le script', () => c('test "{{ cycle.id }}" = essai-0000')[0], { attendu: 'conforme' });
        s.etape('nettoyage : compose -p 7e-essai-0000 … down -v après chaque script', () => readFileSync(journal, 'utf8').split('\n').filter((l) => l.startsWith('compose ')).length >= 5, { attendu: true });
        s.etape('le nettoyage vise le projet éphémère de l’environnement de test', () => readFileSync(journal, 'utf8').includes('compose -p 7e-essai-0000 -f compose.yaml down -v'), { attendu: true });
      }));
      rmSync(rep, { recursive: true, force: true });
    });

    test('scénario réel sur le démon Docker de la VM', { skip: SANS_DEMON }, (t) => avecDepot({ fichiers: { 'compose.yaml': 'services:\n  essai:\n    image: alpine:3.20\n    command: ["true"]\n' }, manifeste: m }, (depot) => {
      const s = scenario(t);
      const c = (script) => { const { r } = controler(depot, { type: 'scenario', script }); return [r.resultat, r.cause]; };
      s.etape('docker compose run réussi → conforme', () => c('docker compose {{ compose.test }} run --rm essai true'), { attendu: ['conforme', null] });
      s.etape('commande en échec dans le conteneur → absent', () => c('docker compose {{ compose.test }} run --rm essai false'), { attendu: ['absent', null] });
      s.etape('aucun conteneur ne survit au scénario', () => spawnSync('docker', ['ps', '-aq', '--filter', 'label=com.docker.compose.project=7e-essai-0000'], { encoding: 'utf8' }).stdout.trim(), { attendu: '' });
    }));
  });

  describe('métrique', () => {
    const avecSeuil = (seuils) => manifesteMinimal({ seuils: { periode_revue_cycles: { valeur: 3, unite: 'cycles' }, ...seuils } });

    test('comparaison au seuil déclaré, mesure consignée', (t) => avecDepot({ manifeste: avecSeuil({ delai: { valeur: 24, unite: 'h' }, debit: { valeur: 10, unite: 'req/s' } }) }, (depot) => {
      const s = scenario(t);
      const c = (ctl) => { const { r, ctx } = controler(depot, { type: 'metrique', indicateur: 'delai', ...ctl }); return [r.resultat, r.constat, ctx.mesures]; };
      s.etape('12 ≤ 24 → conforme', () => c({ mesure: 'echo 12' }), { attendu: ['conforme', 'delai = 12, seuil <= 24', [{ indicateur: 'delai', valeur: 12, seuil: 24, hors_seuil: false }]] });
      s.etape('30 > 24 → absent, hors seuil', () => c({ mesure: 'echo 30' }), { attendu: ['absent', 'delai = 30, seuil <= 24', [{ indicateur: 'delai', valeur: 30, seuil: 24, hors_seuil: true }]] });
      s.etape('≥ : 5 sous le seuil 10 → absent', () => c({ indicateur: 'debit', comparaison: '>=', mesure: 'echo 5' }).slice(0, 2), { attendu: ['absent', 'debit = 5, seuil >= 10'] });
      s.etape('≥ : 15 → conforme', () => c({ indicateur: 'debit', comparaison: '>=', mesure: 'echo 15' })[0], { attendu: 'conforme' });
      s.etape('la dernière ligne fait foi', () => c({ mesure: 'echo début; echo 7' })[1], { attendu: 'delai = 7, seuil <= 24' });
      s.etape('format g dans le constat', () => c({ mesure: 'echo 1234567' })[1], { attendu: 'delai = 1.23457e+06, seuil <= 24' });
      s.etape('inf → hors seuil', () => c({ mesure: 'echo inf' }).slice(0, 2), { attendu: ['absent', 'delai = inf, seuil <= 24'] });
    }));

    test('seuil non déclaré ou illisible : partiel (EX.2)', (t) => {
      const s = scenario(t);
      s.etape('aucun seuil', () => avecDepot({}, (d) => { const { r, ctx } = controler(d, { type: 'metrique', indicateur: 'delai', mesure: 'echo 12' }); return [r.resultat, r.constat, ctx.mesures]; }), { attendu: ['partiel', 'delai = 12, seuil non déclaré (EX.2)', [{ indicateur: 'delai', valeur: 12, seuil: null, hors_seuil: false }]] });
      s.etape('seuil en texte → traité comme non déclaré', () => avecDepot({ manifeste: avecSeuil({ delai: { valeur: '24' } }) }, (d) => controler(d, { type: 'metrique', indicateur: 'delai', mesure: 'echo 12' }).r.resultat), { attendu: 'partiel' });
      s.etape('seuil sans table → traité comme non déclaré', () => avecDepot({ manifeste: avecSeuil({ delai: 24 }) }, (d) => controler(d, { type: 'metrique', indicateur: 'delai', mesure: 'echo 12' }).r.resultat), { attendu: 'partiel' });
    });

    test('mesure impossible : erreur', (t) => avecDepot({ manifeste: avecSeuil({ delai: { valeur: 24 } }) }, (depot) => {
      const s = scenario(t);
      const c = (mesure) => { const { r } = controler(depot, { type: 'metrique', indicateur: 'delai', mesure }); return [r.resultat, r.cause, r.constat]; };
      s.etape('sortie non numérique', () => c('echo abc'), { attendu: ['erreur', 'execution', 'mesure de delai impossible : abc'] });
      s.etape('code ≠ 0', () => c('echo 5; exit 1').slice(0, 2), { attendu: ['erreur', 'execution'] });
      s.etape('sortie vide', () => c('true'), { attendu: ['erreur', 'execution', 'mesure de delai impossible : code 0'] });
      s.etape('commande introuvable → outil absent', () => c('commande_introuvable_7e').slice(0, 2), { attendu: ['erreur', 'outil_absent'] });
      s.etape('« docker » sans démon → outil absent', () => avecEnv({ PATH: pathSans(['docker']) }, () => c('docker compose ps -q | wc -l')), { attendu: ['erreur', 'outil_absent', 'démon Docker injoignable'] });
    }));
  });

  describe('déclaration', () => {
    const question = 'Le code partagé est-il consommé comme bibliothèque ?';
    const c = (declarations) => avecDepot({ manifeste: manifesteMinimal(declarations === undefined ? {} : { declarations }) }, (d) => { const { r } = controler(d, { type: 'declaration', question }, { cid: '1.2' }); return [r.resultat, r.constat, r.preuve]; });

    test('déclaration faite, partielle ou absente', (t) => table(t, [
      ['aucune déclaration → partiel', () => c(undefined), ['partiel', `déclaration non faite : ${question}`, null]],
      ['réponse hors liste → partiel', () => c({ 1.2: { reponse: 'oui', preuve: 'https://x' } }), ['partiel', `déclaration non faite : ${question}`, null]],
      ['conforme sans preuve → partiel', () => c({ 1.2: { reponse: 'conforme' } }), ['partiel', 'déclaré conforme, sans preuve', null]],
      ['conforme avec preuve', () => c({ 1.2: { reponse: 'conforme', preuve: 'https://wiki/bibliotheques' } }), ['conforme', 'déclaré conforme', 'https://wiki/bibliotheques']],
      ['absent avec preuve', () => c({ 1.2: { reponse: 'absent', preuve: 'https://x' } }), ['absent', 'déclaré absent', 'https://x']],
      ['partiel avec preuve', () => c({ 1.2: { reponse: 'partiel', preuve: 'https://x' } }), ['partiel', 'déclaré partiel', 'https://x']],
      ['preuve en liste → JSON', () => c({ 1.2: { reponse: 'conforme', preuve: ['https://a', 'https://b'] } })[2], '["https://a","https://b"]'],
      ['déclaration en texte seul → non faite', () => c({ 1.2: 'conforme' })[0], 'partiel'],
    ]));

    test('clé de critère écrite sans guillemets en YAML', (t) => {
      const s = scenario(t);
      const texte = stringify(manifesteMinimal()) + 'declarations:\n  1.2: { reponse: conforme, preuve: https://x }\n';
      s.etape('1.2 lu comme nombre, retrouvé comme « 1.2 »', () => avecDepot({ manifeste: texte }, (d) => controler(d, { type: 'declaration', question }, { cid: '1.2' }).r.resultat), { attendu: 'conforme' });
    });
  });

  describe('pour_chaque', () => {
    test('liste du manifeste : tous, une partie, aucun', (t) => {
      const s = scenario(t);
      const c = (processus, ctl = {}) => avecDepot({ manifeste: manifesteMinimal(processus === undefined ? {} : { processus }) }, (d) => { const { r } = controler(d, { type: 'commande', pour_chaque: '.processus[]?', commande: 'test "{{ item.service }}" = web', ...ctl }); return [r.resultat, r.constat]; });
      s.etape('aucun processus → sans objet', () => c(undefined), { attendu: ['sans_objet', 'liste vide : rien à examiner'] });
      s.etape('liste vide → sans objet', () => c([]), { attendu: ['sans_objet', 'liste vide : rien à examiner'] });
      s.etape('un conforme sur deux → partiel', () => c([{ service: 'web' }, { service: 'worker' }]), { attendu: ['partiel', '1/2 conformes ; test "worker" = web → code 1'] });
      s.etape('tous conformes', () => c([{ service: 'web' }, { service: 'web' }]), { attendu: ['conforme', '2/2 conformes'] });
      s.etape('aucun conforme → absent', () => c([{ service: 'a' }, { service: 'b' }])[0], { attendu: 'absent' });
      s.etape('champ manquant dans un élément → partiel', () => c([{ service: 'web' }, { type: 'worker' }]), { attendu: ['partiel', '1/2 conformes ; champ non déclaré : item.service'] });
    });

    test('expressions de pour_chaque : environnements, textes, erreur', (t) => {
      const s = scenario(t);
      const m = manifesteMinimal({ environnements: { dev: { release_deployee: 'echo a' }, production: { release_deployee: 'echo b' } }, liste: ['x', 'y'] });
      avecDepot({ manifeste: m }, (depot) => {
        s.etape('environnements en {nom, …}', () => controler(depot, { type: 'commande', pour_chaque: '(.environnements // {}) | to_entries[] | {nom: .key} + .value', commande: '{{ item.release_deployee }}', attendu: 'sortie_non_vide' }).r.constat, { attendu: '2/2 conformes' });
        s.etape('éléments textes : {{ item }}', () => controler(depot, { type: 'commande', pour_chaque: '.liste[]', commande: 'test {{ item }} = x' }).r.constat, { attendu: '1/2 conformes ; test y = x → code 1' });
        s.etape('expression invalide → erreur execution', () => { const { r } = controler(depot, { type: 'commande', pour_chaque: '.[', commande: 'true' }); return [r.resultat, r.cause, r.constat.startsWith('pour_chaque : ')]; }, { attendu: ['erreur', 'execution', true] });
      });
    });

    test('pour_chaque_image : images de la config compose', (t) => {
      const s = scenario(t);
      const sans = manifesteMinimal({ environnements: { production: { fichiers: [] } } });
      s.etape('environnement sans compose → sans objet', () => avecDepot({ manifeste: sans }, (d) => { const { r } = controler(d, { type: 'commande', pour_chaque_image: 'production', commande: 'true' }); return [r.resultat, r.constat]; }), { attendu: ['sans_objet', 'environnement sans fichiers compose (production)'] });
      if (DOCKER.compose) {
        const avec = manifesteMinimal({ environnements: { production: { fichiers: ['compose.yaml'] } } });
        const compose = 'services:\n  a:\n    image: redis:7.4\n  b:\n    image: nginx:1.27\n  c:\n    image: nginx:1.27\n  d:\n    build: .\n';
        s.etape('images uniques et triées, services sans image écartés', () => avecDepot({ manifeste: avec, fichiers: { 'compose.yaml': compose, Dockerfile: 'FROM scratch\n' } }, (d) => interne.elements({ pour_chaque_image: 'production' }, contexteSur(d))), { attendu: ['nginx:1.27', 'redis:7.4'] });
      }
    });
  });

  test('type inconnu : erreur de programmation, jamais un résultat', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    s.etape('executerControle lève', () => assert.throws(() => controler(depot, { type: 'inconnu' }), /type de contrôle inconnu : inconnu/));
  }));

  test('heuristique : le drapeau suit le contrôle, quel que soit le résultat', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    s.etape('heuristique: true sur un échec', () => controler(depot, { type: 'commande', commande: 'false', heuristique: true }).r.heuristique, { attendu: true });
    s.etape('heuristique: true sur un sans objet', () => controler(depot, { type: 'motif', fichiers: '\\.py$', motif: 'x', heuristique: true }).r.heuristique, { attendu: true });
    s.etape('absent → false', () => controler(depot, { type: 'commande', commande: 'false' }).r.heuristique, { attendu: false });
    s.etape('versJournal : « heuristique » écrit seulement s’il est vrai', () => [controler(depot, { type: 'commande', commande: 'false', heuristique: true }).r.versJournal().heuristique, Object.hasOwn(controler(depot, { type: 'commande', commande: 'false' }).r.versJournal(), 'heuristique')], { attendu: [true, false] });
  }));
});

// ════════════════════════════════════════════════════════════════════════════
//  8. PRÉCÉDENCES
//  types_de_controle.regles.sans_objet_automatique : un contrôle qui n'a rien à
//  examiner est sans objet AVANT toute autre règle (liste vide, motif attendu
//  absent sans fichier, compose sans fichiers). Puis requiert, puis le contrôle.
// ════════════════════════════════════════════════════════════════════════════
describe('8. Précédences : sans objet automatique, requiert, contrôle', () => {
  test('le sans objet automatique passe avant requiert', (t) => avecDepot({ manifeste: manifesteMinimal({ environnements: { production: { fichiers: [] } } }) }, (depot) => {
    const s = scenario(t);
    const r = (ctl) => controler(depot, ctl).r.resultat;
    s.etape('compose sans fichiers, requiert manquant → sans objet', () => r({ type: 'compose', environnement: 'production', requiert: ['processus'], assertion: 'true' }), { attendu: 'sans_objet' });
    s.etape('pour_chaque vide, requiert manquant → sans objet', () => r({ type: 'commande', pour_chaque: '.processus[]?', requiert: ['tests.fumee'], commande: 'true' }), { attendu: 'sans_objet' });
    s.etape('motif attendu absent sans fichier, requiert manquant → sans objet', () => r({ type: 'motif', fichiers: '\\.py$', motif: 'x', requiert: ['expose.port_var'] }), { attendu: 'sans_objet' });
  }));

  test('requiert : chaque champ manquant est nommé, dans l’ordre', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    const c = (ctl) => { const { r } = controler(depot, ctl); return [r.resultat, r.constat]; };
    s.etape('deux champs manquants', () => c({ type: 'commande', commande: 'true', requiert: ['tests.fumee', 'release.variable'] }), { attendu: ['partiel', 'champ non déclaré : tests.fumee, release.variable'] });
    s.etape('un présent, un manquant', () => c({ type: 'commande', commande: 'true', requiert: ['journal', 'tests.fumee'] }), { attendu: ['partiel', 'champ non déclaré : tests.fumee'] });
    s.etape('tous présents → le contrôle s’exécute', () => c({ type: 'commande', commande: 'true', requiert: ['journal', 'instance.id'] })[0], { attendu: 'conforme' });
    s.etape('motif attendu present sans fichier : requiert d’abord', () => c({ type: 'motif', fichiers: '\\.py$', motif: 'x', attendu: 'present', requiert: ['expose.port_var'] }), { attendu: ['partiel', 'champ non déclaré : expose.port_var'] });
  }));

  test('scénario : requiert passe avant l’erreur hors compose', (t) => avecDepot({ manifeste: manifesteMinimal({ environnements: { dev: { fichiers: [] } }, environnement_test: 'dev' }) }, (depot) => {
    const s = scenario(t);
    s.etape('requiert manquant → partiel, pas hors_compose', () => controler(depot, { type: 'scenario', requiert: ['tests.fumee'], script: 'true' }).r.resultat, { attendu: 'partiel' });
    s.etape('requiert présent → hors_compose', () => controler(depot, { type: 'scenario', requiert: ['journal'], script: 'true' }).r.cause, { attendu: 'hors_compose' });
  }));

  // types_de_controle.regles.gardes (depuis la 0.3.0) : 2.2 et 5.3 ont un contrôle
  // pour un projet avec compose et un autre pour un projet sans ; un seul s'applique.
  // Les contrôles éprouvés sont ceux du modèle, tels qu'il les écrit.
  const controleDe = (cid, type) => MODELE.termes.flatMap((x) => x.criteres).find((c) => String(c.id) === cid).controles.find((k) => k.type === type);
  const sansCompose = (surcharges = {}) => manifesteMinimal({
    environnements: { dev: { fichiers: [] } }, environnement_test: 'dev',
    release: { variable: 'VERSION_ESSAI', precedente: 'echo v1' },
    tests: { fumee: 'echo "$VERSION_ESSAI" >> fumees.txt' },
    ...surcharges,
  });

  test('gardes : un projet sans compose écarte le scénario compose de 2.2 et 5.3', (t) => avecDepot({ manifeste: sansCompose() }, (depot) => {
    const s = scenario(t);
    const r = (cid, type) => { const { r: x } = controler(depot, controleDe(cid, type)); return [x.resultat, x.constat]; };
    s.etape('2.2 : scénario compose sans objet', () => r('2.2', 'scenario'), { attendu: ['sans_objet', 'liste vide : rien à examiner'] });
    s.etape('5.3 : scénario compose sans objet', () => r('5.3', 'scenario'), { attendu: ['sans_objet', 'liste vide : rien à examiner'] });
  }));

  test('gardes : un projet compose écarte les contrôles sans compose de 2.2 et 5.3', (t) => avecDepot({ manifeste: sansCompose({ environnements: { dev: { fichiers: ['compose.yaml'] } } }) }, (depot) => {
    const s = scenario(t);
    s.etape('2.2 : contrôle sans compose, sans objet', () => controler(depot, controleDe('2.2', 'commande')).r.resultat, { attendu: 'sans_objet' });
    s.etape('5.3 : contrôle sans compose, sans objet', () => controler(depot, controleDe('5.3', 'commande')).r.resultat, { attendu: 'sans_objet' });
  }));

  // La fumée d'essai ne réussit que sur v1 et a1b2c3, et ne lit la variable que
  // dans un processus fils (sh -c) : elle n'y est visible qu'exportée.
  const FUMEE = `sh -c 'case "$VERSION_ESSAI" in v1|a1b2c3) echo "$VERSION_ESSAI" >> fumees.txt ;; *) exit 1 ;; esac'`;
  const avec53 = (depot, fumee, avant) => controler(depot, controleDe('5.3', 'commande'), {
    avant: (ctx) => { ctx.release = 'a1b2c3'; if (fumee !== undefined) ctx.m.tests.fumee = fumee; if (avant) avant(ctx); },
  }).r;

  test('5.3 sans compose : la fumée exerce la release antérieure, puis celle du cycle', (t) => avecDepot({ manifeste: sansCompose({ tests: { fumee: FUMEE } }) }, (depot) => {
    const s = scenario(t);
    const r = avec53(depot);
    s.etape('conforme, le constat cite les deux releases et le témoin', () => [r.resultat, r.constat.split(' → ')[1]], { attendu: ['conforme', 'fumée réussie sur v1 puis a1b2c3, en échec sur une release inexistante'] });
    s.etape('la variable, exportée, porte v1, puis la release du cycle', () => depot.lire('fumees.txt'), { attendu: 'v1\na1b2c3\n' });
    s.etape('release antérieure introuvable → absent', () => avec53(depot, undefined, (ctx) => { ctx.m.release.precedente = 'true'; }).resultat, { attendu: 'absent' });
    s.etape('variable de release non déclarée → partiel', () => avec53(depot, undefined, (ctx) => { delete ctx.m.release.variable; }).constat, { attendu: 'champ non déclaré : release.variable' });
    s.etape('un cd de la fumée ne touche pas le passage suivant', () => { depot.supprimer('fumees.txt'); avec53(depot, `${FUMEE} && cd /`); return depot.lire('fumees.txt'); }, { attendu: 'v1\na1b2c3\n' });
  }));

  // Les trois faux conformes de la 0.3.0 (relecture indépendante), et une fumée
  // qui ignore la release : le témoin les rend absents.
  test('5.3 sans compose : une fumée qui n’exerce pas la release est absente', (t) => avecDepot({ manifeste: sansCompose({ tests: { fumee: FUMEE } }) }, (depot) => {
    const s = scenario(t);
    const r = (fumee) => { const x = avec53(depot, fumee); return [x.resultat, /release inexistante/.test(x.constat)]; };
    s.etape('fumée « true » → absent, le témoin le dit', () => r('true'), { attendu: ['absent', true] });
    s.etape('exit 0 avant la fumée → absent', () => r(`exit 0; ${FUMEE}`), { attendu: ['absent', true] });
    s.etape('exit 0 après la fumée : les deux passages ont lieu, conforme', () => { depot.supprimer('fumees.txt'); const x = avec53(depot, `${FUMEE}; exit 0`); return [x.resultat, depot.lire('fumees.txt')]; }, { attendu: ['conforme', 'v1\na1b2c3\n'] });
    s.etape('liste && en échec sur la release antérieure → absent', () => r(`[ "$VERSION_ESSAI" = a1b2c3 ] && echo ok`)[0], { attendu: 'absent' });
    s.etape('fumée qui se termine par un commentaire → toujours exécutée', () => r(`${FUMEE} # fin`), { attendu: ['conforme', true] });
    s.etape('la sortie d’une fumée réussie ne masque pas l’échec suivant', () => avec53(depot, `echo SORTIE-V1; ${FUMEE}`, (ctx) => { ctx.release = 'zzz'; }).constat.includes('SORTIE-V1'), { attendu: false });
  }));

  test('2.2 sans compose : chaque Dockerfile, construit sans cache depuis un clone', (t) => avecDepot({
    manifeste: sansCompose(),
    fichiers: {
      Dockerfile: 'FROM scratch\n', 'outils/Dockerfile.dev': 'FROM scratch\n', 'outils/Dockerfile.dev.dockerignore': '*\n',
      'déploiement/Dockerfile': 'FROM scratch\n', 'docs/Dockerfile.md': '# notes\n',
    },
  }, (depot) => {
    const s = scenario(t);
    depot.ecrire('brouillon/Dockerfile', 'FROM scratch\n'); // non versionné : jamais construit
    const journal = join(depot.chemin, '.docker-appels');
    const docker = (demon, image = 'sha256:0f') => pathAvec({ docker: `case "$1" in info) exit ${demon ? 0 : 1} ;; build) echo "$* (dans $(basename "$PWD"))" >> "${journal}"; printf '%s' '${image}' ;; image) echo "$*" >> "${journal}" ;; esac` });
    const c = (demon, image) => avecEnv({ PATH: docker(demon, image) }, () => controler(depot, controleDe('2.2', 'commande')).r);
    const r = s.etape('démon joignable : conforme', () => c(true), { verifier: (x) => assert.equal(x.resultat, 'conforme') });
    s.etape('trois Dockerfile, chacun depuis son répertoire, dans le clone ; ni .dockerignore, ni .md, ni fichier non versionné', () => depot.lire('.docker-appels'), {
      attendu: [
        'build --quiet --no-cache --pull -f Dockerfile . (dans src)', 'image rm sha256:0f',
        'build --quiet --no-cache --pull -f déploiement/Dockerfile déploiement (dans src)', 'image rm sha256:0f',
        'build --quiet --no-cache --pull -f outils/Dockerfile.dev outils (dans src)', 'image rm sha256:0f', '',
      ].join('\n'),
    });
    s.etape('le constat nomme les Dockerfile construits', () => r.constat.split(' → ')[1], { attendu: 'construit sans cache depuis un clone : Dockerfile déploiement/Dockerfile outils/Dockerfile.dev' });
    s.etape('build sans identifiant d’image : conforme, aucune suppression vide', () => { depot.supprimer('.docker-appels'); const x = c(true, ''); return [x.resultat, depot.lire('.docker-appels').includes('image rm')]; }, { attendu: ['conforme', false] });
    s.etape('démon injoignable → erreur outil_absent, jamais absent', () => { const x = c(false); return [x.resultat, x.cause]; }, { attendu: ['erreur', 'outil_absent'] });
  }));

  // regles.gardes (0.4.0) : les gardes décident comme le résolveur quand il résout
  // les options compose de l'environnement de test. HorsCompose ⇔ sans compose.
  test('gardes : la même décision que les options compose du résolveur, sur 18 manifestes', (t) => avecDepot({ manifeste: sansCompose() }, (depot) => {
    const s = scenario(t);
    const { avec_compose: avec, sans_compose: sans } = MODELE.types_de_controle.gardes;
    const cas = [
      [{ dev: { fichiers: [] } }, 'dev'], [{ dev: { fichiers: ['c.yaml'] } }, 'dev'], [{ dev: { fichiers: 'c.yaml' } }, 'dev'],
      [{ dev: { fichiers: '' } }, 'dev'], [{ dev: {} }, 'dev'], [{ dev: null }, 'dev'], [{ dev: { fichiers: {} } }, 'dev'],
      [{ dev: { fichiers: false } }, 'dev'], [{ dev: { fichiers: { a: 1 } } }, 'dev'], [{ dev: 'c.yaml' }, 'dev'],
      [{ dev: ['c.yaml'] }, 'dev'], [[{ dev: {} }], 'dev'], [null, 'dev'], [{ prod: { fichiers: [] } }, 'dev'],
      [{ dev: { fichiers: [] } }, null], [{ dev: { fichiers: [] } }, ''], [{ 1: { fichiers: [] } }, 1], [{ dev: { fichiers: [null] } }, 'dev'],
    ];
    const decision = ([envs, test]) => {
      const m = { ...sansCompose(), environnements: envs, environnement_test: test };
      if (test === null) delete m.environnement_test;
      const ctx = contexteSur(depot, (c) => { c.m = m; });
      let resolveur;
      try { ctx.optionsCompose('test'); resolveur = 'avec'; } catch (e) { resolveur = e instanceof interne.HorsCompose ? 'sans' : 'avec'; }
      const jq = (g) => interne.lancer(['jq', '-c', g], depot.chemin, { entree: JSON.stringify(m) });
      const [a, b] = [jq(avec), jq(sans)];
      return { resolveur, avec: a.out.trim() !== '', sans: b.out.trim() !== '', erreur: a.code !== 0 || b.code !== 0 };
    };
    const d = cas.map(decision);
    s.etape('18 manifestes, jq sans erreur', () => d.filter((x) => x.erreur).length, { attendu: 0 });
    s.etape('une seule garde s’applique, toujours', () => d.filter((x) => x.avec === x.sans).length, { attendu: 0 });
    s.etape('sans compose si et seulement si le résolveur lève HorsCompose', () => d.map((x, i) => [i, x.sans === (x.resolveur === 'sans')]).filter(([, ok]) => !ok).map(([i]) => i), { attendu: [] });
    s.etape('dev: (valeur nulle) → sans compose, le contrôle sans compose s’applique', () => avecEnv({ PATH: pathAvec({ docker: 'case "$1" in info) exit 1 ;; esac' }) }, () => {
      const r = (type) => controler(depot, controleDe('2.2', type), { avant: (c) => { c.m.environnements = { dev: null }; } }).r;
      return [r('scenario').resultat, r('commande').cause];
    }), { attendu: ['sans_objet', 'outil_absent'] });
  }));

  // 10.2 (0.4.0) : la date du commit, lue par git log, vaut pour un tag annoté
  // comme pour un tag léger (au cycle 2, git show imprimait l'en-tête du tag).
  test('10.2 : délai commit → production mesuré sur un tag annoté', (t) => avecDepot({
    manifeste: manifesteMinimal({ environnements: { production: { fichiers: [], release_deployee: "git describe --tags --abbrev=0 --match 'v*'", deploye_le: 'date +%s' } } }),
  }, (depot) => {
    const s = scenario(t);
    const ctl = MODELE.termes.flatMap((x) => x.criteres).find((c) => String(c.id) === '10.2').controles[0];
    depot.git('tag', '-a', 'v1.0.0', '-m', 'Version 1.0.0 (essai)\n\nPremière version');
    s.etape('tag annoté : mesure conforme au seuil', () => { const r = controler(depot, ctl).r; return [r.resultat, r.constat]; }, { attendu: ['conforme', 'delai_commit_production_h = 0, seuil <= 24'] });
    depot.git('tag', 'v1.0.1');
    s.etape('tag léger : la même mesure', () => controler(depot, ctl).r.resultat, { attendu: 'conforme' });
    // 0.5.0 : sans date lisible (aucune validation finale), ou avant le commit, aucune mesure — jamais conforme
    const avec = (deploye) => { const r = controler(depot, ctl, { avant: (c) => { c.m.environnements.production.deploye_le = deploye; } }).r; return [r.resultat, r.cause]; };
    s.etape('date de mise en production illisible (validation absente) : erreur', () => avec('false'), { attendu: ['erreur', 'execution'] });
    s.etape('date vide : erreur, jamais une valeur négative', () => avec('true'), { attendu: ['erreur', 'execution'] });
    s.etape('mise en production avant le commit : erreur', () => avec('echo 1'), { attendu: ['erreur', 'execution'] });
    s.etape('release inconnue de Git : erreur', () => { const r = controler(depot, ctl, { avant: (c) => { c.m.environnements.production.release_deployee = 'echo v9.9.9'; } }).r; return r.resultat; }, { attendu: 'erreur' });
  }));
});

// ════════════════════════════════════════════════════════════════════════════
//  9. AGRÉGATION (echelle.agregation)
//  Sans objet ignorés ; tout sans objet → null ; tout conforme → 2, ou 3 en CI
//  sans contrôle déclaratif ; aucun conforme ni partiel, sans échec heuristique
//  ni erreur → 0 ; sinon 1.
// ════════════════════════════════════════════════════════════════════════════
describe('9. Agrégation des résultats en score', () => {
  test('les règles, dans leur ordre', (t) => table(t, [
    ['tous conformes, hors CI → 2', () => agreger([R('conforme'), R('conforme')], false), 2],
    ['tous conformes, en CI → 3', () => agreger([R('conforme')], true), 3],
    ['une déclaration plafonne à 2, même en CI', () => agreger([R('conforme'), R('conforme', 'declaration')], true), 2],
    ['tous absents → 0', () => agreger([R('absent'), R('absent')], false), 0],
    ['l’échec d’une heuristique ne donne jamais 0', () => agreger([R('absent', 'motif', true)], false), 1],
    ['une erreur plafonne à 1', () => agreger([R('conforme'), R('erreur')], false), 1],
    ['une erreur seule → 1, jamais 0', () => agreger([R('erreur')], false), 1],
    ['partiel → 1', () => agreger([R('partiel')], false), 1],
    ['conforme et absent → 1', () => agreger([R('conforme'), R('absent')], false), 1],
    ['tout sans objet → null', () => agreger([R('sans_objet'), R('sans_objet')], false), null],
    ['aucun résultat → null', () => agreger([], true), null],
    ['le sans objet est ignoré', () => agreger([R('conforme'), R('sans_objet')], false), 2],
    ['sans objet et absent → 0', () => agreger([R('sans_objet'), R('absent')], false), 0],
    ['absent non heuristique et heuristique en échec → 1', () => agreger([R('absent'), R('absent', 'motif', true)], false), 1],
    ['heuristique conforme et absent → 1', () => agreger([R('conforme', 'motif', true), R('absent')], false), 1],
  ]));

  test('propriétés sur 3 000 combinaisons tirées (graine fixe)', (t) => {
    const s = scenario(t);
    const tirer = aleatoire(42);
    const sortes = ['conforme', 'partiel', 'absent', 'sans_objet', 'erreur'];
    const types = ['commande', 'motif', 'declaration', 'compose'];
    const tirage = () => Array.from({ length: 1 + Math.floor(tirer() * 5) }, () => R(sortes[Math.floor(tirer() * 5)], types[Math.floor(tirer() * 4)], tirer() < 0.3));
    const cas = Array.from({ length: 3000 }, () => [tirage(), tirer() < 0.5]);
    const rang = { absent: 0, partiel: 1, erreur: 1, conforme: 2 };
    s.etape('le score est null, 0, 1, 2 ou 3', () => cas.filter(([r, ci]) => ![null, 0, 1, 2, 3].includes(agreger(r, ci))).length, { attendu: 0 });
    s.etape('null si et seulement si tout est sans objet', () => cas.filter(([r, ci]) => (agreger(r, ci) === null) !== r.every((x) => x.resultat === 'sans_objet')).length, { attendu: 0 });
    s.etape('3 seulement en CI, tout conforme, sans déclaration', () => cas.filter(([r, ci]) => agreger(r, ci) === 3 && !(ci && r.filter((x) => x.resultat !== 'sans_objet').every((x) => x.resultat === 'conforme' && x.type !== 'declaration'))).length, { attendu: 0 });
    s.etape('ajouter un sans objet ne change rien', () => cas.filter(([r, ci]) => agreger([...r, R('sans_objet')], ci) !== agreger(r, ci)).length, { attendu: 0 });
    s.etape('la CI ne change un score que de 2 à 3', () => cas.filter(([r]) => { const a = agreger(r, false); const b = agreger(r, true); return a !== b && !(a === 2 && b === 3); }).length, { attendu: 0 });
    s.etape('améliorer un résultat ne baisse jamais le score', () => cas.filter(([r, ci]) => {
      const avant = agreger(r, ci);
      return r.some((x, i) => {
        if (x.resultat === 'sans_objet' || x.resultat === 'conforme') return false;
        const mieux = r.map((y, j) => (j === i ? R(rang[y.resultat] === 0 ? 'partiel' : 'conforme', y.type, y.heuristique) : y));
        return agreger(mieux, ci) < (avant ?? -1);
      });
    }).length, { attendu: 0 });
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  10. COMBINAISON (types_de_controle.regles.pour_chaque)
//  Tous conformes → conforme ; une partie, ou un partiel → partiel ; que des
//  erreurs → erreur (cause du premier) ; aucun → absent ; rien → sans objet.
// ════════════════════════════════════════════════════════════════════════════
describe('10. Combinaison des éléments d’un pour_chaque', () => {
  test('résultat combiné', (t) => table(t, [
    ['tous conformes', () => combiner('commande', [R('conforme'), R('conforme')]).resultat, 'conforme'],
    ['une partie', () => combiner('commande', [R('conforme'), R('absent')]).resultat, 'partiel'],
    ['aucun conforme mais un partiel', () => combiner('commande', [R('partiel'), R('absent')]).resultat, 'partiel'],
    ['aucun conforme', () => combiner('commande', [R('absent'), R('absent')]).resultat, 'absent'],
    ['que des erreurs', () => combiner('commande', [R('erreur'), R('erreur')]).resultat, 'erreur'],
    ['erreur et absent → absent', () => combiner('commande', [R('erreur'), R('absent')]).resultat, 'absent'],
    ['sans objet écartés', () => combiner('commande', [R('sans_objet'), R('conforme')]).resultat, 'conforme'],
    ['rien que des sans objet', () => combiner('commande', [R('sans_objet')]).resultat, 'sans_objet'],
    ['liste vide', () => combiner('commande', []).resultat, 'sans_objet'],
  ]));

  test('détail du constat et cause', (t) => {
    const s = scenario(t);
    const e1 = new Resultat('commande', 'erreur', 'e1', { cause: 'outil_absent' });
    const e2 = new Resultat('commande', 'erreur', 'e2', { cause: 'execution' });
    s.etape('compte des conformes', () => combiner('commande', [R('conforme'), R('conforme')]).constat, { attendu: '2/2 conformes' });
    s.etape('trois constats au plus, après le compte', () => combiner('commande', [R('conforme'), R('absent'), R('partiel'), R('erreur'), R('absent')]).constat, { attendu: '1/5 conformes ; constat absent | constat partiel | constat erreur' });
    s.etape('cause : celle de la première erreur', () => combiner('commande', [e1, e2]).cause, { attendu: 'outil_absent' });
    s.etape('le type du contrôle est gardé', () => combiner('motif', [R('conforme')]).type, { attendu: 'motif' });
    s.etape('constat sans objet', () => combiner('commande', []).constat, { attendu: 'rien à examiner' });
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  11. BLOCAGE ET SYNTHÈSE (boucle.blocage, synthese)
// ════════════════════════════════════════════════════════════════════════════
describe('11. Blocage des phases et synthèse par terme', () => {
  /** Des scores à 2 pour chaque critère, puis les surcharges données. */
  const scores = (surcharges = {}) => {
    const s = {};
    for (const [id] of criteresDuModele()) s[id] = { score: 2, constat: 'c', preuves: [], controles: [] };
    for (const [id, v] of Object.entries(surcharges)) s[id].score = v;
    return s;
  };

  test('aucun écart sur les prérequis : les trois phases s’exécutent', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    const ctx = contexteSur(depot);
    s.etape('examiner, evoluer, equilibrer exécutées', () => bloquer(ctx, scores()), { attendu: { examiner: { statut: 'executee' }, evoluer: { statut: 'executee' }, equilibrer: { statut: 'executee' } } });
  }));

  test('un prérequis en écart bloque sa phase et plafonne ses critères', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    const ctx = contexteSur(depot);
    const sc = scores({ '11.1': 1, 'EX.1': 3, 'EX.2': 2 });
    s.etape('11.1 à 1 → Examiner bloquée', () => bloquer(ctx, sc).examiner, { attendu: { statut: 'bloquee', cause: ['11.1'] } });
    s.etape('EX.1 plafonné de 3 à 1', () => sc['EX.1'].score, { attendu: 1 });
    s.etape('EX.2 plafonné de 2 à 1', () => sc['EX.2'].score, { attendu: 1 });
    s.etape('le constat dit pourquoi', () => sc['EX.1'].constat, { attendu: 'c | plafonné à 1 : prérequis en écart (11.1)' });
    s.etape('les autres phases ne sont pas touchées', () => [sc['EV.1'].score, sc['EQ.1'].score], { attendu: [2, 2] });
  }));

  test('cas limites du blocage', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    const ctx = contexteSur(depot);
    s.etape('deux prérequis en écart, dans l’ordre du modèle', () => bloquer(ctx, scores({ '9.2': 0, '5.3': 1 })).equilibrer.cause, { attendu: ['5.3', '9.2'] });
    s.etape('prérequis sans objet (null) : ne bloque pas', () => bloquer(ctx, scores({ '1.1': null, '5.2': null })).evoluer.statut, { attendu: 'executee' });
    s.etape('prérequis à 2 : ne bloque pas', () => bloquer(ctx, scores({ '1.1': 2 })).evoluer.statut, { attendu: 'executee' });
    s.etape('prérequis à 0 : bloque', () => bloquer(ctx, scores({ '5.2': 0 })).evoluer, { attendu: { statut: 'bloquee', cause: ['5.2'] } });
    const sc = scores({ '1.1': 1, 'EV.1': 0, 'EV.2': null });
    bloquer(ctx, sc);
    s.etape('un critère déjà à 0 reste à 0, un null reste null', () => [sc['EV.1'].score, sc['EV.2'].score], { attendu: [0, null] });
    s.etape('pas de constat ajouté à ce qui n’est pas plafonné', () => sc['EV.1'].constat, { attendu: 'c' });
  }));

  test('synthèse : moyenne au pair et écarts par terme', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    const ctx = contexteSur(depot);
    const sc = scores({ '1.1': 1, '1.2': 0, '2.1': 2, '2.2': 2, 'EX.1': 1, 'EX.2': 1, 'EV.1': 1, 'EV.2': 1, 'EQ.1': 1, 'EQ.2': 1, 'IN.1': 1, 'FR.1': 2 });
    const syn = s.etape('huit termes, dans l’ordre du modèle', () => synthese(ctx, sc), { verifier: (v) => assert.deepEqual(Object.keys(v), Object.keys(NOMS_TERMES)) });
    s.etape('Éléments : (1 + 0 + 2 + 2) / 4 = 1,25, écarts 1.1 et 1.2', () => syn.elements, { attendu: { moyenne: 1.25, ecarts: ['1.1', '1.2'] } });
    s.etape('second ordre : 9/8 → 1,12 (au pair)', () => syn.second_ordre.moyenne, { attendu: 1.12 });
    const tousNuls = scores();
    for (const id of ['6.1', '6.2']) tousNuls[id].score = null;
    s.etape('terme sans critère applicable → moyenne null', () => synthese(ctx, tousNuls).etat, { attendu: { moyenne: null, ecarts: [] } });
  }));
});

// ════════════════════════════════════════════════════════════════════════════
//  12. PHASES DU CYCLE (cycle.phases)
// ════════════════════════════════════════════════════════════════════════════
describe('12. Phases : Évaluer, Élaborer, Examiner, Évoluer, Équilibrer', () => {
  describe('Évaluer', () => {
    test('manifeste valide : aucune erreur, release identifiée', (t) => avecDepot({}, (depot) => {
      const s = scenario(t);
      const ctx = contexteSur(depot);
      s.etape('aucune erreur', () => evaluer(ctx), { attendu: [] });
      s.etape('release : SHA court de 12 caractères', () => ctx.release, { attendu: depot.git('rev-parse', '--short=12', 'HEAD') });
      s.etape('aucune remarque sur un dépôt propre', () => ctx.remarques, { attendu: [] });
    }));

    test('release : le tag exact prime sur le SHA ; dépôt modifié signalé', (t) => {
      const s = scenario(t);
      s.etape('tag v1.2.3 sur HEAD', () => avecDepot({ tag: 'v1.2.3' }, (d) => { const ctx = contexteSur(d); evaluer(ctx); return ctx.release; }), { attendu: 'v1.2.3' });
      s.etape('fichier non versionné → remarque qui le nomme', () => avecDepot({}, (d) => { d.ecrire('brouillon.txt', 'x'); const ctx = contexteSur(d); evaluer(ctx); return ctx.remarques; }), { attendu: ["dépôt modifié depuis le dernier commit (1 fichier : brouillon.txt) : la release examinée n'est pas immuable"] });
      s.etape('plus de trois fichiers : les trois premiers, puis …', () => avecDepot({}, (d) => { for (const f of ['a.txt', 'b.txt', 'c.txt', 'd.txt']) d.ecrire(f, 'x'); const ctx = contexteSur(d); evaluer(ctx); return ctx.remarques; }), { attendu: ["dépôt modifié depuis le dernier commit (4 fichiers : a.txt, b.txt, c.txt, …) : la release examinée n'est pas immuable"] });
    });

    // Une copie sur disque Windows perd le bit d'exécution : avec core.filemode à
    // true, les scripts exécutables paraissent modifiés alors que leur contenu ne l'est pas.
    test('dépôt modifié : droits d’exécution seuls reconnus', (t) => avecDepot({ fichiers: { 'outil.sh': '#!/bin/sh\n', 'note.txt': 'a\n' } }, (d) => {
      const s = scenario(t);
      const script = join(d.chemin, 'outil.sh');
      s.etape('script rendu exécutable et versionné', () => { spawnSync('chmod', ['755', script]); return /^[0-9a-f]{12}$/.test(d.commit('exécutable')); }, { attendu: true });
      s.etape('bit d’exécution retiré : droits seuls', () => { spawnSync('chmod', ['644', script]); return interne.etatDuDepot(d.chemin); }, { attendu: { fichiers: ['outil.sh'], droitsSeuls: true } });
      s.etape('remarque : la cause et core.filemode', () => { const ctx = contexteSur(d); evaluer(ctx); return ctx.remarques; }, { attendu: ["dépôt modifié depuis le dernier commit (1 fichier : outil.sh ; droits d'exécution seulement, voir core.filemode) : la release examinée n'est pas immuable"] });
      s.etape('contenu modifié en plus : plus « droits seuls »', () => { d.ecrire('note.txt', 'b\n'); return interne.etatDuDepot(d.chemin); }, { attendu: { fichiers: ['note.txt', 'outil.sh'], droitsSeuls: false } });
      s.etape('renommage : le nouveau chemin seul', () => interne.cheminsPorcelaine('R  neuf.txt\0ancien.txt\0 M outil.sh\0'), { attendu: ['neuf.txt', 'outil.sh'] });
    }));

    // 0.5.0 : le journal et l'instance nomment des répertoires sous la racine du dépôt
    test('journal et instance : jamais hors du dépôt', (t) => {
      const s = scenario(t);
      const erreurs = (surcharges) => avecDepot({ manifeste: manifesteMinimal(surcharges) }, (d) => evaluer(contexteSur(d)));
      s.etape('journal à la racine : refus', () => erreurs({ journal: '.' }).some((e) => e.startsWith('journal doit être un sous-répertoire du dépôt')), { attendu: true });
      s.etape('journal hors du dépôt : refus', () => erreurs({ journal: '../ailleurs' }).some((e) => e.startsWith('journal doit être un sous-répertoire du dépôt')), { attendu: true });
      s.etape('instance.id qui remonte : refus', () => erreurs({ instance: { id: '../../x', nom: 'x', niveau: 'instance' } }).some((e) => e.startsWith('instance.id doit être un nom simple')), { attendu: true });
      s.etape('journal et instance ordinaires : aucune erreur', () => erreurs({ journal: './historique/' }), { attendu: [] });
    });

    test('erreurs du manifeste et de l’environnement', (t) => {
      const s = scenario(t);
      const erreurs = (manifeste) => avecDepot({ manifeste }, (d) => evaluer(contexteSur(d)));
      s.etape('modele.ref différent', () => erreurs(manifesteMinimal({ modele: { ref: 'autre', version: String(MODELE.modele.version) } })), { attendu: ['modele.ref "autre" ≠ "modele-executif-12f-7e"'] });
      s.etape('version épinglée différente', () => erreurs(manifesteMinimal({ modele: { ref: MODELE.modele.id, version: '0.1.0' } })), { attendu: [`version épinglée 0.1.0, modèle fourni ${MODELE.modele.version}`] });
      s.etape('section modele absente : trois erreurs', () => { const m = manifesteMinimal(); delete m.modele; return erreurs(m); }, { attendu: ['modele.ref absent ≠ "modele-executif-12f-7e"', `version épinglée absente, modèle fourni ${MODELE.modele.version}`, 'champ obligatoire absent : modele'] });
      for (const champ of ['instance', 'journal', 'invariants', 'seuils', 'retroaction']) {
        s.etape(`champ obligatoire absent : ${champ}`, () => { const m = manifesteMinimal(); delete m[champ]; return erreurs(m).includes(`champ obligatoire absent : ${champ}`); }, { attendu: true });
      }
      s.etape('niveau hors meta et instance', () => erreurs(manifesteMinimal({ instance: { id: 'essai', niveau: 'projet' } })), { attendu: ['instance.niveau doit valoir meta ou instance'] });
      s.etape('jq masqué', () => avecEnv({ PATH: pathSans(['jq']) }, () => erreurs(manifesteMinimal())), { attendu: ["jq introuvable : les assertions ne peuvent pas s'évaluer"] });
      s.etape('sh masqué', () => avecEnv({ PATH: pathSans(['sh']) }, () => erreurs(manifesteMinimal())), { attendu: ["sh introuvable : les contrôles de commande ne peuvent pas s'exécuter"] });
      s.etape('grep masqué', () => avecEnv({ PATH: pathSans(['grep']) }, () => erreurs(manifesteMinimal())), { attendu: ["grep introuvable : les contrôles de motif ne peuvent pas s'exécuter"] });
      s.etape('sous Windows natif : outils manquants, puis la marche à suivre', () => avecDepot({}, (d) => {
        const ctx = contexteSur(d);
        Object.assign(ctx, { plateforme: 'win32', outils: { ...ctx.outils, sh: false, jq: false, grep: false } });
        return evaluer(ctx);
      }), { attendu: [
        "jq introuvable : les assertions ne peuvent pas s'évaluer",
        "sh introuvable : les contrôles de commande ne peuvent pas s'exécuter",
        "grep introuvable : les contrôles de motif ne peuvent pas s'exécuter",
        'Windows natif non pris en charge : lancer le résolveur sous WSL2 ou dans son image Docker (README)',
      ] });
      s.etape('sous Windows, outils présents : aucune erreur', () => avecDepot({}, (d) => { const ctx = contexteSur(d); ctx.plateforme = 'win32'; return evaluer(ctx); }), { attendu: [] });
      s.etape('hors d’un dépôt Git', () => {
        const rep = mkdtempSync(join(tmpdir(), 'r7e-sans-git-'));
        writeFileSync(join(rep, 'm.yaml'), readFileSync(CHEMIN_MODELE, 'utf8'));
        writeFileSync(join(rep, 'i.yaml'), stringify(manifesteMinimal()));
        const r = evaluer(new Contexte(rep, join(rep, 'm.yaml'), join(rep, 'i.yaml')));
        rmSync(rep, { recursive: true, force: true });
        return r.length === 1 && r[0].startsWith('dépôt Git illisible : ');
      }, { attendu: true });
    });
  });

  describe('Élaborer', () => {
    const precedent = (scores, moyennes) => ({
      scores: Object.fromEntries(Object.entries(scores).map(([c, score]) => [c, { score }])),
      synthese: Object.fromEntries(Object.entries(moyennes).map(([terme, moyenne]) => [terme, { moyenne, ecarts: [] }])),
    });

    test('ordre du plan : prérequis d’abord, puis terme le plus faible', (t) => avecDepot({}, (depot) => {
      const s = scenario(t);
      const ctx = contexteSur(depot);
      s.etape('sans cycle précédent : plan vide', () => elaborer(ctx, null), { attendu: [] });
      const p = precedent({ '3.1': 1, '1.2': 0, 'EX.1': 1, '5.3': 1, '2.1': 2, '10.3': 1 }, { elements: 1.5, espace: 1, environnement: 1, second_ordre: 1.2, engendrent: 1.8 });
      s.etape('5.3 (prérequis) en tête, puis par moyenne du terme, puis par identifiant', () => elaborer(ctx, p), {
        attendu: [
          { critere: '5.3', raison: 'prerequis' },
          { critere: '10.3', raison: 'terme le plus faible' },
          { critere: '3.1', raison: 'terme le plus faible' },
          { critere: 'EX.1', raison: 'terme le plus faible' },
          { critere: '1.2', raison: 'terme le plus faible' },
        ],
      });
    }));

    test('cas limites : moyenne absente, critère retiré du modèle', (t) => avecDepot({}, (depot) => {
      const s = scenario(t);
      const ctx = contexteSur(depot);
      s.etape('moyenne null comptée comme 3', () => elaborer(ctx, precedent({ '6.1': 1, '3.1': 1 }, { etat: null, espace: 2 })).map((x) => x.critere), { attendu: ['3.1', '6.1'] });
      s.etape('critère inconnu du modèle courant : écarté', () => elaborer(ctx, precedent({ '99.9': 0, '3.1': 1 }, { espace: 1 })).map((x) => x.critere), { attendu: ['3.1'] });
      s.etape('scores null ou au-dessus de 1 : écartés', () => elaborer(ctx, precedent({ '3.1': null, '3.2': 2, '4.1': 3 }, {})), { attendu: [] });
    }));
  });

  describe('Examiner', () => {
    test('35 critères examinés, sans objet justifiés, un événement par critère', (t) => avecDepot({ manifeste: manifesteMinimal({ sans_objet: { '6.1': 'aucun processus web', '7.2': 'aucun port' } }) }, (depot) => {
      const s = scenario(t);
      const ctx = contexteSur(depot);
      evaluer(ctx);
      const { valeur: sc, evenements } = capturer(() => examiner(ctx));
      s.etape('35 scores', () => Object.keys(sc).length, { attendu: 35 });
      s.etape('6.1 sans objet : score null, constat justifié', () => [sc['6.1'].score, sc['6.1'].constat, sc['6.1'].controles], { attendu: [null, 'sans objet : aucun processus web', []] });
      s.etape('un événement « critere » par critère applicable', () => evenements.filter((e) => e.evenement === 'critere').length, { attendu: 33 });
      s.etape('chaque score est null, 0, 1, 2 ou 3', () => Object.values(sc).every((v) => [null, 0, 1, 2, 3].includes(v.score)), { attendu: true });
      s.etape('chaque contrôle porte type, résultat et constat', () => Object.values(sc).flatMap((v) => v.controles).every((k) => k.type && k.resultat && typeof k.constat === 'string'), { attendu: true });
      s.etape('hors CI : aucun score 3', () => Object.values(sc).some((v) => v.score === 3), { attendu: false });
    }));
  });

  describe('Évoluer', () => {
    const entree = (scores, moyennes) => ({
      scores: Object.fromEntries(Object.entries(scores).map(([c, score]) => [c, { score }])),
      synthese: Object.fromEntries(Object.entries(moyennes).map(([terme, moyenne]) => [terme, { moyenne }])),
    });

    test('tendance, régressions, viabilité', (t) => avecDepot({}, (depot) => {
      const s = scenario(t);
      const ctx = contexteSur(depot);
      ctx.release = 'v2';
      const avant = entree({ 'EX.1': 0, 'EX.2': 1, '3.1': 2 }, { espace: 2, second_ordre: 1 });
      const apres = entree({ 'EX.1': 1, 'EX.2': 1, '3.1': 1 }, { espace: 1.5, second_ordre: 1.33 });
      evoluer(ctx, apres, avant, [avant]);
      // 0.5.0 : la tendance se calcule sur les critères notés dans les deux cycles, pas sur les moyennes consignées
      s.etape('tendance par terme, sur les critères communs', () => apres.tendance, { attendu: { espace: -1, second_ordre: 0.5 } });
      s.etape('régression rattachée à la release (EV.2)', () => apres.regressions, { attendu: [{ critere: '3.1', release: 'v2' }] });
      s.etape('viable et en progrès : EX.1 monte, rien ne baisse', () => apres.viabilite, { attendu: { viable: true, progresse: true } });
    }));

    test('viabilité : premier cycle, sans progrès, non viable, assertion en échec', (t) => avecDepot({}, (depot) => {
      const s = scenario(t);
      const ctx = contexteSur(depot);
      const juger = (a, b) => { const e = entree(b, {}); evoluer(ctx, e, a ? entree(a, {}) : null, a ? [entree(a, {})] : []); return e.viabilite; };
      s.etape('premier cycle → null', () => juger(null, { 'EX.1': 1 }), { attendu: null });
      s.etape('rien ne bouge → viable, sans progrès', () => juger({ 'EX.1': 1 }, { 'EX.1': 1 }), { attendu: { viable: true, progresse: false } });
      s.etape('EQ.2 baisse → non viable', () => juger({ 'EQ.2': 2, 'EX.1': 0 }, { 'EQ.2': 1, 'EX.1': 1 }), { attendu: { viable: false, progresse: false } });
      s.etape('un score absent d’un côté ne compte pas (0.5.0)', () => juger({}, { 'EV.1': 1 }), { attendu: { viable: true, progresse: false } });
      const e = entree({}, {});
      ctx.M = { ...ctx.M, finalite: { ...ctx.M.finalite, viabilite: { assertion: '.[' } } };
      evoluer(ctx, e, null, []);
      s.etape('assertion en échec → null et remarque', () => [e.viabilite, ctx.remarques.at(-1)?.startsWith('viabilité non jugée : jq : ')], { attendu: [null, true] });
    }));
  });

  describe('Équilibrer', () => {
    const entree = (mesures, statut = 'executee', scores = {}) => ({ phases: { equilibrer: { statut } }, mesures, scores });

    test('rétroaction déclarée, ticket par défaut, ticket forcé si bloquée', (t) => avecDepot({ manifeste: manifesteMinimal({ retroaction: [{ indicateur: 'delai_commit_production_h', correction: 'rollback' }] }) }, (depot) => {
      const s = scenario(t);
      const ctx = contexteSur(depot);
      const hors = [
        { indicateur: 'delai_commit_production_h', valeur: 30, seuil: 24, hors_seuil: true },
        { indicateur: 'cout', valeur: 5, seuil: 3, hors_seuil: true },
        { indicateur: 'ok', valeur: 1, seuil: 2, hors_seuil: false },
      ];
      const e1 = entree(hors);
      equilibrer(ctx, e1);
      // Le critère est celui dont un contrôle métrique mesure l'indicateur (10.2) ;
      // un indicateur qu'aucun contrôle du modèle ne mesure n'a pas de critère
      // Depuis le contrat 0.3, chaque décision porte son motif : la mesure et son
      // seuil (unité du manifeste), puis la correction remplacée si Équilibrer est bloquée
      s.etape('correction déclarée (rollback), critère du contrôle métrique, motif', () => e1.decisions[0], {
        attendu: { indicateur: 'delai_commit_production_h', critere: '10.2', correction: 'rollback', reversible: true, cible: 'ce qui fait dériver delai_commit_production_h', motif: 'delai_commit_production_h = 30, hors seuil (<= 24 h)' },
      });
      s.etape('indicateur sans règle ni unité : ticket par défaut, sans critère', () => e1.decisions[1], {
        attendu: { indicateur: 'cout', critere: null, correction: 'ticket', reversible: true, cible: 'ce qui fait dériver cout', motif: 'cout = 5, hors seuil (<= 3)' },
      });
      s.etape('mesure dans le seuil : aucune décision', () => e1.decisions.length, { attendu: 2 });
      s.etape('clés dans l’ordre du contrat du journal', () => Object.keys(e1.decisions[0]), { attendu: Object.keys(MODELE.contrats.journal.champs.decisions[0]) });
      const e2 = entree(hors.slice(0, 1), 'bloquee');
      equilibrer(ctx, e2);
      s.etape('Équilibrer bloquée : ticket, motif expliqué', () => e2.decisions, { attendu: [{ indicateur: 'delai_commit_production_h', critere: '10.2', correction: 'ticket', reversible: true, cible: 'ce qui fait dériver delai_commit_production_h', motif: 'delai_commit_production_h = 30, hors seuil (<= 24 h) ; Équilibrer bloquée : ticket au lieu de rollback' }] });
      s.etape('aucun seuil révisé automatiquement', () => e2.seuils_revises, { attendu: [] });
    }));

    test('propositions au modèle : contrôles prévus pour compose, sans équivalent', (t) => avecDepot({}, (depot) => {
      const s = scenario(t);
      const ctx = contexteSur(depot);
      const e = entree([], 'executee', {
        '2.2': { controles: [{ type: 'fichier', resultat: 'conforme' }, { type: 'scenario', resultat: 'erreur', cause: 'hors_compose' }] },
        '3.2': { controles: [{ type: 'commande', resultat: 'erreur', cause: 'outil_absent' }] },
        '6.1': { controles: [] },
      });
      equilibrer(ctx, e);
      s.etape('une proposition, pour 2.2 seulement', () => e.propositions_modele, { attendu: [{ critere: '2.2', nature: 'controle', motif: 'contrôle prévu pour un projet compose, sans équivalent pour ce projet' }] });
    }));
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  13. CYCLE ET JOURNAL (contrats.journal)
//  Une entrée par cycle, écrite ouverte (cycle.fin vide), close ensuite et
//  jamais réécrite ; numérotée par le nombre d'entrées ; comparée au dernier
//  cycle clos, d'un contrat à l'autre sur les critères communs (0.5.0). Au
//  rang instance, le cycle part d'une demande : son ticket, à côté de l'entrée.
// ════════════════════════════════════════════════════════════════════════════
describe('13. Cycle complet et journal', () => {
  const lancerCycle = (ctx, clore = false, demande = TICKET) => capturer(() => cycle(ctx, clore, demande));

  test('premier cycle : entrée ouverte, conforme au contrat du journal', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    const { valeur: [chemin, e], evenements } = lancerCycle(contexteSur(depot));
    s.etape('fichier journal/essai/0000.yaml', () => chemin.slice(depot.chemin.length), { attendu: '/journal/essai/0000.yaml' });
    s.etape('clés de l’entrée, dans l’ordre du contrat', () => Object.keys(e), { attendu: ['cycle', 'release', 'demande', 'fichiers', 'plan', 'phases', 'scores', 'synthese', 'mesures', 'incidents', 'remarques', 'outils', 'tendance', 'regressions', 'viabilite', 'decisions', 'seuils_revises', 'propositions_modele'] });
    s.etape('section cycle', () => Object.keys(e.cycle), { attendu: ['id', 'numero', 'instance', 'niveau', 'modele_version', 'contrat_version', 'en_ci', 'debut', 'fin'] });
    s.etape('entrée ouverte : fin vide', () => e.cycle.fin, { attendu: null });
    s.etape('35 scores, 7 phases dans l’ordre, 8 termes', () => [Object.keys(e.scores).length, Object.keys(e.phases), Object.keys(e.synthese).length], { attendu: [35, PHASES, 8] });
    s.etape('premier cycle : plan vide, viabilité non jugée', () => [e.plan, e.viabilite], { attendu: [[], null] });
    s.etape('relu depuis le disque : identique', () => parse(readFileSync(chemin, 'utf8')), { attendu: e });
    s.etape('événements : cycle_ouvert, puis cycle_ecrit', () => [evenements[0].evenement, evenements.at(-1).evenement, evenements.at(-1).close], { attendu: ['cycle_ouvert', 'cycle_ecrit', false] });
  }));

  test('gardes : un cycle ouvert bloque le suivant ; une entrée n’est jamais réécrite', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    lancerCycle(contexteSur(depot));
    s.etape('second cycle refusé tant que 0000 est ouverte', () => assert.throws(() => lancerCycle(contexteSur(depot)), /un cycle est déjà ouvert : clore l'entrée ouverte d'abord/));
    s.etape('fichier attendu déjà présent → refus', () => avecDepot({}, (d) => { ecrireEntree(d, 'essai', 1, entreeMinimale({ id: 'essai-0001', numero: 1 })); return assert.throws(() => lancerCycle(contexteSur(d)), /existe déjà : une entrée n'est jamais réécrite/); }));
    s.etape('manifeste invalide → refus d’Évaluer, rien d’écrit', () => avecDepot({ manifeste: manifesteMinimal({ instance: { id: 'essai', niveau: 'x' } }) }, (d) => { assert.throws(() => lancerCycle(contexteSur(d)), /Évaluer : instance.niveau doit valoir meta ou instance/); return contexteSur(d).journal().length; }), { attendu: 0 });
  }));

  test('cycles successifs : numérotation, comparaison, entrée close', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    const [, e0] = lancerCycle(contexteSur(depot), true).valeur;
    s.etape('cycle 0 clos : fin renseignée', () => typeof e0.cycle.fin, { attendu: 'string' });
    const [c1, e1] = lancerCycle(contexteSur(depot), true).valeur;
    s.etape('cycle 1 : 0001.yaml', () => c1.endsWith('/journal/essai/0001.yaml'), { attendu: true });
    s.etape('cycle 1 comparé au cycle 0 : viabilité jugée', () => e1.viabilite !== null && typeof e1.viabilite.viable, { attendu: 'boolean' });
    s.etape('plan du cycle 1 : écarts du cycle 0', () => e1.plan.every((p) => (e0.scores[p.critere]?.score ?? 3) <= 1), { attendu: true });
    s.etape('tendance calculée sur les termes comparables', () => Object.keys(e1.tendance).length > 0, { attendu: true });
    const [c2] = lancerCycle(contexteSur(depot), true).valeur;
    s.etape('cycle 2 : 0002.yaml', () => c2.endsWith('/journal/essai/0002.yaml'), { attendu: true });
  }));

  test('comparabilité : d’un contrat à l’autre, sur les critères communs', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    ecrireEntree(depot, 'essai', 0, { ...entreeMinimale({ contrat: '0.1', scores: { 'EX.1': { score: 3 }, '99.9': { score: 3 } } }), synthese: { second_ordre: { moyenne: 3, ecarts: [] } } });
    const [, e] = lancerCycle(contexteSur(depot), true).valeur;
    s.etape('numéro 1, comparé au cycle du contrat 0.1', () => [e.cycle.numero, e.viabilite !== null], { attendu: [1, true] });
    s.etape('EX.1 baisse : régression rattachée à la release, cycle non viable', () => [e.regressions.some((r) => r.critere === 'EX.1'), e.viabilite.viable], { attendu: [true, false] });
    s.etape('la version du modèle a changé : elle est citée avec la régression', () => e.regressions.find((r) => r.critere === 'EX.1').modele, { attendu: String(MODELE.modele.version) });
    s.etape('au rang instance, aucune proposition de retour', () => e.propositions_modele.filter((p) => p.nature === 'retour').length, { attendu: 0 });
  }));

  test('rang méta : une baisse après une nouvelle version du modèle la remet en question', (t) => avecDepot({ manifeste: manifesteMinimal({ instance: { id: 'essai', nom: 'Essai', niveau: 'meta' } }) }, (depot) => {
    const s = scenario(t);
    ecrireEntree(depot, 'essai', 0, { ...entreeMinimale({ contrat: '0.1', scores: { 'EX.1': { score: 3 } } }), synthese: { second_ordre: { moyenne: 3, ecarts: [] } } });
    const [, e] = lancerCycle(contexteSur(depot), true, null).valeur;
    const retour = e.propositions_modele.find((p) => p.nature === 'retour' && p.critere === 'EX.1');
    s.etape('rang méta : aucun ticket, demande nulle', () => e.demande, { attendu: null });
    s.etape('proposition de retour sur EX.1', () => Boolean(retour), { attendu: true });
    s.etape('son motif nomme les deux versions', () => retour.motif.startsWith(`EX.1 passe de 3 à ${e.scores['EX.1'].score} avec le modèle ${MODELE.modele.version} (cycle précédent : 0.2.1)`), { attendu: true });
  }));

  test('demande : au rang instance, un ticket MHTML, copié et cité ; le répertoire du cycle n’est pas versionné', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    s.etape('sans demande : refus, rien d’écrit', () => { assert.throws(() => lancerCycle(contexteSur(depot), false, null), /au rang instance, un cycle part d'une demande/); return existsSync(join(depot.chemin, 'journal/essai/0000')); }, { attendu: false });
    const repFaux = mkdtempSync(join(tmpdir(), 'r7e-faux-'));
    const faux = join(repFaux, 'ticket.html');
    writeFileSync(faux, '<html><body>pas un MHTML</body></html>');
    s.etape('un fichier qui n’est pas un MHTML : refus', () => assert.throws(() => lancerCycle(contexteSur(depot), false, faux), /exporté en MHTML/));
    rmSync(repFaux, { recursive: true, force: true });
    const ticket = ticketEssai('Évolution : écran de connexion');
    const [, e] = lancerCycle(contexteSur(depot), false, ticket).valeur;
    s.etape('demande citée : lien, titre décodé, taille, empreinte', () => [e.demande.lien, e.demande.titre, e.demande.octets, e.demande.empreinte], { attendu: ['0000/jira.mhtml', 'Évolution : écran de connexion', readFileSync(ticket).length, createHash('sha256').update(readFileSync(ticket)).digest('hex')] });
    s.etape('le ticket est copié à côté de l’entrée, à l’identique', () => readFileSync(join(depot.chemin, 'journal/essai/0000/jira.mhtml')).equals(readFileSync(ticket)), { attendu: true });
    s.etape('Git ignore tout le répertoire du cycle (.gitignore « * »)', () => [depot.git('status', '--porcelain', '--', 'journal/essai/0000'), depot.git('check-ignore', 'journal/essai/0000/jira.mhtml')], { attendu: ['', 'journal/essai/0000/jira.mhtml'] });
    s.etape('l’entrée, elle, reste à versionner', () => depot.git('status', '--porcelain', '--', 'journal/essai/0000.yaml'), { attendu: '?? journal/essai/0000.yaml' });
  }));

  test('fichiers temporaires : ce qu’un contrôle laisse au temp du cycle est cité par lien', (t) => avecDepot({ manifeste: manifesteMinimal({ tests: { fumee: 'd=$(mktemp -d); echo essai > "$d/trace.txt"' }, sans_objet: {} }) }, (depot) => {
    const s = scenario(t);
    const ctx = contexteSur(depot);
    // un contrôle commande ajouté au modèle chargé exécute la fumée, qui laisse un répertoire au temp
    ctx.M.termes[0].criteres[0].controles.push({ type: 'commande', commande: '{{ manifeste.tests.fumee }}' });
    const [, e] = lancerCycle(ctx, false).valeur;
    const f = e.fichiers.find((x) => x.lien.startsWith('0000/temp/tmp.'));
    s.etape('un fichier cité, sous 0000/temp/', () => Boolean(f), { attendu: true });
    s.etape('taille, nombre et empreinte du répertoire', () => [f.octets, f.nombre, /^[0-9a-f]{64}$/.test(f.empreinte)], { attendu: [6, 1, true] });
    s.etape('le répertoire est conservé', () => existsSync(join(depot.chemin, 'journal/essai', f.lien, 'trace.txt')), { attendu: true });
  }));

  // Évoluer (0.5.0) : tendance sur les critères notés dans les deux cycles ; viabilité sans les sans objet
  test('évolution : tendance et viabilité sur les critères communs', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    const vrai = contexteSur(depot);
    const ctx = { M: MODELE, release: 'r2', remarques: [], termeDe: vrai.termeDe, jq: (e, d) => vrai.jq(e, d) };
    const precedent = { cycle: { modele_version: String(MODELE.modele.version) }, scores: { '1.1': { score: 2 }, '1.2': { score: 0 }, 'EV.1': { score: 2 } }, synthese: {} };
    const entree = { scores: { '1.1': { score: 2 }, '1.2': { score: null }, 'EV.1': { score: null }, 'EX.1': { score: 1 } }, synthese: { elements: { moyenne: 2 }, second_ordre: { moyenne: 1 } } };
    evoluer(ctx, entree, precedent, [precedent]);
    s.etape('tendance des éléments : 1.1 seul compte (1.2 sans objet d’un côté)', () => entree.tendance, { attendu: { elements: 0 } });
    s.etape('aucune régression : un passage à sans objet n’est pas une baisse', () => entree.regressions, { attendu: [] });
    s.etape('viabilité : EV.1 sans objet d’un côté ne compte pas', () => entree.viabilite, { attendu: { viable: true, progresse: false } });
    s.etape('même version du modèle : aucune version citée', () => { const e2 = { scores: { '1.1': { score: 1 } }, synthese: {} }; evoluer(ctx, e2, precedent, [precedent]); return e2.regressions; }, { attendu: [{ critere: '1.1', release: 'r2' }] });
  }));

  test('rang méta : même version du modèle, aucune proposition de retour', (t) => avecDepot({ manifeste: manifesteMinimal({ instance: { id: 'essai', nom: 'Essai', niveau: 'meta' } }) }, (depot) => {
    const s = scenario(t);
    ecrireEntree(depot, 'essai', 0, { ...entreeMinimale({ contrat: '0.1', scores: { 'EX.1': { score: 3 } } }), cycle: { ...entreeMinimale().cycle, modele_version: String(MODELE.modele.version) } });
    const [, e] = lancerCycle(contexteSur(depot), true, null).valeur;
    s.etape('une baisse, rattachée, sans version citée', () => e.regressions.find((r) => r.critere === 'EX.1'), { attendu: { critere: 'EX.1', release: e.release } });
    s.etape('aucune proposition de retour', () => e.propositions_modele.filter((p) => p.nature === 'retour').length, { attendu: 0 });
  }));

  test('cycle interrompu : son répertoire sans entrée est mis de côté, jamais effacé', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    depot.ecrire('journal/essai/0000/temp/reste.txt', 'reste\n');
    const [, e] = lancerCycle(contexteSur(depot)).valeur;
    const abandon = readdirSync(join(depot.chemin, 'journal/essai')).find((n) => n.startsWith('0000.abandon-'));
    s.etape('le cycle 0 s’écrit malgré le répertoire laissé', () => e.cycle.numero, { attendu: 0 });
    s.etape('l’ancien répertoire est mis de côté, son contenu intact', () => readFileSync(join(depot.chemin, 'journal/essai', abandon, 'temp/reste.txt'), 'utf8'), { attendu: 'reste\n' });
    s.etape('une remarque le dit', () => e.remarques.some((r) => r.startsWith('répertoire d\'un cycle interrompu mis de côté : journal/essai/0000.abandon-')), { attendu: true });
    s.etape('un fichier à la place du répertoire : refus net', () => avecDepot({}, (d) => { d.ecrire('journal/essai/0000', 'x'); return assert.throws(() => lancerCycle(contexteSur(d)), /n'est pas un répertoire/); }));
  }));

  test('en CI : en_ci écrit, un 3 seulement sans contrôle déclaratif', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    const [, e] = avecEnv({ CI: 'true' }, () => lancerCycle(contexteSur(depot)).valeur);
    s.etape('en_ci vrai', () => e.cycle.en_ci, { attendu: true });
    const avecDeclaration = new Set(criteresDuModele().filter(([, c]) => c.controles.some((k) => k.type === 'declaration')).map(([id]) => id));
    s.etape('aucun 3 sur un critère à déclaration', () => Object.entries(e.scores).filter(([id, v]) => v.score === 3 && avecDeclaration.has(id)).length, { attendu: 0 });
  }));

  test('format YAML : lisible à l’identique en 1.1 et en 1.2', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    const [chemin] = lancerCycle(contexteSur(depot), true).valeur;
    const texte = readFileSync(chemin, 'utf8');
    s.etape('en-tête de deux commentaires', () => texte.split('\n').slice(0, 2), { attendu: ['# Entrée de journal du modèle exécutif 12 facteurs × 7E (contrats.journal)', "# Écrite par resolveur7e.mjs ; close, elle n'est plus réécrite."] });
    s.etape('horodatages entre guillemets (sinon dates en YAML 1.1)', () => /\n  debut: '\d{4}-\d{2}-\d{2}T/.test(texte), { attendu: true });
    s.etape('identifiants de critères entre guillemets', () => texte.includes("'1.1':"), { attendu: true });
    s.etape('lecture 1.1 = lecture 1.2', () => JSON.stringify(parse(texte, { version: '1.1' })) === JSON.stringify(parse(texte)), { attendu: true });
    s.etape('listes non indentées sous leur clé (style du cycle 0)', () => /\n {4}controles:\n {4}- type: /.test(texte), { attendu: true });
  }));

  test('ecrire : création exclusive, réécriture explicite', (t) => {
    const s = scenario(t);
    const rep = mkdtempSync(join(tmpdir(), 'r7e-ecrire-'));
    const chemin = join(rep, '0000.yaml');
    s.etape('création', () => { interne.ecrire(chemin, { cycle: { id: 'a' } }, true); return parse(readFileSync(chemin, 'utf8')); }, { attendu: { cycle: { id: 'a' } } });
    s.etape('seconde création → EEXIST', () => assert.throws(() => interne.ecrire(chemin, { cycle: { id: 'b' } }, true), /EEXIST/));
    s.etape('réécriture (entrée ouverte) permise', () => { interne.ecrire(chemin, { cycle: { id: 'c' } }); return parse(readFileSync(chemin, 'utf8')).cycle.id; }, { attendu: 'c' });
    rmSync(rep, { recursive: true, force: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  14. LIGNE DE COMMANDE
//  Codes : 0 succès, 1 refus d'une garde, 2 erreur d'usage. Le résolveur lit
//  DEPOT_7E, MODELE_7E, MANIFESTE_7E, DELAI_CONTROLE_7E.
// ════════════════════════════════════════════════════════════════════════════
describe('14. Ligne de commande', () => {
  const lancerMain = (depot, argv, vars = {}) => avecEnv({ DEPOT_7E: depot?.chemin, MODELE_7E: undefined, MANIFESTE_7E: undefined, ...vars }, () => capturer(() => main(argv)));

  test('erreurs d’usage : code 2, usage sur la sortie d’erreur', (t) => {
    const s = scenario(t);
    const c = (argv) => { const r = lancerMain(null, argv); return [r.valeur, r.erreurs.split('\n').filter(Boolean).at(-1)]; };
    s.etape('aucune commande', () => c([]), { attendu: [2, 'resolveur7e : commande attendue'] });
    s.etape('commande inconnue', () => c(['lancer']), { attendu: [2, 'resolveur7e : commande inconnue : lancer'] });
    s.etape('option inconnue', () => c(['cycle', '--vite'])[0], { attendu: 2 });
    s.etape('argument positionnel en trop', () => c(['valider', 'en-trop'])[0], { attendu: 2 });
    s.etape('proposer sans ses options', () => c(['proposer']), { attendu: [2, 'resolveur7e : proposer : options requises : --critere, --nature, --motif'] });
    s.etape('nature inconnue', () => c(['proposer', '--critere', '1.1', '--nature', 'idee', '--motif', 'x']), { attendu: [2, 'resolveur7e : proposer : --nature vaut ajout, retrait, reformulation, controle, retour'] });
    s.etape('le texte d’usage précède le message', () => lancerMain(null, []).erreurs.startsWith('usage : resolveur7e <commande> [options]'), { attendu: true });
  });

  test('aide : code 0, usage sur la sortie standard', (t) => {
    const s = scenario(t);
    s.etape('--help', () => { const r = lancerMain(null, ['--help']); return [r.valeur, r.sortie === interne.USAGE]; }, { attendu: [0, true] });
    s.etape('-h', () => lancerMain(null, ['-h']).valeur, { attendu: 0 });
    s.etape('cycle --help', () => lancerMain(null, ['cycle', '--help']).valeur, { attendu: 0 });
  });

  test('valider et examiner', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    const sha = depot.git('rev-parse', '--short=12', 'HEAD');
    const v = lancerMain(depot, ['valider']);
    s.etape('valider : code 0', () => v.valeur, { attendu: 0 });
    s.etape('première ligne : modèle, instance, release, CI', () => v.sortie.split('\n')[0], { attendu: `Modèle ${MODELE.modele.version} · instance essai · release ${sha} · hors CI` });
    s.etape('les sept outils, oui ou non', () => /^Outils : sh oui, git oui, jq oui, grep oui, docker (oui|non), gitleaks (oui|non), trivy (oui|non)$/.test(v.sortie.split('\n')[1]), { attendu: true });
    s.etape('dernière ligne : Manifeste valide.', () => v.sortie.trim().split('\n').at(-1), { attendu: 'Manifeste valide.' });
    const x = lancerMain(depot, ['examiner']);
    s.etape('examiner : code 0, huit termes et les phases bloquées', () => [x.valeur, x.sortie.trim().split('\n').length, x.sortie.trim().split('\n').at(-1).startsWith('Phases bloquées : ')], { attendu: [0, 9, true] });
    s.etape('examiner n’écrit pas de journal', () => contexteSur(depot).journal().length, { attendu: 0 });
  }));

  test('cycle, proposer, clore, historique', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    const c = (argv) => { const r = lancerMain(depot, argv); return [r.valeur, r.sortie.trim().split('\n').at(-1) ?? '', r.erreurs]; };
    s.etape('cycle sans demande, au rang instance : refus', () => { const [code, , err] = c(['cycle']); return [code, err.includes("Refus : au rang instance, un cycle part d'une demande")]; }, { attendu: [1, true] });
    s.etape('cycle --demande : entrée ouverte', () => c(['cycle', '--demande', TICKET]).slice(0, 2), { attendu: [0, 'Entrée : journal/essai/0000.yaml'] });
    s.etape('proposer : ajoutée à l’entrée ouverte', () => c(['proposer', '--critere', '12.1', '--nature', 'controle', '--motif', 'accepter docker run']).slice(0, 2), { attendu: [0, 'Proposition ajoutée à journal/essai/0000.yaml'] });
    s.etape('la proposition est écrite', () => parse(depot.lire('journal/essai/0000.yaml')).propositions_modele.at(-1), { attendu: { critere: '12.1', nature: 'controle', motif: 'accepter docker run' } });
    s.etape('proposer un retour au rang instance : refus', () => { const [code, , err] = c(['proposer', '--critere', '1.1', '--nature', 'retour', '--motif', 'x']); return [code, err.includes('rang méta seulement')]; }, { attendu: [1, true] });
    s.etape('proposer un critère inconnu : refus', () => { const [code, , err] = c(['proposer', '--critere', '99.9', '--nature', 'ajout', '--motif', 'x']); return [code, err.includes('Refus : critère inconnu : 99.9')]; }, { attendu: [1, true] });
    s.etape('clore', () => c(['clore']).slice(0, 2), { attendu: [0, 'Entrée close : journal/essai/0000.yaml'] });
    s.etape('clore sans entrée ouverte : refus', () => { const [code, , err] = c(['clore']); return [code, err.includes('Refus : aucune entrée ouverte')]; }, { attendu: [1, true] });
    s.etape('proposer sans entrée ouverte : refus', () => c(['proposer', '--critere', '1.1', '--nature', 'ajout', '--motif', 'x'])[0], { attendu: 1 });
    s.etape('historique : une ligne par entrée close', () => { const r = lancerMain(depot, ['historique']); return [r.valeur, /^essai-0000 {2}\d{4}-.+Z {2}release [0-9a-f]{12} {2}moyenne \d,\d\d {2}viable —$/.test(r.sortie.trim())]; }, { attendu: [0, true] });
    s.etape('le refus est journalisé en JSON', () => lancerMain(depot, ['clore']).evenements.at(-1), { verifier: (e) => assert.deepEqual([e.niveau, e.evenement, e.motif], ['erreur', 'refus', 'aucune entrée ouverte']) });
  }));

  test('configuration : fichiers introuvables, délai invalide, chemins explicites', (t) => avecDepot({}, (depot) => {
    const s = scenario(t);
    s.etape('modèle introuvable : refus, code 1', () => { const r = lancerMain(depot, ['valider'], { MODELE_7E: '/inexistant/modele.yaml' }); return [r.valeur, r.erreurs.includes('Refus : fichier introuvable : /inexistant/modele.yaml')]; }, { attendu: [1, true] });
    s.etape('délai invalide : refus avant tout contrôle', () => lancerMain(depot, ['valider'], { DELAI_CONTROLE_7E: 'abc' }).valeur, { attendu: 1 });
    const autre = join(depot.chemin, 'ailleurs.yaml');
    writeFileSync(autre, stringify(manifesteMinimal({ instance: { id: 'autre', niveau: 'instance' } })));
    s.etape('MANIFESTE_7E explicite', () => lancerMain(depot, ['valider'], { MANIFESTE_7E: autre }).sortie.split('\n')[0].includes('instance autre'), { attendu: true });
    s.etape('MODELE_7E explicite (le modèle du méta-projet)', () => lancerMain(depot, ['valider'], { MODELE_7E: CHEMIN_MODELE }).valeur, { attendu: 0 });
  }));

  test('point d’entrée : exécuté directement, par lien, jamais à l’import', (t) => {
    const s = scenario(t);
    const script = join(RACINE, 'resolveur7e.mjs');
    s.etape('node resolveur7e.mjs --help → 0', () => spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' }).status, { attendu: 0 });
    const lien = join(jetable('r7e-lien-'), 'resolveur7e');
    symlinkSync(script, lien);
    s.etape('par un lien symbolique (bin npm) → 0', () => spawnSync(process.execPath, [lien, '--help'], { encoding: 'utf8' }).status, { attendu: 0 });
    s.etape('import seul : aucune sortie', () => { const r = spawnSync(process.execPath, ['--input-type=module', '-e', `await import(${JSON.stringify(script)})`], { encoding: 'utf8' }); return [r.status, r.stdout, r.stderr]; }, { attendu: [0, '', ''] });
    s.etape('sans argument → 2', () => spawnSync(process.execPath, [script], { encoding: 'utf8' }).status, { attendu: 2 });
  });

  test('noms affichés des phases et des termes', (t) => table(t, [
    ['sept phases nommées', () => PHASES.map((p) => NOMS_PHASES[p]), ['Évaluer', 'Élaborer', 'Exécuter', 'Examiner', 'Évoluer', 'Émettre', 'Équilibrer']],
    ['huit termes nommés', () => Object.values(NOMS_TERMES), ['Éléments', 'Espace', 'Engendrent', 'État', 'Expression', 'Évolutif', 'Environnement', 'Second ordre']],
    ['format français des moyennes', () => [interne.fmt(1.5), interne.fmt(null)], ['1,50', '—']],
    ['oui, non, —', () => [interne.ouiNon(true), interne.ouiNon(false), interne.ouiNon(undefined)], ['oui', 'non', '—']],
  ]));
});

// Garde-fou de la convention : aucune constante ne doit dériver de la base
test('capacité : 16 opérations par test, la 17e est refusée', (t) => {
  const s = scenario(t);
  for (let i = 1; i < MAX_OPERATIONS; i += 1) s.etape(`opération ${i}`, () => i, { attendu: i });
  s.etape('opération 16, la dernière permise', () => s.nombre, { attendu: 16 });
  assert.throws(() => s.etape('opération 17', () => 17), /16 opérations au plus par test/);
});

