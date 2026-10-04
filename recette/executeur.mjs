#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  recette/executeur.mjs : l'exécuteur des demandes de l'interface
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  usage : node recette/executeur.mjs [--une]
 *
 *  L'interface dépose des demandes (pilotage.demande) ; l'exécuteur, qui tient
 *  le socket Docker de la VM (l'interface ne l'a jamais), les réclame une à une
 *  et les exécute :
 *
 *    1. réclamer la plus ancienne demande en attente de sa file (FOR UPDATE
 *       SKIP LOCKED : deux exécuteurs ne prennent jamais la même) et tenir son
 *       verrou consultatif jusqu'à la clôture ;
 *    2. recopier l'état courant du dépôt (RECETTE_DEPOT, monté en lecture seule)
 *       dans un répertoire jetable, sans node_modules ni secrets, comme
 *       recette/entree.sh ;
 *    3. exécuter l'action de la liste blanche (recette/pilotage.mjs) : un argv,
 *       jamais un shell. La sortie, secrets masqués, est rangée toutes les deux
 *       secondes : l'interface la montre pendant l'exécution ;
 *    4. clore : réussie (code 0), en échec, ou interrompue (arrêt demandé dans
 *       l'interface, délai de l'action dépassé, exécuteur arrêté), avec le
 *       résultat propre à l'action (campagne rattachée, entrée du cycle à
 *       blanc, documents rechargés).
 *
 *  Réveil par LISTEN pilotage_demande, et par sondage toutes les 5 s. Signe de
 *  vie : pilotage.executeur.vu_le toutes les 10 s, et le fichier
 *  EXECUTEUR_VIVANT (bilan de santé du conteneur). Au démarrage, une demande
 *  « en cours » dont nul ne tient le verrou (exécuteur tué) est close comme
 *  interrompue, et les données du dépôt sont rechargées (sauf pendant une
 *  campagne) : après un git pull et un redémarrage, l'interface montre le dépôt
 *  déployé. Toutes les 15 s, l'exécuteur veille sur les campagnes : une
 *  campagne « en cours » qu'aucun lanceur ne tient, vue ainsi deux fois de
 *  suite, est close comme interrompue.
 *
 *  --une : traite au plus une demande, puis s'arrête (sans recharger ni veiller).
 *
 *  Variables : RECETTE_PG_URL, RECETTE_PG_LECTURE_URL ; RECETTE_DEPOT (défaut :
 *  la racine de ce dépôt) ; RECETTE_MODULES (défaut /app/node_modules, sinon le
 *  node_modules de ce dépôt) ; EXECUTEUR_NOM (défaut : nom de la machine) ;
 *  EXECUTEUR_FILE (défaut principale) ; EXECUTEUR_VIVANT (défaut
 *  /tmp/executeur.vivant).
 */

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse } from 'yaml';

import { RACINE, enTransaction, fermer, jsonPourPg, migrer, ouvrir, textePropre, urlMasquee } from './base.mjs';
import { chargerDocuments, verrouillerDocuments } from './documents.mjs';
import { CLE_CAMPAGNE, examinerOrphelines } from './lancer.mjs';
import { ACTIONS, FILE_PRINCIPALE } from './pilotage.mjs';

/** Clé des verrous consultatifs de demande : (CLE_DEMANDE, numéro). */
export const CLE_DEMANDE = 7_277_714;
/** Taille gardée de la sortie : sa fin, en caractères. */
export const SORTIE_MAX = 64 * 1024;
const SONDAGE_MS = 5000;
const VIE_MS = 10_000;
const RANGEMENT_MS = 2000;
const GRACE_MS = 15_000;
const VEILLE_MS = 15_000;

const journal = (t) => process.stdout.write(`executeur : ${t}\n`);

// ── Secrets et sortie ───────────────────────────────────────────────────────

/**
 * Les secrets de l'environnement : mots de passe des URL et variables qui en
 * portent. Un secret de moins de huit caractères n'est pas masqué seul : il
 * masquerait des mots ordinaires de la sortie (preparer-vm.sh en tire de
 * quarante-huit) ; dans une URL, il l'est toujours (masquer).
 */
