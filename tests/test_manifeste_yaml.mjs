/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  test_manifeste_yaml.mjs : recette des manifestes d'instance (7e-instance.yaml)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Le manifeste est le contrat qu'une instance passe avec le modèle
 *  (contrats.manifeste) : ce qu'elle est, la version qu'elle épingle, ses
 *  environnements, ses seuils, sa rétroaction, ce qu'elle déclare sans objet.
 *  Le résolveur le relit à chaque cycle : une faute de forme n'y fait pas
 *  d'erreur visible, elle devient un contrôle muet ou un score faux. Cette
 *  suite la cherche avant le cycle.
 *
 *  Manifestes éprouvés
 *    - chaque 7e-instance.yaml du dépôt (aujourd'hui celui du méta-projet) ;
 *    - ceux que nomme RECETTE_MANIFESTES (chemins séparés par « : »), pour
 *      recetter une instance depuis la VM sans copier ses fichiers ici ;
 *    - le manifeste minimal des tests du résolveur (tests/outils/depot.mjs) :
 *      les dépôts jetables de test_resolveur7e.mjs restent des instances valides.
 *
 *  Pour chacun, sept tests de 16 opérations au plus :
 *     1. Lecture                YAML lisible, 1.2 = 1.1, champs du contrat
 *     2. Identité               instance, version épinglée, journal
 *     3. Environnements         fichiers, commandes, environnement de test
 *     4. Release et services    release, expose, admin, tests, observabilité
 *     5. Seuils et rétroaction  valeurs, seuils requis, corrections, EX.2, EQ.1
 *     6. Invariants, sans objet, déclarations (IN.1)
 *     7. Le résolveur l'accepte Évaluer et « valider », sur le dépôt réel
 *
 *  Les choix permis (niveaux, corrections, réponses…) sont lus dans le contrat
 *  du modèle, jamais recopiés ici : une révision du contrat révise la recette.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { describe, test } from 'node:test';
import { parseDocument, stringify } from 'yaml';

import { Contexte, champPresent, evaluer, main, present } from '../resolveur7e.mjs';
import { table } from './outils/etapes.mjs';
import { CHEMIN_MODELE, MODELE as M, RACINE, avecDepot, manifesteMinimal } from './outils/depot.mjs';
import { NEUTRE, avecEnv, capturer } from './outils/environnement.mjs';
import { criteres, divergences, jqEvaluer, shellsQuiRefusent } from './outils/yaml.mjs';

// Hors CI, sans variable du résolveur héritée de la machine
for (const k of Object.keys(NEUTRE)) delete process.env[k];

// ── Le contrat, lu dans le modèle ────────────────────────────────────────────
const CONTRAT = M.contrats.manifeste;
const CHAMPS = CONTRAT.champs;
const CRITERES = criteres(M);
const SOURCE_RESOLVEUR = readFileSync(join(RACINE, 'resolveur7e.mjs'), 'utf8');

const estTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const tableOuVide = (v) => (estTable(v) ? v : {});
const listeOuVide = (v) => (Array.isArray(v) ? v : []);

/** Les choix d'un champ du contrat, écrits « a | b | c ». */
const choix = (texte) => String(texte).split('|').map((x) => x.trim());
const NIVEAUX = choix(CHAMPS.instance.niveau);
const CORRECTIONS = choix(CHAMPS.retroaction[0].correction);
const REPONSES = choix(CHAMPS.declarations['<critère>'].reponse);
const TYPES_PROCESSUS = choix(CHAMPS.processus[0].type);
const TYPES_CONSOMME = choix(CHAMPS.consomme[0].type);

/**
 * Sous-champs permis des champs-tables du contrat dont les clés sont fixes
 * (instance, modele, release, expose, admin, tests, bascule, observabilite) ;
 * les tables à clés libres (<nom>, <indicateur>, <critère>) sont traitées à part.
 */
const SOUS_CHAMPS = Object.fromEntries(Object.entries(CHAMPS)
  .filter(([, v]) => estTable(v) && !Object.keys(v).some((k) => k.startsWith('<')))
  .map(([k, v]) => [k, Object.keys(v)]));
const CHAMPS_ENVIRONNEMENT = Object.keys(CHAMPS.environnements['<nom>']);

const VARIABLE = /^[A-Z][A-Z0-9_]*$/;
const relatifSur = (p) => typeof p === 'string' && p.length > 0 && !isAbsolute(p) && !p.split(/[\\/]/).includes('..');
const fichiersDe = (e) => (Array.isArray(e?.fichiers) ? e.fichiers : present(e?.fichiers) ? [e.fichiers] : []);

/** a ≤ b en semver (x.y.z numériques). */
function versionAuPlus(a, b) {
  const [x, y] = [String(a).split('.').map(Number), String(b).split('.').map(Number)];
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] < y[i];
  return true;
}

