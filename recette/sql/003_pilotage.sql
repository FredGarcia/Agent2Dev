-- ═══════════════════════════════════════════════════════════════════════════
--  003_pilotage.sql : workflows, déclencheurs, demandes d'exécution
-- ═══════════════════════════════════════════════════════════════════════════
--
--  L'interface reflète les workflows des projets et en déclenche certains.
--
--    Catalogue   recette/workflows.yaml et les workflows de CI du dépôt
--                (.gitea/workflows/*.yml) sont chargés comme documents, avec
--                le modèle, les manifestes et le journal (natures workflows, ci).
--    Demandes    l'interface dépose une demande ; l'exécuteur
--                (recette/executeur.mjs), qui tient le socket Docker que
--                l'interface n'a jamais, la réclame, l'exécute sur une copie
--                fraîche du dépôt et la clôt avec sa sortie et son résultat.
--    Exécuteurs  chaque exécuteur se signale à intervalle fixe : l'interface
--                sait si une demande sera prise.
--
--  La base garde les invariants : une action de la liste blanche, des
--  paramètres conformes à l'action, un état cohérent avec ses horodatages, une
--  seule demande en attente ou en cours par action et par file.
--
--  Une file sépare des exécuteurs qui partagent la base : l'interface dépose dans
--  la file « principale », que sert l'exécuteur de la pile ; la recette éprouve
--  l'exécuteur dans une file à elle, sans voler ni bloquer les vraies demandes.

CREATE SCHEMA IF NOT EXISTS pilotage;
COMMENT ON SCHEMA pilotage IS 'Pilotage : demandes d''exécution déposées par l''interface, exécuteurs';

-- ── Les documents chargés : le catalogue des workflows et les workflows de CI ─
DO $$
DECLARE
  c text;
BEGIN
  FOR c IN
    SELECT conname FROM pg_constraint
    WHERE conrelid = 'donnees.document'::regclass AND contype = 'c' AND pg_get_constraintdef(oid) LIKE '%nature%'
  LOOP
    EXECUTE format('ALTER TABLE donnees.document DROP CONSTRAINT %I', c);
  END LOOP;
END
$$;
ALTER TABLE donnees.document ADD CONSTRAINT document_nature
  CHECK (nature IN ('modele', 'manifeste', 'journal', 'workflows', 'ci'));

-- ── Paramètres permis, par action ───────────────────────────────────────────
--   campagne  { "libelle": texte de 1 à 200 caractères, sans caractère de contrôle }
--   valider, cycle, charger : aucun paramètre
CREATE FUNCTION pilotage.parametres_valides(a text, p jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof(p) = 'object' AND CASE a
    WHEN 'campagne' THEN
      coalesce((SELECT array_agg(k ORDER BY k) FROM jsonb_object_keys(p) AS k) = ARRAY['libelle'], false)
      AND jsonb_typeof(p -> 'libelle') = 'string'
      AND length(p ->> 'libelle') BETWEEN 1 AND 200
      AND (p ->> 'libelle') !~ '[[:cntrl:]]'
    ELSE p = '{}'::jsonb
  END
$$;
COMMENT ON FUNCTION pilotage.parametres_valides(text, jsonb) IS 'Vrai si les paramètres conviennent à l''action (liste blanche de recette/pilotage.mjs)';

-- ── Demandes ────────────────────────────────────────────────────────────────
CREATE TABLE pilotage.demande (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file         text NOT NULL DEFAULT 'principale' CHECK (file ~ '^[a-z0-9-]{1,40}$'),
  action       text NOT NULL CHECK (action IN ('campagne', 'valider', 'cycle', 'charger')),
  parametres   jsonb NOT NULL DEFAULT '{}'::jsonb,
  demandeur    text NOT NULL CHECK (length(demandeur) BETWEEN 1 AND 200),
  demandee_le  timestamptz NOT NULL DEFAULT now(),
  statut       text NOT NULL DEFAULT 'en_attente'
               CHECK (statut IN ('en_attente', 'en_cours', 'reussie', 'echouee', 'annulee', 'interrompue')),
  executeur    text,             -- l'exécuteur qui l'a réclamée
  debut        timestamptz,
  fin          timestamptz,
  arret_le     timestamptz,      -- arrêt demandé pendant l'exécution
  code_retour  integer,
  sortie       text NOT NULL DEFAULT '',   -- la fin de la sortie, secrets masqués
  campagne_id  bigint REFERENCES recette.campagne (id) ON DELETE SET NULL,
  resultat     jsonb,            -- résumé propre à l'action (entrée du cycle à blanc…)
  CONSTRAINT demande_parametres CHECK (pilotage.parametres_valides(action, parametres)),
  CONSTRAINT demande_etat CHECK (CASE statut
    WHEN 'en_attente' THEN debut IS NULL AND fin IS NULL
    WHEN 'annulee'    THEN debut IS NULL AND fin IS NOT NULL AND fin >= demandee_le
    WHEN 'en_cours'   THEN debut IS NOT NULL AND fin IS NULL AND executeur IS NOT NULL
    ELSE debut IS NOT NULL AND fin IS NOT NULL AND fin >= debut AND executeur IS NOT NULL
  END),
  CONSTRAINT demande_debut CHECK (debut IS NULL OR debut >= demandee_le),
  CONSTRAINT demande_arret CHECK (arret_le IS NULL OR debut IS NOT NULL),
  CONSTRAINT demande_sortie CHECK (length(sortie) <= 70000)
);
COMMENT ON TABLE pilotage.demande IS 'Une demande d''exécution : déposée par l''interface, réclamée et close par l''exécuteur';

-- Une seule demande en attente ou en cours par action et par file : pas de file qui enfle
CREATE UNIQUE INDEX demande_une_par_action ON pilotage.demande (file, action) WHERE statut IN ('en_attente', 'en_cours');
CREATE INDEX demande_en_attente ON pilotage.demande (file, id) WHERE statut = 'en_attente';
CREATE INDEX demande_par_campagne ON pilotage.demande (campagne_id) WHERE campagne_id IS NOT NULL;

-- L'exécuteur écoute : une demande déposée ou un arrêt demandé le réveille
CREATE FUNCTION pilotage.signaler_demande() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM pg_notify('pilotage_demande', NEW.id::text);
  RETURN NEW;
END
$$;
CREATE TRIGGER demande_signalee AFTER INSERT OR UPDATE OF arret_le ON pilotage.demande
  FOR EACH ROW EXECUTE FUNCTION pilotage.signaler_demande();

-- ── Exécuteurs ──────────────────────────────────────────────────────────────
CREATE TABLE pilotage.executeur (
  nom          text PRIMARY KEY CHECK (length(nom) BETWEEN 1 AND 200),
  file         text NOT NULL DEFAULT 'principale' CHECK (file ~ '^[a-z0-9-]{1,40}$'),
  demarre_le   timestamptz NOT NULL DEFAULT now(),
  vu_le        timestamptz NOT NULL DEFAULT now(),
  docker_demon boolean,
  demande_id   bigint REFERENCES pilotage.demande (id) ON DELETE SET NULL
);
COMMENT ON TABLE pilotage.executeur IS 'Les exécuteurs : chacun met à jour vu_le à intervalle fixe';

-- ── Vues de lecture ─────────────────────────────────────────────────────────
CREATE VIEW pilotage.v_demande AS
SELECT d.id, d.file, d.action, d.parametres, d.demandeur, d.demandee_le, d.statut, d.executeur, d.debut, d.fin,
       d.arret_le, d.code_retour, d.campagne_id, d.resultat, length(d.sortie) AS taille_sortie,
       extract(epoch FROM (coalesce(d.debut, d.fin, now()) - d.demandee_le)) AS attente_s,
       CASE WHEN d.debut IS NOT NULL THEN extract(epoch FROM (coalesce(d.fin, now()) - d.debut)) END AS duree_s
FROM pilotage.demande d;

CREATE VIEW pilotage.v_executeur AS
SELECT e.*, e.vu_le > now() - interval '30 seconds' AS actif,
       extract(epoch FROM (now() - e.vu_le)) AS silence_s
FROM pilotage.executeur e;

-- ── Droits du rôle de lecture ───────────────────────────────────────────────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recette_lecture') THEN
    GRANT USAGE ON SCHEMA pilotage TO recette_lecture;
    GRANT SELECT ON ALL TABLES IN SCHEMA pilotage TO recette_lecture;
    GRANT EXECUTE ON FUNCTION pilotage.parametres_valides(text, jsonb) TO recette_lecture;
    ALTER DEFAULT PRIVILEGES IN SCHEMA pilotage GRANT SELECT ON TABLES TO recette_lecture;
  END IF;
END
$$;
