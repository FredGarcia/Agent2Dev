/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  interface/pilotage.mjs : workflows, déclencheurs et suivi
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Les pages qui reflètent les projets eux-mêmes, au-delà de la recette :
 *
 *    Workflows     ce qui s'exécute dans chaque projet : le méta-projet lu dans
 *                  le dépôt (cycle du modèle, CI, résolveur, recette, VM), le
 *                  binôme lu dans sa spécification (W00 à W10, tâches)
 *    Déclencheurs  ce qui lance chaque workflow ; quatre actions se déclenchent
 *                  d'ici : l'interface dépose une demande, l'exécuteur
 *                  (recette/executeur.mjs) l'exécute sur une copie du dépôt ;
 *                  et la validation finale d'une release, qui la met en
 *                  production (mesure 10.2)
 *    Suivi         l'exécuteur et sa file, les demandes et leur sortie, les
 *                  cycles du journal, les propositions au modèle, les campagnes,
 *                  les décisions du binôme
 *
 *  Le suivi automatique d'une demande (rechargement toutes les dix secondes)
 *  ne démarre que sur demande, s'arrête par un lien, et cesse de lui-même quand
 *  la demande se termine (RGAA 13.1).
 */

import {
  ACTIONS, DemandeRefusee, STATUTS_FINAUX, ValidationRefusee, annuler, arreter, catalogueEnBase,
  declencheurs as aplatirDeclencheurs, deposer, enregistrerValidation, validations, validerDemande, validerValidation,
} from '../recette/pilotage.mjs';
import { interne } from '../resolveur7e.mjs';
import { ErreurHttp, entier, messageDe, rediriger } from './commun.mjs';
import { boutonPost, champ, date, duree, enLettres, fiche, html, jour, nombre, page, pagination, recapitulatifErreurs, statut, tableau } from './vues.mjs';

const SUIVI_AUTO_S = 10;
const RE_ID = '[A-Za-z0-9][A-Za-z0-9_-]{0,63}';

const NATURES = {
  cycle: 'cycle du modèle', ci: 'CI (Gitea Actions)', commande: 'commande', script: 'script', n8n: 'workflow n8n',
};
const RAISONS_PLAN = { prerequis: 'prérequis de la boucle', 'terme le plus faible': 'terme le plus faible' };
const LIMITES = { iterations_par_tache: 'Itérations par tâche', questions_par_tache: 'Questions par tâche', campagnes_simultanees: 'Campagnes simultanées', echeance_cloture: 'Échéance de clôture d’une entrée' };
/** Les points humains du binôme (taches.personnes), en clair. */
const POINTS_HUMAINS = { ratifier: 'ratifier', valider: 'valider', arbitrer: 'arbitrer', session_sso: 'ouvrir la session SSO', fusionner: 'fusionner à la mission', auditer: 'auditer à la clôture' };
const majuscule = (t) => (t ? `${t.charAt(0).toUpperCase()}${t.slice(1)}` : t);
/** Les outils d'une entrée, dans l'ordre du résolveur (jsonb ne garde pas l'ordre des clés). */
const outilsDans = (o = {}) => [...interne.OUTILS.filter((k) => Object.hasOwn(o, k)), ...Object.keys(o).filter((k) => !interne.OUTILS.includes(k)).sort()];

const nomAction = (a) => ACTIONS[a]?.nom ?? a;
const lienDemande = (d) => html`<a href="/suivi/demandes/${d.id}">Demande n° ${d.id}</a>`;
const ouiNon = (v) => (v === true ? 'oui' : v === false ? 'non' : '—');
const signe = (n) => (n === null || n === undefined ? '—' : `${Number(n) > 0 ? '+' : ''}${nombre(n)}`);

/** Qui dépose : l'utilisateur de l'authentification HTTP, sinon « interface ». */
const demandeurDe = (app) => app.identifiants?.utilisateur ?? 'interface';

// ── Lectures ────────────────────────────────────────────────────────────────

async function etatExecuteur(app) {
  const { rows: [e] } = await app.principal.query('SELECT * FROM pilotage.v_executeur WHERE file = $1 ORDER BY vu_le DESC LIMIT 1', [app.file]);
  return e ?? null;
}

async function demandesActives(app) {
  const { rows } = await app.principal.query("SELECT * FROM pilotage.v_demande WHERE file = $1 AND statut IN ('en_attente', 'en_cours') ORDER BY id", [app.file]);
  return rows;
}

async function demandeOu404(app, id) {
  const { rows: [d] } = await app.principal.query('SELECT v.*, d.sortie FROM pilotage.v_demande v JOIN pilotage.demande d ON d.id = v.id WHERE v.id = $1 AND v.file = $2', [id, app.file]);
  if (!d) throw new ErreurHttp(404, `Aucune demande n° ${id}.`);
  return d;
}

/** Les repères du modèle chargé : critères dans l'ordre, noms des termes et des phases. */
async function reperesModele(db) {
  const { rows: criteres } = await db.query('SELECT id, terme, enonce FROM donnees.critere ORDER BY ordre');
  const { rows: termes } = await db.query('SELECT id, nom FROM donnees.terme ORDER BY rang');
  const { rows: [m] } = await db.query("SELECT contenu #> '{cycle}' AS cycle FROM donnees.modele LIMIT 1");
  const phases = new Map(Object.entries(m?.cycle?.phases ?? {}).map(([k, v]) => [k, v?.nom ?? k]));
  return {
    criteres,
    termes: new Map([...termes.map((t) => [t.id, t.nom]), ['second_ordre', 'Second ordre']]),
    phases,
    ordrePhases: Array.isArray(m?.cycle?.ordre) ? m.cycle.ordre : [...phases.keys()],
  };
}

// ── Fragments ───────────────────────────────────────────────────────────────

/** L'état de l'exécuteur, en clair : une demande déposée sera-t-elle prise ? */
function noticeExecuteur(e) {
  if (e?.actif) {
    return html`<div class="notice"><p>${statut('actif')} Exécuteur <code>${e.nom}</code>, vu il y a ${duree(e.silence_s)} ; démon Docker ${e.docker_demon ? 'joignable' : 'injoignable : les tests qui l’exigent seront omis'}.${e.demande_id ? html` Il exécute la <a href="/suivi/demandes/${e.demande_id}">demande n° ${e.demande_id}</a>.` : ' Il attend une demande.'}</p></div>`;
  }
  return html`<div class="notice avertissement"><p>${statut('absent')} Aucun exécuteur actif${e ? html` : le dernier, <code>${e.nom}</code>, s’est signalé ${date(e.vu_le)}` : ''}. Les demandes attendront qu’il démarre : <code>docker compose -f compose.recette.yaml --env-file .env.recette up -d executeur</code>.</p></div>`;
}

