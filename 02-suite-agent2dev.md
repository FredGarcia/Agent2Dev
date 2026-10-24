---
espace: a2d
document: suite
version: 1.2.0
statut: ratifie
date: 2026-10-24
amont:
  - a2d/cadrage@0.3.0
  - a2d/architecture@0.3.0
---

# Agent2Dev — Suite de l'étape 1

> Note du 21 octobre 2026, complétée le 22 octobre des amendements de la ratification, puis le 24 octobre du fichier SQLite unique et de l'échange par dossiers ; version 1.2.0 du 24 octobre : ratifiée, par la fusion de la pull request n° 2 · les documents de l'étape 1 restent tels que le 4 octobre les a ratifiés ; cette note dit ce qui en reste en vigueur, et où la conception se poursuit.
> Documents de l'étape 1 : [`00-cadrage.md`](00-cadrage.md) · [`01-architecture.md`](01-architecture.md)

## 1. Ce qui a été décidé le 21 octobre

- Agent2Dev reste la tête de développement, et applique le skill agent-tdd-jira comme méthode.
- Tout reste en local et s'enchaîne à la main. Le développeur lance l'application sur Tomcat en local, et ses batchs ; l'équipe déploie à la main.
- Agent2Test devient une spécification transmissible, `agent2test` 1.0.0, puis 1.1.0 et 1.2.0, avec laquelle Agent2Dev travaille en binôme par des fichiers que le développeur porte, ou que l'échange par dossiers porte à sa place.
- Agent2Dev devient lui aussi une spécification transmissible, dans le dépôt Agent2Prompt (`specs/agent2dev/`) : `agent2dev` 1.0.0, publiée par la pull request n° 7, fusionnée, avec `agent2test` 1.1.0 et `agent-tdd-jira` 1.3.1 ; puis `agent2dev` 1.1.0 (transmission `transmissions/agent2dev-1.1.0.md`), publiée par la pull request n° 10, fusionnée le 24 octobre, avec `agent2test` 1.2.0 et `agent-tdd-jira` 1.3.2. Le code se construira ensuite, par lots, dans le dossier `agent2dev/` du présent dépôt.
- Les points de validation sont toujours présentés ; l'autonomie par point est réservée.
- L'écriture du code est une option : par défaut, Agent2Dev travaille dans une copie de travail et remet un patch par scénario accepté, que le développeur applique lui-même.

Amendements du développeur à la ratification de l'étape 1, le 21 octobre :

- la persistance est en SQLite dès le départ, un fichier par agent, pour Agent2Dev comme pour Agent2Test, qui quitte PostgreSQL (`agent2test` 1.1.0) ; le fichier par agent est remplacé le 23 octobre par un fichier unique par tête, voir ci-dessous ;
- n8n est facultatif, en relais de transport seulement : activé, il porte la remise vers Agent2Test et le journal de tests vers Agent2Dev, par les serveurs MCP des deux têtes, sur sa propre base SQLite ; il ne décide rien et n'ouvre aucune campagne. Sans lui, le développeur porte les fichiers à la main. Ce relais est remplacé le 23 octobre, voir ci-dessous.

Décisions du développeur, les 22 et 23 octobre :

- un fichier SQLite unique par tête, au lieu d'un fichier par agent : `agent2dev.sqlite`, dont l'agent médiateur `donnees` tient la seule connexion. Les autres agents n'y accèdent que par ses actions, sur le bus ; le médiateur tire la table de l'appelant que le bus atteste et de la collection, sans SQL ni nom de table venu d'un agent. Les deux têtes n'ont pas de fichier commun : Agent2Test tourne sous Windows, Agent2Dev dans WSL2 ;
- n8n n'est plus le relais du binôme. La remise et le journal de tests circulent à la main, ce qui est le défaut, ou par l'échange par dossiers, facultatif : Agent2Dev publie la remise dans sa boîte de sortie, où Agent2Test la lit, et relève le journal de tests dans celle d'Agent2Test, en lecture seule. Aucune connexion entre les têtes, aucune décision : le développeur redémarre l'application et ouvre la campagne lui-même.

## 2. Ce qui reste en vigueur

Les choix d'architecture de l'étape 1 restent la source : le noyau 7E et ses quatre échelles, l'agent générique piloté par des fiches, le `depot` seul écrivain et sa vérification « avant / après », la séparation des deux ordres cybernétiques, la gouvernance des leçons par ratification humaine.

