#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════
#  vm/preparer-vm.sh : prépare une VM Ubuntu existante pour la recette
# ═══════════════════════════════════════════════════════════════════════════
#
#  Sur une VM Ubuntu LTS (22.04, 24.04 ou 26.04), depuis le dépôt cloné :
#
#    sudo vm/preparer-vm.sh [--utilisateur NOM] [--port 8080] [--sans-campagne]
#
#    1. installe Docker Engine et son plugin Compose depuis le dépôt apt
#       officiel de Docker (https://docs.docker.com/engine/install/ubuntu/),
#       s'ils manquent ;
#    2. écrit .env.recette (mots de passe tirés au hasard, droits 600), s'il
#       manque ;
#    3. construit l'image de recette, démarre PostgreSQL, l'interface et
#       l'exécuteur des demandes de l'interface, et attend qu'ils soient sains ;
#    4. importe les tests définis en base (recette/tests-definis.yaml) si la
#       base n'en a aucun, puis lance une première campagne si aucune n'a eu lieu.
#
#  Idempotent : relancé, il ne refait que ce qui manque ; il ne touche jamais
#  à un .env.recette existant, ni aux tests définis déjà en base (ceux que
#  l'interface a modifiés restent tels quels), ni au volume de la base.
#
#  Options
#    --utilisateur NOM  ajoute NOM au groupe docker (défaut : l'appelant de sudo) ;
#                       ce groupe vaut un accès root à la VM
#    --port N           port de l'interface sur 127.0.0.1 (défaut 8080), pour
#                       un .env.recette à créer
#    --sans-campagne    s'arrête après le démarrage et l'import
#
#  L'interface n'écoute que sur 127.0.0.1 de la VM. Depuis un poste :
#    ssh -L 8080:127.0.0.1:8080 utilisateur@vm   puis http://127.0.0.1:8080

set -euo pipefail

DEPOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_RECETTE="$DEPOT/.env.recette"
UTILISATEUR="${SUDO_USER:-}"
PORT=8080
CAMPAGNE=1

usage() {
  sed -n '6,31p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,2\}//'
}

etape() { printf '\n==> %s\n' "$*"; }
echec() { printf 'preparer-vm : %s\n' "$*" >&2; exit 1; }

while [ $# -gt 0 ]; do
  case "$1" in
    --utilisateur) UTILISATEUR="${2:?--utilisateur attend un nom}"; shift 2 ;;
    --port) PORT="${2:?--port attend un numéro}"; shift 2 ;;
    --sans-campagne) CAMPAGNE=0; shift ;;
    -h | --aide | --help) usage; exit 0 ;;
    *) printf 'preparer-vm : option inconnue : %s\n\n' "$1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! [[ "$PORT" =~ ^[0-9]{1,5}$ ]] || [ "$PORT" -lt 1 ] || [ "$PORT" -gt 65535 ]; then echec "port invalide : $PORT"; fi
[ "$(id -u)" -eq 0 ] || echec "à lancer en root : sudo $0 $*"
[ -f "$DEPOT/compose.recette.yaml" ] || echec "compose.recette.yaml introuvable dans $DEPOT"

# shellcheck source=/dev/null
. /etc/os-release
[ "${ID:-}" = ubuntu ] || echec "VM Ubuntu attendue (ID=${ID:-inconnu})"
case "${VERSION_ID:-}" in
  22.04 | 24.04 | 26.04) ;;
  *) printf 'preparer-vm : avertissement : Docker ne prend en charge que les LTS 22.04, 24.04 et 26.04 (ici %s)\n' "${VERSION_ID:-inconnue}" >&2 ;;
esac
export DEBIAN_FRONTEND=noninteractive

# ── 1. Docker Engine et Compose ──────────────────────────────────────────────
installer_docker() {
  if command -v docker >/dev/null 2>&1 && docker compose version >/dev/null 2>&1; then
    echo "Docker présent : $(docker --version) ; $(docker compose version)"
    return
  fi
  etape "Installation de Docker Engine (dépôt apt officiel de Docker)"
  # Paquets en conflit, s'ils sont installés (liste de la documentation Docker)
  local conflits
  conflits="$(dpkg --get-selections docker.io docker-compose docker-compose-v2 docker-doc docker-buildx podman-docker containerd runc 2>/dev/null \
    | awk '$2 == "install" { print $1 }' || true)"
  if [ -n "$conflits" ]; then
    echo "Retrait des paquets en conflit : $conflits"
    # shellcheck disable=SC2086 # une liste de paquets, découpée à dessein
    apt-get remove -y $conflits
  fi
  apt-get update
  apt-get install -y ca-certificates curl
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  cat > /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/ubuntu
Suites: ${UBUNTU_CODENAME:-$VERSION_CODENAME}
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
  echo "Docker installé : $(docker --version)"
}

