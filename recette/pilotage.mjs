/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  recette/pilotage.mjs : workflows, déclencheurs et demandes d'exécution
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Ce que l'interface et l'exécuteur partagent :
 *
 *    ACTIONS         la liste blanche de ce que l'interface peut déclencher,
 *                    avec les paramètres permis et la commande exécutée. La base
 *                    tient la même liste (pilotage.parametres_valides) : les
 *                    deux gardes se vérifient l'une l'autre dans les tests.
 *    catalogue()     les projets et leurs workflows, depuis recette/workflows.yaml
 *                    et les workflows de CI chargés comme documents ; les
 *                    déclencheurs et étapes d'un workflow de CI sont lus dans son
 *                    fichier, ceux du cycle 7E dans le modèle.
 *    deposer(), annuler(), arreter()
 *                    les demandes, telles que l'interface les dépose : une seule
 *                    en attente ou en cours par action, la base le garantit.
 *    valider…(), enregistrerValidation(), derniereValidation()
 *                    la validation finale d'une release par une personne, qui la
 *                    met en production : la mesure 10.2 s'arrête là.
 */

/** Une seule demande en attente ou en cours par action : refus explicite. */
export class DemandeRefusee extends Error {
  constructor(message, { code = 409, existante = null } = {}) {
    super(message);
    this.code = code;
    this.existante = existante;
  }
}

const LIBELLE_MAX = 200;

/**
 * Les actions que l'interface peut demander. `commande(parametres, demande)`
 * rend l'argv exécuté dans la copie du dépôt (jamais par un shell) ; une action
 * sans commande est exécutée par l'exécuteur lui-même.
 */
export const ACTIONS = Object.freeze({
  campagne: Object.freeze({
    nom: 'Campagne de recette',
    verbe: 'Demander la campagne',
    aide: 'Les suites du dépôt et les tests définis en base, sur l’état courant du dépôt. Quelques minutes.',
    parametres: ['libelle'],
    delaiMin: 90,
    commande: (p, d) => ['recette/lancer.mjs', 'campagne', `--libelle=${p.libelle}`, `--demande=${d.id}`],
  }),
  valider: Object.freeze({
    nom: 'Évaluer seul',
    verbe: 'Demander la validation',
    aide: 'Modèle, manifeste, release, CI et outils, sans examiner. Quelques secondes.',
    parametres: [],
    delaiMin: 10,
    commande: () => ['resolveur7e.mjs', 'valider'],
  }),
  cycle: Object.freeze({
    nom: 'Cycle à blanc',
    verbe: 'Demander un cycle à blanc',
    aide: 'Le cycle complet sur une copie du dépôt : l’entrée produite reste dans la demande, jamais au journal. Une à quelques minutes.',
    parametres: [],
    delaiMin: 60,
    commande: () => ['resolveur7e.mjs', 'cycle'],
  }),
  charger: Object.freeze({
    nom: 'Recharger les données du dépôt',
    verbe: 'Demander le rechargement',
    aide: 'Modèle, manifestes, journal et workflows relus depuis le dépôt, sans lancer de test. Quelques secondes.',
    parametres: [],
    delaiMin: 5,
    commande: null,
  }),
});

/** Statuts d'une demande, dans l'ordre de leur vie. */
export const STATUTS_DEMANDE = ['en_attente', 'en_cours', 'reussie', 'echouee', 'annulee', 'interrompue'];
export const STATUTS_FINAUX = new Set(['reussie', 'echouee', 'annulee', 'interrompue']);

/**
 * Paramètres d'une demande depuis les champs d'un formulaire : rend
 * { parametres } ou { erreurs: { champ: message } }. Mêmes règles que la base.
 */
export function validerDemande(action, champs = {}) {
  if (!Object.hasOwn(ACTIONS, action)) return { erreurs: { action: `Action inconnue : ${String(action).slice(0, 50)}.` } };
  if (action !== 'campagne') return { parametres: {} };
  const libelle = String(champs.libelle ?? '').trim();
  if (!libelle) return { erreurs: { libelle: 'Le libellé de la campagne est obligatoire.' } };
  if (libelle.length > LIBELLE_MAX) return { erreurs: { libelle: `Le libellé dépasse ${LIBELLE_MAX} caractères (${libelle.length}).` } };
  if (/[\u0000-\u001f\u007f-\u009f]/.test(libelle)) return { erreurs: { libelle: 'Le libellé ne doit contenir aucun caractère de contrôle (retour à la ligne, tabulation…).' } };
  return { parametres: { libelle } };
}

