import { chargerConfig, construire, fermer } from './atelier.js';

const config = await chargerConfig();
let atelier;
try {
  atelier = await construire({ config });
} catch (erreur) {
  console.error(`\nDémarrage impossible : ${erreur.message}\n`);
  process.exit(1);
}
const { agents, fiches, moteur } = atelier;

const arret = async () => {
  console.log('\nFermeture des agents…');
  await fermer(agents);
  process.exit(0);
};
process.on('SIGINT', arret);
process.on('SIGTERM', arret);

console.log(`\nAtelier de modification — mode ${config.mode}, moteur ${moteur.nom}`);
console.log(`Dépôt : ${config.depot.racine}`);
console.log(`Phases : ${fiches.map((f) => `${f.code} (${f.agent})`).join(' → ')}`);
console.log(`Points de contrôle : ${config.orchestration.validationAuto ? 'validation automatique' : 'opérateur'}`);
console.log(`Tableau de bord : http://${config.tableauDeBord.hote}:${config.tableauDeBord.port}\n`);
