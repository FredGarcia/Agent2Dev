import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent, ErreurAtelier } from '../agent.js';
import { genererLivrable } from '../livrable.js';

/**
 * Agent ordonnanceur — file des demandes, une à la fois.
 *
 * Séparé de l'orchestrateur comme dans le banc de test : l'orchestrateur sait
 * dérouler une demande, l'ordonnanceur sait quand en lancer une et quoi faire
 * du résultat (livrable Markdown, résultat JSON).
 */
export class AgentOrdonnanceur extends Agent {
  constructor({ config, racineSortie }) {
    super('ordonnanceur', { config });
    this.racineSortie = racineSortie;
    this.file = [];
    this.etats = new Map();
    this.enCours = false;
    this.compteur = 0;
    this.action('soumettre', this.soumettre);
    this.action('etat', ({ id }) => this.trouver(id));
    this.action('lister', () => [...this.etats.values()].map(({ resultat, demande, livrable, ...reste }) => ({ ...reste, titre: demande.titre })));
    this.action('livrable', ({ id }) => this.trouver(id).livrable ?? null);
  }

  trouver(id) {
    const e = this.etats.get(id);
    if (!e) throw new ErreurAtelier(`Demande inconnue : ${id}`, { code: 'DEMANDE_INCONNUE' });
    return e;
  }

  soumettre({ demande }) {
    if (!demande?.texte?.trim()) throw new ErreurAtelier('La demande doit contenir un texte', { code: 'DEMANDE_VIDE' });
    this.compteur++;
    const jour = new Date().toISOString().slice(0, 10).replaceAll('-', '');
    const id = demande.id ?? `DM-${jour}-${String(this.compteur).padStart(3, '0')}`;
    const d = { ...demande, id, titre: demande.titre?.trim() || demande.texte.slice(0, 60) };
    this.etats.set(id, { id, demande: d, statut: 'en_file', soumise: new Date().toISOString() });
    this.file.push(d);
    this.publier('demande_soumise', { demandeId: id, titre: d.titre });
    this.pomper();
    return { id };
  }

  async pomper() {
    if (this.enCours) return;
    this.enCours = true;
    while (this.file.length) {
      const demande = this.file.shift();
      const etat = this.etats.get(demande.id);
      etat.statut = 'en_cours';
      try {
        const resultat = await this.demander('orchestrateur', 'traiter', { demande }, { demandeId: demande.id }, { delaiMs: 0 });
        etat.statut = resultat.statut;
        etat.resultat = resultat;
        await this.ecrire(demande, resultat, etat);
      } catch (erreur) {
        etat.statut = 'erreur';
        etat.erreur = erreur.message;
        this.publier('demande_erreur', { demandeId: demande.id, erreur: erreur.message, detail: erreur.detail ?? null });
      }
      etat.terminee = new Date().toISOString();
    }
    this.enCours = false;
    this.publier('file_vide');
  }

  async ecrire(demande, resultat, etat) {
    const [lecons, bilan] = await Promise.all([
      this.demander('apprenant', 'lister', {}),
      this.demander('observant', 'bilan', {})
    ]);
    const dossier = path.join(this.racineSortie, demande.id);
    await mkdir(dossier, { recursive: true });
    etat.livrable = genererLivrable({ demande, resultat, lecons, bilan });
    await writeFile(path.join(dossier, 'livrable.md'), etat.livrable);
    await writeFile(path.join(dossier, 'resultat.json'), JSON.stringify({ demande, resultat }, null, 2));
    etat.dossier = dossier;
    this.publier('livrable_ecrit', { demandeId: demande.id, dossier });
  }
}
