/**
 * Accès à la base de recette : connexions, conversions, migrations.
 *
 * Deux connexions, deux rôles (recette/initdb/10-roles.sh) :
 *   RECETTE_PG_URL          rôle recette, propriétaire des schémas : le lanceur
 *                           et l'interface écrivent avec lui ;
 *   RECETTE_PG_LECTURE_URL  rôle recette_lecture, lecture seule et délai court :
 *                           les requêtes des tests définis en base passent par lui.
 * Sans URL de lecture, les requêtes passent par le rôle principal, toujours en
 * transaction en lecture seule : la garde est plus faible, et le dit (avertissement).
 *
 * Conversions : les entiers 64 bits et les numériques reviennent en nombres
 * JavaScript quand c'est exact, les dates et horodatages en texte ISO tel que
 * PostgreSQL l'écrit : les valeurs comparées par les tests restent du JSON simple.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

export const RACINE = join(dirname(fileURLToPath(import.meta.url)), '..');
export const REPERTOIRE_SQL = join(RACINE, 'recette', 'sql');

/** Verrou consultatif des migrations : deux processus ne migrent jamais ensemble. */
const VERROU_MIGRATION = 7_277_712;

const OID = { ENTIER8: 20, NUMERIQUE: 1700, DATE: 1082, HORODATAGE: 1114, HORODATAGE_TZ: 1184 };
const texteBrut = (v) => v;

/** Conversions propres à la recette, par connexion (sans toucher aux réglages globaux de pg). */
export const TYPES = {
  getTypeParser(oid, format) {
    if (format === 'binary') return pg.types.getTypeParser(oid, format);
    if (oid === OID.ENTIER8) return (v) => { const n = Number(v); return Number.isSafeInteger(n) ? n : v; };
    if (oid === OID.NUMERIQUE) return (v) => { const n = Number(v); return Number.isFinite(n) ? n : v; };
    if (oid === OID.DATE || oid === OID.HORODATAGE || oid === OID.HORODATAGE_TZ) return texteBrut;
    return pg.types.getTypeParser(oid, format);
  },
};

/** Masque le mot de passe d'une URL de connexion, pour les messages. */
export function urlMasquee(url) {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return '(URL illisible)';
  }
}

/**
 * Les deux pools. Rend { principal, lecture, lectureDediee } ; lève si
 * RECETTE_PG_URL manque. `application_name` permet de suivre la recette dans
 * pg_stat_activity.
 */
export function ouvrir({ url = process.env.RECETTE_PG_URL, urlLecture = process.env.RECETTE_PG_LECTURE_URL, nom = 'recette-7e' } = {}) {
  if (!url) throw new Error('RECETTE_PG_URL absente : la base de recette est injoignable (voir .env.recette.example)');
  // Sans JIT : il ne paie jamais ici (requêtes courtes, vues qui déplient du JSON),
  // et sur une base neuve, sans statistiques, les estimations le déclenchent avec
  // inlining : plus d'une seconde de compilation LLVM à froid, au lieu d'une
  // milliseconde. Un test défini en base y a dépassé son délai de 5 s.
  const options = '-c jit=off';
  const principal = new pg.Pool({ connectionString: url, types: TYPES, max: 6, application_name: nom, options });
  const lecture = urlLecture
    ? new pg.Pool({ connectionString: urlLecture, types: TYPES, max: 4, application_name: `${nom}-lecture`, options })
    : principal;
  // Une connexion perdue au repos ne doit pas tuer le processus
  for (const pool of new Set([principal, lecture])) pool.on('error', (e) => process.stderr.write(`recette : connexion PostgreSQL perdue : ${e.message}\n`));
  return { principal, lecture, lectureDediee: Boolean(urlLecture) };
}

/** Ferme les pools ouverts par ouvrir(). */
export async function fermer({ principal, lecture }) {
  await Promise.all([...new Set([principal, lecture])].map((p) => p.end()));
}

/** Exécute fn(client) dans une transaction ; annule sur erreur. */
export async function enTransaction(pool, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const r = await fn(client);
    await client.query('COMMIT');
    return r;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export const empreinte = (texte) => createHash('sha256').update(texte).digest('hex');

/**
 * Texte acceptable par PostgreSQL : jsonb et text refusent le caractère NUL
 * et les moitiés de paire de substitution (qu'une troncature en unités UTF-16
 * peut laisser). Les deux deviennent U+FFFD, sans faire échouer un chargement.
 */
export const textePropre = (s) => String(s).toWellFormed().replaceAll('\u0000', '�');

/** Applique textePropre à tous les textes d'une valeur JSON, clés comprises. */
export function assainir(v) {
  if (typeof v === 'string') return textePropre(v);
  if (Array.isArray(v)) return v.map(assainir);
  if (v !== null && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [textePropre(k), assainir(x)]));
  return v;
}

/** JSON prêt pour un paramètre jsonb. */
export const jsonPourPg = (v) => JSON.stringify(assainir(v));

/** Les migrations du dépôt, dans l'ordre : NNN_nom.sql. */
export function migrationsDisponibles(repertoire = REPERTOIRE_SQL) {
  return readdirSync(repertoire)
    .filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f))
    .sort()
    .map((fichier) => {
      const sql = readFileSync(join(repertoire, fichier), 'utf8');
      return { version: Number(fichier.slice(0, 3)), nom: fichier, sql, empreinte: empreinte(sql) };
    });
}

/**
 * Applique les migrations manquantes, chacune dans sa transaction, sous verrou
 * consultatif. Une migration déjà appliquée dont le fichier a changé arrête
 * tout : on n'édite pas l'histoire d'une base, on ajoute une migration.
 * Rend la liste des migrations appliquées par cet appel.
 */
export async function migrer(pool, repertoire = REPERTOIRE_SQL) {
  const client = await pool.connect();
  const appliquees = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [VERROU_MIGRATION]);
    await client.query(`
      CREATE SCHEMA IF NOT EXISTS recette;
      CREATE TABLE IF NOT EXISTS recette.migration (
        version     integer PRIMARY KEY,
        nom         text NOT NULL,
        empreinte   text NOT NULL,
        appliquee_le timestamptz NOT NULL DEFAULT now()
      )`);
    const deja = new Map((await client.query('SELECT version, nom, empreinte, appliquee_le FROM recette.migration')).rows.map((r) => [r.version, r]));
    for (const m of migrationsDisponibles(repertoire)) {
      const d = deja.get(m.version);
      if (d) {
        if (d.empreinte !== m.empreinte) {
          throw new Error(`migration ${m.nom} modifiée depuis son application (${d.appliquee_le ?? 'date inconnue'}) : ajouter une migration plutôt que réécrire celle-ci`);
        }
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(m.sql);
        await client.query('INSERT INTO recette.migration (version, nom, empreinte) VALUES ($1, $2, $3)', [m.version, m.nom, m.empreinte]);
        await client.query('COMMIT');
        appliquees.push(m.nom);
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`migration ${m.nom} : ${e.message}`);
      }
    }
    return appliquees;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [VERROU_MIGRATION]).catch(() => {});
    client.release();
  }
}

/** Vrai si la base répond (pour les tests et /sante). */
export async function joignable(pool) {
  try {
    await pool.query('SELECT 1');
    return true;
  } catch {
    return false;
  }
}
