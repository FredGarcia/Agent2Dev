/**
 * Dépôts Git jetables et contextes de cycle pour les tests.
 *
 * Chaque test qui touche au dépôt examiné (fichiers versionnés, journal, release)
 * travaille sur son propre dépôt, créé dans le répertoire temporaire et détruit
 * à la fin : aucun test ne lit ni n'écrit le dépôt du méta-projet lui-même, sauf
 * les suites YAML, qui le lisent seulement.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';

import { after } from 'node:test';

import { Contexte } from '../../resolveur7e.mjs';

/** Racine du dépôt du méta-projet (deux niveaux au-dessus de tests/outils). */
export const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CHEMIN_MODELE = join(RACINE, 'modele-executif-12f-7e.yaml');
export const CHEMIN_MANIFESTE_META = join(RACINE, '7e-instance.yaml');

/** Le modèle réel, lu une fois. */
export const MODELE = parse(readFileSync(CHEMIN_MODELE, 'utf8'));

/** Identité Git neutre : aucun test ne dépend de la configuration de la machine. */
const GIT = [
  '-c', 'user.name=essai', '-c', 'user.email=essai@localhost',
  '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'init.defaultBranch=main',
  '-c', 'core.hooksPath=/dev/null',
];

/**
 * Le plus petit manifeste conforme au contrat, au niveau instance : les six
 * champs obligatoires (contrats.manifeste.obligatoires), les seuils que le
 * modèle exige d'une instance sans critère sans objet (EX.2 : métriques et
 * revue) et une correction pour chacun (EQ.1). test_manifeste_yaml.mjs le
 * recette comme un vrai manifeste, pour que les dépôts jetables restent des
 * instances valides.
 */
export function manifesteMinimal(surcharges = {}) {
  return {
    instance: { id: 'essai', nom: 'Essai', niveau: 'instance' },
    modele: { ref: MODELE.modele.id, version: String(MODELE.modele.version) },
    journal: 'journal',
    invariants: ['axiome', 'cycle', 'contrats'],
    seuils: {
      delai_commit_production_h: { valeur: 24, unite: 'h' },
      periode_revue_cycles: { valeur: 3, unite: 'cycles' },
      temps_demarrage_s: { valeur: 10, unite: 's' },
    },
    retroaction: [
      { indicateur: 'delai_commit_production_h', correction: 'ticket' },
      { indicateur: 'temps_demarrage_s', correction: 'ticket' },
    ],
    ...surcharges,
  };
}

/**
 * Crée un dépôt jetable.
 *   manifeste  objet (écrit en YAML), texte (écrit tel quel) ou null (aucun)
 *   fichiers   { 'chemin/relatif': contenu } écrits avant le commit
 *   modele     true : copie du modèle réel ; texte : modèle donné ; false : aucun
 *   commit     faire le commit initial (défaut : oui)
 *   tag        étiquette posée sur le commit initial
 */
export function depotJetable({ manifeste = manifesteMinimal(), fichiers = {}, modele = true, commit = true, tag } = {}) {
  const chemin = mkdtempSync(join(tmpdir(), 'r7e-depot-'));

  const git = (...args) => {
    const r = spawnSync('git', [...GIT, ...args], { cwd: chemin, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${args.join(' ')} : ${r.stderr.trim()}`);
    return r.stdout.trim();
  };
  const ecrire = (relatif, contenu) => {
    const cible = join(chemin, relatif);
    mkdirSync(dirname(cible), { recursive: true });
    writeFileSync(cible, contenu);
    return cible;
  };

  git('init', '-q', '-b', 'main');
  if (modele === true) ecrire('modele-executif-12f-7e.yaml', readFileSync(CHEMIN_MODELE, 'utf8'));
  else if (typeof modele === 'string') ecrire('modele-executif-12f-7e.yaml', modele);
  if (manifeste !== null) {
    ecrire('7e-instance.yaml', typeof manifeste === 'string' ? manifeste : stringify(manifeste));
  }
  for (const [relatif, contenu] of Object.entries(fichiers)) ecrire(relatif, contenu);
  if (commit) {
    git('add', '-A');
    git('commit', '-qm', 'essai');
    if (tag) git('tag', tag);
  }

  return {
    chemin,
    git,
    ecrire,
    lire: (relatif) => readFileSync(join(chemin, relatif), 'utf8'),
    supprimer: (relatif) => rmSync(join(chemin, relatif), { force: true }),
    /** Versionne tout et fait un commit ; rend le SHA court sur 12 caractères. */
    commit(message = 'suite') {
      git('add', '-A');
      git('commit', '-qm', message, '--allow-empty');
      return git('rev-parse', '--short=12', 'HEAD');
    },
    /** Remplace le manifeste (objet ou texte), sans commit. */
    manifeste(m) {
      ecrire('7e-instance.yaml', typeof m === 'string' ? m : stringify(m));
    },
    nettoyer: () => rmSync(chemin, { recursive: true, force: true }),
  };
}

/**
 * Un contexte de cycle sur un dépôt jetable : le modèle et le manifeste sont
 * ceux du dépôt. `avant` permet d'ajuster le contexte (numéro, release…).
 */
export function contexteSur(depot, avant) {
  const ctx = new Contexte(depot.chemin, join(depot.chemin, 'modele-executif-12f-7e.yaml'), join(depot.chemin, '7e-instance.yaml'));
  if (avant) avant(ctx);
  return ctx;
}

/**
 * Exécute fn avec un dépôt jetable, puis le détruit, même en cas d'échec.
 * fn peut être asynchrone.
 */
export function avecDepot(options, fn) {
  const depot = depotJetable(options);
  let r;
  try {
    r = fn(depot);
  } catch (e) {
    depot.nettoyer();
    throw e;
  }
  if (r && typeof r.then === 'function') return r.finally(() => depot.nettoyer());
  depot.nettoyer();
  return r;
}

/** Les critères du modèle réel, dans l'ordre : [id, critère, terme]. */
export function criteresDuModele(M = MODELE) {
  const liste = [];
  for (const t of M.termes) for (const c of t.criteres) liste.push([String(c.id), c, t.id]);
  for (const c of M.second_ordre.criteres) liste.push([String(c.id), c, 'second_ordre']);
  return liste;
}

/**
 * Un ticket d'essai exporté en MHTML : un cycle part toujours d'une demande
 * (modèle 0.5.0). Écrit hors de tout dépôt jetable, une fois par processus.
 */
export function ticketEssai(sujet = 'Ticket d’essai : demande de cycle') {
  const rep = mkdtempSync(join(tmpdir(), 'r7e-ticket-'));
  // retiré à la fin du fichier de tests qui l'a créé (le crochet racine de node:test)
  after(() => rmSync(rep, { recursive: true, force: true }));
  const chemin = join(rep, 'ticket.mhtml');
  writeFileSync(chemin, [
    'MIME-Version: 1.0', `Subject: =?utf-8?B?${Buffer.from(sujet, 'utf8').toString('base64')}?=`,
    'Content-Type: multipart/related; type="text/html"; boundary="----essai"', '',
    '------essai', 'Content-Type: text/html; charset="utf-8"', '',
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>${sujet}</title></head><body><p>${sujet}</p></body></html>`,
    '------essai--', '',
  ].join('\r\n'));
  return chemin;
}
export const TICKET = ticketEssai();
