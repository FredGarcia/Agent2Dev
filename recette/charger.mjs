/**
 * Chargement d'une campagne : des enregistrements (rapporteur node:test et
 * tests définis en base) aux tables recette.test, operation, execution et
 * resultat, en quatre requêtes ensemblistes, dans la transaction de l'appelant.
 *
 * Chaque table reçoit un seul paramètre jsonb déplié par jsonb_to_recordset,
 * assaini (jsonPourPg : ni NUL ni moitié de paire de substitution) :
 * quelques centaines de tests à seize opérations font quelques milliers de
 * lignes, chargées d'un tenant, sans boucle de requêtes.
 *
 * Catalogue des opérations des tests de fichier : les étapes vues y sont
 * ajoutées ou renommées à chaque exécution ; celles qui n'existent plus n'en
 * sont retirées qu'après une exécution réussie (un test arrêté à sa 3e étape ne
 * dit rien des suivantes).
 */

import { jsonPourPg } from './base.mjs';

const STATUTS_EXECUTES = new Set(['reussi', 'echoue', 'erreur', 'a_faire']);

/** Totaux d'une liste d'enregistrements de test. */
export function totaux(enregistrements) {
  const tests = enregistrements.filter((e) => e.type === 'test');
  const compter = (s) => tests.filter((t) => t.statut === s).length;
  return {
    tests: tests.length,
    reussis: compter('reussi'),
    echoues: compter('echoue'),
    erreurs: compter('erreur'),
    omis: compter('omis'),
    a_faire: compter('a_faire'),
    operations: tests.reduce((n, t) => n + (t.etapes?.length ?? 0), 0),
    base: tests.filter((t) => t.origine === 'base').length,
  };
}

/**
 * Charge les enregistrements d'une campagne. `client` est dans une transaction
 * ouverte par l'appelant. Rend { tests, executions, resultats, operations }.
 */
export async function charger(client, campagneId, enregistrements) {
  const tests = enregistrements.filter((e) => e.type === 'test');
  const deFichier = tests.filter((t) => t.origine !== 'base');
  const deBase = tests.filter((t) => t.origine === 'base');

  // 1. Tests de fichier : création ou mise à jour du catalogue
  const ids = new Map();
  if (deFichier.length) {
    const { rows } = await client.query(
      `INSERT INTO recette.test (origine, fichier, nom_complet, suite, libelle, vu_le)
       SELECT 'fichier', t.fichier, t.nom_complet, t.suite, t.libelle, now()
       FROM jsonb_to_recordset($1::jsonb) AS t(fichier text, nom_complet text, suite text, libelle text)
       ON CONFLICT ON CONSTRAINT test_unique
       DO UPDATE SET suite = EXCLUDED.suite, libelle = EXCLUDED.libelle, vu_le = now()
       RETURNING id, fichier, nom_complet`,
      [jsonPourPg(deFichier.map(({ fichier, nom_complet, suite, libelle }) => ({ fichier, nom_complet, suite, libelle })))],
    );
    for (const r of rows) ids.set(`${r.fichier}\u0000${r.nom_complet}`, r.id);
  }
  const idDe = (t) => (t.origine === 'base' ? t.test_id : ids.get(`${t.fichier}\u0000${t.nom_complet}`));
  if (deBase.length) {
    await client.query('UPDATE recette.test SET vu_le = now() WHERE id = ANY($1::bigint[])', [deBase.map((t) => t.test_id)]);
  }

  // 2. Catalogue des étapes des tests de fichier exécutés
  const etapes = deFichier
    .filter((t) => STATUTS_EXECUTES.has(t.statut))
    .flatMap((t) => (t.etapes ?? []).map((e) => ({ test_id: idDe(t), ordre: e.ordre, libelle: String(e.libelle).slice(0, 500) || '(sans libellé)' })));
  let operations = 0;
  if (etapes.length) {
    const lot = jsonPourPg(etapes);
    const maj = await client.query(
      `UPDATE recette.operation o SET libelle = e.libelle
       FROM jsonb_to_recordset($1::jsonb) AS e(test_id bigint, ordre smallint, libelle text)
       WHERE o.test_id = e.test_id AND o.ordre = e.ordre AND o.libelle IS DISTINCT FROM e.libelle`,
      [lot],
    );
    const ajout = await client.query(
      `INSERT INTO recette.operation (test_id, ordre, libelle, nature)
       SELECT e.test_id, e.ordre, e.libelle, 'etape'
       FROM jsonb_to_recordset($1::jsonb) AS e(test_id bigint, ordre smallint, libelle text)
       WHERE NOT EXISTS (SELECT 1 FROM recette.operation o WHERE o.test_id = e.test_id AND o.ordre = e.ordre)`,
      [lot],
    );
    operations = maj.rowCount + ajout.rowCount;
  }
  const reussis = deFichier.filter((t) => t.statut === 'reussi').map((t) => ({ test_id: idDe(t), n: t.etapes?.length ?? 0 }));
  if (reussis.length) {
    await client.query(
      `DELETE FROM recette.operation o
       USING jsonb_to_recordset($1::jsonb) AS r(test_id bigint, n integer)
       WHERE o.test_id = r.test_id AND o.nature = 'etape' AND o.ordre > r.n`,
      [jsonPourPg(reussis)],
    );
  }

  // 3. Exécutions
  const executions = new Map();
  if (tests.length) {
    const { rows } = await client.query(
      `INSERT INTO recette.execution (campagne_id, test_id, statut, motif, duree_ms)
       SELECT $1, e.test_id, e.statut, e.motif, e.duree_ms
       FROM jsonb_to_recordset($2::jsonb) AS e(test_id bigint, statut text, motif text, duree_ms numeric)
       RETURNING id, test_id`,
      [campagneId, jsonPourPg(tests.map((t) => ({ test_id: idDe(t), statut: t.statut, motif: t.motif ?? null, duree_ms: t.duree_ms ?? null })))],
    );
    for (const r of rows) executions.set(String(r.test_id), r.id);
  }

  // 4. Résultats des opérations, reliés au catalogue
  const resultats = tests.flatMap((t) => (t.etapes ?? []).map((e) => ({
    execution_id: executions.get(String(idDe(t))),
    test_id: idDe(t),
    ordre: e.ordre,
    libelle: String(e.libelle ?? '').slice(0, 500) || '(sans libellé)',
    statut: e.statut,
    // Une valeur JSON null devient NULL en base : « attendu null » et « sans attendu » se confondent
    entree: e.entree ?? null,
    attendu: e.attendu ?? null,
    obtenu: e.obtenu ?? null,
    message: e.message ?? null,
    duree_ms: e.duree_ms ?? null,
  })));
  if (resultats.length) {
    await client.query(
      `INSERT INTO recette.resultat (execution_id, ordre, operation_id, libelle, statut, entree, attendu, obtenu, message, duree_ms)
       SELECT r.execution_id, r.ordre, o.id, r.libelle, r.statut, r.entree, r.attendu, r.obtenu, r.message, r.duree_ms
       FROM jsonb_to_recordset($1::jsonb)
            AS r(execution_id bigint, test_id bigint, ordre smallint, libelle text, statut text,
                 entree jsonb, attendu jsonb, obtenu jsonb, message text, duree_ms numeric)
       LEFT JOIN recette.operation o ON o.test_id = r.test_id AND o.ordre = r.ordre`,
      [jsonPourPg(resultats)],
    );
  }
  return { tests: tests.length, executions: executions.size, resultats: resultats.length, operations };
}
