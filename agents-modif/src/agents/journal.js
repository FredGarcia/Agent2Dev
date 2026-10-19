import { createWriteStream } from 'node:fs';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../agent.js';

/**
 * Agent journal — persiste chaque trace d'appel et chaque événement, une ligne
 * JSON par entrée, un fichier par jour. Le format ligne à ligne se recharge
 * tel quel dans une table PostgreSQL (jsonb) si l'équipe veut l'interroger en SQL.
 */
export class AgentJournal extends Agent {
  constructor({ config, repertoire }) {
    super('journal', { config });
    this.repertoire = repertoire;
    this.flux = null;
    this.fichier = null;
    this.action('lire', this.lire);
  }

  attacher(bus) {
    super.attacher(bus);
    bus.tracer((t) => this.ecrire({ nature: 'trace', ...t }));
    bus.abonner((e) => this.ecrire({ nature: 'evenement', ...e }));
  }

  async ouvrir() {
    await mkdir(this.repertoire, { recursive: true });
    this.fichier = path.join(this.repertoire, `${new Date().toISOString().slice(0, 10)}.jsonl`);
    this.flux = createWriteStream(this.fichier, { flags: 'a' });
  }

  ecrire(entree) {
    this.flux?.write(`${JSON.stringify(entree)}\n`);
  }

  async lire({ demandeId = null, limite = 500 }) {
    if (!this.fichier) return [];
    const lignes = (await readFile(this.fichier, 'utf8').catch(() => '')).split('\n').filter(Boolean);
    return lignes
      .map((l) => JSON.parse(l))
      .filter((e) => !demandeId || e.demandeId === demandeId)
      .slice(-limite);
  }

  async fermer() {
    if (!this.flux) return;
    await new Promise((fin) => this.flux.end(fin));
    this.flux = null;
  }
}
