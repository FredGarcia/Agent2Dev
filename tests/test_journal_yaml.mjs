/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  test_journal_yaml.mjs : recette du journal de cycle (journal/<instance>/NNNN.yaml)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Le journal est la mémoire du système (contrats.journal) : chaque cycle y
 *  verse une entrée, écrite par Émettre, close par Équilibrer, jamais réécrite
 *  ensuite. Les cycles suivants s'y comparent (Élaborer, Évoluer) et la
 *  viabilité s'y juge : une entrée fausse fausse toute la suite.
 *
 *  Deux familles de vérifications, entrée par entrée :
 *    - la forme : le contrat (champs, ordre, valeurs permises, YAML 1.1 = 1.2) ;
 *    - la cohérence : ce qui se déduit d'autres champs est recalculé et comparé.
 *      Le score depuis les contrôles consignés (echelle.agregation et plafond de
 *      la boucle), le constat, la synthèse depuis les scores, le blocage depuis
 *      les prérequis, le plan depuis le cycle comparable précédent, la tendance,
 *      les régressions et la viabilité depuis l'historique, les décisions depuis
 *      les mesures.
 *  Les recalculs passent par les fonctions du résolveur (agreger, synthese,
 *  bloquer, elaborer, evoluer), nourries des seules données du journal : ils
 *  prouvent que l'entrée est celle que le résolveur aurait écrite, quel que
 *  soit le résolveur qui l'a écrite (resolveur7e.py pour le cycle 0).
 *
 *  Puis la suite du journal de chaque instance (numérotation, clôtures,
 *  versions, releases), et enfin le contrat face au résolveur : deux cycles
 *  synthétiques sur un dépôt jetable, avec une mesure hors seuil, passent les
 *  mêmes épreuves que les entrées réelles.
 *
 *  Les recalculs qui dépendent du modèle (critères, prérequis, métriques,
 *  assertions) ne portent que sur les entrées du contrat courant
 *  (cycle.contrat_version) : une entrée d'un autre contrat n'est éprouvée que
 *  dans sa forme.
 *
 *  Tests par entrée, 16 opérations au plus chacun :
 *     1. Fichier                 nom, YAML, en-tête, ordre du contrat, Git
 *     2. Cycle                   identité, versions, horodatages, release
 *     3. Scores                  valeurs, contrôles consignés, recalculs
 *     4. Synthèse, phases, plan  recalculés
 *     5. Évolution               tendance, régressions, viabilité, outils
 *     6. Mesures et décisions    hors seuil, décisions, propositions au modèle
 *  Par instance : 7. Suite du journal.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { after, describe, test } from 'node:test';
import { parse, parseDocument } from 'yaml';

import { NOMS_TERMES, PHASES, agreger, bloquer, cycle, elaborer, evoluer, interne, synthese } from '../resolveur7e.mjs';
import { table } from './outils/etapes.mjs';
import { MODELE as M, RACINE, TICKET, contexteSur, depotJetable, manifesteMinimal } from './outils/depot.mjs';
import { NEUTRE, capturer } from './outils/environnement.mjs';
import { criteres, divergences, jqEvaluer } from './outils/yaml.mjs';

// Hors CI, sans variable du résolveur héritée de la machine
for (const k of Object.keys(NEUTRE)) delete process.env[k];

// ── Le contrat, lu dans le modèle ────────────────────────────────────────────
const CHAMPS = M.contrats.journal.champs;
/** Les choix d'un champ du contrat, écrits « a | b | c ». */
const choix = (texte) => String(texte).split('|').map((x) => x.trim());

const ORDRE_ENTREE = Object.keys(CHAMPS);
const ORDRE_CYCLE = Object.keys(CHAMPS.cycle);
const CONTROLE = CHAMPS.scores['<critère>'].controles[0];
const CHAMPS_CONTROLE = Object.keys(CONTROLE);
const CAUSES = choix(CONTROLE.cause);
const SCORES = choix(CHAMPS.scores['<critère>'].score).map((s) => (s === 'null' ? null : Number(s)));
const NIVEAUX = choix(CHAMPS.cycle.niveau);
const STATUTS = choix(CHAMPS.phases['<phase>'].statut);
const RAISONS = choix(CHAMPS.plan[0].raison);
const CORRECTIONS = choix(CHAMPS.decisions[0].correction);
const CHAMPS_DECISION = Object.keys(CHAMPS.decisions[0]);
const NATURES = choix(CHAMPS.propositions_modele[0].nature);
const RESULTATS = M.types_de_controle.resultats;
const TYPES = Object.keys(M.types_de_controle.types);

