# Section 01 — Socle d'Infrastructure & Méta-Système Cybernétique 7E

## 1. Description Fonctionnelle
La section 01 initialise le réseau `gitmanager-network`, la base de données PostgreSQL pour la persistance des cycles, le Sidecar Node.js d'observation cybernétique et l'interface Angular en Server-Sent Events.

## 2. Cartographie 7E
- **E1 — Éléments :** Services Docker (Node.js, PostgreSQL, Angular/Nginx).
- **E2 — Espace :** Méta-modèle récursif et fractal, organisation du réseau local `gitmanager-network` et topologie des ports (80/3000/5432).
- **E3 — Émergence :** Détection autonome d'anomalies et régulation automatique.
- **E4 — État :** Table `cycles_7e` (PostgreSQL) et registres mémoire.
- **E5 — Expression :** Cortex Visuel Angular via flux SSE réactifs (Signals).
- **E6 — Évolution :** Moteur d'adaptation dynamique du Sidecar Node.js.
- **E7 — Environnement :** Contexte d'exécution global (WSL2, contraintes hôte et système externe).

## 3. Procédures Opérationnelles
- Démarrage : `./scripts/01-infra.sh && ./scripts/01-app.sh && ./scripts/01-db.sh`
- Validation : `./scripts/01-verify.sh`
- Restauration : `./scripts/01-rollback.sh`