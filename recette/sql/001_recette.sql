-- ═══════════════════════════════════════════════════════════════════════════
--  001_recette.sql : campagnes, tests, opérations, exécutions, résultats
-- ═══════════════════════════════════════════════════════════════════════════
--
--  Une campagne exécute des tests ; chaque test porte une liste ordonnée
--  d'opérations, seize au plus (capacité visée : 16 opérations, requêtes SQL
--  comprises, pour quelques centaines de tests).
--
--  Deux origines de test :
--    fichier  les suites node:test du dépôt (tests/test_*.mjs). Leurs opérations
--             sont les étapes que le code déclare (tests/outils/etapes.mjs) :
--             la base en tient le catalogue, mis à jour à chaque campagne.
--    base     les tests définis ici même, édités dans l'interface et exécutés
--             par le lanceur : opérations SQL (en lecture seule) ou appels de
--             fonctions de la liste blanche (recette/definis.mjs).
--
--  Les seize opérations sont garanties par la base elle-même : rang de 1 à 16
--  et unicité du rang dans le test. Le code échoue plus tôt (17e étape refusée),
--  la base reste la dernière garde.
--
--  Appliquée par recette/base.mjs (migrer), qui tient recette.migration.

CREATE SCHEMA IF NOT EXISTS recette;
COMMENT ON SCHEMA recette IS 'Recette du méta-projet 12 facteurs × 7E : campagnes, tests, opérations, résultats';

-- ── Campagnes ───────────────────────────────────────────────────────────────
CREATE TABLE recette.campagne (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  libelle        text NOT NULL CHECK (length(libelle) BETWEEN 1 AND 200),
  debut          timestamptz NOT NULL DEFAULT now(),
  fin            timestamptz,
  statut         text NOT NULL DEFAULT 'en_cours'
                 CHECK (statut IN ('en_cours', 'reussie', 'echouee', 'interrompue')),
  release        text,          -- commit du dépôt examiné (12 caractères)
  modele_version text,
  machine        text,
  node_version   text,
  docker_demon   boolean,
  fichiers       text[] NOT NULL DEFAULT '{}',
  totaux         jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT campagne_fin CHECK (fin IS NULL OR fin >= debut),
  CONSTRAINT campagne_close CHECK ((statut = 'en_cours') = (fin IS NULL))
);
COMMENT ON TABLE recette.campagne IS 'Une exécution de la recette : suites node:test et tests définis en base';

-- ── Tests ───────────────────────────────────────────────────────────────────
CREATE TABLE recette.test (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  origine      text NOT NULL CHECK (origine IN ('fichier', 'base')),
  fichier      text,           -- suite node:test ; NULL pour un test défini en base
  nom_complet  text NOT NULL CHECK (length(nom_complet) BETWEEN 1 AND 1000),
  libelle      text NOT NULL CHECK (length(libelle) BETWEEN 1 AND 500),
  suite        text,           -- suites englobantes, « A > B »
  description  text,
  actif        boolean NOT NULL DEFAULT true,
  cree_le      timestamptz NOT NULL DEFAULT now(),
  modifie_le   timestamptz NOT NULL DEFAULT now(),
  vu_le        timestamptz,    -- dernière exécution enregistrée
  CONSTRAINT test_fichier CHECK ((origine = 'fichier') = (fichier IS NOT NULL)),
  CONSTRAINT test_unique UNIQUE NULLS NOT DISTINCT (origine, fichier, nom_complet)
);
COMMENT ON TABLE recette.test IS 'Catalogue des tests : suites du dépôt (fichier) et tests définis en base (base)';

