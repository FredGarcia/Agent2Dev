---
espace: a2d
document: cadrage
version: 0.1.0
statut: proposition
date: 2026-09-27
amont:
  - bin/cadrage@0.1.0
  - bin/architecture@0.1.0
---

# Agent2Dev — Cadrage

> Étape 1 sur 8 · proposition soumise à ratification · 27 septembre 2026
> Document compagnon : [`01-architecture.md`](01-architecture.md)
> Niveau système (hypothèses, tensions et plan du binôme) : [`binome/docs/00-cadrage.md`](../../binome/docs/00-cadrage.md) · [`binome/docs/01-architecture.md`](../../binome/docs/01-architecture.md)

## 1. Objet

Agent2Dev prend en charge une demande de modification ou d'évolution d'une application : front Angular, back Java, base PostgreSQL sous Docker. Il va de l'analyse jusqu'au code livré sur une instance en marche. En chemin, il produit :

- l'analyse de la demande et du code ;
- le cahier des charges : des US et leurs critères d'acceptation numérotés, qui forment l'oracle ;
- les scénarios, en étapes numérotées ou en Gherkin ;
- les préconisations et les avertissements ;
- le plan de réalisation ;
- le plan de tests transmis à Agent2Test.

Il dialogue ensuite avec Agent2Test jusqu'à la conformité. Il corrige les anomalies transmises, et informe Agent2Test chaque fois que ses modifications sont effectives sur l'instance.

Agent2Dev succède à `agents-modif`, version du dépôt du 21 septembre. Il en garde les idées : un bus, un agent générique piloté par des fiches, la vérification « avant / après », la boucle observant-apprenant et la décision valider-corriger-rejeter. Il y ajoute :

- la réalisation effective dans une branche dédiée ;
- la construction et le démarrage de l'application (option B) ;
- le dialogue avec Agent2Test ;
- la fractale 7E en code ;
- la séparation stricte des deux ordres cybernétiques.

## 2. Périmètre

| Dans le périmètre | Hors périmètre |
|---|---|
| Analyse de la demande et du code, cahier des charges, scénarios, préconisations, avertissements, plan de réalisation | Rédaction de la demande |
| Plan de tests au format d'Agent2Test ; dialogue avec Agent2Test jusqu'à conformité ou arbitrage | Sélection et exécution des tests, rôle d'Agent2Test |
| Modifications du back, du front, des migrations et des tests unitaires, dans un arbre de travail dédié | Fusion, poussée, écriture dans l'arbre de travail du développeur |
| Construction, migrations, démarrage et sonde de l'instance dédiée | Démarrage ou arrêt d'environnements partagés |
| Diagnostic et correction des anomalies ; contestation argumentée d'un verdict | Modification des critères ou des scénarios pour obtenir la conformité |
| Observabilité et réflexivité d'Agent2Dev ; propositions d'amendement de ses documents | Écriture de ses documents normatifs |

## 3. Ce que fixent la demande et les réponses du 27 septembre

| # | Élément | Conséquence dans l'architecture |
|---|---|---|
| 1 | Prendre en charge une demande de l'analyse au code : scénarios, préconisations, avertissements, plan de réalisation, plan de tests | Sept fiches cognitives, de l'analyse au diagnostic (`01-architecture.md` §3.3). Le plan de tests part vers Agent2Test. |
| 2 | Dialoguer avec Agent2Test : corriger les anomalies, signaler les modifications effectives | Un module `liaison` ; une boucle de convergence ; une enveloppe d'autonomie. |
| 3 | Option B : Agent2Dev reconstruit et relance l'application | Un module `exploitant`, une instance dédiée, des instantanés de base. |
| 4 | Gherkin possible | La fiche `scenarios` écrit en étapes numérotées ou en Gherkin, selon le projet. |
| 5 | Application générique Java / Angular / PostgreSQL sous Docker | Un profil d'application ratifié en CP-0 ; une cartographie générique ; aucune fiche ne nomme un projet. |
| 6 | JSON ou SQLite pour le travail interne | Le port de stockage du socle : un fichier SQLite par agent, ou un dossier JSON. |
| 7 | AI Act mis de côté | Pas de volet conformité. |
| 8 | Agent2Dev est à modifier | `agents-modif` évolue vers cette tête. La correspondance module par module est dans `01-architecture.md` §13. |
| 9 | Autonomie et supervision humaine | Sept points de contrôle, chacun avec son régime et son plancher. Seuls CP-0, CP-4 et CP-5 bloquent par nature. |
| 10 | Documentation compatible avec celle d'Agent2Test, servant aux agents pour leur propre ajustement | Même gabarit et mêmes identifiants qu'Agent2Test ; en-tête de convention documentaire ; le `referentiel` extrait la constitution de ces documents. |
| 11 | Noyau : Markdown, UML et Mermaid ; cybernétique de second ordre ; cycle 7E à tous les étages | Documents normatifs ; diagrammes UML en Mermaid ; premier et second ordres séparés ; quatre échelles récursives. |
| 12 | Hors périmètre : rédaction de la demande | La demande entre telle quelle. L'analyse la reformule sans la réécrire. |

