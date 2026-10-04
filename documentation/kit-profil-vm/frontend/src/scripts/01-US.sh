#!/usr/bin/env bash
set -euo pipefail

echo "========================================================================="
echo "SECTION 01 : USER STORIES & ALIGNEMENT PIPELINE GITEA"
echo "========================================================================="
printf "%-10s | %-42s | %-10s | %-10s\n" "US ID" "Titre" "Priorité" "Job Gitea"
echo "-------------------------------------------------------------------------"
printf "%-10s | %-42s | %-10s | %-10s\n" "US-01" "Socle Docker & Réseau Virtuel" "MUST" "infra-job"
printf "%-10s | %-42s | %-10s | %-10s\n" "US-02" "Persistance PostgreSQL & Triggers NOTIFY" "MUST" "db-job"
printf "%-10s | %-42s | %-10s | %-10s\n" "US-03" "Sidecar Node.js Cybernétique 7E" "MUST" "agent-job"
printf "%-10s | %-42s | %-10s | %-10s\n" "US-04" "Dashboard Angular Cortex Visuel" "MUST" "ui-job"
echo "========================================================================="