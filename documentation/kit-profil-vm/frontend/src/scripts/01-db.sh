#!/usr/bin/env bash
set -euo pipefail

echo "[01-DB] Exécution des schémas BDD et vérification PostgreSQL..."

docker compose exec -T postgres psql -U postgres -d gitmanager -f /docker-entrypoint-initdb.d/init.sql

echo "[01-DB] Initialisation de la base de données terminée."