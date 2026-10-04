# shellcheck shell=bash
# Fonctions communes aux scripts 7E. Sourcé par les scripts, jamais exécuté seul.
set -euo pipefail
shopt -s inherit_errexit            # une erreur dans $(...) interrompt aussi la sous-commande

RACINE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEPOT="${RACINE##*/}"              # un dépôt par application (1.1) : son nom nomme les projets
ETAT="$RACINE/.7e/etat"            # état local du poste : release en service
MEMOIRE="$RACINE/.7e/memoire"      # mémoire des cycles : worktree de la branche « cycles » (EV.1)
# shellcheck disable=SC2034  # utilisé par les scripts qui sourcent ce fichier
APP_SERVICES=(web worker scheduler)

die()  { printf '7e: %s\n' "$*" >&2; exit 1; }
info() { printf '7e: %s\n' "$*" >&2; }
need() { local c; for c in "$@"; do command -v "$c" >/dev/null 2>&1 || die "commande requise absente : $c"; done; }
horodatage() { date -u +%Y-%m-%dT%H:%M:%SZ; }

env_valide() { [[ "${1:-}" == dev || "${1:-}" == prod ]] || die "environnement attendu : dev ou prod (reçu : ${1:-rien})"; }
projet()     { printf '%s-%s' "$DEPOT" "$1"; }
compose()    { "$RACINE/scripts/compose.sh" "$@"; }

# Image de l'application pour un commit donné, telle que la prod locale la nomme.
image_app() {
  local images
  images="$(DEPLOY_TAG="$1" compose prod config --images)"
  grep -m1 -F ":$1" <<<"$images"
}

etat_lire()   { [[ -s "$ETAT/$1" ]] && cat "$ETAT/$1"; }
etat_ecrire() { mkdir -p "$ETAT"; printf '%s\n' "$2" >"$ETAT/$1"; }

# Valeur d'un seuil de 7e/seuils.json ; vide s'il est en calibrage (null).
seuil() { jq -r --arg k "$1" '.seuils[$k].valeur // empty' "$RACINE/7e/seuils.json"; }

# Identifiants des conteneurs d'un service ; vide si aucun.
conteneurs() { compose "$1" ps -q "$2" 2>/dev/null || true; }

# Révision (commit) de l'image du premier conteneur d'un service ; vide si aucune.
revision() {
  local ids c r
  ids="$(conteneurs "$1" "$2")"
  c="${ids%%$'\n'*}"
  [[ -n "$c" ]] || return 0
  r="$(docker inspect -f '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$c")"
  [[ "$r" == "<no value>" ]] || printf '%s' "$r"
}

memoire_pret() { [[ -e "$MEMOIRE/.git" ]]; }

memoire_valider() {
  memoire_pret || return 0
  git -C "$MEMOIRE" add -A
  git -C "$MEMOIRE" -c user.name="boucle-7e" -c user.email="boucle-7e@localhost" \
    commit -q -m "7e: $1" || return 0
  git -C "$MEMOIRE" push -q origin cycles 2>/dev/null || info "mémoire non poussée vers Gitea (hors ligne ?)"
}

# Ajoute un événement horodaté : déploiement, retour arrière, admin, épreuve, ticket.
memoire_evenement() {
  if ! memoire_pret; then
    info "mémoire non initialisée (scripts/7e-init.sh) : événement non conservé"
    return 0
  fi
  mkdir -p "$MEMOIRE/$1"
  jq -c --arg ts "$(horodatage)" '{ts: $ts} + .' <<<"$2" >>"$MEMOIRE/$1/evenements.jsonl"
  memoire_valider "$1 $(jq -r '.type' <<<"$2")"
}

evenements() {
  if [[ -f "$MEMOIRE/$1/evenements.jsonl" ]]; then cat "$MEMOIRE/$1/evenements.jsonl"; fi
}

# Fichier du dernier cycle enregistré pour un environnement ; vide si aucun.
dernier_cycle() {
  find "$MEMOIRE/$1/cycles" -name '*.json' 2>/dev/null | sort | tail -n 1 || true
}

# Release vers laquelle revenir depuis $1 : la dernière déployée saine, hors releases
# dont on est déjà revenu (rejetées). Vide si aucune.
cible_retour_arriere() {
  evenements prod | jq -rs --arg c "$1" '
    (map(select(.type == "retour_arriere") | .depuis)) as $rejetees
    | map(select(.type == "deploiement" and .resultat == "ok" and .commit != $c
                 and (.commit as $x | any($rejetees[]; . == $x) | not)))
    | (last // {}) | .commit // empty'
}

# Ticket Gitea (règles R3, R4), sans doublon tant qu'un ticket du même titre est ouvert.
# Requiert GITEA_URL, GITEA_REPO (propriétaire/dépôt) et GITEA_TOKEN ; n'échoue jamais.
ticket() {
  local titre="[7E] $1" corps="$2" api ouverts reponse
  if [[ -z "${GITEA_URL:-}" || -z "${GITEA_REPO:-}" || -z "${GITEA_TOKEN:-}" ]]; then
    info "ticket non ouvert (GITEA_URL, GITEA_REPO ou GITEA_TOKEN absent) : $titre"
    return 0
  fi
  api="$GITEA_URL/api/v1/repos/$GITEA_REPO/issues"
  ouverts="$(curl -fsS -H "Authorization: token $GITEA_TOKEN" -G "$api" \
    --data-urlencode state=open --data-urlencode type=issues --data-urlencode "q=$titre" 2>/dev/null || echo '[]')"
  if jq -e --arg t "$titre" 'any(.[]; .title == $t)' <<<"$ouverts" >/dev/null 2>&1; then
    info "ticket déjà ouvert : $titre"
    return 0
  fi
  if reponse="$(curl -fsS -H "Authorization: token $GITEA_TOKEN" -H "Content-Type: application/json" \
       -X POST "$api" -d "$(jq -nc --arg t "$titre" --arg b "$corps" '{title: $t, body: $b}')" 2>/dev/null)"; then
    info "ticket ouvert : #$(jq -r '.number' <<<"$reponse") $titre"
  else
    info "échec de l'ouverture du ticket : $titre"
  fi
}