Les invariants I1 à I15 deviennent des invariants de dimension de la spécification ; la table de correspondance est dans `specs/agent2dev/SKILL.md`, section 11.1, du dépôt Agent2Prompt.

## 3. Ce qui est remplacé

| Étape 1, version 0.3.0 | Spécification agent2dev 1.1.0 |
|---|---|
| couplage des deux têtes par n8n, enveloppe `binome-7e/1` | enchaînement à la main : remise du plan validé, journal de tests d'Agent2Test lu par le script du skill (module `binome`) ; échange par dossiers facultatif, sans connexion, sans enveloppe ni décision (module `echange`, D25) ; plus de n8n |
| stockage JSON par agent, puis SQLite au-delà de 250 Ko | un fichier SQLite unique, `agent2dev.sqlite`, dès le premier enregistrement, par `node:sqlite`, que seul l'agent médiateur `donnees` ouvre (module `donnees`, D24) |
| contestation tranchée par une personne en a2d/CP-5 | désaccord présenté au développeur ; Agent2Dev ne conteste ni ne réécrit aucun verdict |
| points CP-0 à CP-6, régime `differe` d'a2d/CP-1 à la mission | points V0 à V5 du skill, toujours présentés, et CP-4 pour la gouvernance ; autonomie réservée (D22) |
| option B : `exploitant`, instance dédiée sous Docker, sonde, instantanés de base | `executant` limité à la compilation, aux tests et aux scripts du skill ; ni démarrage, ni déploiement, ni batch |
| arbre de travail et branche `a2d/<demande>` créés par Agent2Dev, poussée vers un Gitea local | copie de travail dans les données d'Agent2Dev, un patch par scénario accepté, appliqué par le développeur ; écriture dans l'arbre de la demande sur autorisation ; aucune poussée |
| sept fiches : analyse, cahier, scénarios, préconisation, plan de réalisation, développement, diagnostic | huit fiches calées sur le skill : analyse, impact, variantes, contrat, rouge, vert, remanié, rapport |
| demande en texte libre, ou issue « à faire » en mode binôme | demande Jira exportée en MHTML, extraite par le script du skill |
| adaptateurs `gemini-cli`, `externe`, `compatible-openai`, `anthropic`, `simulation` | `externe` (Gemini Code Assist par MCP), `compatible-openai`, `simulation` |
| mémoire et recherche hybride sur le code | réservées (D21) |
| plusieurs demandes actives, file et verrou gérés par n8n | une demande à la fois par instance ; une instance par worktree du kit en mode parallèle ; l'échange par dossiers ne gère ni file ni verrou |
| AI Act | hors périmètre ; restent l'origine des productions du moteur et la gouvernance |

## 4. Les points ouverts du 4 octobre

| Point | Ce qu'il devient |
|---|---|
| allers-retours entre les têtes : 3 par tâche dans le catalogue de n8n, 5 itérations par demande | sans objet : n8n n'est plus employé, et l'échange par dossiers ne fait que porter les fichiers ; un scénario se corrige au plus `budget.correctionsParScenario` fois, 3 par défaut, entre 1 et 5 |
| budgets d'appels au moteur et de jetons | budgets d'essais par sortie et par pas, durée de travail par demande ; les jetons sont mesurés, sans budget |
| licence de n8n, montage réseau de son conteneur, points bloquants du binôme | licence et réseau : sans objet depuis le 23 octobre, n8n n'étant plus employé ; l'échange par dossiers n'ouvre aucune connexion ni aucun port. Points bloquants : l'échange ne décide rien et n'ouvre aucune campagne ; le développeur publie lui-même, aucun agent n'ouvre de pull request |
| `binome/` dans le dépôt du binôme (H11), vérificateur des documents au statut `remplace` | sans objet pour la spécification ; à reprendre si ces dossiers servent de nouveau |

## 5. Ce qui ne change pas ici

- Les documents de l'étape 1, du niveau Agent2Dev comme du niveau binôme, gardent leur version, leur statut et leur contenu : ils sont la trace de la ratification du 4 octobre.
- `agents-modif/` reste en place jusqu'à la recette de la première version d'Agent2Dev construite, puis sera retiré.
- Le dossier `documentation/agent2dev/` garde les deux patchs et la note d'origine de la ratification, appliqués par la pull request qui ajoute cette note.
