/**
 * Classe de base des agents — un nom, un jeu d'actions, rien d'autre.
 * Un agent ne connaît ses pairs que par leur nom sur le bus.
 */
export class Agent {
  constructor(nom, { config = {} } = {}) {
    this.nom = nom;
    this.config = config;
    this.actions = new Map();
    this.bus = null;
  }

  attacher(bus) {
    this.bus = bus;
  }

  action(nom, fonction) {
    this.actions.set(nom, fonction);
    return this;
  }

  async executer(action, charge, contexte) {
    const fonction = this.actions.get(action);
    if (!fonction) throw new Error(`Action inconnue : ${this.nom}.${action}`);
    return fonction.call(this, charge ?? {}, contexte ?? {});
  }

  demander(cible, action, charge, contexte = {}, options = {}) {
    return this.bus.demander(cible, action, charge, contexte, options);
  }

  publier(type, charge = {}) {
    this.bus?.publier({ type, source: this.nom, ...charge });
  }

  async ouvrir() {}
  async fermer() {}
}

export class ErreurAtelier extends Error {
  constructor(message, { code = 'ERREUR_TECHNIQUE', detail = null } = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}
