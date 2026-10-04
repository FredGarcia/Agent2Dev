/**
 * Les fichiers YAML du dépôt, chargés dans donnees.document à chaque campagne,
 * à chaque demande « Recharger les données » de l'interface et au démarrage de
 * l'exécuteur.
 *
 *   modèle      modele-executif-12f-7e.yaml
 *   manifestes  chaque 7e-instance.yaml du dépôt (hors node_modules et .git)
 *   journal     <journal du manifeste racine>/<instance>/NNNN.yaml
 *   workflows   recette/workflows.yaml, le catalogue que l'interface reflète
 *   ci          les workflows de CI du dépôt : .gitea/workflows/*.y(a)ml et
 *               .github/workflows/*.y(a)ml
 *
 * Lecture en YAML 1.2, comme le résolveur. Un fichier illisible est chargé
 * quand même, avec { erreur } pour contenu : les tests SQL le voient.
 * Le chargement remplace l'état précédent en une transaction, sous un verrou
 * qui sérialise les rechargements (campagne, interface, démarrage de
 * l'exécuteur).
 */

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { parse } from 'yaml';

import { empreinte, jsonPourPg } from './base.mjs';

const NOM_MODELE = 'modele-executif-12f-7e.yaml';
const NOM_MANIFESTE = '7e-instance.yaml';
const CATALOGUE = join('recette', 'workflows.yaml');
const REPERTOIRES_CI = [join('.gitea', 'workflows'), join('.github', 'workflows')];

function chercher(rep, nom, trouves = []) {
  for (const e of readdirSync(rep, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = join(rep, e.name);
    if (e.isDirectory()) chercher(p, nom, trouves);
    else if (e.isFile() && e.name === nom) trouves.push(p);
  }
  return trouves;
}

/** JSON sûr : les nombres non finis (.inf du YAML) deviennent null, comme en JSON. */
const versJson = (valeur) => JSON.parse(JSON.stringify(valeur ?? null, (_, v) => (typeof v === 'number' && !Number.isFinite(v) ? null : v)));

function lireDocument(racine, chemin, nature) {
  const texte = readFileSync(chemin, 'utf8');
  let contenu;
  try {
    contenu = versJson(parse(texte));
    if (contenu === null || typeof contenu !== 'object' || Array.isArray(contenu)) contenu = { erreur: 'le document n’est pas une table YAML' };
  } catch (e) {
    contenu = { erreur: `YAML illisible : ${e.message}` };
  }
  return { nature, chemin: relative(racine, chemin).split('\\').join('/'), contenu, empreinte: empreinte(texte) };
}

/** Les documents du dépôt, dans l'ordre : modèle, manifestes, journal. */
export function documentsDuDepot(racine) {
  const docs = [];
  const modele = join(racine, NOM_MODELE);
  if (existsSync(modele)) docs.push(lireDocument(racine, modele, 'modele'));
  const manifestes = chercher(racine, NOM_MANIFESTE).sort();
  for (const m of manifestes) docs.push(lireDocument(racine, m, 'manifeste'));
  // Le journal : celui que déclare le manifeste racine, une instance par répertoire
  const racineManifeste = join(racine, NOM_MANIFESTE);
  let journal = 'journal';
  if (existsSync(racineManifeste)) {
    try { journal = String(parse(readFileSync(racineManifeste, 'utf8'))?.journal ?? 'journal'); } catch { /* manifeste illisible : défaut */ }
  }
  const dossier = join(racine, journal);
  if (existsSync(dossier) && statSync(dossier).isDirectory()) {
    for (const instance of readdirSync(dossier).sort()) {
      const rep = join(dossier, instance);
      if (!statSync(rep).isDirectory()) continue;
      for (const f of readdirSync(rep).filter((x) => x.endsWith('.yaml') && !x.startsWith('.')).sort()) {
        docs.push(lireDocument(racine, join(rep, f), 'journal'));
      }
    }
  }
  // Le catalogue des workflows, puis les workflows de CI
  if (existsSync(join(racine, CATALOGUE))) docs.push(lireDocument(racine, join(racine, CATALOGUE), 'workflows'));
  for (const relatif of REPERTOIRES_CI) {
    const rep = join(racine, relatif);
    if (!existsSync(rep) || !statSync(rep).isDirectory()) continue;
    for (const f of readdirSync(rep).filter((x) => /\.ya?ml$/.test(x) && !x.startsWith('.')).sort()) {
      if (statSync(join(rep, f)).isFile()) docs.push(lireDocument(racine, join(rep, f), 'ci'));
    }
  }
  return docs;
}

/** Clé du verrou de transaction des documents (clé simple : hors de l'espace des clés doubles). */
export const CLE_DOCUMENTS = 7_277_715;

/**
 * Prend le verrou des documents pour la transaction du client : deux
 * rechargements ne se croisent jamais ; le second attend, puis remplace ce que
 * le premier a validé. Réentrant dans une même transaction.
 */
export const verrouillerDocuments = (client) => client.query('SELECT pg_advisory_xact_lock($1)', [CLE_DOCUMENTS]);

/**
 * Remplace les documents chargés par ceux du dépôt, dans la transaction du
 * client donné, sous le verrou des documents. Rend le nombre de documents par
 * nature.
 */
export async function chargerDocuments(client, racine, campagneId = null) {
  const docs = documentsDuDepot(racine);
  await verrouillerDocuments(client);
  await client.query('DELETE FROM donnees.document');
  if (docs.length) {
    await client.query(
      `INSERT INTO donnees.document (nature, chemin, contenu, empreinte, campagne_id)
       SELECT d.nature, d.chemin, d.contenu, d.empreinte, $2
       FROM jsonb_to_recordset($1::jsonb) AS d(nature text, chemin text, contenu jsonb, empreinte text)`,
      [jsonPourPg(docs), campagneId],
    );
  }
  const compte = { modele: 0, manifeste: 0, journal: 0, workflows: 0, ci: 0 };
  for (const d of docs) compte[d.nature] += 1;
  return compte;
}
