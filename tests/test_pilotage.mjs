/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  test_pilotage.mjs : workflows, déclencheurs, demandes et exécuteur
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  L'interface reflète les workflows des deux projets et en déclenche quatre ;
 *  l'exécuteur exécute ce qu'elle demande, avec le socket Docker qu'elle n'a
 *  pas. Cette suite éprouve chaque garde de cette chaîne. Sept sections :
 *
 *     1. Catalogue          recette/workflows.yaml et la CI du dépôt : deux
 *                           projets, déclencheurs et étapes lus aux sources,
 *                           problèmes signalés sans lever
 *     2. Liste blanche      les quatre actions, leurs argv, la validation des
 *                           paramètres
 *     3. Exécuteur seul     secrets masqués, sortie bornée, copie du dépôt
 *     4. Base               invariants des demandes (la base est la dernière
 *                           garde, d'accord avec le code), documents chargés
 *     5. Demandes           déposer, annuler, arrêter ; files isolées
 *     6. Exécuteur en base  réclamer, exécuter, clore : réussite, échec, délai,
 *                           arrêt, orphelines, veille des campagnes,
 *                           rechargement au démarrage, service --une
 *     7. Interface          déclencher et suivre une demande, de bout en bout
 *     8. Validation finale  le bouton qui met une release en production (10.2) :
 *                           formulaire, base immuable, commande de lecture
 *
 *  Les sections 4 à 7 exigent la base (RECETTE_PG_URL) : sans elle, elles sont
 *  omises avec leur motif. Elles travaillent dans des files à elles
 *  (essai-<pid>-…) : jamais elles ne volent ni ne bloquent une vraie demande,
 *  ni l'exécuteur de la pile les leurs. Tout ce qu'elles créent est retiré.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { parse } from 'yaml';

import { enTransaction, fermer, joignable, migrer, ouvrir } from '../recette/base.mjs';
import { chargerDocuments, documentsDuDepot } from '../recette/documents.mjs';
import {
  CLE_DEMANDE, SORTIE_MAX, Sortie, cloreOrphelines, copierDepot, couperFin, executer, masquer, rechargerAuDemarrage, reclamer, secretsDe, servir,
  veilleurCampagnes,
} from '../recette/executeur.mjs';
import { CLE_CAMPAGNE, creerCampagne, main as lancer } from '../recette/lancer.mjs';
import {
  ACTIONS, DemandeRefusee, FILE_PRINCIPALE, TYPES_DECLENCHEUR, ValidationRefusee, annuler, arreter, catalogue, catalogueEnBase, declencheurs, deposer,
  derniereValidation, enregistrerValidation, lireWorkflowCi, validerDemande, validerValidation,
} from '../recette/pilotage.mjs';
import { creerApplication } from '../interface/serveur.mjs';
import { table } from './outils/etapes.mjs';
import { MODELE, RACINE } from './outils/depot.mjs';
import { trouve } from './outils/environnement.mjs';
import { defautsAccessibilite } from './outils/pages.mjs';
import { divergences } from './outils/yaml.mjs';

const lire = (relatif) => readFileSync(join(RACINE, relatif), 'utf8');
const TEXTE_CATALOGUE = lire('recette/workflows.yaml');
const CATALOGUE = parse(TEXTE_CATALOGUE);
const CI = { '.gitea/workflows/cycle-7e.yml': parse(lire('.gitea/workflows/cycle-7e.yml')) };
const CAT = catalogue({ workflows: CATALOGUE, ci: CI, modele: MODELE });
const projet = (id) => CAT.projets.find((p) => p.id === id);

/**
 * Le rechargement des tests : il compte les documents de la copie sans les
 * écrire. Un vrai rechargement remplacerait, au milieu d'une campagne, les
 * documents qu'elle a chargés (et que ses tests définis en base interrogent).
 */
const compterSansEcrire = async (_client, racine) => {
  const n = { modele: 0, manifeste: 0, journal: 0, workflows: 0, ci: 0 };
  for (const d of documentsDuDepot(racine)) n[d.nature] += 1;
  return n;
};

/** Aucune campagne vivante : la garde du rechargement laisse passer (avec compterSansEcrire). */
const aucuneCampagne = async () => null;

/** Vrai si le processus vit encore (un zombie, en attente d'être récolté, ne vit plus). */
const vivant = (pid) => {
  try { return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, 'utf8')); } catch { return false; }
};

/** Attend qu'une condition devienne vraie (sondage toutes les 200 ms) ; rend faux au délai. */
async function attendreQue(condition, delaiMs = 20_000) {
  const fin = Date.now() + delaiMs;
  while (Date.now() < fin) {
    if (await condition()) return true;
    await new Promise((ok) => setTimeout(ok, 200));
  }
  return false;
}

/**
 * Une file propre à ce processus : les vraies demandes n'y sont jamais. Le
 * suffixe tiré au hasard sépare deux recettes dont les pid se répètent (deux
 * conteneurs sur la même base).
 */
const PREFIXE = `essai-${process.pid}-${randomBytes(3).toString('hex')}`;
const file = (nom) => `${PREFIXE}-${nom}`;

// ── La base, si elle est là ──────────────────────────────────────────────────
let POOLS = null;
let SANS_BASE = 'RECETTE_PG_URL absente : à exécuter dans la VM de recette (ou avec une base locale)';
if (process.env.RECETTE_PG_URL) {
  try {
    POOLS = ouvrir({ nom: 'recette-7e-tests-pilotage' });
    SANS_BASE = (await joignable(POOLS.principal)) ? false : 'PostgreSQL injoignable à RECETTE_PG_URL';
    if (!SANS_BASE) await migrer(POOLS.principal);
  } catch (e) {
    SANS_BASE = `base inutilisable : ${e.message}`;
  }
}
after(async () => {
  if (!POOLS) return;
  if (!SANS_BASE) {
    await POOLS.principal.query('DELETE FROM pilotage.demande WHERE file LIKE $1', [`${PREFIXE}-%`]).catch(() => {});
    await POOLS.principal.query('DELETE FROM pilotage.executeur WHERE nom LIKE $1', [`${PREFIXE}-%`]).catch(() => {});
    await POOLS.principal.query('DELETE FROM pilotage.validation WHERE file LIKE $1', [`${PREFIXE}-%`]).catch(() => {});
  }
  await fermer(POOLS);
});

/** fn(client) dans une transaction toujours annulée. */
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

/** Le code d'erreur PostgreSQL d'une instruction qui doit échouer, dans un point de reprise. */
async function refus(c, sql, params = []) {
  await c.query('SAVEPOINT p');
  try {
    await c.query(sql, params);
    await c.query('RELEASE SAVEPOINT p');
    return 'acceptée';
  } catch (e) {
    await c.query('ROLLBACK TO SAVEPOINT p');
    return e.code ?? e.message;
  }
}

/** La classe et le code d'une promesse qui doit être refusée par le code. */
async function refusCode(promesse) {
  try {
    await promesse;
    return 'acceptée';
  } catch (e) {
    return e instanceof DemandeRefusee ? `DemandeRefusee ${e.code}` : e.message;
  }
}