// ── Les demandes, côté interface ────────────────────────────────────────────

/** La file que sert l'exécuteur de la pile, et où l'interface dépose. */
export const FILE_PRINCIPALE = 'principale';

/** Dépose une demande ; refuse si une demande de la même action attend ou tourne dans la file. */
export async function deposer(principal, { action, parametres = {}, demandeur, file = FILE_PRINCIPALE }) {
  try {
    const { rows: [d] } = await principal.query(
      'INSERT INTO pilotage.demande (file, action, parametres, demandeur) VALUES ($1, $2, $3::jsonb, $4) RETURNING *',
      [file, action, JSON.stringify(parametres), String(demandeur ?? '').slice(0, 200) || 'interface'],
    );
    return d;
  } catch (e) {
    if (e.code !== '23505') throw e;
    const { rows: [x] } = await principal.query(
      "SELECT id, statut FROM pilotage.demande WHERE file = $1 AND action = $2 AND statut IN ('en_attente', 'en_cours') ORDER BY id LIMIT 1",
      [file, action],
    );
    throw new DemandeRefusee(
      `Une demande « ${ACTIONS[action]?.nom ?? action} » est déjà ${x?.statut === 'en_cours' ? 'en cours' : 'en attente'}${x ? ` : la n° ${x.id}` : ''}. Elle doit se terminer, ou être annulée, avant une autre.`,
      { existante: x ?? null },
    );
  }
}

/** Annule une demande encore en attente ; rend la demande, ou lève si elle a démarré. */
export async function annuler(principal, id, { file = FILE_PRINCIPALE } = {}) {
  const { rows: [d] } = await principal.query(
    "UPDATE pilotage.demande SET statut = 'annulee', fin = greatest(now(), demandee_le) WHERE id = $1 AND file = $2 AND statut = 'en_attente' RETURNING *",
    [id, file],
  );
  if (d) return d;
  const { rows: [x] } = await principal.query('SELECT id, statut FROM pilotage.demande WHERE id = $1 AND file = $2', [id, file]);
  if (!x) throw new DemandeRefusee(`Aucune demande n° ${id}.`, { code: 404 });
  throw new DemandeRefusee(`La demande n° ${id} n’est plus en attente (${x.statut.replace('_', ' ')}) : elle ne s’annule plus.`);
}

/** Demande l'arrêt d'une demande en cours : l'exécuteur l'interrompt à sa prochaine vérification. */
export async function arreter(principal, id, { file = FILE_PRINCIPALE } = {}) {
  const { rows: [d] } = await principal.query(
    "UPDATE pilotage.demande SET arret_le = coalesce(arret_le, greatest(now(), debut)) WHERE id = $1 AND file = $2 AND statut = 'en_cours' RETURNING *",
    [id, file],
  );
  if (d) return d;
  const { rows: [x] } = await principal.query('SELECT id, statut FROM pilotage.demande WHERE id = $1 AND file = $2', [id, file]);
  if (!x) throw new DemandeRefusee(`Aucune demande n° ${id}.`, { code: 404 });
  throw new DemandeRefusee(`La demande n° ${id} n’est pas en cours (${x.statut.replace('_', ' ')}) : rien à arrêter.`);
}

// ── La validation finale d'une release ─────────────────────────────────────

/** Une release qui se valide deux fois, ou que la base refuse. */
export class ValidationRefusee extends Error {
  constructor(message, { code = 409 } = {}) {
    super(message);
    this.code = code;
  }
}

const RE_RELEASE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$/;
const COMMENTAIRE_MAX = 500;

