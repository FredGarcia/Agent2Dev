# Méta-projet 12 facteurs × 7E

Ce dépôt porte le modèle exécutif qui croise la méthode Twelve-Factor App et l'Axiome 7E, son résolveur et le journal de ses cycles. Le méta-projet est la première instance du modèle qu'il porte : il l'exécute sur lui-même avant de le publier.

| Fichier | Rôle |
| --- | --- |
| `modele-executif-12f-7e.yaml` | Le modèle : 35 critères résolus en contrôles, le cycle, les contrats |
| `resolveur7e.mjs` | Le résolveur, sous Node.js : exécute un cycle et écrit l'entrée de journal |
| `package.json`, `package-lock.json` | Ses dépendances verrouillées : `yaml` ; `pg` pour la seule recette |
| `7e-instance.yaml` | Le manifeste du méta-projet, au niveau méta |
| `journal/` | Une entrée par cycle, jamais réécrite une fois close |
| `docs/` | La documentation, indexée par `docs/README.md` : le modèle en lecture humaine, la vue d'ensemble (Mermaid et son rendu SVG), le profil localhost |
| `tests/test_*.mjs` | Les suites de recette : résolveur, modèle, manifestes, journal, outillage, pilotage |
| `tests/outils/` | Étapes (16 opérations par test), dépôts jetables, rapporteurs de campagne |
| `recette/` | Le lanceur de campagnes, l'exécuteur des demandes, la base PostgreSQL (migrations), les tests définis en base, le catalogue des workflows (`recette/workflows.yaml`) |
| `interface/` | L'interface web : workflows, déclencheurs et suivi des deux projets, données de recette |
| `compose.recette.yaml`, `Dockerfile.recette` | La pile de recette : PostgreSQL, interface, exécuteur, lanceur |
| `vm/preparer-vm.sh` | La préparation d'une VM Ubuntu : Docker, secrets, démarrage, première campagne |
| `.gitea/workflows/cycle-7e.yml` | Le cycle en CI : build de l'image, tests, cycle, journal versionné |

## Exécuter un cycle