// ── Le modèle courant, pour les recalculs ────────────────────────────────────
const CRITERES = criteres(M);
const IDS = CRITERES.map(([id]) => id);
const TERME_DE = Object.fromEntries(CRITERES.map(([id, , terme]) => [id, terme]));
const CONTROLES_DE = Object.fromEntries(CRITERES.map(([id, c]) => [id, c.controles]));
/** Phase de la boucle de chaque critère du second ordre qui y appartient. */
const PHASE_DE = Object.fromEntries(Object.entries(M.boucle.phases).flatMap(([ph, d]) => d.criteres.map((c) => [c, ph])));
/** Indicateur → critère qui le mesure (le premier, comme Équilibrer) et comparaison. */
const METRIQUES = {};
for (const [id, c] of CRITERES) {
  for (const k of c.controles) {
    if (k.type === 'metrique' && !Object.hasOwn(METRIQUES, k.indicateur)) METRIQUES[k.indicateur] = { critere: id, comparaison: k.comparaison ?? '<=' };
  }
}

/** versionnage.contrat_version : la majeure ; avant 1.0.0, 0.<mineure>. */
function contratDe(version) {
  const [majeure, mineure] = String(version).split('.');
  return majeure === '0' ? `0.${mineure}` : majeure;
}
const CONTRAT_COURANT = contratDe(M.modele.version);

const ENTETE = /^# Entrée de journal du modèle exécutif 12 facteurs × 7E \(contrats\.journal\)\n# Écrite par resolveur7e\.(mjs|py) ; close, elle n'est plus réécrite\.\n/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const MOTIF_HORS_COMPOSE = 'contrôle prévu pour un projet compose, sans équivalent pour ce projet';

const estTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const tableOuVide = (v) => (estTable(v) ? v : {});
const listeOuVide = (v) => (Array.isArray(v) ? v : []);
const comparer = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const semver = (v) => String(v).split('.').map(Number);
function versionAvant(a, b) {
  const [x, y] = [semver(a), semver(b)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i];
  return false;
}

// ── Git, en lecture seule ────────────────────────────────────────────────────
const git = (depot, ...args) => spawnSync('git', ['-C', depot, ...args], { encoding: 'utf8' });
const estGit = (depot) => git(depot, 'rev-parse', '--is-inside-work-tree').stdout.trim() === 'true';
const commitsDe = (depot, rel) => git(depot, 'log', '--format=%H', '--reverse', '--', rel).stdout.split('\n').filter(Boolean);

/** Les commits qui ont modifié (ou supprimé) l'entrée après celui qui l'a versée close. */
function reecrituresApresCloture(depot, rel) {
  let blobClos = null;
  const reecritures = [];
  for (const c of commitsDe(depot, rel)) {
    const blob = git(depot, 'rev-parse', '--verify', '--quiet', `${c}:${rel}`).stdout.trim();
    if (blobClos === null) {
      let fin = null;
      try { fin = parse(git(depot, 'show', `${c}:${rel}`).stdout)?.cycle?.fin ?? null; } catch { /* illisible à ce commit */ }
      if (fin) blobClos = blob;
    } else if (blob !== blobClos) {
      reecritures.push(c.slice(0, 12));
    }
  }
  return reecritures;
}

// ── Lecture des journaux ─────────────────────────────────────────────────────
/** Lit une entrée sans jamais lever : une erreur de lecture devient une opération en échec. */
function lire(texte) {
  const doc = parseDocument(texte);
  const doc11 = parseDocument(texte, { version: '1.1' });
  const erreurs = [...doc.errors, ...doc11.errors].map((e) => e.message);
  const sur = (d) => { try { return d.toJS() ?? {}; } catch { return {}; } };
  return { texte, doc, erreurs, e: erreurs.length ? {} : sur(doc), e11: erreurs.length ? {} : sur(doc11) };
}

/**
 * Les clés de critère écrites sans guillemets, partout où l'entrée en porte
 * (scores, plan…) : 1.1 se lit 1.1, mais 1.10 se lirait 1.1 et écraserait.
 */
function clesNonCitees(doc) {
  const scores = doc.get('scores', true);
  const cles = Array.isArray(scores?.items) ? scores.items.filter((p) => typeof p.key?.value !== 'string').map((p) => `scores.${p.key?.value}`) : [];
  const valeurs = [];
  for (const champ of ['plan', 'regressions', 'decisions', 'propositions_modele']) {
    const liste = doc.get(champ, true);
    for (const [i, item] of (Array.isArray(liste?.items) ? liste.items : []).entries()) {
      const c = item?.get?.('critere', true);
      if (c && c.value !== null && typeof c.value !== 'string') valeurs.push(`${champ}[${i}].critere`);
    }
  }
  const phases = doc.get('phases', true);
  for (const p of Array.isArray(phases?.items) ? phases.items : []) {
    const cause = p.value?.get?.('cause', true);
    for (const [i, c] of (Array.isArray(cause?.items) ? cause.items : []).entries()) if (typeof c?.value !== 'string') valeurs.push(`phases.${p.key?.value}.cause[${i}]`);
  }
  return [...cles, ...valeurs];
}