/** Les champs du formulaire de validation finale : { valeurs } ou { erreurs }. Mêmes règles que la base. */
export function validerValidation(champs = {}) {
  const release = String(champs.release ?? '').trim();
  const commentaire = String(champs.commentaire ?? '').trim();
  const erreurs = {};
  // irréversible : une confirmation explicite (WCAG 3.3.4, RGAA 11.11)
  if (!release) erreurs.release = 'La release validée est obligatoire : un tag (v0.5.0) ou un commit.';
  else if (!RE_RELEASE.test(release) || release.includes('..')) erreurs.release = 'La release ne contient que des lettres, chiffres, points, tirets, soulignés et barres obliques, 100 caractères au plus, sans « .. » : un tag (v0.5.0) ou un commit.';
  if (commentaire.length > COMMENTAIRE_MAX) erreurs.commentaire = `Le commentaire dépasse ${COMMENTAIRE_MAX} caractères (${commentaire.length}).`;
  else if (/[\u0000-\u001f\u007f-\u009f]/.test(commentaire)) erreurs.commentaire = 'Le commentaire ne doit contenir aucun caractère de contrôle (retour à la ligne, tabulation…).';
  if (champs.confirmation !== '1') erreurs.confirmation = 'Cochez la confirmation : une validation finale ne se modifie ni ne se retire.';
  return Object.keys(erreurs).length ? { erreurs } : { valeurs: { release, commentaire: commentaire || null } };
}

/** Enregistre la validation finale d'une release ; une release ne se valide qu'une fois par file. */
export async function enregistrerValidation(principal, { release, commentaire = null, validePar, file = FILE_PRINCIPALE }) {
  try {
    const { rows: [v] } = await principal.query(
      'INSERT INTO pilotage.validation (file, release, valide_par, commentaire) VALUES ($1, $2, $3, $4) RETURNING *',
      [file, release, String(validePar ?? '').slice(0, 200) || 'interface', commentaire],
    );
    return v;
  } catch (e) {
    if (e.code === '23505') throw new ValidationRefusee(`La release « ${release} » a déjà sa validation finale : une validation ne se refait pas.`);
    if (e.code === '23514') throw new ValidationRefusee(`La base refuse cette validation : ${e.message}`, { code: 422 });
    throw e;
  }
}

/** Les validations finales d'une file, la plus récente d'abord. */
export async function validations(db, { file = FILE_PRINCIPALE, limite = 20 } = {}) {
  const { rows } = await db.query('SELECT * FROM pilotage.validation WHERE file = $1 ORDER BY valide_le DESC, id DESC LIMIT $2', [file, limite]);
  return rows;
}

/** La dernière validation finale d'une file, ou null : la release en production et sa date. */
export async function derniereValidation(db, { file = FILE_PRINCIPALE } = {}) {
  return (await validations(db, { file, limite: 1 }))[0] ?? null;
}

// ── Le catalogue des workflows ──────────────────────────────────────────────

/** Types de déclencheur : libellé, et si le déclencheur vit hors de cette VM. */
export const TYPES_DECLENCHEUR = Object.freeze({
  poussee: 'Poussée sur une branche',
  manuel_forge: 'Lancement manuel depuis la forge',
  planifie: 'Planification',
  commande: 'Commande à la main',
  script: 'Script',
  workflow: 'Lancé par un autre workflow',
  interface: 'Depuis l’interface',
  evenement: 'Événement',
  message: 'Message du contrat',
});

/** Phases du cycle, quand le modèle n'est pas chargé ; « bouclage » est propre au binôme. */
const NOMS_PHASES = {
  evaluer: 'Évaluer', elaborer: 'Élaborer', executer: 'Exécuter', examiner: 'Examiner',
  evoluer: 'Évoluer', emettre: 'Émettre', equilibrer: 'Équilibrer', bouclage: 'Bouclage',
};

const estTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const liste = (v) => (Array.isArray(v) ? v : []);
const texte = (v) => (v === null || v === undefined ? null : Array.isArray(v) ? v.map(String).join(', ') : String(v));

/**
 * Déclencheurs et étapes d'un workflow de CI (Gitea ou GitHub Actions), lus dans
 * son contenu YAML 1.2 : `on` y reste une clé texte.
 */