function avertissementsCatalogue(cat) {
  if (!cat.problemes.length) return '';
  return html`<div class="notice avertissement"><p>Le catalogue des workflows signale ${cat.problemes.length > 1 ? `${cat.problemes.length} problèmes` : 'un problème'} :</p><ul>${cat.problemes.map((p) => html`<li>${p}</li>`)}</ul></div>`;
}

function chargementCatalogue(cat) {
  if (!cat.charge) return '';
  return html`<p class="aide">Lu dans le dépôt le ${date(cat.charge.le)}${cat.charge.campagne ? html`, par la <a href="/campagnes/${cat.charge.campagne}">campagne n° ${cat.charge.campagne}</a>` : ''}. <a href="/declencheurs#action-charger">Recharger les données du dépôt</a>.</p>`;
}

function phasesDe(w) {
  if (w.nature === 'cycle') return 'les sept phases';
  if (w.transverse) return 'toutes (transverse)';
  const noms = w.parPhase.map((x) => x.nomPhase);
  return noms.length ? [...new Set(noms)].join(', ') : '—';
}

function declencheursCourts(w) {
  return html`${w.declencheurs.map((d, i) => html`${i ? ' · ' : ''}${d.libelle}${d.action ? html` <span class="etiquette">ici</span>` : ''}`)}`;
}

const COLONNES_DEMANDES = ['Demande', 'Action', 'Statut', 'Déposée', 'Par', { texte: 'Attente', nombre: true }, { texte: 'Durée', nombre: true }, 'Résultat'];

function resumeResultat(d) {
  if (d.campagne_id) return html`<a href="/campagnes/${d.campagne_id}">Campagne n° ${d.campagne_id}</a>`;
  if (d.action === 'cycle' && d.resultat?.entree?.chemin) return html`entrée à blanc <code>${d.resultat.entree.chemin}</code>`;
  if (d.action === 'valider' && d.resultat?.conclusion) return d.resultat.conclusion;
  if (d.action === 'charger' && d.resultat?.documents) return `${nombre(Object.values(d.resultat.documents).reduce((a, b) => a + Number(b), 0))} document(s)`;
  if (d.code_retour !== null && d.code_retour !== undefined) return `code ${d.code_retour}`;
  return '—';
}

function lignesDemandes(demandes) {
  return demandes.map((d) => [
    lienDemande(d), nomAction(d.action), statut(d.statut), date(d.demandee_le), d.demandeur,
    duree(d.attente_s), duree(d.duree_s), resumeResultat(d),
  ]);
}

/** Les boutons d'une demande active : annuler si elle attend, arrêter si elle tourne. */
function commandesDemande(app, d) {
  if (d.statut === 'en_attente') return boutonPost({ action: `/suivi/demandes/${d.id}/annuler`, texte: 'Annuler', csrf: app.csrf, classe: 'secondaire', etiquette: `Annuler la demande n° ${d.id}` });
  if (d.statut === 'en_cours') {
    if (d.arret_le) return html`<span>arrêt demandé ${date(d.arret_le)}</span>`;
    return boutonPost({ action: `/suivi/demandes/${d.id}/arreter`, texte: 'Arrêter', csrf: app.csrf, classe: 'danger', etiquette: `Arrêter la demande n° ${d.id}` });
  }
  return '';
}

/**
 * Une entrée de journal, rendue : celle du journal chargé ou celle d'un cycle à
 * blanc. `niveau` : niveau des titres de section (2 ou 3).
 */
