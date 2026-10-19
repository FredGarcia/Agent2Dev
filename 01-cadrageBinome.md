---
espace: bin
document: cadrage
version: 0.2.0
statut: proposition
date: 2026-09-28
amont:
  - a2t/cadrage@0.1
  - a2t/architecture@0.1
  - a2t/cahier-des-charges@0.1
---

# Binôme Agent2Dev · Agent2Test — Cadrage

> Étape 1 sur 8 · version 0.2.0 du 28 septembre : tensions T1 et T3 à T10 arbitrées, le reste soumis à ratification
> Document compagnon : [`01-architecture.md`](01-architecture.md)
> Agent2Dev : [`00-cadrage.md`](../../agent2dev/docs/00-cadrage.md) · [`01-architecture.md`](../../agent2dev/docs/01-architecture.md)
> Agent2Test, version 0.1 du 25 septembre : [`00-cadrage.md`](../../agent2test/docs/00-cadrage.md) · [`01-architecture.md`](../../agent2test/docs/01-architecture.md) · [`02-cahier-des-charges.md`](../../agent2test/docs/02-cahier-des-charges.md)

## 1. Objet

Le binôme réunit deux systèmes multi-agents autour d'une même demande.

- **Agent2Dev** prend en charge une demande de modification d'une application Java / Angular / PostgreSQL. Il va de l'analyse jusqu'au code livré sur une instance en marche, en passant par le cahier des charges, les scénarios, les préconisations, les avertissements, le plan de réalisation et le plan de tests.
- **Agent2Test** vérifie cette instance contre les critères d'acceptation de la demande et rend un rapport de campagne.

Les deux têtes dialoguent jusqu'à ce que l'application soit conforme, ou jusqu'à ce qu'un humain tranche. Entre les points de contrôle, elles avancent seules. À tout moment, un humain voit où en est la boucle et peut l'arrêter.

Ce document cadre le système à deux têtes : ce qui le borne, ce que fixent les réponses du 27 septembre et les arbitrages du 28, les hypothèses et les tensions de niveau système, le plan des étapes. Chaque tête garde ses propres documents :

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
| 3 | Application cible générique : back Java, front Angular, base PostgreSQL sous Docker. | Un profil d'application déclaratif et une carte générique du projet. Aucune fiche ne nomme un projet. |
| 4 | JSON ou SQLite pour le travail interne. | Un port de stockage dans chaque tête : JSON par défaut, SQLite au-delà de 250 Ko par agent, un dossier ou un fichier par agent (T5, AM-3). |
| 5 | AI Act mis de côté. | Aucun volet conformité. Traçabilité, contrôle humain et marquage d'origine restent, pour eux-mêmes. |
| 6 | Agent2Dev est à modifier. Agent2Test existe en documentation et peut être amélioré. | `agents-modif` évolue vers la nouvelle tête Agent2Dev. Dix-sept amendements d'Agent2Test sont proposés ; un dix-huitième, AM-7, est retiré. |
| 7 | Le binôme fonctionne en autonomie et permet la supervision humaine. | Des régimes de contrôle par point, au plancher par défaut (T1) ; une enveloppe d'autonomie, une vue binôme et un arrêt d'urgence commun. |
| 8 | La documentation doit être compatible avec celle d'Agent2Test ; elle servira aux agents pour leur propre ajustement. | Une convention documentaire commune. Les documents deviennent le modèle de soi du système, lu par ses agents, qui y reportent leurs réglages ratifiés (T9). |
| 9 | Agent2Test n'existe qu'en documentation ; par défaut, la version d'Agent2Dev qui fait foi est celle du dépôt (`agents-modif`). | Le dialogue se recette avec un simulateur d'Agent2Test conforme au contrat (H13). Chaque tête appelle Gemini CLI sans tête ; l'IDE reste branché par MCP (H7). |

## 4. Hypothèses

Chaque information manquante est remplacée par une hypothèse, avec ce qui changerait si elle était fausse.

