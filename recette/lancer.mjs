#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  recette/lancer.mjs : le lanceur de la recette
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  usage : node recette/lancer.mjs <commande> [options]
 *
 *    migrer                       applique les migrations (recette/sql/NNN_*.sql)
 *    importer [fichier] [--remplacer | --si-vide | --nouveaux]
 *                                 charge les tests définis (défaut recette/tests-definis.yaml) ;
 *                                 --si-vide : seulement si la base n'en a aucun (signale
 *                                 alors ceux du fichier qu'elle n'a pas) ; --nouveaux :
 *                                 seulement ceux qu'elle n'a pas, sans toucher aux autres
 *    exporter [fichier]           réécrit les tests définis depuis la base (défaut : sortie standard)
 *    campagne [--libelle t] [--si-premiere] [--demande n] [motifs…]
 *                                 une campagne complète (défaut : tests/test_*.mjs) ;
 *                                 --si-premiere : seulement si aucune n'a encore eu lieu ;
 *                                 --demande : la demande de l'interface qui la lance
 *                                 (l'exécuteur, recette/executeur.mjs), rattachée à la campagne
 *    comparer <a> <b>             ce qui change entre deux campagnes
 *    etat                         les dix dernières campagnes
 *    validation [--release | --date]
 *                                 la dernière validation finale (interface, bouton
 *                                 « Validation finale ») : sa release, ou sa date en
 *                                 secondes depuis l'epoch ; code 1 s'il n'y en a aucune.
 *                                 Le manifeste du méta-projet la lit pour 10.2.
 *
 *  Une campagne, pas à pas :
 *    1. migrer, puis ouvrir la campagne (commit examiné, version du modèle,
 *       machine, Node, démon Docker) ;
 *    2. recharger les fichiers YAML du dépôt dans donnees.document ;
 *    3. lancer node --test avec deux rapporteurs : la console (lisible) et la
 *       recette (JSONL, une ligne par test avec ses opérations) ;
 *    4. exécuter les tests définis en base (SQL en lecture seule, fonctions) ;
 *    5. charger le tout en une transaction, clore la campagne avec ses totaux.
 *  Le lanceur tient un verrou consultatif au numéro de la campagne, pris avant
 *  même qu'elle soit validée : une campagne restée « en cours » sans verrou tenu
 *  (lanceur tué) est close comme interrompue au lancement suivant, ou par
 *  l'exécuteur qui veille (recette/executeur.mjs). Interrompu (SIGINT, SIGTERM),
 *  le lanceur arrête node --test et clôt lui-même la campagne comme interrompue.
 *  Code de sortie : 0 sans échec ni erreur (omis et « à faire » ne comptent pas),
 *  1 sinon, 2 pour un usage invalide, 3 si la base est injoignable.
 *
 *  Variables : RECETTE_PG_URL, RECETTE_PG_LECTURE_URL, RECETTE_DELAI_SQL_MS
 *  (voir .env.recette.example).
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';

import { RACINE, enTransaction, fermer, migrer, ouvrir, urlMasquee } from './base.mjs';
import { charger, totaux } from './charger.mjs';
import { absents, executerTestsDefinis, exporter, importer } from './definis.mjs';
import { chargerDocuments } from './documents.mjs';
import { derniereValidation } from './pilotage.mjs';

const DEFINIS = join(RACINE, 'recette', 'tests-definis.yaml');
const MOTIFS_DEFAUT = ['tests/test_*.mjs'];

const USAGE = `usage : node recette/lancer.mjs <commande> [options]

  migrer                         applique les migrations
  importer [fichier] [--remplacer | --si-vide | --nouveaux]
                                 charge les tests définis (défaut : recette/tests-definis.yaml) ;
                                 --nouveaux : seulement ceux que la base n'a pas
  exporter [fichier]             écrit les tests définis (défaut : sortie standard)
  campagne [--libelle t] [--si-premiere] [--demande n] [motifs…]
                                 campagne complète (défaut : tests/test_*.mjs)
  comparer <a> <b>               ce qui change entre deux campagnes
  etat                           les dix dernières campagnes
  validation [--release | --date]
                                 la dernière validation finale : release, ou date (epoch)
`;

const sortie = (t = '') => process.stdout.write(`${t}\n`);
const erreur = (t) => process.stderr.write(`recette : ${t}\n`);

function usage(message) {
  process.stderr.write(`${USAGE}\nrecette : ${message}\n`);
  return 2;
}

/** Ce qui identifie la campagne : commit, modèle, machine, Node, démon Docker. */
function contexteCampagne() {
  const git = spawnSync('git', ['-C', RACINE, 'rev-parse', '--short=12', 'HEAD'], { encoding: 'utf8' });
  const sale = spawnSync('git', ['-C', RACINE, 'status', '--porcelain'], { encoding: 'utf8' });
  let modele = null;
  try { modele = String(parse(readFileSync(join(RACINE, 'modele-executif-12f-7e.yaml'), 'utf8')).modele.version); } catch { /* modèle illisible */ }
  const demon = spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 15000 }).status === 0;
  return {
    release: git.status === 0 ? `${git.stdout.trim()}${sale.stdout.trim() ? '+modifié' : ''}` : null,
    modele_version: modele,
    machine: hostname(),
    node_version: process.version,
    docker_demon: demon,
  };
}