function rendreEntree(e, reperes, { niveau = 2 } = {}) {
  const H = (texte, id) => (niveau === 2 ? html`<h2 id="${id}">${texte}</h2>` : html`<h3 id="${id}">${texte}</h3>`);
  const c = e?.cycle ?? {};
  const scores = e?.scores ?? {};
  const synthese = e?.synthese ?? {};
  const tendance = e?.tendance ?? {};
  const phases = e?.phases ?? {};
  const termes = [...reperes.termes.keys()].filter((t) => Object.hasOwn(synthese, t));
  const ordrePhases = reperes.ordrePhases.filter((p) => Object.hasOwn(phases, p));
  const idsConnus = new Set(reperes.criteres.map((x) => x.id));
  const criteres = [...reperes.criteres.filter((x) => Object.hasOwn(scores, x.id)), ...Object.keys(scores).filter((k) => !idsConnus.has(k)).sort().map((id) => ({ id, terme: null, enonce: null }))];
  const viabilite = e?.viabilite;
  return html`${fiche([
    ['Cycle', c.id ?? '—'], ['Release', e?.release ? html`<code>${e.release}</code>` : '—'], ['Début', date(c.debut)],
    ['Fin', c.fin ? date(c.fin) : statut('ouverte')], ['En CI', ouiNon(c.en_ci)], ['Modèle', c.modele_version ?? '—'], ['Contrat du journal', c.contrat_version ?? '—'],
    ['Viabilité', viabilite ? html`${statut(viabilite.viable ? 'viable' : 'non_viable')}${viabilite.progresse ? ' et en progrès' : ''}` : 'sans cycle comparable'],
    // contrat 0.5 : le ticket et les fichiers du cycle, cités par lien (ils restent sur le poste qui a tourné le cycle)
    Object.hasOwn(e ?? {}, 'demande') ? ['Demande', e.demande ? html`${e.demande.titre ?? 'ticket'} : <code>${e.demande.lien}</code>` : 'aucune (rang méta)'] : null,
    Array.isArray(e?.fichiers) ? ['Fichiers temporaires cités', e.fichiers.length ? html`<ul>${e.fichiers.map((f) => html`<li><code>${f.lien}</code> : ${nombre(f.nombre ?? 0)} fichier(s), ${nombre(f.octets ?? 0)} octets</li>`)}</ul>` : 'aucun'] : null,
  ])}
${H('Synthèse par terme', 'synthese')}
${tableau({
    legende: 'Moyenne sur 3 de chaque terme, écarts (critères notés 0 ou 1) et tendance depuis le cycle comparable précédent',
    colonnes: ['Terme', { texte: 'Moyenne sur 3', nombre: true }, 'Écarts', { texte: 'Tendance', nombre: true }],
    lignes: termes.map((t) => [reperes.termes.get(t) ?? t, synthese[t]?.moyenne === null ? 'sans objet' : nombre(synthese[t]?.moyenne), (synthese[t]?.ecarts ?? []).join(', ') || 'aucun', signe(tendance[t])]),
    vide: 'Aucune synthèse.',
  })}
${H('Phases', 'phases')}
${tableau({
    legende: 'Statut de chaque phase du cycle ; une phase bloquée cite les prérequis en écart',
    colonnes: ['Phase', 'Statut', 'Cause'],
    lignes: ordrePhases.map((p) => [reperes.phases.get(p) ?? p, statut(phases[p]?.statut), (phases[p]?.cause ?? []).join(', ') || '—']),
    vide: 'Aucune phase consignée.',
  })}
${H('Plan', 'plan')}
${tableau({
    legende: 'Plan ordonné : prérequis de la boucle d’abord, puis le terme le plus faible',
    colonnes: [{ texte: 'Rang', nombre: true }, 'Critère', 'Raison'],
    lignes: (e?.plan ?? []).map((p, i) => [nombre(i + 1), p.critere, RAISONS_PLAN[p.raison] ?? p.raison]),
    vide: 'Plan vide : premier cycle comparable, ou aucun écart au cycle précédent.',
  })}
${H('Scores', 'scores')}
${tableau({
    legende: `${criteres.length} critères : score sur 3 et constat`,
    colonnes: ['Critère', 'Terme', 'Énoncé', { texte: 'Score', nombre: true }, 'Constat'],
    lignes: criteres.map((x) => [x.id, reperes.termes.get(x.terme) ?? x.terme ?? '—', x.enonce ?? '—', scores[x.id]?.score === null ? 'sans objet' : nombre(scores[x.id]?.score), scores[x.id]?.constat ?? '—']),
    vide: 'Aucun score.',
  })}
${H('Propositions au modèle', 'propositions')}
${tableau({
    legende: 'Propositions faites au modèle pendant ce cycle (Équilibrer)',
    colonnes: ['Critère', 'Nature', 'Motif'],
    lignes: (e?.propositions_modele ?? []).map((p) => [p.critere, p.nature, p.motif]),
    vide: 'Aucune proposition.',
  })}
${H('Décisions et mesures', 'decisions')}
${tableau({
    legende: 'Décisions de rétroaction appliquées',
    colonnes: ['Critère ou indicateur', 'Correction', 'Réversible', 'Cible', 'Motif'],
    lignes: (e?.decisions ?? []).map((d) => [d.critere ?? d.indicateur ?? '—', d.correction ?? '—', ouiNon(d.reversible), d.cible ?? '—', d.motif ?? '—']),
    vide: 'Aucune décision.',
  })}
${tableau({
    legende: 'Mesures comparées aux seuils du manifeste',
    colonnes: ['Indicateur', { texte: 'Valeur', nombre: true }, { texte: 'Seuil', nombre: true }, 'Hors seuil'],
    lignes: (e?.mesures ?? []).map((m) => [m.indicateur, nombre(m.valeur), nombre(m.seuil), ouiNon(m.hors_seuil)]),
    vide: 'Aucune mesure.',
  })}
${(e?.remarques ?? []).length ? html`${H('Remarques', 'remarques')}<ul>${e.remarques.map((r) => html`<li>${r}</li>`)}</ul>` : ''}
<p class="aide">Outils recensés : ${outilsDans(e?.outils).map((o) => `${o} ${e.outils[o] ? 'oui' : 'non'}`).join(', ') || '—'}.</p>`;
}

// ── Workflows ───────────────────────────────────────────────────────────────

function tableauWorkflows(projet) {
  return tableau({
    legende: `Workflows de ${projet.nom}`,
    colonnes: ['Workflow', 'Nature', 'Phases', 'Déclencheurs', 'Exécutant'],
    lignes: projet.workflows.map((w) => [
      html`<a href="/workflows/${projet.id}/${w.id}">${w.nom}</a>${w.nom !== w.id ? html` <span class="etiquette">${w.id}</span>` : ''}`,
      NATURES[w.nature] ?? w.nature ?? '—', phasesDe(w), declencheursCourts(w), w.executant ?? '—',
    ]),
    vide: 'Aucun workflow.',
  });
}

function sectionTaches(projet, nomPhase) {
  const t = projet.taches;
  if (!t) return '';
  const etats = new Map((t.etats ?? []).map((x) => [x.id, x.nom ?? x.id]));
  const limites = Object.entries(t.limites ?? {});
  return html`<h3 id="taches-${projet.id}">Les tâches : états et transitions</h3>
<p>Une tâche porte son état ${t.portees_par ? `(${t.portees_par})` : ''}. Une transition ne part que de l’état attendu : un message en double ou en retard ne change rien.</p>
${tableau({
    legende: `Transitions entre les ${etats.size} états d’une tâche`,
    colonnes: ['De', 'Vers', 'Sur'],
    lignes: (t.transitions ?? []).map((x) => [etats.get(x.de) ?? x.de, etats.get(x.vers) ?? x.vers, x.sur ?? '—']),
  })}
<p>États finals : ${(t.etats ?? []).filter((x) => x.final).map((x) => x.nom).join(', ') || '—'}.</p>
${t.attente ? html`<p>${majuscule(t.attente)}.</p>` : ''}
${Array.isArray(t.personnes) && t.personnes.length ? html`<p>Points humains : ${t.personnes.map((x) => POINTS_HUMAINS[x] ?? String(x).replaceAll('_', ' ')).join(', ')}.</p>` : ''}
${tableau({
    legende: 'Catalogue des tâches : où n8n les achemine, sous quel délai',
    colonnes: ['Nature', 'Phase', 'Exécutant', 'Délai', { texte: 'Relances', nombre: true }],
    lignes: (t.natures ?? []).map((n) => [n.id, nomPhase(n.phase), n.executant, n.delai, nombre(n.relances)]),
  })}
${limites.length ? fiche(limites.map(([k, v]) => [LIMITES[k] ?? k.replaceAll('_', ' '), String(v)])) : ''}
${t.note ? html`<p class="aide">${majuscule(t.note)}.</p>` : ''}`;
}