/**
 * Le journal d'une instance, et pour chaque entrée ce que le résolveur voyait
 * à son cycle : les entrées closes et comparables qui la précèdent, par date de
 * clôture, et la dernière d'entre elles (le précédent). Avant le contrat 0.5,
 * seules celles du même contrat ; depuis, toutes (contrats.journal.cloture).
 */
function lireDossier(depot, repertoire, origine) {
  const fichiers = readdirSync(repertoire)
    .filter((f) => f.endsWith('.yaml') && !f.startsWith('.') && statSync(join(repertoire, f)).isFile())
    .sort();
  const entrees = fichiers.map((fichier) => {
    const chemin = join(repertoire, fichier);
    return { fichier, chemin, rel: relative(depot, chemin), ...lire(readFileSync(chemin, 'utf8')) };
  });
  for (const [i, x] of entrees.entries()) {
    const contrat = String(x.e?.cycle?.contrat_version);
    const croise = !versionAvant(`${contrat}.0`, '0.5.0');
    x.comparables = entrees.slice(0, i).map((y) => y.e)
      .filter((e) => e?.cycle?.fin && (croise || String(e.cycle.contrat_version) === contrat))
      .sort((a, b) => comparer(String(a.cycle.fin), String(b.cycle.fin)));
    x.precedent = x.comparables.at(-1) ?? null;
    x.memeContrat = contrat === CONTRAT_COURANT;
  }
  return { depot, repertoire, instance: basename(repertoire), origine, git: estGit(depot), entrees };
}