/** Lit le JSONL du rapporteur ; une ligne illisible est signalée, pas fatale. */
function lireJsonl(chemin) {
  if (!existsSync(chemin)) return [];
  const lignes = [];
  for (const [i, l] of readFileSync(chemin, 'utf8').split('\n').entries()) {
    if (!l.trim()) continue;
    try { lignes.push(JSON.parse(l)); } catch { erreur(`ligne ${i + 1} du rapport illisible, ignorée`); }
  }
  return lignes;
}

/** Clé des verrous consultatifs de campagne : (CLE_CAMPAGNE, numéro). */
export const CLE_CAMPAGNE = 7_277_713;

/**
 * Les campagnes « en cours » dont aucun lanceur ne tient le verrou. `clore(id)`
 * dit lesquelles clore comme interrompues ; `ids` borne l'examen à ces numéros.
 * Sans `ids`, les campagnes d'essai de la recette (numéros négatifs) sont
 * laissées à leurs tests. L'examen prend le verrou en partage, le temps de
 * regarder et de clore : il cède devant un lanceur (verrou exclusif), jamais
 * devant un autre examen, qui ne fait donc pas passer une orpheline pour
 * vivante. Rend { libres, closes }.
 */
export async function examinerOrphelines(principal, { clore = () => true, ids = null } = {}) {
  const { rows } = ids
    ? await principal.query("SELECT id FROM recette.campagne WHERE statut = 'en_cours' AND id = ANY($1::bigint[]) ORDER BY id", [ids])
    : await principal.query("SELECT id FROM recette.campagne WHERE statut = 'en_cours' AND id > 0 ORDER BY id");
  const libres = [];
  const closes = [];
  for (const { id } of rows) {
    const c = await principal.connect();
    try {
      const { rows: [{ libre }] } = await c.query('SELECT pg_try_advisory_lock_shared($1, $2::int) AS libre', [CLE_CAMPAGNE, id]);
      if (!libre) continue;
      try {
        libres.push(id);
        if (!clore(id)) continue;
        const r = await c.query(
          "UPDATE recette.campagne SET statut = 'interrompue', fin = greatest(now(), debut), totaux = totaux || $2 WHERE id = $1 AND statut = 'en_cours'",
          [id, { erreur: 'lanceur arrêté sans clore la campagne' }],
        );
        if (r.rowCount) closes.push(id);
      } finally {
        await c.query('SELECT pg_advisory_unlock_shared($1, $2::int)', [CLE_CAMPAGNE, id]).catch(() => {});
      }
    } finally {
      c.release();
    }
  }
  return { libres, closes };
}

/** Clôt comme interrompues les campagnes « en cours » dont aucun lanceur ne tient le verrou (`ids` : ces numéros seulement). */
export async function cloreOrphelines(principal, { ids = null } = {}) {
  return (await examinerOrphelines(principal, { ids })).closes;
}

