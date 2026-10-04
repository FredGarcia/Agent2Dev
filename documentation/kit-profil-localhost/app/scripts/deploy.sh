#!/usr/bin/env bash
# Déploie une release publiée dans la prod locale ; si elle n'atteint pas l'état sain,
# revient à la précédente (règle R1 : 5.3, EQ.1). Chaque issue est tracée (EV.1, 10.2).
# usage : scripts/deploy.sh <commit>      (complet ou abrégé, publié par la CI)
set -euo pipefail
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"
need docker git jq
cd "$RACINE"

[[ $# -eq 1 ]] || die "usage : scripts/deploy.sh <commit>"
sha="$(git rev-parse --verify --quiet "$1^{commit}")" || die "commit inconnu du dépôt : $1 (git fetch ?)"
precedent="$(etat_lire prod.tag || true)"
attente="${DEPLOY_TIMEOUT:-180}"

if [[ "$sha" == "$precedent" ]]; then
  info "release $sha déjà en service"
  exit 0
fi

image="$(image_app "$sha")"
info "récupération de $image"
docker pull -q "$image" >/dev/null || die "release absente du registre : $image (publiée par la CI ?)"

debut=$(date +%s)
if DEPLOY_TAG="$sha" compose prod up -d --wait --wait-timeout "$attente" --remove-orphans; then
  duree=$(( $(date +%s) - debut ))
  etat_ecrire prod.tag "$sha"
  memoire_evenement prod "$(jq -nc --arg c "$sha" --arg p "$precedent" --argjson d "$duree" \
    --arg par "$(git config user.email || echo inconnu)" \
    '{type: "deploiement", resultat: "ok", commit: $c, precedent: $p, duree_s: $d, par: $par}')"
  info "release $sha en service en $duree s"
  exit 0
fi

memoire_evenement prod "$(jq -nc --arg c "$sha" --arg p "$precedent" \
  '{type: "deploiement", resultat: "echec", commit: $c, precedent: $p}')"
if [[ -z "$precedent" ]]; then
  die "release $sha non saine, aucune release précédente vers laquelle revenir"
fi
info "release $sha non saine : retour à $precedent (règle R1)"
DEPLOY_TAG="$precedent" compose prod up -d --wait --wait-timeout "$attente" --remove-orphans
memoire_evenement prod "$(jq -nc --arg c "$precedent" --arg depuis "$sha" \
  '{type: "retour_arriere", auto: true, regle: "R1", commit: $c, depuis: $depuis}')"
die "déploiement de $sha refusé, $precedent reste en service"