## 4. Hypothèses

Les hypothèses du binôme (bin/H1 à bin/H15) s'appliquent. Celles-ci sont propres à Agent2Dev.

| # | Hypothèse | Si elle est fausse |
|---|---|---|
| H1 | Une demande est un texte libre, avec en option des indices (fichiers, classes, écrans, identifiant de ticket) et des pièces jointes textuelles. Elle est soumise par le tableau de bord, le MCP ou un fichier. | Un import de tickets (GitLab, Jira) demande un adaptateur d'entrée, par connecteur MCP. |
| H2 | Le projet est un dépôt git local. La branche de base est déclarée dans le profil. Pour chaque demande, Agent2Dev crée un arbre de travail (`git worktree`) et une branche `a2d/<demande>` depuis le dernier commit de cette branche. | Sans git, il n'y a ni arbre dédié ni retour arrière : Agent2Dev refuse de démarrer. |
| H3 | Contrôles locaux : compilation du back et du front, obligatoires ; tests unitaires existants, s'ils sont déclarés dans le profil. Les échecs présents avant la demande forment une ligne de base et ne lui sont pas imputés. | — |
| H4 | Tests unitaires : le développeur peut en ajouter. Modifier ou supprimer un test existant exige une tâche du plan ratifié (I15). | — |
| H5 | Migrations : Liquibase ou Flyway, détecté par la cartographie. Toute évolution de schéma passe par un changeset nouveau, jamais par la modification d'un changeset existant. | Sans outil de migration, les scripts SQL sont traités comme du code ; l'instantané reste pris avant tout démarrage. |
| H6 | Instance : back et front sont construits depuis l'arbre dédié, puis lancés en conteneurs (Compose de l'application, projet `a2d-instance`) ou en processus, selon le profil. La santé du back se lit sur une URL déclarée (par exemple `/actuator/health`), celle du front sur sa page d'accueil. | Sans URL de santé, la sonde se contente d'une réponse HTTP 2xx de l'URL de base. |
| H7 | Commits : un commit par itération sur la branche dédiée, auteur « Agent2Dev ». Les pieds de page portent `Demande:`, `Iteration:`, `Criteres:` et `Fiches:`. Aucune poussée. | — |
| H8 | Conservation : les instantanés de base sont gardés jusqu'à la clôture de la demande, plus 7 jours. L'arbre de travail est supprimé à la clôture ; la branche est conservée. | — |
| H9 | Moteur : au premier palier, un même moteur sert toutes les fiches. La configuration permet ensuite un moteur par fiche. | — |
| H10 | Profil : la cartographie le propose à partir de `pom.xml` ou `build.gradle`, `angular.json`, `package.json`, du fichier Compose et du journal de migrations. Ce qu'elle ne détecte pas porte la marque « à renseigner ». Le profil est ratifié en CP-0. | Un projet hors de ces conventions se décrit à la main dans le profil. |

## 5. Tensions — signalées, non arbitrées

