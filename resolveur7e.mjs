#!/usr/bin/env node
/**
 * Résolveur du modèle exécutif 12 facteurs × 7E.
 *
 * Exécute le cycle 7E d'un projet à partir du modèle (spec YAML) et du manifeste
 * de l'instance (7e-instance.yaml), puis écrit l'entrée de journal du cycle.
 *
 * Commandes
 *   valider     Évaluer seul : modèle, manifeste, release, CI, outils
 *   examiner    Évaluer puis Examiner, sans écrire de journal
 *   cycle       cycle complet ; l'entrée reste ouverte, sauf avec --clore
 *   proposer    ajoute une proposition au modèle dans l'entrée ouverte
 *   clore       clôt l'entrée ouverte ; close, elle n'est plus réécrite
 *   historique  liste les entrées closes du journal
 *
 * Configuration, par variables d'environnement (voir .env.example)
 *   DEPOT_7E           racine du dépôt examiné (défaut : répertoire courant)
 *   MODELE_7E          chemin du modèle (défaut : modele-executif-12f-7e.yaml du dépôt)
 *   MANIFESTE_7E       chemin du manifeste (défaut : 7e-instance.yaml du dépôt)
 *   DELAI_CONTROLE_7E  délai maximal d'un contrôle, en secondes (défaut : 600)
 *
 * Le résolveur exécute les commandes que déclare le manifeste : le manifeste fait
 * partie du dépôt examiné et porte la même confiance que son code.
 * Journalisation : une ligne JSON horodatée par événement, sur la sortie d'erreur.
 * Node.js 20 ou plus ; une seule dépendance, le paquet yaml.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { constants as constantesOs, tmpdir } from 'node:os';
import { delimiter, join, posix, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { parse, stringify } from 'yaml';

export const PHASES = ['evaluer', 'elaborer', 'executer', 'examiner', 'evoluer', 'emettre', 'equilibrer'];
export const NOMS_PHASES = {
  evaluer: 'Évaluer', elaborer: 'Élaborer', executer: 'Exécuter', examiner: 'Examiner',
  evoluer: 'Évoluer', emettre: 'Émettre', equilibrer: 'Équilibrer',
};
export const NOMS_TERMES = {
  elements: 'Éléments', espace: 'Espace', engendrent: 'Engendrent', etat: 'État',
  expression: 'Expression', evolutif: 'Évolutif', environnement: 'Environnement',
  second_ordre: 'Second ordre',
};
const OUTILS = ['sh', 'git', 'jq', 'grep', 'docker', 'gitleaks', 'trivy'];
const NATURES = ['ajout', 'retrait', 'reformulation', 'controle', 'retour'];

// ── Journalisation : une ligne JSON par événement, sur stderr ────────────────
export function maintenant() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function log(niveau, evenement, champs = {}) {
  process.stderr.write(JSON.stringify({ ts: maintenant(), niveau, evenement, ...champs }) + '\n');
}

// ── Résultats et exceptions ──────────────────────────────────────────────────
export class Resultat {
  /** resultat : conforme | partiel | absent | sans_objet | erreur ; cause : outil_absent | hors_compose | execution */
  constructor(type, resultat, constat, { cause = null, preuve = null, heuristique = false } = {}) {
    this.type = type;
    this.resultat = resultat;
    this.constat = constat;
    this.cause = cause;
    this.preuve = preuve;
    this.heuristique = heuristique;
  }

  versJournal() {
    const d = { type: this.type, resultat: this.resultat, constat: this.constat };
    if (this.cause) d.cause = this.cause;
    if (this.heuristique) d.heuristique = true;
    return d;
  }
}

/** Un champ du manifeste demandé par un contrôle n'est pas déclaré. */
class ChampAbsent extends Error {}

/** L'environnement visé n'a pas de fichiers compose. */
class HorsCompose extends Error {}

export class ErreurControle extends Error {
  constructor(cause, message) {
    super(message);
    this.causeControle = cause;
  }
}

/** Une garde du protocole arrête la commande. */
export class Refus extends Error {}

// ── Nombres : arrondis et formats de Python, au pair sur la valeur exacte ────
// Les moyennes du journal et les constats doivent être les mêmes quel que soit
// le résolveur qui les écrit : l'arrondi se fait sur la valeur décimale exacte
// du flottant, au pair en cas d'égalité, comme round() et format() de Python.

/** |x| = n × 10^e exactement, n entier, e ≤ 0. */
function decimalExact(x) {
  const vue = new DataView(new ArrayBuffer(8));
  vue.setFloat64(0, Math.abs(x));
  const haut = vue.getUint32(0);
  const bits = (haut >>> 20) & 0x7ff;
  let mantisse = (BigInt(haut & 0xfffff) << 32n) | BigInt(vue.getUint32(4));
  let k = -1074;
  if (bits !== 0) {
    mantisse |= 1n << 52n;
    k = bits - 1075;
  }
  return k >= 0 ? { n: mantisse << BigInt(k), e: 0 } : { n: mantisse * 5n ** BigInt(-k), e: k };
}

/** Entier q tel que q × 10^-f soit n × 10^e arrondi au pair à f décimales. */
function arrondiPair(n, e, f) {
  const d = -f - e;
  if (d <= 0) return n * 10n ** BigInt(-d);
  const p = 10n ** BigInt(d);
  let q = n / p;
  const r = n % p;
  const moitie = p / 2n;
  if (r > moitie || (r === moitie && q % 2n === 1n)) q += 1n;
  return q;
}

/** f"{x:.{f}f}" de Python. */
export function fixe(x, f) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : x > 0 ? 'inf' : '-inf';
  const { n, e } = decimalExact(x);
  const q = arrondiPair(n, e, f).toString().padStart(f + 1, '0');
  const corps = f > 0 ? `${q.slice(0, -f)}.${q.slice(-f)}` : q;
  return (x < 0 || Object.is(x, -0) ? '-' : '') + corps;
}

/** round(x, f) de Python. */
export function arrondi(x, f = 2) {
  return Number(fixe(x, f));
}

/** f"{x:g}" de Python : p chiffres significatifs, zéros finaux retirés. */
export function formatG(x, p = 6) {
  if (!Number.isFinite(x)) return Number.isNaN(x) ? 'nan' : x > 0 ? 'inf' : '-inf';
  const signe = x < 0 || Object.is(x, -0) ? '-' : '';
  if (x === 0) return `${signe}0`;
  const { n, e } = decimalExact(x);
  let X = n.toString().length - 1 + e;
  let q = arrondiPair(n, e, p - 1 - X);
  if (q.toString().length > p) {
    q /= 10n;
    X += 1;
  }
  const D = q.toString();
  if (X < -4 || X >= p) {
    const queue = D.slice(1).replace(/0+$/, '');
    return `${signe}${D[0]}${queue ? '.' + queue : ''}e${X < 0 ? '-' : '+'}${String(Math.abs(X)).padStart(2, '0')}`;
  }
  const entier = X >= 0 ? D.slice(0, X + 1) : '0';
  const decimales = (X >= 0 ? D.slice(X + 1) : '0'.repeat(-X - 1) + D).replace(/0+$/, '');
  return signe + entier + (decimales ? `.${decimales}` : '');
}

/** Python float() sur un texte : décimal, exposant, inf, nan ; rien d'autre. */
function versFlottant(texte) {
  const t = texte.trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  const mot = /^([+-]?)(inf|infinity|nan)$/i.exec(t);
  if (mot) return mot[2].toLowerCase() === 'nan' ? NaN : mot[1] === '-' ? -Infinity : Infinity;
  return null;
}

// ── Textes ───────────────────────────────────────────────────────────────────
/** Lignes non vides, coupées comme str.splitlines() de Python. */
function lignesDe(texte) {
  return texte.split(/\r\n|[\n\r\v\f\x1c\x1d\x1e\x85\u2028\u2029]/).filter(Boolean);
}

// Séquences d'échappement des terminaux (couleurs des outils) : hors du journal
const RE_ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

export function extrait(texte, n = 240) {
  const t = String(texte).replace(RE_ANSI, '').split(/\s+/).filter(Boolean).join(' ');
  const signes = Array.from(t);
  return signes.length <= n ? t : signes.slice(0, n - 1).join('') + '…';
}

/** Valeur insérée dans une commande ou un constat. */
function texteDe(v) {
  if (v === null || v === undefined) return '';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
}

/** Valeur rendue par une assertion jq, dans un constat. */
function texteAssertion(v) {
  if (typeof v === 'boolean') return v ? 'vrai' : 'faux';
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/** shlex.quote de Python. */
export function quote(s) {
  const t = String(s);
  if (t === '') return "''";
  if (!/[^\w@%+=:,./-]/.test(t)) return t;
  return `'${t.replace(/'/g, `'"'"'`)}'`;
}

export function echapperEre(texte) {
  return String(texte).replace(/[\\.[\]{}()*+?^$|]/g, '\\$&');
}

const RE_PLACEHOLDER = /\{\{\s*([^}]+?)\s*\}\}/g;

// ── Exécution de commandes ───────────────────────────────────────────────────
function delaiControle() {
  const brut = process.env.DELAI_CONTROLE_7E ?? '600';
  if (!/^\s*\+?\d+\s*$/.test(brut) || Number(brut) <= 0) {
    throw new Refus(`DELAI_CONTROLE_7E doit être un nombre entier de secondes : ${JSON.stringify(brut)}`);
  }
  return Number(brut);
}

