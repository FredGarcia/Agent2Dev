#!/usr/bin/env bash
set -euo pipefail

echo "[01-APP] Génération des configurations applicatives..."

cat << 'EOF' > .env
NODE_ENV=production
PORT=3000
DATABASE_URL=postgres://postgres:postgres_password@postgres:5432/gitmanager
REDIS_URL=redis://redis:6379/0
META_CONFIG_PATH=/etc/meta/system.yaml
DOCKER_SOCKET=/var/run/docker.sock
EOF

echo "[01-APP] Fichier .env généré avec succès."