export async function pageWorkflows({ app }) {
  const cat = await catalogueEnBase(app.principal);
  const reperes = await reperesModele(app.principal);
  const nomPhase = (p) => reperes.phases.get(p) ?? p;
  const contenu = html`<h1>Workflows</h1>
<p>Ce qui s’exécute dans chaque projet, et ce qui le lance. Le méta-projet est lu dans son dépôt ; le binôme, dans sa spécification, en attendant que n8n tourne.</p>
${chargementCatalogue(cat)}
${avertissementsCatalogue(cat)}
${cat.projets.length ? html`<nav aria-label="Projets"><ul>${cat.projets.map((p) => html`<li><a href="#projet-${p.id}">${p.nom}</a></li>`)}</ul></nav>` : ''}
${cat.projets.map((p) => html`<h2 id="projet-${p.id}">${p.nom}</h2>
${p.resume ? html`<p>${p.resume}</p>` : ''}
${p.etat || p.source ? html`<div class="notice">${p.etat ? html`<p>État : ${p.etat}.</p>` : ''}${p.source ? html`<p>Source : ${p.source}.</p>` : ''}</div>` : ''}
${tableauWorkflows(p)}
${sectionTaches(p, nomPhase)}`)}`;
  return page({ titre: 'Workflows', actif: 'workflows', fil: [['/', 'Accueil'], [null, 'Workflows']], contenu });
}

export async function pageWorkflow({ app, params }) {
  const [idProjet, idWorkflow] = params;
  const cat = await catalogueEnBase(app.principal);
  const projet = cat.projets.find((p) => p.id === idProjet);
  const w = projet?.workflows.find((x) => x.id === idWorkflow);
  if (!w) throw new ErreurHttp(404, `Aucun workflow ${idWorkflow} dans le projet ${idProjet}.`);
  let document = null;
  if (w.fichier) {
    const { rows: [d] } = await app.principal.query('SELECT id FROM donnees.document WHERE chemin = $1', [w.fichier]);
    document = d ?? null;
  }
  const actions = [...new Set(w.declencheurs.map((d) => d.action).filter(Boolean))];
  const { rows: demandes } = actions.length
    ? await app.principal.query('SELECT * FROM pilotage.v_demande WHERE file = $1 AND action = ANY($2) ORDER BY id DESC LIMIT 10', [app.file, actions])
    : { rows: [] };
  let etapes;
  if (w.nature === 'cycle') {
    etapes = tableau({
      legende: 'Les sept phases du modèle (cycle.phases), dans l’ordre du cycle',
      colonnes: ['Phase', 'Porteur', 'Rôle', 'Sortie', 'Garde'],
      lignes: w.etapes.map((e) => [e.nom, e.porteur ?? '—', e.detail ?? '—', e.sortie ?? '—', e.garde ?? '—']),
    });
  } else if (w.parPhase.length) {
    etapes = tableau({
      legende: 'Ce que le workflow fait à chaque phase',
      colonnes: ['Phase', 'Échanges', 'Garde'],
      lignes: w.parPhase.map((x) => [x.nomPhase, x.echanges ?? '—', x.garde ?? '—']),
    });
  } else if (w.etapes.length) {
    etapes = html`<ol class="etapes">${w.etapes.map((e) => html`<li>${e.nom}${e.detail ? html` <span class="suite">(${e.detail})</span>` : ''}</li>`)}</ol>`;
  } else {
    etapes = html`<p class="vide">${w.transverse ? 'Workflow transverse : il sert toutes les phases.' : 'Aucune étape décrite.'}</p>`;
  }
  const contenu = html`<h1>${w.nom}</h1>
${w.resume ? html`<p>${w.resume}</p>` : ''}
${fiche([
    ['Projet', html`<a href="/workflows#projet-${projet.id}">${projet.nom}</a>`], ['Identifiant', html`<code>${w.id}</code>`],
    ['Nature', NATURES[w.nature] ?? w.nature ?? '—'], ['Exécutant', w.executant ?? '—'],
    w.fichier ? ['Fichier', document ? html`<a href="/donnees/${document.id}"><code>${w.fichier}</code></a>` : html`<code>${w.fichier}</code>`] : null,
    w.commande ? ['Commande', html`<code>${w.commande}</code>`] : null,
    w.source ? ['Source', w.source] : null,
    w.etat ? ['État', w.etat] : null,
    projet.etat ? ['État du projet', projet.etat] : null,
  ])}
<h2>Étapes</h2>
${etapes}
<h2>Déclencheurs</h2>
${tableau({
    legende: `Ce qui lance ${w.nom}`,
    colonnes: ['Déclencheur', 'Détail', 'Ici'],
    lignes: w.declencheurs.map((d) => [d.libelle, d.detail ?? '—', d.action ? html`<a href="/declencheurs#action-${d.action}">${ACTIONS[d.action]?.verbe ?? 'Lancer'}</a>` : 'non']),
    vide: 'Aucun déclencheur décrit.',
  })}
${actions.length ? html`<h2>Dernières demandes</h2>
${tableau({ legende: `Les dix dernières demandes de ${w.nom}`, colonnes: COLONNES_DEMANDES, lignes: lignesDemandes(demandes), vide: 'Aucune demande encore.' })}` : ''}`;
  return page({ titre: w.nom, actif: 'workflows', fil: [['/', 'Accueil'], ['/workflows', 'Workflows'], [`/workflows#projet-${projet.id}`, projet.nom], [null, w.nom]], contenu });
}

// ── Déclencheurs ────────────────────────────────────────────────────────────

/** Pourquoi un déclencheur ne se lance pas d'ici. */
function horsInterface(d) {
  if (d.projet.origine === 'specification') return 'non : n8n n’est pas installé';
  return {
    poussee: 'non : sur la forge (Gitea au backlog)', manuel_forge: 'non : sur la forge (Gitea au backlog)', planifie: 'non : planifié',
    commande: 'non : à la main, sur la VM', script: 'non : par son script', workflow: 'non : par son workflow',
  }[d.type] ?? 'non';
}

function carteAction(app, cle, active, extra) {
  const a = ACTIONS[cle];
  const erreurs = extra.action === cle ? extra.erreurs ?? {} : {};
  const decrit = active ? `action-${cle}-aide action-${cle}-occupee` : `action-${cle}-aide`;
  return html`<section class="carte" id="action-${cle}" aria-labelledby="action-${cle}-titre">
<h3 id="action-${cle}-titre">${a.nom}</h3>
<p id="action-${cle}-aide">${a.aide}</p>
${active ? html`<p id="action-${cle}-occupee">${statut(active.statut)} <a href="/suivi/demandes/${active.id}">Demande n° ${active.id}</a> : une autre ne se dépose qu’après elle.</p>` : ''}
<form method="post" action="/declencheurs/${cle}" novalidate>
<input type="hidden" name="_csrf" value="${app.csrf}">
${cle === 'campagne' ? html`${recapitulatifErreurs(erreurs, { libelle: 'action-campagne-libelle' }, { niveau: 4 })}${champ({ id: 'action-campagne-libelle', nom: 'libelle', etiquette: 'Libellé de la campagne', valeur: extra.saisie?.libelle ?? '', requis: true, erreur: erreurs.libelle, aide: 'Ce qui la distingue des autres : « après la révision 0.3 »… 200 caractères au plus.', attributs: 'maxlength="200"' })}` : ''}
<button type="submit" aria-describedby="${decrit}"${active ? html` disabled` : ''}>${a.verbe}</button>
</form>
</section>`;
}

