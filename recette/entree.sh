#!/bin/sh
# ═══════════════════════════════════════════════════════════════════════════
#  recette/entree.sh : point d'entrée des conteneurs de recette
# ═══════════════════════════════════════════════════════════════════════════
#
#  Le dépôt est monté en lecture seule sur /depot. Chaque conteneur en recopie
#  l'état courant dans un répertoire de travail jetable, relie les dépendances
#  de l'image (/app/node_modules, ou RECETTE_MODULES), puis lance :
#
#    interface              l'interface web (interface/serveur.mjs)
#    executeur [--une]      l'exécuteur des demandes de l'interface
#                           (recette/executeur.mjs) ; il recopie le dépôt à
#                           nouveau pour chaque demande
#    <commande> [options]   le lanceur (recette/lancer.mjs) : campagne, migrer,
#                           importer, exporter, comparer, etat
#    (rien)                 une campagne
#
#  Recopier plutôt que travailler sur le montage : les tests créent leurs
#  dépôts jetables ailleurs, mais rien ne doit pouvoir écrire dans le dépôt de
#  la VM, et la recette porte toujours sur l'état présent du dépôt, sans
#  reconstruire l'image. Les secrets (.env.recette) ne sont jamais recopiés.

set -eu

SOURCE="${RECETTE_DEPOT:-/depot}"
TRAVAIL="${RECETTE_TRAVAIL:-/tmp/travail}"
MODULES="${RECETTE_MODULES:-/app/node_modules}"

if [ ! -f "$SOURCE/package.json" ]; then
  echo "recette : aucun dépôt dans $SOURCE (monter le dépôt : -v \"\$PWD:$SOURCE:ro\")" >&2
  exit 2
fi

rm -rf "$TRAVAIL"
mkdir -p "$TRAVAIL"
tar -C "$SOURCE" --exclude=./node_modules --exclude=./.env.recette --exclude='./.env' \
    --ignore-failed-read -cf - . | tar -C "$TRAVAIL" -xf -
ln -s "$MODULES" "$TRAVAIL/node_modules"
cd "$TRAVAIL"

case "${1:-campagne}" in
  interface)
    shift
    exec node interface/serveur.mjs "$@"
    ;;
  executeur)
    shift
    exec node recette/executeur.mjs "$@"
    ;;
  *)
    [ $# -gt 0 ] || set -- campagne
    exec node recette/lancer.mjs "$@"
    ;;
esac