export function lireWorkflowCi(contenu) {
  const declencheurs = [];
  const etapes = [];
  if (!estTable(contenu) || contenu.erreur) return { nom: null, declencheurs, etapes, erreur: contenu?.erreur ?? 'contenu illisible' };
  let sur = contenu.on;
  if (typeof sur === 'string') sur = { [sur]: null };
  else if (Array.isArray(sur)) sur = Object.fromEntries(sur.map((s) => [String(s), null]));
  for (const [evenement, reglage] of Object.entries(estTable(sur) ? sur : {})) {
    const r = estTable(reglage) ? reglage : {};
    if (evenement === 'push') {
      const branches = liste(r.branches).map(String);
      const ignores = liste(r['paths-ignore']).map(String);
      const chemins = liste(r.paths).map(String);
      declencheurs.push({
        type: 'poussee',
        detail: [
          branches.length ? `sur ${branches.join(', ')}` : 'sur toute branche',
          chemins.length ? `touchant ${chemins.join(', ')}` : null,
          ignores.length ? `hors ${ignores.join(', ')}` : null,
        ].filter(Boolean).join(', '),
      });
    } else if (evenement === 'workflow_dispatch') {
      declencheurs.push({ type: 'manuel_forge', detail: 'workflow_dispatch, depuis la forge ou son API' });
    } else if (evenement === 'schedule') {
      const crons = liste(reglage).map((x) => texte(x?.cron)).filter(Boolean);
      declencheurs.push({ type: 'planifie', detail: crons.length ? `cron ${crons.join(' ; ')}` : 'planification' });
    } else {
      declencheurs.push({ type: 'evenement', detail: evenement });
    }
  }
  for (const [idJob, job] of Object.entries(estTable(contenu.jobs) ? contenu.jobs : {})) {
    liste(job?.steps).forEach((pas, i) => {
      const nom = texte(pas?.name) ?? texte(pas?.uses) ?? `pas ${i + 1}`;
      etapes.push({ nom, detail: texte(pas?.uses) ? `action ${pas.uses}` : null, job: idJob });
    });
  }
  return { nom: texte(contenu.name), declencheurs, etapes, erreur: null };
}

function declencheursDe(brut) {
  return liste(brut).filter(estTable).map((d) => ({
    type: texte(d.type),
    libelle: TYPES_DECLENCHEUR[d.type] ?? texte(d.type),
    detail: texte(d.detail),
    action: texte(d.action),
    workflow: texte(d.workflow),
    connu: Object.hasOwn(TYPES_DECLENCHEUR, d.type),
  }));
}

/**
 * Le catalogue normalisé. `workflows` : contenu de recette/workflows.yaml (ou
 * null) ; `ci` : { chemin: contenu } des workflows de CI chargés ; `modele` :
 * contenu du modèle (pour les phases du cycle). Rend { projets, problemes } :
 * un problème (fichier de CI absent, action inconnue…) s'affiche, il ne lève pas.
 */