// ════════════════════════════════════════════════════════════════════════════
describe('1. Catalogue : workflows des deux projets, lus à leurs sources', () => {
  test('le catalogue du dépôt : deux projets, sans problème', (t) => table(t, [
    ['aucun problème signalé', () => CAT.problemes, []],
    ['deux projets : le méta-projet, puis le binôme', () => CAT.projets.map((p) => [p.id, p.origine]), [['meta-12f-7e', 'depot'], ['binome', 'specification']]],
    ['le méta-projet : six workflows', () => projet('meta-12f-7e').workflows.map((w) => w.id), ['cycle-7e', 'ci-cycle-7e', 'valider', 'campagne', 'charger', 'preparer-vm']],
    ['le binôme : W00 à W11, W11 pour les personnes', () => projet('binome').workflows.map((w) => w.id), Array.from({ length: 12 }, (_, i) => `W${String(i).padStart(2, '0')}`)],
    ['chaque action se déclenche depuis l’interface, une seule fois', () => Object.keys(ACTIONS).map((a) => declencheurs(CAT).filter((d) => d.type === 'interface' && d.action === a).length), [1, 1, 1, 1]],
    ['la CI : déclencheurs lus dans son fichier', () => projet('meta-12f-7e').workflows.find((w) => w.id === 'ci-cycle-7e').declencheurs.map((d) => [d.type, d.detail]), [['poussee', 'sur main, hors journal/**'], ['manuel_forge', 'workflow_dispatch, depuis la forge ou son API']]],
    ['la CI : étapes lues dans son fichier', () => projet('meta-12f-7e').workflows.find((w) => w.id === 'ci-cycle-7e').etapes.map((e) => e.nom), CI['.gitea/workflows/cycle-7e.yml'].jobs.cycle.steps.map((p) => p.name ?? p.uses)],
    ['le cycle : les sept phases du modèle, avec porteur et garde', () => { const e = projet('meta-12f-7e').workflows.find((w) => w.id === 'cycle-7e').etapes; return [e.map((x) => x.phase), e.every((x) => x.porteur && x.garde)]; }, [MODELE.cycle.ordre, true]],
    ['lecture YAML 1.1 = lecture 1.2 (aucune clé n, on, off ni date nue)', () => divergences(CATALOGUE, parse(TEXTE_CATALOGUE, { version: '1.1' })).map((d) => d.chemin), []],
    ['binôme : dix décisions numérotées, statuts connus, toutes ratifiées, datées', () => { const d = projet('binome').decisions; return [d.map((x) => x.numero), d.every((x) => ['a_ratifier', 'ratifiee', 'autre_voie'].includes(x.statut)), d.filter((x) => x.statut === 'ratifiee' && /^\d{4}-\d{2}-\d{2}$/.test(x.ratifiee_le ?? '')).map((x) => x.numero)]; }, [[1, 2, 3, 4, 5, 6, 7, 8, 9, 10], true, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]]],
    ['binôme : la tâche peut attendre une personne ; six points humains', () => { const t2 = projet('binome').taches; return [t2.etats.some((e) => e.id === 'attente'), t2.transitions.filter((x) => x.de === 'attente' || x.vers === 'attente').length, t2.personnes]; }, [true, 2, ['ratifier', 'valider', 'arbitrer', 'session_sso', 'fusionner', 'auditer']]],
    ['binôme : transitions entre états connus, deux états finals', () => { const t2 = projet('binome').taches; const ids = new Set(t2.etats.map((e) => e.id)); return [t2.transitions.every((x) => ids.has(x.de) && ids.has(x.vers)), t2.etats.filter((e) => e.final).map((e) => e.id)]; }, [true, ['integree', 'escaladee']]],
    ['binôme : phases connues du modèle (ou le bouclage)', () => { const p = projet('binome'); const connues = new Set([...MODELE.cycle.ordre, 'bouclage']); return [...p.workflows.flatMap((w) => w.parPhase.map((x) => x.phase)), ...p.taches.natures.map((n) => n.phase)].filter((x) => !connues.has(x)); }, []],
  ]));

  test('catalogue : un défaut est signalé, jamais levé', (t) => {
    const avec = (workflows) => catalogue({ workflows: { version: 1, projets: [{ id: 'p', nom: 'P', workflows }] }, ci: {}, modele: MODELE });
    return table(t, [
      ['action inconnue', () => avec([{ id: 'w', declencheurs: [{ type: 'interface', action: 'rm' }] }]).problemes, ['p/w : action inconnue : rm']],
      ['type de déclencheur inconnu', () => avec([{ id: 'w', declencheurs: [{ type: 'magie' }] }]).problemes, ['p/w : type de déclencheur inconnu : magie']],
      ['déclencheur interface sans action', () => avec([{ id: 'w', declencheurs: [{ type: 'interface' }] }]).problemes, ['p/w : déclencheur interface sans action']],
      ['fichier de CI non chargé', () => avec([{ id: 'w', nature: 'ci', fichier: '.gitea/workflows/absent.yml' }]).problemes, ['p/w : .gitea/workflows/absent.yml n’est pas chargé']],
      ['workflow déclencheur inconnu', () => avec([{ id: 'w', declencheurs: [{ type: 'workflow', workflow: 'x' }] }]).problemes, ['p/w : workflow déclencheur inconnu : x']],
      ['catalogue absent : aucun projet, la marche à suivre', () => { const c = catalogue({}); return [c.projets, c.problemes.length]; }, [[], 1]],
      ['catalogue illisible : le message du chargeur', () => catalogue({ workflows: { erreur: 'YAML illisible : x' } }).problemes, ['recette/workflows.yaml illisible : YAML illisible : x']],
      ['CI : « on » en texte, en liste', () => [lireWorkflowCi({ on: 'push' }).declencheurs[0].type, lireWorkflowCi({ on: ['workflow_dispatch', 'pull_request'] }).declencheurs.map((d) => d.type)], ['poussee', ['manuel_forge', 'evenement']]],
      ['CI : planification, chemins, toute branche', () => lireWorkflowCi({ on: { schedule: [{ cron: '0 3 * * 1' }], push: { paths: ['src/**'] } } }).declencheurs.map((d) => d.detail), ['cron 0 3 * * 1', 'sur toute branche, touchant src/**']],
      ['CI : un pas sans nom prend son action', () => lireWorkflowCi({ jobs: { j: { steps: [{ uses: 'actions/checkout@v4' }, { run: 'x' }] } } }).etapes.map((e) => e.nom), ['actions/checkout@v4', 'pas 2']],
      ['chaque type de déclencheur a son libellé', () => Object.entries(TYPES_DECLENCHEUR).every(([k, v]) => k && v), true],
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('2. Liste blanche : quatre actions, des argv, jamais un shell', () => {
  test('actions et validation des paramètres', (t) => table(t, [
    ['quatre actions, celles de la base', () => Object.keys(ACTIONS), ['campagne', 'valider', 'cycle', 'charger']],
    ['chacune nommée, expliquée, bornée dans le temps', () => Object.values(ACTIONS).every((a) => a.nom && a.verbe && a.aide && a.delaiMin > 0), true],
    ['campagne : un libellé en « -- » reste un seul argument', () => ACTIONS.campagne.commande({ libelle: '--remplacer' }, { id: 7 }), ['recette/lancer.mjs', 'campagne', '--libelle=--remplacer', '--demande=7']],
    ['valider et cycle : le résolveur, sans option', () => [ACTIONS.valider.commande(), ACTIONS.cycle.commande()], [['resolveur7e.mjs', 'valider'], ['resolveur7e.mjs', 'cycle']]],
    ['charger : exécuté par l’exécuteur lui-même', () => ACTIONS.charger.commande, null],
    ['campagne : libellé obligatoire', () => validerDemande('campagne', { libelle: '   ' }).erreurs?.libelle, 'Le libellé de la campagne est obligatoire.'],
    ['campagne : 200 caractères au plus', () => validerDemande('campagne', { libelle: 'x'.repeat(201) }).erreurs?.libelle, 'Le libellé dépasse 200 caractères (201).'],
    ['campagne : aucun caractère de contrôle', () => Boolean(validerDemande('campagne', { libelle: 'a\nb' }).erreurs?.libelle), true],
    ['campagne : libellé nettoyé de ses espaces de bord', () => validerDemande('campagne', { libelle: '  après 0.3  ' }), { parametres: { libelle: 'après 0.3' } }],
    ['les autres actions : aucun paramètre, quoi qu’on envoie', () => ['valider', 'cycle', 'charger'].map((a) => validerDemande(a, { libelle: 'x' })), [{ parametres: {} }, { parametres: {} }, { parametres: {} }]],
    ['action inconnue : refusée', () => validerDemande('exec', {}).erreurs?.action, 'Action inconnue : exec.'],
    ['la file de l’interface', () => FILE_PRINCIPALE, 'principale'],
    ['le lanceur refuse un numéro de demande mal formé', async () => { const avant = process.stderr.write; process.stderr.write = () => true; try { return await lancer(['campagne', '--demande=abc']); } finally { process.stderr.write = avant; } }, 2],
  ]));
});

// ════════════════════════════════════════════════════════════════════════════
describe('3. Exécuteur sans base : secrets, sortie, copie du dépôt', () => {
  test('secrets masqués, sortie bornée, copie sans secrets', (t) => {
    const source = mkdtempSync(join(tmpdir(), 'r7e-source-'));
    const cible = join(mkdtempSync(join(tmpdir(), 'r7e-copie-')), 'copie');
    const modules = mkdtempSync(join(tmpdir(), 'r7e-modules-'));
    for (const [f, c] of [['README.md', 'x'], ['.env', 'S=1'], ['.env.recette', 'S=2'], ['node_modules/a/index.js', ''], ['.git/HEAD', 'ref: refs/heads/main'], ['sous/.env', 'garde']]) {
      mkdirSync(join(source, f, '..'), { recursive: true });
      writeFileSync(join(source, f), c);
    }
    const env = { RECETTE_PG_URL: 'postgres://recette:motdepasse-long-1@base/recette', ESSAI_MOT_DE_PASSE: 'secret-de-test-123', COURT_MOT_DE_PASSE: 'abc', AUTRE: 'visible' };
    try {
      return table(t, [
        ['secrets : URL et variables à mot de passe, plus longs d’abord', () => secretsDe(env), ['secret-de-test-123', 'motdepasse-long-1']],
        ['un secret court n’est pas masqué seul (il masquerait des mots)', () => secretsDe(env).includes('abc'), false],
        ['masqués dans la sortie', () => masquer('a motdepasse-long-1 b secret-de-test-123', secretsDe(env)), 'a *** b ***'],
        ['tout identifiant d’URL masqué, même inconnu', () => masquer('postgres://u:inconnu@h/b https://a:b@c', []), 'postgres://u:***@h/b https://a:***@c'],
        ['sortie : la fin seulement, signalée', () => { const s = new Sortie(); s.ajouter('x'.repeat(SORTIE_MAX * 3)); s.ajouter('FIN'); const v = s.valeur(); return [v.startsWith('[début de la sortie omis]\n'), v.endsWith('FIN'), v.length <= SORTIE_MAX + 40]; }, [true, true, true]],
        ['sortie : couleurs des terminaux retirées', () => { const s = new Sortie(); s.ajouter('\u001b[32mvert\u001b[0m'); return s.valeur(); }, 'vert'],
        ['coupe : la ligne entamée tombe', () => couperFin('début entamé\nligne gardée', 18), 'ligne gardée'],
        ['coupe au milieu d’un secret, sans fin de ligne : rien n’en reste', () => {
          const secret = 'secret-de-test-123456';
          const s = new Sortie([secret]);
          const avant = 'A'.repeat(SORTIE_MAX + 10);
          s.ajouter(`${avant}${secret}${'B'.repeat(SORTIE_MAX - 10)}`); // la coupe tombe dans le secret
          const v = s.valeur();
          return [v.includes(secret.slice(-8)), v.includes('***')];
        }, [false, true]],
        ['le masquage qui allonge ne fait pas dépasser la taille rangée', () => { const s = new Sortie([]); s.ajouter('a://b:c@\n'.repeat(20_000)); return s.valeur().length <= SORTIE_MAX + 40; }, true],
        ['copie : ni node_modules, ni .env, ni .env.recette à la racine', () => { copierDepot(source, cible, modules); return ['README.md', '.git/HEAD', '.env', '.env.recette', 'sous/.env'].map((f) => existsSync(join(cible, f))); }, [true, true, false, false, true]],
        ['copie : node_modules relié aux modules donnés', () => [lstatSync(join(cible, 'node_modules')).isSymbolicLink(), readlinkSync(join(cible, 'node_modules'))], [true, modules]],
        ['copie impossible : erreur claire', () => { try { copierDepot(join(source, 'absent'), join(cible, 'x'), null); return 'copiée'; } catch (e) { return e.message.startsWith('copie du dépôt impossible'); } }, true],
      ]);
    } finally {
      for (const r of [source, join(cible, '..'), modules]) rmSync(r, { recursive: true, force: true });
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('4. Base : les demandes gardées par la base, les documents chargés', { skip: SANS_BASE }, () => {
  test('invariants des demandes : la base refuse ce que le code refuse', async (t) => enEssai(async (c) => {
    const F = file('base');
    const ins = (action, parametres = {}, f = F) => refus(c, 'INSERT INTO pilotage.demande (file, action, parametres, demandeur) VALUES ($1, $2, $3::jsonb, $4)', [f, action, JSON.stringify(parametres), 'essai']);
    const valideEnBase = async (action, p) => (await c.query('SELECT pilotage.parametres_valides($1, $2::jsonb) AS v', [action, JSON.stringify(p)])).rows[0].v;
    const echantillons = [['campagne', { libelle: 'ok' }], ['campagne', {}], ['campagne', { libelle: '' }], ['campagne', { libelle: 'x'.repeat(201) }], ['campagne', { libelle: 'a\tb' }],
      ['campagne', { libelle: 'a', b: 1 }], ['campagne', { libelle: 3 }], ['valider', {}], ['valider', { libelle: 'x' }], ['cycle', {}], ['charger', {}]];
    return table(t, [
      ['action hors liste blanche', () => ins('exec'), '23514'],
      ['campagne sans libellé', () => ins('campagne'), '23514'],
      ['libellé avec un retour à la ligne', () => ins('campagne', { libelle: 'a\nb' }), '23514'],
      ['paramètre de trop', () => ins('campagne', { libelle: 'a', x: 1 }), '23514'],
      ['valider avec un paramètre', () => ins('valider', { a: 1 }), '23514'],
      ['file mal nommée', () => ins('valider', {}, 'File Principale'), '23514'],
      ['une demande valide', () => ins('campagne', { libelle: 'essai' }), 'acceptée'],
      ['une seconde, même action, même file : refusée', () => ins('campagne', { libelle: 'essai 2' }), '23505'],
      ['la même action dans une autre file : acceptée', () => ins('campagne', { libelle: 'essai' }, file('base-b')), 'acceptée'],
      ['en cours sans début', () => refus(c, "UPDATE pilotage.demande SET statut = 'en_cours' WHERE file = $1", [F]), '23514'],
      ['annulée avec un début', () => refus(c, "UPDATE pilotage.demande SET statut = 'annulee', debut = now(), fin = now() WHERE file = $1", [F]), '23514'],
      ['arrêt demandé avant le début', () => refus(c, 'UPDATE pilotage.demande SET arret_le = now() WHERE file = $1', [F]), '23514'],
      // Ce que le code accepte, il l'envoie normalisé : la base doit l'accepter ;
      // ce qu'il refuse, la base le refuse aussi tel quel
      ['code et base d’accord sur chaque échantillon', async () => {
        const ecarts = [];
        for (const [a, p] of echantillons) {
          const v = validerDemande(a, p);
          if (v.erreurs) { if (await valideEnBase(a, p)) ecarts.push(`code refuse, base accepte : ${a} ${JSON.stringify(p)}`); } else if (!(await valideEnBase(a, v.parametres))) ecarts.push(`code accepte, base refuse : ${a} ${JSON.stringify(v.parametres)}`);
        }
        return ecarts;
      }, []],
    ]);
  }));

  test('documents : le catalogue et la CI chargés, nature contrôlée', async (t) => enEssai(async (c) => table(t, [
    ['chargés avec le modèle, les manifestes et le journal', async () => { const n = await chargerDocuments(c, RACINE, null); return [n.modele, n.workflows, n.ci >= 1]; }, [1, 1, true]],
    ['lus en base : le même catalogue, sans problème', async () => { const cat = await catalogueEnBase(c); return [cat.problemes, cat.projets.map((p) => p.id), Boolean(cat.charge)]; }, [[], ['meta-12f-7e', 'binome'], true]],
    ['nature inconnue refusée', () => refus(c, "INSERT INTO donnees.document (nature, chemin, contenu, empreinte) VALUES ('autre', 'x.yaml', '{}', 'x')"), '23514'],
    ['le rôle de lecture lit les demandes', async () => (POOLS.lectureDediee ? (await POOLS.lecture.query('SELECT count(*) >= 0 AS ok FROM pilotage.demande')).rows[0].ok : true), true],
    ['le rôle de lecture n’y écrit pas', async () => { if (!POOLS.lectureDediee) return 'refusé'; try { await POOLS.lecture.query("INSERT INTO pilotage.demande (file, action, demandeur) VALUES ('essai-lecture', 'valider', 'x')"); return 'écrit'; } catch { return 'refusé'; } }, 'refusé'],
  ])));
});

// ════════════════════════════════════════════════════════════════════════════
describe('5. Demandes : déposer, annuler, arrêter', { skip: SANS_BASE }, () => {
  test('cycle de vie d’une demande, files isolées', async (t) => {
    const F = file('vie');
    const db = POOLS.principal;
    let d;
    return table(t, [
      ['déposée : en attente, sans début', async () => { d = await deposer(db, { action: 'valider', demandeur: 'essai', file: F }); return [d.statut, d.debut, d.parametres]; }, ['en_attente', null, {}]],
      ['une seconde : refusée, la première citée', async () => { try { await deposer(db, { action: 'valider', demandeur: 'essai', file: F }); return 'acceptée'; } catch (e) { return [e instanceof DemandeRefusee, e.code, e.existante?.id === d.id]; } }, [true, 409, true]],
      ['arrêter une demande en attente : refusé', () => refusCode(arreter(db, d.id, { file: F })), 'DemandeRefusee 409'],
      ['annuler depuis une autre file : introuvable', () => refusCode(annuler(db, d.id, { file: file('autre') })), 'DemandeRefusee 404'],
      ['annulée : statut et fin', async () => { const a = await annuler(db, d.id, { file: F }); return [a.statut, Boolean(a.fin), a.debut]; }, ['annulee', true, null]],
      ['annuler de nouveau : refusé, avec la raison', async () => { try { await annuler(db, d.id, { file: F }); return 'acceptée'; } catch (e) { return [e.code, e.message.includes('n’est plus en attente')]; } }, [409, true]],
      ['une demande inconnue : 404', () => refusCode(annuler(db, 999_999_999, { file: F })), 'DemandeRefusee 404'],
      ['après l’annulation, une nouvelle demande est permise', async () => (await deposer(db, { action: 'valider', demandeur: 'essai', file: F })).statut, 'en_attente'],
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('6. Exécuteur en base : réclamer, exécuter, clore', { skip: SANS_BASE }, () => {
  const executable = ['sh', 'git', 'jq', 'grep'].every(trouve);

  test('réclamer : une seule fois, sous verrou ; orphelines closes', async (t) => {
    const F = file('verrou');
    const db = POOLS.principal;
    let pris = null;
    try {
      return await table(t, [
        ['file vide : rien à réclamer', () => reclamer(db, { nom: `${PREFIXE}-a`, file: F }), null],
        ['deux réclamations simultanées : une seule l’obtient', async () => {
          await deposer(db, { action: 'charger', demandeur: 'essai', file: F });
          const r = await Promise.all([reclamer(db, { nom: `${PREFIXE}-a`, file: F }), reclamer(db, { nom: `${PREFIXE}-b`, file: F })]);
          pris = r.find(Boolean);
          return [r.filter(Boolean).length, pris.demande.statut, Boolean(pris.demande.debut)];
        }, [1, 'en_cours', true]],
        ['tenue sous verrou : jamais prise pour orpheline', () => cloreOrphelines(db, { file: F }), []],
        ['sans verrou tenu (exécuteur tué) : close comme interrompue', async () => {
          const { rows: [o] } = await db.query("INSERT INTO pilotage.demande (file, action, demandeur, statut, debut, executeur) VALUES ($1, 'valider', 'essai', 'en_cours', now(), 'fantôme') RETURNING id", [F]);
          const closes = await cloreOrphelines(db, { file: F });
          const { rows: [x] } = await db.query('SELECT statut, sortie FROM pilotage.demande WHERE id = $1', [o.id]);
          return [closes.length === 1 && closes[0] === o.id, x.statut, x.sortie.includes('arrêté sans clore')];
        }, [true, 'interrompue', true]],
      ]);
    } finally {
      if (pris) { await db.query('SELECT pg_advisory_unlock($1, $2::int)', [CLE_DEMANDE, pris.demande.id]).catch(() => {}); pris.verrou.release(); }
    }
  });

  test('exécuter : réussite, échec, délai, arrêt, secrets', { timeout: 180_000 }, async (t) => {
    const F = file('exec');
    const db = POOLS.principal;
    /** Dépose, réclame et exécute une demande ; rend la demande close. */
    const passer = async (action, options = {}, parametres = {}) => {
      const d = await deposer(db, { action, parametres, demandeur: 'essai', file: F });
      const pris = await reclamer(db, { nom: `${PREFIXE}-exec`, file: F });
      assert.equal(pris.demande.id, d.id);
      return executer(POOLS, pris, { source: RACINE, chargeur: compterSansEcrire, garde: aucuneCampagne, ...options });
    };
    return table(t, [
      ['charger : réussie, les documents de la copie', async () => { const d = await passer('charger'); return [d.statut, d.code_retour, d.resultat.documents.workflows, d.resultat.documents.modele]; }, ['reussie', 0, 1, 1]],
      ['valider : le vrai résolveur sur une copie du dépôt', async () => { const d = await passer('valider'); return [d.statut, executable ? d.resultat?.conclusion : d.resultat?.conclusion?.startsWith('Refus')]; }, executable ? ['reussie', 'Manifeste valide.'] : ['echouee', true]],
      ['échec : le code de la commande', async () => { const d = await passer('cycle', { commandes: { cycle: ['-e', 'console.log("essai"); process.exit(3)'] } }); return [d.statut, d.code_retour, d.sortie.includes('essai'), d.resultat]; }, ['echouee', 3, true, { entree: null }]],
      ['délai dépassé : interrompue, et dit pourquoi', async () => { const d = await passer('cycle', { commandes: { cycle: ['-e', 'setTimeout(() => {}, 60000)'] }, delaiMs: 1200 }); return [d.statut, d.sortie.includes('délai de l’action dépassé')]; }, ['interrompue', true]],
      ['arrêt demandé : interrompue en quelques secondes', async () => {
        const d = await deposer(db, { action: 'cycle', demandeur: 'essai', file: F });
        const pris = await reclamer(db, { nom: `${PREFIXE}-exec`, file: F });
        setTimeout(() => arreter(db, d.id, { file: F }).catch(() => {}), 500);
        const debut = Date.now();
        const close = await executer(POOLS, pris, { source: RACINE, commandes: { cycle: ['-e', 'setTimeout(() => {}, 60000)'] } });
        return [close.statut, Boolean(close.arret_le), Date.now() - debut < 20_000];
      }, ['interrompue', true, true]],
      ['secrets de l’environnement masqués dans la sortie', async () => {
        process.env.ESSAI_MOT_DE_PASSE = 'secret-de-test-123456';
        try {
          const d = await passer('valider', { commandes: { valider: ['-e', 'console.log(process.env.ESSAI_MOT_DE_PASSE, process.env.RECETTE_PG_URL)'] } });
          return [d.sortie.includes('secret-de-test-123456'), d.sortie.includes('***'), /:\/\/[^:\s]+:[^*\s][^@\s]*@/.test(d.sortie)];
        } finally { delete process.env.ESSAI_MOT_DE_PASSE; }
      }, [false, true, false]],
      ['campagne : sans campagne ouverte, le résultat le dit', async () => (await passer('campagne', { commandes: { campagne: ['-e', 'process.exit(0)'] } }, { libelle: 'essai' })).resultat, { campagne: null }],
      ['la configuration du résolveur ne passe pas aux commandes', async () => {
        process.env.DEPOT_7E = '/ailleurs';
        try { return (await passer('valider', { commandes: { valider: ['-e', 'console.log("DEPOT_7E=" + (process.env.DEPOT_7E ?? "absent"))'] } })).sortie.includes('DEPOT_7E=absent'); } finally { delete process.env.DEPOT_7E; }
      }, true],
    ]);
  });

  test('gardes : campagne vivante, descendant détaché, écoute perdue', { timeout: 90_000 }, async (t) => {
    const F = file('gardes');
    const db = POOLS.principal;
    return table(t, [
      ['recharger pendant une campagne vivante : refusé, la campagne citée', async () => {
        const id = -2_000_000 - (process.pid % 100_000);
        const verrou = await db.connect();
        try {
          // Créée sous son verrou, comme le fait le lanceur
          await creerCampagne(verrou, { libelle: 'campagne vivante simulée', ctx: {}, id });
          await deposer(db, { action: 'charger', demandeur: 'essai', file: F });
          const pris = await reclamer(db, { nom: `${PREFIXE}-gardes`, file: F });
          const d = await executer(POOLS, pris, { source: RACINE, chargeur: compterSansEcrire });
          return [d.statut, d.resultat?.refus, typeof d.resultat?.campagne, d.sortie.includes('Rechargement refusé')];
        } finally {
          await verrou.query('SELECT pg_advisory_unlock($1, $2::int)', [CLE_CAMPAGNE, id]).catch(() => {});
          verrou.release();
          await db.query('DELETE FROM recette.campagne WHERE id = $1', [id]);
        }
      }, ['echouee', 'campagne en cours', 'number', true]],
      ['le meneur sorti, ce qui reste de son groupe est arrêté', async () => {
        await deposer(db, { action: 'cycle', demandeur: 'essai', file: F });
        const pris = await reclamer(db, { nom: `${PREFIXE}-gardes`, file: F });
        const d = await executer(POOLS, pris, { source: RACINE, commandes: { cycle: ['-e', "const c = require('node:child_process').spawn('sleep', ['30'], { stdio: 'ignore' }); c.unref(); console.log('reste ' + c.pid)"] }, delaiMs: 60_000 });
        const pid = Number(/reste (\d+)/.exec(d.sortie)?.[1]);
        return [d.statut, pid > 0, await attendreQue(async () => !vivant(pid), 4000)];
      }, ['reussie', true, true]],
      ['arrêt demandé : le meneur tombe, le reste de son groupe aussi', async () => {
        const dem = await deposer(db, { action: 'cycle', demandeur: 'essai', file: F });
        const pris = await reclamer(db, { nom: `${PREFIXE}-gardes`, file: F });
        setTimeout(() => arreter(db, dem.id, { file: F }).catch(() => {}), 800);
        const d = await executer(POOLS, pris, { source: RACINE, commandes: { cycle: ['-e', "const c = require('node:child_process').spawn('sleep', ['30'], { stdio: 'ignore' }); c.unref(); console.log('reste ' + c.pid); setTimeout(() => {}, 60000)"] }, delaiMs: 60_000 });
        const pid = Number(/reste (\d+)/.exec(d.sortie)?.[1]);
        return [d.statut, pid > 0, await attendreQue(async () => !vivant(pid), 4000)];
      }, ['interrompue', true, true]],
      ['un descendant détaché qui garde la sortie : la demande se clôt quand même', async () => {
        await deposer(db, { action: 'cycle', demandeur: 'essai', file: F });
        const pris = await reclamer(db, { nom: `${PREFIXE}-gardes`, file: F });
        const debut = Date.now();
        const d = await executer(POOLS, pris, { source: RACINE, commandes: { cycle: ['-e', "require('node:child_process').spawn('sleep', ['8'], { stdio: ['ignore', 'inherit', 'inherit'], detached: true }).unref(); console.log('meneur fini')"] }, delaiMs: 60_000 });
        return [d.statut, d.code_retour, d.sortie.includes('meneur fini'), Date.now() - debut < 7000];
      }, ['reussie', 0, true, true]],
      ['écoute perdue : le service continue et traite par sondage ; données rechargées au démarrage', async () => {
        const ac = new AbortController();
        const nom = `${PREFIXE}-ecoute`;
        const fe = file('ecoute');
        const ecoutes = "SELECT pid FROM pg_stat_activity WHERE query = 'LISTEN pilotage_demande' AND application_name = 'recette-7e-tests-pilotage' AND usename = current_user";
        const copies = [];
        const chargeur = async (client, racine) => { copies.push(basename(racine)); return compterSansEcrire(client, racine); };
        const service = servir(POOLS, { nom, file: fe, signal: ac.signal, source: RACINE, chargeur, garde: aucuneCampagne });
        try {
          const ecoute = await attendreQue(async () => (await db.query(ecoutes)).rows.length > 0);
          const { rows } = await db.query(`SELECT pg_terminate_backend(pid) AS fait FROM (${ecoutes}) e`);
          const d = await deposer(db, { action: 'charger', demandeur: 'essai', file: fe });
          const traitee = await attendreQue(async () => (await db.query('SELECT statut FROM pilotage.demande WHERE id = $1', [d.id])).rows[0].statut === 'reussie');
          const reprise = await attendreQue(async () => (await db.query(ecoutes)).rows.length > 0, 8000);
          return [ecoute, rows.every((r) => r.fait), traitee, reprise, copies[0]?.startsWith('demarrage-')];
        } finally {
          ac.abort();
          await service;
        }
      }, [true, true, true, true, true]],
    ]);
  });

  test('veille des campagnes : orpheline vue deux fois, close ; tenue, jamais', async (t) => {
    const db = POOLS.principal;
    const orpheline = -3_000_000 - (process.pid % 100_000) * 2;
    const tenue = orpheline - 1;
    const etat = async (id) => (await db.query("SELECT statut, totaux->>'erreur' AS motif FROM recette.campagne WHERE id = $1", [id])).rows[0];
    await db.query('DELETE FROM recette.campagne WHERE id = ANY($1::bigint[])', [[orpheline, tenue]]);
    const mort = await db.connect();
    const tenant = await db.connect();
    try {
      // Deux campagnes nées sous leur verrou ; le lanceur de la première meurt
      await creerCampagne(mort, { libelle: 'orpheline simulée', ctx: {}, id: orpheline });
      await creerCampagne(tenant, { libelle: 'campagne tenue', ctx: {}, id: tenue });
      await mort.query('SELECT pg_advisory_unlock($1, $2::int)', [CLE_CAMPAGNE, orpheline]);
      // La veille bornée à ces deux campagnes : celles des autres essais ne la concernent pas
      const veiller = veilleurCampagnes(db, { ids: [orpheline, tenue] });
      return await table(t, [
        ['première ronde : vue sans lanceur, pas encore close', () => veiller(), []],
        ['toujours en cours', async () => (await etat(orpheline)).statut, 'en_cours'],
        ['seconde ronde : close comme interrompue', () => veiller(), [orpheline]],
        ['statut et motif', () => etat(orpheline), { statut: 'interrompue', motif: 'lanceur arrêté sans clore la campagne' }],
        ['la campagne tenue ne l’est jamais', async () => { await veiller(); return (await etat(tenue)).statut; }, 'en_cours'],
        ['relâchée, elle l’est à son tour, deux rondes plus tard', async () => {
          await tenant.query('SELECT pg_advisory_unlock($1, $2::int)', [CLE_CAMPAGNE, tenue]);
          return [await veiller(), await veiller()];
        }, [[], [tenue]]],
      ]);
    } finally {
      for (const [c, id] of [[mort, orpheline], [tenant, tenue]]) {
        await c.query('SELECT pg_advisory_unlock($1, $2::int)', [CLE_CAMPAGNE, id]).catch(() => {});
        c.release();
      }
      await db.query('DELETE FROM recette.campagne WHERE id = ANY($1::bigint[])', [[orpheline, tenue]]);
    }
  });

  test('au démarrage : les données du dépôt rechargées, sauf pendant une campagne', async (t) => {
    const db = POOLS.principal;
    const copies = [];
    const espion = async (client, racine) => { copies.push(racine); return compterSansEcrire(client, racine); };
    return table(t, [
      ['sans campagne : rechargées depuis une copie du dépôt', async () => {
        const n = await rechargerAuDemarrage(db, { source: RACINE, chargeur: espion, garde: aucuneCampagne });
        return [n.modele, n.workflows, copies.length, copies[0] !== RACINE && basename(copies[0]).startsWith('demarrage-')];
      }, [1, 1, 1, true]],
      ['la copie retirée ensuite', () => existsSync(copies[0]), false],
      ['une campagne en cours : laissées telles quelles', async () => [await rechargerAuDemarrage(db, { source: RACINE, chargeur: espion, garde: async () => 42 }), copies.length], [null, 1]],
      ['un rechargement qui échoue : signalé, sans lever', () => rechargerAuDemarrage(db, { source: RACINE, chargeur: async () => { throw new Error('base en panne'); }, garde: aucuneCampagne }), null],
    ]);
  });

  test('servir --une : une demande, puis rien ; signe de vie', { timeout: 60_000 }, async (t) => {
    const F = file('service');
    const nom = `${PREFIXE}-service`;
    const db = POOLS.principal;
    return table(t, [
      ['une demande en attente : traitée', async () => { await deposer(db, { action: 'charger', demandeur: 'essai', file: F }); return servir(POOLS, { nom, file: F, une: true, source: RACINE, chargeur: compterSansEcrire, garde: aucuneCampagne }); }, 1],
      ['close comme réussie', async () => (await db.query('SELECT statut FROM pilotage.demande WHERE file = $1', [F])).rows.map((r) => r.statut), ['reussie']],
      ['file vide : rien', () => servir(POOLS, { nom, file: F, une: true, source: RACINE, chargeur: compterSansEcrire, garde: aucuneCampagne }), 0],
      ['signe de vie : sa file, récent, aucune demande en cours', async () => { const { rows: [e] } = await db.query('SELECT file, actif, demande_id FROM pilotage.v_executeur WHERE nom = $1', [nom]); return e; }, { file: F, actif: true, demande_id: null }],
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('7. Interface : déclencher et suivre une demande', { skip: SANS_BASE }, () => {
  const F = file('interface');
  const csrf = 'jeton-pilotage-0123456789abcdef';
  let serveur;
  let base;
  before(async () => {
    const { createServer } = await import('node:http');
    serveur = createServer(creerApplication({ principal: POOLS.principal, lecture: POOLS.lecture, csrf, file: F }));
    await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
    base = `http://127.0.0.1:${serveur.address().port}`;
  });
  after(() => new Promise((ok) => (serveur ? serveur.close(ok) : ok())));
  const lirePage = async (chemin, options = {}) => { const r = await fetch(base + chemin, { redirect: 'manual', ...options }); return { code: r.status, texte: await r.text(), lieu: r.headers.get('location') }; };
  const poster = (chemin, champs) => lirePage(chemin, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...champs }).toString() });

  test('pages du pilotage : réponse et structure accessible', async (t) => {
    const { rows: [cat] } = await POOLS.principal.query("SELECT count(*) > 0 AS charge FROM donnees.document WHERE nature = 'workflows'");
    const { rows: [cycle] } = await POOLS.principal.query('SELECT instance, numero FROM donnees.entree ORDER BY numero LIMIT 1');
    const pages = ['/workflows', '/declencheurs', '/suivi', '/suivi/demandes', '/',
      ...(cat.charge ? ['/workflows/meta-12f-7e/cycle-7e', '/workflows/meta-12f-7e/ci-cycle-7e', '/workflows/meta-12f-7e/campagne', '/workflows/binome/W02', '/workflows/binome/W00'] : []),
      ...(cycle ? [`/suivi/cycles/${cycle.instance}/${cycle.numero}`] : [])];
    const resultats = {};
    for (const p of pages) { const r = await lirePage(p); resultats[p] = { code: r.code, defauts: defautsAccessibilite(r.texte) }; }
    return table(t, [
      ['toutes en 200', () => Object.entries(resultats).filter(([, r]) => r.code !== 200).map(([p, r]) => `${p} : ${r.code}`), []],
      ['aucun défaut structurel d’accessibilité', () => Object.entries(resultats).flatMap(([p, r]) => r.defauts.map((d) => `${p} : ${d}`)), []],
      ['workflow inconnu : 404', async () => (await lirePage('/workflows/meta-12f-7e/inconnu')).code, 404],
      ['cycle absent du journal : 404', async () => (await lirePage('/suivi/cycles/meta-12f-7e/999999')).code, 404],
    ]);
  });

  test('déposer, suivre, voir exécuter, refuser ce qui ne se fait plus', { timeout: 60_000 }, async (t) => {
    let id;
    return table(t, [
      ['campagne sans libellé : 422, l’erreur reliée au champ', async () => { const r = await poster('/declencheurs/campagne', { libelle: '' }); return [r.code, r.texte.includes('href="#action-campagne-libelle"'), r.texte.includes('aria-invalid="true"')]; }, [422, true, true]],
      ['action inconnue : 404', async () => (await poster('/declencheurs/supprimer', {})).code, 404],
      ['recharger : déposée, vers son suivi', async () => { const r = await poster('/declencheurs/charger', {}); id = Number(/\/suivi\/demandes\/(\d+)\?fait=demande-deposee$/.exec(r.lieu ?? '')?.[1]); return [r.code, Number.isInteger(id)]; }, [303, true]],
      ['une seconde : 409, avec la raison en alerte', async () => { const r = await poster('/declencheurs/charger', {}); return [r.code, /role="alert"><p>Une demande « Recharger les données du dépôt » est déjà en attente/.test(r.texte)]; }, [409, true]],
      ['le bouton de l’action est désactivé, la demande citée', async () => { const r = await lirePage('/declencheurs'); return /<button type="submit" aria-describedby="action-charger-aide action-charger-occupee" disabled>/.test(r.texte); }, true],
      ['son suivi : en attente, suivi automatique proposé', async () => { const r = await lirePage(`/suivi/demandes/${id}`); return [r.code, r.texte.includes('statut-en_attente'), r.texte.includes(`href="/suivi/demandes/${id}?suivre=1"`), r.texte.includes('http-equiv="refresh"')]; }, [200, true, true, false]],
      ['suivi automatique : rechargement et lien d’arrêt', async () => { const r = await lirePage(`/suivi/demandes/${id}?suivre=1`); return [r.texte.includes('<meta http-equiv="refresh" content="10">'), r.texte.includes('Arrêter le suivi automatique')]; }, [true, true]],
      ['l’exécuteur la traite', async () => { const pris = await reclamer(POOLS.principal, { nom: `${PREFIXE}-interface`, file: F }); return (await executer(POOLS, pris, { source: RACINE, chargeur: compterSansEcrire, garde: aucuneCampagne })).statut; }, 'reussie'],
      ['finie : plus de rechargement, même demandé ; le résultat', async () => { const r = await lirePage(`/suivi/demandes/${id}?suivre=1`); return [r.texte.includes('statut-reussie'), r.texte.includes('http-equiv="refresh"'), r.texte.includes('Catalogue des workflows')]; }, [true, false, true]],
      ['annuler une demande finie : 409, avec la raison', async () => { const r = await poster(`/suivi/demandes/${id}/annuler`, {}); return [r.code, r.texte.includes('n’est plus en attente')]; }, [409, true]],
      ['arrêter une demande inconnue : 404', async () => (await poster('/suivi/demandes/999999999/arreter', {})).code, 404],
      ['une campagne demandée puis annulée', async () => {
        const r = await poster('/declencheurs/campagne', { libelle: 'essai de l’interface' });
        const n = Number(/\/suivi\/demandes\/(\d+)/.exec(r.lieu ?? '')?.[1]);
        const a = await poster(`/suivi/demandes/${n}/annuler`, {});
        const { rows: [x] } = await POOLS.principal.query('SELECT statut, parametres, demandeur FROM pilotage.demande WHERE id = $1', [n]);
        return [r.code, a.code, x];
      }, [303, 303, { statut: 'annulee', parametres: { libelle: 'essai de l’interface' }, demandeur: 'interface' }]],
      ['une demande d’une autre file : introuvable ici', async () => { const d = await deposer(POOLS.principal, { action: 'valider', demandeur: 'essai', file: file('ailleurs') }); return (await lirePage(`/suivi/demandes/${d.id}`)).code; }, 404],
      ['formulaire sans jeton : refusé', async () => (await lirePage('/declencheurs/valider', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: '' })).code, 403],
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
//  8. VALIDATION FINALE (mesure 10.2, modèle 0.5.0)
//  Une personne valide une release : elle est en production, et le délai
//  commit → production de 10.2 s'arrête là. Une release ne se valide qu'une
//  fois par file ; une validation de la file principale ne change plus.
// ════════════════════════════════════════════════════════════════════════════
describe('8. Validation finale : le bouton, la base, la commande', () => {
  test('formulaire : mêmes règles que la base', (t) => table(t, [
    ['un tag, confirmé', () => validerValidation({ release: ' v0.5.0 ', commentaire: '', confirmation: '1' }), { valeurs: { release: 'v0.5.0', commentaire: null } }],
    ['un commit, un commentaire', () => validerValidation({ release: '62c18ecf0d77', commentaire: ' recette verte ', confirmation: '1' }), { valeurs: { release: '62c18ecf0d77', commentaire: 'recette verte' } }],
    ['sans confirmation : refusée (irréversible)', () => Object.keys(validerValidation({ release: 'v1' }).erreurs), ['confirmation']],
    ['release vide', () => Object.keys(validerValidation({ release: '', confirmation: '1' }).erreurs), ['release']],
    ['« .. » ou espace refusés', () => [validerValidation({ release: 'v0..5', confirmation: '1' }).erreurs?.release !== undefined, validerValidation({ release: 'v 0.5', confirmation: '1' }).erreurs?.release !== undefined], [true, true]],
    ['commentaire trop long ou avec retour à la ligne', () => [Object.keys(validerValidation({ release: 'v1', commentaire: 'x'.repeat(501), confirmation: '1' }).erreurs), Object.keys(validerValidation({ release: 'v1', commentaire: 'a\nb', confirmation: '1' }).erreurs)], [['commentaire'], ['commentaire']]],
  ]));

  test('base : une fois par release et par file, immuable en file principale', { skip: SANS_BASE }, async (t) => {
    const F = file('validation');
    return table(t, [
      ['enregistrée, puis lue comme la dernière', async () => { await enregistrerValidation(POOLS.principal, { release: 'v9.9.8', validePar: 'essai', file: F }); await enregistrerValidation(POOLS.principal, { release: 'v9.9.9', validePar: 'essai', file: F }); return (await derniereValidation(POOLS.principal, { file: F })).release; }, 'v9.9.9'],
      ['la même release une seconde fois : refusée', async () => { try { await enregistrerValidation(POOLS.principal, { release: 'v9.9.9', validePar: 'essai', file: F }); return null; } catch (e) { return [e instanceof ValidationRefusee, e.code]; } }, [true, 409]],
      ['la base refuse une release mal formée', async () => { try { await enregistrerValidation(POOLS.principal, { release: '../x', validePar: 'essai', file: F }); return null; } catch (e) { return [e instanceof ValidationRefusee, e.code]; } }, [true, 422]],
      ['file principale : ni modifiée ni supprimée', async () => enEssai(async (c) => {
        await c.query("INSERT INTO pilotage.validation (file, release, valide_par) VALUES ('principale', 'essai-immuable', 'essai')");
        await c.query('SAVEPOINT a');
        const maj = await c.query("UPDATE pilotage.validation SET valide_par = 'autre' WHERE release = 'essai-immuable'").then(() => 'permis', (e) => (/jamais modifiée/.test(e.message) ? 'refusé' : e.message));
        await c.query('ROLLBACK TO SAVEPOINT a');
        const sup = await c.query("DELETE FROM pilotage.validation WHERE release = 'essai-immuable'").then(() => 'permis', (e) => (/jamais modifiée/.test(e.message) ? 'refusé' : e.message));
        await c.query('ROLLBACK TO SAVEPOINT a');
        const vid = await c.query('TRUNCATE pilotage.validation').then(() => 'permis', (e) => (/TRUNCATE refusé/.test(e.message) ? 'refusé' : e.message));
        return [maj, sup, vid];
      }), ['refusé', 'refusé', 'refusé']],
      ['commande : --release et --date ensemble, erreur d’usage', async () => lancer(['validation', '--release', '--date']), 2],
    ]);
  });

  describe('interface', { skip: SANS_BASE }, () => {
    const F = file('validation-interface');
    const csrf = 'jeton-validation-0123456789abcdef';
    let serveur;
    let base;
    before(async () => {
      const { createServer } = await import('node:http');
      serveur = createServer(creerApplication({ principal: POOLS.principal, lecture: POOLS.lecture, csrf, file: F }));
      await new Promise((ok) => serveur.listen(0, '127.0.0.1', ok));
      base = `http://127.0.0.1:${serveur.address().port}`;
    });
    after(() => new Promise((ok) => (serveur ? serveur.close(ok) : ok())));
    const lirePage = async (chemin, options = {}) => { const r = await fetch(base + chemin, { redirect: 'manual', ...options }); return { code: r.status, texte: await r.text(), lieu: r.headers.get('location') }; };
    const poster = (champs) => lirePage('/validations', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ _csrf: csrf, ...champs }).toString() });

    test('le bouton « Validation finale », de bout en bout', async (t) => table(t, [
      ['la page porte le formulaire, sans défaut d’accessibilité', async () => { const r = await lirePage('/declencheurs'); return [r.code, r.texte.includes('<h2 id="validation-titre">Validation finale</h2>'), r.texte.includes('<button type="submit" aria-describedby="validation-aide">Validation finale</button>'), defautsAccessibilite(r.texte)]; }, [200, true, true, []]],
      ['release vide : 422, l’erreur reliée au champ', async () => { const r = await poster({ release: '', confirmation: '1' }); return [r.code, r.texte.includes('href="#validation-release"'), r.texte.includes('aria-invalid="true"'), defautsAccessibilite(r.texte)]; }, [422, true, true, []]],
      ['non confirmée : 422, rien d’enregistré', async () => { const r = await poster({ release: 'v0.0.2-essai' }); const { rows } = await POOLS.principal.query("SELECT 1 FROM pilotage.validation WHERE release = 'v0.0.2-essai'"); return [r.code, r.texte.includes('href="#validation-confirmation"'), rows.length]; }, [422, true, 0]],
      ['validée : redirigée, avec sa confirmation', async () => { const r = await poster({ release: 'v0.0.1-essai', commentaire: 'essai de l’interface', confirmation: '1' }); return [r.code, r.lieu]; }, [303, '/declencheurs?fait=validation-enregistree#validation']],
      ['la table la montre, avec son auteur', async () => { const r = await lirePage('/declencheurs?fait=validation-enregistree'); return [r.texte.includes('Validation finale enregistrée'), r.texte.includes('<th scope="row">v0.0.1-essai</th>'), r.texte.includes('essai de l’interface')]; }, [true, true, true]],
      ['la même release une seconde fois : 409, l’erreur reliée au champ', async () => { const r = await poster({ release: 'v0.0.1-essai', confirmation: '1' }); return [r.code, r.texte.includes('a déjà sa validation finale'), r.texte.includes('href="#validation-release"'), r.texte.includes('<title>Erreur : déclencheurs')]; }, [409, true, true, true]],
      ['rangée dans la file de l’interface, jamais en principale', async () => { const { rows } = await POOLS.principal.query("SELECT file, valide_par FROM pilotage.validation WHERE release = 'v0.0.1-essai'"); return rows; }, [{ file: F, valide_par: 'interface' }]],
      ['sans jeton : refusée', async () => (await lirePage('/validations', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'release=v1' })).code, 403],
    ]));
  });
});