/**
 * À l'échéance du délai, seul le processus lancé est tué, par SIGKILL
 * (types_de_controle.regles.delai) ; sa sortie partielle reste au constat.
 * env : variables ajoutées à l'environnement (TMPDIR du cycle, par exemple).
 */
function lancer(argv, depot, { entree = null, delai = null, env = null } = {}) {
  const r = spawnSync(argv[0], argv.slice(1), {
    cwd: depot,
    input: entree ?? undefined,
    encoding: 'utf8',
    timeout: (delai || delaiControle()) * 1000,
    killSignal: 'SIGKILL',
    maxBuffer: Infinity,
    env: env ? { ...process.env, ...env } : undefined,
  });
  // EPIPE : le processus s'est terminé sans lire son entrée ; son code fait foi
  if (r.error && !(r.error.code === 'EPIPE' && r.status !== null)) {
    if (r.error.code === 'ENOENT') return { code: 127, out: '', err: `${argv[0]} : introuvable` };
    if (r.error.code === 'ETIMEDOUT') return { code: 124, out: r.stdout ?? '', err: 'délai dépassé' };
    return { code: 126, out: r.stdout ?? '', err: `${argv[0]} : ${r.error.message}` };
  }
  if (r.status === null) return { code: 128 + (constantesOs.signals[r.signal] ?? 0), out: r.stdout, err: r.stderr };
  return { code: r.status, out: r.stdout, err: r.stderr };
}

function shell(script, depot, env = null) {
  return lancer(['sh', '-c', script], depot, { env });
}

/**
 * Cherche un outil dans le PATH comme spawnSync le résout (libuv) : le nom tel quel
 * sous POSIX ; sous Windows, suffixé de .com puis de .exe, jamais sans extension, et
 * sans bit d'exécution à vérifier. La ligne « Outils » dit ainsi ce que lancer() peut
 * réellement exécuter. Les options servent aux tests.
 */
function trouver(outil, { plateforme = process.platform, chemin = process.env.PATH ?? '', separateur = delimiter } = {}) {
  const windows = plateforme === 'win32';
  const suffixes = windows ? ['.com', '.exe'] : [''];
  const acces = windows ? constants.F_OK : constants.X_OK;
  for (const rep of chemin.split(separateur)) {
    if (!rep) continue;
    for (const suffixe of suffixes) {
      try {
        const fichier = join(rep, outil + suffixe);
        accessSync(fichier, acces);
        if (statSync(fichier).isFile()) return true;
      } catch {
        // absent de ce répertoire
      }
    }
  }
  return false;
}

function estFichier(chemin) {
  return statSync(chemin, { throwIfNoEntry: false })?.isFile() ?? false;
}

function estRepertoire(chemin) {
  return statSync(chemin, { throwIfNoEntry: false })?.isDirectory() ?? false;
}

// ── Accès au manifeste ───────────────────────────────────────────────────────
const estTable = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const propre = (n, cle) => (estTable(n) && Object.hasOwn(n, cle) ? n[cle] : undefined);

export function present(v) {
  return !(v === null || v === undefined || v === ''
    || (Array.isArray(v) && v.length === 0)
    || (estTable(v) && Object.keys(v).length === 0));
}

/** requiert : « <nom> » vaut chaque entrée d'une table, une liste vaut si un élément porte le champ. */
export function champPresent(noeud, chemin) {
  const parts = chemin.split('.');
  const rec = (n, i) => {
    if (i === parts.length) return present(n);
    if (Array.isArray(n)) return n.some((e) => rec(e, i));
    if (!estTable(n)) return false;
    if (parts[i].startsWith('<')) return Object.keys(n).length > 0 && Object.values(n).every((v) => rec(v, i + 1));
    return Object.hasOwn(n, parts[i]) && rec(n[parts[i]], i + 1);
  };
  return rec(noeud, 0);
}

function valeur(noeud, chemin, prefixe = '') {
  let n = noeud;
  for (const p of chemin.split('.')) {
    if (!present(propre(n, p))) throw new ChampAbsent(prefixe + chemin);
    n = n[p];
  }
  return n;
}

function lireYaml(chemin) {
  try {
    return parse(readFileSync(chemin, 'utf8'));
  } catch (e) {
    throw new Refus(`${chemin} : YAML illisible : ${extrait(e.message, 200)}`);
  }
}

const comparer = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ── Contexte d'un cycle ──────────────────────────────────────────────────────
export class Contexte {
  constructor(depot, cheminModele, cheminManifeste) {
    this.depot = resolve(depot);
    this.M = lireYaml(cheminModele);
    if (!estTable(this.M)) throw new Refus(`${cheminModele} : le modèle doit être une table YAML`);
    this.m = lireYaml(cheminManifeste) ?? {};
    if (!estTable(this.m)) throw new Refus(`${cheminManifeste} : le manifeste doit être une table YAML`);
    this.instance = String(propre(this.m.instance, 'id') ?? 'instance');
    this.plateforme = process.platform;
    this.outils = Object.fromEntries(OUTILS.map((o) => [o, trouver(o)]));
    this.enCi = ['CI', 'GITEA_ACTIONS', 'GITHUB_ACTIONS'].some((v) => ['true', '1'].includes((process.env[v] ?? '').toLowerCase()));
    this.numero = 0;
    this.release = null;
    this.remarques = [];
    this.mesures = [];
    this.criteres = [];
    this.termeDe = {};
    for (const t of this.M.termes) {
      for (const c of t.criteres) {
        this.criteres.push([String(c.id), c]);
        this.termeDe[c.id] = t.id;
      }
    }
    for (const c of this.M.second_ordre.criteres) {
      this.criteres.push([String(c.id), c]);
      this.termeDe[c.id] = 'second_ordre';
    }
    this.sansObjet = estTable(this.m.sans_objet) ? { ...this.m.sans_objet } : {};
    this.requis = this.indicateursRequis();
    this.exclusion = this.M.types_de_controle.exclusion_globale;
    this.fichiers = null;
    this.demon = null;
    this.temp = null; // répertoire temp du cycle (regles.fichiers_temporaires)
  }

  /**
   * Environnement des commandes, scénarios et mesures : TMPDIR sur le temp du cycle
   * (regles.fichiers_temporaires). Hors cycle, celui que pose l'appelant (examiner en
   * pose un jetable), sinon le TMPDIR hérité.
   */
  envCommandes() {
    if (this.temp === null) return null;
    mkdirSync(this.temp, { recursive: true });
    return { TMPDIR: this.temp };
  }

  /** Le client docker peut exister sans démon joignable : les scénarios et mesures en ont besoin. */
  get demonDocker() {
    if (this.demon === null) {
      this.demon = this.outils.docker && lancer(['docker', 'info'], this.depot, { delai: 15 }).code === 0;
    }
    return this.demon;
  }

  /** Indicateurs dont un seuil est exigé : métriques des critères applicables + revue. */
  indicateursRequis() {
    const ind = new Set(['periode_revue_cycles']);
    for (const [cid, c] of this.criteres) {
      if (Object.hasOwn(this.sansObjet, cid)) continue;
      for (const ctl of c.controles) if (ctl.type === 'metrique') ind.add(ctl.indicateur);
    }
    return [...ind].sort();
  }

  get contratVersion() {
    const [majeure, mineure] = String(this.M.modele.version).split('.');
    return majeure === '0' ? `0.${mineure}` : majeure;
  }

  get cycleId() {
    return `${this.instance}-${String(this.numero).padStart(4, '0')}`;
  }

  /** Répertoire du journal, relatif à la racine du dépôt et normalisé (./journal, journal/ → journal). */
  journalRelatif() {
    const j = this.m.journal;
    const brut = present(j) && typeof j !== 'object' ? String(j) : 'journal';
    return relative(this.depot, resolve(this.depot, brut)).split(sep).join('/');
  }

  journalDir() {
    return join(this.depot, this.journalRelatif(), this.instance);
  }

  fichiersVersionnes() {
    if (this.fichiers === null) {
      const s = lancer(['git', 'ls-files', '-z'], this.depot);
      if (s.code !== 0) throw new ErreurControle(s.code === 127 ? 'outil_absent' : 'execution', 'git ls-files : ' + extrait(s.err));
      this.fichiers = s.out.split('\0').filter(Boolean);
    }
    return this.fichiers;
  }

  optionsCompose(nom) {
    const envs = estTable(this.m.environnements) ? this.m.environnements : {};
    let cible = nom;
    if (nom === 'test' || nom === 'depot') {
      cible = this.m.environnement_test;
      if (!present(cible)) throw new ChampAbsent('environnement_test');
    }
    if (!Object.hasOwn(envs, cible)) throw new ChampAbsent(`environnements.${cible}`);
    const env = estTable(envs[cible]) ? envs[cible] : {};
    const fichiers = Array.isArray(env.fichiers) ? env.fichiers : present(env.fichiers) ? [env.fichiers] : [];
    if (!fichiers.length) throw new HorsCompose(String(cible));
    const opts = [];
    if (nom === 'test' || nom === 'depot') opts.push('-p', `7e-${this.cycleId}`.toLowerCase().replace(/[^a-z0-9_-]/g, '-'));
    for (const f of fichiers) opts.push('-f', String(f));
    if (nom === 'depot') opts.push('--env-file', '.env.example');
    else if (env.env_file) opts.push('--env-file', String(env.env_file));
    return opts.map(quote).join(' ');
  }

