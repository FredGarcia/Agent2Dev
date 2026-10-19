---
espace: bin
document: cadrage
version: 0.1.0
statut: proposition
date: 2026-09-27
amont:
  - a2t/cadrage@0.1
  - a2t/architecture@0.1
  - a2t/cahier-des-charges@0.1
---

# Binôme Agent2Dev · Agent2Test — Cadrage

> Étape 1 sur 8 · proposition soumise à ratification · 27 septembre 2026
> Document compagnon : [`01-architecture.md`](01-architecture.md)
> Agent2Dev : [`00-cadrage.md`](../../agent2dev/docs/00-cadrage.md) · [`01-architecture.md`](../../agent2dev/docs/01-architecture.md)
> Agent2Test, version 0.1 du 25 septembre : [`00-cadrage.md`](../../agent2test/docs/00-cadrage.md) · [`01-architecture.md`](../../agent2test/docs/01-architecture.md) · [`02-cahier-des-charges.md`](../../agent2test/docs/02-cahier-des-charges.md)

## 1. Objet

Le binôme réunit deux systèmes multi-agents autour d'une même demande.

- **Agent2Dev** prend en charge une demande de modification d'une application Java / Angular / PostgreSQL. Il va de l'analyse jusqu'au code livré sur une instance en marche, en passant par le cahier des charges, les scénarios, les préconisations, les avertissements, le plan de réalisation et le plan de tests.
- **Agent2Test** vérifie cette instance contre les critères d'acceptation de la demande et rend un rapport de campagne.

Les deux têtes dialoguent jusqu'à ce que l'application soit conforme, ou jusqu'à ce qu'un humain tranche. Entre les points de contrôle, elles avancent seules. À tout moment, un humain voit où en est la boucle et peut l'arrêter.

Ce document cadre le système à deux têtes : ce qui le borne, ce que fixent les réponses du 27 septembre, les hypothèses et les tensions de niveau système, le plan des étapes. Chaque tête garde ses propres documents :

- ceux d'Agent2Dev accompagnent celui-ci ;
- ceux d'Agent2Test existent depuis le 25 septembre (version 0.1) et ne sont pas modifiés ici. Les améliorations proposées pour que le binôme fonctionne sont registrées comme amendements, à ratifier (`01-architecture.md` §12).

La chaîne de traçabilité, de bout en bout, suit la règle de la mission :

`demande → US → critères numérotés (oracle ratifié) → scénarios → plan de réalisation → modifications → livraison → parcours → verdicts → correction → … → clôture`

## 2. Périmètre

| Dans le périmètre | Hors périmètre |
|---|---|
| Prise en charge d'une demande déjà rédigée, de l'analyse au code | Rédaction de la demande |
| Scénarios, préconisations, avertissements, plan de réalisation, plan de tests | Fusion, poussée vers un dépôt distant, livraison hors du poste |
| Écriture dans une branche et un arbre de travail dédiés du projet local | Écriture dans l'arbre de travail du développeur |
| Construction, migrations, démarrage et sonde d'une instance dédiée de l'application (option B) | Démarrage ou arrêt d'environnements partagés : recette, production |
| Dialogue Agent2Dev ↔ Agent2Test jusqu'à conformité ou arbitrage humain | Pilotage d'une tête par l'autre : chacune reste maîtresse de ses cycles |
| Supervision humaine : points de contrôle, régimes, arrêt d'urgence | Conformité AI Act (mise de côté le 27 septembre) |
| Observabilité et réflexivité de chaque tête et du binôme | Tout ce qui ne sert ni la modification ni sa vérification |

## 3. Ce que fixent les réponses du 27 septembre

