#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  interface/serveur.mjs : l'interface de recette
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Une application web rendue côté serveur (node:http et pg, sans framework ni
 *  JavaScript dans le navigateur) pour manipuler les données de la recette :
 *
 *    Tableau de bord   pilotage (exécuteur, demandes, dernier cycle, binôme),
 *                      dernière campagne, catalogue, capacité
 *    Workflows, Déclencheurs, Suivi
 *                      les workflows des projets, ce qui les lance, où ils en
 *                      sont ; quatre actions se déclenchent d'ici, exécutées
 *                      par l'exécuteur (interface/pilotage.mjs)
 *    Campagnes         liste, détail filtrable, résultat de chaque opération
 *    Tests             catalogue (fichiers et base), historique d'un test ;
 *                      création et édition des tests définis en base et de
 *                      leurs opérations (16 au plus), essai d'une opération
 *                      en lecture seule avant de l'enregistrer
 *    Comparer          régressions, corrections, nouveaux et disparus
 *    Données           les fichiers YAML chargés, les vues SQL disponibles
 *    Import et export  tests-definis.yaml, dans les deux sens
 *
 *  Sûreté : écoute sur 127.0.0.1 par défaut (INTERFACE_HOTE) ; en-tête Host
 *  limité aux noms permis (localhost, 127.0.0.1, ::1 et INTERFACE_HOTES_PERMIS),
 *  contre le rebond DNS ; formulaires protégés par jeton et contrôle
 *  d'origine ; requêtes paramétrées ; essais
 *  d'opérations sous le rôle de lecture, en lecture seule et sous délai ;
 *  authentification HTTP facultative (INTERFACE_UTILISATEUR et
 *  INTERFACE_MOT_DE_PASSE) ; en-têtes de sécurité stricts (CSP sans script).
 *
 *  Variables : RECETTE_PG_URL, RECETTE_PG_LECTURE_URL, INTERFACE_HOTE (défaut
 *  127.0.0.1), INTERFACE_PORT (défaut 8080), INTERFACE_HOTES_PERMIS (noms
 *  d'hôte de plus, séparés par des virgules), INTERFACE_UTILISATEUR et
 *  INTERFACE_MOT_DE_PASSE (les deux, ou aucun).
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { enTransaction, fermer, joignable, jsonPourPg, migrer, ouvrir, urlMasquee } from '../recette/base.mjs';
import { COMPARAISONS, FONCTIONS, LIGNES_MAX, exporter, importer, jsonComplet, obtenir, validerOperation, verifier } from '../recette/definis.mjs';
import { MAX_OPERATIONS } from '../tests/outils/etapes.mjs';
import { FILE_PRINCIPALE } from '../recette/pilotage.mjs';
import { ErreurHttp, envoyer, entier, messageDe, rediriger } from './commun.mjs';
import { ROUTES_PILOTAGE, sectionPilotage } from './pilotage.mjs';
import {
  boutonPost, brut, champ, date, duree, fiche, html, libelleStatut, nombre, page, pagination,
  recapitulatifErreurs, statut, tableau, valeurJson,
} from './vues.mjs';

const ICI = dirname(fileURLToPath(import.meta.url));
const STYLE = readFileSync(join(ICI, 'style.css'));

const STATUTS_TEST = ['reussi', 'echoue', 'erreur', 'omis', 'a_faire'];
const LIBELLES_COMPARAISON = {
  egal: 'égal à l’attendu', contient: 'contient l’attendu', nombre_lignes: 'nombre de lignes',
  vide: 'aucune ligne', non_vide: 'au moins une ligne', tolerance: 'égal à la tolérance près',
};

async function lireCorps(req, limite = 2_000_000) {
  const type = req.headers['content-type'] ?? '';
  if (!type.startsWith('application/x-www-form-urlencoded')) throw new ErreurHttp(415, 'Formulaire attendu (application/x-www-form-urlencoded).');
  let taille = 0;
  const morceaux = [];
  for await (const m of req) {
    taille += m.length;
    if (taille > limite) throw new ErreurHttp(413, 'Formulaire trop volumineux.');
    morceaux.push(m);
  }
  return new URLSearchParams(Buffer.concat(morceaux).toString('utf8'));
}

/** Noms d'hôte toujours permis : l'interface ne sert que la machine où elle tourne. */
export const HOTES_LOCAUX = ['localhost', '127.0.0.1', '[::1]'];

/** Le nom d'hôte d'un en-tête Host ou d'une origine (« [::1] » pour IPv6), en minuscules. */
function nomHote(valeur, prefixe = 'http://') {
  try {
    return new URL(valeur.includes('://') ? valeur : prefixe + valeur).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * L'en-tête Host doit nommer un hôte permis : sans cette garde, une page tierce
 * dont le nom DNS se rebat sur 127.0.0.1 (rebond DNS) lirait les pages et le
 * jeton des formulaires, Origin et Host étant alors tous deux les siens.
 */
function verifierHote(app, req) {
  const hote = nomHote(String(req.headers.host ?? ''));
  if (!hote || !app.hotes.has(hote)) {
    throw new ErreurHttp(421, `Hôte non permis : ${String(req.headers.host ?? '(aucun)').slice(0, 100)}. Ouvrir l’interface par 127.0.0.1 ou localhost, ou déclarer ce nom dans INTERFACE_HOTES_PERMIS.`);
  }
}

function verifierFormulaire(app, req, corps) {
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) throw new ErreurHttp(403, 'Formulaire venu d’un autre site : refusé.');
  const origine = req.headers.origin;
  if (origine && origine !== 'null') {
    let hote = null;
    try { hote = new URL(origine).host; } catch { /* origine illisible */ }
    if (hote !== req.headers.host || !app.hotes.has(nomHote(origine))) throw new ErreurHttp(403, 'Origine du formulaire refusée.');
  }
  const recu = Buffer.from(corps.get('_csrf') ?? '');
  const attendu = Buffer.from(app.csrf);
  if (recu.length !== attendu.length || !timingSafeEqual(recu, attendu)) {
    throw new ErreurHttp(403, 'Jeton de formulaire invalide ou périmé : rechargez la page, puis recommencez.');
  }
}

function autorise(app, req) {
  if (!app.identifiants) return true;
  const [type, valeur] = String(req.headers.authorization ?? '').split(' ');
  if (type !== 'Basic' || !valeur) return false;
  const recu = Buffer.from(Buffer.from(valeur, 'base64').toString('utf8'));
  const attendu = Buffer.from(`${app.identifiants.utilisateur}:${app.identifiants.motDePasse}`);
  return recu.length === attendu.length && timingSafeEqual(recu, attendu);
}

// ── Lectures communes ────────────────────────────────────────────────────────
async function campagneOu404(db, id) {
  const { rows: [c] } = await db.query('SELECT * FROM recette.v_campagne WHERE id = $1', [id]);
  if (!c) throw new ErreurHttp(404, `Aucune campagne n° ${id}.`);
  return c;
}

async function testOu404(db, id) {
  const { rows: [t] } = await db.query('SELECT * FROM recette.v_test WHERE id = $1', [id]);
  if (!t) throw new ErreurHttp(404, `Aucun test n° ${id}.`);
  return t;
}

const lienCampagne = (c) => html`<a href="/campagnes/${c.id}">Campagne n° ${c.id}</a>`;
const nomTest = (t) => (t.suite ? html`<span class="suite">${t.suite} › </span>${t.libelle}` : html`${t.libelle}`);

function lignesCampagnes(campagnes) {
  return campagnes.map((c) => [
    lienCampagne(c), c.libelle, date(c.debut), duree(c.duree_s), statut(c.statut),
    nombre(c.tests), nombre(c.reussis), nombre(Number(c.echoues) + Number(c.erreurs)), nombre(c.omis), nombre(c.a_faire), nombre(c.operations),
  ]);
}
const COLONNES_CAMPAGNES = ['Campagne', 'Libellé', 'Début', { texte: 'Durée', nombre: true }, 'Statut', { texte: 'Tests', nombre: true },
  { texte: 'Réussis', nombre: true }, { texte: 'En échec', nombre: true }, { texte: 'Omis', nombre: true }, { texte: 'À faire', nombre: true }, { texte: 'Opérations', nombre: true }];

// ── Pages ────────────────────────────────────────────────────────────────────
async function tableauDeBord({ app, url }) {
  const db = app.principal;
  const { rows: campagnes } = await db.query('SELECT * FROM recette.v_campagne ORDER BY id DESC LIMIT 10');
  const { rows: [cat] } = await db.query(`
    SELECT count(*) FILTER (WHERE origine = 'fichier') AS fichier, count(*) FILTER (WHERE origine = 'base') AS base,
           (SELECT count(*) FROM recette.operation) AS operations,
           (SELECT coalesce(max(n), 0) FROM (SELECT count(*) AS n FROM recette.operation GROUP BY test_id) x) AS max_operations
    FROM recette.test`);
  const derniere = campagnes[0];
  const contenu = html`<h1>Tableau de bord</h1>
${await sectionPilotage(app)}
${derniere ? html`<h2>Dernière campagne</h2>
${fiche([
    ['Campagne', lienCampagne(derniere)], ['Libellé', derniere.libelle], ['Statut', statut(derniere.statut)], ['Début', date(derniere.debut)],
    ['Durée', duree(derniere.duree_s)], ['Tests', nombre(derniere.tests)], ['Réussis', nombre(derniere.reussis)],
    ['En échec ou en erreur', nombre(Number(derniere.echoues) + Number(derniere.erreurs))], ['Omis', nombre(derniere.omis)],
    ['À faire', nombre(derniere.a_faire)], ['Opérations', nombre(derniere.operations)], ['Release examinée', derniere.release ?? '—'],
  ])}
<p class="actions"><a href="/campagnes/${derniere.id}">Voir le détail de la campagne n° ${derniere.id}</a>
${campagnes[1] ? html`<a href="/comparer?a=${campagnes[1].id}&amp;b=${derniere.id}">Comparer avec la campagne n° ${campagnes[1].id}</a>` : ''}</p>`
    : html`<p>Aucune campagne n’a encore été lancée : <a href="/declencheurs#action-campagne">en demander une</a>, ou depuis la VM de recette :</p>
<pre><code>docker compose -f compose.recette.yaml --env-file .env.recette run --rm recette campagne</code></pre>`}
<h2>Catalogue</h2>
${fiche([
    ['Tests des suites du dépôt', nombre(cat.fichier)], ['Tests définis en base', nombre(cat.base)],
    ['Opérations au catalogue', nombre(cat.operations)], ['Opérations du plus long test', `${nombre(cat.max_operations)} sur ${MAX_OPERATIONS} permises`],
  ])}
<p class="actions"><a class="bouton" href="/tests/nouveau">Définir un nouveau test en base</a> <a href="/tests">Parcourir le catalogue</a></p>
<h2>Dix dernières campagnes</h2>
${tableau({ legende: 'Les dix dernières campagnes, de la plus récente à la plus ancienne', colonnes: COLONNES_CAMPAGNES, lignes: lignesCampagnes(campagnes), vide: 'Aucune campagne.' })}`;
  return page({ titre: 'Tableau de bord', actif: 'tableau', contenu, message: messageDe(url) });
}

async function listeCampagnes({ app, url }) {
  const db = app.principal;
  const n = Math.max(1, entier(url.searchParams.get('page'), 1));
  const parPage = 50;
  const { rows: [{ total }] } = await db.query('SELECT count(*) AS total FROM recette.campagne');
  const { rows } = await db.query('SELECT * FROM recette.v_campagne ORDER BY id DESC LIMIT $1 OFFSET $2', [parPage, (n - 1) * parPage]);
  const contenu = html`<h1>Campagnes</h1>
<p>${nombre(total)} campagne(s) enregistrée(s). Une campagne exécute les suites du dépôt puis les tests définis en base.</p>
${tableau({ legende: `Campagnes, page ${n}`, colonnes: COLONNES_CAMPAGNES, lignes: lignesCampagnes(rows), vide: 'Aucune campagne.' })}
${pagination({ page: n, total: Number(total), parPage, base: '/campagnes' })}`;
  return page({ titre: n > 1 ? `Campagnes, page ${n}` : 'Campagnes', actif: 'campagnes', fil: [['/', 'Accueil'], [null, 'Campagnes']], contenu });
}

async function detailCampagne({ app, url, params }) {
  const db = app.principal;
  const id = Number(params[0]);
  const c = await campagneOu404(db, id);
  const filtreStatut = url.searchParams.get('statut') ?? '';
  const filtreFichier = url.searchParams.get('fichier') ?? '';
  const recherche = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
  const { rows: fichiers } = await db.query('SELECT DISTINCT fichier FROM recette.v_execution WHERE campagne_id = $1 AND fichier IS NOT NULL ORDER BY fichier', [id]);
  const conditions = ['campagne_id = $1'];
  const valeurs = [id];
  if (filtreStatut === 'en_echec') conditions.push("statut IN ('echoue', 'erreur')");
  else if (STATUTS_TEST.includes(filtreStatut)) { valeurs.push(filtreStatut); conditions.push(`statut = $${valeurs.length}`); }
  if (filtreFichier === 'base') conditions.push('fichier IS NULL');
  else if (filtreFichier) { valeurs.push(filtreFichier); conditions.push(`fichier = $${valeurs.length}`); }
  if (recherche) { valeurs.push(`%${recherche.replace(/[\\%_]/g, (x) => `\\${x}`)}%`); conditions.push(`nom_complet ILIKE $${valeurs.length}`); }
  const { rows } = await db.query(
    `SELECT * FROM recette.v_execution WHERE ${conditions.join(' AND ')}
     ORDER BY array_position(ARRAY['echoue', 'erreur', 'a_faire', 'omis', 'reussi'], statut), fichier NULLS LAST, nom_complet LIMIT 2000`,
    valeurs,
  );
  const { rows: [precedente] } = await db.query('SELECT id FROM recette.campagne WHERE id < $1 ORDER BY id DESC LIMIT 1', [id]);
  const filtre = Boolean(filtreStatut || filtreFichier || recherche);
  const contenu = html`<h1>Campagne n° ${id} : ${c.libelle}</h1>
${fiche([
    ['Statut', statut(c.statut)], ['Début', date(c.debut)], ['Fin', date(c.fin)], ['Durée', duree(c.duree_s)],
    ['Release examinée', c.release ?? '—'], ['Version du modèle', c.modele_version ?? '—'], ['Machine', c.machine ?? '—'],
    ['Node', c.node_version ?? '—'], ['Démon Docker', c.docker_demon === null ? '—' : c.docker_demon ? 'joignable' : 'injoignable'],
    ['Tests', nombre(c.tests)], ['Réussis', nombre(c.reussis)], ['En échec', nombre(c.echoues)], ['En erreur', nombre(c.erreurs)],
    ['Omis', nombre(c.omis)], ['À faire', nombre(c.a_faire)], ['Opérations', `${nombre(c.operations)} (${nombre(c.operations_en_echec)} en échec)`],
  ])}
${precedente ? html`<p><a href="/comparer?a=${precedente.id}&amp;b=${id}">Comparer avec la campagne précédente (n° ${precedente.id})</a></p>` : ''}
<h2>Tests exécutés</h2>
<form method="get" action="/campagnes/${id}" class="filtres" role="search" aria-label="Filtrer les tests de la campagne">
${champ({ id: 'f-statut', nom: 'statut', etiquette: 'Statut', valeur: filtreStatut, options: [['', 'Tous'], ['en_echec', 'En échec ou en erreur'], ...STATUTS_TEST.map((s) => [s, libelleStatut(s)])] })}
${champ({ id: 'f-fichier', nom: 'fichier', etiquette: 'Origine', valeur: filtreFichier, options: [['', 'Toutes'], ['base', 'Tests définis en base'], ...fichiers.map((f) => [f.fichier, f.fichier])] })}
${champ({ id: 'f-q', nom: 'q', etiquette: 'Nom contient', type: 'search', valeur: recherche })}
<button type="submit">Filtrer</button>
${filtre ? html`<a href="/campagnes/${id}">Retirer les filtres</a>` : ''}
</form>
${tableau({
    legende: `${nombre(rows.length)} test(s)${filtre ? ' correspondant aux filtres' : ''}, les échecs d’abord`,
    colonnes: ['Test', 'Origine', 'Statut', { texte: 'Opérations', nombre: true }, { texte: 'En échec', nombre: true }, { texte: 'Durée', nombre: true }],
    lignes: rows.map((e) => [
      html`<a href="/campagnes/${id}/tests/${e.test_id}">${nomTest(e)}</a>`, e.fichier ?? 'base', statut(e.statut),
      nombre(e.operations), nombre(e.operations_en_echec), duree(e.duree_ms === null ? null : Number(e.duree_ms) / 1000),
    ]),
    vide: 'Aucun test ne correspond.',
  })}`;
  return page({ titre: `Campagne n° ${id}`, actif: 'campagnes', fil: [['/', 'Accueil'], ['/campagnes', 'Campagnes'], [null, `Campagne n° ${id}`]], contenu });
}

async function detailExecution({ app, params }) {
  const db = app.principal;
  const [campagneId, testId] = params.map(Number);
  await campagneOu404(db, campagneId);
  const { rows: [e] } = await db.query('SELECT * FROM recette.v_execution WHERE campagne_id = $1 AND test_id = $2', [campagneId, testId]);
  if (!e) throw new ErreurHttp(404, `Le test n° ${testId} n’a pas été exécuté dans la campagne n° ${campagneId}.`);
  const { rows: resultats } = await db.query('SELECT * FROM recette.resultat WHERE execution_id = $1 ORDER BY ordre', [e.id]);
  const { rows: catalogue } = await db.query('SELECT ordre, libelle FROM recette.operation WHERE test_id = $1 ORDER BY ordre', [testId]);
  const vus = new Set(resultats.map((r) => r.ordre));
  const lignes = [
    ...resultats.map((r) => ({ ordre: r.ordre, cellules: [String(r.ordre), r.libelle, statut(r.statut), valeurJson(r.attendu, { resume: 'attendu' }), valeurJson(r.obtenu, { resume: 'obtenu' }), r.message ? html`<pre>${r.message}</pre>` : '—', duree(r.duree_ms === null ? null : Number(r.duree_ms) / 1000)] })),
    ...catalogue.filter((o) => !vus.has(o.ordre)).map((o) => ({ ordre: o.ordre, cellules: [String(o.ordre), o.libelle, statut('non_executee'), '—', '—', 'non exécutée dans cette campagne', '—'] })),
  ].sort((a, b) => a.ordre - b.ordre).map((l) => l.cellules);
  const contenu = html`<h1>${e.libelle}</h1>
${fiche([
    ['Campagne', html`<a href="/campagnes/${campagneId}">n° ${campagneId}</a>`], ['Origine', e.fichier ?? 'test défini en base'],
    ['Suite', e.suite ?? '—'], ['Statut', statut(e.statut)], ['Durée', duree(e.duree_ms === null ? null : Number(e.duree_ms) / 1000)],
    ['Opérations', `${nombre(e.operations)} exécutée(s), ${nombre(e.operations_en_echec)} en échec`],
  ])}
${e.motif ? html`<h2>Motif</h2><pre>${e.motif}</pre>` : ''}
<h2>Opérations</h2>
${tableau({ legende: `Opérations du test, ${MAX_OPERATIONS} au plus`, colonnes: [{ texte: 'Rang', nombre: true }, 'Libellé', 'Statut', 'Attendu', 'Obtenu', 'Message', { texte: 'Durée', nombre: true }], lignes, vide: 'Ce test ne déclare aucune opération.' })}
<p><a href="/tests/${testId}">Historique et fiche du test</a></p>`;
  return page({ titre: `${e.libelle} · campagne n° ${campagneId}`, actif: 'campagnes', fil: [['/', 'Accueil'], ['/campagnes', 'Campagnes'], [`/campagnes/${campagneId}`, `Campagne n° ${campagneId}`], [null, e.libelle]], contenu });
}

async function comparer({ app, url }) {
  const db = app.principal;
  const { rows: campagnes } = await db.query('SELECT id, libelle, debut FROM recette.campagne ORDER BY id DESC LIMIT 200');
  let a = entier(url.searchParams.get('a'));
  let b = entier(url.searchParams.get('b'));
  if (a === null && b === null && campagnes.length >= 2) { a = campagnes[1].id; b = campagnes[0].id; }
  const options = campagnes.map((c) => [c.id, `n° ${c.id} : ${c.libelle}`]);
  let resultat = '';
  if (a !== null && b !== null) {
    await campagneOu404(db, a);
    await campagneOu404(db, b);
    const { rows } = await db.query('SELECT * FROM recette.comparer($1, $2) ORDER BY fichier NULLS LAST, nom_complet', [a, b]);
    const groupes = ['regression', 'correction', 'changement', 'nouveau', 'disparu'];
    const titres = { regression: 'Régressions', correction: 'Corrections', changement: 'Autres changements de statut', nouveau: 'Nouveaux tests', disparu: 'Tests disparus' };
    const identiques = rows.filter((r) => r.changement === 'identique').length;
    resultat = html`<h2>Campagne n° ${a} → campagne n° ${b}</h2>
${fiche([...groupes.map((g) => [titres[g], nombre(rows.filter((r) => r.changement === g).length)]), ['Inchangés', nombre(identiques)]])}
${groupes.map((g) => {
    const lot = rows.filter((r) => r.changement === g);
    if (!lot.length) return '';
    return html`<h3>${titres[g]}</h3>${tableau({
      legende: `${titres[g]} (${lot.length})`,
      colonnes: ['Test', 'Origine', `Campagne n° ${a}`, `Campagne n° ${b}`],
      lignes: lot.map((r) => [html`<a href="/tests/${r.test_id}">${r.nom_complet}</a>`, r.fichier ?? 'base', r.statut_a ? statut(r.statut_a) : '—', r.statut_b ? statut(r.statut_b) : '—']),
    })}`;
  })}`;
  }
  const contenu = html`<h1>Comparer deux campagnes</h1>
${campagnes.length < 2 ? html`<p>Il faut au moins deux campagnes pour comparer.</p>` : html`<form method="get" action="/comparer" class="filtres">
${champ({ id: 'c-a', nom: 'a', etiquette: 'Campagne de référence', valeur: a ?? '', options })}
${champ({ id: 'c-b', nom: 'b', etiquette: 'Campagne comparée', valeur: b ?? '', options })}
<button type="submit">Comparer</button>
</form>`}
${resultat}`;
  return page({ titre: a !== null && b !== null ? `Comparaison ${a} → ${b}` : 'Comparer', actif: 'comparer', fil: [['/', 'Accueil'], [null, 'Comparer']], contenu });
}

async function listeTests({ app, url }) {
  const db = app.principal;
  const origine = url.searchParams.get('origine') ?? '';
  const recherche = (url.searchParams.get('q') ?? '').trim().slice(0, 200);
  const dernier = url.searchParams.get('statut') ?? '';
  const conditions = ['true'];
  const valeurs = [];
  if (['fichier', 'base'].includes(origine)) { valeurs.push(origine); conditions.push(`origine = $${valeurs.length}`); }
  if (STATUTS_TEST.includes(dernier)) { valeurs.push(dernier); conditions.push(`dernier_statut = $${valeurs.length}`); }
  if (recherche) { valeurs.push(`%${recherche.replace(/[\\%_]/g, (x) => `\\${x}`)}%`); conditions.push(`nom_complet ILIKE $${valeurs.length}`); }
  const { rows } = await db.query(`SELECT * FROM recette.v_test WHERE ${conditions.join(' AND ')} ORDER BY origine DESC, fichier NULLS FIRST, nom_complet LIMIT 2000`, valeurs);
  const contenu = html`<h1>Tests</h1>
<p>Le catalogue réunit les tests des suites du dépôt (leurs opérations sont les étapes que le code déclare, en lecture seule ici) et les tests définis en base, éditables, de ${MAX_OPERATIONS} opérations au plus.</p>
<p class="actions"><a class="bouton" href="/tests/nouveau">Définir un nouveau test en base</a></p>
<form method="get" action="/tests" class="filtres" role="search" aria-label="Filtrer le catalogue">
${champ({ id: 't-origine', nom: 'origine', etiquette: 'Origine', valeur: origine, options: [['', 'Toutes'], ['base', 'Définis en base'], ['fichier', 'Suites du dépôt']] })}
${champ({ id: 't-statut', nom: 'statut', etiquette: 'Dernier statut', valeur: dernier, options: [['', 'Tous'], ...STATUTS_TEST.map((s) => [s, libelleStatut(s)])] })}
${champ({ id: 't-q', nom: 'q', etiquette: 'Nom contient', type: 'search', valeur: recherche })}
<button type="submit">Filtrer</button>
</form>
${tableau({
    legende: `${nombre(rows.length)} test(s)`,
    colonnes: ['Test', 'Origine', { texte: 'Opérations', nombre: true }, 'Dernier statut', 'Actif'],
    lignes: rows.map((t) => [html`<a href="/tests/${t.id}">${nomTest(t)}</a>`, t.fichier ?? 'base', `${nombre(t.operations)} / ${MAX_OPERATIONS}`, t.dernier_statut ? statut(t.dernier_statut) : '—', t.actif ? 'oui' : 'non']),
    vide: 'Aucun test ne correspond.',
  })}`;
  return page({ titre: 'Tests', actif: 'tests', fil: [['/', 'Accueil'], [null, 'Tests']], contenu });
}

function formulaireTestHtml(app, { action, valeurs = {}, erreurs = {}, titreBouton }) {
  return html`${recapitulatifErreurs(erreurs, { nom: 'test-nom', description: 'test-description' })}
<form method="post" action="${action}" novalidate>
<input type="hidden" name="_csrf" value="${app.csrf}">
${champ({ id: 'test-nom', nom: 'nom', etiquette: 'Nom du test', valeur: valeurs.nom ?? '', requis: true, erreur: erreurs.nom, aide: 'Unique parmi les tests définis en base. Exemple : « Journal : aucun 3 hors CI ».' })}
${champ({ id: 'test-description', nom: 'description', etiquette: 'Description', valeur: valeurs.description ?? '', zone: true, lignes: 3, erreur: erreurs.description, aide: 'Facultative : ce que le test protège, la règle du modèle qu’il éprouve.' })}
<div class="champ"><label><input type="checkbox" name="actif" value="1"${valeurs.actif === false ? '' : brut(' checked')}> Actif : exécuté à chaque campagne</label></div>
<div class="actions"><button type="submit">${titreBouton}</button></div>
</form>`;
}

function testDuFormulaire(corps) {
  const nom = (corps.get('nom') ?? '').trim();
  const description = (corps.get('description') ?? '').trim();
  const erreurs = {};
  if (!nom) erreurs.nom = 'Le nom est obligatoire.';
  else if (nom.length > 500) erreurs.nom = 'Le nom dépasse 500 caractères.';
  if (description.length > 5000) erreurs.description = 'La description dépasse 5 000 caractères.';
  return { valeurs: { nom, description, actif: corps.get('actif') === '1' }, erreurs };
}

async function formulaireTest({ app }) {
  const contenu = html`<h1>Nouveau test défini en base</h1>
<p>Un test défini en base porte au plus ${MAX_OPERATIONS} opérations : des requêtes SQL, exécutées en lecture seule sur les schémas donnees et recette, ou des appels de fonctions de la liste blanche.</p>
${formulaireTestHtml(app, { action: '/tests', titreBouton: 'Créer le test' })}`;
  return page({ titre: 'Nouveau test', actif: 'tests', fil: [['/', 'Accueil'], ['/tests', 'Tests'], [null, 'Nouveau test']], contenu });
}

const estDoublon = (e) => e?.code === '23505';

async function creerTest({ app, res, corps }) {
  const { valeurs, erreurs } = testDuFormulaire(corps);
  if (!Object.keys(erreurs).length) {
    try {
      const { rows: [{ id }] } = await app.principal.query(
        "INSERT INTO recette.test (origine, fichier, nom_complet, libelle, description, actif) VALUES ('base', NULL, $1, $1, $2, $3) RETURNING id",
        [valeurs.nom, valeurs.description || null, valeurs.actif],
      );
      return rediriger(res, `/tests/${id}?fait=test-cree`);
    } catch (e) {
      if (!estDoublon(e)) throw e;
      erreurs.nom = 'Un test défini en base porte déjà ce nom.';
    }
  }
  const contenu = html`<h1>Nouveau test défini en base</h1>${formulaireTestHtml(app, { action: '/tests', valeurs, erreurs, titreBouton: 'Créer le test' })}`;
  return { code: 422, corps: page({ titre: 'Erreur : nouveau test', actif: 'tests', fil: [['/', 'Accueil'], ['/tests', 'Tests'], [null, 'Nouveau test']], contenu }) };
}

async function detailTest({ app, url, params }, extra = {}) {
  const db = app.principal;
  const id = Number(params[0]);
  const t = await testOu404(db, id);
  const { rows: operations } = await db.query('SELECT * FROM recette.operation WHERE test_id = $1 ORDER BY ordre', [id]);
  const { rows: historique } = await db.query(
    `SELECT e.campagne_id, c.debut, e.statut, e.duree_ms,
            (SELECT count(*) FROM recette.resultat r WHERE r.execution_id = e.id AND r.statut <> 'reussie') AS en_echec
     FROM recette.execution e JOIN recette.campagne c ON c.id = e.campagne_id
     WHERE e.test_id = $1 ORDER BY e.campagne_id DESC LIMIT 30`, [id],
  );
  const editable = t.origine === 'base';
  const plein = operations.length >= MAX_OPERATIONS;
  const decrireOp = (o) => {
    if (o.nature === 'sql') return html`<pre><code>${o.requete}</code></pre>`;
    if (o.nature === 'fonction') return html`<code>${o.fonction}(${(o.arguments ?? []).map((x) => JSON.stringify(x)).join(', ')})</code>`;
    return html`<span class="vide">étape du code</span>`;
  };
  const lignesOps = operations.map((o, i) => {
    const cellules = [String(o.ordre), o.libelle, o.nature === 'etape' ? 'étape' : o.nature === 'sql' ? 'requête SQL' : 'fonction', decrireOp(o)];
    if (editable) {
      cellules.push(html`${LIBELLES_COMPARAISON[o.comparaison]}${o.comparaison === 'tolerance' ? ` (± ${o.tolerance})` : ''}`, ['vide', 'non_vide'].includes(o.comparaison) ? '—' : valeurJson(o.attendu, { resume: 'attendu' }));
      cellules.push(html`<div class="operations-actions">
<a href="/operations/${o.id}">Modifier<span class="visuellement-cache"> l’opération ${o.ordre}</span></a>
${i > 0 ? boutonPost({ action: `/operations/${o.id}/deplacer`, texte: 'Monter', csrf: app.csrf, classe: 'secondaire', champs: { sens: 'haut' }, etiquette: `Monter l’opération ${o.ordre}` }) : ''}
${i < operations.length - 1 ? boutonPost({ action: `/operations/${o.id}/deplacer`, texte: 'Descendre', csrf: app.csrf, classe: 'secondaire', champs: { sens: 'bas' }, etiquette: `Descendre l’opération ${o.ordre}` }) : ''}
${boutonPost({ action: `/operations/${o.id}/supprimer`, texte: 'Supprimer', csrf: app.csrf, classe: 'danger', etiquette: `Supprimer l’opération ${o.ordre}` })}
</div>`);
    }
    return cellules;
  });
  const colonnes = [{ texte: 'Rang', nombre: true }, 'Libellé', 'Nature', 'Définition', ...(editable ? ['Comparaison', 'Attendu', 'Actions'] : [])];
  const contenu = html`<h1>${t.libelle}</h1>
${fiche([
    ['Origine', t.origine === 'base' ? 'défini en base' : t.fichier], ['Suite', t.suite ?? '—'], ['Actif', t.actif ? 'oui' : 'non'],
    ['Opérations', `${operations.length} sur ${MAX_OPERATIONS} permises`], ['Dernier statut', t.dernier_statut ? statut(t.dernier_statut) : '—'],
    ['Créé le', date(t.cree_le)], ['Dernière exécution', date(t.vu_le)],
  ])}
${t.description ? html`<p>${t.description}</p>` : ''}
<h2>Opérations</h2>
${editable ? '' : html`<p>Les opérations d’un test de suite sont les étapes que déclare son code (tests/outils/etapes.mjs) ; le catalogue se met à jour à chaque campagne.</p>`}
${tableau({ legende: `Opérations, dans l’ordre d’exécution (${operations.length} sur ${MAX_OPERATIONS})`, colonnes, lignes: lignesOps, vide: 'Aucune opération pour l’instant.' })}
${editable ? (plein
    ? html`<p class="alerte" role="note">Ce test porte déjà ${MAX_OPERATIONS} opérations, le maximum : supprimez-en une pour en ajouter une autre, ou scindez le test.</p>`
    : html`<p class="actions"><a class="bouton" href="/tests/${id}/operations/nouvelle">Ajouter une opération (${operations.length + 1} sur ${MAX_OPERATIONS})</a></p>`) : ''}
<h2>Historique</h2>
${tableau({
    legende: 'Les trente dernières exécutions, de la plus récente à la plus ancienne',
    colonnes: ['Campagne', 'Date', 'Statut', { texte: 'Opérations en échec', nombre: true }, { texte: 'Durée', nombre: true }],
    lignes: historique.map((x) => [html`<a href="/campagnes/${x.campagne_id}/tests/${id}">n° ${x.campagne_id}</a>`, date(x.debut), statut(x.statut), nombre(x.en_echec), duree(x.duree_ms === null ? null : Number(x.duree_ms) / 1000)]),
    vide: 'Ce test n’a encore été exécuté par aucune campagne.',
  })}
${editable ? html`<h2>Modifier le test</h2>
${formulaireTestHtml(app, { action: `/tests/${id}`, valeurs: extra.valeurs ?? { nom: t.libelle, description: t.description ?? '', actif: t.actif }, erreurs: extra.erreurs ?? {}, titreBouton: 'Enregistrer le test' })}
<p><a href="/tests/${id}/supprimer">Supprimer ce test…</a></p>` : ''}`;
  return page({ titre: t.libelle, actif: 'tests', fil: [['/', 'Accueil'], ['/tests', 'Tests'], [null, t.libelle]], contenu, message: messageDe(url) });
}

async function testDefiniOu404(db, id) {
  const t = await testOu404(db, id);
  if (t.origine !== 'base') throw new ErreurHttp(409, 'Seuls les tests définis en base se modifient ici ; un test de suite se modifie dans son fichier.');
  return t;
}

async function modifierTest(ctx) {
  const { app, res, corps, params } = ctx;
  const id = Number(params[0]);
  await testDefiniOu404(app.principal, id);
  const { valeurs, erreurs } = testDuFormulaire(corps);
  if (!Object.keys(erreurs).length) {
    try {
      await app.principal.query('UPDATE recette.test SET nom_complet = $2, libelle = $2, description = $3, actif = $4, modifie_le = now() WHERE id = $1', [id, valeurs.nom, valeurs.description || null, valeurs.actif]);
      return rediriger(res, `/tests/${id}?fait=test-modifie`);
    } catch (e) {
      if (!estDoublon(e)) throw e;
      erreurs.nom = 'Un test défini en base porte déjà ce nom.';
    }
  }
  return { code: 422, corps: await detailTest(ctx, { valeurs, erreurs }) };
}

async function confirmerSuppressionTest({ app, params }) {
  const id = Number(params[0]);
  const t = await testDefiniOu404(app.principal, id);
  const contenu = html`<h1>Supprimer le test « ${t.libelle} » ?</h1>
<p>Ses ${nombre(t.operations)} opération(s) et tout son historique d’exécution seront supprimés. Cette action est définitive ; un export préalable (Import et export) permet de le recréer.</p>
<div class="actions">
${boutonPost({ action: `/tests/${id}/supprimer`, texte: 'Supprimer définitivement', csrf: app.csrf, classe: 'danger' })}
<a href="/tests/${id}">Annuler</a>
</div>`;
  return page({ titre: `Supprimer ${t.libelle}`, actif: 'tests', fil: [['/', 'Accueil'], ['/tests', 'Tests'], [`/tests/${id}`, t.libelle], [null, 'Supprimer']], contenu });
}

async function supprimerTest({ app, res, params }) {
  const id = Number(params[0]);
  await testDefiniOu404(app.principal, id);
  await app.principal.query("DELETE FROM recette.test WHERE id = $1 AND origine = 'base'", [id]);
  return rediriger(res, '/tests?fait=test-supprime');
}

// ── Opérations ───────────────────────────────────────────────────────────────
const CHAMPS_OPERATION = {
  libelle: 'op-libelle', nature: 'op-nature-sql', requete: 'op-requete', fonction: 'op-fonction',
  arguments: 'op-arguments', comparaison: 'op-comparaison', attendu: 'op-attendu', tolerance: 'op-tolerance',
};

/** Les champs saisis, et l'opération validée s'ils sont corrects. */
function operationDuFormulaire(corps) {
  const saisie = {
    libelle: corps.get('libelle') ?? '', nature: corps.get('nature') ?? '', requete: corps.get('requete') ?? '',
    fonction: corps.get('fonction') ?? '', arguments: corps.get('arguments') ?? '', comparaison: corps.get('comparaison') ?? 'egal',
    attendu: corps.get('attendu') ?? '', tolerance: corps.get('tolerance') ?? '',
  };
  const erreurs = {};
  const candidat = { libelle: saisie.libelle, comparaison: saisie.comparaison };
  if (saisie.nature === 'sql') {
    if (!saisie.requete.trim()) erreurs.requete = 'La requête SQL est obligatoire.';
    else candidat.sql = saisie.requete;
  } else if (saisie.nature === 'fonction') {
    if (!saisie.fonction) erreurs.fonction = 'Choisissez une fonction.';
    else candidat.fonction = saisie.fonction;
    if (saisie.arguments.trim()) {
      try { candidat.arguments = JSON.parse(saisie.arguments); } catch (e) { erreurs.arguments = `Les arguments ne sont pas du JSON lisible (${e.message}).`; }
    } else candidat.arguments = [];
  } else {
    erreurs.nature = 'Choisissez une requête SQL ou un appel de fonction.';
  }
  if (!['vide', 'non_vide'].includes(saisie.comparaison)) {
    if (!saisie.attendu.trim()) erreurs.attendu = 'L’attendu est obligatoire pour cette comparaison : une valeur JSON (35, "texte", [1, 2], null…).';
    else {
      try { candidat.attendu = JSON.parse(saisie.attendu); } catch (e) { erreurs.attendu = `L’attendu n’est pas du JSON lisible (${e.message}) ; un texte s’écrit entre guillemets.`; }
    }
  }
  if (saisie.comparaison === 'tolerance') {
    const t = Number(saisie.tolerance.replace(',', '.'));
    if (!saisie.tolerance.trim() || !Number.isFinite(t) || t < 0) erreurs.tolerance = 'La tolérance est un nombre positif ou nul (0,01 par exemple).';
    else candidat.tolerance = t;
  }
  // Toutes les erreurs d'un coup : celles de la saisie, puis celles du contrat d'opération
  const v = validerOperation(candidat);
  const toutes = { ...(v.erreurs ?? {}), ...erreurs };
  if (erreurs.requete || erreurs.fonction) delete toutes.nature;
  if (Object.keys(toutes).length) return { saisie, erreurs: toutes, operation: null, candidat };
  return { saisie, erreurs: {}, operation: v.operation, candidat };
}

const saisieDe = (o) => ({
  libelle: o.libelle, nature: o.nature, requete: o.requete ?? '', fonction: o.fonction ?? '',
  arguments: o.nature === 'fonction' ? JSON.stringify(o.arguments ?? []) : '', comparaison: o.comparaison,
  attendu: ['vide', 'non_vide'].includes(o.comparaison) ? '' : JSON.stringify(o.attendu, null, 2), tolerance: o.tolerance === null ? '' : String(o.tolerance),
});

function formulaireOperationHtml(app, { test, operation = null, saisie, erreurs = {}, essai = null }) {
  const action = operation ? `/operations/${operation.id}` : `/tests/${test.id}/operations`;
  const radio = (valeur, texte, id) => html`<label><input type="radio" id="${id}" name="nature" value="${valeur}"${saisie.nature === valeur ? brut(' checked') : ''}${erreurs.nature ? brut(' aria-invalid="true" aria-describedby="op-nature-erreur"') : ''}> ${texte}</label>`;
  return html`${recapitulatifErreurs(erreurs, CHAMPS_OPERATION)}
${essai}
<form method="post" action="${action}" novalidate>
<input type="hidden" name="_csrf" value="${app.csrf}">
<input type="hidden" name="test_id" value="${test.id}">
${operation ? html`<input type="hidden" name="operation_id" value="${operation.id}">` : ''}
${champ({ id: 'op-libelle', nom: 'libelle', etiquette: 'Libellé', valeur: saisie.libelle, requis: true, erreur: erreurs.libelle, aide: 'Ce que l’opération vérifie, en une phrase : « 35 critères en tout ».' })}
<fieldset${erreurs.nature ? brut(' class="champ-erreur"') : ''}>
<legend>Nature de l’opération</legend>
${erreurs.nature ? html`<p class="erreur" id="op-nature-erreur"><span aria-hidden="true">⚠</span> ${erreurs.nature}</p>` : ''}
<div class="choix">${radio('sql', 'Requête SQL (lecture seule)', 'op-nature-sql')}${radio('fonction', 'Appel de fonction', 'op-nature-fonction')}</div>
</fieldset>
${champ({ id: 'op-requete', code: true, nom: 'requete', etiquette: 'Requête SQL', valeur: saisie.requete, zone: true, lignes: 6, erreur: erreurs.requete, aide: `Pour une requête : une seule lecture (SELECT, WITH, VALUES ou TABLE), exécutée sous le rôle de lecture, en lecture seule, 5 s et ${LIGNES_MAX} lignes au plus. Vues utiles : donnees.critere, donnees.score, donnees.synthese… (page Données).` })}
${champ({ id: 'op-fonction', nom: 'fonction', etiquette: 'Fonction', valeur: saisie.fonction, erreur: erreurs.fonction, options: [['', '— choisir —'], ...Object.entries(FONCTIONS).map(([n, f]) => [n, f.signature])], aide: 'Pour un appel : une fonction de la liste blanche (détail sous le formulaire).' })}
${champ({ id: 'op-arguments', code: true, nom: 'arguments', etiquette: 'Arguments (liste JSON)', valeur: saisie.arguments, zone: true, lignes: 3, erreur: erreurs.arguments, aide: 'Par exemple [1.125, 2] pour arrondi(1.125, 2).' })}
${champ({ id: 'op-comparaison', nom: 'comparaison', etiquette: 'Comparaison', valeur: saisie.comparaison, erreur: erreurs.comparaison, options: COMPARAISONS.map((c) => [c, LIBELLES_COMPARAISON[c]]) })}
${champ({ id: 'op-attendu', code: true, nom: 'attendu', etiquette: 'Attendu (valeur JSON)', valeur: saisie.attendu, zone: true, lignes: 4, erreur: erreurs.attendu, aide: 'Une colonne et une ligne se comparent à la valeur seule (35), une colonne à la liste des valeurs, plusieurs colonnes à la liste des lignes. Inutile pour « aucune ligne » et « au moins une ligne ».' })}
${champ({ id: 'op-tolerance', nom: 'tolerance', etiquette: 'Tolérance', valeur: saisie.tolerance, erreur: erreurs.tolerance, aide: 'Pour la comparaison « à la tolérance près » seulement.', attributs: 'inputmode="decimal"' })}
<div class="actions">
<button type="submit">Enregistrer l’opération</button>
<button type="submit" class="secondaire" formaction="/operations/essayer" name="action" value="essayer">Essayer sans enregistrer</button>
<button type="submit" class="secondaire" formaction="/operations/essayer" name="action" value="adopter">Essayer et prendre l’obtenu comme attendu</button>
<a href="/tests/${test.id}">Annuler</a>
</div>
</form>
<h2>Fonctions de la liste blanche</h2>
<dl>${Object.entries(FONCTIONS).map(([, f]) => html`<dt><code>${f.signature}</code></dt><dd>${f.aide}</dd>`)}</dl>`;
}

async function formulaireOperation({ app, params }) {
  const test = await testDefiniOu404(app.principal, Number(params[0]));
  if (test.operations >= MAX_OPERATIONS) throw new ErreurHttp(409, `Ce test porte déjà ${MAX_OPERATIONS} opérations, le maximum.`);
  const saisie = { libelle: '', nature: 'sql', requete: '', fonction: '', arguments: '', comparaison: 'egal', attendu: '', tolerance: '' };
  const contenu = html`<h1>Nouvelle opération (${Number(test.operations) + 1} sur ${MAX_OPERATIONS})</h1>
<p>Test : <a href="/tests/${test.id}">${test.libelle}</a></p>
${formulaireOperationHtml(app, { test, saisie })}`;
  return page({ titre: `Nouvelle opération · ${test.libelle}`, actif: 'tests', fil: [['/', 'Accueil'], ['/tests', 'Tests'], [`/tests/${test.id}`, test.libelle], [null, 'Nouvelle opération']], contenu });
}

async function operationOu404(db, id) {
  const { rows: [o] } = await db.query('SELECT * FROM recette.operation WHERE id = $1', [id]);
  if (!o) throw new ErreurHttp(404, `Aucune opération n° ${id}.`);
  return o;
}

async function formulaireOperationExistante({ app, url, params }) {
  const o = await operationOu404(app.principal, Number(params[0]));
  const test = await testOu404(app.principal, o.test_id);
  if (test.origine !== 'base') throw new ErreurHttp(409, 'Les étapes d’un test de suite se modifient dans son fichier.');
  const contenu = html`<h1>Opération ${o.ordre} : ${o.libelle}</h1>
<p>Test : <a href="/tests/${test.id}">${test.libelle}</a></p>
${formulaireOperationHtml(app, { test, operation: o, saisie: saisieDe(o) })}`;
  return page({ titre: `Opération ${o.ordre} · ${test.libelle}`, actif: 'tests', fil: [['/', 'Accueil'], ['/tests', 'Tests'], [`/tests/${test.id}`, test.libelle], [null, `Opération ${o.ordre}`]], contenu, message: messageDe(url) });
}

const parametresOperation = (op) => [op.libelle, op.nature, op.requete, op.fonction, op.arguments === null ? null : jsonPourPg(op.arguments),
  op.comparaison, ['vide', 'non_vide'].includes(op.comparaison) ? null : jsonPourPg(op.attendu ?? null), op.tolerance];

async function pageOperationEnErreur(app, test, operation, saisie, erreurs, essai = null) {
  const titre = operation ? `Opération ${operation.ordre} : ${operation.libelle}` : `Nouvelle opération (${Number(test.operations) + 1} sur ${MAX_OPERATIONS})`;
  const contenu = html`<h1>${titre}</h1><p>Test : <a href="/tests/${test.id}">${test.libelle}</a></p>${formulaireOperationHtml(app, { test, operation, saisie, erreurs, essai })}`;
  return page({ titre: `${Object.keys(erreurs).length ? 'Erreur : ' : ''}${titre}`, actif: 'tests', fil: [['/', 'Accueil'], ['/tests', 'Tests'], [`/tests/${test.id}`, test.libelle], [null, operation ? `Opération ${operation.ordre}` : 'Nouvelle opération']], contenu });
}

async function creerOperation({ app, res, corps, params }) {
  const test = await testDefiniOu404(app.principal, Number(params[0]));
  const { saisie, erreurs, operation } = operationDuFormulaire(corps);
  if (operation) {
    try {
      const n = await enTransaction(app.principal, async (c) => {
        await c.query('SELECT id FROM recette.test WHERE id = $1 FOR UPDATE', [test.id]);
        const { rows: [{ total }] } = await c.query('SELECT count(*) AS total FROM recette.operation WHERE test_id = $1', [test.id]);
        if (total >= MAX_OPERATIONS) throw new ErreurHttp(409, `Ce test porte déjà ${MAX_OPERATIONS} opérations, le maximum.`);
        await c.query(
          `INSERT INTO recette.operation (test_id, ordre, libelle, nature, requete, fonction, arguments, comparaison, attendu, tolerance)
           VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9::jsonb, $10)`,
          [test.id, total + 1, ...parametresOperation(operation)],
        );
        return total + 1;
      });
      return rediriger(res, `/tests/${test.id}?fait=operation-ajoutee&n=${n}`);
    } catch (e) {
      if (e instanceof ErreurHttp) throw e;
      if (e.code !== '23514') throw e;
      erreurs.libelle = `La base refuse l’opération : ${e.message}`;
    }
  }
  return { code: 422, corps: await pageOperationEnErreur(app, test, null, saisie, erreurs) };
}

async function modifierOperation({ app, res, corps, params }) {
  const o = await operationOu404(app.principal, Number(params[0]));
  const test = await testDefiniOu404(app.principal, o.test_id);
  const { saisie, erreurs, operation } = operationDuFormulaire(corps);
  if (operation) {
    try {
      await app.principal.query(
        `UPDATE recette.operation SET libelle = $2, nature = $3, requete = $4, fonction = $5, arguments = $6::jsonb,
                comparaison = $7, attendu = $8::jsonb, tolerance = $9 WHERE id = $1`,
        [o.id, ...parametresOperation(operation)],
      );
      return rediriger(res, `/tests/${test.id}?fait=operation-modifiee`);
    } catch (e) {
      if (e.code !== '23514') throw e;
      erreurs.libelle = `La base refuse l’opération : ${e.message}`;
    }
  }
  return { code: 422, corps: await pageOperationEnErreur(app, test, o, saisie, erreurs) };
}

async function supprimerOperation({ app, res, params }) {
  const o = await operationOu404(app.principal, Number(params[0]));
  await testDefiniOu404(app.principal, o.test_id);
  await enTransaction(app.principal, async (c) => {
    await c.query('DELETE FROM recette.operation WHERE id = $1', [o.id]);
    // Le rang est différable : la renumérotation se vérifie en fin d'instruction
    await c.query('UPDATE recette.operation SET ordre = ordre - 1 WHERE test_id = $1 AND ordre > $2', [o.test_id, o.ordre]);
  });
  return rediriger(res, `/tests/${o.test_id}?fait=operation-supprimee`);
}

async function deplacerOperation({ app, res, corps, params }) {
  const o = await operationOu404(app.principal, Number(params[0]));
  await testDefiniOu404(app.principal, o.test_id);
  const sens = corps.get('sens');
  if (!['haut', 'bas'].includes(sens)) throw new ErreurHttp(400, 'Sens de déplacement inconnu.');
  const voisin = sens === 'haut' ? o.ordre - 1 : o.ordre + 1;
  await enTransaction(app.principal, async (c) => {
    const { rowCount } = await c.query('SELECT 1 FROM recette.operation WHERE test_id = $1 AND ordre = $2 FOR UPDATE', [o.test_id, voisin]);
    if (!rowCount) return;
    await c.query('UPDATE recette.operation SET ordre = CASE WHEN ordre = $2 THEN $3 ELSE $2 END WHERE test_id = $1 AND ordre IN ($2, $3)', [o.test_id, o.ordre, voisin]);
  });
  return rediriger(res, `/tests/${o.test_id}?fait=operation-deplacee`);
}

async function essayerOperation({ app, corps }) {
  const test = await testDefiniOu404(app.principal, entier(corps.get('test_id'), 0));
  const idOperation = entier(corps.get('operation_id'));
  const existante = idOperation ? await operationOu404(app.principal, idOperation) : null;
  if (existante && existante.test_id !== test.id) throw new ErreurHttp(400, 'Opération et test ne correspondent pas.');
  const { saisie, erreurs, operation, candidat } = operationDuFormulaire(corps);
  const adopter = corps.get('action') === 'adopter';
  // L'essai n'exige pas d'attendu : on l'exécute même sans
  const erreursBloquantes = Object.fromEntries(Object.entries(erreurs).filter(([k]) => !(k === 'attendu' && !saisie.attendu.trim())));
  let essai = '';
  if (!Object.keys(erreursBloquantes).length) {
    // Sans attendu, l'opération n'est pas validée : on essaie le candidat déjà analysé
    const op = operation ?? {
      nature: saisie.nature, requete: candidat.sql ?? null, fonction: candidat.fonction ?? null,
      arguments: candidat.arguments ?? [], comparaison: saisie.comparaison,
    };
    let obtenu;
    let verdict;
    let message = null;
    try {
      const r = await obtenir(op, { lecture: app.lecture });
      obtenu = jsonComplet(r.valeur);
      if (operation) {
        try { verifier(operation, obtenu, r.lignes); verdict = 'reussie'; } catch (e) { verdict = 'echouee'; message = e.message; }
      } else verdict = null;
      if (adopter) {
        saisie.attendu = JSON.stringify(obtenu, null, 2);
        if (['vide', 'non_vide'].includes(saisie.comparaison)) saisie.comparaison = 'egal';
      }
      essai = html`<section class="resultat-essai" role="status" aria-labelledby="essai-titre">
<h2 id="essai-titre">Résultat de l’essai${verdict ? html` : ${statut(verdict)}` : ''}</h2>
<p>${nombre(r.lignes)} ligne(s) ou élément(s) obtenu(s)${adopter ? ' ; l’obtenu est repris comme attendu, à vérifier avant d’enregistrer' : ''}.</p>
<pre><code>${JSON.stringify(obtenu, null, 2)}</code></pre>
${message ? html`<p class="erreur">${message}</p>` : ''}
${!operation && !adopter ? html`<p>Sans attendu, l’essai montre l’obtenu sans le juger.</p>` : ''}
</section>`;
    } catch (e) {
      essai = html`<section class="resultat-essai" role="status" aria-labelledby="essai-titre">
<h2 id="essai-titre">Résultat de l’essai : ${statut('erreur')}</h2>
<pre>${e.message}</pre>
</section>`;
    }
  }
  return { code: Object.keys(erreursBloquantes).length ? 422 : 200, corps: await pageOperationEnErreur(app, test, existante, saisie, erreursBloquantes, essai) };
}

// ── Données, échange, santé ──────────────────────────────────────────────────
async function donnees({ app }) {
  const db = app.principal;
  const { rows: docs } = await db.query('SELECT id, nature, chemin, empreinte, campagne_id, charge_le, contenu ? \'erreur\' AS illisible FROM donnees.document ORDER BY nature, chemin');
  const { rows: colonnes } = await db.query(
    `SELECT c.table_name, string_agg(c.column_name || ' (' || c.data_type || ')', ', ' ORDER BY c.ordinal_position) AS colonnes
     FROM information_schema.columns c JOIN information_schema.views v ON v.table_schema = c.table_schema AND v.table_name = c.table_name
     WHERE c.table_schema = 'donnees' GROUP BY c.table_name ORDER BY c.table_name`,
  );
  const contenu = html`<h1>Données</h1>
<p>À chaque campagne, le lanceur recharge ici les fichiers YAML du dépôt (modèle, manifestes, journal). Les vues ci-dessous les déplient en lignes : les requêtes SQL des tests définis en base les interrogent.</p>
<h2>Documents chargés</h2>
${tableau({
    legende: `${docs.length} document(s)`,
    colonnes: ['Chemin', 'Nature', 'Lisible', 'Empreinte (sha256)', 'Campagne', 'Chargé le'],
    lignes: docs.map((d) => [html`<a href="/donnees/${d.id}">${d.chemin}</a>`, d.nature, d.illisible ? 'non' : 'oui', html`<code>${d.empreinte.slice(0, 12)}</code>`, d.campagne_id ? html`<a href="/campagnes/${d.campagne_id}">n° ${d.campagne_id}</a>` : '—', date(d.charge_le)]),
    vide: 'Aucun document : lancez une campagne pour les charger.',
  })}
<h2>Vues SQL du schéma donnees</h2>
${tableau({ legende: 'Vues et leurs colonnes', colonnes: ['Vue', 'Colonnes'], lignes: colonnes.map((c) => [html`<code>donnees.${c.table_name}</code>`, c.colonnes]) })}
<p>Fonction utile : <code>donnees.arrondi_pair(x, n)</code>, l’arrondi au pair des moyennes du journal.</p>`;
  return page({ titre: 'Données', actif: 'donnees', fil: [['/', 'Accueil'], [null, 'Données']], contenu });
}

async function documentDonnees({ app, params }) {
  const { rows: [d] } = await app.principal.query('SELECT * FROM donnees.document WHERE id = $1', [Number(params[0])]);
  if (!d) throw new ErreurHttp(404, `Aucun document n° ${params[0]}.`);
  const sections = Object.entries(d.contenu ?? {});
  const contenu = html`<h1>${d.chemin}</h1>
${fiche([['Nature', d.nature], ['Empreinte', html`<code>${d.empreinte}</code>`], ['Chargé le', date(d.charge_le)], ['Sections', nombre(sections.length)]])}
${sections.map(([cle, v]) => html`<details><summary><code>${cle}</code></summary><pre><code>${JSON.stringify(v, null, 2)}</code></pre></details>`)}`;
  return page({ titre: d.chemin, actif: 'donnees', fil: [['/', 'Accueil'], ['/donnees', 'Données'], [null, d.chemin]], contenu });
}

async function echange({ app, url }, extra = {}) {
  const { rows: [{ n }] } = await app.principal.query("SELECT count(*) AS n FROM recette.test WHERE origine = 'base'");
  const contenu = html`<h1>Import et export</h1>
<p>Les tests définis en base s’échangent au format de <code>recette/tests-definis.yaml</code> : on l’exporte pour le versionner avec le dépôt, on l’importe pour les recréer ailleurs.</p>
<h2>Exporter</h2>
<p><a class="bouton" href="/echange/tests-definis.yaml" download>Télécharger les ${nombre(n)} test(s) défini(s) (YAML)</a></p>
<h2>Importer</h2>
${recapitulatifErreurs(extra.erreurs, { yaml: 'import-yaml' })}
<form method="post" action="/echange/importer" novalidate>
<input type="hidden" name="_csrf" value="${app.csrf}">
${champ({ id: 'import-yaml', code: true, nom: 'yaml', etiquette: 'Contenu YAML', valeur: extra.yaml ?? '', zone: true, lignes: 14, requis: true, erreur: extra.erreurs?.yaml, aide: 'Le contenu d’un fichier tests-definis.yaml. Un test existant (même nom) est mis à jour, opération par opération.' })}
<div class="champ"><label><input type="checkbox" name="remplacer" value="1"> Retirer les tests définis en base absents du contenu importé</label></div>
<div class="actions"><button type="submit">Importer</button></div>
</form>`;
  return page({ titre: extra.erreurs ? 'Erreur : import et export' : 'Import et export', actif: 'echange', fil: [['/', 'Accueil'], [null, 'Import et export']], contenu, message: messageDe(url) });
}

async function telechargerDefinis({ app, res }) {
  const texte = await exporter(app.principal);
  return envoyer(res, 200, texte, 'application/yaml; charset=utf-8', { 'Content-Disposition': 'attachment; filename="tests-definis.yaml"' });
}

async function importerDefinis(ctx) {
  const { app, res, corps } = ctx;
  const yaml = corps.get('yaml') ?? '';
  if (!yaml.trim()) return { code: 422, corps: await echange(ctx, { yaml, erreurs: { yaml: 'Le contenu YAML est obligatoire.' } }) };
  try {
    await enTransaction(app.principal, (c) => importer(c, yaml, { remplacer: corps.get('remplacer') === '1' }));
  } catch (e) {
    return { code: 422, corps: await echange(ctx, { yaml, erreurs: { yaml: e.message } }) };
  }
  return rediriger(res, '/echange?fait=importe');
}

async function sante({ app, res }) {
  const ok = await joignable(app.principal);
  return envoyer(res, ok ? 200 : 503, JSON.stringify({ statut: ok ? 'ok' : 'base injoignable' }), 'application/json; charset=utf-8');
}

const style = ({ res }) => envoyer(res, 200, STYLE, 'text/css; charset=utf-8', { 'Cache-Control': 'max-age=300' });

// ── Routage ──────────────────────────────────────────────────────────────────
const ROUTES = [
  ['GET', /^\/$/, tableauDeBord],
  ['GET', /^\/campagnes$/, listeCampagnes],
  ['GET', /^\/campagnes\/(\d{1,15})$/, detailCampagne],
  ['GET', /^\/campagnes\/(\d{1,15})\/tests\/(\d{1,15})$/, detailExecution],
  ['GET', /^\/comparer$/, comparer],
  ['GET', /^\/tests$/, listeTests],
  ['GET', /^\/tests\/nouveau$/, formulaireTest],
  ['POST', /^\/tests$/, creerTest],
  ['GET', /^\/tests\/(\d{1,15})$/, detailTest],
  ['POST', /^\/tests\/(\d{1,15})$/, modifierTest],
  ['GET', /^\/tests\/(\d{1,15})\/supprimer$/, confirmerSuppressionTest],
  ['POST', /^\/tests\/(\d{1,15})\/supprimer$/, supprimerTest],
  ['GET', /^\/tests\/(\d{1,15})\/operations\/nouvelle$/, formulaireOperation],
  ['POST', /^\/tests\/(\d{1,15})\/operations$/, creerOperation],
  ['POST', /^\/operations\/essayer$/, essayerOperation],
  ['GET', /^\/operations\/(\d{1,15})$/, formulaireOperationExistante],
  ['POST', /^\/operations\/(\d{1,15})$/, modifierOperation],
  ['POST', /^\/operations\/(\d{1,15})\/supprimer$/, supprimerOperation],
  ['POST', /^\/operations\/(\d{1,15})\/deplacer$/, deplacerOperation],
  ['GET', /^\/donnees$/, donnees],
  ['GET', /^\/donnees\/(\d{1,15})$/, documentDonnees],
  ['GET', /^\/echange$/, echange],
  ['GET', /^\/echange\/tests-definis\.yaml$/, telechargerDefinis],
  ['POST', /^\/echange\/importer$/, importerDefinis],
  ...ROUTES_PILOTAGE,
  ['GET', /^\/sante$/, sante],
  ['GET', /^\/style\.css$/, style],
];

function pageErreur(code, message) {
  const titres = { 400: 'Requête invalide', 401: 'Authentification requise', 403: 'Action refusée', 404: 'Page introuvable', 405: 'Méthode non permise', 409: 'Action impossible', 413: 'Formulaire trop volumineux', 415: 'Format refusé', 421: 'Hôte non permis', 500: 'Erreur interne' };
  const titre = titres[code] ?? 'Erreur';
  return page({ titre, actif: null, contenu: html`<h1>${titre}</h1><p>${message}</p><p><a href="/">Retour au tableau de bord</a></p>` });
}

/**
 * Crée le gestionnaire de requêtes : { principal, lecture } sont des pools pg ;
 * `file` est la file de demandes que l'interface lit et où elle dépose (celle
 * de l'exécuteur de la pile, sauf pour les essais de la recette).
 */
export function creerApplication({ principal, lecture = principal, csrf = randomBytes(32).toString('hex'), identifiants = null, hotes = [], file = FILE_PRINCIPALE }) {
  const app = { principal, lecture, csrf, identifiants, file, hotes: new Set([...HOTES_LOCAUX, ...hotes].map((h) => h.trim().toLowerCase()).filter(Boolean)) };
  return async function gerer(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://interface.local');
    } catch {
      return envoyer(res, 400, pageErreur(400, 'Adresse illisible.'));
    }
    const methode = req.method === 'HEAD' ? 'GET' : req.method;
    try {
      verifierHote(app, req);
      if (url.pathname !== '/sante' && !autorise(app, req)) {
        return envoyer(res, 401, pageErreur(401, 'Identifiants requis.'), 'text/html; charset=utf-8', { 'WWW-Authenticate': 'Basic realm="recette", charset="UTF-8"' });
      }
      const candidates = ROUTES.filter(([, motif]) => motif.test(url.pathname));
      const route = candidates.find(([m]) => m === methode);
      if (!route) {
        if (candidates.length) return envoyer(res, 405, pageErreur(405, 'Méthode non permise pour cette adresse.'), 'text/html; charset=utf-8', { Allow: [...new Set(candidates.map(([m]) => m))].join(', ') });
        return envoyer(res, 404, pageErreur(404, 'Cette page n’existe pas.'));
      }
      const params = route[1].exec(url.pathname).slice(1);
      let corps = null;
      if (methode === 'POST') {
        corps = await lireCorps(req);
        verifierFormulaire(app, req, corps);
      }
      const r = await route[2]({ app, req, res, url, params, corps });
      if (res.headersSent || res.writableEnded) return undefined;
      if (typeof r === 'string') return envoyer(res, 200, r);
      if (r && typeof r === 'object' && 'code' in r) return envoyer(res, r.code, r.corps);
      return envoyer(res, 500, pageErreur(500, 'Réponse vide.'));
    } catch (e) {
      if (e instanceof ErreurHttp) return envoyer(res, e.code, pageErreur(e.code, e.message));
      process.stderr.write(`interface : ${req.method} ${url.pathname} : ${e.stack ?? e}\n`);
      if (!res.headersSent) return envoyer(res, 500, pageErreur(500, 'Une erreur interne est survenue ; le détail est dans le journal du serveur.'));
      return undefined;
    }
  };
}

/** Démarre le serveur ; rend { serveur, pools, adresse }. */
export async function demarrer({ hote = process.env.INTERFACE_HOTE || '127.0.0.1', port = Number(process.env.INTERFACE_PORT || 8080) } = {}) {
  const utilisateur = process.env.INTERFACE_UTILISATEUR ?? '';
  const motDePasse = process.env.INTERFACE_MOT_DE_PASSE ?? '';
  // Une seule des deux variables : on refuse de démarrer plutôt que d'ouvrir sans authentification
  if (Boolean(utilisateur) !== Boolean(motDePasse)) throw new Error('INTERFACE_UTILISATEUR et INTERFACE_MOT_DE_PASSE vont ensemble : renseigner les deux, ou aucune');
  const identifiants = utilisateur ? { utilisateur, motDePasse } : null;
  const hotes = (process.env.INTERFACE_HOTES_PERMIS ?? '').split(',').map((h) => h.trim()).filter(Boolean);
  const pools = ouvrir({ nom: 'recette-7e-interface' });
  const appliquees = await migrer(pools.principal);
  if (appliquees.length) process.stdout.write(`interface : migrations appliquées : ${appliquees.join(', ')}\n`);
  const serveur = createServer(creerApplication({ principal: pools.principal, lecture: pools.lecture, identifiants, hotes }));
  serveur.headersTimeout = 20_000;
  serveur.requestTimeout = 60_000;
  await new Promise((ok, ko) => { serveur.once('error', ko); serveur.listen(port, hote, ok); });
  const a = serveur.address();
  process.stdout.write(`interface : http://${a.address}:${a.port} (base ${urlMasquee(process.env.RECETTE_PG_URL)}${identifiants ? ', authentification HTTP' : ''})\n`);
  const arreter = () => { serveur.close(() => fermer(pools).finally(() => process.exit(0))); };
  process.once('SIGTERM', arreter);
  process.once('SIGINT', arreter);
  return { serveur, pools, adresse: a };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  demarrer().catch((e) => {
    process.stderr.write(`interface : démarrage impossible : ${e.message}\n`);
    process.exit(1);
  });
}