  resoudre(texte, item = null, regex = false) {
    return String(texte).replace(RE_PLACEHOLDER, (_, cle) => {
      let v;
      if (cle === 'item') v = item;
      else if (cle.startsWith('item.')) v = valeur(estTable(item) ? item : {}, cle.slice('item.'.length), 'item.');
      else if (cle === 'manifeste.journal') v = this.journalRelatif(); // normalisé (regles.exclusion)
      else if (cle.startsWith('manifeste.')) v = valeur(this.m, cle.slice('manifeste.'.length));
      else if (cle.startsWith('compose.')) return this.optionsCompose(cle.slice('compose.'.length));
      else if (cle.startsWith('chemins.')) {
        const expr = propre(this.M.chemins, cle.slice('chemins.'.length));
        if (typeof expr !== 'string') throw new ErreurControle('execution', `chemin inconnu : ${cle}`);
        return quote(expr);
      }
      else if (cle === 'cycle.id') v = this.cycleId;
      else if (cle === 'cycle.release') v = this.release;
      else throw new ErreurControle('execution', `placeholder inconnu : ${cle}`);
      const t = texteDe(v);
      return regex ? echapperEre(t) : t;
    });
  }

  jq(expression, donnees) {
    const s = lancer(['jq', '--argjson', 'm', JSON.stringify(this.m), '--argjson', 'requis', JSON.stringify(this.requis),
      '--arg', 'contrat', this.contratVersion, expression],
      this.depot, { entree: JSON.stringify(donnees) });
    if (s.code === 127) throw new ErreurControle('outil_absent', 'jq introuvable');
    if (s.code !== 0) throw new ErreurControle('execution', 'jq : ' + extrait(s.err));
    const texte = s.out.trim();
    if (!texte) return null;
    try {
      return JSON.parse(texte);
    } catch {
      throw new ErreurControle('execution', 'jq : une seule valeur JSON attendue, rendu : ' + extrait(texte, 120));
    }
  }

  configCompose(env) {
    const opts = this.optionsCompose(env); // HorsCompose si l'environnement n'a pas de compose
    if (!this.outils.docker) throw new ErreurControle('outil_absent', 'docker introuvable');
    const s = shell(`docker compose ${opts} config --format json`, this.depot);
    if (s.code === 127) throw new ErreurControle('outil_absent', 'docker compose introuvable');
    if (s.code !== 0) throw new ErreurControle('execution', 'docker compose config : ' + extrait(s.err));
    try {
      return JSON.parse(s.out);
    } catch {
      throw new ErreurControle('execution', 'docker compose config : sortie non JSON');
    }
  }

  /** Entrées du journal de l'instance, par nom de fichier : [chemin, entrée]. */
  journal() {
    const d = this.journalDir();
    if (!estRepertoire(d)) return [];
    return readdirSync(d)
      .filter((f) => f.endsWith('.yaml') && !f.startsWith('.') && estFichier(join(d, f)))
      .sort()
      .map((f) => {
        const chemin = join(d, f);
        const e = lireYaml(chemin);
        if (!estTable(e) || !estTable(e.cycle)) throw new Refus(`${chemin} : entrée de journal sans section cycle`);
        return [chemin, e];
      });
  }

  /** Un lien du journal, relatif au répertoire de l'instance, sans en sortir ; null sinon. */
  cheminDuLien(lien) {
    if (typeof lien !== 'string' || !lien) return null;
    const d = this.journalDir();
    const c = resolve(d, lien);
    return c === d || !c.startsWith(d + sep) ? null : c;
  }

  /**
   * Entrées closes, triées par fin. Chacune porte _lus : ce que le résolveur trouve
   * à côté d'elle (types_de_controle.types.journal) : le ticket, et chaque lien de fichiers.
   */
  journalClos() {
    const present = (lien) => { const c = this.cheminDuLien(lien); return c !== null && existsSync(c); };
    return this.journal()
      .map(([, e]) => e)
      .filter((e) => e.cycle.fin)
      .sort((a, b) => comparer(String(a.cycle.fin), String(b.cycle.fin)))
      .map((e) => ({
        ...e,
        _lus: {
          demande: present(propre(e.demande, 'lien')),
          fichiers: (Array.isArray(e.fichiers) ? e.fichiers : []).map((f) => present(propre(f, 'lien'))),
        },
      }));
  }
}

// ── Contrôles unitaires ──────────────────────────────────────────────────────
function grepListe(motif, lignes, depot, inverse = false) {
  const s = lancer(['grep', inverse ? '-vE' : '-E', '-e', motif], depot, { entree: lignes.join('\n') + '\n' });
  if (s.code === 127) throw new ErreurControle('outil_absent', 'grep introuvable');
  if (s.code === 124) throw new ErreurControle('execution', 'grep : délai dépassé');
  if (s.code === 2) throw new ErreurControle('execution', 'expression invalide : ' + extrait(s.err));
  return lignesDe(s.out);
}

function ctlCommande(ctl, ctx, item) {
  const cmd = ctx.resoudre(ctl.commande, item);
  const s = shell(cmd, ctx.depot, ctx.envCommandes());
  if (s.code === 127) throw new ErreurControle('outil_absent', `${extrait(cmd, 60)} : ${extrait(s.err, 120)}`);
  if (s.code === 124) throw new ErreurControle('execution', `${extrait(cmd, 60)} : délai dépassé`);
  const attendu = ctl.attendu ?? 'code_retour_0';
  const ok = s.code === 0 && (attendu === 'code_retour_0'
    || (attendu === 'sortie_non_vide' && s.out.trim() !== '')
    || (attendu === 'sortie_vide' && s.out.trim() === ''));
  const detail = extrait(s.out || s.err, 120) || `code ${s.code}`;
  return new Resultat('commande', ok ? 'conforme' : 'absent', `${extrait(cmd, 80)} → ${detail}`);
}

function ctlFichier(ctl, ctx, item) {
  const fichiers = ctx.fichiersVersionnes();
  const constats = [];
  let ok = true;
  if (Object.hasOwn(ctl, 'versionne')) {
    const rx = ctx.resoudre(ctl.versionne, item, true);
    let trouves = grepListe(rx, fichiers, ctx.depot);
    if (ctl.exclure && trouves.length) trouves = grepListe(ctx.resoudre(ctl.exclure, item, true), trouves, ctx.depot, true);
    ok = ok && trouves.length > 0;
    constats.push(`versionné : ${trouves.length ? trouves.slice(0, 3).join(', ') : 'aucun fichier pour ' + rx}`);
  }
  if (Object.hasOwn(ctl, 'ignore')) {
    const s = lancer(['git', 'check-ignore', '-q', '--', String(ctl.ignore)], ctx.depot);
    ok = ok && s.code === 0;
    constats.push(`${ctl.ignore} ${s.code === 0 ? 'ignoré' : 'non ignoré'} par Git`);
  }
  if (Object.hasOwn(ctl, 'paires')) {
    const versionnes = new Set(fichiers);
    let vues = 0;
    for (const p of ctl.paires) {
      for (const f of fichiers) {
        if (posix.basename(f) !== p.si) continue;
        vues += 1;
        const rep = posix.dirname(f);
        const voisins = p.alors_un_de.map((a) => (rep !== '.' ? `${rep}/${a}` : a));
        if (!voisins.some((v) => versionnes.has(v))) {
          ok = false;
          constats.push(`${f} sans verrou (${p.alors_un_de.join(' ou ')})`);
        }
      }
    }
    if (vues === 0 && Object.keys(ctl).length === 2) { // seul paramètre : aucun manifeste concerné
      return new Resultat('fichier', 'sans_objet', 'aucun manifeste de dépendances concerné');
    }
    if (vues && ok) constats.push(`${vues} manifeste(s) de dépendances, chacun verrouillé`);
  }
  return new Resultat('fichier', ok ? 'conforme' : 'absent', constats.join(' ; '));
}

/** Fichiers que lit un contrôle motif : versionnés, filtrés, présents sur le disque. */
function fichiersDuMotif(ctl, ctx) {
  let fichiers = grepListe(ctl.fichiers, ctx.fichiersVersionnes(), ctx.depot);
  if (ctl.exclure) fichiers = grepListe(ctl.exclure, fichiers, ctx.depot, true);
  // exclusion_globale cite le journal de l'instance ({{ manifeste.journal }}) :
  // sa valeur y est insérée échappée (types_de_controle.regles.insertion)
  fichiers = grepListe(ctx.resoudre(ctx.exclusion, null, true), fichiers, ctx.depot, true);
  return fichiers.filter((f) => estFichier(join(ctx.depot, f)));
}

