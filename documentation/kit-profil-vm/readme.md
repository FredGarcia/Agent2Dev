Commandes de lancement
Vérifie que Docker est actif sur ta machine (ou dans WSL2).


Bash
docker compose up --build -d
4. Accès et Vérification
Service	URL / Port	Description
Dashboard Angular	http://localhost	Interface temps réel (Cortex Visuel)
API Node.js / Flux SSE	http://localhost:3000/api/7e/stream	Flux temps réel d'événements 7E
Historique JSON 7E	http://localhost:3000/api/7e/history	Dernières transitions lues depuis Postgres
PostgreSQL	localhost:5432	BDD (user: postgres, pass: postgres_password, db: gitmanager)
5. Commandes de gestion au quotidien
Consulter les logs du Sidecar Cybernétique en direct :

Bash
docker compose logs -f node_backend
Arrêter la pile sans supprimer les données :

Bash
docker compose stop
Tout réinitialiser à zéro (supprime la base Postgres et réexécute init.sql) :

Bash
docker compose down -v