/** Seuils exigés, comme le résolveur les calcule : revue + métriques des critères applicables. */
function requisPour(m) {
  const sans = tableOuVide(m.sans_objet);
  const ind = new Set(['periode_revue_cycles']);
  for (const [cid, c] of CRITERES) {
    if (Object.hasOwn(sans, cid)) continue;
    for (const k of c.controles) if (k.type === 'metrique') ind.add(k.indicateur);
  }
  return [...ind].sort();
}

/** L'assertion jq d'un contrôle du modèle (critère, type). */
const assertion = (cid, type) => CRITERES.find(([id]) => id === cid)[1].controles.find((k) => k.type === type).assertion;

/** Un chemin pointé qui existe dans le modèle, ou dans le manifeste sous « manifeste. ». */
function elementConnu(chemin, m) {
  const suivre = (racine, segments) => segments.reduce((n, k) => (estTable(n) && Object.hasOwn(n, k) ? n[k] : undefined), racine);
  const segments = String(chemin).split('.');
  if (segments[0] === 'manifeste') return suivre(m, segments.slice(1)) !== undefined;
  return suivre(M, segments) !== undefined;
}

/** Les clés de critère écrites sans guillemets : 4.2 est un nombre, 1.10 deviendrait 1.1. */
function clesNonCitees(doc) {
  return ['sans_objet', 'declarations'].flatMap((champ) => {
    const noeud = doc.get(champ, true);
    if (!noeud || !Array.isArray(noeud.items)) return [];
    return noeud.items.filter((p) => typeof p.key?.value !== 'string').map((p) => `${champ}.${p.key?.value}`);
  });
}

/** Exécute un script dans le dépôt ; rend sa sortie, ou lève avec sa sortie d'erreur. */
function sortie(script, cwd) {
  const r = spawnSync('sh', ['-c', script], { cwd, encoding: 'utf8', timeout: 30000 });
  if (r.status !== 0) throw new Error(`code ${r.status} : ${(r.stderr || r.error?.message || '').trim()}`);
  return r.stdout.trim();
}

const versionne = (depot, fichier) => spawnSync('git', ['-C', depot, 'ls-files', '--error-unmatch', '--', String(fichier)], { encoding: 'utf8' }).status === 0;