/** node --test avec les deux rapporteurs ; rend le code de sortie. `surEnfant` reçoit le processus lancé. */
function lancerNodeTest(motifs, jsonl, campagneId, surEnfant = () => {}) {
  const args = [
    '--test',
    '--test-reporter=./tests/outils/rapporteur-console.mjs', '--test-reporter-destination=stdout',
    '--test-reporter=./tests/outils/rapporteur-recette.mjs', `--test-reporter-destination=${jsonl}`,
    ...motifs,
  ];
  return new Promise((ok) => {
    const enfant = spawn(process.execPath, args, { cwd: RACINE, stdio: ['ignore', 'inherit', 'inherit'], env: { ...process.env, RECETTE_CAMPAGNE_ID: String(campagneId) } });
    enfant.on('close', (code, signal) => ok(signal ? 128 : code ?? 1));
    enfant.on('error', (e) => { erreur(`node --test : ${e.message}`); ok(1); });
    surEnfant(enfant);
  });
}

/**
 * Crée la campagne sous son verrou, pris avant la validation : visible « en
 * cours », elle est toujours tenue, et nul ne la prend pour orpheline. `client`
 * garde le verrou jusqu'à la clôture ; une création manquée lève, et
 * l'appelant détruit alors le client (un verrou déjà pris part avec lui).
 * `id` impose le numéro (campagnes d'essai de la recette, négatives).
 */
