#!/usr/bin/env bash
set -euo pipefail

echo "[01-INFRA] Initialisation des réseaux et des volumes..."
docker network create gitmanager-network 2>/dev/null || true
docker volume create pgdata 2>/dev/null || true
docker volume create redis_data 2>/dev/null || true