-- ── Opérations : seize au plus par test ─────────────────────────────────────
CREATE TABLE recette.operation (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  test_id     bigint NOT NULL REFERENCES recette.test (id) ON DELETE CASCADE,
  ordre       smallint NOT NULL CHECK (ordre BETWEEN 1 AND 16),
  libelle     text NOT NULL CHECK (length(libelle) BETWEEN 1 AND 500),
  nature      text NOT NULL CHECK (nature IN ('etape', 'sql', 'fonction')),
  requete     text,            -- sql : une seule instruction, exécutée en lecture seule
  fonction    text,            -- fonction : un nom de la liste blanche du lanceur
  arguments   jsonb,           -- fonction : la liste de ses arguments
  comparaison text NOT NULL DEFAULT 'egal'
              CHECK (comparaison IN ('egal', 'contient', 'nombre_lignes', 'vide', 'non_vide', 'tolerance')),
  attendu     jsonb,
  tolerance   numeric CHECK (tolerance IS NULL OR tolerance >= 0),
  modifie_le  timestamptz NOT NULL DEFAULT now(),
  -- Différable : déplacer ou renuméroter des opérations se fait en une instruction
  CONSTRAINT operation_ordre UNIQUE (test_id, ordre) DEFERRABLE INITIALLY IMMEDIATE,
  CONSTRAINT operation_requete CHECK ((nature = 'sql') = (requete IS NOT NULL)),
  CONSTRAINT operation_fonction CHECK ((nature = 'fonction') = (fonction IS NOT NULL)),
  CONSTRAINT operation_arguments CHECK (arguments IS NULL OR jsonb_typeof(arguments) = 'array'),
  CONSTRAINT operation_tolerance CHECK ((comparaison = 'tolerance') = (tolerance IS NOT NULL)),
  CONSTRAINT operation_attendu CHECK (nature = 'etape' OR comparaison IN ('vide', 'non_vide') OR attendu IS NOT NULL)
);
COMMENT ON TABLE recette.operation IS 'Opérations d''un test, 16 au plus : étapes du code, requêtes SQL ou appels de fonction';

-- Une étape n'appartient qu'à un test de fichier ; une requête ou un appel,
-- qu'à un test défini en base.
CREATE FUNCTION recette.verifier_operation() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  o text;
BEGIN
  SELECT origine INTO o FROM recette.test WHERE id = NEW.test_id;
  IF (o = 'fichier') <> (NEW.nature = 'etape') THEN
    RAISE EXCEPTION 'opération % pour un test d''origine % : %', NEW.nature, o,
      CASE WHEN o = 'fichier' THEN 'un test de fichier ne porte que des étapes'
           ELSE 'un test défini en base ne porte que des requêtes SQL ou des appels de fonction' END
      USING ERRCODE = 'check_violation';
  END IF;
  NEW.modifie_le := now();
  RETURN NEW;
END
$$;
CREATE TRIGGER operation_verifiee BEFORE INSERT OR UPDATE ON recette.operation
  FOR EACH ROW EXECUTE FUNCTION recette.verifier_operation();

-- ── Exécutions et résultats ─────────────────────────────────────────────────
CREATE TABLE recette.execution (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  campagne_id bigint NOT NULL REFERENCES recette.campagne (id) ON DELETE CASCADE,
  test_id     bigint NOT NULL REFERENCES recette.test (id) ON DELETE CASCADE,
  statut      text NOT NULL CHECK (statut IN ('reussi', 'echoue', 'erreur', 'omis', 'a_faire')),
  motif       text,            -- raison d'omission ou « à faire », message d'échec
  duree_ms    numeric CHECK (duree_ms IS NULL OR duree_ms >= 0),
  CONSTRAINT execution_unique UNIQUE (campagne_id, test_id)
);
CREATE INDEX execution_par_test ON recette.execution (test_id, campagne_id DESC);
COMMENT ON TABLE recette.execution IS 'Le résultat d''un test dans une campagne';

CREATE TABLE recette.resultat (
  execution_id bigint NOT NULL REFERENCES recette.execution (id) ON DELETE CASCADE,
  ordre        smallint NOT NULL CHECK (ordre BETWEEN 1 AND 16),
  operation_id bigint REFERENCES recette.operation (id) ON DELETE SET NULL,
  libelle      text NOT NULL,
  statut       text NOT NULL CHECK (statut IN ('reussie', 'echouee', 'erreur')),
  entree       jsonb,
  attendu      jsonb,
  obtenu       jsonb,
  message      text,
  duree_ms     numeric,
  PRIMARY KEY (execution_id, ordre)
);
CREATE INDEX resultat_par_operation ON recette.resultat (operation_id);
COMMENT ON TABLE recette.resultat IS 'Le résultat de chaque opération d''une exécution (16 au plus)';