export function catalogue({ workflows = null, ci = {}, modele = null } = {}) {
  const problemes = [];
  if (!estTable(workflows) || workflows.erreur) {
    return { projets: [], problemes: [workflows?.erreur ? `recette/workflows.yaml illisible : ${workflows.erreur}` : 'recette/workflows.yaml n’est pas chargé : lancer une campagne ou recharger les données'] };
  }
  const phasesModele = estTable(modele?.cycle?.phases) ? modele.cycle.phases : {};
  const boucle = estTable(modele?.boucle?.phases) ? modele.boucle.phases : {};
  const ordrePhases = liste(modele?.cycle?.ordre).length ? modele.cycle.ordre.map(String) : Object.keys(NOMS_PHASES).filter((p) => p !== 'bouclage');
  const nomPhase = (p) => texte(phasesModele[p]?.nom) ?? NOMS_PHASES[p] ?? p;

  const projets = liste(workflows.projets).filter(estTable).map((p) => {
    const projet = {
      id: texte(p.id), nom: texte(p.nom) ?? texte(p.id), origine: texte(p.origine), source: texte(p.source),
      etat: texte(p.etat), resume: texte(p.resume), workflows: [],
      taches: estTable(p.taches) ? p.taches : null, decisions: liste(p.decisions).filter(estTable),
    };
    projet.workflows = liste(p.workflows).filter(estTable).map((w) => {
      const wf = {
        id: texte(w.id), nom: texte(w.nom) ?? texte(w.id), nature: texte(w.nature), executant: texte(w.executant),
        resume: texte(w.resume), etat: texte(w.etat), fichier: texte(w.fichier), commande: texte(w.commande),
        source: texte(w.source), transverse: w.transverse === true,
        declencheurs: declencheursDe(w.declencheurs),
        etapes: liste(w.etapes).map((e) => (estTable(e) ? { nom: texte(e.nom), detail: texte(e.detail) } : { nom: texte(e), detail: null })),
        parPhase: liste(w.par_phase).filter(estTable).map((x) => ({ phase: texte(x.phase), nomPhase: nomPhase(texte(x.phase)), echanges: texte(x.echanges), garde: texte(x.garde) })),
        phases: [],
      };
      if (wf.nature === 'ci') {
        const doc = wf.fichier ? ci[wf.fichier] : undefined;
        if (doc === undefined) {
          problemes.push(`${projet.id}/${wf.id} : ${wf.fichier ?? 'fichier'} n’est pas chargé`);
        } else {
          const lu = lireWorkflowCi(doc);
          if (lu.erreur) problemes.push(`${projet.id}/${wf.id} : ${wf.fichier} illisible : ${lu.erreur}`);
          wf.declencheurs = [...lu.declencheurs.map((d) => ({ ...d, libelle: TYPES_DECLENCHEUR[d.type], action: null, workflow: null, connu: true })), ...wf.declencheurs];
          wf.etapes = [...lu.etapes, ...wf.etapes];
          wf.nomFichier = lu.nom;
        }
      }
      if (wf.nature === 'cycle') {
        // La garde d'une phase : celle du cycle, et pour les phases de la boucle le
        // blocage par leurs prérequis (boucle.phases)
        wf.etapes = ordrePhases.map((ph) => {
          const d = phasesModele[ph] ?? {};
          const b = boucle[ph];
          const blocage = b && liste(b.prerequis).length ? `prérequis ${liste(b.prerequis).join(', ')} en écart : ${liste(b.criteres).join(', ')} plafonnés à 1` : null;
          return { nom: nomPhase(ph), detail: texte(d.role), phase: ph, porteur: texte(d.porteur), sortie: texte(d.sortie), garde: [texte(d.garde), blocage].filter(Boolean).join(' ; ') || null };
        });
        if (!Object.keys(phasesModele).length) problemes.push(`${projet.id}/${wf.id} : le modèle n’est pas chargé, phases du cycle par défaut`);
      }
      wf.phases = [...new Set([...wf.parPhase.map((x) => x.phase), ...wf.etapes.map((e) => e.phase).filter(Boolean)])];
      for (const d of wf.declencheurs) {
        if (!d.connu) problemes.push(`${projet.id}/${wf.id} : type de déclencheur inconnu : ${d.type}`);
        if (d.action && !Object.hasOwn(ACTIONS, d.action)) problemes.push(`${projet.id}/${wf.id} : action inconnue : ${d.action}`);
        if (d.type === 'interface' && !d.action) problemes.push(`${projet.id}/${wf.id} : déclencheur interface sans action`);
      }
      return wf;
    });
    // Un déclencheur « workflow » doit nommer un workflow du même projet
    const ids = new Set(projet.workflows.map((w) => w.id));
    for (const w of projet.workflows) {
      for (const d of w.declencheurs) if (d.type === 'workflow' && !ids.has(d.workflow)) problemes.push(`${projet.id}/${w.id} : workflow déclencheur inconnu : ${d.workflow}`);
    }
    return projet;
  });
  const vus = new Set();
  for (const p of projets) {
    if (vus.has(p.id)) problemes.push(`projet en double : ${p.id}`);
    vus.add(p.id);
  }
  return { projets, problemes };
}

/** Tous les déclencheurs du catalogue, à plat, avec leur projet et leur workflow. */
export function declencheurs(cat) {
  return cat.projets.flatMap((p) => p.workflows.flatMap((w) => w.declencheurs.map((d) => ({ ...d, projet: p, workflowCible: w }))));
}

/**
 * Lit le catalogue depuis la base : documents workflows et ci, et le modèle.
 * Rend aussi la date du chargement et la campagne qui l'a fait.
 */
export async function catalogueEnBase(db) {
  const { rows } = await db.query(
    "SELECT nature, chemin, contenu, charge_le, campagne_id FROM donnees.document WHERE nature IN ('workflows', 'ci', 'modele') ORDER BY nature, chemin",
  );
  const ci = {};
  let workflows = null;
  let modele = null;
  let charge = null;
  for (const r of rows) {
    if (r.nature === 'ci') ci[r.chemin] = r.contenu;
    else if (r.nature === 'workflows') { workflows = r.contenu; charge = { le: r.charge_le, campagne: r.campagne_id }; } else modele = r.contenu;
  }
  return { ...catalogue({ workflows, ci, modele }), charge };
}
