import { randomUUID } from 'node:crypto';

/**
 * Bus de messages entre agents — même modèle que le banc de test.
 *
 *   - demander() : appel nommé vers un agent, avec réponse, trace et délai de garde.
 *   - publier()  : événement diffusé sans réponse (tableau de bord, journal, observant).
 *   - tracer()   : chaque appel terminé, succès comme échec, est remis aux traceurs.
 *
 * Aucun agent n'importe un autre agent : toutes les dépendances passent par ici.
 */
export class Bus {
  constructor({ delaiParDefautMs = 30000 } = {}) {
    this.agents = new Map();
    this.abonnes = new Set();
    this.traceurs = new Set();
    this.delaiParDefautMs = delaiParDefautMs;
  }

  enregistrer(agent) {
    if (this.agents.has(agent.nom)) throw new Error(`Agent déjà enregistré : ${agent.nom}`);
    this.agents.set(agent.nom, agent);
    agent.attacher(this);
    return this;
  }

  agent(nom) {
    const a = this.agents.get(nom);
    if (!a) throw new Error(`Agent inconnu : ${nom}`);
    return a;
  }

  tracer(fonction) {
    this.traceurs.add(fonction);
    return () => this.traceurs.delete(fonction);
  }

  abonner(fonction) {
    this.abonnes.add(fonction);
    return () => this.abonnes.delete(fonction);
  }

  /** delaiMs = 0 : pas de garde (attente d'une décision humaine, par exemple). */
  async demander(cible, action, charge = {}, contexte = {}, { delaiMs } = {}) {
    const agent = this.agent(cible);
    const ctx = { correlation: contexte.correlation ?? randomUUID(), ...contexte };
    const delai = delaiMs ?? this.delaiParDefautMs;
    const debut = Date.now();
    let minuterie = null;
    const appels = [agent.executer(action, charge, ctx)];
    if (delai > 0) {
      appels.push(
        new Promise((_, rejeter) => {
          minuterie = setTimeout(() => rejeter(new Error(`Délai dépassé : ${cible}.${action} (${delai} ms)`)), delai);
        })
      );
    }
    try {
      const resultat = await Promise.race(appels);
      this.#tracer({ cible, action, ctx, debut, statut: 'succes' });
      return resultat;
    } catch (erreur) {
      this.#tracer({ cible, action, ctx, debut, statut: 'echec', erreur: erreur.message });
      throw erreur;
    } finally {
      if (minuterie) clearTimeout(minuterie);
    }
  }

  publier(evenement) {
    const e = { horodate: new Date().toISOString(), ...evenement };
    for (const abonne of this.abonnes) {
      try {
        abonne(e);
      } catch (erreur) {
        console.error(`[bus] abonné en échec sur ${e.type} :`, erreur.message);
      }
    }
  }

  #tracer({ cible, action, ctx, debut, statut, erreur = null }) {
    const trace = {
      cible,
      action,
      correlation: ctx.correlation,
      demandeId: ctx.demandeId ?? null,
      phase: ctx.phase ?? null,
      dureeMs: Date.now() - debut,
      statut,
      erreur,
      horodate: new Date().toISOString()
    };
    for (const traceur of this.traceurs) {
      try {
        traceur(trace);
      } catch (e) {
        console.error('[bus] traceur en échec :', e.message);
      }
    }
  }
}