/** La validation finale : le bouton, puis les validations déjà faites (mesure 10.2). */
function sectionValidation(app, faites, extra) {
  const erreurs = extra.validation?.erreurs ?? {};
  const saisie = extra.validation?.saisie ?? {};
  return html`<section class="carte" id="validation" aria-labelledby="validation-titre">
<h2 id="validation-titre">Validation finale</h2>
<p id="validation-aide">Valider une release la met en production : le délai commit → production (critère 10.2) va du commit de la release à cette validation. Une release ne se valide qu’une fois, et une validation ne se modifie plus.</p>
<form method="post" action="/validations" novalidate>
<input type="hidden" name="_csrf" value="${app.csrf}">
${recapitulatifErreurs(erreurs, { release: 'validation-release', commentaire: 'validation-commentaire', confirmation: 'validation-confirmation' }, { niveau: 3 })}
${champ({ id: 'validation-release', nom: 'release', etiquette: 'Release validée', valeur: saisie.release ?? '', requis: true, erreur: erreurs.release, aide: 'Un tag (v0.5.0) ou un commit. 100 caractères au plus.', attributs: 'maxlength="100" autocomplete="off" spellcheck="false"' })}
${champ({ id: 'validation-commentaire', nom: 'commentaire', etiquette: 'Commentaire', valeur: saisie.commentaire ?? '', erreur: erreurs.commentaire, aide: 'Facultatif : ce qui a été vérifié avant de valider. 500 caractères au plus.', attributs: 'maxlength="500"' })}
<div class="champ${erreurs.confirmation ? ' champ-erreur' : ''}">
${erreurs.confirmation ? html`<p class="erreur" id="validation-confirmation-erreur"><span aria-hidden="true">⚠</span> ${erreurs.confirmation}</p>` : ''}
<input type="checkbox" id="validation-confirmation" name="confirmation" value="1" required${erreurs.confirmation ? html` aria-invalid="true" aria-describedby="validation-confirmation-erreur"` : ''}>
<label for="validation-confirmation">Je confirme que cette release est en production : sa validation ne pourra être ni modifiée ni retirée. <span class="requis">(obligatoire)</span></label>
</div>
<button type="submit" aria-describedby="validation-aide">Validation finale</button>
</form>
${tableau({
    legende: `Validations finales, la plus récente d’abord (${faites.length})`,
    colonnes: ['Release', 'Validée le', 'Par', 'Commentaire'],
    lignes: faites.map((v) => [v.release, date(v.valide_le), v.valide_par, v.commentaire ?? '—']),
    vide: 'Aucune release validée : la mesure 10.2 n’a pas encore de mise en production.',
  })}
</section>`;
}

export async function pageDeclencheurs({ app, url }, extra = {}) {
  const [cat, executeur, actives, faites] = await Promise.all([catalogueEnBase(app.principal), etatExecuteur(app), demandesActives(app), validations(app.principal, { file: app.file })]);
  const activeDe = new Map(actives.map((d) => [d.action, d]));
  const tous = aplatirDeclencheurs(cat);
  const contenu = html`<h1>Déclencheurs</h1>
<p>Ce qui lance chaque workflow. Les ${enLettres(Object.keys(ACTIONS).length)} actions ci-dessous se lancent d’ici : l’interface dépose une demande, et l’exécuteur l’exécute sur une copie fraîche du dépôt. Le suivi de chaque demande montre sa sortie au fil de l’exécution.</p>
${noticeExecuteur(executeur)}
<h2>Lancer depuis l’interface</h2>
<div class="actions-pilotage">${Object.keys(ACTIONS).map((cle) => carteAction(app, cle, activeDe.get(cle), extra))}</div>
${sectionValidation(app, faites, extra)}
<h2>Tous les déclencheurs</h2>
${avertissementsCatalogue(cat)}
${cat.projets.length ? cat.projets.map((p) => {
    const lot = tous.filter((d) => d.projet === p);
    return html`<h3 id="declencheurs-${p.id}">${p.nom}</h3>
${tableau({
      legende: `${lot.length} déclencheurs de ${p.nom}, par workflow`,
      colonnes: ['Déclencheur', 'Détail', 'Workflow', 'Ici'],
      lignes: lot.map((d) => [
        d.libelle, d.detail ?? '—', html`<a href="/workflows/${p.id}/${d.workflowCible.id}">${d.workflowCible.nom}</a>`,
        d.action ? html`<a href="#action-${d.action}">oui : ${ACTIONS[d.action]?.nom ?? d.action}</a>` : horsInterface(d),
      ]),
      vide: 'Aucun déclencheur décrit.',
    })}`;
  }) : html`<p class="vide">Aucun déclencheur : le catalogue des workflows n’est pas chargé.</p>`}`;
  return page({
    titre: extra.erreurs || extra.validation?.erreurs ? 'Erreur : déclencheurs' : 'Déclencheurs', actif: 'declencheurs', fil: [['/', 'Accueil'], [null, 'Déclencheurs']],
    contenu, message: url ? messageDe(url) : null, alerte: extra.alerte ?? null,
  });
}

export async function deposerDemande(ctx) {
  const { app, res, corps, params } = ctx;
  const [action] = params;
  if (!Object.hasOwn(ACTIONS, action)) throw new ErreurHttp(404, `Aucune action « ${action} » ne se déclenche d’ici.`);
  const saisie = { libelle: corps.get('libelle') ?? '' };
  const v = validerDemande(action, saisie);
  if (v.erreurs) return { code: 422, corps: await pageDeclencheurs(ctx, { action, erreurs: v.erreurs, saisie }) };
  try {
    const d = await deposer(app.principal, { action, parametres: v.parametres, demandeur: demandeurDe(app), file: app.file });
    return rediriger(res, `/suivi/demandes/${d.id}?fait=demande-deposee`);
  } catch (e) {
    if (!(e instanceof DemandeRefusee)) throw e;
    return { code: 409, corps: await pageDeclencheurs(ctx, { alerte: e.message }) };
  }
}