function ctlMotif(ctl, ctx, item) {
  const fichiers = fichiersDuMotif(ctl, ctx);
  const attendu = ctl.attendu ?? 'absent';
  if (!fichiers.length) {
    if (attendu === 'absent') return new Resultat('motif', 'sans_objet', 'aucun fichier à lire');
    return new Resultat('motif', 'absent', 'aucun fichier à lire pour ' + ctl.fichiers);
  }
  const motif = ctx.resoudre(ctl.motif, item, true);
  const lignes = [];
  for (let i = 0; i < fichiers.length; i += 200) {
    const s = lancer(['grep', '-nEI', '-e', motif, '--', ...fichiers.slice(i, i + 200)], ctx.depot);
    if (s.code === 127) throw new ErreurControle('outil_absent', 'grep introuvable');
    if (s.code === 124) throw new ErreurControle('execution', 'grep : délai dépassé');
    if (s.code === 2) throw new ErreurControle('execution', 'grep : ' + extrait(s.err));
    lignes.push(...lignesDe(s.out));
  }
  if (attendu === 'absent') {
    if (lignes.length) return new Resultat('motif', 'absent', `${lignes.length} occurrence(s) : ` + extrait(lignes.slice(0, 3).join(' | '), 200));
    return new Resultat('motif', 'conforme', `aucune occurrence dans ${fichiers.length} fichier(s)`);
  }
  if (lignes.length) return new Resultat('motif', 'conforme', 'trouvé : ' + extrait(lignes[0], 160));
  return new Resultat('motif', 'absent', `motif absent de ${fichiers.length} fichier(s)`);
}

function ctlCompose(ctl, ctx) {
  const env = ctl.environnement;
  let donnees;
  if (env === 'tous') {
    donnees = [];
    for (const [nom, e] of Object.entries(estTable(ctx.m.environnements) ? ctx.m.environnements : {})) {
      if (present(propre(e, 'fichiers'))) donnees.push({ env: nom, config: ctx.configCompose(nom) });
    }
    if (!donnees.length) throw new HorsCompose('tous');
  } else {
    donnees = ctx.configCompose(env);
  }
  const v = ctx.jq(ctl.assertion, donnees);
  if (v === null) return new Resultat('compose', 'sans_objet', "l'assertion ne s'applique pas");
  return new Resultat('compose', v === true ? 'conforme' : 'absent', `assertion sur la config de ${env} : ${texteAssertion(v)}`);
}

function ctlManifeste(ctl, ctx) {
  const v = ctx.jq(ctl.assertion, ctx.m);
  if (v === null) return new Resultat('manifeste', 'sans_objet', "l'assertion ne s'applique pas");
  return new Resultat('manifeste', v === true ? 'conforme' : 'absent', `assertion sur le manifeste : ${texteAssertion(v)}`);
}

function ctlJournal(ctl, ctx) {
  const v = ctx.jq(ctl.assertion, ctx.journalClos());
  if (v === null) return new Resultat('journal', 'sans_objet', 'historique insuffisant');
  return new Resultat('journal', v === true ? 'conforme' : 'absent', `assertion sur le journal : ${texteAssertion(v)}`);
}

function ctlScenario(ctl, ctx, item) {
  const script = ctx.resoudre(ctl.script, item);
  const test = ctx.optionsCompose('test');
  if (!ctx.demonDocker) throw new ErreurControle('outil_absent', 'démon Docker injoignable');
  // le piège rend le code du script, pas celui du nettoyage
  const enveloppe = `trap "c=\\$?; docker compose ${test} down -v >/dev/null 2>&1; exit \\$c" EXIT\nset -e\n${script}`;
  const s = shell(enveloppe, ctx.depot, ctx.envCommandes());
  if (s.code === 127) throw new ErreurControle('outil_absent', extrait(s.err, 160));
  if (s.code === 124) throw new ErreurControle('execution', 'scénario : délai dépassé');
  if (s.code === 0) return new Resultat('scenario', 'conforme', 'scénario réussi');
  return new Resultat('scenario', 'absent', `scénario en échec (code ${s.code}) : ` + extrait(s.err || s.out, 160));
}

function ctlMetrique(ctl, ctx, item) {
  const ind = ctl.indicateur;
  const script = ctx.resoudre(ctl.mesure, item);
  if (script.includes('docker ') && !ctx.demonDocker) throw new ErreurControle('outil_absent', 'démon Docker injoignable');
  const s = shell(script, ctx.depot, ctx.envCommandes());
  if (s.code === 127) throw new ErreurControle('outil_absent', extrait(s.err, 160));
  const lignes = lignesDe(s.out.trim());
  const v = lignes.length ? versFlottant(lignes[lignes.length - 1]) : null;
  if (v === null || s.code !== 0) {
    throw new ErreurControle('execution', `mesure de ${ind} impossible : ` + extrait(s.err || s.out || `code ${s.code}`, 160));
  }
  const seuil = propre(propre(ctx.m.seuils, ind), 'valeur');
  const comparaison = ctl.comparaison ?? '<=';
  if (typeof seuil !== 'number') {
    ctx.mesures.push({ indicateur: ind, valeur: v, seuil: null, hors_seuil: false });
    return new Resultat('metrique', 'partiel', `${ind} = ${formatG(v)}, seuil non déclaré (EX.2)`);
  }
  const hors = !(comparaison === '<=' ? v <= seuil : v >= seuil);
  ctx.mesures.push({ indicateur: ind, valeur: v, seuil, hors_seuil: hors });
  return new Resultat('metrique', hors ? 'absent' : 'conforme', `${ind} = ${formatG(v)}, seuil ${comparaison} ${formatG(seuil)}`);
}

function ctlDeclaration(ctl, ctx, cid) {
  const d = propre(ctx.m.declarations, cid);
  const decl = estTable(d) ? d : {};
  const rep = decl.reponse;
  if (!['conforme', 'partiel', 'absent'].includes(rep)) {
    return new Resultat('declaration', 'partiel', 'déclaration non faite : ' + ctl.question);
  }
  if (!present(decl.preuve)) return new Resultat('declaration', 'partiel', `déclaré ${rep}, sans preuve`);
  return new Resultat('declaration', rep, `déclaré ${rep}`, { preuve: texteDe(decl.preuve) });
}

const UNITAIRES = {
  commande: ctlCommande, fichier: ctlFichier, motif: ctlMotif, compose: ctlCompose,
  manifeste: ctlManifeste, journal: ctlJournal, scenario: ctlScenario, metrique: ctlMetrique,
};

function executerUnitaire(ctl, ctx, cid, item) {
  const t = ctl.type;
  try {
    if (t === 'declaration') return ctlDeclaration(ctl, ctx, cid);
    if (!Object.hasOwn(UNITAIRES, t)) throw new Error(`type de contrôle inconnu : ${t}`);
    return UNITAIRES[t](ctl, ctx, item);
  } catch (e) {
    if (e instanceof ChampAbsent) return new Resultat(t, 'partiel', `champ non déclaré : ${e.message}`);
    if (e instanceof HorsCompose) {
      if (t === 'compose') return new Resultat(t, 'sans_objet', `environnement sans fichiers compose (${e.message})`);
      return new Resultat(t, 'erreur', `environnement sans fichiers compose (${e.message})`, { cause: 'hors_compose' });
    }
    if (e instanceof ErreurControle) return new Resultat(t, 'erreur', e.message, { cause: e.causeControle });
    throw e;
  }
}

function elements(ctl, ctx) {
  if (Object.hasOwn(ctl, 'pour_chaque')) {
    const s = lancer(['jq', '-c', ctl.pour_chaque], ctx.depot, { entree: JSON.stringify(ctx.m) });
    if (s.code !== 0) throw new ErreurControle(s.code === 127 ? 'outil_absent' : 'execution', 'pour_chaque : ' + extrait(s.err));
    try {
      return s.out.split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
    } catch {
      throw new ErreurControle('execution', 'pour_chaque : sortie non JSON');
    }
  }
  const cfg = ctx.configCompose(ctl.pour_chaque_image);
  const images = Object.values(estTable(cfg.services) ? cfg.services : {}).map((sv) => propre(sv, 'image')).filter(Boolean);
  return [...new Set(images)].sort();
}

export function combiner(t, resultats) {
  const utiles = resultats.filter((r) => r.resultat !== 'sans_objet');
  if (!utiles.length) return new Resultat(t, 'sans_objet', 'rien à examiner');
  const conformes = utiles.filter((r) => r.resultat === 'conforme').length;
  const autres = utiles.filter((r) => r.resultat !== 'conforme');
  // un seul élément (une garde, par exemple) : son constat, qui cite la preuve
  const detail = utiles.length === 1 ? utiles[0].constat
    : `${conformes}/${utiles.length} conformes` + (autres.length ? ' ; ' + autres.slice(0, 3).map((r) => r.constat).join(' | ') : '');
  if (conformes === utiles.length) return new Resultat(t, 'conforme', detail);
  if (conformes || utiles.some((r) => r.resultat === 'partiel')) return new Resultat(t, 'partiel', detail);
  if (utiles.every((r) => r.resultat === 'erreur')) return new Resultat(t, 'erreur', detail, { cause: utiles[0].cause });
  return new Resultat(t, 'absent', detail);
}

/** Contrôle compose dont la cible n'a aucun fichier compose : rien à examiner. */
function sansCompose(ctl, ctx) {
  const envs = estTable(ctx.m.environnements) ? ctx.m.environnements : {};
  const cibles = ctl.environnement === 'tous' ? Object.keys(envs) : [ctl.environnement];
  return cibles.every((c) => Object.hasOwn(envs, c) && !present(propre(envs[c], 'fichiers')));
}

