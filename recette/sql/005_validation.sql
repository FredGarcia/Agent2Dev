-- ═══════════════════════════════════════════════════════════════════════════
--  005_validation.sql : la validation finale d'une release (mesure 10.2)
-- ═══════════════════════════════════════════════════════════════════════════
--
--  Depuis le modèle 0.5.0, une release atteint la production quand une
--  personne la valide dans l'interface (bouton « Validation finale »). Le délai
--  commit → production de 10.2 va du commit de la release à cette validation ;
--  le manifeste du méta-projet la lit par « node recette/lancer.mjs validation ».
--
--  Une release ne se valide qu'une fois par file ; une validation de la file
--  principale n'est jamais modifiée ni supprimée. Comme pour les demandes, la
--  recette éprouve l'interface dans une file à elle, qu'elle nettoie.

CREATE TABLE pilotage.validation (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  file         text NOT NULL DEFAULT 'principale' CHECK (file ~ '^[a-z0-9-]{1,40}$'),
  release      text NOT NULL CHECK (release ~ '^[A-Za-z0-9][A-Za-z0-9._/-]{0,99}$' AND release !~ '\.\.'),
  valide_par   text NOT NULL CHECK (length(valide_par) BETWEEN 1 AND 200),
  valide_le    timestamptz NOT NULL DEFAULT now(),
  commentaire  text CHECK (commentaire IS NULL OR (length(commentaire) BETWEEN 1 AND 500 AND commentaire !~ '[[:cntrl:]]')),
  UNIQUE (file, release)
);
COMMENT ON TABLE pilotage.validation IS 'Validation finale d''une release par une personne : sa mise en production (10.2)';

CREATE FUNCTION pilotage.validation_immuable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND OLD.file <> 'principale' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'une validation finale n''est jamais modifiée ni supprimée';
END
$$;
CREATE TRIGGER validation_immuable BEFORE UPDATE OR DELETE ON pilotage.validation
  FOR EACH ROW EXECUTE FUNCTION pilotage.validation_immuable();

-- TRUNCATE ne passe pas par les lignes : refusé dès qu'une validation principale existe
CREATE FUNCTION pilotage.validation_sans_vidage() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM pilotage.validation WHERE file = 'principale') THEN
    RAISE EXCEPTION 'une validation finale n''est jamais modifiée ni supprimée (TRUNCATE refusé)';
  END IF;
  RETURN NULL;
END
$$;
CREATE TRIGGER validation_sans_vidage BEFORE TRUNCATE ON pilotage.validation
  FOR EACH STATEMENT EXECUTE FUNCTION pilotage.validation_sans_vidage();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'recette_lecture') THEN
    GRANT SELECT ON pilotage.validation TO recette_lecture;
  END IF;
END
$$;
