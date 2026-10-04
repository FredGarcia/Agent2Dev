-- ═══════════════════════════════════════════════════════════════════════════
--  002_donnees.sql : les fichiers YAML du dépôt, chargés en tables
-- ═══════════════════════════════════════════════════════════════════════════
--
--  À chaque campagne, le lanceur recharge ici le modèle, les manifestes et les
--  entrées de journal (recette/documents.mjs), lus en YAML 1.2 puis rangés en
--  jsonb. Les vues les déplient en lignes : les tests définis en base les
--  interrogent en SQL (contrôles croisés du modèle, du manifeste et du journal).
--
--  Seul l'état courant est gardé : l'historique des fichiers est celui de Git,
--  et chaque document dit quelle campagne l'a chargé.
--
--  Les vues ne lèvent jamais sur une donnée mal formée : une valeur du mauvais
--  type y devient NULL, que les tests SQL savent chercher.

CREATE SCHEMA IF NOT EXISTS donnees;
COMMENT ON SCHEMA donnees IS 'Fichiers YAML du dépôt (modèle, manifestes, journal), chargés à chaque campagne';

CREATE TABLE donnees.document (
  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  nature      text NOT NULL CHECK (nature IN ('modele', 'manifeste', 'journal')),
  chemin      text NOT NULL UNIQUE,     -- relatif à la racine du dépôt
  contenu     jsonb NOT NULL,           -- { "erreur": … } si le YAML est illisible
  empreinte   text NOT NULL,            -- sha256 du texte
  campagne_id bigint REFERENCES recette.campagne (id) ON DELETE SET NULL,
  charge_le   timestamptz NOT NULL DEFAULT now()
);

