import { Agent } from '../agent.js';

/**
 * Agent observant — il ne produit rien, il regarde le système produire.
 *
 * Deux sources, sans jamais être appelé par les agents qu'il observe :
 *   - les traces du bus (chaque appel : agent, action, durée, succès/échec) ;
 *   - les événements (propositions, décisions de l'opérateur, échecs de schéma,
 *     vérifications de code).
 *
 * Il tient, par phase, le taux de propositions validées par l'opérateur, et
 * lève une alerte quand le taux de renvoi dépasse le seuil sur la fenêtre
 * glissante. Surtout, il mesure l'effet des leçons : pour une leçon donnée, il
 * compare le taux de validation des propositions qui l'ont reçue à celui des
 * autres. C'est cette mesure qui permet à l'apprenant de retirer une leçon qui
 * n'améliore rien — l'observation porte sur l'apprentissage lui-même.
 */
export class AgentObservant extends Agent {
  constructor({ config }) {
    super('observant', { config });
    this.reglages = config.observant;
    this.propositions = [];
    this.appels = new Map();
    this.echecsSchema = new Map();
    this.verifications = { ok: 0, ko: 0 };
    this.alertes = [];
    this.enAlerte = new Set();
    this.action('bilan', this.bilan);
    this.action('evaluerLecon', this.evaluerLecon);
  }

  attacher(bus) {
    super.attacher(bus);
    bus.tracer((t) => this.surTrace(t));
    bus.abonner((e) => this.surEvenement(e));
  }

  surTrace(t) {
    const cle = `${t.cible}.${t.action}`;
    const a = this.appels.get(cle) ?? { appels: 0, echecs: 0, dureeTotaleMs: 0, dureeMaxMs: 0 };
    a.appels++;
    if (t.statut === 'echec') a.echecs++;
    // Les attentes humaines faussent les durées : elles sont comptées, pas moyennées.
    if (!(t.cible === 'orchestrateur' && t.action === 'traiter')) {
      a.dureeTotaleMs += t.dureeMs;
      a.dureeMaxMs = Math.max(a.dureeMaxMs, t.dureeMs);
    }
    this.appels.set(cle, a);
  }

  surEvenement(e) {
    switch (e.type) {
      case 'proposition':
        this.propositions.push({
          demandeId: e.demandeId,
          phase: e.phase,
          iteration: e.iteration,
          lecons: e.lecons ?? [],
          issue: null
        });
        break;
      case 'decision': {
        const p = this.propositions.findLast(
          (x) => x.demandeId === e.demandeId && x.phase === e.phase && x.issue === null
        );
        if (p) p.issue = e.decision;
        this.surveiller(e.phase);
        break;
      }
      case 'validation_echec':
        this.echecsSchema.set(e.phase, (this.echecsSchema.get(e.phase) ?? 0) + 1);
        break;
      case 'verification_code':
        e.ok ? this.verifications.ok++ : this.verifications.ko++;
        break;
      default:
    }
  }

  /** Alerte à l'entrée en dérive et retour à la normale, pas à chaque décision. */
  surveiller(phase) {
    const { fenetre, seuilCorrection } = this.reglages;
    const recentes = this.propositions.filter((p) => p.phase === phase && p.issue).slice(-fenetre);
    if (recentes.length < Math.min(3, fenetre)) return;
    const taux = recentes.filter((p) => p.issue !== 'valider').length / recentes.length;
    if (taux > seuilCorrection && !this.enAlerte.has(phase)) {
      this.enAlerte.add(phase);
      const alerte = { phase, taux, fenetre: recentes.length, horodate: new Date().toISOString() };
      this.alertes.push(alerte);
      this.publier('alerte', { ...alerte, message: `Phase ${phase} : ${Math.round(taux * 100)} % de propositions renvoyées` });
    } else if (taux <= seuilCorrection && this.enAlerte.has(phase)) {
      this.enAlerte.delete(phase);
      this.publier('alerte_levee', { phase, taux });
    }
  }

  static taux(liste) {
    return liste.length ? liste.filter((p) => p.issue === 'valider').length / liste.length : null;
  }

  evaluerLecon({ id, phase }) {
    const tranchees = this.propositions.filter((p) => p.issue && (!phase || phase === '*' || p.phase === phase));
    const avec = tranchees.filter((p) => p.lecons.includes(id));
    const sans = tranchees.filter((p) => !p.lecons.includes(id));
    return {
      id,
      exposition: avec.length,
      tauxAvec: AgentObservant.taux(avec),
      tauxSans: AgentObservant.taux(sans),
      referenceSans: sans.length
    };
  }

  bilan() {
    const phases = {};
    for (const p of this.propositions) {
      const b = (phases[p.phase] ??= { propositions: 0, validees: 0, corrigees: 0, rejetees: 0, enAttente: 0 });
      b.propositions++;
      if (p.issue === 'valider') b.validees++;
      else if (p.issue === 'corriger') b.corrigees++;
      else if (p.issue === 'rejeter') b.rejetees++;
      else b.enAttente++;
    }
    for (const [phase, b] of Object.entries(phases)) {
      const tranchees = b.validees + b.corrigees + b.rejetees;
      b.tauxValidation = tranchees ? b.validees / tranchees : null;
      b.premierPassage = this.tauxPremierPassage(phase);
      b.echecsSchema = this.echecsSchema.get(phase) ?? 0;
    }
    const appels = Object.fromEntries(
      [...this.appels].map(([cle, a]) => [
        cle,
        { ...a, dureeMoyenneMs: a.appels ? Math.round(a.dureeTotaleMs / a.appels) : 0 }
      ])
    );
    return { phases, appels, verifications: this.verifications, alertes: this.alertes, enAlerte: [...this.enAlerte] };
  }

  /** Part des (demande, phase) validées dès la première proposition. */
  tauxPremierPassage(phase) {
    const premieres = this.propositions.filter((p) => p.phase === phase && p.iteration === 1 && p.issue);
    return AgentObservant.taux(premieres);
  }
}