| # | Réponse | Conséquence dans l'architecture |
|---|---|---|
| 1 | Option B : Agent2Dev reconstruit et relance l'application, vérifie qu'elle répond, puis notifie Agent2Test. | Agent2Dev gagne un agent `exploitant`, seul exécutant de commandes, sur une instance dédiée. Une livraison n'est « effective » qu'après sonde positive. |
| 2 | Gherkin possible. | Les scénarios s'écrivent en étapes numérotées ou en Gherkin français. L'annexe A d'Agent2Test accepte les deux formats (AM-2). |
| 3 | Application cible générique : back Java, front Angular, base PostgreSQL sous Docker. | Un profil d'application déclaratif et une cartographie générique. Aucune fiche ne nomme un projet. |
| 4 | JSON ou SQLite pour le travail interne. | Un port de stockage commun, SQLite par défaut, un fichier par agent (AM-3). |
| 5 | AI Act mis de côté. | Aucun volet conformité. Traçabilité, contrôle humain et marquage d'origine restent, pour eux-mêmes. |
| 6 | Agent2Dev est à modifier. Agent2Test existe en documentation et peut être amélioré. | `agents-modif` évolue vers la nouvelle tête Agent2Dev. Quinze amendements d'Agent2Test sont proposés. |
| 7 | Le binôme fonctionne en autonomie et permet la supervision humaine. | Des régimes de contrôle par point, une enveloppe d'autonomie, une vue binôme et un arrêt d'urgence commun. |
| 8 | La documentation doit être compatible avec celle d'Agent2Test ; elle servira aux agents pour leur propre ajustement. | Une convention documentaire commune. Les documents deviennent le modèle de soi du système, lu par ses agents. |
| 9 | Agent2Test n'existe qu'en documentation ; par défaut, la version d'Agent2Dev qui fait foi est celle du dépôt (`agents-modif`). | Le dialogue se recette avec un simulateur d'Agent2Test conforme au contrat (H13). Le branchement de Gemini par MCP est à construire (H7). |

## 4. Hypothèses

Chaque information manquante est remplacée par une hypothèse, avec ce qui changerait si elle était fausse.

