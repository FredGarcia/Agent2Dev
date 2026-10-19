import path from 'node:path';
import { Agent, ErreurAtelier } from '../agent.js';

const DECISIONS = ['valider', 'corriger', 'rejeter'];

/**
 * Agent orchestrateur — déroule une demande phase par phase.
 *
 * Pour chaque phase déclarée par les fiches :
 *   leçons (apprenant) → proposition (agent générique) → [vérification du code
 *   (dépôt)] → point de contrôle opérateur → décision transmise à l'apprenant.
 *
 * Le point de contrôle est le modèle « proposer → ratifier → poursuivre » :
 * aucune phase ne consomme une sortie qui n'a pas été validée. « Corriger »
 * relance la même phase avec le commentaire ; « rejeter » arrête la demande.
 */
export class AgentOrchestrateur extends Agent {
  constructor({ config, fiches, racineSortie }) {
    super('orchestrateur', { config });
    this.phases = [...fiches].sort((a, b) => a.ordre - b.ordre);
    this.racineSortie = racineSortie;
    this.enAttente = new Map();
    this.action('traiter', this.traiter);
    this.action('decider', this.decider);
    this.action('attentes', () => [...this.enAttente.values()].map(({ proposition }) => proposition));
    this.action('phases', () => this.phases.map((f) => ({ code: f.code, libelle: f.libelle, agent: f.agent })));
  }

  async traiter({ demande }, ctx) {
    const demandeId = demande.id;
    const c = { ...ctx, demandeId };
    const { maxIterationsParPhase } = this.config.orchestration;
    const delaiMoteur = { delaiMs: this.config.moteur?.delaiMs ?? 300000 };

    this.publier('demande_debut', { demandeId, titre: demande.titre });
    const contexteCode = await this.demander('depot', 'explorer', { texte: demande.texte, indices: demande.indices ?? [] }, c);
    this.publier('contexte_code', {
      demandeId,
      termes: contexteCode.termes,
      fichiers: contexteCode.fichiers.map(({ chemin, score }) => ({ chemin, score }))
    });

    const livrables = {};
    const historique = [];
    let verification = null;

    for (const fiche of this.phases) {
      const cp = { ...c, phase: fiche.code };
      let correction = null;
      let valide = false;

      for (let iteration = 1; iteration <= maxIterationsParPhase && !valide; iteration++) {
        const lecons = await this.demander('apprenant', 'leconsPour', { phase: fiche.code }, cp);
        const sortie = await this.demander(
          fiche.agent,
          'produire',
          { entree: { demande, contexteCode, ...livrables }, lecons, correction },
          cp,
          delaiMoteur
        );

        let verif = null;
        if (fiche.verificationCode) {
          verif = await this.demander('depot', 'verifier', { modifications: sortie.contenu.modifications }, cp);
          this.publier('verification_code', { demandeId, phase: fiche.code, iteration, ok: verif.ok, resultats: verif.resultats });
        }

        const proposition = {
          demandeId,
          phase: fiche.code,
          libelle: fiche.libelle,
          iteration,
          lecons: sortie.meta.lecons,
          meta: sortie.meta,
          contenu: sortie.contenu,
          verification: verif
        };
        const attente = this.attendreDecision(proposition);
        this.publier('proposition', proposition);
        const { decision, commentaire } = await attente;

        this.publier('decision', { demandeId, phase: fiche.code, iteration, decision, commentaire });
        await this.demander(
          'apprenant',
          'enregistrerDecision',
          { demandeId, phase: fiche.code, decision, commentaire, contenu: sortie.contenu },
          cp
        );
        historique.push({ phase: fiche.code, iteration, decision, commentaire: commentaire ?? null, lecons: sortie.meta.lecons, tentatives: sortie.meta.tentatives });

        if (decision === 'valider') {
          livrables[fiche.livrable] = sortie.contenu;
          if (verif) verification = verif;
          valide = true;
        } else if (decision === 'rejeter') {
          this.publier('demande_fin', { demandeId, statut: 'rejetee', phase: fiche.code });
          return { statut: 'rejetee', phase: fiche.code, livrables, historique, contexteCode: resumer(contexteCode) };
        } else {
          correction = commentaire;
        }
      }

      if (!valide) {
        this.publier('demande_fin', { demandeId, statut: 'abandonnee', phase: fiche.code });
        return { statut: 'abandonnee', phase: fiche.code, livrables, historique, contexteCode: resumer(contexteCode) };
      }
    }

    const dev = livrables.developpement ?? { modifications: [], nouveauxFichiers: [] };
    const application = await this.demander(
      'depot',
      'appliquer',
      { ...dev, cible: path.join(this.racineSortie, demandeId, 'fichiers') },
      c
    );
    this.publier('demande_fin', { demandeId, statut: 'livree' });
    return { statut: 'livree', livrables, verification, application, historique, contexteCode: resumer(contexteCode) };
  }

  attendreDecision(proposition) {
    if (this.config.orchestration.validationAuto) {
      return Promise.resolve({ decision: 'valider', commentaire: 'validation automatique' });
    }
    const cle = `${proposition.demandeId}:${proposition.phase}`;
    return new Promise((resoudre) => this.enAttente.set(cle, { proposition, resoudre }));
  }

  decider({ demandeId, phase, decision, commentaire = null }) {
    const cle = `${demandeId}:${phase}`;
    const attente = this.enAttente.get(cle);
    if (!attente) throw new ErreurAtelier(`Aucune proposition en attente pour ${cle}`, { code: 'PAS_EN_ATTENTE' });
    if (!DECISIONS.includes(decision)) throw new ErreurAtelier(`Décision inconnue : ${decision}`, { code: 'DECISION_INCONNUE' });
    if (decision === 'corriger' && !commentaire?.trim()) {
      throw new ErreurAtelier('Une correction doit porter un commentaire', { code: 'COMMENTAIRE_REQUIS' });
    }
    this.enAttente.delete(cle);
    attente.resoudre({ decision, commentaire: commentaire?.trim() || null });
    return { ok: true };
  }
}

function resumer(contexteCode) {
  return {
    termes: contexteCode.termes,
    total: contexteCode.total,
    fichiers: contexteCode.fichiers.map(({ chemin, score, lignes, tronque }) => ({ chemin, score, lignes, tronque }))
  };
}