| # | Tension | Exigences en conflit | Proposition | À trancher par |
|---|---|---|---|---|
| T1 | Autonomie ou code non relu exécuté | En régime `differe` sur CP-3, la construction, les tests et le démarrage exécutent sur le poste du code écrit par le moteur avant qu'un humain l'ait lu. | `presenter` forcé sur toute modification de la chaîne de construction ou des dépendances ; garde statique sur les appels système, le réseau et les écritures de fichiers ; instance en conteneurs recommandée. | Vous |
| T2 | Contexte riche ou minimisé | Un contexte large améliore le code, mais augmente les données envoyées au moteur et le coût. | Dossier technique borné et pondéré ; fragments par symbole ; poids recalibrés par le second ordre ; moteur souverain possible. | Vous |
| T3 | Petits pas ou cohérence d'ensemble | Contrôler après chaque tâche détecte tôt, mais une refonte transverse ne compile qu'une fois achevée. | Tâches groupées en lots ; contrôle par lot quand le plan le déclare. | Vous |
| T4 | Lignée ou autonomie | `agents-modif` fait trancher chaque phase par l'opérateur ; l'autonomie demande moins d'arrêts. | Phases regroupées en deux points : CP-1 pour le quoi, CP-2 pour le comment. Le régime `presenter` sur ces deux points rend le fonctionnement actuel. | Vous |
| T5 | Instance dédiée ou fidélité | L'instance du binôme diffère de celle du développeur : ports, base, données. | Profil d'instance ratifié en CP-0 ; données de référence déclarées ; écarts visibles dans le profil. | Vous |
| T6 | Tests unitaires écrits par le même moteur | Le moteur qui écrit le code écrit aussi ses tests unitaires. | Ils restent secondaires : la conformité vient des verdicts d'Agent2Test sur un oracle ratifié (I5). | Vous |

## 6. Agents demandés, agents ajoutés

| Agent demandé | Module ou fiche | Nature |
|---|---|---|
| Scanner de l'application en local | `scanner`, sur la cartographie du socle ; la sonde de l'instance revient à l'`exploitant` | déterministe |
| Analyse de code après scan | `analyste-code` (dossier technique), puis fiche `analyse` | déterministe, puis cognitif |
| Scénarisation | fiche `scenarios` (`scenariste`) | cognitif |
| Cahier des charges | fiche `cahier` (`redacteur`) | cognitif |
| Plan de réalisation | fiche `plan-realisation` (`planificateur`) | cognitif |
| Réalisation du développement | fiche `developpement` (`developpeur`), `depot`, `exploitant` | cognitif, puis déterministe |
| Communicant avec Agent2Test | `liaison` | déterministe |
| Orchestrateur | `orchestrateur` | déterministe |

Agents ajoutés, ce que la demande laissait « à identifier » :

| Agent ajouté | Raison |
|---|---|
| `preconisateur` (fiche `preconisation`) | préconisations et avertissements, repris d'`agents-modif` |
| `diagnosticien` (fiche `diagnostic`) | relier une anomalie à sa cause dans le code avant de corriger, ou contester |
| `depot` | seul écrivain du projet |
| `exploitant` | seul exécutant de commandes ; option B |
| `memoire` | RAG et mémoire persistante |
| `journal`, `observateur` | premier ordre |
| `apprenant`, `reflexif`, `referentiel` | second ordre |
| `tableau-de-bord`, `mcp` | supervision humaine et IDE |

## 7. Plan des étapes

Le plan est celui du binôme (`binome/docs/00-cadrage.md` §7). Pour Agent2Dev :

- **étape 2** : son cahier des charges, `02-cahier-des-charges.md` ;
- **étape 3** : les spécifications de ses modules ;
- **étape 5** : ses sept fiches ;
- **étape 6** : les lots 6b à 6f ; le lot 6a construit le socle qu'il importe.

## 8. Registre de ratification

| Objet | Où | Statut |
|---|---|---|
| Hypothèses H1 à H10 | §4 | à confirmer |
| Tensions T1 à T6 | §5 | à arbitrer |
| Agents demandés et agents ajoutés | §6 | à ratifier |
| Décisions D1 à D19 | `01-architecture.md` §12 | à ratifier |
| Invariants I1 à I15, règles modifiables et bornes | `01-architecture.md` §6.6 | à ratifier |
| Points de contrôle CP-0 à CP-6, régimes et planchers | `01-architecture.md` §5.2 | à ratifier |
| Fiches, entrées, sorties et contrôles | `01-architecture.md` §3.3 | à ratifier |
| Filiation et migration depuis `agents-modif` | `01-architecture.md` §13 | à ratifier |
