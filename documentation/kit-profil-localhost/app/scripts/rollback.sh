#!/usr/bin/env bash
# Retour arrière (5.3) : redéploie la dernière release saine qui n'a pas été rejetée.
# La cible vient de la mémoire des cycles (EV.1) ; --vers <commit> l'impose.
# usage : scripts/rollback.sh [--vers <commit>]
set -euo pipefail
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"
need docker git jq
cd "$RACINE"

courant="$(etat_lire prod.tag || true)"
[[ -n "$courant" ]] || die "aucune release en service"

if [[ "${1:-}" == --vers ]]; then
  cible="$(git rev-parse --verify --quiet "${2:?commit attendu après --vers}^{commit}")" || die "commit inconnu : $2"
else
  memoire_pret || die "mémoire absente : préciser --vers <commit>"
  # Une release dont on est déjà revenu est rejetée : elle n'est pas proposée comme cible.
  cible="$(cible_retour_arriere "$courant")"
  [[ -n "$cible" ]] || die "aucune release antérieure saine en mémoire : préciser --vers <commit>"
fi

info "retour arrière : $courant -> $cible"
"$RACINE/scripts/deploy.sh" "$cible"
memoire_evenement prod "$(jq -nc --arg c "$cible" --arg depuis "$courant" \
  '{type: "retour_arriere", auto: false, commit: $c, depuis: $depuis}')"
