import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent, ErreurAtelier } from '../agent.js';
import { court, extraireJson, termes } from '../texte.js';

/**
 * Agent apprenant — il transforme les corrections de l'opérateur en leçons
 * réutilisables et les réinjecte dans les agents génériques.
 *
 * Cycle d'une leçon :
 *   candidate  → née d'une correction ou d'un rejet commenté ;
 *   active     → ratifiée par l'opérateur (ou directement si ratificationRequise=false),
 *                injectée dans la fiche de sa phase aux demandes suivantes ;
 *   suspendue  → l'observant montre qu'elle n'améliore pas le taux de validation,
 *                ou l'opérateur la retire. Elle reste consultable et réactivable.
 *
 * Rien n'est appris sans trace : chaque leçon garde son origine (demande,
 * phase, commentaire) et ses occurrences.
 */
export class AgentApprenant extends Agent {
  constructor({ config, moteur, fichier }) {
    super('apprenant', { config });
    this.moteur = moteur;
    this.fichier = fichier;
    this.reglages = config.apprenant;
    this.lecons = [];
    this.action('leconsPour', this.leconsPour);
    this.action('enregistrerDecision', this.enregistrerDecision);
    this.action('ratifier', this.ratifier);
    this.action('suspendre', this.suspendre);
    this.action('lister', () => this.lecons);
    this.action('reevaluer', this.reevaluer);
  }

  async ouvrir() {
    try {
      this.lecons = JSON.parse(await readFile(this.fichier, 'utf8'));
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      this.lecons = [];
    }
  }

  async sauver() {
    await mkdir(path.dirname(this.fichier), { recursive: true });
    await writeFile(this.fichier, JSON.stringify(this.lecons, null, 2));
  }

  leconsPour({ phase }) {
    return this.lecons
      .filter((l) => l.statut === 'active' && (l.phase === phase || l.phase === '*'))
      .map(({ id, regle, phase: p }) => ({ id, regle, phase: p }));
  }

  async enregistrerDecision({ demandeId, phase, decision, commentaire, contenu }) {
    let lecon = null;
    if (decision !== 'valider' && commentaire?.trim()) {
      const regle = await this.distiller({ phase, commentaire, contenu });
      lecon = await this.retenir({ demandeId, phase, commentaire, regle });
    }
    await this.reevaluer();
    return { lecon };
  }

  /** Généralise le commentaire en règle ; en cas d'échec, le commentaire fait foi. */
  async distiller({ phase, commentaire, contenu }) {
    try {
      const { texte } = await this.moteur.completer({
        phase: 'distillation',
        systeme:
          "Tu transformes la correction d'un opérateur en une règle générale, courte et impérative, " +
          "applicable aux prochaines demandes de la même phase. Pas de référence au cas particulier. " +
          'Réponds uniquement par {"regle": "..."}.',
        message: JSON.stringify({ phase, commentaire, extraitProposition: court(JSON.stringify(contenu), 1500) }),
        entree: { phase, commentaire }
      });
      const regle = extraireJson(texte).regle;
      return typeof regle === 'string' && regle.trim() ? regle.trim() : commentaire.trim();
    } catch {
      return commentaire.trim();
    }
  }

  async retenir({ demandeId, phase, commentaire, regle }) {
    const empreinte = termes(regle).sort().join(' ');
    const existante = this.lecons.find((l) => l.phase === phase && l.empreinte === empreinte);
    if (existante) {
      existante.occurrences++;
      existante.origines.push({ demandeId, commentaire });
      await this.sauver();
      this.publier('lecon_renforcee', { lecon: existante });
      return existante;
    }
    const lecon = {
      id: `L${String(this.lecons.length + 1).padStart(3, '0')}`,
      phase,
      regle,
      empreinte,
      statut: this.reglages.ratificationRequise ? 'candidate' : 'active',
      occurrences: 1,
      origines: [{ demandeId, commentaire }],
      creee: new Date().toISOString(),
      historique: []
    };
    this.lecons.push(lecon);
    await this.sauver();
    this.publier(lecon.statut === 'candidate' ? 'lecon_candidate' : 'lecon_active', { lecon });
    return lecon;
  }

  trouver(id) {
    const l = this.lecons.find((x) => x.id === id);
    if (!l) throw new ErreurAtelier(`Leçon inconnue : ${id}`, { code: 'LECON_INCONNUE' });
    return l;
  }

  async changer(l, statut, motif) {
    l.historique.push({ de: l.statut, vers: statut, motif, horodate: new Date().toISOString() });
    l.statut = statut;
    await this.sauver();
  }

  async ratifier({ id, regle = null }) {
    const l = this.trouver(id);
    if (regle?.trim()) l.regle = regle.trim();
    await this.changer(l, 'active', 'ratifiée par l\'opérateur');
    this.publier('lecon_active', { lecon: l });
    return l;
  }

  async suspendre({ id, motif = 'retirée par l\'opérateur' }) {
    const l = this.trouver(id);
    await this.changer(l, 'suspendue', motif);
    this.publier('lecon_suspendue', { lecon: l, motif });
    return l;
  }

  /**
   * Boucle de second ordre : une leçon active suffisamment exposée dont le taux
   * de validation est inférieur à la référence, de plus que la marge, est suspendue.
   */
  async reevaluer() {
    const { expositionMin, margeRetrait } = this.config.observant;
    const suspendues = [];
    for (const l of this.lecons.filter((x) => x.statut === 'active')) {
      const m = await this.demander('observant', 'evaluerLecon', { id: l.id, phase: l.phase });
      l.mesure = m;
      if (m.exposition >= expositionMin && m.tauxAvec !== null && m.tauxSans !== null && m.tauxAvec < m.tauxSans - margeRetrait) {
        const motif = `taux de validation ${pct(m.tauxAvec)} avec la leçon contre ${pct(m.tauxSans)} sans (${m.exposition} exposition(s))`;
        await this.changer(l, 'suspendue', motif);
        this.publier('lecon_suspendue', { lecon: l, motif });
        suspendues.push(l.id);
      }
    }
    if (!suspendues.length && this.lecons.length) await this.sauver();
    return { suspendues };
  }
}

const pct = (x) => `${Math.round(x * 100)} %`;