export async function creerCampagne(client, { libelle, motifs = [], ctx = contexteCampagne(), id = null }) {
  const colonnes = ['libelle', 'release', 'modele_version', 'machine', 'node_version', 'docker_demon', 'fichiers'];
  const valeurs = [libelle, ctx.release ?? null, ctx.modele_version ?? null, ctx.machine ?? null, ctx.node_version ?? null, ctx.docker_demon ?? null, motifs];
  if (id !== null) { colonnes.unshift('id'); valeurs.unshift(id); }
  try {
    await client.query('BEGIN');
    const { rows: [c] } = await client.query(
      `INSERT INTO recette.campagne (${colonnes.join(', ')}) ${id === null ? '' : 'OVERRIDING SYSTEM VALUE '}VALUES (${valeurs.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      valeurs,
    );
    await client.query('SELECT pg_advisory_lock($1, $2::int)', [CLE_CAMPAGNE, c.id]);
    await client.query('COMMIT');
    return c.id;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  }
}

/**
 * La garde d'interruption d'une campagne : au premier SIGINT ou SIGTERM,
 * l'enfant suivi (node --test) reçoit SIGTERM et la campagne est dite
 * interrompue ; les signaux suivants n'y changent rien. Le gestionnaire reste
 * en place jusqu'à lever() : un second signal ne tue pas le lanceur avant
 * qu'il ait clos sa campagne. `cible` et `dire` : le processus et la sortie.
 */
export function garderInterruption({ cible = process, dire = sortie } = {}) {
  let interrompue = false;
  let enfant = null;
  const arreterEnfant = () => { try { enfant?.kill('SIGTERM'); } catch { /* déjà fini */ } };
  /** Interrompt la campagne (signal reçu, verrou perdu…) : `raison` est dite une fois. */
  const interrompre = (raison = 'Interruption') => {
    if (interrompue) return;
    interrompue = true;
    dire(`\n${raison} : arrêt des tests, la campagne sera close comme interrompue`);
    arreterEnfant();
  };
  const surSignal = () => interrompre();
  for (const s of ['SIGINT', 'SIGTERM']) cible.on(s, surSignal);
  return {
    get interrompue() { return interrompue; },
    interrompre,
    suivre(e) { enfant = e; if (interrompue) arreterEnfant(); },
    verifier() { if (interrompue) throw new Error('campagne interrompue'); },
    lever() { for (const s of ['SIGINT', 'SIGTERM']) cible.removeListener(s, surSignal); },
  };
}

async function campagne(pools, { libelle, motifs, demande = null }) {
  const { principal, lecture, lectureDediee } = pools;
  const appliquees = await migrer(principal);
  if (appliquees.length) sortie(`Migrations appliquées : ${appliquees.join(', ')}`);
  if (!lectureDediee) erreur('RECETTE_PG_LECTURE_URL absente : les requêtes SQL passent par le rôle principal (lecture seule par transaction seulement)');

  const orphelines = await cloreOrphelines(principal);
  if (orphelines.length) sortie(`Campagne(s) restée(s) en cours, closes comme interrompues : ${orphelines.join(', ')}`);

  // Une interruption arrête node --test, puis clôt la campagne comme interrompue,
  // sans rien charger ; la garde reste en place jusqu'à la dernière instruction
  const garde = garderInterruption();
  let verrou = null;
  let perte = null;
  let id = null;
  let travail = null;
  try {
    const ctx = contexteCampagne();
    // Le verrou de la campagne, tenu jusqu'à sa clôture : sans lui, elle serait
    // orpheline, et la veille de l'exécuteur la clorait. Perdu (connexion
    // coupée), il interrompt la campagne.
    verrou = await principal.connect();
    verrou.on('error', (e) => {
      perte = e;
      garde.interrompre(`Verrou de la campagne perdu (${e.message})`);
    });
    // Interrompue avant même d'exister : rien n'est créé
    garde.verifier();
    id = await creerCampagne(verrou, { libelle, motifs, ctx });
    sortie(`Campagne ${id} : ${libelle}`);
    // Lancée par l'exécuteur : la demande de l'interface pointe sur sa campagne dès l'ouverture
    if (demande !== null) {
      const r = await principal.query("UPDATE pilotage.demande SET campagne_id = $1 WHERE id = $2 AND statut = 'en_cours'", [id, demande]);
      if (!r.rowCount) erreur(`demande n° ${demande} introuvable ou pas en cours : campagne non rattachée`);
    }
    sortie(`  release ${ctx.release ?? '—'} · modèle ${ctx.modele_version ?? '—'} · ${ctx.machine} · Node ${ctx.node_version} · démon Docker ${ctx.docker_demon ? 'joignable' : 'injoignable'}`);
    garde.verifier();

    travail = mkdtempSync(join(tmpdir(), `recette-${id}-`));
    const docs = await enTransaction(principal, (c) => chargerDocuments(c, RACINE, id));
    sortie(`  documents : ${docs.modele} modèle, ${docs.manifeste} manifeste(s), ${docs.journal} entrée(s) de journal, ${docs.workflows} catalogue de workflows, ${docs.ci} workflow(s) de CI\n`);
    garde.verifier();

    const jsonl = join(travail, 'campagne.jsonl');
    const code = await lancerNodeTest(motifs, jsonl, id, (e) => garde.suivre(e));
    const rapport = lireJsonl(jsonl);
    garde.verifier();

    const definis = await executerTestsDefinis({ principal, lecture });
    garde.verifier();
    const enregistrements = [...rapport.filter((l) => l.type === 'test'), ...definis];
    if (definis.length) {
      const { lignesFichier } = await import('../tests/outils/rapporteur-console.mjs');
      sortie(lignesFichier('tests définis en base', definis, definis.reduce((s, t) => s + (t.duree_ms ?? 0), 0)).join('\n'));
    }
    const t = totaux(enregistrements);
    if (!rapport.length) t.rapport_absent = true;
    const reussie = rapport.length > 0 && t.echoues + t.erreurs === 0 && code === 0;
    await enTransaction(principal, async (c) => {
      await charger(c, id, enregistrements);
      // Close entre-temps (par la veille, verrou perdu) : rien n'est chargé
      const r = await c.query("UPDATE recette.campagne SET fin = now(), statut = $2, totaux = $3 WHERE id = $1 AND statut = 'en_cours'", [id, reussie ? 'reussie' : 'echouee', t]);
      if (!r.rowCount) throw new Error(`campagne ${id} close entre-temps : résultats non chargés`);
    });
    sortie(`\nCampagne ${id} ${reussie ? 'réussie' : 'en échec'} : ${t.tests} tests (${t.base} définis en base) · ${t.reussis} réussis · ${t.echoues} en échec · ${t.erreurs} en erreur · ${t.omis} omis · ${t.a_faire} à faire · ${t.operations} opérations`);
    if (!rapport.length) erreur(`aucun rapport de node --test (code ${code}) : voir la sortie ci-dessus`);
    return reussie ? 0 : 1;
  } catch (e) {
    if (id !== null) {
      await principal.query("UPDATE recette.campagne SET fin = now(), statut = $2, totaux = totaux || $3 WHERE id = $1 AND statut = 'en_cours'",
        [id, garde.interrompue ? 'interrompue' : 'echouee', { erreur: e.message }]).catch(() => {});
    }
    // Création manquée, ou connexion du verrou perdue : la connexion est détruite, et le verrou avec elle
    if (verrou && (id === null || perte)) { verrou.release(perte ?? e); verrou = null; }
    throw e;
  } finally {
    if (travail) rmSync(travail, { recursive: true, force: true });
    if (verrou) {
      if (!perte) await verrou.query('SELECT pg_advisory_unlock($1, $2::int)', [CLE_CAMPAGNE, id]).catch(() => {});
      verrou.release(perte ?? undefined);
    }
    garde.lever();
  }
}

async function comparer(pools, a, b) {
  const { rows } = await pools.principal.query(
    "SELECT * FROM recette.comparer($1, $2) WHERE changement <> 'identique' ORDER BY changement, fichier NULLS LAST, nom_complet",
    [a, b],
  );
  const { rows: [{ identiques }] } = await pools.principal.query("SELECT count(*) AS identiques FROM recette.comparer($1, $2) WHERE changement = 'identique'", [a, b]);
  sortie(`Campagnes ${a} → ${b} : ${identiques} test(s) inchangé(s), ${rows.length} changement(s)`);
  const titres = { regression: 'Régressions', correction: 'Corrections', changement: 'Autres changements', nouveau: 'Nouveaux', disparu: 'Disparus' };
  for (const [k, titre] of Object.entries(titres)) {
    const lot = rows.filter((r) => r.changement === k);
    if (!lot.length) continue;
    sortie(`\n${titre} (${lot.length})`);
    for (const r of lot) sortie(`  ${r.statut_a ?? '—'} → ${r.statut_b ?? '—'}  ${r.fichier ?? 'base'} : ${r.nom_complet}`);
  }
  return rows.some((r) => r.changement === 'regression') ? 1 : 0;
}

async function etat(pools) {
  const { rows } = await pools.principal.query('SELECT * FROM recette.v_campagne ORDER BY id DESC LIMIT 10');
  if (!rows.length) { sortie('Aucune campagne.'); return 0; }
  for (const c of rows) {
    sortie(`${String(c.id).padStart(5)}  ${c.debut}  ${c.statut.padEnd(11)}  ${String(c.tests).padStart(4)} tests  ${String(c.reussis).padStart(4)} réussis  ${String(c.echoues + c.erreurs).padStart(3)} en échec  ${String(c.operations).padStart(5)} opérations  ${c.libelle}`);
  }
  return 0;
}

export async function main(argv = process.argv.slice(2)) {
  const [commande, ...reste] = argv;
  if (!commande || commande === '-h' || commande === '--help') { process.stdout.write(USAGE); return commande ? 0 : 2; }
  const options = {
    migrer: {}, etat: {}, exporter: {},
    importer: { remplacer: { type: 'boolean', default: false }, 'si-vide': { type: 'boolean', default: false }, nouveaux: { type: 'boolean', default: false } },
    campagne: { libelle: { type: 'string' }, 'si-premiere': { type: 'boolean', default: false }, demande: { type: 'string' } },
    comparer: {},
    validation: { release: { type: 'boolean', default: false }, date: { type: 'boolean', default: false } },
  };
  if (!Object.hasOwn(options, commande)) return usage(`commande inconnue : ${commande}`);
  let a;
  try {
    a = parseArgs({ args: reste, options: options[commande], allowPositionals: true, strict: true });
  } catch (e) {
    return usage(e.message);
  }
  if (commande === 'comparer' && (a.positionals.length !== 2 || !a.positionals.every((p) => /^\d+$/.test(p)))) return usage('comparer attend deux numéros de campagne');
  if (commande === 'campagne' && a.values.demande !== undefined && !/^\d{1,15}$/.test(a.values.demande)) return usage('--demande attend un numéro de demande');
  if (commande === 'importer' && a.values.nouveaux && (a.values.remplacer || a.values['si-vide'])) return usage('--nouveaux exclut --remplacer et --si-vide');
  if (commande === 'validation' && a.values.release && a.values.date) return usage('--release exclut --date');

  let pools;
  try {
    pools = ouvrir();
    await pools.principal.query('SELECT 1');
  } catch (e) {
    erreur(`base injoignable (${process.env.RECETTE_PG_URL ? urlMasquee(process.env.RECETTE_PG_URL) : 'RECETTE_PG_URL absente'}) : ${e.message}`);
    if (pools) await fermer(pools).catch(() => {});
    return 3;
  }
  try {
    if (commande === 'migrer') {
      const m = await migrer(pools.principal);
      sortie(m.length ? `Migrations appliquées : ${m.join(', ')}` : 'Base à jour.');
      return 0;
    }
    if (commande === 'importer') {
      await migrer(pools.principal);
      const fichier = resolve(a.positionals[0] ?? DEFINIS);
      if (a.values['si-vide']) {
        const { rows: [{ n }] } = await pools.principal.query("SELECT count(*) AS n FROM recette.test WHERE origine = 'base'");
        if (n > 0) {
          sortie(`${n} test(s) défini(s) déjà en base : import ignoré (--si-vide). Sans cette option, l’import met à jour les tests de même nom.`);
          // Ce que le dépôt définit de plus que la base : signalé, jamais importé d'office
          // (un test supprimé dans l'interface reviendrait)
          try {
            const manquants = await absents(pools.principal, readFileSync(fichier, 'utf8'));
            if (manquants.length) {
              sortie(`Le dépôt en définit ${manquants.length} que la base n’a pas : ${manquants.map((m) => `« ${m} »`).join(', ')}.`);
              sortie('« importer --nouveaux » les ajoute, sans toucher aux tests de la base (un test supprimé dans l’interface reviendrait).');
            }
          } catch (e) {
            erreur(`tests définis du dépôt illisibles : ${e.message.split('\n')[0]}`);
          }
          return 0;
        }
      }
      const r = await enTransaction(pools.principal, (c) => importer(c, readFileSync(fichier, 'utf8'), { remplacer: a.values.remplacer, nouveaux: a.values.nouveaux }));
      if (a.values.nouveaux) {
        sortie(r.ajoutes.length
          ? `${r.ajoutes.length} test(s) défini(s) ajouté(s) depuis ${fichier} : ${r.ajoutes.map((m) => `« ${m} »`).join(', ')} ; ceux de la base restent tels quels.`
          : `Aucun test défini nouveau dans ${fichier} : la base les a tous.`);
        return 0;
      }
      sortie(`${r.importes} test(s) défini(s) importé(s) depuis ${fichier}${a.values.remplacer ? `, ${r.retires} retiré(s)` : ''}.`);
      return 0;
    }
    if (commande === 'exporter') {
      const texte = await exporter(pools.principal);
      if (a.positionals[0]) { writeFileSync(resolve(a.positionals[0]), texte); sortie(`Tests définis écrits dans ${resolve(a.positionals[0])}.`); } else process.stdout.write(texte);
      return 0;
    }
    if (commande === 'campagne') {
      if (a.values['si-premiere']) {
        await migrer(pools.principal);
        const { rows: [{ n }] } = await pools.principal.query('SELECT count(*) AS n FROM recette.campagne WHERE id > 0');
        if (n > 0) {
          sortie(`${n} campagne(s) déjà enregistrée(s) : rien à lancer (--si-premiere).`);
          return 0;
        }
      }
      const libelle = a.values.libelle ?? `campagne du ${new Date().toISOString().slice(0, 16).replace('T', ' ')}`;
      const demande = a.values.demande === undefined ? null : Number(a.values.demande);
      return await campagne(pools, { libelle, motifs: a.positionals.length ? a.positionals : MOTIFS_DEFAUT, demande });
    }
    if (commande === 'comparer') return await comparer(pools, Number(a.positionals[0]), Number(a.positionals[1]));
    if (commande === 'validation') {
      // Une lecture, par le rôle de lecture : la mesure d'un cycle ne migre jamais la base
      let v;
      try {
        v = await derniereValidation(pools.lecture);
      } catch (e) {
        if (e.code !== '42P01') throw e;
        erreur('table pilotage.validation absente : appliquer les migrations (node recette/lancer.mjs migrer)');
        return 1;
      }
      if (!v) {
        erreur('aucune validation finale : une release se valide dans l’interface (Déclencheurs, « Validation finale »)');
        return 1;
      }
      const epoch = Math.floor(new Date(v.valide_le).getTime() / 1000);
      sortie(a.values.release ? v.release : a.values.date ? String(epoch) : `${v.release}  ${new Date(v.valide_le).toISOString()}  ${v.valide_par}`);
      return 0;
    }
    if (commande === 'etat') return await etat(pools);
    return 2;
  } catch (e) {
    erreur(e.message);
    return 1;
  } finally {
    await fermer(pools).catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