/** Le bouton « Validation finale » : enregistre la validation, ou redit le formulaire avec ses erreurs. */
export async function validerRelease(ctx) {
  const { app, res, corps } = ctx;
  const saisie = { release: corps.get('release') ?? '', commentaire: corps.get('commentaire') ?? '', confirmation: corps.get('confirmation') ?? '' };
  const v = validerValidation(saisie);
  if (v.erreurs) return { code: 422, corps: await pageDeclencheurs(ctx, { validation: { erreurs: v.erreurs, saisie } }) };
  try {
    await enregistrerValidation(app.principal, { ...v.valeurs, validePar: demandeurDe(app), file: app.file });
    return rediriger(res, '/declencheurs?fait=validation-enregistree#validation');
  } catch (e) {
    if (!(e instanceof ValidationRefusee)) throw e;
    // l'erreur porte sur la release : reliée à son champ, comme une erreur de saisie
    return { code: e.code, corps: await pageDeclencheurs(ctx, { validation: { erreurs: { release: e.message }, saisie: { ...saisie, confirmation: '' } } }) };
  }
}

// ── Suivi ───────────────────────────────────────────────────────────────────

export async function pageSuivi({ app, url }) {
  const db = app.principal;
  const [executeur, actives, cat] = await Promise.all([etatExecuteur(app), demandesActives(app), catalogueEnBase(db)]);
  const { rows: recentes } = await db.query("SELECT * FROM pilotage.v_demande WHERE file = $1 AND statut NOT IN ('en_attente', 'en_cours') ORDER BY id DESC LIMIT 10", [app.file]);
  const { rows: cycles } = await db.query(`
    SELECT e.instance, e.numero, e.release, e.debut, e.fin, e.en_ci, e.contenu -> 'viabilite' AS viabilite, d.charge_le, d.campagne_id,
           (SELECT string_agg(p.phase, ', ' ORDER BY p.phase) FROM donnees.phase p WHERE p.instance = e.instance AND p.numero = e.numero AND p.statut = 'bloquee') AS bloquees,
           (SELECT count(*) FROM donnees.proposition p WHERE p.instance = e.instance AND p.numero = e.numero) AS propositions
    FROM donnees.entree e JOIN donnees.document d ON d.chemin = e.chemin
    ORDER BY e.instance, e.numero DESC`);
  const dernierClos = cycles.find((c) => c.fin);
  const { rows: propositions } = dernierClos
    ? await db.query('SELECT critere, nature, motif FROM donnees.proposition WHERE instance = $1 AND numero = $2 ORDER BY rang', [dernierClos.instance, dernierClos.numero])
    : { rows: [] };
  const reperes = await reperesModele(db);
  const { rows: [campagne] } = await db.query('SELECT * FROM recette.v_campagne ORDER BY id DESC LIMIT 1');
  const binome = cat.projets.find((p) => p.origine === 'specification');
  const decisions = binome?.decisions ?? [];
  const ratifiees = decisions.filter((d) => d.statut === 'ratifiee').length;
  // Les phases bloquées, dans l'ordre du cycle
  const nomPhase = (liste) => (liste ? liste.split(', ').sort((a, b) => reperes.ordrePhases.indexOf(a) - reperes.ordrePhases.indexOf(b)).map((p) => reperes.phases.get(p) ?? p).join(', ') : 'aucune');
  const contenu = html`<h1>Suivi</h1>
<p>Où en sont les demandes, les cycles du journal, les campagnes de recette et le binôme.</p>
<nav aria-label="Sections du suivi"><ul>
<li><a href="#file">Exécuteur et file</a></li><li><a href="#recentes">Demandes récentes</a></li><li><a href="#cycles">Cycles du journal</a></li>
<li><a href="#propositions">Propositions au modèle</a></li><li><a href="#campagne">Dernière campagne</a></li>${binome ? html`<li><a href="#binome">Binôme</a></li>` : ''}
</ul></nav>
<h2 id="file">Exécuteur et file</h2>
${noticeExecuteur(executeur)}
${tableau({
    legende: 'Demandes en attente ou en cours',
    colonnes: [...COLONNES_DEMANDES, 'Commande'],
    lignes: actives.map((d) => [...lignesDemandes([d])[0], commandesDemande(app, d)]),
    vide: 'Aucune demande en attente ni en cours.',
  })}
<p class="actions"><a class="bouton" href="/declencheurs">Déclencher un workflow</a></p>
<h2 id="recentes">Demandes récentes</h2>
${tableau({ legende: 'Les dix dernières demandes terminées, de la plus récente à la plus ancienne', colonnes: COLONNES_DEMANDES, lignes: lignesDemandes(recentes), vide: 'Aucune demande terminée.' })}
<p><a href="/suivi/demandes">Toutes les demandes</a></p>
<h2 id="cycles">Cycles du journal</h2>
${cycles[0] ? html`<p class="aide">Journal lu dans le dépôt le ${date(cycles[0].charge_le)}${cycles[0].campagne_id ? html`, par la <a href="/campagnes/${cycles[0].campagne_id}">campagne n° ${cycles[0].campagne_id}</a>` : ''}. <a href="/declencheurs#action-charger">Recharger les données du dépôt</a> ; <a href="/declencheurs#action-cycle">demander un cycle à blanc</a>.</p>` : ''}
${tableau({
    legende: 'Les entrées du journal, de la plus récente à la plus ancienne',
    colonnes: ['Cycle', 'Release', 'Début', 'Entrée', 'En CI', 'Viabilité', 'Phases bloquées', { texte: 'Propositions', nombre: true }],
    lignes: cycles.map((c) => [
      html`<a href="/suivi/cycles/${c.instance}/${c.numero}">${c.instance} n° ${c.numero}</a>`, c.release ? html`<code>${c.release}</code>` : '—', date(c.debut),
      statut(c.fin ? 'close' : 'ouverte'), ouiNon(c.en_ci),
      c.viabilite ? html`${statut(c.viabilite.viable ? 'viable' : 'non_viable')}${c.viabilite.progresse ? ' en progrès' : ''}` : '—',
      nomPhase(c.bloquees), nombre(c.propositions),
    ]),
    vide: 'Aucune entrée de journal chargée : lancer une campagne ou recharger les données.',
  })}
<h2 id="propositions">Propositions au modèle</h2>
${dernierClos ? html`<p>Celles du dernier cycle clos, <a href="/suivi/cycles/${dernierClos.instance}/${dernierClos.numero}">${dernierClos.instance} n° ${dernierClos.numero}</a> : elles attendent la ratification du méta-projet (EQ.2).</p>` : ''}
${tableau({ legende: 'Propositions du dernier cycle clos', colonnes: ['Critère', 'Nature', 'Motif'], lignes: propositions.map((p) => [p.critere, p.nature, p.motif]), vide: 'Aucune proposition en attente.' })}
<h2 id="campagne">Dernière campagne de recette</h2>
${campagne ? html`${fiche([
    ['Campagne', html`<a href="/campagnes/${campagne.id}">n° ${campagne.id}</a>`], ['Libellé', campagne.libelle], ['Statut', statut(campagne.statut)], ['Début', date(campagne.debut)],
    ['Tests', nombre(campagne.tests)], ['Réussis', nombre(campagne.reussis)], ['En échec ou en erreur', nombre(Number(campagne.echoues) + Number(campagne.erreurs))], ['Opérations', nombre(campagne.operations)],
  ])}<p><a href="/campagnes">Toutes les campagnes</a></p>` : html`<p class="vide">Aucune campagne : <a href="/declencheurs#action-campagne">en demander une</a>.</p>`}
${binome ? html`<h2 id="binome">${binome.nom}</h2>
<div class="notice"><p>${binome.etat ? `${majuscule(binome.etat)}.` : ''} Aucune tâche ne circule encore : elles viendront des issues Gitea et de leurs labels d’état (voir <a href="/workflows#taches-${binome.id}">les états et transitions</a>).</p></div>
<h3 id="decisions">Décisions de la spécification</h3>
<p>${nombre(ratifiees)} ratifiée(s) sur ${nombre(decisions.length)}. ${binome.source ? `D’après ${binome.source}.` : ''}</p>
${tableau({
    legende: 'Décisions de la spécification du binôme et leur statut',
    colonnes: [{ texte: 'N°', nombre: true }, 'Décision', 'Retenu', 'Autre voie', 'Statut'],
    lignes: decisions.map((d) => [nombre(d.numero), d.decision, d.proposition, d.autre_voie, html`${statut(d.statut)}${d.ratifiee_le ? html` le ${jour(d.ratifiee_le)}` : ''}`]),
    vide: 'Aucune décision.',
  })}` : ''}`;
  return page({ titre: 'Suivi', actif: 'suivi', fil: [['/', 'Accueil'], [null, 'Suivi']], contenu, message: messageDe(url) });
}

