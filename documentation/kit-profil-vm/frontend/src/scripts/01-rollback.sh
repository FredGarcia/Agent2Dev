#!/usr/bin/env bash
set -euo pipefail

echo "[01-ROLLBACK] Nettoyage complet de la section 01..."
docker compose down -v