export function secretsDe(env = process.env) {
  const s = new Set();
  for (const [cle, v] of Object.entries(env)) {
    if (!v) continue;
    if (/MOT_DE_PASSE|PASSWORD|SECRET|TOKEN|JETON/i.test(cle)) s.add(v);
    if (/_URL$/.test(cle)) {
      try {
        const u = new URL(v);
        if (u.password) { s.add(u.password); s.add(decodeURIComponent(u.password)); }
      } catch { /* pas une URL */ }
    }
  }
  // Les plus longs d'abord : un secret qui en contient un autre est masqué entier
  return [...s].filter((x) => x.length >= 8).sort((a, b) => b.length - a.length);
}

/**
 * Masque les secrets connus, puis tout identifiant porté par une URL
 * (schéma://utilisateur:mot-de-passe@hôte), même inconnu de l'exécuteur.
 */
export const masquer = (texte, secrets) => secrets
  .reduce((t, x) => t.split(x).join('***'), texte)
  .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)[^\s@/]+@/gi, '$1***@');

// Séquences d'échappement des terminaux (couleurs des outils) : hors de la sortie
// rangée ; la même expression que le résolveur
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/**
 * La fin d'un texte, n caractères au plus. La coupe ne doit pas laisser la fin
 * d'un secret en tête : la première ligne entamée tombe ; sans fin de ligne, un
 * début qui achève un secret connu est masqué.
 */
export function couperFin(texte, n, secrets = []) {
  if (texte.length <= n) return texte;
  let t = texte.slice(-n);
  const fin = t.indexOf('\n');
  if (fin >= 0 && fin < t.length - 1) return t.slice(fin + 1);
  for (const s of secrets) {
    for (let k = s.length - 1; k >= 3; k -= 1) {
      if (t.startsWith(s.slice(-k))) { t = `***${t.slice(k)}`; return t; }
    }
  }
  return t;
}

/**
 * La fin d'une sortie qui grandit : SORTIE_MAX caractères au plus, secrets
 * masqués. Le texte brut est gardé (deux fois la taille au plus) et masqué en
 * entier à chaque lecture, puis coupé : une coupe ne passe jamais avant le
 * masquage, et le masquage, qui peut allonger le texte, ne fait pas dépasser
 * la taille rangée.
 */
export class Sortie {
  constructor(secrets = []) {
    this.secrets = secrets;
    this.brut = '';
    this.tronquee = false;
  }

  ajouter(morceau) {
    this.brut += String(morceau).replace(ANSI, '');
    if (this.brut.length > SORTIE_MAX * 2) {
      this.brut = couperFin(this.brut, SORTIE_MAX, this.secrets);
      this.tronquee = true;
    }
  }

  valeur() {
    let t = textePropre(masquer(this.brut, this.secrets));
    if (t.length > SORTIE_MAX) {
      t = couperFin(t, SORTIE_MAX);
      this.tronquee = true;
    }
    return this.tronquee ? `[début de la sortie omis]\n${t}` : t;
  }
}

// ── Réclamer, clore les orphelines ──────────────────────────────────────────

/**
 * Réclame la plus ancienne demande en attente de la file. Le verrou de session
 * est pris avant la validation : une demande « en cours » visible est toujours
 * tenue. Rend { demande, verrou } (verrou : le client qui le tient), ou null.
 */
export async function reclamer(principal, { nom, file = FILE_PRINCIPALE }) {
  const client = await principal.connect();
  try {
    await client.query('BEGIN');
    const { rows: [libre] } = await client.query(
      "SELECT id FROM pilotage.demande WHERE file = $1 AND statut = 'en_attente' ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED",
      [file],
    );
    if (!libre) {
      await client.query('COMMIT');
      client.release();
      return null;
    }
    const { rows: [demande] } = await client.query(
      "UPDATE pilotage.demande SET statut = 'en_cours', debut = greatest(now(), demandee_le), executeur = $2 WHERE id = $1 RETURNING *",
      [libre.id, nom],
    );
    await client.query('SELECT pg_advisory_lock($1, $2::int)', [CLE_DEMANDE, demande.id]);
    await client.query('COMMIT');
    return { demande, verrou: client };
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw e;
  }
}