const MANIFESTE_RACINE = parse(readFileSync(join(RACINE, '7e-instance.yaml'), 'utf8'));
const DOSSIER_JOURNAL = join(RACINE, String(MANIFESTE_RACINE.journal ?? 'journal'));
const DOSSIERS = existsSync(DOSSIER_JOURNAL)
  ? readdirSync(DOSSIER_JOURNAL, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort()
    .map((nom) => lireDossier(RACINE, join(DOSSIER_JOURNAL, nom), 'dépôt'))
  : [];

// ── Recalculs ────────────────────────────────────────────────────────────────
/** Score et constat d'un critère, recalculés depuis ses contrôles consignés. */
function scoreEtConstat(e, cid) {
  const s = e.scores[cid];
  if (!s.controles.length && String(s.constat).startsWith('sans objet : ')) return { score: null, constat: s.constat };
  const resultats = s.controles.map((k) => ({ type: k.type, resultat: k.resultat, heuristique: k.heuristique === true }));
  const base = agreger(resultats, e.cycle.en_ci === true);
  const aVoir = s.controles.filter((k) => k.resultat !== 'conforme' && k.resultat !== 'sans_objet');
  const constat = aVoir.length
    ? aVoir.map((k) => `${k.type} ${k.resultat} : ${k.constat}`).join(' | ')
    : base !== null ? 'tous les contrôles applicables sont conformes' : 'aucun contrôle applicable';
  const ph = PHASE_DE[cid];
  if (ph && e.phases?.[ph]?.statut === 'bloquee' && base !== null && base > 1) {
    return { score: 1, constat: `${constat} | plafonné à 1 : prérequis en écart (${e.phases[ph].cause.join(', ')})` };
  }
  return { score: base, constat };
}

/** Tendance, régressions et viabilité, recalculées par Évoluer sur les seules données du journal. */
function evolutionDe(x) {
  const copie = structuredClone(x.e);
  const ctx = { M, termeDe: TERME_DE, release: x.e.release, remarques: [], jq: (expression, donnees) => jqEvaluer(expression, donnees) };
  evoluer(ctx, copie, x.precedent, x.comparables);
  return { tendance: copie.tendance, regressions: copie.regressions, viabilite: copie.viabilite };
}

const assertion = (cid, type) => CRITERES.find(([id]) => id === cid)[1].controles.find((k) => k.type === type).assertion;
const ecart = (v) => v?.score !== null && v?.score !== undefined && v.score <= 1;

// ── Les six tests d'une entrée, en tables d'opérations ───────────────────────
function fichier(dos, x) {
  const ferme = Boolean(x.e?.cycle?.fin);
  const cas = [
    ['nom : quatre chiffres, extension .yaml', () => /^\d{4}\.yaml$/.test(x.fichier), true],
    ['YAML lisible, sans clé dupliquée', () => x.erreurs, []],
    ['lecture 1.1 = lecture 1.2 (le résolveur écrit en 1.1)', () => divergences(x.e, x.e11).map((d) => d.chemin), []],
    ['encodage UTF-8 sans BOM, fins de ligne Unix', () => [x.texte.charCodeAt(0) === 0xfeff, x.texte.includes('\r\n')], [false, false]],
    ['en-tête : écrite par le résolveur, jamais réécrite close', () => ENTETE.test(x.texte), true],
    // demande et fichiers entrent au contrat avec la 0.5.0
    ['champs de l’entrée, dans l’ordre du contrat', () => Object.keys(x.e), versionAvant(`${x.e?.cycle?.contrat_version}.0`, '0.5.0') ? ORDRE_ENTREE.filter((c) => !['demande', 'fichiers'].includes(c)) : ORDRE_ENTREE],
    ['champs de la section cycle, dans l’ordre du contrat', () => Object.keys(tableOuVide(x.e.cycle)), ORDRE_CYCLE],
    ['identifiants de critère cités (1.10 non cité se lirait 1.1)', () => clesNonCitees(x.doc), []],
  ];
  if (dos.git) {
    cas.push(['versionnée dans Git', () => git(dos.depot, 'ls-files', '--error-unmatch', '--', x.rel).status, 0]);
    if (ferme) {
      cas.push(
        ['close : aucun commit ne l’a réécrite depuis sa clôture', () => reecrituresApresCloture(dos.depot, x.rel), []],
        ['close : aucune modification en cours', () => git(dos.depot, 'diff', '--quiet', 'HEAD', '--', x.rel).status, 0],
      );
    }
  }
  return cas;
}

function sectionCycle(dos, x) {
  const c = tableOuVide(x.e.cycle);
  const numero = x.fichier.slice(0, 4);
  const cas = [
    ['id = <instance>-<numéro sur 4 chiffres>', () => c.id, `${dos.instance}-${numero}`],
    ['numero = numéro du fichier, à partir de 0', () => c.numero, Number(numero)],
    ['instance = répertoire du journal', () => c.instance, dos.instance],
    [`niveau : ${NIVEAUX.join(' ou ')}`, () => NIVEAUX.includes(c.niveau), true],
    ['modele_version : semver, en texte', () => typeof c.modele_version === 'string' && /^\d+\.\d+\.\d+$/.test(c.modele_version), true],
    ['contrat_version dérivée de modele_version (versionnage), en texte', () => c.contrat_version, contratDe(c.modele_version)],
    ['en_ci : un booléen', () => typeof c.en_ci, 'boolean'],
    ['debut : ISO 8601 UTC, à la seconde', () => ISO.test(String(c.debut)), true],
    ['fin : ISO 8601 UTC, ou vide tant que l’entrée est ouverte', () => c.fin === null || ISO.test(String(c.fin)), true],
    ['fin ≥ debut', () => c.fin === null || String(c.fin) >= String(c.debut), true],
    ['release : commit sur 12 caractères ou tag', () => /^[0-9a-f]{12}$/.test(String(x.e.release)) || /^v?\d+\.\d+\.\d+\S*$/.test(String(x.e.release)), true],
  ];
  if (dos.git) {
    cas.push(
      ['la release examinée existe dans l’historique', () => git(dos.depot, 'cat-file', '-e', `${x.e.release}^{commit}`).status, 0],
      ['elle précède le commit qui verse l’entrée', () => {
        const premier = commitsDe(dos.depot, x.rel)[0];
        return premier ? git(dos.depot, 'merge-base', '--is-ancestor', String(x.e.release), premier).status : 'non versionnée';
      }, 0],
    );
  }
  return cas;
}

function scores(dos, x) {
  const sc = tableOuVide(x.e.scores);
  const entrees = Object.entries(sc);
  const consignes = entrees.flatMap(([cid, s]) => listeOuVide(s?.controles).map((k, i) => ({ cid, i, k })));
  const declares = (s) => !listeOuVide(s?.controles).length && String(s?.constat).startsWith('sans objet : ');
  const cas = [
    ['scores permis : 0, 1, 2, 3 ou null', () => entrees.filter(([, s]) => !SCORES.includes(s?.score)).map(([c]) => c), []],
    ['chaque score : un constat, des preuves, des contrôles', () => entrees.filter(([, s]) => typeof s?.constat !== 'string' || !Array.isArray(s?.preuves) || !Array.isArray(s?.controles)).map(([c]) => c), []],
    ['preuves : des textes', () => entrees.filter(([, s]) => !listeOuVide(s?.preuves).every((p) => typeof p === 'string')).map(([c]) => c), []],
    ['contrôles : type, résultat, constat ; cause et heuristique au besoin', () => consignes.filter(({ k }) => !estTable(k) || !['type', 'resultat', 'constat'].every((p) => Object.hasOwn(k, p)) || Object.keys(k).some((p) => !CHAMPS_CONTROLE.includes(p))).map(({ cid, i }) => `${cid}#${i + 1}`), []],
    ['types et résultats du protocole', () => consignes.filter(({ k }) => !TYPES.includes(k?.type) || !RESULTATS.includes(k?.resultat)).map(({ cid, i }) => `${cid}#${i + 1}`), []],
    [`cause pour une erreur, et seulement : ${CAUSES.join(', ')}`, () => consignes.filter(({ k }) => (k?.cause !== undefined) !== (k?.resultat === 'erreur') || (k?.cause !== undefined && !CAUSES.includes(k.cause))).map(({ cid, i }) => `${cid}#${i + 1}`), []],
    ['heuristique : true ou absente', () => consignes.filter(({ k }) => k?.heuristique !== undefined && k.heuristique !== true).map(({ cid, i }) => `${cid}#${i + 1}`), []],
    ['critère déclaré sans objet : sans score, justification en constat', () => entrees.filter(([, s]) => declares(s) && s.score !== null).map(([c]) => c), []],
    ['hors CI, aucun 3 (echelle.agregation)', () => x.e.cycle?.en_ci === true || entrees.every(([, s]) => s?.score !== 3), true],
    ['aucun 3 avec une déclaration parmi les contrôles', () => entrees.filter(([, s]) => s?.score === 3 && listeOuVide(s.controles).some((k) => k.type === 'declaration' && k.resultat !== 'sans_objet')).map(([c]) => c), []],
  ];
  if (x.memeContrat) {
    cas.push(
      ['un score par critère du modèle, dans son ordre', () => Object.keys(sc), IDS],
      ['un contrôle consigné par contrôle du modèle, mêmes types', () => entrees.filter(([cid, s]) => !declares(s) && JSON.stringify(listeOuVide(s?.controles).map((k) => k.type)) !== JSON.stringify(listeOuVide(CONTROLES_DE[cid]).map((k) => k.type))).map(([c]) => c), []],
      ['heuristique consignée = heuristique du modèle', () => consignes.filter(({ cid, i, k }) => (k?.heuristique === true) !== (CONTROLES_DE[cid]?.[i]?.heuristique === true)).map(({ cid, i }) => `${cid}#${i + 1}`), []],
      ['score recalculé : echelle.agregation, puis plafond de la boucle', () => entrees.filter(([cid, s]) => scoreEtConstat(x.e, cid).score !== s.score).map(([c]) => c), []],
      ['constat recalculé : les contrôles non conformes, dans l’ordre', () => entrees.filter(([cid, s]) => scoreEtConstat(x.e, cid).constat !== s.constat).map(([c]) => c), []],
    );
  }
  return cas;
}

function synthesePhasesPlan(dos, x) {
  const ph = tableOuVide(x.e.phases);
  const boucle = Object.keys(M.boucle.phases);
  const cas = [
    ['synthèse : les huit termes, dans l’ordre', () => Object.keys(tableOuVide(x.e.synthese)), Object.keys(NOMS_TERMES)],
    ['phases : les sept, dans l’ordre du cycle', () => Object.keys(ph), PHASES],
    [`statut ${STATUTS.join(' ou ')} ; cause si et seulement si bloquée`, () => Object.entries(ph).filter(([, v]) => !STATUTS.includes(v?.statut) || (v.statut === 'bloquee') !== Array.isArray(v.cause) || (v.statut === 'bloquee' && !v.cause.length)).map(([p]) => p), []],
    ['hors de la boucle, aucune phase bloquée', () => PHASES.filter((p) => !boucle.includes(p) && ph[p]?.statut !== 'executee'), []],
    [`plan : critère et raison (${RAISONS.join(', ')})`, () => listeOuVide(x.e.plan).filter((p) => typeof p?.critere !== 'string' || !RAISONS.includes(p?.raison)).length, 0],
    ['premier cycle comparable : plan vide', () => x.precedent !== null || listeOuVide(x.e.plan).length === 0, true],
  ];
  if (x.memeContrat) {
    cas.push(
      ['synthèse recalculée : moyenne au pair, écarts ≤ 1, sans objet exclus', () => synthese({ termeDe: TERME_DE }, x.e.scores), x.e.synthese],
      ['blocage recalculé : prérequis en écart (boucle.blocage)', () => bloquer({ M }, structuredClone(x.e.scores)), Object.fromEntries(boucle.map((p) => [p, ph[p]]))],
      ['critères d’une phase bloquée plafonnés à 1', () => boucle.filter((p) => ph[p]?.statut === 'bloquee').flatMap((p) => M.boucle.phases[p].criteres).filter((c) => (x.e.scores?.[c]?.score ?? 0) > 1), []],
      ['plan recalculé depuis le cycle comparable précédent (Élaborer)', () => elaborer({ M, termeDe: TERME_DE }, x.precedent), x.e.plan],
      ['le plan ne vise que des écarts du précédent', () => listeOuVide(x.e.plan).filter((p) => !ecart(x.precedent?.scores?.[p.critere])).map((p) => p.critere), []],
    );
  }
  return cas;
}

function evolution(dos, x) {
  const v = x.e.viabilite;
  const cas = [
    ['viabilité : vide, ou { viable, progresse } booléens', () => v === null || (estTable(v) && typeof v.viable === 'boolean' && typeof v.progresse === 'boolean' && Object.keys(v).length === 2), true],
    ['progresser suppose d’être viable', () => v === null || !v.progresse || v.viable, true],
    ['premier cycle comparable : ni tendance, ni régression, ni viabilité', () => x.precedent !== null || [x.e.tendance, x.e.regressions, x.e.viabilite], x.precedent !== null || [{}, [], null]],
    ['régressions rattachées à la release examinée (EV.2)', () => listeOuVide(x.e.regressions).filter((r) => r?.release !== x.e.release).length, 0],
    // Une entrée garde les outils que recensait le résolveur de son cycle (sh n'y est
    // que depuis la détection Windows) : connus du résolveur et dans son ordre ; une
    // entrée écrite par le résolveur courant (dépôt synthétique) les a tous.
    ['outils : ceux du résolveur, dans son ordre, en booléens', () => {
      const cles = Object.keys(tableOuVide(x.e.outils));
      const rangs = cles.map((c) => interne.OUTILS.indexOf(c));
      return [
        dos.origine === 'synthétique' ? JSON.stringify(cles) === JSON.stringify(interne.OUTILS) : cles.length > 0 && rangs.every((r, i) => r >= 0 && (i === 0 || r > rangs[i - 1])),
        Object.values(tableOuVide(x.e.outils)).every((b) => typeof b === 'boolean'),
      ];
    }, [true, true]],
    ['remarques : des textes', () => listeOuVide(x.e.remarques).every((r) => typeof r === 'string') && Array.isArray(x.e.remarques), true],
    ['incidents : date, release, résumé', () => Array.isArray(x.e.incidents) && x.e.incidents.every((i) => estTable(i) && ['date', 'release', 'resume'].every((k) => Object.hasOwn(i, k))), true],
  ];
  if (x.memeContrat) {
    cas.push(
      ['tendance recalculée : écart de moyenne avec le précédent', () => evolutionDe(x).tendance, x.e.tendance],
      ['régressions recalculées', () => evolutionDe(x).regressions, x.e.regressions],
      ['viabilité recalculée (finalite.viabilite, cycles comparables)', () => evolutionDe(x).viabilite, x.e.viabilite],
    );
  }
  return cas;
}

function mesuresDecisions(dos, x) {
  const mesures = listeOuVide(x.e.mesures);
  const decisions = listeOuVide(x.e.decisions);
  const props = listeOuVide(x.e.propositions_modele);
  const cas = [
    ['mesures : indicateur, valeur, seuil (ou vide), hors_seuil', () => mesures.filter((m) => !estTable(m) || typeof m.indicateur !== 'string' || typeof m.valeur !== 'number' || !(m.seuil === null || typeof m.seuil === 'number') || typeof m.hors_seuil !== 'boolean').length, 0],
    ['une décision par mesure hors seuil, dans l’ordre', () => decisions.map((d) => d?.indicateur), mesures.filter((m) => m?.hors_seuil).map((m) => m.indicateur)],
    // Le motif entre au contrat avec la 0.3.0 : avant, il restait facultatif (en fin)
    ['décisions : champs du contrat dans l’ordre, motif requis depuis le contrat 0.3', () => decisions.filter((d) => { const k = JSON.stringify(Object.keys(tableOuVide(d))); return k !== JSON.stringify(CHAMPS_DECISION) && !(versionAvant(String(x.e.cycle?.contrat_version ?? '0'), '0.3') && k === JSON.stringify(CHAMPS_DECISION.filter((c) => c !== 'motif'))); }).length, 0],
    ['décisions : un motif écrit, quand il y est', () => decisions.filter((d) => Object.hasOwn(tableOuVide(d), 'motif') && (typeof d.motif !== 'string' || !d.motif.trim())).length, 0],
    [`corrections : ${CORRECTIONS.join(', ')} ; réversible : booléen`, () => decisions.filter((d) => !CORRECTIONS.includes(d?.correction) || typeof d?.reversible !== 'boolean').length, 0],
    ['Équilibrer bloquée : des tickets seulement', () => x.e.phases?.equilibrer?.statut !== 'bloquee' || decisions.every((d) => d?.correction === 'ticket'), true],
    ['aucune décision ne vise un invariant (IN.1)', () => jqEvaluer(assertion('IN.1', 'journal'), [x.e], { m: { invariants: ['axiome', 'cycle', 'contrats'] } }), true],
    ['seuils révisés : indicateur, avant, après, motif', () => listeOuVide(x.e.seuils_revises).filter((s) => !estTable(s) || typeof s.indicateur !== 'string' || typeof s.avant !== 'number' || typeof s.apres !== 'number' || typeof s.motif !== 'string').length, 0],
    [`propositions : critère, nature (${NATURES.join(', ')}), motif`, () => props.filter((p) => typeof p?.critere !== 'string' || !NATURES.includes(p?.nature) || typeof p?.motif !== 'string' || !p.motif.trim()).length, 0],
    ['chaque contrôle hors compose a sa proposition automatique', () => Object.entries(tableOuVide(x.e.scores)).filter(([, s]) => listeOuVide(s?.controles).some((k) => k.cause === 'hors_compose')).map(([c]) => c).filter((c) => !props.some((p) => p.critere === c && p.nature === 'controle' && p.motif === MOTIF_HORS_COMPOSE)), []],
  ];
  if (x.memeContrat) {
    cas.push(
      ['chaque mesure vient d’un contrôle métrique du modèle', () => mesures.filter((m) => !Object.hasOwn(METRIQUES, m?.indicateur)).length, 0],
      ['hors_seuil recalculé par la comparaison du modèle', () => mesures.filter((m) => m.hors_seuil !== (m.seuil === null ? false : !(METRIQUES[m.indicateur].comparaison === '<=' ? m.valeur <= m.seuil : m.valeur >= m.seuil))).length, 0],
      ['chaque décision nomme le critère qui mesure son indicateur', () => decisions.filter((d) => d.critere !== (METRIQUES[d.indicateur]?.critere ?? null)).length, 0],
      ['propositions : des critères du modèle', () => props.filter((p) => !IDS.includes(p?.critere)).map((p) => p?.critere), []],
      ['assertion EQ.1 (journal) : aucune mesure hors seuil sans décision', () => jqEvaluer(assertion('EQ.1', 'journal'), [x.e]) !== false, true],
    );
  }
  return cas;
}

function suite(dos) {
  const es = dos.entrees.map((x) => x.e);
  const fins = es.map((e) => e?.cycle?.fin ?? null);
  const ouvertes = fins.map((f, i) => (f ? null : i)).filter((i) => i !== null);
  const paires = es.slice(1).map((e, i) => [es[i], e]);
  const cas = [
    ['numérotation continue depuis 0000', () => dos.entrees.map((x) => x.fichier), dos.entrees.map((_, i) => `${String(i).padStart(4, '0')}.yaml`)],
    ['une entrée ouverte au plus : la dernière', () => ouvertes.length === 0 || (ouvertes.length === 1 && ouvertes[0] === es.length - 1), true],
    ['même instance et même niveau d’un cycle à l’autre', () => [new Set(es.map((e) => e?.cycle?.instance)).size, new Set(es.map((e) => e?.cycle?.niveau)).size], es.length ? [1, 1] : [0, 0]],
    ['clôtures dans l’ordre des numéros', () => fins.filter(Boolean).every((f, i, l) => i === 0 || l[i - 1] <= f), true],
    ['chaque cycle s’ouvre après la clôture du précédent', () => paires.filter(([a, b]) => !(String(b?.cycle?.debut) >= String(a?.cycle?.fin))).map(([, b]) => b?.cycle?.id), []],
    ['la version du modèle ne recule jamais', () => paires.filter(([a, b]) => versionAvant(b?.cycle?.modele_version, a?.cycle?.modele_version)).map(([, b]) => b?.cycle?.id), []],
  ];
  if (dos.git) {
    cas.push(['chaque release examinée descend de la précédente', () => paires.filter(([a, b]) => git(dos.depot, 'merge-base', '--is-ancestor', String(a?.release), String(b?.release)).status !== 0).map(([, b]) => b?.cycle?.id), []]);
  }
  return cas;
}

/** Déclare les sept tests d'un journal d'instance. */
function eprouver(dos) {
  describe(`Journal ${dos.origine} : ${dos.instance}`, () => {
    for (const x of dos.entrees) {
      describe(`entrée ${x.fichier}${x.memeContrat ? '' : ` (contrat ${x.e?.cycle?.contrat_version} : forme seule)`}`, () => {
        test('1. Fichier', (t) => table(t, fichier(dos, x)));
        test('2. Cycle', (t) => table(t, sectionCycle(dos, x)));
        test('3. Scores', (t) => table(t, scores(dos, x)));
        test('4. Synthèse, phases, plan', (t) => table(t, synthesePhasesPlan(dos, x)));
        test('5. Évolution', (t) => table(t, evolution(dos, x)));
        test('6. Mesures, décisions, propositions', (t) => table(t, mesuresDecisions(dos, x)));
      });
    }
    test('7. Suite du journal', (t) => table(t, suite(dos)));
  });
}

// ════════════════════════════════════════════════════════════════════════════
test('le journal du méta-projet : son répertoire et le cycle 0', (t) => table(t, [
  ['le répertoire du journal (manifeste.journal) existe', () => existsSync(DOSSIER_JOURNAL), true],
  ['le méta-projet y a son journal, à partir du cycle 0 (amorçage)', () => existsSync(join(DOSSIER_JOURNAL, String(MANIFESTE_RACINE.instance?.id), '0000.yaml')), true],
  ['chaque instance publiée y a son répertoire, rien d’autre', () => readdirSync(DOSSIER_JOURNAL).filter((n) => !statSync(join(DOSSIER_JOURNAL, n)).isDirectory()), []],
]));

for (const dos of DOSSIERS) eprouver(dos);

// ════════════════════════════════════════════════════════════════════════════
//  Contrat ↔ résolveur : deux cycles synthétiques, une mesure hors seuil
// ════════════════════════════════════════════════════════════════════════════
//  Le dépôt jetable déclare une production déployée 100 h après chaque commit
//  (seuil 24 h, comparaison <=) : 10.2 mesure un délai hors seuil, Équilibrer
//  décide. Sa rétroaction prévoit un rollback, mais Équilibrer est bloquée par
//  ses prérequis (5.3, déclaration non faite) : le ticket est forcé, et motivé.
//  Les deux entrées écrites passent ensuite les mêmes épreuves que le journal
//  réel : le contrat, le résolveur et la recette disent la même chose.
function cyclesSynthetiques() {
  const m = manifesteMinimal({
    environnements: {
      production: {
        release_deployee: 'git rev-parse --short=12 HEAD',
        deploye_le: 'echo $(( $(git log -1 --format=%ct) + 360000 ))',
      },
    },
    retroaction: [
      { indicateur: 'delai_commit_production_h', correction: 'rollback' },
      { indicateur: 'temps_demarrage_s', correction: 'ticket' },
    ],
  });
  const depot = depotJetable({ manifeste: m, fichiers: { 'README.md': '# Essai\n' } });
  try {
    capturer(() => cycle(contexteSur(depot), true, TICKET));
    depot.commit('journal : cycle 0');
    capturer(() => cycle(contexteSur(depot), true, TICKET));
    depot.commit('journal : cycle 1');
    return { depot, erreur: null };
  } catch (e) {
    return { depot, erreur: e };
  }
}

const SYNTHESE = cyclesSynthetiques();
after(() => SYNTHESE.depot.nettoyer());
const DOSSIER_SYNTHETIQUE = SYNTHESE.erreur ? null : lireDossier(SYNTHESE.depot.chemin, join(SYNTHESE.depot.chemin, 'journal', 'essai'), 'synthétique');

describe('Contrat ↔ résolveur : deux cycles synthétiques, une mesure hors seuil', () => {
  test('les entrées écrites par le résolveur', (t) => {
    if (SYNTHESE.erreur) throw SYNTHESE.erreur;
    const [e0, e1] = DOSSIER_SYNTHETIQUE.entrees.map((x) => x.e);
    return table(t, [
      ['deux entrées écrites et closes', () => DOSSIER_SYNTHETIQUE.entrees.map((x) => [x.fichier, Boolean(x.e.cycle.fin)]), [['0000.yaml', true], ['0001.yaml', true]]],
      ['la mesure hors seuil est consignée : 100 h > 24 h', () => e1.mesures, [{ indicateur: 'delai_commit_production_h', valeur: 100, seuil: 24, hors_seuil: true }]],
      ['10.2 constate le délai hors seuil', () => e1.scores['10.2'].controles.find((k) => k.type === 'metrique'), { type: 'metrique', resultat: 'absent', constat: 'delai_commit_production_h = 100, seuil <= 24' }],
      ['Équilibrer est bloquée par 5.3 (déclaration non faite)', () => e1.phases.equilibrer.statut === 'bloquee' && e1.phases.equilibrer.cause.includes('5.3'), true],
      ['la décision nomme son critère ; ticket forcé, motivé', () => e1.decisions, [{ indicateur: 'delai_commit_production_h', critere: '10.2', correction: 'ticket', reversible: true, cible: 'ce qui fait dériver delai_commit_production_h', motif: 'delai_commit_production_h = 100, hors seuil (<= 24 h) ; Équilibrer bloquée : ticket au lieu de rollback' }]],
      ['le cycle 0 est le premier comparable : ni plan ni viabilité', () => [e0.plan, e0.viabilite], [[], null]],
      ['le cycle 1 se compare au cycle 0 : plan et viabilité', () => [e1.plan.length > 0, estTable(e1.viabilite)], [true, true]],
    ]);
  });
});

if (DOSSIER_SYNTHETIQUE) eprouver(DOSSIER_SYNTHETIQUE);