/** Le sans objet automatique passe avant toute autre règle, puis requiert, puis le contrôle. */
export function executerControle(ctl, ctx, cid) {
  const t = ctl.type;
  let items = null;
  let r = null;
  if (t === 'compose' && sansCompose(ctl, ctx)) {
    r = new Resultat(t, 'sans_objet', `aucun fichier compose pour ${ctl.environnement}`);
  } else if (Object.hasOwn(ctl, 'pour_chaque') || Object.hasOwn(ctl, 'pour_chaque_image')) {
    try {
      items = elements(ctl, ctx);
      if (!items.length) r = new Resultat(t, 'sans_objet', 'liste vide : rien à examiner');
    } catch (e) {
      if (e instanceof ChampAbsent) r = new Resultat(t, 'partiel', `champ non déclaré : ${e.message}`);
      else if (e instanceof HorsCompose) r = new Resultat(t, 'sans_objet', `environnement sans fichiers compose (${e.message})`);
      else if (e instanceof ErreurControle) r = new Resultat(t, 'erreur', e.message, { cause: e.causeControle });
      else throw e;
    }
  }
  // Motif attendu absent sans aucun fichier à lire : sans objet, lui aussi avant
  // requiert (types_de_controle.regles.sans_objet_automatique). Une erreur ici
  // (expression invalide, champ non déclaré…) est laissée au contrôle, qui la rendra.
  if (r === null && t === 'motif' && (ctl.attendu ?? 'absent') === 'absent') {
    try {
      if (!fichiersDuMotif(ctl, ctx).length) r = new Resultat(t, 'sans_objet', 'aucun fichier à lire');
    } catch (e) {
      if (!(e instanceof ErreurControle || e instanceof ChampAbsent)) throw e;
    }
  }
  if (r === null) {
    const manquants = (ctl.requiert ?? []).filter((p) => !champPresent(ctx.m, p));
    if (manquants.length) r = new Resultat(t, 'partiel', 'champ non déclaré : ' + manquants.join(', '));
    else if (items !== null) r = combiner(t, items.map((it) => executerUnitaire(ctl, ctx, cid, it)));
    else r = executerUnitaire(ctl, ctx, cid, null);
  }
  r.heuristique = Boolean(ctl.heuristique);
  return r;
}

// ── Agrégation, blocage, synthèse ────────────────────────────────────────────
export function agreger(resultats, enCi) {
  const utiles = resultats.filter((r) => r.resultat !== 'sans_objet');
  if (!utiles.length) return null;
  if (utiles.every((r) => r.resultat === 'conforme')) {
    return enCi && !utiles.some((r) => r.type === 'declaration') ? 3 : 2;
  }
  if (!utiles.some((r) => r.resultat === 'conforme' || r.resultat === 'partiel')
    && !utiles.some((r) => r.heuristique && r.resultat === 'absent')
    && !utiles.some((r) => r.resultat === 'erreur')) {
    return 0;
  }
  return 1;
}

export function examiner(ctx) {
  const scores = {};
  for (const [cid, c] of ctx.criteres) {
    if (Object.hasOwn(ctx.sansObjet, cid)) {
      scores[cid] = { score: null, constat: `sans objet : ${ctx.sansObjet[cid]}`, preuves: [], controles: [] };
      continue;
    }
    const resultats = c.controles.map((ctl) => executerControle(ctl, ctx, cid));
    const score = agreger(resultats, ctx.enCi);
    const aVoir = resultats.filter((r) => r.resultat !== 'conforme' && r.resultat !== 'sans_objet');
    const constat = aVoir.length
      ? aVoir.map((r) => `${r.type} ${r.resultat} : ${r.constat}`).join(' | ')
      : score !== null ? 'tous les contrôles applicables sont conformes' : 'aucun contrôle applicable';
    scores[cid] = {
      score, constat,
      preuves: resultats.filter((r) => r.preuve).map((r) => r.preuve),
      controles: resultats.map((r) => r.versJournal()),
    };
    log('info', 'critere', { critere: cid, score });
  }
  return scores;
}

export function bloquer(ctx, scores) {
  const phases = {};
  for (const [ph, d] of Object.entries(ctx.M.boucle.phases)) {
    const ecarts = d.prerequis.filter((p) => scores[p].score !== null && scores[p].score <= 1);
    if (ecarts.length) {
      phases[ph] = { statut: 'bloquee', cause: ecarts };
      for (const c of d.criteres) {
        if (scores[c].score !== null && scores[c].score > 1) {
          scores[c].score = 1;
          scores[c].constat += ` | plafonné à 1 : prérequis en écart (${ecarts.join(', ')})`;
        }
      }
    } else {
      phases[ph] = { statut: 'executee' };
    }
  }
  return phases;
}

export function synthese(ctx, scores) {
  const s = {};
  for (const terme of Object.keys(NOMS_TERMES)) {
    const notes = Object.entries(scores).filter(([c]) => ctx.termeDe[c] === terme);
    const valides = notes.map(([, v]) => v.score).filter((n) => n !== null);
    s[terme] = {
      moyenne: valides.length ? arrondi(valides.reduce((a, b) => a + b, 0) / valides.length, 2) : null,
      ecarts: notes.filter(([, v]) => v.score !== null && v.score <= 1).map(([c]) => c),
    };
  }
  return s;
}

// ── Le cycle ─────────────────────────────────────────────────────────────────
const montrer = (v) => (v === null || v === undefined ? 'absent' : JSON.stringify(v));

/** Phase 1 : vérifie modèle et manifeste, identifie la release, détecte la CI. */
export function evaluer(ctx) {
  const erreurs = [];
  const ref = estTable(ctx.m.modele) ? ctx.m.modele : {};
  if (ref.ref !== ctx.M.modele.id) erreurs.push(`modele.ref ${montrer(ref.ref)} ≠ ${montrer(ctx.M.modele.id)}`);
  if (String(ref.version) !== String(ctx.M.modele.version)) {
    erreurs.push(`version épinglée ${ref.version ?? 'absente'}, modèle fourni ${ctx.M.modele.version}`);
  }
  for (const champ of ctx.M.contrats.manifeste.obligatoires) {
    if (!champPresent(ctx.m, champ)) erreurs.push(`champ obligatoire absent : ${champ}`);
  }
  if (!['meta', 'instance'].includes(propre(ctx.m.instance, 'niveau'))) erreurs.push('instance.niveau doit valoir meta ou instance');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(ctx.instance) || ctx.instance.includes('..')) {
    erreurs.push(`instance.id doit être un nom simple (lettres, chiffres, . _ -, 64 au plus) : ${montrer(propre(ctx.m.instance, 'id'))}`);
  }
  const j = ctx.journalRelatif();
  if (j === '' || j === '..' || j.startsWith('../') || /^([A-Za-z]:|\/)/.test(j)) {
    erreurs.push(`journal doit être un sous-répertoire du dépôt : ${montrer(ctx.m.journal)} (contrats.manifeste.champs.journal)`);
  }
  const sha = lancer(['git', 'rev-parse', '--short=12', 'HEAD'], ctx.depot);
  if (sha.code !== 0) {
    erreurs.push('dépôt Git illisible : ' + extrait(sha.err));
  } else {
    const tag = lancer(['git', 'describe', '--tags', '--exact-match', 'HEAD'], ctx.depot);
    ctx.release = tag.code === 0 ? tag.out.trim() : sha.out.trim();
    const modifie = etatDuDepot(ctx.depot);
    if (modifie) ctx.remarques.push(remarqueDepotModifie(modifie.fichiers, modifie.droitsSeuls));
  }
  // Sans ces outils, une part des contrôles ne peut pas s'exécuter : une entrée
  // plafonnée faute d'outils serait fausse, et une fois close elle ne se réécrit plus.
  const manque = [];
  if (!ctx.outils.jq) manque.push("jq introuvable : les assertions ne peuvent pas s'évaluer");
  if (!ctx.outils.sh) manque.push("sh introuvable : les contrôles de commande ne peuvent pas s'exécuter");
  if (!ctx.outils.grep) manque.push("grep introuvable : les contrôles de motif ne peuvent pas s'exécuter");
  if (manque.length && ctx.plateforme === 'win32') {
    manque.push('Windows natif non pris en charge : lancer le résolveur sous WSL2 ou dans son image Docker (README)');
  }
  return [...erreurs, ...manque];
}

/** Chemins d'une sortie git status --porcelain -z ; d'un renommage, le nouveau chemin. */
function cheminsPorcelaine(sortie) {
  const champs = sortie.split('\0');
  const chemins = [];
  for (let i = 0; i < champs.length; i++) {
    const champ = champs[i];
    if (champ.length < 4) continue;
    chemins.push(champ.slice(3));
    if (/[RC]/.test(champ.slice(0, 2))) i++; // l'ancien chemin suit : on le saute
  }
  return chemins;
}

/**
 * Fichiers modifiés depuis le dernier commit (null si le dépôt est propre), et si
 * seuls leurs droits d'exécution diffèrent : cas d'une copie sur un disque sans bit
 * d'exécution (Windows), avec core.filemode à true.
 */
function etatDuDepot(depot) {
  const etat = lancer(['git', 'status', '--porcelain', '-z'], depot);
  if (etat.code !== 0 || !etat.out) return null;
  const fichiers = cheminsPorcelaine(etat.out);
  if (!fichiers.length) return null;
  const noms = (r) => new Set(r.code === 0 ? r.out.split('\0').filter(Boolean) : []);
  const changes = noms(lancer(['git', 'diff', 'HEAD', '--name-only', '-z'], depot));
  const contenus = noms(lancer(['git', '-c', 'core.filemode=false', 'diff', 'HEAD', '--name-only', '-z'], depot));
  return { fichiers, droitsSeuls: fichiers.every((f) => changes.has(f) && !contenus.has(f)) };
}