/** Clôt comme interrompues les demandes « en cours » de la file dont nul ne tient le verrou. */
export async function cloreOrphelines(principal, { file = FILE_PRINCIPALE } = {}) {
  const { rows } = await principal.query("SELECT id FROM pilotage.demande WHERE file = $1 AND statut = 'en_cours' ORDER BY id", [file]);
  const closes = [];
  for (const { id } of rows) {
    const c = await principal.connect();
    try {
      const { rows: [{ libre }] } = await c.query('SELECT pg_try_advisory_lock($1, $2::int) AS libre', [CLE_DEMANDE, id]);
      if (!libre) continue;
      try {
        const r = await c.query(
          `UPDATE pilotage.demande SET statut = 'interrompue', fin = greatest(now(), debut),
             sortie = right(sortie || $2, 70000) WHERE id = $1 AND statut = 'en_cours'`,
          [id, '\n[exécuteur arrêté sans clore la demande : close comme interrompue]\n'],
        );
        if (r.rowCount) closes.push(id);
      } finally {
        await c.query('SELECT pg_advisory_unlock($1, $2::int)', [CLE_DEMANDE, id]).catch(() => {});
      }
    } finally {
      c.release();
    }
  }
  return closes;
}

// ── Copie du dépôt ──────────────────────────────────────────────────────────

/** Recopie l'état courant du dépôt, sans node_modules ni secrets (comme recette/entree.sh). */
export function copierDepot(source, cible, modules = null) {
  mkdirSync(cible, { recursive: true });
  const r = spawnSync('sh', ['-c',
    // ni secrets, ni modules, ni les répertoires des cycles (ticket, temp : conservés sur le poste, jamais versionnés)
    'tar -C "$1" --exclude=./node_modules --exclude=./.env.recette --exclude=./.env --exclude="./journal/*/[0-9][0-9][0-9][0-9]" --exclude="./journal/*/[0-9][0-9][0-9][0-9].abandon-*" --ignore-failed-read -cf - . | tar -C "$2" -xf -',
    'copie', source, cible], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`copie du dépôt impossible : ${(r.stderr || r.error?.message || '').trim().slice(0, 500)}`);
  if (modules && existsSync(modules)) symlinkSync(modules, join(cible, 'node_modules'), 'dir');
}

/** Les modules à relier dans la copie : ceux de l'image, sinon ceux du dépôt. */
export function modulesParDefaut() {
  if (process.env.RECETTE_MODULES) return process.env.RECETTE_MODULES;
  if (existsSync('/app/node_modules')) return '/app/node_modules';
  return join(RACINE, 'node_modules');
}

/** Les entrées de journal d'une copie : { chemin relatif → date de modification }. */
function entreesDeJournal(racine) {
  const vu = new Map();
  const dossier = join(racine, 'journal');
  if (!existsSync(dossier)) return vu;
  for (const instance of readdirSync(dossier)) {
    const rep = join(dossier, instance);
    if (!statSync(rep).isDirectory()) continue;
    for (const f of readdirSync(rep).filter((x) => /^\d+\.yaml$/.test(x))) vu.set(`journal/${instance}/${f}`, statSync(join(rep, f)).mtimeMs);
  }
  return vu;
}

// ── Exécution ───────────────────────────────────────────────────────────────

/** Envoie un signal au groupe de processus de l'enfant (ou à lui seul si le groupe n'existe plus). */
function signalerGroupe(enfant, signal) {
  try { process.kill(-enfant.pid, signal); } catch { try { enfant.kill(signal); } catch { /* déjà fini */ } }
}

/**
 * Arrête une commande par degrés, sans attendre qu'on le redemande : TERM au
 * meneur d'abord (le lanceur arrête ses tests et clôt sa campagne comme
 * interrompue, les scripts lancent leurs pièges de sortie), TERM au groupe
 * après le délai de grâce, KILL au groupe cinq secondes plus tard. Un meneur
 * sorti plus tôt emporte le reste de son groupe (lancerCommande).
 */
function arreterParDegres(enfant) {
  try { enfant.kill('SIGTERM'); } catch { /* déjà fini */ }
  const t1 = setTimeout(() => signalerGroupe(enfant, 'SIGTERM'), GRACE_MS);
  const t2 = setTimeout(() => signalerGroupe(enfant, 'SIGKILL'), GRACE_MS + 5000);
  t1.unref();
  t2.unref();
  return () => { clearTimeout(t1); clearTimeout(t2); };
}

