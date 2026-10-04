#!/usr/bin/env bash
set -euo pipefail

echo "[01-VERIFY] Contrôle de santé des conteneurs..."
docker compose ps
curl -sSf http://localhost:3000/api/7e/history > /dev/null && echo "API Node.js : OK"
curl -sSf http://localhost > /dev/null && echo "Frontend Angular : OK"