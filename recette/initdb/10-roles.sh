#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
#  10-roles.sh : rôles de la base de recette (premier démarrage de PostgreSQL)
# ═══════════════════════════════════════════════════════════════════════════
#
#  Exécuté une seule fois par l'image officielle postgres, à l'initialisation
#  du volume (docker-entrypoint-initdb.d), en superutilisateur. Il crée :
#
#    recette          propriétaire des schémas recette et donnees, sans aucun
#                     privilège d'administration : le lanceur et l'interface
#                     se connectent avec lui, et appliquent les migrations ;
#    recette_lecture  lecture seule, à délai court : les requêtes SQL des tests
#                     définis en base (et l'essai d'une requête dans
#                     l'interface) s'exécutent sous ce rôle, jamais sous l'autre.
#
#  Les mots de passe viennent de l'environnement du conteneur (.env.recette,
#  écrit par vm/preparer-vm.sh) ; ils passent à psql en variables, jamais dans
#  le texte d'une commande.

set -eu

: "${RECETTE_MOT_DE_PASSE:?mot de passe du rôle recette absent}"
: "${RECETTE_LECTURE_MOT_DE_PASSE:?mot de passe du rôle recette_lecture absent}"

psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER}" --dbname "${POSTGRES_DB}" \
  -v base="${POSTGRES_DB}" \
  -v mdp="${RECETTE_MOT_DE_PASSE}" \
  -v mdp_lecture="${RECETTE_LECTURE_MOT_DE_PASSE}" <<'SQL'
CREATE ROLE recette LOGIN PASSWORD :'mdp' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
CREATE ROLE recette_lecture LOGIN PASSWORD :'mdp_lecture' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;

-- recette crée ses schémas ; recette_lecture ne fait que se connecter et lire
GRANT CONNECT, CREATE, TEMPORARY ON DATABASE :"base" TO recette;
REVOKE ALL ON DATABASE :"base" FROM PUBLIC;
GRANT CONNECT ON DATABASE :"base" TO recette_lecture;

-- Lecture seule et délai court, quoi que demande la session
ALTER ROLE recette_lecture SET default_transaction_read_only = on;
ALTER ROLE recette_lecture SET statement_timeout = '5s';
ALTER ROLE recette_lecture SET idle_in_transaction_session_timeout = '30s';
ALTER ROLE recette_lecture SET search_path = donnees, recette;
SQL