function estRacineGit(rep) {
  const r = spawnSync('git', ['-C', rep, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  return r.status === 0 && realpathSync(r.stdout.trim()) === realpathSync(rep);
}

// ── Les manifestes éprouvés ──────────────────────────────────────────────────
/** Lit un manifeste sans jamais lever : une erreur de lecture devient une opération en échec. */
function lire(texte) {
  const doc = parseDocument(texte);
  const doc11 = parseDocument(texte, { version: '1.1' });
  const erreurs = [...doc.errors, ...doc11.errors].map((e) => e.message);
  const sur = (d) => { try { return d.toJS() ?? {}; } catch { return {}; } };
  return { texte, doc, erreurs, m: erreurs.length ? {} : sur(doc), m11: erreurs.length ? {} : sur(doc11) };
}

function depuisFichier(chemin, origine) {
  const depot = dirname(chemin);
  const rel = relative(RACINE, chemin);
  return {
    nom: `${origine} : ${rel.startsWith('..') ? chemin : rel}`,
    chemin, depot, fixture: false,
    git: estRacineGit(depot),
    racine: realpathSync(depot) === realpathSync(RACINE),
    ...lire(readFileSync(chemin, 'utf8')),
  };
}

function chercher(rep, nom, trouves = []) {
  for (const e of readdirSync(rep, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(rep, e.name);
    if (e.isDirectory()) chercher(p, nom, trouves);
    else if (e.isFile() && e.name === nom) trouves.push(p);
  }
  return trouves.sort();
}

const DU_DEPOT = chercher(RACINE, CONTRAT.fichier);
const EXTERNES = (process.env.RECETTE_MANIFESTES ?? '').split(delimiter).filter(Boolean).map((p) => resolve(p));
const MANIFESTES = [
  ...DU_DEPOT.map((p) => depuisFichier(p, 'dépôt')),
  ...EXTERNES.filter((p) => existsSync(p)).map((p) => depuisFichier(p, 'RECETTE_MANIFESTES')),
  { nom: 'fixture : manifeste minimal (tests/outils/depot.mjs)', chemin: null, depot: null, fixture: true, git: false, racine: false, ...lire(stringify(manifesteMinimal())) },
];

// ── Les sept tests d'un manifeste, en tables d'opérations ────────────────────
const lecture = (x) => [
  ['YAML lisible, sans clé dupliquée', () => x.erreurs, []],
  ['une table YAML', () => estTable(x.m), true],
  ['lecture 1.1 = lecture 1.2 (aucun yes/no, octal ou date ambigu)', () => divergences(x.m, x.m11).map((d) => d.chemin), []],
  ['encodage UTF-8 sans BOM, fins de ligne Unix', () => [x.texte.charCodeAt(0) === 0xfeff, x.texte.includes('\r\n')], [false, false]],
  [`les ${CONTRAT.obligatoires.length} champs obligatoires présents`, () => CONTRAT.obligatoires.filter((c) => !champPresent(x.m, c)), []],
  ['aucun champ hors contrat (faute de frappe)', () => Object.keys(x.m).filter((k) => !Object.hasOwn(CHAMPS, k)), []],
  ['sous-champs du contrat seulement', () => Object.entries(SOUS_CHAMPS).flatMap(([c, permis]) => Object.keys(tableOuVide(x.m[c])).filter((k) => !permis.includes(k)).map((k) => `${c}.${k}`)), []],
  ['champs d’environnement du contrat seulement', () => Object.entries(tableOuVide(x.m.environnements)).flatMap(([n, e]) => Object.keys(tableOuVide(e)).filter((k) => !CHAMPS_ENVIRONNEMENT.includes(k)).map((k) => `environnements.${n}.${k}`)), []],
  ['clés de critère citées (1.10 non cité se lirait 1.1)', () => clesNonCitees(x.doc), []],
];

function identite(x) {
  const inst = tableOuVide(x.m.instance);
  const mod = tableOuVide(x.m.modele);
  const cas = [
    ['instance.id : identifiant stable (minuscules, chiffres, tirets)', () => /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(String(inst.id ?? '')), true],
    ['instance.nom : un libellé', () => typeof inst.nom === 'string' && inst.nom.trim().length > 0, true],
    [`instance.niveau : ${NIVEAUX.join(' ou ')}`, () => NIVEAUX.includes(inst.niveau), true],
    ['modele.ref : l’identifiant du modèle', () => mod.ref, M.modele.id],
    ['modele.version écrite en texte (1.0 non cité se lirait 1)', () => typeof mod.version, 'string'],
    ['modele.version : semver', () => /^\d+\.\d+\.\d+$/.test(String(mod.version)), true],
    x.racine || x.fixture
      ? ['version épinglée = version du modèle porté par ce dépôt', () => String(mod.version), String(M.modele.version)]
      : ['version épinglée déjà publiée (≤ version du modèle)', () => versionAuPlus(mod.version, M.modele.version), true],
    ['journal : chemin relatif, sans remontée', () => relatifSur(x.m.journal), true],
  ];
  if (x.racine) {
    cas.push(
      ['à la racine du méta-projet, le niveau est meta', () => inst.niveau, 'meta'],
      ['le journal de l’instance existe : <journal>/<instance.id>/', () => existsSync(join(x.depot, String(x.m.journal), String(inst.id))), true],
    );
  }
  return cas;
}

function environnements(x) {
  const envs = tableOuVide(x.m.environnements);
  const noms = Object.keys(envs);
  const avecCompose = noms.filter((n) => fichiersDe(envs[n]).length);
  const commandes = noms.flatMap((n) => ['release_deployee', 'deploye_le']
    .filter((c) => tableOuVide(envs[n])[c] !== undefined).map((c) => [`environnements.${n}.${c}`, envs[n][c]]));
  const cas = [
    ['chaque environnement est une table', () => noms.filter((n) => !estTable(envs[n])), []],
    ['noms d’environnement en minuscules', () => noms.filter((n) => !/^[a-z][a-z0-9_-]*$/.test(n)), []],
    ['production comprise dès qu’un environnement est déclaré', () => !noms.length || noms.includes('production'), true],
    ['fichiers : liste de chemins relatifs', () => noms.filter((n) => !fichiersDe(envs[n]).every(relatifSur)), []],
    ['env_file : chemin relatif', () => noms.filter((n) => tableOuVide(envs[n]).env_file !== undefined && !relatifSur(envs[n].env_file)), []],
    ['release_deployee, deploye_le : textes que sh et bash acceptent', () => commandes.filter(([, c]) => typeof c !== 'string' || shellsQuiRefusent(c).length).map(([p]) => p), []],
    ['environnement_test déclaré dès qu’un environnement a un compose', () => !avecCompose.length || present(x.m.environnement_test), true],
    ['environnement_test nomme un environnement déclaré', () => x.m.environnement_test === undefined || noms.includes(x.m.environnement_test), true],
  ];
  if (x.depot) {
    cas.push(['les fichiers compose existent dans le dépôt', () => noms.flatMap((n) => fichiersDe(envs[n])).filter((f) => !existsSync(join(x.depot, String(f)))), []]);
  }
  // Les commandes de l'environnement de test se lancent pour de vrai (lecture seule)
  const test = tableOuVide(envs[x.m.environnement_test]);
  if (x.git && typeof test.release_deployee === 'string') {
    cas.push([`${x.m.environnement_test} : release_deployee imprime une release (tag ou commit)`, () => /^[\w.+\-/]+$/.test(sortie(test.release_deployee, x.depot)), true]);
  }
  if (x.git && typeof test.deploye_le === 'string') {
    cas.push([`${x.m.environnement_test} : deploye_le imprime une date epoch en secondes`, () => {
      const s = sortie(test.deploye_le, x.depot);
      return /^\d+$/.test(s) && Number(s) > 946684800 && Number(s) < Date.now() / 1000 + 86400;
    }, true]);
  }
  return cas;
}

function services(x) {
  const rel = tableOuVide(x.m.release);
  const exp = tableOuVide(x.m.expose);
  const adm = tableOuVide(x.m.admin);
  const tst = tableOuVide(x.m.tests);
  const obs = tableOuVide(x.m.observabilite);
  const taches = listeOuVide(adm.taches);
  const scripts = [
    ['release.precedente', rel.precedente],
    ['admin.etat_migrations', adm.etat_migrations],
    ...taches.map((t, i) => [`admin.taches[${i}].commande`, t?.commande]),
    ['tests.fumee', tst.fumee], ['tests.session', tst.session],
    ['tests.taches.enfiler', tableOuVide(tst.taches).enfiler], ['tests.taches.verifier', tableOuVide(tst.taches).verifier],
    ['observabilite.requete_test', obs.requete_test], ['observabilite.alertes', obs.alertes],
  ].filter(([, v]) => v !== undefined);
  const cas = [
    ['release.variable : une variable (MAJUSCULES_SOULIGNÉES)', () => rel.variable === undefined || VARIABLE.test(String(rel.variable)), true],
    ['expose : variable_consommateur et port_var sont des variables', () => ['variable_consommateur', 'port_var'].filter((k) => exp[k] !== undefined && !VARIABLE.test(String(exp[k]))), []],
    ['expose.contrat : chemin relatif', () => exp.contrat === undefined || relatifSur(exp.contrat), true],
    ['admin.taches : un nom et une commande, noms uniques', () => taches.every((t) => typeof t?.nom === 'string' && typeof t?.commande === 'string') && new Set(taches.map((t) => t?.nom)).size === taches.length, true],
    ['commandes déclarées : des textes que sh et bash acceptent', () => scripts.filter(([, v]) => typeof v !== 'string' || shellsQuiRefusent(v).length).map(([p]) => p), []],
    ['observabilite.tableaux_de_bord : une URL http(s)', () => obs.tableaux_de_bord === undefined || /^https?:\/\/\S+$/.test(String(obs.tableaux_de_bord)), true],
    [`processus : type ${TYPES_PROCESSUS.join(', ')}, et un service`, () => listeOuVide(x.m.processus).filter((p) => !TYPES_PROCESSUS.includes(p?.type) || typeof p?.service !== 'string').length, 0],
    [`consomme : un nom, type ${TYPES_CONSOMME.join(', ')}, via pour un service`, () => listeOuVide(x.m.consomme).filter((c) => typeof c?.nom !== 'string' || !TYPES_CONSOMME.includes(c?.type) || (c.type === 'service' && !VARIABLE.test(String(c.via ?? '')))).length, 0],
    ['bascule.env_file : chemin relatif', () => x.m.bascule === undefined || relatifSur(tableOuVide(x.m.bascule).env_file), true],
  ];
  if (x.depot && exp.contrat !== undefined) cas.push(['expose.contrat : le fichier existe', () => existsSync(join(x.depot, String(exp.contrat))), true]);
  if (x.git && exp.contrat !== undefined) cas.push(['expose.contrat : le fichier est versionné', () => versionne(x.depot, exp.contrat), true]);
  if (tableOuVide(x.m.instance).niveau === 'meta') {
    cas.push(
      ['au rang méta, le méta-projet expose le modèle', () => exp.contrat, basename(CHEMIN_MODELE)],
      ['que le consommateur lit par la variable du résolveur', () => [exp.variable_consommateur, SOURCE_RESOLVEUR.includes(`process.env.${exp.variable_consommateur}`)], ['MODELE_7E', true]],
    );
  }
  return cas;
}

function seuils(x) {
  const s = tableOuVide(x.m.seuils);
  const r = listeOuVide(x.m.retroaction);
  const requis = requisPour(x.m);
  const cas = [
    ['chaque seuil : { valeur: nombre, unite: texte }', () => Object.entries(s).filter(([, v]) => !estTable(v) || typeof v.valeur !== 'number' || !Number.isFinite(v.valeur) || typeof v.unite !== 'string' || !v.unite.trim()).map(([k]) => k), []],
    ['indicateurs en minuscules_soulignées', () => Object.keys(s).filter((k) => !/^[a-z][a-z0-9_]*$/.test(k)), []],
    ['« requis » est la liste du contrat, jamais un indicateur', () => Object.hasOwn(s, 'requis'), false],
    ['seuils requis présents (métriques applicables, revue)', () => requis.filter((i) => !Object.hasOwn(s, i)), []],
    ['periode_revue_cycles : un entier ≥ 1', () => Number.isInteger(s.periode_revue_cycles?.valeur) && s.periode_revue_cycles.valeur >= 1, true],
    ['rétroaction : des { indicateur, correction }', () => r.filter((e) => !estTable(e) || typeof e.indicateur !== 'string' || typeof e.correction !== 'string').length, 0],
    ['chaque règle vise un seuil déclaré', () => r.map((e) => e?.indicateur).filter((i) => !Object.hasOwn(s, i)), []],
    [`corrections permises : ${CORRECTIONS.join(', ')}`, () => r.map((e) => e?.correction).filter((c) => !CORRECTIONS.includes(c)), []],
    ['une seule règle par indicateur', () => r.length - new Set(r.map((e) => e?.indicateur)).size, 0],
    ['assertion EX.2 du modèle : seuils requis renseignés', () => jqEvaluer(assertion('EX.2', 'manifeste'), x.m, { m: x.m, requis }), true],
    ['assertion EQ.1 du modèle : chaque seuil a sa correction', () => jqEvaluer(assertion('EQ.1', 'manifeste'), x.m, { m: x.m, requis }), true],
  ];
  if (tableOuVide(x.m.instance).niveau === 'meta') {
    cas.push(['au rang méta, chaque indicateur d’observation du modèle a son seuil', () => Object.keys(M.observation_du_modele.indicateurs).filter((i) => !Object.hasOwn(s, i)), []]);
  }
  return cas;
}

function invariants(x) {
  const inv = listeOuVide(x.m.invariants);
  const sans = tableOuVide(x.m.sans_objet);
  const decl = tableOuVide(x.m.declarations);
  const ids = new Set(CRITERES.map(([id]) => id));
  const declarables = new Set(CRITERES.filter(([, c]) => c.controles.some((k) => k.type === 'declaration')).map(([id]) => id));
  return [
    ['invariants : une liste de textes', () => Array.isArray(x.m.invariants) && inv.every((i) => typeof i === 'string'), true],
    ['au moins axiome, cycle et contrats', () => ['axiome', 'cycle', 'contrats'].filter((i) => !inv.includes(i)), []],
    ['chaque invariant nomme un élément du modèle ou du manifeste', () => inv.filter((i) => !elementConnu(i, x.m)), []],
    ['assertion IN.1 du modèle', () => jqEvaluer(assertion('IN.1', 'manifeste'), x.m, { m: x.m, requis: requisPour(x.m) }), true],
    ['sans_objet : des critères du modèle', () => Object.keys(sans).filter((c) => !ids.has(c)), []],
    ['chaque critère sans objet est justifié (une phrase)', () => Object.entries(sans).filter(([, j]) => typeof j !== 'string' || j.trim().length < 10).map(([c]) => c), []],
    ['declarations : des critères à déclaration seulement', () => Object.keys(decl).filter((c) => !declarables.has(c)), []],
    [`réponses déclarées : ${REPONSES.join(', ')}`, () => Object.entries(decl).filter(([, d]) => !REPONSES.includes(d?.reponse)).map(([c]) => c), []],
    ['chaque déclaration cite sa preuve', () => Object.entries(decl).filter(([, d]) => !present(d?.preuve)).map(([c]) => c), []],
    ['aucun critère à la fois sans objet et déclaré', () => Object.keys(decl).filter((c) => Object.hasOwn(sans, c)), []],
  ];
}

/** Évaluer et « valider » sur le dépôt du manifeste (ou un dépôt jetable pour la fixture). */
function parLeResolveur(x, depot, cheminModele, cheminManifeste) {
  return [
    ['Évaluer : aucune erreur (modèle, manifeste, release, outils)', () => evaluer(new Contexte(depot, cheminModele, cheminManifeste)), []],
    ['seuils requis du résolveur = ceux de la recette', () => new Contexte(depot, cheminModele, cheminManifeste).requis, requisPour(x.m)],
    ['valider : code 0 et « Manifeste valide. »', () => {
      const c = avecEnv({ DEPOT_7E: depot, MODELE_7E: cheminModele, MANIFESTE_7E: cheminManifeste }, () => capturer(() => main(['valider'])));
      return [c.valeur, c.sortie.includes('Manifeste valide.')];
    }, [0, true]],
  ];
}

// ════════════════════════════════════════════════════════════════════════════
test('les manifestes du dépôt : celui du méta-projet, à la racine', (t) => table(t, [
  ['le méta-projet a son manifeste à la racine (amorçage, cycle 0)', () => DU_DEPOT.includes(join(RACINE, CONTRAT.fichier)), true],
  ['RECETTE_MANIFESTES : chaque chemin nommé existe', () => EXTERNES.filter((p) => !existsSync(p)), []],
]));

for (const x of MANIFESTES) {
  describe(`Manifeste ${x.nom}`, () => {
    test('1. Lecture', (t) => table(t, x.fixture ? lecture(x).filter(([l]) => !l.startsWith('encodage')) : lecture(x)));
    test('2. Identité', (t) => table(t, identite(x)));
    test('3. Environnements', (t) => table(t, environnements(x)));
    test('4. Release et services', (t) => table(t, services(x)));
    test('5. Seuils et rétroaction', (t) => table(t, seuils(x)));
    test('6. Invariants, sans objet, déclarations', (t) => table(t, invariants(x)));

    const version = String(tableOuVide(x.m.modele).version);
    const omis = x.fixture ? false
      : !x.git ? 'pas de dépôt Git ici : Évaluer lit la release dans Git'
        : version !== String(M.modele.version) ? `version épinglée ${version}, modèle du dépôt ${M.modele.version}` : false;
    test('7. Le résolveur l’accepte', { skip: omis }, (t) => (x.fixture
      ? avecDepot({ manifeste: manifesteMinimal() }, (d) => table(t, parLeResolveur(x, d.chemin, join(d.chemin, basename(CHEMIN_MODELE)), join(d.chemin, CONTRAT.fichier))))
      : table(t, parLeResolveur(x, x.depot, CHEMIN_MODELE, x.chemin))));
  });
}