export async function listeDemandes({ app, url }) {
  const n = Math.max(1, entier(url.searchParams.get('page'), 1));
  const parPage = 50;
  const { rows: [{ total }] } = await app.principal.query('SELECT count(*) AS total FROM pilotage.demande WHERE file = $1', [app.file]);
  const { rows } = await app.principal.query('SELECT * FROM pilotage.v_demande WHERE file = $1 ORDER BY id DESC LIMIT $2 OFFSET $3', [app.file, parPage, (n - 1) * parPage]);
  const contenu = html`<h1>Demandes</h1>
<p>${nombre(total)} demande(s) déposée(s) depuis l’interface.</p>
${tableau({ legende: `Demandes, page ${n}`, colonnes: COLONNES_DEMANDES, lignes: lignesDemandes(rows), vide: 'Aucune demande.' })}
${pagination({ page: n, total: Number(total), parPage, base: '/suivi/demandes' })}`;
  return page({ titre: n > 1 ? `Demandes, page ${n}` : 'Demandes', actif: 'suivi', fil: [['/', 'Accueil'], ['/suivi', 'Suivi'], [null, 'Demandes']], contenu });
}

async function resultatDemande(app, d) {
  if (d.action === 'campagne') {
    if (!d.campagne_id) return html`<p class="vide">${STATUTS_FINAUX.has(d.statut) ? 'Aucune campagne ouverte par cette demande.' : 'La campagne n’est pas encore ouverte.'}</p>`;
    const { rows: [c] } = await app.principal.query('SELECT * FROM recette.v_campagne WHERE id = $1', [d.campagne_id]);
    if (!c) return html`<p class="vide">La campagne n° ${d.campagne_id} a été supprimée.</p>`;
    return html`${fiche([
      ['Campagne', html`<a href="/campagnes/${c.id}">n° ${c.id}</a>`], ['Statut', statut(c.statut)], ['Tests', nombre(c.tests)], ['Réussis', nombre(c.reussis)],
      ['En échec ou en erreur', nombre(Number(c.echoues) + Number(c.erreurs))], ['Omis', nombre(c.omis)], ['Opérations', nombre(c.operations)], ['Release examinée', c.release ?? '—'],
    ])}`;
  }
  if (d.action === 'valider') return d.resultat?.conclusion ? html`<p>Conclusion : <strong>${d.resultat.conclusion}</strong></p>` : html`<p class="vide">Pas de conclusion lue : voir la sortie.</p>`;
  if (d.action === 'charger') {
    const c = d.resultat?.documents;
    return c ? fiche([['Modèle', nombre(c.modele)], ['Manifestes', nombre(c.manifeste)], ['Entrées de journal', nombre(c.journal)], ['Catalogue des workflows', nombre(c.workflows)], ['Workflows de CI', nombre(c.ci)]]) : html`<p class="vide">Aucun document rechargé.</p>`;
  }
  if (d.action === 'cycle') {
    const e = d.resultat?.entree;
    if (!e) return html`<p class="vide">${STATUTS_FINAUX.has(d.statut) ? 'Aucune entrée produite : voir la sortie.' : 'L’entrée sera lisible à la fin du cycle.'}</p>`;
    if (!e.contenu) return html`<p class="erreur">Entrée <code>${e.chemin}</code> illisible : ${e.erreur ?? 'contenu vide'}.</p>`;
    return html`<p>${statut('a_blanc')} Entrée <code>${e.chemin}</code>, produite sur une copie du dépôt : elle ne figure pas au journal.</p>
${rendreEntree(e.contenu, await reperesModele(app.principal), { niveau: 3 })}`;
  }
  return '';
}