/** Remarque d'Évaluer sur un dépôt modifié : nombre, trois premiers fichiers, cause probable. */
export function remarqueDepotModifie(fichiers, droitsSeuls = false) {
  const n = fichiers.length;
  const liste = fichiers.slice(0, 3).join(', ') + (n > 3 ? ', …' : '');
  const cause = droitsSeuls ? " ; droits d'exécution seulement, voir core.filemode" : '';
  return `dépôt modifié depuis le dernier commit (${n} fichier${n > 1 ? 's' : ''} : ${liste}${cause}) : la release examinée n'est pas immuable`;
}

/** Phase 2 : ordonne les écarts du cycle précédent (prérequis d'abord, puis terme le plus faible). */
export function elaborer(ctx, precedent) {
  if (!precedent) return [];
  const prerequis = new Set(Object.values(ctx.M.boucle.phases).flatMap((d) => d.prerequis));
  // seuls les critères du modèle courant entrent au plan
  const ecarts = Object.entries(precedent.scores ?? {})
    .filter(([c, v]) => Object.hasOwn(ctx.termeDe, c) && v?.score !== null && v?.score !== undefined && v.score <= 1)
    .map(([c]) => c);
  const moyennes = Object.fromEntries(Object.entries(precedent.synthese ?? {}).map(([t, v]) => [t, v?.moyenne ?? 3]));
  const plan = ecarts.filter((c) => prerequis.has(c)).map((c) => ({ critere: c, raison: 'prerequis' }));
  const autres = ecarts
    .filter((c) => !prerequis.has(c))
    .sort((a, b) => comparer(moyennes[ctx.termeDe[a]] ?? 3, moyennes[ctx.termeDe[b]] ?? 3) || comparer(a, b));
  return [...plan, ...autres.map((c) => ({ critere: c, raison: 'terme le plus faible' }))];
}

/** Phase 5 : tendance, régressions rattachées à la release, viabilité. */
export function evoluer(ctx, entree, precedent, closes) {
  const tendance = {};
  const regressions = [];
  if (precedent) {
    // Les critères communs aux deux cycles, notés dans les deux (contrats.journal.cloture)
    const communs = Object.entries(entree.scores)
      .filter(([c, v]) => v.score !== null && typeof precedent.scores?.[c]?.score === 'number')
      .map(([c, v]) => [c, precedent.scores[c].score, v.score]);
    for (const t of Object.keys(entree.synthese)) {
      const du = communs.filter(([c]) => ctx.termeDe[c] === t);
      if (!du.length) continue;
      const moy = (i) => du.reduce((x, d) => x + d[i], 0) / du.length;
      tendance[t] = arrondi(moy(2) - moy(1), 2);
    }
    // Une baisse se rattache à la release examinée ; si la version du modèle a changé,
    // elle peut venir du modèle : sa version est citée (EV.2, cycle.phases.evoluer)
    const avant = precedent.cycle?.modele_version;
    const modeleChange = avant !== undefined && String(avant) !== String(ctx.M.modele.version);
    for (const [c, a, b] of communs) {
      if (b < a) regressions.push(modeleChange ? { critere: c, release: ctx.release, modele: String(ctx.M.modele.version) } : { critere: c, release: ctx.release });
    }
  }
  entree.tendance = tendance;
  entree.regressions = regressions;
  try {
    entree.viabilite = ctx.jq(ctx.M.finalite.viabilite.assertion, [...closes, entree]);
  } catch (e) {
    if (!(e instanceof ErreurControle)) throw e;
    entree.viabilite = null;
    ctx.remarques.push('viabilité non jugée : ' + e.message);
  }
}

/** Phase 7, part automatique : rétroaction déclarée, propositions sur les contrôles muets hors compose. */
export function equilibrer(ctx, entree, precedent = null) {
  const bloquee = entree.phases.equilibrer.statut === 'bloquee';
  const regles = new Map();
  for (const r of Array.isArray(ctx.m.retroaction) ? ctx.m.retroaction : []) {
    if (estTable(r)) regles.set(r.indicateur, r.correction);
  }
  // Critère de chaque indicateur : celui dont un contrôle métrique le mesure
  // (contrats.journal.champs.decisions.critere), avec le côté du seuil où il doit rester
  const critereDe = new Map();
  const comparaisonDe = new Map();
  for (const [cid, c] of ctx.criteres) {
    for (const k of c.controles) {
      if (k.type !== 'metrique' || critereDe.has(k.indicateur)) continue;
      critereDe.set(k.indicateur, cid);
      comparaisonDe.set(k.indicateur, k.comparaison ?? '<=');
    }
  }
  const decisions = [];
  for (const mes of entree.mesures) {
    if (!mes.hors_seuil) continue;
    const prevue = regles.get(mes.indicateur) ?? 'ticket';
    const correction = bloquee ? 'ticket' : prevue;
    // Le motif (contrats.journal.champs.decisions.motif) : la mesure et son seuil,
    // puis la correction remplacée quand Équilibrer est bloquée
    const unite = propre(propre(ctx.m.seuils, mes.indicateur), 'unite');
    const seuil = `${comparaisonDe.get(mes.indicateur) ?? '<='} ${formatG(mes.seuil)}${present(unite) ? ` ${texteDe(unite)}` : ''}`;
    let motif = `${mes.indicateur} = ${formatG(mes.valeur)}, hors seuil (${seuil})`;
    if (correction !== prevue) motif += ` ; Équilibrer bloquée : ticket au lieu de ${prevue}`;
    decisions.push({
      indicateur: mes.indicateur, critere: critereDe.get(mes.indicateur) ?? null,
      correction, reversible: true, cible: `ce qui fait dériver ${mes.indicateur}`, motif,
    });
  }
  const propositions = [];
  for (const [c, v] of Object.entries(entree.scores)) {
    if (v.controles.some((k) => k.cause === 'hors_compose')) {
      propositions.push({ critere: c, nature: 'controle', motif: 'contrôle prévu pour un projet compose, sans équivalent pour ce projet' });
    }
  }
  // Au rang méta, une baisse après une nouvelle version du modèle la remet en question
  // (cycle.phases.equilibrer : nature retour) ; la régression est déjà rattachée (EV.2).
  const versionAvant = precedent?.cycle?.modele_version;
  if (ctx.m.instance?.niveau === 'meta' && versionAvant !== undefined && String(versionAvant) !== String(ctx.M.modele.version)) {
    for (const r of entree.regressions ?? []) {
      const a = precedent.scores?.[r.critere]?.score;
      const b = entree.scores[r.critere]?.score;
      propositions.push({
        critere: r.critere, nature: 'retour',
        motif: `${r.critere} passe de ${a} à ${b} avec le modèle ${ctx.M.modele.version} (cycle précédent : ${versionAvant}) : revenir sur cette version, ou réviser le critère`,
      });
    }
  }
  entree.decisions = decisions;
  entree.seuils_revises = [];
  entree.propositions_modele = propositions;
}

// ── Demande et fichiers d'un cycle (contrats.journal.cycle) ─────────────────
const empreinteDe = (donnees) => createHash('sha256').update(donnees).digest('hex');
const TICKET_MAX = 100 * 1024 * 1024;

/** Empreinte d'un fichier, lue par blocs : aucune taille ne le charge en mémoire. */
function empreinteFichier(chemin) {
  const h = createHash('sha256');
  const tampon = Buffer.allocUnsafe(1 << 20);
  const fd = openSync(chemin, 'r');
  try {
    let n;
    while ((n = readSync(fd, tampon, 0, tampon.length, null)) > 0) h.update(tampon.subarray(0, n));
  } finally {
    closeSync(fd);
  }
  return h.digest('hex');
}

/**
 * Décode un en-tête MIME encodé (RFC 2047, =?jeu?B|Q?…?=). Les mots encodés
 * adjacents se joignent sans l'espace qui les sépare, octets mis bout à bout
 * avant le décodage : un caractère UTF-8 peut être coupé entre deux mots.
 */
export function decoderEntete(texte) {
  const RE = /=\?([^?]+)\?([BbQq])\?([^?]*)\?=/g;
  const octetsDe = (mode, contenu) => (mode.toUpperCase() === 'B' ? Buffer.from(contenu, 'base64')
    : Buffer.from(contenu.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (m, h) => String.fromCharCode(parseInt(h, 16))), 'latin1'));
  const decoder = (jeu, octets) => {
    try {
      return new TextDecoder(/^utf-?8$/i.test(jeu) ? 'utf-8' : jeu).decode(octets);
    } catch {
      return octets.toString('latin1');
    }
  };
  const t = String(texte);
  let sortie = '';
  let fin = 0;
  let lot = null; // { jeu, morceaux } : mots encodés adjacents de même jeu
  const vider = () => { if (lot) sortie += decoder(lot.jeu, Buffer.concat(lot.morceaux)); lot = null; };
  for (const m of t.matchAll(RE)) {
    const entre = t.slice(fin, m.index);
    if (lot && !/^\s*$/.test(entre)) vider();
    const [, jeu, mode, contenu] = m;
    const adjacent = lot !== null && /^\s*$/.test(entre); // l'espace entre deux mots encodés ne compte pas
    if (adjacent && lot.jeu.toLowerCase() === jeu.toLowerCase()) {
      lot.morceaux.push(octetsDe(mode, contenu));
    } else {
      vider();
      if (!adjacent) sortie += entre;
      lot = { jeu, morceaux: [octetsDe(mode, contenu)] };
    }
    fin = m.index + m[0].length;
  }
  vider();
  return (sortie + t.slice(fin)).trim();
}

