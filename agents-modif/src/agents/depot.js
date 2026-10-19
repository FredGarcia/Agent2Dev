import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent, ErreurAtelier } from '../agent.js';
import { decamel, normaliser, occurrences, racines } from '../texte.js';

/**
 * Agent dépôt : seul agent qui touche au code source, et en lecture seule sur
 * le dépôt. Il explore, vérifie l'applicabilité des modifications proposées et
 * les applique sur une copie, jamais sur le dépôt lui-même.
 */
export class AgentDepot extends Agent {
  constructor({ config, racine }) {
    super('depot', { config });
    this.racine = path.resolve(racine);
    this.reglages = config.depot;
    this.action('explorer', this.explorer);
    this.action('verifier', this.verifier);
    this.action('appliquer', this.appliquer);
  }

  resoudre(relatif, base = this.racine) {
    const absolu = path.resolve(base, relatif);
    if (absolu !== base && !absolu.startsWith(base + path.sep)) {
      throw new ErreurAtelier(`Chemin hors du dépôt : ${relatif}`, { code: 'CHEMIN_INTERDIT' });
    }
    return absolu;
  }

  async lister(dossier = this.racine, acc = []) {
    for (const entree of await readdir(dossier, { withFileTypes: true })) {
      if (this.reglages.exclusions.includes(entree.name)) continue;
      const complet = path.join(dossier, entree.name);
      if (entree.isDirectory()) await this.lister(complet, acc);
      else if (this.reglages.extensions.includes(path.extname(entree.name))) acc.push(complet);
    }
    return acc;
  }

  relatif(absolu) {
    return path.relative(this.racine, absolu).split(path.sep).join('/');
  }

  async explorer({ texte, indices = [] }) {
    const cles = racines(texte);
    const tous = await this.lister();
    const notes = [];
    for (const absolu of tous) {
      const chemin = this.relatif(absolu);
      const contenu = await readFile(absolu, 'utf8');
      const corps = normaliser(contenu);
      const nom = normaliser(decamel(chemin));
      let score = 0;
      for (const c of cles) score += occurrences(corps, c) + (nom.includes(c) ? 5 : 0);
      for (const indice of indices) if (chemin.includes(indice)) score += 50;
      if (score > 0) notes.push({ chemin, score, contenu });
    }
    notes.sort((a, b) => b.score - a.score);
    const max = this.reglages.maxCaracteresParFichier;
    return {
      termes: cles,
      total: tous.length,
      arbre: tous.slice(0, 300).map((a) => this.relatif(a)),
      fichiers: notes.slice(0, this.reglages.maxFichiers).map((n) => ({
        chemin: n.chemin,
        score: n.score,
        lignes: n.contenu.split('\n').length,
        tronque: n.contenu.length > max,
        contenu: n.contenu.length > max ? `${n.contenu.slice(0, max)}\n/* … tronqué … */` : n.contenu
      }))
    };
  }

  /**
   * Chaque bloc « avant » doit exister exactement une fois. Les modifications
   * d'un même fichier sont vérifiées dans l'ordre, sur le contenu déjà modifié,
   * comme elles seront appliquées.
   */
  async verifier({ modifications = [] }) {
    const courant = new Map();
    const resultats = [];
    for (const [i, m] of modifications.entries()) {
      let statut;
      try {
        if (!courant.has(m.fichier)) courant.set(m.fichier, await readFile(this.resoudre(m.fichier), 'utf8'));
        const contenu = courant.get(m.fichier);
        const n = m.avant ? occurrences(contenu, m.avant) : 0;
        statut = !m.avant ? 'avant_vide' : n === 1 ? 'ok' : n === 0 ? 'introuvable' : 'ambigu';
        if (statut === 'ok') courant.set(m.fichier, contenu.replace(m.avant, () => m.apres));
      } catch (e) {
        statut = e.code === 'CHEMIN_INTERDIT' ? 'chemin_interdit' : 'fichier_absent';
      }
      resultats.push({ index: i, fichier: m.fichier, critere: m.critere ?? null, statut });
    }
    return { ok: resultats.every((r) => r.statut === 'ok'), resultats };
  }

  /** Écrit les fichiers modifiés et les nouveaux fichiers dans `cible`, jamais dans le dépôt. */
  async appliquer({ modifications = [], nouveauxFichiers = [], cible }) {
    if (!cible) throw new ErreurAtelier('appliquer : cible absente');
    const base = path.resolve(cible);
    const contenus = new Map();
    const modifies = new Set();
    const ignorees = [];
    for (const m of modifications) {
      try {
        if (!contenus.has(m.fichier)) contenus.set(m.fichier, await readFile(this.resoudre(m.fichier), 'utf8'));
        const contenu = contenus.get(m.fichier);
        if (occurrences(contenu, m.avant) !== 1) {
          ignorees.push({ fichier: m.fichier, motif: 'bloc avant non unique ou introuvable' });
          continue;
        }
        contenus.set(m.fichier, contenu.replace(m.avant, () => m.apres));
        modifies.add(m.fichier);
      } catch (e) {
        ignorees.push({ fichier: m.fichier, motif: e.message });
      }
    }
    const ecrits = [];
    const ecrire = async (relatif, contenu) => {
      const absolu = this.resoudre(relatif, base);
      await mkdir(path.dirname(absolu), { recursive: true });
      await writeFile(absolu, contenu);
      ecrits.push(relatif);
    };
    for (const fichier of modifies) await ecrire(fichier, contenus.get(fichier));
    for (const n of nouveauxFichiers) await ecrire(n.fichier, n.contenu);
    return { cible: base, ecrits, ignorees };
  }
}