installer_docker
# Le démon doit répondre. Sur une VM, c'est le service systemd docker ; sous WSL2
# avec Docker Desktop, c'est l'intégration WSL, sans service docker dans systemd.
if ! docker info >/dev/null 2>&1; then
  systemctl start docker || true
  docker info >/dev/null 2>&1 || echec "le démon Docker ne répond pas (systemctl status docker ; sous WSL2, l'intégration WSL de Docker Desktop)"
fi

if [ -n "$UTILISATEUR" ] && [ "$UTILISATEUR" != root ]; then
  if ! id "$UTILISATEUR" >/dev/null 2>&1; then
    echec "utilisateur inconnu : $UTILISATEUR"
  elif id -nG "$UTILISATEUR" | tr ' ' '\n' | grep -qx docker; then
    echo "$UTILISATEUR est déjà dans le groupe docker."
  else
    usermod -aG docker "$UTILISATEUR"
    echo "$UTILISATEUR ajouté au groupe docker (effectif à sa prochaine connexion) : ce groupe vaut un accès root à la VM."
  fi
fi

# ── 2. .env.recette ─────────────────────────────────────────────────────────
secret() { head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n'; }

if [ -f "$ENV_RECETTE" ]; then
  echo ".env.recette existe : conservé tel quel."
else
  etape "Écriture de .env.recette (mots de passe tirés au hasard)"
  (
    umask 077
    cat > "$ENV_RECETTE" <<EOF
# Écrit par vm/preparer-vm.sh le $(date -u +%Y-%m-%dT%H:%M:%SZ) ; jamais versionné (.gitignore).
# Modèle commenté : .env.recette.example
PG_MOT_DE_PASSE_ADMIN=$(secret)
RECETTE_MOT_DE_PASSE=$(secret)
RECETTE_LECTURE_MOT_DE_PASSE=$(secret)
INTERFACE_PORT=$PORT
INTERFACE_UTILISATEUR=
INTERFACE_MOT_DE_PASSE=
RECETTE_DELAI_SQL_MS=5000
TZ=Europe/Paris
EOF
  )
  if [ -n "$UTILISATEUR" ] && [ "$UTILISATEUR" != root ]; then chown "$UTILISATEUR": "$ENV_RECETTE"; fi
  echo "Écrit : $ENV_RECETTE (droits 600)"
fi
PORT_INTERFACE="$(sed -n 's/^INTERFACE_PORT=\([0-9]*\).*/\1/p' "$ENV_RECETTE" | tail -n 1)"
PORT_INTERFACE="${PORT_INTERFACE:-8080}"

# ── 3. Image, base et interface ─────────────────────────────────────────────
compose() {
  docker compose --project-directory "$DEPOT" -f "$DEPOT/compose.recette.yaml" --env-file "$ENV_RECETTE" "$@"
}

etape "Construction de l'image de recette"
compose build interface

etape "Démarrage de PostgreSQL, de l'interface et de l'exécuteur"
compose up -d --wait base interface executeur

# ── 4. Tests définis, première campagne ─────────────────────────────────────
etape "Tests définis en base (recette/tests-definis.yaml), si la base n'en a aucun"
compose run --rm recette importer --si-vide

if [ "$CAMPAGNE" -eq 1 ]; then
  etape "Première campagne, si aucune n'a eu lieu"
  if ! compose run --rm recette campagne --si-premiere --libelle "première campagne de la VM $(hostname)"; then
    echo "La campagne signale des échecs ou des erreurs : le détail est dans l'interface." >&2
  fi
fi

etape "Prêt"
cat <<EOF
Interface   http://127.0.0.1:${PORT_INTERFACE}  (sur la VM) : workflows, déclencheurs, suivi
Depuis un poste :
            ssh -L ${PORT_INTERFACE}:127.0.0.1:${PORT_INTERFACE} ${UTILISATEUR:-utilisateur}@<adresse-de-la-vm>
            puis http://127.0.0.1:${PORT_INTERFACE}
Campagne    docker compose -f compose.recette.yaml --env-file .env.recette run --rm recette campagne
État        docker compose -f compose.recette.yaml --env-file .env.recette run --rm recette etat
Arrêt       docker compose -f compose.recette.yaml --env-file .env.recette down
            (les données restent dans le volume recette-donnees)
EOF
