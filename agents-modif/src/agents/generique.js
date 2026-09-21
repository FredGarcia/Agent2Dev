import { Agent, ErreurAtelier } from '../agent.js';
import { extraireJson } from '../texte.js';
import { verifierSortie } from '../validateur.js';

/**
 * Agent générique.
 *
 * Une seule classe pour l'analyste, le rédacteur, le préconisateur et le
 * développeur : ce qui les distingue tient entièrement dans leur fiche
 * (fiches/*.json) — rôle, consignes, entrées retenues, schéma de sortie,
 * contrôles. Ajouter un agent revient à ajouter une fiche.
 *
 * Boucle de premier ordre : une sortie non conforme au schéma ou aux contrôles
 * est renvoyée au moteur avec la liste des écarts, dans la limite de
 * `tentativesSchema`.
 */
export class AgentGenerique extends Agent {
  constructor({ fiche, moteur, config }) {
    super(fiche.agent, { config });
    this.fiche = fiche;
    this.moteur = moteur;
    this.action('produire', this.produire);
    this.action('decrire', () => ({
      agent: this.nom,
      phase: fiche.code,
      libelle: fiche.libelle,
      entrees: fiche.entrees,
      controles: fiche.controles ?? []
    }));
  }

  systeme(lecons) {
    const f = this.fiche;
    const blocs = [
      f.role,
      `Consignes :\n${f.consignes.map((c, i) => `${i + 1}. ${c}`).join('\n')}`
    ];
    if (lecons.length) {
      blocs.push(
        'Leçons retenues par l\'équipe sur les demandes précédentes (à appliquer) :\n' +
          lecons.map((l) => `- [${l.id}] ${l.regle}`).join('\n')
      );
    }
    blocs.push(
      'Réponds uniquement par un objet JSON conforme au schéma suivant, sans texte autour, sans clôture Markdown :\n' +
        JSON.stringify(f.schema)
    );
    return blocs.join('\n\n');
  }

  message(entree, correction, erreurs, precedente) {
    const blocs = [`Entrées :\n${JSON.stringify(entree, null, 2)}`];
    if (correction) {
      blocs.push(`Ta proposition précédente a été renvoyée par l'opérateur avec cette correction :\n${correction}`);
    }
    if (erreurs.length) {
      blocs.push(
        `Ta dernière réponse n'était pas conforme :\n${erreurs.map((e) => `- ${e}`).join('\n')}\n` +
          `Réponse fautive :\n${String(precedente).slice(0, 4000)}`
      );
    }
    return blocs.join('\n\n');
  }

  async produire({ entree = {}, lecons = [], correction = null }, ctx) {
    const f = this.fiche;
    const entreeCiblee = Object.fromEntries(f.entrees.filter((k) => k in entree).map((k) => [k, entree[k]]));
    const systeme = this.systeme(lecons);
    const max = this.config.orchestration?.tentativesSchema ?? 2;
    const debut = Date.now();
    let erreurs = [];
    let precedente = null;

    for (let tentative = 1; tentative <= max; tentative++) {
      const { texte, usage } = await this.moteur.completer({
        phase: f.code,
        systeme,
        message: this.message(entreeCiblee, correction, erreurs, precedente),
        entree: entreeCiblee,
        lecons,
        correction
      });
      let contenu = null;
      try {
        contenu = extraireJson(texte);
        erreurs = verifierSortie(f, contenu);
      } catch (e) {
        erreurs = [`JSON illisible : ${e.message}`];
      }
      if (!erreurs.length) {
        return {
          contenu,
          meta: {
            phase: f.code,
            agent: this.nom,
            moteur: this.moteur.nom,
            lecons: lecons.map((l) => l.id),
            tentatives: tentative,
            dureeMs: Date.now() - debut,
            usage
          }
        };
      }
      precedente = texte;
      this.publier('validation_echec', { demandeId: ctx.demandeId, phase: f.code, tentative, erreurs });
    }
    throw new ErreurAtelier(`${f.code} : sortie non conforme après ${max} tentative(s)`, {
      code: 'SORTIE_NON_CONFORME',
      detail: erreurs
    });
  }
}
