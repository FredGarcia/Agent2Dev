import { readdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Bus } from './bus.js';
import { MoteurClaude } from './moteurs/claude.js';
import { MoteurSimulation } from './moteurs/simulation.js';
import { AgentGenerique } from './agents/generique.js';
import { AgentDepot } from './agents/depot.js';
import { AgentObservant } from './agents/observant.js';
import { AgentApprenant } from './agents/apprenant.js';
import { AgentJournal } from './agents/journal.js';
import { AgentOrchestrateur } from './agents/orchestrateur.js';
import { AgentOrdonnanceur } from './agents/ordonnanceur.js';
import { AgentTableauDeBord } from './agents/tableau-de-bord.js';

export const racine = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const depuisRacine = (p) => path.resolve(racine, p);

/** Variables reconnues : MODE, DEPOT, AUTO=1, PORT, DONNEES (répertoire des leçons et du journal). */
export async function chargerConfig(surcharges = {}) {
  const config = JSON.parse(await readFile(path.join(racine, 'config/atelier.json'), 'utf8'));
  if (process.env.MODE) config.mode = process.env.MODE;
  if (process.env.DEPOT) config.depot.racine = process.env.DEPOT;
  if (process.env.AUTO === '1') config.orchestration.validationAuto = true;
  if (process.env.PORT) config.tableauDeBord.port = Number(process.env.PORT);
  if (process.env.DONNEES) {
    config.apprenant.fichier = path.join(process.env.DONNEES, 'lecons.json');
    config.journal.repertoire = path.join(process.env.DONNEES, 'journal');
  }
  for (const [cle, valeur] of Object.entries(surcharges)) {
    config[cle] = valeur && typeof valeur === 'object' && !Array.isArray(valeur) ? { ...config[cle], ...valeur } : valeur;
  }
  return config;
}

export async function chargerFiches() {
  const dossier = path.join(racine, 'fiches');
  const fichiers = (await readdir(dossier)).filter((f) => f.endsWith('.json')).sort();
  const fiches = await Promise.all(fichiers.map(async (f) => JSON.parse(await readFile(path.join(dossier, f), 'utf8'))));
  const codes = new Set();
  for (const f of fiches) {
    if (codes.has(f.code)) throw new Error(`Fiche en double : ${f.code}`);
    codes.add(f.code);
  }
  return fiches.sort((a, b) => a.ordre - b.ordre);
}

/** Le dépôt à analyser est obligatoire : on échoue au démarrage, pas à la première demande. */
export async function verifierDepot(config) {
  const racineDepot = config.depot.racine?.trim();
  if (!racineDepot) {
    throw new Error('Aucun dépôt renseigné : lancer avec DEPOT=/chemin/vers/le/depot ou remplir depot.racine dans config/atelier.json');
  }
  const absolu = depuisRacine(racineDepot);
  const infos = await stat(absolu).catch(() => null);
  if (!infos?.isDirectory()) throw new Error(`Dépôt introuvable ou non répertoire : ${absolu}`);
}

export function creerMoteur(config) {
  return config.mode === 'simulation' ? new MoteurSimulation() : new MoteurClaude(config.moteur);
}

/**
 * Construit le bus et les agents : un agent générique par fiche, puis les agents
 * de service (dépôt, journal, observant, apprenant, orchestrateur, ordonnanceur,
 * tableau de bord). L'ordre d'enregistrement n'a pas d'importance fonctionnelle ;
 * l'observant et le journal s'abonnent dès leur enregistrement.
 */
export async function construire({ config, avecTableauDeBord = true, moteur = creerMoteur(config) }) {
  await verifierDepot(config);
  const fiches = await chargerFiches();
  const racineSortie = depuisRacine(config.sortie);
  const bus = new Bus();
  const agents = [
    new AgentJournal({ config, repertoire: depuisRacine(config.journal.repertoire) }),
    new AgentObservant({ config }),
    new AgentApprenant({ config, moteur, fichier: depuisRacine(config.apprenant.fichier) }),
    new AgentDepot({ config, racine: depuisRacine(config.depot.racine) }),
    ...fiches.map((fiche) => new AgentGenerique({ fiche, moteur, config })),
    new AgentOrchestrateur({ config, fiches, racineSortie }),
    new AgentOrdonnanceur({ config, racineSortie })
  ];
  if (avecTableauDeBord) agents.push(new AgentTableauDeBord({ config, racineWeb: path.join(racine, 'web') }));
  for (const agent of agents) bus.enregistrer(agent);
  for (const agent of agents) await agent.ouvrir();
  return { bus, agents, fiches, moteur };
}

export async function fermer(agents) {
  for (const agent of [...agents].reverse()) {
    await agent.fermer().catch((e) => console.error(`[${agent.nom}]`, e.message));
  }
}

/** Attend la fin de la file (événement file_vide). */
export function attendreFileVide(bus) {
  return new Promise((ok) => {
    const desabonner = bus.abonner((e) => {
      if (e.type === 'file_vide') {
        desabonner();
        ok();
      }
    });
  });
}