-- ── Vues de lecture ─────────────────────────────────────────────────────────
CREATE VIEW recette.v_campagne AS
SELECT c.id, c.libelle, c.debut, c.fin, c.statut, c.release, c.modele_version, c.machine,
       c.node_version, c.docker_demon, c.fichiers,
       extract(epoch FROM (coalesce(c.fin, now()) - c.debut)) AS duree_s,
       count(e.id) AS tests,
       count(e.id) FILTER (WHERE e.statut = 'reussi') AS reussis,
       count(e.id) FILTER (WHERE e.statut = 'echoue') AS echoues,
       count(e.id) FILTER (WHERE e.statut = 'erreur') AS erreurs,
       count(e.id) FILTER (WHERE e.statut = 'omis') AS omis,
       count(e.id) FILTER (WHERE e.statut = 'a_faire') AS a_faire,
       coalesce(sum(r.operations), 0)::bigint AS operations,
       coalesce(sum(r.en_echec), 0)::bigint AS operations_en_echec
FROM recette.campagne c
LEFT JOIN recette.execution e ON e.campagne_id = c.id
LEFT JOIN LATERAL (
  SELECT count(*) AS operations, count(*) FILTER (WHERE x.statut <> 'reussie') AS en_echec
  FROM recette.resultat x WHERE x.execution_id = e.id
) r ON true
GROUP BY c.id;

CREATE VIEW recette.v_execution AS
SELECT e.id, e.campagne_id, e.test_id, t.origine, t.fichier, t.nom_complet, t.suite, t.libelle,
       e.statut, e.motif, e.duree_ms,
       (SELECT count(*) FROM recette.resultat r WHERE r.execution_id = e.id) AS operations,
       (SELECT count(*) FROM recette.resultat r WHERE r.execution_id = e.id AND r.statut <> 'reussie') AS operations_en_echec
FROM recette.execution e
JOIN recette.test t ON t.id = e.test_id;

CREATE VIEW recette.v_test AS
SELECT t.*,
       (SELECT count(*) FROM recette.operation o WHERE o.test_id = t.id) AS operations,
       d.campagne_id AS derniere_campagne, d.statut AS dernier_statut
FROM recette.test t
LEFT JOIN LATERAL (
  SELECT e.campagne_id, e.statut FROM recette.execution e
  WHERE e.test_id = t.id ORDER BY e.campagne_id DESC LIMIT 1
) d ON true;

-- Comparaison de deux campagnes, test par test
CREATE FUNCTION recette.comparer(a bigint, b bigint)
RETURNS TABLE (test_id bigint, origine text, fichier text, nom_complet text,
               statut_a text, statut_b text, changement text)
LANGUAGE sql STABLE AS $$
  SELECT t.id, t.origine, t.fichier, t.nom_complet, ea.statut, eb.statut,
         CASE
           WHEN ea.statut IS NULL THEN 'nouveau'
           WHEN eb.statut IS NULL THEN 'disparu'
           WHEN ea.statut = 'reussi' AND eb.statut IN ('echoue', 'erreur') THEN 'regression'
           WHEN ea.statut IN ('echoue', 'erreur') AND eb.statut = 'reussi' THEN 'correction'
           WHEN ea.statut <> eb.statut THEN 'changement'
           ELSE 'identique'
         END
  FROM (SELECT * FROM recette.execution WHERE campagne_id = a) ea
  FULL JOIN (SELECT * FROM recette.execution WHERE campagne_id = b) eb ON eb.test_id = ea.test_id
  JOIN recette.test t ON t.id = coalesce(ea.test_id, eb.test_id)
$$;
COMMENT ON FUNCTION recette.comparer(bigint, bigint) IS 'Régressions, corrections, changements, nouveaux et disparus entre deux campagnes';
