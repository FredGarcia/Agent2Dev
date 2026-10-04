/**
 * Outils des suites YAML : lecture double (YAML 1.2 et 1.1), parcours du modèle,
 * et épreuve des expressions par les outils qui les exécuteront (grep -E, jq,
 * sh et bash) plutôt que par une réimplémentation de leur syntaxe.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

/** Lit un document YAML deux fois : en YAML 1.2 (le résolveur) et en 1.1 (PyYAML et ses pareils). */
export function lireDocument(chemin) {
  const texte = readFileSync(chemin, 'utf8');
  return { texte, donnees: parse(texte), donnees11: parse(texte, { version: '1.1' }) };
}

/**
 * Les chemins où deux lectures d'un même document diffèrent : « .termes.0.n »,
 * avec les deux valeurs. Sert à comparer la lecture YAML 1.2 à la lecture 1.1,
 * où yes/no/on/off/y/n sont des booléens, 0755 un octal, 1:20 un sexagésimal :
 * une clé « n » non citée y devient la clé « false ».
 */
export function divergences(a, b, chemin = '') {
  const nature = (v) => (v === null ? 'null' : Array.isArray(v) ? 'liste' : typeof v);
  if (nature(a) !== nature(b)) return [{ chemin: chemin || '.', a, b }];
  if (a && typeof a === 'object') {
    const cles = [...new Set([...Object.keys(a), ...Object.keys(b)])];
    return cles.flatMap((k) => divergences(a[k], b[k], `${chemin}.${k}`));
  }
  return Object.is(a, b) ? [] : [{ chemin: chemin || '.', a, b }];
}

export const RE_PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

/** Clés des placeholders d'un texte, dans l'ordre. */
export function placeholders(texte) {
  return [...String(texte).matchAll(RE_PLACEHOLDER)].map((m) => m[1]);
}

/**
 * Remplace chaque placeholder par un mot neutre, pour éprouver une syntaxe sans
 * manifeste : les options compose deviennent de vraies options.
 */
export function neutraliser(texte) {
  return String(texte).replace(RE_PLACEHOLDER, (_, cle) => (cle.startsWith('compose.') ? '-p x7e -f x7e.yaml' : 'x7e'));
}

/** Vrai si grep -E refuse l'expression (code 2). */
export function regexInvalide(motif) {
  return spawnSync('grep', ['-E', '-e', motif], { input: '' }).status === 2;
}

/**
 * Vrai si jq ne compile pas l'expression. Elle est compilée sans être exécutée
 * (branche jamais prise), avec $m, $requis et $contrat déclarés comme dans le résolveur.
 * Le saut de ligne avant la parenthèse protège d'un commentaire final.
 */
export function jqInvalide(expression) {
  const r = spawnSync('jq', ['-n', '--argjson', 'm', '{}', '--argjson', 'requis', '[]', '--arg', 'contrat', '0.0', `if false then (${expression}\n) else empty end`], { encoding: 'utf8' });
  return r.status !== 0;
}

/** Évalue une expression jq sur des données, avec $m, $requis et $contrat. */
export function jqEvaluer(expression, donnees, { m = {}, requis = [], contrat = '0.2' } = {}) {
  const r = spawnSync('jq', ['--argjson', 'm', JSON.stringify(m), '--argjson', 'requis', JSON.stringify(requis), '--arg', 'contrat', contrat, expression], { input: JSON.stringify(donnees), encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr.trim());
  const texte = r.stdout.trim();
  return texte ? JSON.parse(texte) : null;
}

/** Les interpréteurs qui refusent un script (sh -n, bash -n), ou une liste vide. */
export function shellsQuiRefusent(script) {
  return ['sh', 'bash'].filter((sh) => spawnSync(sh, ['-n', '-c', script]).status !== 0);
}

/** Les critères d'un modèle, dans l'ordre : [id, critère, terme]. */
export function criteres(M) {
  const liste = [];
  for (const t of M.termes) for (const c of t.criteres) liste.push([c.id, c, t.id]);
  for (const c of M.second_ordre.criteres) liste.push([c.id, c, 'second_ordre']);
  return liste;
}

/** Les contrôles d'un modèle : { cid, terme, rang, ctl }, rang à partir de 1. */
export function controles(M) {
  return criteres(M).flatMap(([cid, c, terme]) => c.controles.map((ctl, i) => ({ cid, terme, rang: i + 1, ctl })));
}

/** Nom lisible d'un contrôle : « 5.3#2 (scenario) ». */
export const nomControle = ({ cid, rang, ctl }) => `${cid}#${rang} (${ctl.type})`;
