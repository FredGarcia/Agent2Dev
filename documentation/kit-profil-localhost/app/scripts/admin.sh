#!/usr/bin/env bash
# Tâche ponctuelle lancée depuis la release et la config de l'environnement (12.1),
# tracée dans la mémoire avec son auteur et son code de sortie (12.2).
# usage : scripts/admin.sh dev|prod <type ou commande>     ex. : scripts/admin.sh prod migrate
set -euo pipefail
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"
need docker git jq

env="${1:-}"
env_valide "$env"
shift
[[ $# -gt 0 ]] || die "commande attendue, par exemple : migrate"
cd "$RACINE"

if [[ "$env" == prod ]]; then
  release="$(etat_lire prod.tag || true)"
  [[ -n "$release" ]] || die "aucune release en service : déployer d'abord (scripts/deploy.sh)"
else
  release="dev"
fi

# Sans terminal (timer, CI), pas de pseudo-TTY : sinon « the input device is not a TTY ».
tty=()
[[ -t 0 && -t 1 ]] || tty=(-T)
debut=$(date +%s)
code=0
compose "$env" run --rm "${tty[@]}" web "$@" || code=$?
memoire_evenement "$env" "$(jq -nc --arg cmd "$*" --arg r "$release" --argjson code "$code" \
  --argjson d "$(( $(date +%s) - debut ))" --arg par "$(git config user.email || echo inconnu)" \
  '{type: "admin", commande: $cmd, release: $r, code: $code, duree_s: $d, par: $par}')"
exit "$code"