-- ── Conversions sûres ───────────────────────────────────────────────────────
CREATE FUNCTION donnees.nombre(v jsonb) RETURNS numeric
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(v) = 'number' THEN (v #>> '{}')::numeric END
$$;

CREATE FUNCTION donnees.entier(v jsonb) RETURNS integer
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(v) = 'number' AND (v #>> '{}') ~ '^-?\d{1,9}$' THEN (v #>> '{}')::integer END
$$;

CREATE FUNCTION donnees.booleen(v jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(v) = 'boolean' THEN (v #>> '{}')::boolean END
$$;

CREATE FUNCTION donnees.horodatage(v jsonb) RETURNS timestamptz
LANGUAGE sql STABLE AS $$
  SELECT CASE WHEN jsonb_typeof(v) = 'string' AND pg_input_is_valid(v #>> '{}', 'timestamptz')
              THEN (v #>> '{}')::timestamptz END
$$;

CREATE FUNCTION donnees.liste(v jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(v) = 'array' THEN v ELSE '[]'::jsonb END
$$;

CREATE FUNCTION donnees.table_(v jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN jsonb_typeof(v) = 'object' THEN v ELSE '{}'::jsonb END
$$;

-- Arrondi au pair, sur la valeur décimale exacte : celui du résolveur (et de
-- round() de Python). round() de PostgreSQL arrondit les égalités loin de zéro :
-- 1,125 y donne 1,13, le journal 1,12.
CREATE FUNCTION donnees.arrondi_pair(x numeric, n integer DEFAULT 2) RETURNS numeric
LANGUAGE sql IMMUTABLE STRICT AS $$
  SELECT CASE
    WHEN abs(x * power(10::numeric, n) - trunc(x * power(10::numeric, n))) = 0.5
      THEN round(2 * round(x * power(10::numeric, n) / 2) / power(10::numeric, n), n)
    ELSE round(x, n)
  END
$$;
COMMENT ON FUNCTION donnees.arrondi_pair(numeric, integer) IS 'Arrondi au pair (half-even) : la règle des moyennes du journal';

-- ── Le modèle ───────────────────────────────────────────────────────────────
CREATE VIEW donnees.modele AS
SELECT d.contenu #>> '{modele,id}' AS id, d.contenu #>> '{modele,version}' AS version,
       d.contenu #>> '{modele,statut}' AS statut, d.contenu #>> '{modele,date}' AS date,
       d.chemin, d.contenu
FROM donnees.document d WHERE d.nature = 'modele';

CREATE VIEW donnees.terme AS
SELECT t.v ->> 'id' AS id, t.v ->> 'nom' AS nom, t.rang::integer AS rang, t.v ->> 'sens' AS sens
FROM donnees.modele m, jsonb_array_elements(donnees.liste(m.contenu -> 'termes')) WITH ORDINALITY AS t(v, rang);

CREATE VIEW donnees.facteur AS
SELECT donnees.entier(f.v -> 'n') AS n, f.v ->> 'nom' AS nom, t.v ->> 'id' AS terme
FROM donnees.modele m,
     jsonb_array_elements(donnees.liste(m.contenu -> 'termes')) AS t(v),
     jsonb_array_elements(donnees.liste(t.v -> 'facteurs')) AS f(v);

-- Les 35 critères, dans l'ordre du modèle : ceux des termes, puis le second ordre
CREATE VIEW donnees.critere_brut AS
SELECT c.v ->> 'id' AS id, t.v ->> 'id' AS terme, t.rang * 100 + c.rang AS ordre, c.v AS critere
FROM donnees.modele m,
     jsonb_array_elements(donnees.liste(m.contenu -> 'termes')) WITH ORDINALITY AS t(v, rang),
     jsonb_array_elements(donnees.liste(t.v -> 'criteres')) WITH ORDINALITY AS c(v, rang)
UNION ALL
SELECT c.v ->> 'id', 'second_ordre', 10000 + c.rang, c.v
FROM donnees.modele m,
     jsonb_array_elements(donnees.liste(m.contenu #> '{second_ordre,criteres}')) WITH ORDINALITY AS c(v, rang);

CREATE VIEW donnees.critere AS
SELECT id, terme, ordre, donnees.entier(critere -> 'facteur') AS facteur, critere ->> 'phase' AS phase,
       critere ->> 'enonce' AS enonce, critere ->> 'preuve_attendue' AS preuve_attendue,
       jsonb_array_length(donnees.liste(critere -> 'controles')) AS nb_controles
FROM donnees.critere_brut;

CREATE VIEW donnees.controle AS
SELECT cb.id AS critere, k.rang::integer AS rang, k.v ->> 'type' AS type,
       coalesce(donnees.booleen(k.v -> 'heuristique'), false) AS heuristique, k.v AS parametres
FROM donnees.critere_brut cb,
     jsonb_array_elements(donnees.liste(cb.critere -> 'controles')) WITH ORDINALITY AS k(v, rang);

CREATE VIEW donnees.type_controle AS
SELECT t.key AS type, t.value AS definition
FROM donnees.modele m, jsonb_each(donnees.table_(m.contenu #> '{types_de_controle,types}')) AS t;

CREATE VIEW donnees.prerequis AS
SELECT p.key AS phase, r.v AS critere, r.rang::integer AS rang
FROM donnees.modele m,
     jsonb_each(donnees.table_(m.contenu #> '{boucle,phases}')) AS p,
     jsonb_array_elements_text(donnees.liste(p.value -> 'prerequis')) WITH ORDINALITY AS r(v, rang);

-- ── Les manifestes ──────────────────────────────────────────────────────────
CREATE VIEW donnees.manifeste AS
SELECT d.chemin, d.contenu #>> '{instance,id}' AS instance, d.contenu #>> '{instance,niveau}' AS niveau,
       d.contenu #>> '{modele,ref}' AS modele_ref, d.contenu #>> '{modele,version}' AS version_epinglee,
       d.contenu ->> 'journal' AS journal, d.contenu
FROM donnees.document d WHERE d.nature = 'manifeste';

CREATE VIEW donnees.seuil AS
SELECT m.instance, s.key AS indicateur, donnees.nombre(s.value -> 'valeur') AS valeur, s.value ->> 'unite' AS unite
FROM donnees.manifeste m, jsonb_each(donnees.table_(m.contenu -> 'seuils')) AS s;

CREATE VIEW donnees.retroaction AS
SELECT m.instance, r.v ->> 'indicateur' AS indicateur, r.v ->> 'correction' AS correction, r.rang::integer AS rang
FROM donnees.manifeste m, jsonb_array_elements(donnees.liste(m.contenu -> 'retroaction')) WITH ORDINALITY AS r(v, rang);

CREATE VIEW donnees.sans_objet AS
SELECT m.instance, s.key AS critere, s.value #>> '{}' AS justification
FROM donnees.manifeste m, jsonb_each(donnees.table_(m.contenu -> 'sans_objet')) AS s;

-- ── Le journal ──────────────────────────────────────────────────────────────
CREATE VIEW donnees.entree AS
SELECT d.chemin, d.contenu #>> '{cycle,instance}' AS instance, donnees.entier(d.contenu #> '{cycle,numero}') AS numero,
       d.contenu #>> '{cycle,id}' AS id, d.contenu #>> '{cycle,niveau}' AS niveau,
       d.contenu #>> '{cycle,modele_version}' AS modele_version, d.contenu #>> '{cycle,contrat_version}' AS contrat_version,
       donnees.booleen(d.contenu #> '{cycle,en_ci}') AS en_ci,
       donnees.horodatage(d.contenu #> '{cycle,debut}') AS debut, donnees.horodatage(d.contenu #> '{cycle,fin}') AS fin,
       d.contenu ->> 'release' AS release, d.contenu
FROM donnees.document d WHERE d.nature = 'journal';

CREATE VIEW donnees.score AS
SELECT e.instance, e.numero, s.key AS critere, donnees.entier(s.value -> 'score') AS score,
       s.value ->> 'constat' AS constat, jsonb_array_length(donnees.liste(s.value -> 'controles')) AS nb_controles
FROM donnees.entree e, jsonb_each(donnees.table_(e.contenu -> 'scores')) AS s;

CREATE VIEW donnees.controle_consigne AS
SELECT e.instance, e.numero, s.key AS critere, k.rang::integer AS rang, k.v ->> 'type' AS type,
       k.v ->> 'resultat' AS resultat, k.v ->> 'cause' AS cause,
       coalesce(donnees.booleen(k.v -> 'heuristique'), false) AS heuristique, k.v ->> 'constat' AS constat
FROM donnees.entree e,
     jsonb_each(donnees.table_(e.contenu -> 'scores')) AS s,
     jsonb_array_elements(donnees.liste(s.value -> 'controles')) WITH ORDINALITY AS k(v, rang);

CREATE VIEW donnees.synthese AS
SELECT e.instance, e.numero, t.key AS terme, donnees.nombre(t.value -> 'moyenne') AS moyenne,
       ARRAY(SELECT jsonb_array_elements_text(donnees.liste(t.value -> 'ecarts'))) AS ecarts
FROM donnees.entree e, jsonb_each(donnees.table_(e.contenu -> 'synthese')) AS t;

CREATE VIEW donnees.phase AS
SELECT e.instance, e.numero, p.key AS phase, p.value ->> 'statut' AS statut,
       ARRAY(SELECT jsonb_array_elements_text(donnees.liste(p.value -> 'cause'))) AS cause
FROM donnees.entree e, jsonb_each(donnees.table_(e.contenu -> 'phases')) AS p;

CREATE VIEW donnees.mesure AS
SELECT e.instance, e.numero, m.v ->> 'indicateur' AS indicateur, donnees.nombre(m.v -> 'valeur') AS valeur,
       donnees.nombre(m.v -> 'seuil') AS seuil, donnees.booleen(m.v -> 'hors_seuil') AS hors_seuil
FROM donnees.entree e, jsonb_array_elements(donnees.liste(e.contenu -> 'mesures')) AS m(v);

CREATE VIEW donnees.decision AS
SELECT e.instance, e.numero, d.rang::integer AS rang, d.v ->> 'indicateur' AS indicateur, d.v ->> 'critere' AS critere,
       d.v ->> 'correction' AS correction, donnees.booleen(d.v -> 'reversible') AS reversible, d.v ->> 'cible' AS cible
FROM donnees.entree e, jsonb_array_elements(donnees.liste(e.contenu -> 'decisions')) WITH ORDINALITY AS d(v, rang);

CREATE VIEW donnees.proposition AS
SELECT e.instance, e.numero, p.rang::integer AS rang, p.v ->> 'critere' AS critere, p.v ->> 'nature' AS nature, p.v ->> 'motif' AS motif
FROM donnees.entree e, jsonb_array_elements(donnees.liste(e.contenu -> 'propositions_modele')) WITH ORDINALITY AS p(v, rang);

-- ── Droits du rôle de lecture (tests SQL définis en base) ───────────────────
-- Le rôle recette_lecture est créé à l'initialisation de la base
-- (recette/initdb/10-roles.sh) ; sans lui, la migration n'accorde rien.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recette_lecture') THEN
    GRANT USAGE ON SCHEMA recette, donnees TO recette_lecture;
    GRANT SELECT ON ALL TABLES IN SCHEMA recette, donnees TO recette_lecture;
    GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA donnees TO recette_lecture;
    GRANT EXECUTE ON FUNCTION recette.comparer(bigint, bigint) TO recette_lecture;
    ALTER DEFAULT PRIVILEGES IN SCHEMA recette, donnees GRANT SELECT ON TABLES TO recette_lecture;
  END IF;
END
$$;
