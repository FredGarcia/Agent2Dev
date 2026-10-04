#!/usr/bin/env bash
# Point d'entrée unique vers Docker Compose : un projet par environnement (10.1).
# usage : scripts/compose.sh dev|prod <arguments de docker compose>
#   dev  : compose.yaml + compose.override.yaml, image construite depuis les sources
#   prod : compose.yaml + compose.prod.yaml, image publiée ; tag lu dans .7e/etat/prod.tag
#          (écrit par deploy.sh) ou imposé par DEPLOY_TAG
set -euo pipefail
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"

env="${1:-}"
env_valide "$env"
shift
cd "$RACINE"

case "$env" in
  dev)
    fichiers=(-f compose.yaml -f compose.override.yaml) ;;
  prod)
    fichiers=(-f compose.yaml -f compose.prod.yaml)
    # Toujours la release en service, jamais un APP_TAG resté dans .env.prod (5.2).
    APP_TAG="${DEPLOY_TAG:-$(etat_lire prod.tag || true)}"
    export APP_TAG ;;
esac

exec docker compose -p "$(projet "$env")" --env-file ".env.$env" "${fichiers[@]}" "$@"