/**
 * Exécute l'argv dans la copie, sous délai ; `verifier()` est appelé toutes les
 * deux secondes et rend vrai pour arrêter. La commande est finie quand son
 * meneur sort : ce qui reste de son groupe est arrêté (TERM, puis KILL), et ses
 * flux, si un descendant les tient ouverts, fermés après deux secondes. Rend
 * { code, motif } : motif vaut 'arret', 'delai' ou null.
 */
function lancerCommande(argv, { cwd, env, delaiMs, sortie, verifier }) {
  return new Promise((ok) => {
    let motif = null;
    let annulerDegres = () => {};
    const enfant = spawn(process.execPath, argv, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    enfant.stdout.setEncoding('utf8');
    enfant.stderr.setEncoding('utf8');
    enfant.stdout.on('data', (m) => sortie.ajouter(m));
    enfant.stderr.on('data', (m) => sortie.ajouter(m));
    const arreter = (pourquoi) => {
      if (motif) return;
      motif = pourquoi;
      sortie.ajouter(pourquoi === 'delai' ? `\n[délai de l’action dépassé (${Math.round(delaiMs / 1000)} s) : arrêt]\n` : '\n[arrêt demandé : arrêt]\n');
      annulerDegres = arreterParDegres(enfant);
    };
    const delai = setTimeout(() => arreter('delai'), delaiMs);
    let enVerification = false;
    const ronde = setInterval(async () => {
      if (enVerification) return;
      enVerification = true;
      try { if (await verifier()) arreter('arret'); } catch { /* base momentanément injoignable : on réessaie */ } finally { enVerification = false; }
    }, RANGEMENT_MS);
    let fini = false;
    const conclure = (code, signal) => {
      if (fini) return;
      fini = true;
      clearTimeout(delai);
      clearInterval(ronde);
      annulerDegres();
      ok({ code: code ?? (signal ? 128 : 1), motif });
    };
    enfant.on('error', (e) => { sortie.ajouter(`\n[lancement impossible : ${e.message}]\n`); conclure(127, null); });
    enfant.on('exit', (code, signal) => {
      // Le meneur est sorti : ce qui reste de son groupe est arrêté (TERM, puis
      // KILL cinq secondes plus tard), que ses flux se ferment d'eux-mêmes ou
      // qu'un descendant les tienne (fermés alors après deux secondes)
      const nettoyer = () => {
        signalerGroupe(enfant, 'SIGTERM');
        setTimeout(() => signalerGroupe(enfant, 'SIGKILL'), 5000).unref();
      };
      const reste = setTimeout(() => {
        nettoyer();
        enfant.stdout.destroy();
        enfant.stderr.destroy();
        conclure(code, signal);
      }, 2000);
      enfant.once('close', () => { clearTimeout(reste); nettoyer(); conclure(code, signal); });
    });
  });
}

/** L'environnement des commandes : celui de l'exécuteur, sans la configuration du résolveur ni la CI. */
function environnementCommande() {
  const env = { ...process.env };
  for (const k of ['DEPOT_7E', 'MODELE_7E', 'MANIFESTE_7E', 'CI', 'GITEA_ACTIONS', 'GITHUB_ACTIONS', 'RECETTE_CAMPAGNE_ID', 'NODE_TEST_CONTEXT']) delete env[k];
  return env;
}

/** Recharge les documents depuis la copie : hors campagne, sans numéro de campagne. */
const chargerHorsCampagne = (client, racine) => chargerDocuments(client, racine, null);

/**
 * La campagne en cours, si un lanceur la tient : recharger les documents
 * pendant ses tests changerait ce qu'ils interrogent. Une campagne naît sous
 * son verrou (recette/lancer.mjs) : visible, elle est déjà tenue.
 */
export async function campagneVivante(principal) {
  const { rows } = await principal.query("SELECT id FROM recette.campagne WHERE statut = 'en_cours' ORDER BY id");
  for (const { id } of rows) {
    const c = await principal.connect();
    try {
      // En partage : seul un lanceur (verrou exclusif) la fait vivante, jamais un autre examen
      const { rows: [{ libre }] } = await c.query('SELECT pg_try_advisory_lock_shared($1, $2::int) AS libre', [CLE_CAMPAGNE, id]);
      if (!libre) return id;
      await c.query('SELECT pg_advisory_unlock_shared($1, $2::int)', [CLE_CAMPAGNE, id]);
    } finally {
      c.release();
    }
  }
  return null;
}

/**
 * Recharge les documents depuis la copie, sauf pendant une campagne vivante.
 * Le verrou des documents est pris avant la garde : une campagne qui démarre
 * charge sous ce même verrou ; vue vivante ici, ses documents restent les
 * siens. Rend { compte } ou { vivante }.
 */
async function rechargerSaufCampagne(principal, copie, { chargeur, garde }) {
  return enTransaction(principal, async (c) => {
    await verrouillerDocuments(c);
    const vivante = await garde(principal);
    return vivante ? { vivante } : { compte: await chargeur(c, copie) };
  });
}

/**
 * Exécute une demande réclamée, puis la clôt. Pour les tests : `commandes`
 * remplace l'argv d'une action, `delaiMs` son délai, `chargeur(client, racine)`
 * le rechargement des documents (sans toucher à ceux d'une campagne en cours),
 * `garde(principal)` la recherche d'une campagne vivante qui l'interdit.
 * Rend la demande close.
 */
export async function executer(pools, pris, { source = process.env.RECETTE_DEPOT || RACINE, modules = modulesParDefaut(), commandes = {}, delaiMs = null, chargeur = chargerHorsCampagne, garde = campagneVivante, arretGeneral = () => false } = {}) {
  const { principal } = pools;
  const { demande, verrou } = pris;
  const action = ACTIONS[demande.action];
  const sortie = new Sortie(secretsDe());
  let copie = null;
  let statut = 'echouee';
  let code = null;
  let resultat = null;
  // Sans sa connexion, le verrou de la demande est perdu : on arrête la commande
  let verrouPerdu = null;
  const surPerte = (e) => {
    if (verrouPerdu) return;
    verrouPerdu = e;
    sortie.ajouter(`\n[connexion du verrou perdue (${e.message}) : arrêt]\n`);
  };
  verrou.on('error', surPerte);
  const ranger = async () => {
    const { rows: [d] } = await principal.query('UPDATE pilotage.demande SET sortie = $2 WHERE id = $1 RETURNING arret_le', [demande.id, sortie.valeur()]);
    return Boolean(d?.arret_le) || arretGeneral() || Boolean(verrouPerdu);
  };
  try {
    if (!action) throw new Error(`action inconnue de cet exécuteur : ${demande.action}`);
    copie = mkdtempSync(join(tmpdir(), `demande-${demande.id}-`));
    sortie.ajouter(`[${new Date().toISOString()}] ${action.nom} : copie du dépôt (${source})\n`);
    copierDepot(source, copie, modules);
    if (demande.action === 'charger' && !commandes.charger) {
      const { vivante, compte } = await rechargerSaufCampagne(principal, copie, { chargeur, garde });
      if (vivante) {
        sortie.ajouter(`La campagne n° ${vivante} est en cours : elle recharge elle-même les documents, et ses tests les interrogent. Rechargement refusé ; le redemander après elle.\n`);
        resultat = { refus: 'campagne en cours', campagne: vivante };
      } else {
        sortie.ajouter(`Documents rechargés : ${compte.modele} modèle, ${compte.manifeste} manifeste(s), ${compte.journal} entrée(s) de journal, ${compte.workflows} catalogue de workflows, ${compte.ci} workflow(s) de CI.\n`);
        statut = 'reussie';
        code = 0;
        resultat = { documents: compte };
      }
    } else {
      const argv = commandes[demande.action] ?? action.commande(demande.parametres ?? {}, demande);
      const avant = demande.action === 'cycle' ? entreesDeJournal(copie) : null;
      sortie.ajouter(`$ node ${argv.join(' ')}\n`);
      await ranger();
      const r = await lancerCommande(argv, { cwd: copie, env: environnementCommande(), delaiMs: delaiMs ?? action.delaiMin * 60_000, sortie, verifier: ranger });
      code = r.code;
      statut = r.motif || verrouPerdu ? 'interrompue' : code === 0 ? 'reussie' : 'echouee';
      resultat = await resultatDe(principal, demande, copie, avant, sortie);
      sortie.ajouter(`\n[fin : code ${code}${r.motif ? `, ${r.motif === 'delai' ? 'délai dépassé' : 'arrêt demandé'}` : ''}]\n`);
    }
  } catch (e) {
    sortie.ajouter(`\n[erreur de l’exécuteur : ${e.message}]\n`);
    statut = 'echouee';
  } finally {
    if (copie) rmSync(copie, { recursive: true, force: true });
  }
  const clore = (texte) => principal.query(
    `UPDATE pilotage.demande SET statut = $2, fin = greatest(now(), debut), code_retour = $3, sortie = $4, resultat = $5::jsonb
     WHERE id = $1 AND statut = 'en_cours' RETURNING *`,
    [demande.id, statut, code, texte, resultat === null ? null : jsonPourPg(resultat)],
  );
  try {
    let close;
    try {
      ({ rows: [close] } = await clore(sortie.valeur()));
    } catch (e) {
      // Dernier recours : une sortie que la base refuserait ne doit pas laisser la demande en cours
      if (e.code !== '23514' && e.code !== '22021') throw e;
      ({ rows: [close] } = await clore(`[sortie refusée par la base (${e.code}) : fin seulement]\n${couperFin(sortie.valeur(), 20_000)}`));
    }
    return close ?? (await principal.query('SELECT * FROM pilotage.demande WHERE id = $1', [demande.id])).rows[0];
  } finally {
    verrou.removeListener('error', surPerte);
    if (verrouPerdu) verrou.release(verrouPerdu);
    else {
      await verrou.query('SELECT pg_advisory_unlock($1, $2::int)', [CLE_DEMANDE, demande.id]).catch(() => {});
      verrou.release();
    }
  }
}

/** Le résultat propre à l'action, lu après la commande. */
async function resultatDe(principal, demande, copie, avant, sortie) {
  if (demande.action === 'campagne') {
    const { rows: [c] } = await principal.query(
      `SELECT c.id, c.libelle, c.statut, c.release, c.tests, c.reussis, c.echoues, c.erreurs, c.omis, c.a_faire, c.operations
       FROM pilotage.demande d JOIN recette.v_campagne c ON c.id = d.campagne_id WHERE d.id = $1`,
      [demande.id],
    );
    return { campagne: c ?? null };
  }
  if (demande.action === 'cycle') {
    const apres = entreesDeJournal(copie);
    const nouvelles = [...apres.keys()].filter((k) => !avant.has(k) || avant.get(k) !== apres.get(k)).sort();
    const chemin = nouvelles.at(-1);
    if (!chemin) return { entree: null };
    try {
      const contenu = JSON.parse(JSON.stringify(parse(readFileSync(join(copie, chemin), 'utf8')) ?? null, (_, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)));
      return { entree: { chemin, contenu } };
    } catch (e) {
      sortie.ajouter(`\n[entrée ${chemin} illisible : ${e.message}]\n`);
      return { entree: { chemin, contenu: null, erreur: e.message } };
    }
  }
  if (demande.action === 'valider') {
    const lignes = sortie.valeur().split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('[') && !l.startsWith('$') && !l.startsWith('{'));
    return { conclusion: lignes.at(-1) ?? null };
  }
  return null;
}

