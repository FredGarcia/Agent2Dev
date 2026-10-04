#!/usr/bin/env bash
# Prépare le poste et le dépôt pour la boucle 7E. Idempotent : se relance sans risque.
#  - copies .env.dev et .env.prod depuis le contrat .env.example (3.1)
#  - réseau Docker « contrats » où le rang N expose son service (FR.1)
#  - mémoire des cycles : worktree .7e/memoire sur la branche orpheline « cycles » (EV.1)
set -euo pipefail
# shellcheck source=scripts/lib.sh
. "$(dirname "$0")/lib.sh"
need docker git jq curl
cd "$RACINE"

docker compose version >/dev/null 2>&1 || die "plugin « docker compose » absent"
git worktree list >/dev/null 2>&1 || die "git trop ancien pour les worktrees"

for e in dev prod; do
  if [[ ! -f ".env.$e" ]]; then
    cp .env.example ".env.$e"
    info ".env.$e créé depuis .env.example : à renseigner (ports distincts en dev et en prod)"
  fi
done
for f in .env.dev .env.prod .7e/; do
  git check-ignore -q "$f" || die ".gitignore doit ignorer $f"
done

if ! docker network inspect contrats >/dev/null 2>&1; then
  docker network create contrats >/dev/null
  info "réseau « contrats » créé (FR.1)"
fi

if ! memoire_pret; then
  git fetch -q origin cycles 2>/dev/null || true
  if git show-ref -q --verify refs/heads/cycles || git show-ref -q --verify refs/remotes/origin/cycles; then
    git worktree add -q "$MEMOIRE" cycles
  else
    git worktree add -q --orphan -b cycles "$MEMOIRE"     # git 2.42 ou plus
    printf '%s\n' "# Mémoire des cycles 7E (EV.1)" "" \
      "Branche en ajout seul : un fichier par cycle, une ligne par événement. Ne jamais réécrire." \
      >"$MEMOIRE/README.md"
    memoire_valider "initialisation de la mémoire"
  fi
fi
info "mémoire des cycles : $MEMOIRE (branche cycles)"
registre="$(sed -n 's/^REGISTRY=//p' .env.example)"
info "prêt. Ensuite : docker login $registre (jeton write:package), puis scripts/compose.sh dev up -d --build --wait"