| # | Hypothèse | Si elle est fausse |
|---|---|---|
| H1 | Poste unique : Windows 11, WSL2 Ubuntu 24.04 et Docker (a2t/H6). Les deux têtes sont deux processus Node distincts sur ce poste et dialoguent en HTTP local, sur `127.0.0.1`. | Avec deux machines, le contrat ne change pas ; le transport exige alors TLS et une authentification mutuelle. |
| H2 | Application cible générique : back Java (Maven ou Gradle, Spring Boot supposé), front Angular (CLI et npm), base PostgreSQL dans Docker Compose, migrations Liquibase, Flyway ou aucune. | Un back sans Spring (JAX-RS, Quarkus) dégrade la carte des points d'API : il faut un analyseur de plus dans chaque tête. |
| H3 | Instance dédiée : l'application testée est celle qu'Agent2Dev construit et lance depuis son arbre de travail dédié, avec ses propres ports, son propre projet Compose et sa propre base. L'instance de travail du développeur n'est pas touchée. | Si une seule instance est possible (ports imposés, ressources du poste), le développeur arrête la sienne pendant une demande. |
| H4 | Plusieurs demandes actives, trois au plus par défaut, chacune dans son arbre de travail. L'instance, unique, est prise par une demande de sa livraison jusqu'au rapport de campagne ; les autres livraisons attendent leur tour (T10). | Si le poste ne tient pas la charge, la limite descend à une demande active. Au-delà, il faudrait une instance par demande (reportée, §6). |
| H5 | Authentification de l'application : SSO ou formulaire. Dans les deux cas, l'humain s'authentifie lui-même (a2t/CP-0) et aucune tête ne détient d'identifiant (a2t/I11). | Sans authentification, a2t/CP-0 disparaît. Un compte de service imposé demanderait un coffre de secrets, hors de ce cadrage. |
| H6 | Scénarios : étapes numérotées par défaut (annexe A d'Agent2Test) ; Gherkin en français (`# language: fr`) au choix du projet (T4). | — |
| H7 | Moteur : Gemini, sous la licence Gemini Code Assist, pour les deux têtes (T3, T6). En mode autonome, chaque tête appelle Gemini CLI sans tête, qui réutilise les identifiants mis en cache lors d'une première connexion. En mode accompagné, l'IDE rédige par MCP. | Si la licence ne couvre pas Gemini CLI, l'autonomie n'existe qu'en mode accompagné, IDE ouvert, ou avec le profil `souverain`. |
| H8 | Stockage interne : JSON par défaut. Un agent dont les données dépassent 250 Ko passe à SQLite, par le module `node:sqlite` intégré à Node : sans option depuis Node 22.13, au stade « release candidate » dans Node 24 (T5). | Si `node:sqlite` est écarté, JSON seul fait tourner le binôme ; la recherche plein texte ralentit au-delà du seuil. |
| H9 | Node 24 LTS pour les deux têtes, Node 22.13 au minimum (révision de a2t/H8). | — |
| H10 | Langue : français pour les documents, l'IHM, les messages et les journaux ; identifiants techniques sans accents (a2t/H17). | — |
| H11 | Dépôt : `FredGarcia/Agent2Dev` porte trois dossiers sans code commun : `agent2dev/` (successeur d'`agents-modif/`), `agent2test/` et `binome/` (documents du binôme, schémas du contrat, vecteurs de conformité, vérificateur des documents). Ils vont à la racine, ou sous `autotest/` selon la consigne du 21 septembre : à confirmer. `agents-modif/` reste en place jusqu'à la recette de la nouvelle tête. Cette hypothèse tranche a2t/H13. | Chaque tête peut partir dans son propre dépôt sans changer de code (T8) ; `binome/` suit alors l'un des deux dépôts, ou le sien. |
| H12 | Rôles : les utilisateurs sont des développeurs. Un même développeur peut tenir tous les rôles sur son poste. Développeur, testeur et référent restent des rôles distincts dans la configuration (a2t/H11). | — |
| H13 | Code d'Agent2Test : il relève de son propre plan (a2t étape 5), avec son propre noyau (T8). Ce chantier livre Agent2Dev, les spécifications communes et un simulateur d'Agent2Test conforme au contrat, qui sert à recetter le dialogue. Le module `liaison` d'Agent2Test est spécifié ici et codé avec Agent2Test. | Si Agent2Test doit être codé dans ce chantier, son plan d'étapes s'insère à l'étape 6. |
| H14 | La conformité AI Act est mise de côté. Traçabilité, contrôle humain et marquage d'origine restent, pour eux-mêmes. | — |
| H15 | Recette du binôme : d'abord en simulation (moteur et Agent2Test simulés), puis sur une application témoin minimale livrée avec le kit : une entité, un écran de liste, un formulaire, en Java, Angular et PostgreSQL. | Sans application témoin, la recette réelle se fait directement sur le projet de l'équipe. |
| H16 | La mission autorise l'envoi à Gemini, sous sa licence Gemini Code Assist, de contextes de code bornés et masqués, pour les deux têtes (T7). | Sans cette autorisation, le profil `souverain` (Ollama) devient le défaut, avec une rédaction de moindre qualité. |
| H17 | Les quotas de la licence couvrent le volume d'appels du binôme : de l'ordre d'une centaine d'appels par demande, les deux têtes comprises, multiplié par le nombre de demandes actives (T10). Cet ordre de grandeur est une estimation, à mesurer en recette. | Les budgets d'appels par demande et la limite de demandes actives se resserrent ; la file s'allonge. |

## 5. Tensions

### 5.1 Arbitrées le 28 septembre

| # | Tension | Exigences en conflit | Arbitrage | Conséquence |
|---|---|---|---|---|
| T1 | Autonomie ou supervision | « Fonctionner en autonomie » contre « permettre la supervision humaine » et les points de contrôle des deux têtes. | Autonomie, avec Gemini Code Assist. | Chaque point de contrôle est par défaut à son plancher (D20). La boucle ne s'arrête plus qu'au profil, à la session SSO, à l'arbitrage et aux cas forcés d'a2d/I8 ; la gouvernance reste asynchrone. Une demande ne se clôt « conforme » qu'après ratification de l'oracle (I2). |
| T3 | Même moteur des deux côtés (a2t/T6) | Le même modèle peut écrire le code et le test, avec les mêmes angles morts. | Même moteur. | Gemini pour les deux têtes (D16). La diversité passe des moteurs aux contextes : contextes séparés (I8), contrôle de dérivabilité des attendus (AM-17), posture de réfutation dans les consignes d'Agent2Test (étape 5). |
| T4 | Gherkin permis ou chaîne sans Gherkin | Le 27 septembre : Gherkin possible. La règle de mission et la décision 8 du cahier d'Agent2Test : « sans Gherkin ». | Gherkin permis. | Gherkin est un format de scénario, jamais une étape : la chaîne reste demande → US → CA → scénarios → parcours. Étapes numérotées par défaut ; Gherkin en français au choix du projet (H6, AM-2). |
| T5 | Stockage interne | Le 27 septembre : JSON ou SQLite. Agent2Test (précision 5, a2t/H5, a2t/D5, a2t/D6) : PostgreSQL sous Docker, un schéma et un rôle par agent. | JSON, puis SQLite au-delà de 250 Ko. | JSON par défaut ; chaque agent bascule seul vers SQLite quand ses données dépassent 250 Ko, sans retour, entre deux de ses cycles (`01-architecture.md` §7, D10, AM-3). L'isolation par agent est conservée. PostgreSQL reste la base de l'application. |
| T6 | Gemini Code Assist ou autonomie | Le montage MCP fait de l'IDE le moteur : une rédaction attend qu'un humain ait l'IDE ouvert. | Gemini Code Assist, en autonomie. | Mode autonome : Gemini CLI sans tête, authentifié par la licence Gemini Code Assist. Mode accompagné : l'IDE par MCP. Les deux passent par le même port moteur (D21, H7, AM-16). |
| T7 | Souveraineté ou moteur externe (a2t/T1) | L'exécution locale et souveraine contre un moteur hébergé : des extraits de code quittent le poste. | Souveraineté de l'exécution et des données ; Gemini reste le moteur. | Agents, stockage, journal, mémoire et instance restent sur le poste ; seul un contexte borné et masqué part vers Gemini. Un moteur local (Ollama) reste branchable par le même port : c'est le profil `souverain`. L'envoi reste à autoriser par la mission (H16). |
| T8 | Socle commun ou indépendance | L'absence de redondance structurelle contre des têtes découplables : un socle partagé lie leurs versions. | Indépendance : des spécifications communes, aucun code commun. | Chaque tête a son noyau et son cycle de versions, et peut vivre dans son propre dépôt. Seules des spécifications sont communes : cycle 7E, contrat, ligne de journal, politique de stockage, clés de l'application, convention documentaire, avec leurs vecteurs de conformité (D1, `01-architecture.md` §3). Le noyau existe en deux implémentations : la redondance est assumée entre les têtes, jamais à l'intérieur d'une tête. |
| T9 | Documents normatifs ou agilité | La documentation sert de modèle de soi au système : changer un document change le système. | Agilité : le système écrit les réglages ratifiés. | Après ratification au point de gouvernance de la tête (a2d/CP-4, a2t/CP-4), son `referentiel` reporte lui-même les valeurs ajustées dans ses documents. La constitution — invariants, points de contrôle et planchers, bornes des règles — reste écrite par l'humain seul. Une constitution modifiée attend sa ratification, sans empêcher le démarrage (I7, D12, AM-18). |
| T10 | Parallélisme ou simplicité | Préparer les tests pendant la réalisation, ou avancer la demande suivante pendant une campagne, raccourcit la boucle mais multiplie les états. | Parallélisme en pipeline, sur une instance. | Plusieurs demandes actives, chacune dans son arbre ; l'instance est prise de la livraison au rapport, une campagne à la fois ; le plan de tests part dès sa production (D22, H4). Un recouvrement de fichiers entre demandes actives est signalé en a2d/CP-2 (a2d/T7). |

### 5.2 Ouverte

| # | Tension | Exigences en conflit | Proposition | À trancher par |
|---|---|---|---|---|
| T2 | Co-dérive des deux têtes | Deux systèmes qui s'ajustent l'un à l'autre peuvent converger vers un état faux mais cohérent : un code et des tests d'accord sur un comportement que personne n'a demandé. Le même moteur (T3) et l'autonomie (T1) aggravent le risque : la panne de mode commun devient possible, et les décisions humaines qui permettent de voir la dérive se raréfient. | Oracle ancré par l'humain (I2), jamais négocié entre têtes. Attendus dérivés de l'oracle, jamais du code ni d'une réparation (AM-11), vérifiés à l'import (AM-17). Contextes séparés (I8). Fiabilité croisée mesurée contre l'arbitrage humain. En autonomie, un audit par échantillon : à la clôture, l'humain confirme un critère « conforme » tiré au hasard, pour que la dérive reste mesurable. Mécanisme et parades : `01-architecture.md` §6.4. | Vous |

## 6. Mis de côté et reporté

- **AI Act** : mis de côté le 27 septembre. Les passages d'Agent2Test qui en relèvent sont visés par l'amendement AM-9.
- **Socle commun** : écarté le 28 septembre, au profit de spécifications communes (T8).
- **Une instance par demande** : reportée ; le pipeline sur une instance est retenu (H4, T10).
- **Import de tickets** (GitLab, Jira) : un connecteur MCP, à un palier ultérieur.
- **Têtes sur deux machines** : le contrat le permet ; le transport sécurisé est reporté (H1).

## 7. Plan des étapes

| Étape | Livrables | Point de contrôle |
|---|---|---|
| 1 | Cadrage et architecture du binôme et d'Agent2Dev ; registre des amendements d'Agent2Test | hypothèses, tensions, décisions, invariants, régimes, amendements |
| 2 | Cahier des charges d'Agent2Dev, au format de celui d'Agent2Test ; protocole binôme v1 (messages, schémas, états) ; documents d'Agent2Test amendés (version 0.2) | exigences et contrat |
| 3 | Spécifications détaillées : spécifications communes (contrat, journal, stockage, convention documentaire) et leurs vecteurs de conformité ; modules d'Agent2Dev ; module `liaison` d'Agent2Test ; outils MCP ; algorithmes du dossier technique, de la convergence et de la file | contrats et formats |
| 4 | Backlog modulaire priorisé, roadmap de maturité, stratégie et plan de tests du binôme | priorités, paliers, stratégie |
| 5 | Prompts système : les sept fiches d'Agent2Dev, `GEMINI.md`, consignes du mode accompagné, posture de réfutation pour Agent2Test | rôles, consignes, schémas de sortie |
| 6 | Code exécutable par lots, chacun jouable en simulation avec ses tests : 6a noyau d'Agent2Dev · 6b substrat · 6c fiches et orchestrateur · 6d liaison et simulateur d'Agent2Test · 6e premier et second ordres · 6f tableau de bord, vue binôme, MCP | un point par lot |
| 7 | Déploiement : Docker Compose (profils `souverain` et `conteneur`), scripts bash et `.cmd` en ASCII, configuration Gemini (CLI et IDE), application témoin | démarrage sur votre poste |
| 8 | Recette contre la Definition of Done : dialogue complet Agent2Dev ↔ Agent2Test, d'abord avec le simulateur, puis avec Agent2Test quand il existe ; guide de démarrage | Definition of Done |

## 8. Registre de ratification

| Objet | Où | Statut |
|---|---|---|
| Réponses du 27 septembre et leurs conséquences | §3 | à confirmer |
| Hypothèses H1 à H17 | §4 | à confirmer ; H4, H6 à H8, H11 et H13 révisées, H16 et H17 nouvelles |
| Tensions T1 et T3 à T10 | §5.1 | arbitrées le 28 septembre |
| Tension T2 | §5.2 | à arbitrer |
| Décisions D1 à D22 | `01-architecture.md` §11 | à ratifier |
| Invariants I1 à I8 du binôme | `01-architecture.md` §6.5 | à ratifier |
| Spécifications communes et vecteurs de conformité | `01-architecture.md` §3.2 | à ratifier |
| Contrat d'échange | `01-architecture.md` §4 | à ratifier |
| Régimes de contrôle et enveloppe d'autonomie | `01-architecture.md` §5 | à ratifier |
| Convention documentaire | `01-architecture.md` §9 | à ratifier |
| Amendements AM-1 à AM-18 d'Agent2Test | `01-architecture.md` §12 | à ratifier ; AM-7 retiré |
| Plan des étapes | §7 | à ratifier |
| Documents d'Agent2Dev | `agent2dev/docs/`, leur propre registre | à ratifier |