// ── Le service ──────────────────────────────────────────────────────────────

/**
 * La veille des campagnes : une campagne « en cours » qu'aucun lanceur ne tient
 * (lanceur tué, conteneur arrêté net), vue ainsi à deux rondes de suite, est
 * close comme interrompue. Une campagne naît sous son verrou (recette/lancer.mjs) ;
 * la double observation laisse en paix les campagnes d'essai que la recette
 * tient un instant sans verrou. `ids` borne la veille à ces numéros (essais).
 * Rend la fonction d'une ronde, qui rend les campagnes closes.
 */
export function veilleurCampagnes(principal, { ids = null } = {}) {
  let vues = new Set();
  return async () => {
    const { libres, closes } = await examinerOrphelines(principal, { ids, clore: (id) => vues.has(id) });
    vues = new Set(libres.filter((id) => !closes.includes(id)));
    return closes;
  };
}

/**
 * Au démarrage, les données du dépôt (modèle, manifestes, journal, workflows)
 * rechargées depuis une copie : après un git pull et un redémarrage,
 * l'interface montre le dépôt déployé. Jamais pendant une campagne, qui les
 * recharge elle-même et dont les tests les interrogent. Rend le compte, ou null.
 */
export async function rechargerAuDemarrage(principal, { source = process.env.RECETTE_DEPOT || RACINE, chargeur = chargerHorsCampagne, garde = campagneVivante } = {}) {
  let copie = null;
  try {
    copie = mkdtempSync(join(tmpdir(), 'demarrage-'));
    copierDepot(source, copie);
    const { vivante, compte } = await rechargerSaufCampagne(principal, copie, { chargeur, garde });
    if (vivante) {
      journal(`données du dépôt laissées telles quelles : la campagne n° ${vivante} est en cours`);
      return null;
    }
    journal(`données du dépôt rechargées : ${compte.modele} modèle, ${compte.manifeste} manifeste(s), ${compte.journal} entrée(s) de journal, ${compte.workflows} catalogue de workflows, ${compte.ci} workflow(s) de CI`);
    return compte;
  } catch (e) {
    journal(`données du dépôt non rechargées : ${e.message}`);
    return null;
  } finally {
    if (copie) rmSync(copie, { recursive: true, force: true });
  }
}