/**
 * Lit le ticket d'une demande : un export MHTML (en-têtes MIME, multipart/related).
 * Rend { donnees, titre } ; refuse ce qui n'en est pas un.
 */
export function lireDemande(chemin) {
  if (!estFichier(chemin)) throw new Refus(`demande introuvable : ${chemin}`);
  const taille = statSync(chemin).size;
  if (taille > TICKET_MAX) throw new Refus(`${chemin} : ticket de ${taille} octets, ${TICKET_MAX} au plus`);
  const donnees = readFileSync(chemin);
  const tete = donnees.subarray(0, 65536).toString('latin1');
  const entetes = tete.split(/\r?\n\r?\n/)[0];
  if (!/^MIME-Version:/mi.test(entetes) || !/^Content-Type:\s*multipart\/related/mi.test(entetes)) {
    throw new Refus(`${chemin} : la demande doit être un ticket exporté en MHTML (MIME-Version, multipart/related)`);
  }
  const sujet = /^Subject:[ \t]*(.*(?:\r?\n[ \t].*)*)/mi.exec(entetes);
  const titre = sujet ? decoderEntete(Buffer.from(sujet[1].replace(/\r?\n[ \t]/g, ' '), 'latin1').toString('utf8')) : null;
  return { donnees, titre: titre || null };
}

/** Inventaire d'un fichier ou d'un répertoire : taille totale, nombre de fichiers, empreinte. */
export function inventaire(chemin) {
  const fichiers = [];
  const parcourir = (c, rel) => {
    const st = lstatSync(c);
    if (st.isDirectory()) {
      for (const n of readdirSync(c).sort()) parcourir(join(c, n), rel ? `${rel}/${n}` : n);
    } else if (st.isSymbolicLink()) {
      fichiers.push([rel, 0, empreinteDe('lien:' + readlinkSync(c))]);
    } else if (!st.isFile()) {
      // FIFO, socket, périphérique : nommé, jamais lu
    } else if (st.isFile()) {
      try {
        fichiers.push([rel, st.size, empreinteFichier(c)]);
      } catch (e) {
        illisibles.push(`${rel || '.'} (${e.code ?? e.message})`);
      }
    }
  };
  const illisibles = [];
  try {
    parcourir(chemin, '');
  } catch (e) {
    illisibles.push(`. (${e.code ?? e.message})`);
  }
  const h = createHash('sha256');
  for (const [rel, , e] of fichiers) h.update(`${rel}\0${e}\n`);
  const r = { octets: fichiers.reduce((t, [, o]) => t + o, 0), nombre: fichiers.length, empreinte: illisibles.length ? null : h.digest('hex') };
  if (illisibles.length) r.illisibles = illisibles.slice(0, 10);
  return r;
}

export function cycle(ctx, clore = false, demande = null) {
  const debut = maintenant();
  const erreurs = evaluer(ctx);
  if (erreurs.length) throw new Refus('Évaluer : ' + erreurs.join(' ; '));
  const entrees = ctx.journal();
  if (entrees.some(([, e]) => !e.cycle.fin)) throw new Refus("un cycle est déjà ouvert : clore l'entrée ouverte d'abord");
  ctx.numero = entrees.length;
  // Au rang instance, un cycle part d'une demande : le ticket Jira d'une évolution de
  // l'application, exporté en MHTML. Au rang méta, aucun ticket (cycle.phases.evaluer).
  const meta = propre(ctx.m.instance, 'niveau') === 'meta';
  if (!demande && !meta) throw new Refus('au rang instance, un cycle part d\'une demande : --demande <ticket Jira exporté en MHTML>');
  const ticket = demande ? lireDemande(resolve(demande)) : null;
  // Toutes les entrées closes se comparent ; d'un contrat à l'autre, sur les critères
  // communs (contrats.journal.cloture) : l'évolution peut remettre en question le modèle.
  const comparables = ctx.journalClos();
  const precedent = comparables.length ? comparables[comparables.length - 1] : null;
  const numero = String(ctx.numero).padStart(4, '0');
  const chemin = join(ctx.journalDir(), `${numero}.yaml`);
  if (existsSync(chemin)) throw new Refus(`${chemin} existe déjà : une entrée n'est jamais réécrite`);
  const dossierCycle = join(ctx.journalDir(), numero);
  // Sans son entrée, le répertoire est celui d'un cycle interrompu : mis de côté, jamais effacé
  if (existsSync(dossierCycle)) {
    if (!lstatSync(dossierCycle).isDirectory()) throw new Refus(`${dossierCycle} existe et n'est pas un répertoire : le cycle ne peut pas y ranger ses fichiers`);
    const abandon = `${dossierCycle}.abandon-${maintenant().replace(/[-:]/g, '')}`;
    renameSync(dossierCycle, abandon);
    ctx.remarques.push(`répertoire d'un cycle interrompu mis de côté : ${relative(ctx.depot, abandon)}`);
  }
  mkdirSync(join(dossierCycle, 'temp'), { recursive: true });
  // le répertoire du cycle (ticket, temp) est conservé, jamais versionné : il s'ignore
  // lui-même, quel que soit le dépôt (contrats.journal.cycle)
  writeFileSync(join(dossierCycle, '.gitignore'), '*\n');
  if (ticket) writeFileSync(join(dossierCycle, 'jira.mhtml'), ticket.donnees, { flag: 'wx' });
  ctx.temp = join(dossierCycle, 'temp');
  log('info', 'cycle_ouvert', { cycle: ctx.cycleId, release: ctx.release, en_ci: ctx.enCi });

  const plan = elaborer(ctx, precedent);
  const scores = examiner(ctx);
  const phases = Object.fromEntries(PHASES.map((ph) => [ph, { statut: 'executee' }]));
  Object.assign(phases, bloquer(ctx, scores));
  const entree = {
    cycle: {
      id: ctx.cycleId, numero: ctx.numero, instance: ctx.instance,
      niveau: ctx.m.instance.niveau, modele_version: String(ctx.M.modele.version),
      contrat_version: ctx.contratVersion, en_ci: ctx.enCi, debut, fin: null,
    },
    release: ctx.release,
    demande: ticket ? { lien: `${numero}/jira.mhtml`, titre: ticket.titre, octets: ticket.donnees.length, empreinte: empreinteDe(ticket.donnees) } : null,
    fichiers: [],
    plan,
    phases,
    scores,
    synthese: synthese(ctx, scores),
    mesures: ctx.mesures,
    incidents: [],
    remarques: ctx.remarques,
    outils: ctx.outils,
  };
  evoluer(ctx, entree, precedent, comparables);
  equilibrer(ctx, entree, precedent);
  // Ce que les contrôles ont laissé dans le temp du cycle, cité par lien (regles.fichiers_temporaires)
  entree.fichiers = readdirSync(ctx.temp).sort().map((n) => ({ lien: `${numero}/temp/${n}`, ...inventaire(join(ctx.temp, n)) }));
  if (clore) entree.cycle.fin = maintenant();
  const d = ctx.journalDir();
  mkdirSync(d, { recursive: true });
  ecrire(chemin, entree, true);
  log('info', 'cycle_ecrit', { cycle: ctx.cycleId, fichier: relative(ctx.depot, chemin), close: clore });
  return [chemin, entree];
}

/**
 * YAML lisible à l'identique en 1.1 et en 1.2 : les textes qu'un lecteur 1.1
 * prendrait pour une date ou un booléen restent entre guillemets.
 */
function ecrire(chemin, entree, nouvelle = false) {
  const entete = '# Entrée de journal du modèle exécutif 12 facteurs × 7E (contrats.journal)\n'
    + "# Écrite par resolveur7e.mjs ; close, elle n'est plus réécrite.\n";
  const corps = stringify(entree, { version: '1.1', lineWidth: 100, indentSeq: false, singleQuote: true });
  writeFileSync(chemin, entete + corps, { encoding: 'utf8', flag: nouvelle ? 'wx' : 'w' });
}

function entreeOuverte(ctx) {
  const ouvertes = ctx.journal().filter(([, e]) => !e.cycle.fin);
  if (!ouvertes.length) throw new Refus('aucune entrée ouverte');
  return ouvertes[ouvertes.length - 1];
}

// ── Affichage ────────────────────────────────────────────────────────────────
function fmt(n) {
  return n === null || n === undefined ? '—' : fixe(n, 2).replace('.', ',');
}

const ouiNon = (v) => (v === null || v === undefined ? '—' : v ? 'oui' : 'non');

function ligneTerme(t, v) {
  return `${NOMS_TERMES[t].padEnd(15)}${fmt(v.moyenne).padStart(8)}   ${v.ecarts.join(' ') || '—'}`;
}

