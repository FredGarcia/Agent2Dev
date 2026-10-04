/**
 * Rapporteur console de la recette : une ligne par fichier de test, le détail
 * des seuls échecs (avec leurs opérations en échec), puis le bilan.
 *
 *   node --test --test-reporter=./tests/outils/rapporteur-console.mjs tests/test_*.mjs
 *
 * Le rapporteur « spec » de node:test affiche chaque diagnostic d'étape : utile
 * pour un fichier, illisible pour une campagne de plusieurs centaines de tests.
 * Celui-ci s'appuie sur le même dépouillement que le rapporteur de la recette
 * (rapporteur-recette.mjs) : ce qu'il affiche est ce que la base enregistrera.
 *
 * Texte brut, sans couleur : lisible dans un terminal, un journal de CI ou un
 * fichier ; les symboles doublent toujours un mot (réussi, en échec…).
 */

import { relative } from 'node:path';

import { nouvelEtat, traiter } from './rapporteur-recette.mjs';

const secondes = (ms) => `${(ms / 1000).toFixed(1).replace('.', ',')} s`;
const pluriel = (n, un, plusieurs) => `${n} ${n > 1 ? plusieurs : un}`;
const court = (v) => {
  const t = typeof v === 'string' ? v : JSON.stringify(v);
  return t === undefined ? '—' : t.length > 160 ? `${t.slice(0, 160)}…` : t;
};

/** Le décompte d'une liste de tests, en mots. */
export function decompte(tests) {
  const n = (s) => tests.filter((t) => t.statut === s).length;
  const parties = [pluriel(n('reussi'), 'réussi', 'réussis')];
  if (n('echoue')) parties.push(`${n('echoue')} en échec`);
  if (n('erreur')) parties.push(`${n('erreur')} en erreur`);
  if (n('omis')) parties.push(pluriel(n('omis'), 'omis', 'omis'));
  if (n('a_faire')) parties.push(`${n('a_faire')} à faire`);
  const ops = tests.reduce((s, t) => s + t.etapes.length, 0);
  parties.push(pluriel(ops, 'opération', 'opérations'));
  return parties.join(' · ');
}

/** Les lignes d'un fichier terminé : sa ligne de bilan, puis ses échecs, omissions et « à faire ». */
export function lignesFichier(fichier, tests, dureeMs) {
  const enEchec = tests.filter((t) => t.statut === 'echoue' || t.statut === 'erreur');
  const symbole = enEchec.length ? '✖' : '✔';
  const lignes = [`${symbole} ${fichier} : ${decompte(tests)} · ${secondes(dureeMs)}`];
  for (const t of enEchec) {
    lignes.push(`    ✖ ${t.statut === 'erreur' ? 'erreur' : 'échec'} : ${t.nom_complet}`);
    for (const e of t.etapes.filter((x) => x.statut !== 'reussie')) {
      lignes.push(`        #${e.ordre} ${e.libelle} (${e.statut})`);
      if (e.statut === 'echouee') lignes.push(`           attendu ${court(e.attendu)} ; obtenu ${court(e.obtenu)}`);
      else if (e.message) lignes.push(`           ${court(e.message)}`);
    }
    if (t.motif && !t.etapes.some((x) => x.statut !== 'reussie')) lignes.push(`        ${court(t.motif)}`);
  }
  for (const t of tests.filter((x) => x.statut === 'omis')) lignes.push(`    ○ omis : ${t.nom_complet} (${t.motif})`);
  for (const t of tests.filter((x) => x.statut === 'a_faire')) lignes.push(`    ◌ à faire : ${t.nom_complet} (${t.motif})`);
  return lignes;
}

export default async function* rapporteurConsole(source) {
  const etat = nouvelEtat();
  const debut = Date.now();
  const debuts = new Map();
  for await (const evenement of source) {
    traiter(etat, evenement);
    const fichier = evenement.data?.file;
    if (fichier && !debuts.has(fichier)) debuts.set(fichier, Date.now());
    // Un fichier est terminé quand node:test en publie le résumé
    if (evenement.type === 'test:summary' && fichier) {
      const relatif = relative(etat.racine, fichier).split('\\').join('/');
      const tests = etat.tests.filter((t) => t.fichier === relatif);
      const duree = evenement.data.duration_ms ?? Date.now() - (debuts.get(fichier) ?? debut);
      yield `${lignesFichier(relatif, tests, duree).join('\n')}\n`;
    }
  }
  const tous = etat.tests;
  const enEchec = tous.filter((t) => t.statut === 'echoue' || t.statut === 'erreur').length;
  yield `\n${enEchec ? '✖' : '✔'} Recette : ${pluriel(tous.length, 'test', 'tests')} · ${decompte(tous)} · ${secondes(Date.now() - debut)}\n`;
}