/** Signe de vie : la ligne de l'exécuteur et le fichier du bilan de santé. */
async function signalerVie(principal, { nom, file, demandeId, demon, vivant }) {
  await principal.query(
    `INSERT INTO pilotage.executeur (nom, file, demarre_le, vu_le, docker_demon, demande_id) VALUES ($1, $2, now(), now(), $3, $4)
     ON CONFLICT (nom) DO UPDATE SET file = EXCLUDED.file, vu_le = now(), docker_demon = EXCLUDED.docker_demon, demande_id = EXCLUDED.demande_id`,
    [nom, file, demon, demandeId],
  );
  if (vivant) writeFileSync(vivant, new Date().toISOString());
}

/**
 * Sert la file jusqu'à l'arrêt (SIGTERM, SIGINT, ou `signal` d'un
 * AbortController) ; avec `une`, traite au plus une demande. Rend le nombre de
 * demandes traitées.
 */
export async function servir(pools, { nom = process.env.EXECUTEUR_NOM || hostname(), file = process.env.EXECUTEUR_FILE || FILE_PRINCIPALE, une = false, vivant = process.env.EXECUTEUR_VIVANT || '/tmp/executeur.vivant', signal = null, ...options } = {}) {
  const { principal } = pools;
  const appliquees = await migrer(principal);
  if (appliquees.length) journal(`migrations appliquées : ${appliquees.join(', ')}`);
  const orphelines = await cloreOrphelines(principal, { file });
  if (orphelines.length) journal(`demande(s) restée(s) en cours, closes comme interrompues : ${orphelines.join(', ')}`);
  const demon = spawnSync('docker', ['info'], { timeout: 15000 }).status === 0;
  journal(`file ${file}, nom ${nom}, démon Docker ${demon ? 'joignable' : 'injoignable'}, base ${urlMasquee(process.env.RECETTE_PG_URL ?? '')}`);

  let arret = false;
  let reveil = null;
  const reveiller = () => { if (reveil) { const r = reveil; reveil = null; r(); } };
  const arreter = () => { arret = true; journal('arrêt demandé'); reveiller(); };
  process.once('SIGTERM', arreter);
  process.once('SIGINT', arreter);
  if (signal) { if (signal.aborted) arret = true; else signal.addEventListener('abort', arreter, { once: true }); }
  // Après les gestionnaires : un arrêt pendant le rechargement le laisse finir (et retirer sa copie)
  if (!une) await rechargerAuDemarrage(principal, options);

  // L'écoute ne fait que réveiller plus tôt : perdue, elle est reprise ; le sondage suffit entre-temps.
  // `ecoute` : { client, rendre } ; rendre() détache nos écouteurs avant de rendre le client au pool.
  let ecoute = null;
  const ecouter = async () => {
    let client = null;
    let rendu = false;
    const surErreur = (e) => {
      journal(`écoute perdue (${e.message}) : sondage seul jusqu'à sa reprise`);
      if (ecoute?.client === client) ecoute = null;
      rendre(e);
    };
    const rendre = (e) => {
      if (rendu) return;
      rendu = true;
      client.removeListener('error', surErreur);
      client.removeListener('notification', reveiller);
      client.release(e);
    };
    try {
      client = await principal.connect();
      client.on('error', surErreur);
      client.on('notification', reveiller);
      await client.query('LISTEN pilotage_demande');
      ecoute = { client, rendre };
    } catch (e) {
      journal(`écoute impossible (${e.message}) : sondage seul`);
      if (client) rendre(e);
    }
  };
  await ecouter();
  let enCours = null;
  const vie = () => signalerVie(principal, { nom, file, demandeId: enCours, demon, vivant: une ? null : vivant }).catch((e) => journal(`signe de vie impossible : ${e.message}`));
  await vie();
  const minuterieVie = setInterval(vie, VIE_MS);
  // La veille des campagnes, en service continu seulement ; une ronde à la fois
  const veiller = veilleurCampagnes(principal);
  let ronde = null;
  const veille = () => {
    ronde ??= veiller()
      .then((closes) => { if (closes.length) journal(`campagne(s) restée(s) en cours sans lanceur, closes comme interrompues : ${closes.join(', ')}`); })
      .catch((e) => journal(`veille des campagnes impossible : ${e.message}`))
      .finally(() => { ronde = null; });
    return ronde;
  };
  const minuterieVeille = une ? null : setInterval(veille, VEILLE_MS);
  if (!une) veille();
  const attendre = () => new Promise((ok) => { reveil = ok; setTimeout(reveiller, SONDAGE_MS).unref(); });
  let traitees = 0;
  try {
    while (!arret) {
      let pris = null;
      try {
        if (!ecoute) await ecouter();
        pris = await reclamer(principal, { nom, file });
      } catch (e) {
        // Base momentanément injoignable : on réessaie au prochain sondage
        journal(`réclamation impossible (${e.message}) : nouvel essai dans ${SONDAGE_MS / 1000} s`);
        if (une) break;
        await attendre();
        continue;
      }
      if (pris) {
        enCours = pris.demande.id;
        await vie();
        journal(`demande n° ${pris.demande.id} : ${pris.demande.action}`);
        const close = await executer(pools, pris, { ...options, arretGeneral: () => arret });
        journal(`demande n° ${close?.id ?? pris.demande.id} : ${close?.statut ?? 'inconnu'} (code ${close?.code_retour ?? '—'})`);
        enCours = null;
        traitees += 1;
        await vie();
        if (une) break;
        continue;
      }
      if (une) break;
      await attendre();
    }
  } finally {
    clearInterval(minuterieVie);
    if (minuterieVeille) clearInterval(minuterieVeille);
    await ronde;
    process.removeListener('SIGTERM', arreter);
    process.removeListener('SIGINT', arreter);
    signal?.removeEventListener('abort', arreter);
    if (ecoute) {
      const { client, rendre } = ecoute;
      ecoute = null;
      await client.query('UNLISTEN *').catch(() => {});
      rendre();
    }
  }
  return traitees;
}

export async function main(argv = process.argv.slice(2)) {
  let a;
  try {
    a = parseArgs({ args: argv, options: { une: { type: 'boolean', default: false }, aide: { type: 'boolean', short: 'h', default: false } }, strict: true });
  } catch (e) {
    process.stderr.write(`executeur : ${e.message}\nusage : node recette/executeur.mjs [--une]\n`);
    return 2;
  }
  if (a.values.aide) { process.stdout.write('usage : node recette/executeur.mjs [--une]\n'); return 0; }
  let pools;
  try {
    pools = ouvrir({ nom: 'recette-7e-executeur' });
    await pools.principal.query('SELECT 1');
  } catch (e) {
    process.stderr.write(`executeur : base injoignable : ${e.message}\n`);
    if (pools) await fermer(pools).catch(() => {});
    return 3;
  }
  try {
    await servir(pools, { une: a.values.une });
    return 0;
  } catch (e) {
    process.stderr.write(`executeur : ${e.stack ?? e.message}\n`);
    return 1;
  } finally {
    await fermer(pools).catch(() => {});
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then((code) => { process.exitCode = code; });
}