export async function pageDemande({ app, url, params }, extra = {}) {
  const d = await demandeOu404(app, Number(params[0]));
  const finale = STATUTS_FINAUX.has(d.statut);
  const suivre = !finale && url.searchParams.get('suivre') === '1';
  const libelle = d.parametres?.libelle;
  const contenu = html`<h1>Demande n° ${d.id} : ${nomAction(d.action)}</h1>
${suivre ? html`<div class="notice"><p>Suivi automatique : la page se recharge toutes les ${SUIVI_AUTO_S} secondes, jusqu’à la fin de la demande. <a href="/suivi/demandes/${d.id}">Arrêter le suivi automatique</a></p></div>` : ''}
${fiche([
    ['Action', nomAction(d.action)], libelle ? ['Libellé', libelle] : null, ['Statut', statut(d.statut)], ['Déposée', date(d.demandee_le)], ['Par', d.demandeur],
    ['Exécuteur', d.executeur ?? '—'], ['Début', date(d.debut)], ['Fin', date(d.fin)], ['Attente', duree(d.attente_s)], ['Durée', duree(d.duree_s)],
    ['Code de retour', d.code_retour ?? '—'], d.arret_le ? ['Arrêt demandé', date(d.arret_le)] : null,
  ])}
<div class="actions">
<a href="/suivi/demandes/${d.id}">Actualiser</a>
${!finale && !suivre ? html`<a href="/suivi/demandes/${d.id}?suivre=1">Suivre automatiquement (toutes les ${SUIVI_AUTO_S} s)</a>` : ''}
${commandesDemande(app, d)}
</div>
<h2>Résultat</h2>
${await resultatDemande(app, d)}
<h2 id="sortie">Sortie</h2>
${d.sortie ? html`<p class="aide">${nombre(d.sortie.length)} caractères${d.sortie.startsWith('[début de la sortie omis]') ? ', la fin seulement' : ''} ; mots de passe masqués.</p>
<div class="sortie" tabindex="0" role="region" aria-labelledby="sortie"><pre><code>${d.sortie}</code></pre></div>` : html`<p class="vide">${d.statut === 'en_attente' ? 'Rien encore : la demande attend l’exécuteur.' : 'Aucune sortie.'}</p>`}`;
  return page({
    titre: `Demande n° ${d.id}`, actif: 'suivi', fil: [['/', 'Accueil'], ['/suivi', 'Suivi'], ['/suivi/demandes', 'Demandes'], [null, `Demande n° ${d.id}`]],
    contenu, message: messageDe(url), alerte: extra.alerte ?? null, rafraichir: suivre ? SUIVI_AUTO_S : null,
  });
}

async function agirSurDemande(ctx, fn, fait) {
  const { app, res, params } = ctx;
  const id = Number(params[0]);
  try {
    await fn(app.principal, id, { file: app.file });
    return rediriger(res, `/suivi/demandes/${id}?fait=${fait}`);
  } catch (e) {
    if (!(e instanceof DemandeRefusee)) throw e;
    if (e.code === 404) throw new ErreurHttp(404, e.message);
    return { code: 409, corps: await pageDemande({ ...ctx, url: new URL(`http://interface.local/suivi/demandes/${id}`) }, { alerte: e.message }) };
  }
}

export const annulerDemande = (ctx) => agirSurDemande(ctx, annuler, 'demande-annulee');
export const arreterDemande = (ctx) => agirSurDemande(ctx, arreter, 'arret-demande');

export async function pageCycle({ app, params }) {
  const [instance, numero] = params;
  const { rows: [e] } = await app.principal.query('SELECT chemin, contenu FROM donnees.entree WHERE instance = $1 AND numero = $2', [instance, Number(numero)]);
  if (!e) throw new ErreurHttp(404, `Aucune entrée n° ${numero} pour l’instance ${instance} dans le journal chargé.`);
  const contenu = html`<h1>Cycle ${instance} n° ${numero}</h1>
<p>Entrée <code>${e.chemin}</code> du journal, telle que chargée depuis le dépôt.</p>
${rendreEntree(e.contenu, await reperesModele(app.principal), { niveau: 2 })}`;
  return page({ titre: `Cycle ${instance} n° ${numero}`, actif: 'suivi', fil: [['/', 'Accueil'], ['/suivi', 'Suivi'], [null, `Cycle ${instance} n° ${numero}`]], contenu });
}

/** La section « Pilotage » du tableau de bord : un coup d'œil sur tout le reste. */
export async function sectionPilotage(app) {
  const db = app.principal;
  const [executeur, actives, cat] = await Promise.all([etatExecuteur(app), demandesActives(app), catalogueEnBase(db)]);
  const { rows: [dernier] } = await db.query('SELECT instance, numero, release, fin, contenu -> \'viabilite\' AS viabilite FROM donnees.entree ORDER BY debut DESC NULLS LAST, numero DESC LIMIT 1');
  const { rows: [derniere] } = await db.query('SELECT * FROM pilotage.v_demande WHERE file = $1 ORDER BY id DESC LIMIT 1', [app.file]);
  const binome = cat.projets.find((p) => p.origine === 'specification');
  const workflows = cat.projets.reduce((n, p) => n + p.workflows.length, 0);
  return html`<h2>Pilotage</h2>
${fiche([
    ['Exécuteur', statut(executeur?.actif ? 'actif' : 'absent')],
    ['Demandes en attente ou en cours', nombre(actives.length)],
    ['Dernière demande', derniere ? html`${lienDemande(derniere)} : ${nomAction(derniere.action)}, ${statut(derniere.statut)}` : 'aucune'],
    ['Dernier cycle du journal', dernier ? html`<a href="/suivi/cycles/${dernier.instance}/${dernier.numero}">${dernier.instance} n° ${dernier.numero}</a>, ${dernier.fin ? 'clos' : 'ouvert'}${dernier.viabilite ? (dernier.viabilite.viable ? ', viable' : ', non viable') : ''}` : 'aucun chargé'],
    ['Workflows décrits', `${nombre(workflows)} dans ${nombre(cat.projets.length)} projet(s)`],
    binome ? ['Décisions du binôme ratifiées', `${nombre((binome.decisions ?? []).filter((d) => d.statut === 'ratifiee').length)} sur ${nombre((binome.decisions ?? []).length)}`] : null,
  ])}
<p class="actions"><a class="bouton" href="/declencheurs">Déclencher un workflow</a> <a href="/suivi">Suivi</a> <a href="/workflows">Workflows</a></p>`;
}

// ── Routes ──────────────────────────────────────────────────────────────────
export const ROUTES_PILOTAGE = [
  ['GET', /^\/workflows$/, pageWorkflows],
  ['GET', new RegExp(`^/workflows/(${RE_ID})/(${RE_ID})$`), pageWorkflow],
  ['GET', /^\/declencheurs$/, pageDeclencheurs],
  ['POST', /^\/declencheurs\/([a-z]{1,20})$/, deposerDemande],
  ['POST', /^\/validations$/, validerRelease],
  ['GET', /^\/suivi$/, pageSuivi],
  ['GET', /^\/suivi\/demandes$/, listeDemandes],
  ['GET', /^\/suivi\/demandes\/(\d{1,15})$/, pageDemande],
  ['POST', /^\/suivi\/demandes\/(\d{1,15})\/annuler$/, annulerDemande],
  ['POST', /^\/suivi\/demandes\/(\d{1,15})\/arreter$/, arreterDemande],
  ['GET', new RegExp(`^/suivi/cycles/(${RE_ID})/(\\d{1,6})$`), pageCycle],
];
