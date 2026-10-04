/**
 * Environnement des tests : variables d'environnement, PATH réduits ou enrichis
 * d'exécutables simulés, capture de la sortie de main(), détection de Docker.
 *
 * Le résolveur lit son environnement à l'exécution (DEPOT_7E, MODELE_7E,
 * MANIFESTE_7E, DELAI_CONTROLE_7E, CI…) et cherche ses outils dans PATH : ces
 * aides permettent de placer chaque test dans une situation précise, puis de
 * tout remettre en l'état, même quand le test échoue.
 */

import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, constants, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { after } from 'node:test';

/** Un répertoire jetable, retiré à la fin du fichier de tests qui l'a créé. */
export function jetable(prefixe) {
  const rep = mkdtempSync(join(tmpdir(), prefixe));
  after(() => rmSync(rep, { recursive: true, force: true }));
  return rep;
}

/** Les variables qui font croire au résolveur qu'il tourne en CI. */
export const VARIABLES_CI = ['CI', 'GITEA_ACTIONS', 'GITHUB_ACTIONS'];

/** Environnement neutre : hors CI, sans configuration héritée du résolveur. */
export const NEUTRE = Object.freeze({
  CI: undefined, GITEA_ACTIONS: undefined, GITHUB_ACTIONS: undefined,
  DEPOT_7E: undefined, MODELE_7E: undefined, MANIFESTE_7E: undefined, DELAI_CONTROLE_7E: undefined,
});

/**
 * Exécute fn avec des variables posées (valeur texte) ou retirées (undefined),
 * puis restaure l'environnement d'origine. fn peut être asynchrone.
 */
export function avecEnv(variables, fn) {
  const avant = {};
  for (const [k, v] of Object.entries(variables)) {
    avant[k] = Object.hasOwn(process.env, k) ? process.env[k] : undefined;
    if (v === undefined) delete process.env[k];
    else process.env[k] = String(v);
  }
  const restaurer = () => {
    for (const [k, v] of Object.entries(avant)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  let r;
  try {
    r = fn();
  } catch (e) {
    restaurer();
    throw e;
  }
  if (r && typeof r.then === 'function') return r.finally(restaurer);
  restaurer();
  return r;
}

/**
 * Capture ce que fn écrit sur la sortie standard et la sortie d'erreur (fn est
 * synchrone, comme main() du résolveur). Rend la valeur de fn, les deux textes
 * et les événements du journal JSON du résolveur (une ligne JSON par événement).
 */
export function capturer(fn) {
  const { write: ecrireSortie } = process.stdout;
  const { write: ecrireErreur } = process.stderr;
  let sortie = '';
  let erreurs = '';
  process.stdout.write = (t) => { sortie += t; return true; };
  process.stderr.write = (t) => { erreurs += t; return true; };
  let valeur;
  try {
    valeur = fn();
  } finally {
    process.stdout.write = ecrireSortie;
    process.stderr.write = ecrireErreur;
  }
  const evenements = erreurs.split('\n').filter((l) => l.startsWith('{')).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
  return { valeur, sortie, erreurs, evenements };
}

/** Vrai si l'exécutable est trouvé dans le PATH courant. */
export function trouve(outil) {
  for (const rep of (process.env.PATH ?? '').split(delimiter)) {
    if (!rep) continue;
    try {
      const p = join(rep, outil);
      accessSync(p, constants.X_OK);
      if (statSync(p).isFile()) return true;
    } catch { /* absent ici */ }
  }
  return false;
}

const reduits = new Map();
after(() => { for (const rep of reduits.values()) rmSync(rep, { recursive: true, force: true }); });

/**
 * Un PATH qui contient tous les exécutables du PATH courant sauf ceux nommés :
 * pour simuler l'absence d'un outil (docker, jq, gitleaks…) sans rien désinstaller.
 * Le répertoire de liens est construit une fois par combinaison et réutilisé.
 */
export function pathSans(outils) {
  const cle = [...outils].sort().join(',');
  if (reduits.has(cle)) return reduits.get(cle);
  // réutilisé d'un test à l'autre : retiré à la fin du fichier (crochet racine, plus bas)
  const rep = mkdtempSync(join(tmpdir(), `r7e-path-sans-${cle.replace(/[^a-z0-9]+/gi, '-')}-`));
  const exclus = new Set(outils);
  const vus = new Set();
  for (const source of (process.env.PATH ?? '').split(delimiter)) {
    if (!source) continue;
    let noms = [];
    try { noms = readdirSync(source); } catch { continue; }
    for (const nom of noms) {
      if (exclus.has(nom) || vus.has(nom)) continue;
      const cible = join(source, nom);
      try {
        accessSync(cible, constants.X_OK);
        if (!statSync(cible).isFile()) continue;
        symlinkSync(cible, join(rep, nom));
        vus.add(nom);
      } catch { /* illisible ou déjà lié */ }
    }
  }
  reduits.set(cle, rep);
  return rep;
}

/**
 * Un répertoire d'exécutables simulés, à placer en tête du PATH :
 * { nom: 'script sh' }. Rend le PATH complet à utiliser.
 */
export function pathAvec(simules, base = process.env.PATH ?? '') {
  const rep = jetable('r7e-simules-');
  mkdirSync(rep, { recursive: true });
  for (const [nom, script] of Object.entries(simules)) {
    const p = join(rep, nom);
    writeFileSync(p, `#!/bin/sh\n${script}\n`);
    chmodSync(p, 0o755);
  }
  return `${rep}${delimiter}${base}`;
}

/** Docker : client, plugin compose, démon joignable (les scénarios en dépendent). */
export const DOCKER = (() => {
  const client = trouve('docker');
  const compose = client && spawnSync('docker', ['compose', 'version'], { encoding: 'utf8' }).status === 0;
  const demon = client && spawnSync('docker', ['info'], { encoding: 'utf8', timeout: 15000 }).status === 0;
  return Object.freeze({ client, compose, demon });
})();

/** Motif d'omission lisible pour un test qui exige un outil absent. */
export const SANS_DEMON = DOCKER.demon ? false : 'démon Docker injoignable : à exécuter dans la VM de recette';
export const SANS_COMPOSE = DOCKER.compose ? false : 'docker compose absent';