function resume(ctx, chemin, e) {
  const c = e.cycle;
  const lignes = [
    `Cycle ${c.id} · modèle ${c.modele_version} · release ${e.release} · `
      + `${c.en_ci ? 'en CI' : 'hors CI'} · entrée ${c.fin ? 'close' : 'ouverte'}`,
    '', `${'Terme'.padEnd(15)}${'Moyenne'.padStart(8)}   Écarts`,
  ];
  for (const [t, v] of Object.entries(e.synthese)) lignes.push(ligneTerme(t, v));
  lignes.push('', `Demande : ${e.demande ? e.demande.titre ?? e.demande.lien : 'aucune (rang méta)'}`);
  const bloquees = Object.entries(e.phases)
    .filter(([, v]) => v.statut === 'bloquee')
    .map(([p, v]) => `${NOMS_PHASES[p]} (${v.cause.join(', ')})`);
  lignes.push('', 'Phases bloquées : ' + (bloquees.join(', ') || 'aucune'));
  const v = e.viabilite;
  lignes.push('Viabilité : ' + (v === null || v === undefined ? 'premier cycle comparable, pas de jugement'
    : v.progresse ? 'viable et en progrès' : v.viable ? 'viable, sans progrès' : 'non viable'));
  const sans = Object.values(e.scores).filter((s) => s.score === null);
  lignes.push(`Sans objet : ${sans.length} critère(s)`);
  const causes = new Map();
  for (const [cid, s] of Object.entries(e.scores)) {
    for (const k of s.controles) {
      if (!k.cause) continue;
      if (!causes.has(k.cause)) causes.set(k.cause, new Set());
      causes.get(k.cause).add(cid);
    }
  }
  for (const [cause, cids] of [...causes].sort(([a], [b]) => comparer(a, b))) {
    lignes.push(`Contrôles en erreur (${cause}) : ${[...cids].sort().join(', ')}`);
  }
  if (e.propositions_modele.length) lignes.push('Propositions au modèle : ' + e.propositions_modele.map((p) => p.critere).join(', '));
  for (const r of e.remarques ?? []) lignes.push('Remarque : ' + r);
  if (e.fichiers?.length) lignes.push(`Fichiers temporaires cités : ${e.fichiers.length}`);
  lignes.push(`Entrée : ${relative(ctx.depot, chemin)}`);
  console.log(lignes.join('\n'));
}

// ── Ligne de commande ────────────────────────────────────────────────────────
export function contexte() {
  const depot = resolve(process.env.DEPOT_7E || '.');
  const modele = resolve(process.env.MODELE_7E || join(depot, 'modele-executif-12f-7e.yaml'));
  const manifeste = resolve(process.env.MANIFESTE_7E || join(depot, '7e-instance.yaml'));
  for (const p of [modele, manifeste]) if (!estFichier(p)) throw new Refus(`fichier introuvable : ${p}`);
  delaiControle();
  return new Contexte(depot, modele, manifeste);
}

const USAGE = `usage : resolveur7e <commande> [options]

Résolveur du modèle exécutif 12 facteurs × 7E.

  valider                     Évaluer seul : modèle, manifeste, release, CI, outils
  examiner                    Évaluer puis Examiner, sans écrire de journal
  cycle [--demande <ticket.mhtml>] [--clore]
                              cycle complet ; au rang instance, lancé par une demande
                              (ticket Jira exporté en MHTML) ; l'entrée reste ouverte,
                              sauf avec --clore
  proposer --critere <id> --nature <${NATURES.join('|')}> --motif <texte>
                              ajoute une proposition au modèle dans l'entrée ouverte
  clore                       clôt l'entrée ouverte ; close, elle n'est plus réécrite
  historique                  liste les entrées closes du journal

Variables : DEPOT_7E, MODELE_7E, MANIFESTE_7E, DELAI_CONTROLE_7E (voir .env.example).
`;

const OPTIONS = {
  valider: {}, examiner: {}, clore: {}, historique: {},
  cycle: { clore: { type: 'boolean', default: false }, demande: { type: 'string' } },
  proposer: { critere: { type: 'string' }, nature: { type: 'string' }, motif: { type: 'string' } },
};

function usage(message) {
  process.stderr.write(`${USAGE}\nresolveur7e : ${message}\n`);
  return 2;
}

export function main(argv = process.argv.slice(2)) {
  const [commande, ...reste] = argv;
  if (commande === '-h' || commande === '--help') {
    process.stdout.write(USAGE);
    return 0;
  }
  if (!Object.hasOwn(OPTIONS, commande ?? '')) return usage(commande ? `commande inconnue : ${commande}` : 'commande attendue');
  let a;
  try {
    a = parseArgs({ args: reste, options: { ...OPTIONS[commande], help: { type: 'boolean', short: 'h' } }, strict: true }).values;
  } catch (e) {
    return usage(`${commande} : ${e.message}`);
  }
  if (a.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (commande === 'proposer') {
    const manquants = ['critere', 'nature', 'motif'].filter((k) => a[k] === undefined);
    if (manquants.length) return usage(`proposer : options requises : ${manquants.map((k) => '--' + k).join(', ')}`);
    if (!NATURES.includes(a.nature)) return usage(`proposer : --nature vaut ${NATURES.join(', ')}`);
  }
  try {
    const ctx = contexte();
    if (commande === 'valider') {
      const erreurs = evaluer(ctx);
      console.log(`Modèle ${ctx.M.modele.version} · instance ${ctx.instance} · release ${ctx.release} · ${ctx.enCi ? 'en CI' : 'hors CI'}`);
      console.log('Outils : ' + Object.entries(ctx.outils).map(([o, v]) => `${o} ${v ? 'oui' : 'non'}`).join(', '));
      for (const r of ctx.remarques) console.log('Remarque : ' + r);
      if (erreurs.length) throw new Refus('Évaluer : ' + erreurs.join(' ; '));
      console.log('Manifeste valide.');
    } else if (commande === 'examiner') {
      const erreurs = evaluer(ctx);
      if (erreurs.length) throw new Refus('Évaluer : ' + erreurs.join(' ; '));
      let scores;
      ctx.temp = mkdtempSync(join(tmpdir(), 'r7e-temp-'));
      try {
        scores = examiner(ctx);
      } finally {
        if (ctx.temp) rmSync(ctx.temp, { recursive: true, force: true }); // hors cycle, rien n'est cité
      }
      const phases = bloquer(ctx, scores);
      for (const [t, v] of Object.entries(synthese(ctx, scores))) console.log(ligneTerme(t, v));
      const bloquees = Object.entries(phases).filter(([, v]) => v.statut === 'bloquee').map(([p]) => NOMS_PHASES[p]);
      console.log('Phases bloquées : ' + (bloquees.join(', ') || 'aucune'));
    } else if (commande === 'cycle') {
      const [chemin, e] = cycle(ctx, a.clore, a.demande ?? null);
      resume(ctx, chemin, e);
    } else if (commande === 'proposer') {
      const [chemin, e] = entreeOuverte(ctx);
      if (!Object.hasOwn(ctx.termeDe, a.critere)) throw new Refus(`critère inconnu : ${a.critere}`);
      if (a.nature === 'retour' && propre(ctx.m.instance, 'niveau') !== 'meta') throw new Refus('la nature retour revient sur une version du modèle : rang méta seulement');
      (e.propositions_modele ??= []).push({ critere: a.critere, nature: a.nature, motif: a.motif });
      ecrire(chemin, e);
      log('info', 'proposition', { critere: a.critere, nature: a.nature });
      console.log(`Proposition ajoutée à ${relative(ctx.depot, chemin)}`);
    } else if (commande === 'clore') {
      const [chemin, e] = entreeOuverte(ctx);
      e.cycle.fin = maintenant();
      ecrire(chemin, e);
      log('info', 'cycle_clos', { cycle: e.cycle.id });
      console.log(`Entrée close : ${relative(ctx.depot, chemin)}`);
    } else if (commande === 'historique') {
      for (const e of ctx.journalClos()) {
        const moy = Object.values(e.synthese ?? {}).map((x) => x?.moyenne).filter((m) => m !== null && m !== undefined);
        console.log(`${e.cycle.id}  ${e.cycle.fin}  release ${e.release}  `
          + `moyenne ${fmt(moy.length ? moy.reduce((x, y) => x + y, 0) / moy.length : null)}  viable ${ouiNon(e.viabilite?.viable)}`);
      }
    }
    return 0;
  } catch (e) {
    if (!(e instanceof Refus)) throw e;
    log('erreur', 'refus', { motif: e.message });
    process.stderr.write(`Refus : ${e.message}\n`);
    return 1;
  }
}

// ── Surface de test ──────────────────────────────────────────────────────────
// Fonctions internes exposées aux seuls tests (tests/test_resolveur7e.mjs) :
// elles ne font pas partie du contrat du résolveur et peuvent changer sans
// préavis. La ligne de commande et les exports nommés ci-dessus font foi.
export const interne = Object.freeze({
  ChampAbsent, HorsCompose, OUTILS, NATURES, USAGE,
  decimalExact, arrondiPair, versFlottant, lignesDe, texteDe, texteAssertion,
  delaiControle, lancer, shell, trouver, estTable, valeur, lireYaml, cheminsPorcelaine, etatDuDepot,
  grepListe, executerUnitaire, elements, sansCompose, ecrire, entreeOuverte, fmt, ouiNon,
});

function estPrincipal() {
  try {
    return Boolean(process.argv[1]) && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (estPrincipal()) process.exitCode = main();