Prérequis : un environnement POSIX (Linux, WSL2 ou l'image du résolveur), Node.js 20 ou plus, git, jq, sh et grep. gitleaks sert au critère 3.2 ; Docker et Docker Compose servent aux contrôles de config et aux scénarios, et le démon Docker à la construction des Dockerfile d'un projet sans compose (2.2). Sans jq, sh ou grep, Évaluer refuse : une part des contrôles ne pourrait pas s'exécuter. Un contrôle qui dépasse son délai (`DELAI_CONTROLE_7E`) est tué, lui seul, et rendu en erreur.

```bash
npm ci                                   # les dépendances, depuis le verrou
node resolveur7e.mjs valider             # Évaluer : modèle, manifeste, release, outils
node resolveur7e.mjs cycle               # le cycle du méta-projet ; l'entrée reste ouverte
node resolveur7e.mjs proposer --critere 12.1 --nature controle --motif "…"
node resolveur7e.mjs clore               # clôt l'entrée, qui n'est plus réécrite
node resolveur7e.mjs historique          # les cycles clos
npm test                                 # les suites de recette (sans base : sections base omises)
```

À côté de l'entrée `journal/<instance>/<n>.yaml`, le cycle range dans `journal/<instance>/<n>/` ce qu'il ne versionne pas : `temp/`, où les contrôles laissent leurs fichiers temporaires (TMPDIR), et, au rang instance, `jira.mhtml`, le ticket de la demande. L'entrée, versionnée, les cite par un lien, avec leur taille et leur empreinte. Un projet instance du modèle lance chaque cycle depuis le ticket Jira d'une évolution de son application, exporté en MHTML : `node resolveur7e.mjs cycle --demande ~/tickets/APP-123.mhtml`, le ticket rangé hors du dépôt (dedans, il rendrait le dépôt « modifié »). Un cycle interrompu laisse son répertoire sans entrée : le cycle suivant le met de côté (`<n>.abandon-<horodatage>`), sans rien effacer. Ce répertoire reste sur le poste qui a tourné le cycle : en CI, il disparaît avec l'espace de travail, et l'entrée garde seule les liens, tailles et empreintes ; l'exécuteur de l'interface ne le recopie pas. Le méta-projet, lui, n'a pas de ticket : il s'améliore à chaque ticket de ses instances.

La release du méta-projet n'atteint la production qu'à sa validation finale : le bouton « Validation finale » de l'interface (page Déclencheurs) l'enregistre en base, et `node recette/lancer.mjs validation --date` la relit pour la mesure 10.2 (délai du commit à la validation). Sans base joignable, cette mesure reste en erreur.

En image : `docker build -t resolveur7e .`, puis `docker run --rm -v "$PWD:/depot" resolveur7e cycle --clore` (pour une instance, le ticket monté aussi : `-v ~/tickets:/tickets:ro … cycle --demande /tickets/APP-123.mhtml`). L'image porte sa propre copie du modèle et du résolveur : la reconstruire quand l'un des deux change.

### Depuis Windows

Le résolveur ne tourne pas sous Windows natif : ni sh ni grep, et Évaluer le dit. Deux voies :

- **WSL2**, dépôt dans le système de fichiers Linux (pas sous `/mnt/c`), où les droits des fichiers sont conservés. Le `nodejs` d'apt est trop ancien sur Ubuntu 24.04 : installer Node.js 22 (NodeSource ou nvm).

  ```bash
  sudo apt update && sudo apt install -y git jq unzip
  mkdir -p ~/projets && cd ~/projets && git clone <dépôt> meta-12f-7e   # ou unzip de l'archive
  cd meta-12f-7e && npm ci && node resolveur7e.mjs valider
  ```

- **L'image**, depuis PowerShell dans le dépôt. Un disque Windows n'a pas de bit d'exécution : `core.filemode` à `false` évite que les scripts paraissent modifiés.

  ```powershell
  git config core.filemode false
  docker build -t resolveur7e .
  docker run --rm -v "${PWD}:/depot" resolveur7e valider
  ```

Sur une copie restée en `core.filemode = true`, la remarque « dépôt modifié » d'Évaluer le signale : « droits d'exécution seulement, voir core.filemode ».

Pour un autre projet : épingler la version du modèle dans son `7e-instance.yaml`, puis lancer le résolveur avec `DEPOT_7E` sur son dépôt et `MODELE_7E` sur le modèle publié.

### Versions publiées

Une version du modèle n'est publiée qu'après un cycle clos sur le méta-projet, avec IN.1 au moins à 2 (`amorcage.publication`). Son tag `v<x>.<y>.<z>` marque la release que ce cycle a examinée.

| Tag | Version | Publiée par | Ce qui change |
| --- | --- | --- | --- |
| `v0.4.0` | révision, contrat 0.4 | cycle 4, 4 octobre 2026 | EV.1 et EV.2 ne comparent que le contrat courant ; 10.2 mesure aussi sur un tag annoté ; 2.2 écarte ce qui n'est pas un Dockerfile et lit les chemins accentués ; 5.3 éprouve la fumée par un témoin, chaque commande du manifeste tourne dans son sous-shell ; gardes alignées sur le résolveur ; journal normalisé ; fiche de version en structure ; un délai dépassé arrête tout ce que le contrôle a lancé |
| `v0.3.0` | révision, contrat 0.3 | cycle 3, 4 octobre 2026 | 11.1 lit tout le code, `cjs` compris ; le journal sort des motifs ; 2.2 et 5.3 ont un contrôle pour les projets sans compose ; chaque décision porte son motif ; la section `modele` est rangée |
| `v0.2.2` | correctif | cycle 2, 4 octobre 2026 | la clé `"n"` des facteurs est citée : le modèle se lit à l'identique en YAML 1.1 et 1.2 |
| `v0.2.1` | correctif | cycle 1, 2 octobre 2026 | le résolveur passe en Node.js ; première version publiée |

Chaque version mineure change le contrat (0.2 : cycles 0 à 2 ; 0.3 : cycle 3 ; 0.4 : cycle 4). Jusqu'à la 0.4, un cycle ne se comparait qu'aux cycles du même contrat ; depuis la 0.5, il se compare au dernier cycle clos, quel que soit son contrat, sur les critères notés dans les deux : une baisse après une nouvelle version du modèle la remet en question. Un projet épingle sa version dans `modele.version`, puis lit le modèle de ce tag : `git show v0.4.0:modele-executif-12f-7e.yaml > modele.yaml` et `MODELE_7E=modele.yaml`.

## Recette

La recette vérifie le résolveur, les fichiers YAML et son propre outillage, puis range chaque campagne dans PostgreSQL, opération par opération ; une interface web la donne à lire et à enrichir.

| Suite | Ce qu'elle éprouve |
| --- | --- |
| `test_resolveur7e.mjs` | Le résolveur, fonction par fonction puis de bout en bout : nombres (parité Python), contrôles, agrégation, blocage, phases, journal, ligne de commande |
| `test_modele_yaml.mjs` | Le modèle : lecture YAML 1.2 = 1.1, structure, paramètres de contrôle, expressions acceptées par grep, jq et sh, assertions éprouvées sur des données d'essai |
| `test_manifeste_yaml.mjs` | Chaque `7e-instance.yaml` (et ceux de `RECETTE_MANIFESTES`) contre le contrat du modèle, jusqu'à `valider` |
| `test_journal_yaml.mjs` | Chaque entrée de journal : forme, puis cohérence recalculée (scores, synthèse, blocage, plan, tendance, viabilité, décisions) ; deux cycles synthétiques confrontent contrat et résolveur |
| `test_recette.mjs` | L'outillage : rapporteurs, tests définis, infrastructure, base (16 opérations, rôle de lecture, capacité), interface |
| `test_pilotage.mjs` | Le pilotage : catalogue des workflows, liste blanche des actions, invariants des demandes en base, exécuteur (réussite, échec, délai, arrêt, orphelines, secrets masqués), déclencher et suivre depuis l'interface |

Chaque test déclare ses opérations (étapes), seize au plus : `scenario(t).etape(…)` ou `table(t, […])` dans `tests/outils/etapes.mjs`. La 17e est refusée par le code, et par la base (rang de 1 à 16, unique par test).

### Sur la VM de recette

Sur une VM Ubuntu LTS (22.04, 24.04 ou 26.04), dépôt cloné :

```bash
sudo vm/preparer-vm.sh            # Docker, .env.recette, image, base, interface, première campagne
```

Le script installe Docker Engine depuis le dépôt apt officiel de Docker s'il manque, écrit `.env.recette` (mots de passe tirés au hasard, droits 600, jamais versionné), démarre PostgreSQL, l'interface et l'exécuteur, importe les tests définis si la base n'en a aucun et lance une première campagne. Relancé, il ne refait que ce qui manque : les tests modifiés dans l'interface restent tels quels. Il interroge le démon Docker lui-même (`docker info`) et ne passe par systemd que s'il ne répond pas : sans systemd, un démon déjà démarré suffit (WSL2 avec Docker Desktop, par exemple).

L'interface écoute sur `127.0.0.1:8080` de la VM. Depuis un poste : `ssh -L 8080:127.0.0.1:8080 utilisateur@vm`, puis http://127.0.0.1:8080. Elle ne répond qu'aux noms localhost, 127.0.0.1 et [::1] (garde contre le rebond DNS ; d'autres noms par `INTERFACE_HOTES_PERMIS`). Une authentification HTTP s'active par `INTERFACE_UTILISATEUR` et `INTERFACE_MOT_DE_PASSE`, renseignés ensemble.

```bash
alias recette='docker compose -f compose.recette.yaml --env-file .env.recette'
recette run --rm recette campagne --libelle "après la révision 0.3"
recette run --rm recette etat                 # les dix dernières campagnes
recette run --rm recette comparer 3 4         # régressions, corrections, nouveaux, disparus
recette run --rm recette exporter > recette/tests-definis.yaml
recette logs -f executeur                     # ce que l'exécuteur fait des demandes
recette down                                  # arrêt ; les données restent dans le volume
```

Chaque conteneur recopie l'état courant du dépôt (monté en lecture seule) : la recette porte toujours sur le dépôt tel qu'il est, sans reconstruire l'image. Le lanceur monte le socket Docker de la VM pour les tests qui exigent un vrai démon ; retirer ce montage les omet, avec leur motif.

Mettre à jour une VM déjà préparée :

```bash
git pull
sudo vm/preparer-vm.sh                    # image reconstruite si besoin, conteneurs recréés si leur définition change
recette restart interface executeur       # chacun reprend son code ; l'exécuteur recharge les données du dépôt
recette run --rm recette importer --nouveaux   # s'il signale des tests définis que la base n'a pas
```

L'interface et l'exécuteur, qui tournent en continu, prennent leur code au démarrage ; chaque demande, elle, recopie le dépôt du moment. Au démarrage, l'exécuteur recharge les données du dépôt (modèle, manifestes, journal, workflows), sauf pendant une campagne : l'interface montre le dépôt déployé. Relancé sur une base qui a déjà des tests définis, `preparer-vm.sh` n'en importe aucun mais cite ceux du dépôt qu'elle n'a pas ; `importer --nouveaux` les ajoute sans toucher aux autres (un test supprimé dans l'interface reviendrait, d'où l'import à la main).

### Workflows, déclencheurs, suivi

L'interface reflète les deux projets. Le méta-projet y est lu dans son dépôt : le cycle 7E et ses sept phases (le modèle), le workflow de CI (ses déclencheurs et ses étapes lus dans `.gitea/workflows/cycle-7e.yml`), le résolveur, la recette, la préparation de la VM. Le binôme y est lu dans sa spécification, en attendant n8n : W00 à W10, les états et transitions d'une tâche, le catalogue des tâches, les dix décisions et leur statut. Le catalogue est `recette/workflows.yaml` ; l'extrait du binôme s'y met à jour avec sa spécification (révision citée).

| Page | Ce qu'elle montre |
| --- | --- |
| Workflows | Chaque workflow : nature, phases, déclencheurs, exécutant ; le détail donne ses étapes, ses gardes et ses dernières demandes |
| Déclencheurs | Tous les déclencheurs des deux projets ; quatre se lancent d'ici : campagne de recette, Évaluer seul (`valider`), cycle à blanc, recharger les données du dépôt ; et la validation finale d'une release, qui la met en production (10.2) |
| Suivi | L'exécuteur et sa file, les demandes et leur sortie, les cycles du journal, les propositions au modèle, la dernière campagne, les décisions du binôme |

Lancer depuis l'interface dépose une demande (`pilotage.demande`). L'exécuteur, service `executeur` de la pile, la réclame ; avec le lanceur en ligne de commande, il tient le socket Docker de la VM, que l'interface n'a jamais. Il recopie l'état courant du dépôt et y exécute l'action : un argv de la liste blanche (`recette/pilotage.mjs`), jamais un shell. La base vérifie aussi l'action et ses paramètres, et n'admet qu'une demande en attente ou en cours par action. La sortie, mots de passe masqués, se range au fil de l'exécution ; une demande se suit, s'annule tant qu'elle attend, s'arrête pendant qu'elle tourne, et chaque action a son délai. Le cycle à blanc garde son entrée dans la demande : seule la CI écrit le journal.

Arrêter une campagne, depuis l'interface ou en arrêtant le conteneur de l'exécuteur, la clôt comme interrompue en quelques secondes : le lanceur arrête les tests, puis clôt sa campagne ; ce qui reste des processus de la demande est arrêté par degrés (TERM, puis KILL), dans le délai de grâce du conteneur. Si l'exécuteur est tué net, sa demande « en cours » est close comme interrompue à son redémarrage ; une campagne qu'aucun lanceur ne tient plus est close par l'exécuteur, qui veille sur les campagnes toutes les 15 s.

Le suivi automatique d'une demande (rechargement toutes les dix secondes) ne démarre que sur demande, s'arrête par un lien et cesse à la fin de la demande (RGAA 13.1).

### Les données

Trois schémas : `recette` (campagnes, tests, opérations, exécutions, résultats), `donnees` (le modèle, les manifestes, le journal, le catalogue des workflows et les workflows de CI, rechargés à chaque campagne, sur demande et au démarrage de l'exécuteur, et dépliés en vues : `donnees.critere`, `donnees.score`, `donnees.synthese`…) et `pilotage` (demandes, exécuteurs).

Les tests définis en base portent des requêtes SQL, exécutées sous le rôle `recette_lecture` (une seule lecture SELECT, WITH, VALUES ou TABLE, 5 s et 1 000 lignes au plus), ou des appels de fonctions d'une liste blanche (fonctions pures du résolveur, jq sans environnement ni accès aux fichiers, assertions du modèle). Ils s'éditent dans l'interface, qui permet d'essayer une opération avant de l'enregistrer, et s'échangent par `recette/tests-definis.yaml`, versionné avec le dépôt.

Capacité mesurée : 300 tests à 16 requêtes SQL s'importent, s'exécutent et se chargent en quelques secondes (`test_recette.mjs`, section 5).

Sans VM : `RECETTE_PG_URL=… RECETTE_PG_LECTURE_URL=… node recette/lancer.mjs campagne` sur toute base PostgreSQL 16 préparée par `recette/initdb/10-roles.sh`.