| # | Hypothèse | Si elle est fausse |
|---|---|---|
| H1 | Poste unique : Windows 11, WSL2 Ubuntu 24.04 et Docker (a2t/H6). Les deux têtes sont deux processus Node distincts sur ce poste et dialoguent en HTTP local, sur `127.0.0.1`. | Avec deux machines, le contrat ne change pas ; le transport exige alors TLS et une authentification mutuelle. |
| H2 | Application cible générique : back Java (Maven ou Gradle, Spring Boot supposé), front Angular (CLI et npm), base PostgreSQL dans Docker Compose, migrations Liquibase, Flyway ou aucune. | Un back sans Spring (JAX-RS, Quarkus) dégrade la cartographie des points d'API : il faut un analyseur de plus dans la cartographie commune. |
| H3 | Instance dédiée : l'application testée est celle qu'Agent2Dev construit et lance depuis son arbre de travail dédié, avec ses propres ports, son propre projet Compose et sa propre base. L'instance de travail du développeur n'est pas touchée. | Si une seule instance est possible (ports imposés, ressources du poste), le développeur arrête la sienne pendant une demande. |
| H4 | Une demande à la fois occupe l'instance, de la première livraison à la clôture ; les suivantes attendent en file. | Plusieurs instances simultanées multiplient les ports et les bases. Le contrat le permet déjà : tout message est corrélé à sa demande. |
| H5 | Authentification de l'application : SSO ou formulaire. Dans les deux cas, l'humain s'authentifie lui-même (a2t/CP-0) et aucune tête ne détient d'identifiant (a2t/I11). | Sans authentification, a2t/CP-0 disparaît. Un compte de service imposé demanderait un coffre de secrets, hors de ce cadrage. |
| H6 | Scénarios : étapes numérotées par défaut (annexe A d'Agent2Test) ; Gherkin en français (`# language: fr`) sur choix du projet. | — |
| H7 | Moteurs : le binôme est autonome avec un moteur que le système appelle lui-même, par exemple un modèle local compatible OpenAI, l'API Anthropic ou Gemini CLI sans tête. Gemini Code Assist, relié par MCP, reste un mode accompagné, piloté depuis l'IDE (T6). | Si seul Gemini Code Assist est autorisé, l'autonomie s'arrête à chaque rédaction : un humain doit garder l'IDE ouvert. |
| H8 | Stockage interne : le module SQLite intégré à Node (`node:sqlite`), un fichier par agent propriétaire ; JSON en option. Ce module ne demande plus d'option depuis Node 22.13 et il est au stade « release candidate » dans Node 24. | Si `node:sqlite` est écarté, l'adaptateur JSON suffit à faire tourner le binôme, avec une recherche plein texte moins fine. |
| H9 | Node 24 LTS pour les deux têtes, Node 22.13 au minimum (révision de a2t/H8). | — |
| H10 | Langue : français pour les documents, l'IHM, les messages et les journaux ; identifiants techniques sans accents (a2t/H17). | — |
| H11 | Dépôt : `FredGarcia/Agent2Dev` devient un monodépôt à quatre dossiers : `socle/`, `agent2dev/` (successeur d'`agents-modif/`), `agent2test/` et `binome/`. `agents-modif/` reste en place jusqu'à la recette de la nouvelle tête. Cette hypothèse tranche a2t/H13. | Deux dépôts séparés imposent de publier le socle comme paquet versionné. |
| H12 | Rôles : les utilisateurs sont des développeurs. Un même développeur peut tenir tous les rôles sur son poste. Développeur, testeur et référent restent des rôles distincts dans la configuration (a2t/H11). | — |
| H13 | Code d'Agent2Test : il relève de son propre plan (a2t étape 5). Ce chantier livre le socle commun, Agent2Dev et un simulateur d'Agent2Test conforme au contrat, qui sert à recetter le dialogue. Le module `liaison` d'Agent2Test est spécifié ici et codé avec Agent2Test. | Si Agent2Test doit être codé dans ce chantier, son plan d'étapes s'insère à l'étape 6. |
| H14 | La conformité AI Act est mise de côté. Traçabilité, contrôle humain et marquage d'origine restent, pour eux-mêmes. | — |
| H15 | Recette du binôme : d'abord en simulation (moteur et Agent2Test simulés), puis sur une application témoin minimale livrée avec le kit : une entité, un écran de liste, un formulaire, en Java, Angular et PostgreSQL. | Sans application témoin, la recette réelle se fait directement sur le projet de l'équipe. |

## 5. Tensions — signalées, non arbitrées

| # | Tension | Exigences en conflit | Proposition | À trancher par |
|---|---|---|---|---|
| T1 | Autonomie ou supervision | « Fonctionner en autonomie » contre « permettre la supervision humaine » et les points de contrôle des deux têtes. | Un régime de contrôle par point, jamais sous son plancher constitutionnel ; une enveloppe d'autonomie. Seuls restent bloquants par nature : le profil et ses commandes, l'ancrage de l'oracle avant la clôture, l'arbitrage, la gouvernance et la session SSO. | Vous |
| T2 | Co-dérive des deux têtes | Deux systèmes qui s'ajustent l'un à l'autre peuvent converger vers un état faux mais cohérent : un code et des tests d'accord sur un comportement que personne n'a demandé. | Oracle ancré par l'humain (I2) ; aucune négociation de l'oracle entre têtes ; une réparation de parcours ne change jamais un attendu (AM-11) ; fiabilité croisée mesurée contre l'arbitrage humain. | Vous |
| T3 | Même moteur des deux côtés (a2t/T6) | Le même modèle peut écrire le code et le test, avec les mêmes angles morts. | Moteurs distincts recommandés par tête ; oracle humain ; leçons indexées par moteur. | Vous |
| T4 | Gherkin permis ou chaîne sans Gherkin | Le 27 septembre : Gherkin possible. La règle de mission et la décision 8 du cahier d'Agent2Test : « sans Gherkin ». | Gherkin est un format de scénario, pas une étape intermédiaire. La chaîne reste demande → US → CA → scénarios → parcours, et les étapes numérotées restent le format par défaut. | Vous |
| T5 | Stockage interne | Le 27 septembre : JSON ou SQLite. Agent2Test (précision 5, a2t/H5, a2t/D5, a2t/D6) : PostgreSQL sous Docker, un schéma et un rôle par agent. | Port de stockage commun, SQLite par défaut, un fichier par agent. L'isolation par agent est conservée, par fichier au lieu de rôle. PostgreSQL reste la base de l'application (AM-3). | Vous |
| T6 | Gemini Code Assist ou autonomie | Le montage MCP prévu pour les deux têtes fait de l'IDE le moteur : une rédaction attend qu'un humain ait l'IDE ouvert. | Deux modes derrière le même port moteur : autonome (le système appelle le moteur) et accompagné (l'IDE rédige par MCP). Le mode se choisit par configuration, pour chaque tête. | Vous |
| T7 | Souveraineté ou moteur externe (a2t/T1) | L'exécution locale et souveraine contre un moteur hébergé : le code du projet quitte le poste. | Profil souverain (Ollama) ; contexte borné et masqué ; autorisation d'envoi à obtenir pour chaque projet. | Vous, DSI et RSSI |
| T8 | Socle commun ou indépendance | L'absence de redondance structurelle contre des têtes découplables : un socle partagé lie leurs versions. | Socle versionné sémantiquement, épinglé par chaque tête. Le contrat est la seule dépendance de fonctionnement entre têtes. Chaque tête fonctionne seule (mode solo). | Vous |
| T9 | Documents normatifs ou agilité | La documentation sert de modèle de soi au système : changer un document change le système. | Seules les parties normatives sont lues : tableaux H, T, D, I, CP, AM, règles et bornes. Elles ne changent que par une version publiée par un humain. Le système propose des amendements et ne les écrit jamais. | Vous |
| T10 | Parallélisme ou simplicité | Préparer les tests pendant la réalisation, ou cadrer la demande suivante pendant une campagne, raccourcit la boucle mais multiplie les états. | Premier palier : une demande à la fois (H4). Le plan de tests part dès a2d/CP-1, pour qu'Agent2Test prépare sa sélection pendant la réalisation. Le reste attend des paliers ultérieurs. | Vous |

## 6. Mis de côté et reporté

- **AI Act** : mis de côté le 27 septembre. Les passages d'Agent2Test qui en relèvent sont visés par l'amendement AM-9.
- **Demandes en parallèle** sur des instances distinctes : reportées (H4, T10).
- **Import de tickets** (GitLab, Jira) : un connecteur MCP, à un palier ultérieur.
- **Têtes sur deux machines** : le contrat le permet ; le transport sécurisé est reporté (H1).

## 7. Plan des étapes

| Étape | Livrables | Point de contrôle |
|---|---|---|
| 1 | Cadrage et architecture du binôme et d'Agent2Dev ; registre des amendements d'Agent2Test | hypothèses, tensions, décisions, invariants, régimes, amendements |
| 2 | Cahier des charges d'Agent2Dev, au format de celui d'Agent2Test ; protocole binôme v1 (messages, schémas, états) ; documents d'Agent2Test amendés (version 0.2) | exigences et contrat |
| 3 | Spécifications détaillées : socle, modules d'Agent2Dev, module `liaison` d'Agent2Test ; schémas de stockage ; API du cycle 7E ; outils MCP ; algorithmes du dossier technique et de la convergence | contrats et formats |
| 4 | Backlog modulaire priorisé, roadmap de maturité, stratégie et plan de tests du binôme | priorités, paliers, stratégie |
| 5 | Prompts système : les sept fiches d'Agent2Dev, `GEMINI.md`, consignes du mode accompagné | rôles, consignes, schémas de sortie |
| 6 | Code exécutable par lots, chacun jouable en simulation avec ses tests : 6a socle · 6b substrat d'Agent2Dev · 6c fiches et orchestrateur · 6d liaison d'Agent2Dev et simulateur d'Agent2Test · 6e premier et second ordres · 6f tableau de bord, vue binôme, MCP | un point par lot |
| 7 | Déploiement : Docker Compose (profils `souverain` et `conteneur`), scripts bash et `.cmd` en ASCII, configuration Gemini, application témoin | démarrage sur votre poste |
| 8 | Recette contre la Definition of Done : dialogue complet Agent2Dev ↔ Agent2Test, d'abord avec le simulateur, puis avec Agent2Test quand il existe ; guide de démarrage | Definition of Done |

## 8. Registre de ratification

| Objet | Où | Statut |
|---|---|---|
| Réponses du 27 septembre et leurs conséquences | §3 | à confirmer |
| Hypothèses H1 à H15 | §4 | à confirmer |
| Tensions T1 à T10 | §5 | à arbitrer |
| Décisions D1 à D19 | `01-architecture.md` §11 | à ratifier |
| Invariants I1 à I7 du binôme | `01-architecture.md` §6.5 | à ratifier |
| Contrat d'échange | `01-architecture.md` §4 | à ratifier |
| Régimes de contrôle et enveloppe d'autonomie | `01-architecture.md` §5 | à ratifier |
| Convention documentaire | `01-architecture.md` §9 | à ratifier |
| Amendements AM-1 à AM-15 d'Agent2Test | `01-architecture.md` §12 | à ratifier |
| Plan des étapes | §7 | à ratifier |
| Documents d'Agent2Dev | `agent2dev/docs/`, leur propre registre | à ratifier |
