---
espace: bin
document: cadrage
version: 0.3.0
statut: ratifie
date: 2026-10-04
amont:
  - a2t/cadrage@0.1
  - a2t/architecture@0.1
  - a2t/cahier-des-charges@0.1
---

# Binôme Agent2Dev · Agent2Test — Cadrage

> Étape 1 sur 8 · version 0.3.0 du 4 octobre : ratifiée, avec la tension T2 arbitrée et le couplage des deux têtes porté par n8n (§3.2)
> Document compagnon : [`01-architecture.md`](01-architecture.md)
> Agent2Dev : [`00-cadrage.md`](../../agent2dev/docs/00-cadrage.md) · [`01-architecture.md`](../../agent2dev/docs/01-architecture.md)
> Agent2Test, version 0.1 du 25 septembre : [`00-cadrage.md`](../../agent2test/docs/00-cadrage.md) · [`01-architecture.md`](../../agent2test/docs/01-architecture.md) · [`02-cahier-des-charges.md`](../../agent2test/docs/02-cahier-des-charges.md)
> Couplage des deux têtes : spécification « Binôme cybernétique 7E × 12 facteurs — orchestration n8n », ratifiée le 4 octobre 2026

## 1. Objet

Le binôme réunit deux systèmes multi-agents autour d'une même demande.

- **Agent2Dev** prend en charge une demande de modification d'une application Java / Angular / PostgreSQL. Il va de l'analyse jusqu'au code livré sur une instance en marche, en passant par le cahier des charges, les scénarios, les préconisations, les avertissements, le plan de réalisation et le plan de tests.
- **Agent2Test** vérifie cette instance contre les critères d'acceptation de la demande et rend un rapport de campagne.

Les deux têtes dialoguent jusqu'à ce que l'application soit conforme, ou jusqu'à ce qu'un humain tranche. Entre les points de contrôle, elles avancent seules. À tout moment, un humain voit où en est la boucle et peut l'arrêter. Leurs échanges passent par n8n, qui porte le couplage sans jamais juger à leur place (§3.2).

Ce document cadre le système à deux têtes : ce qui le borne, ce que fixent les réponses du 27 septembre, les arbitrages du 28 et la ratification du 4 octobre, les hypothèses et les tensions de niveau système, le plan des étapes. Chaque tête garde ses propres documents :

- ceux d'Agent2Dev accompagnent celui-ci ;
- ceux d'Agent2Test existent depuis le 25 septembre (version 0.1) et ne sont pas modifiés ici. Les améliorations proposées pour que le binôme fonctionne sont enregistrées comme amendements, ratifiés le 4 octobre, à appliquer à l'étape 2 (`01-architecture.md` §12).

La chaîne de traçabilité, de bout en bout, suit la règle de la mission :

`demande → US → critères numérotés (oracle ratifié) → scénarios → plan de réalisation → modifications → livraison → parcours → verdicts → correction → … → clôture`

## 2. Périmètre

| Dans le périmètre | Hors périmètre |
|---|---|
| Prise en charge d'une demande déjà rédigée, de l'analyse au code | Rédaction de la demande |
| Scénarios, préconisations, avertissements, plan de réalisation, plan de tests | Fusion à la mission ; poussée ou livraison hors du poste |
| Écriture dans une branche et un arbre de travail dédiés du projet local | Écriture dans l'arbre de travail du développeur |
| Construction, migrations, démarrage et sonde d'une instance dédiée de l'application (option B) | Démarrage ou arrêt d'environnements partagés : recette, production |
| Dialogue Agent2Dev ↔ Agent2Test, par n8n, jusqu'à conformité ou arbitrage humain | Pilotage d'une tête par l'autre ou par n8n : chacune reste maîtresse de ses cycles |
| Supervision humaine : points de contrôle, régimes, arrêt d'urgence | Conformité AI Act (mise de côté le 27 septembre) |
| Observabilité et réflexivité de chaque tête et du binôme | Tout ce qui ne sert ni la modification ni sa vérification |

## 3. Ce que fixent les réponses du 27 septembre et la ratification du 4 octobre

### 3.1 Les réponses du 27 septembre

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

### 3.2 La ratification du 4 octobre

Le 4 octobre, l'humain a ratifié le registre de l'étape 1 (§8) et le couplage des deux têtes par n8n, que décrit la spécification du binôme orchestré par n8n. Ce qui en découle pour les deux têtes :

| # | Point ratifié | Conséquence dans l'architecture |
|---|---|---|
| 1 | n8n porte le couplage. Agent2Dev est le système dev, Agent2Test le système test, chacun derrière le contrat. | Les têtes ne s'adressent plus directement : chacune expose son API, n8n valide et achemine chaque message. Chacune garde ses cycles, sa constitution et ses points de contrôle (`01-architecture.md` §4.3, D1, D5). |
| 2 | n8n tient la mécanique de la boucle : compteurs, délais, relances, escalades. Agent2Dev garde le jugement : diagnostic, correction, contestation. | n8n ne juge jamais une livraison ni un verdict. Une contestation va à une personne, qui arbitre en a2d/CP-5 ; Agent2Test n'en reçoit que la décision, jamais l'argument (I8). |
| 3 | Le milieu des échanges est un Gitea local, sur le poste. | Tâches, états et messages y sont inscrits ; à la mission, le projet y est une copie du projet GitLab, et Agent2Dev y pousse sa branche dédiée. À la clôture (a2d/CP-6), une personne pousse la branche prête vers le GitLab du projet ; aucun agent n'écrit dans GitLab (D9). |
| 4 | Trois dépôts : le binôme (contrat, catalogue, workflows n8n, simulation), Agent2Dev et Agent2Test. | Chaque dépôt épingle la version du contrat (H11). |
| 5 | À la mission, une personne fusionne ; n8n ne fusionne que pour des projets personnels. | À la mission, fusion et poussée hors du poste restent hors du système (§2, D9) ; pour un projet personnel, n8n fusionne sur verdict accepté et CI verte. |
| 6 | Les points humains s'additionnent : ceux des deux têtes et ceux du binôme. | Chaque point garde le régime que lui fixe sa tête : son plancher par défaut (D20), plus strict si une personne le configure ainsi. À un point bloquant, la tâche passe en attente d'une personne. La session SSO (a2t/CP-0) précède toute campagne : sans elle, aucune ne tourne (`01-architecture.md` §5.2). |
| 7 | T2 est arbitrée par un audit par échantillon. | À chaque clôture, une personne confirme un critère « conforme » tiré au hasard (§5.2). |
| 8 | La chaîne de construction est soumise à ratification : `pom.xml`, `package.json`, `package-lock.json`, Dockerfile, compose, CI. | Une PR qui en touche un attend la décision d'une personne, à l'image du régime `presenter` forcé par a2d/I8. |
| 9 | Le catalogue de n8n porte les limites entre les têtes ; chaque tête garde ses budgets internes. | Au catalogue : allers-retours, questions, campagnes simultanées, délais. Dans la constitution de chaque tête : ses budgets, sa règle de progrès, sa détection d'oscillation (`01-architecture.md` §5.3). |
| 10 | H16 et H17 sont confirmées. | Gemini CLI fixe le modèle demandé, sauf pour ses sous-agents, et peut basculer sur un modèle de repli : chaque tête consigne le modèle réellement utilisé, appel par appel. |
| 11 | n8n, Postgres et Gitea tournent en composition sur le poste. | À la mission, un processus par tête et une campagne à la fois (H1, H4, D22). |
| 12 | Entre les têtes, une seule enveloppe : `binome-7e/1`. | La livraison effective devient une `livraison`, le rapport de campagne un `verdict`, ses anomalies et leurs reproductions vont dans ses échecs. La ligne de journal et la convention documentaire communes restent normatives dans chaque tête (`01-architecture.md` §4, D4). |
| 13 | La file des demandes et le verrou de l'instance, tenus jusque-là à l'échelle Système d'Agent2Dev, passent à n8n. | Agent2Dev demande le verrou à n8n avant chaque déploiement ; n8n l'attribue dans l'ordre d'arrivée et le reprend au rapport de campagne, à un refus ou à un échec (H4, D22). |
| 14 | Un dépôt cible n'a besoin que de `binome.yaml` ; sans `7e-instance.yaml`, le binôme n'y conduit pas de cycle 7E et n'y traite que des demandes. | En mode binôme, une demande entre par une issue « à faire » du Gitea local, que n8n met en file ; Agent2Dev en rédige les US et les critères numérotés, soumis à a2d/CP-1, puis le plan donne les tâches. |

## 4. Hypothèses

Chaque information manquante est remplacée par une hypothèse, avec ce qui changerait si elle était fausse.

| # | Hypothèse | Si elle est fausse |
|---|---|---|
| H1 | Poste unique : Windows 11, WSL2 Ubuntu 24.04 et Docker (a2t/H6). Les deux têtes sont deux processus Node distincts sur ce poste ; chacune expose son API HTTP sur `127.0.0.1`. n8n, en composition avec Postgres et Gitea sur le même poste, porte leurs échanges (§3.2). | Avec deux machines, le contrat ne change pas ; le transport exige alors TLS et une authentification mutuelle. |
| H2 | Application cible générique : back Java (Maven ou Gradle, Spring Boot supposé), front Angular (CLI et npm), base PostgreSQL dans Docker Compose, migrations Liquibase, Flyway ou aucune. | Un back sans Spring (JAX-RS, Quarkus) dégrade la carte des points d'API : il faut un analyseur de plus dans chaque tête. |
| H3 | Instance dédiée : l'application testée est celle qu'Agent2Dev construit et lance depuis son arbre de travail dédié, avec ses propres ports, son propre projet Compose et sa propre base. L'instance de travail du développeur n'est pas touchée. | Si une seule instance est possible (ports imposés, ressources du poste), le développeur arrête la sienne pendant une demande. |
| H4 | Plusieurs demandes actives, trois au plus par défaut, chacune dans son arbre de travail. L'instance, unique, est prise par une demande de sa livraison jusqu'au rapport de campagne ; les autres livraisons attendent leur tour (T10). n8n gère la file des demandes et le verrou de l'instance : une campagne à la fois (§3.2). | Si le poste ne tient pas la charge, la limite descend à une demande active. Au-delà, il faudrait une instance par demande (reportée, §6). |
| H5 | Authentification de l'application : SSO ou formulaire. Dans les deux cas, l'humain s'authentifie lui-même (a2t/CP-0) et aucune tête ne détient d'identifiant (a2t/I11). | Sans authentification, a2t/CP-0 disparaît. Un compte de service imposé demanderait un coffre de secrets, hors de ce cadrage. |
| H6 | Scénarios : étapes numérotées par défaut (annexe A d'Agent2Test) ; Gherkin en français (`# language: fr`) au choix du projet (T4). | — |
| H7 | Moteur : Gemini, sous la licence Gemini Code Assist, pour les deux têtes (T3, T6). En mode autonome, chaque tête appelle Gemini CLI sans tête, qui réutilise les identifiants mis en cache lors d'une première connexion. En mode accompagné, l'IDE rédige par MCP. Confirmé le 4 octobre : la licence couvre Gemini CLI. Gemini CLI peut basculer sur un modèle de repli : chaque tête épingle le nom du modèle et consigne, appel par appel, le modèle réellement utilisé. | Si la licence ne couvre pas Gemini CLI, l'autonomie n'existe qu'en mode accompagné, IDE ouvert, ou avec le profil `souverain`. |
| H8 | Stockage interne : JSON par défaut. Un agent dont les données dépassent 250 Ko passe à SQLite, par le module `node:sqlite` intégré à Node : sans option depuis Node 22.13, au stade « release candidate » dans Node 24 (T5). | Si `node:sqlite` est écarté, JSON seul fait tourner le binôme ; la recherche plein texte ralentit au-delà du seuil. |
| H9 | Node 24 LTS pour les deux têtes, Node 22.13 au minimum (révision de a2t/H8). | — |
| H10 | Langue : français pour les documents, l'IHM, les messages et les journaux ; identifiants techniques sans accents (a2t/H17). | — |
| H11 | Dépôts, révisés le 4 octobre : trois dépôts sans code commun. `FredGarcia/Agent2Dev` porte Agent2Dev, successeur d'`agents-modif/` ; Agent2Test a le sien ; le dépôt du binôme porte le contrat `binome-7e/1`, le catalogue, les workflows n8n et la simulation, et `binome/` (documents du binôme, vecteurs de conformité, vérificateur des documents) le rejoint. Chaque dépôt épingle la version du contrat. `agents-modif/` reste en place jusqu'à la recette de la nouvelle tête. Cette hypothèse tranche a2t/H13. | Un dépôt unique reste possible sans changer de code (T8) : les trois parties y cohabitent, sans code commun. |
| H12 | Rôles : les utilisateurs sont des développeurs. Un même développeur peut tenir tous les rôles sur son poste. Développeur, testeur et référent restent des rôles distincts dans la configuration (a2t/H11). | — |
| H13 | Code d'Agent2Test : il relève de son propre plan (a2t étape 5), avec son propre noyau (T8). Ce chantier livre Agent2Dev, les spécifications communes et un simulateur d'Agent2Test conforme au contrat, qui sert à recetter le dialogue. Le module `liaison` d'Agent2Test est spécifié ici et codé avec Agent2Test. | Si Agent2Test doit être codé dans ce chantier, son plan d'étapes s'insère à l'étape 6. |
| H14 | La conformité AI Act est mise de côté. Traçabilité, contrôle humain et marquage d'origine restent, pour eux-mêmes. | — |
| H15 | Recette du binôme : d'abord en simulation (moteur et Agent2Test simulés), puis sur une application témoin minimale livrée avec le kit : une entité, un écran de liste, un formulaire, en Java, Angular et PostgreSQL. | Sans application témoin, la recette réelle se fait directement sur le projet de l'équipe. |
| H16 | La mission autorise l'envoi à Gemini, sous sa licence Gemini Code Assist, de contextes de code bornés et masqués, pour les deux têtes (T7). Confirmée le 4 octobre. | Sans cette autorisation, le profil `souverain` (Ollama) devient le défaut, avec une rédaction de moindre qualité. |
| H17 | Les quotas de la licence couvrent le volume d'appels du binôme : de l'ordre d'une centaine d'appels par demande, les deux têtes comprises, multiplié par le nombre de demandes actives (T10). Confirmée le 4 octobre ; l'ordre de grandeur reste à mesurer en recette. | Les budgets d'appels par demande et la limite de demandes actives se resserrent ; la file s'allonge. |

## 5. Tensions

### 5.1 Arbitrées le 28 septembre

| # | Tension | Exigences en conflit | Arbitrage | Conséquence |
|---|---|---|---|---|
| T1 | Autonomie ou supervision | « Fonctionner en autonomie » contre « permettre la supervision humaine » et les points de contrôle des deux têtes. | Autonomie, avec Gemini Code Assist. | Chaque point de contrôle est par défaut à son plancher (D20). La boucle ne s'arrête plus qu'au profil, à la session SSO, à l'arbitrage, aux cas forcés d'a2d/I8 et aux points bloquants du binôme (§3.2) ; la gouvernance reste asynchrone. Une demande ne se clôt « conforme » qu'après ratification de l'oracle (I2). |
| T3 | Même moteur des deux côtés (a2t/T6) | Le même modèle peut écrire le code et le test, avec les mêmes angles morts. | Même moteur. | Gemini pour les deux têtes (D16). La diversité passe des moteurs aux contextes : contextes séparés (I8), contrôle de dérivabilité des attendus (AM-17), posture de réfutation dans les consignes d'Agent2Test (étape 5). |
| T4 | Gherkin permis ou chaîne sans Gherkin | Le 27 septembre : Gherkin possible. La règle de mission et la décision 8 du cahier d'Agent2Test : « sans Gherkin ». | Gherkin permis. | Gherkin est un format de scénario, jamais une étape : la chaîne reste demande → US → CA → scénarios → parcours. Étapes numérotées par défaut ; Gherkin en français au choix du projet (H6, AM-2). |
| T5 | Stockage interne | Le 27 septembre : JSON ou SQLite. Agent2Test (précision 5, a2t/H5, a2t/D5, a2t/D6) : PostgreSQL sous Docker, un schéma et un rôle par agent. | JSON, puis SQLite au-delà de 250 Ko. | JSON par défaut ; chaque agent bascule seul vers SQLite quand ses données dépassent 250 Ko, sans retour, entre deux de ses cycles (`01-architecture.md` §7, D10, AM-3). L'isolation par agent est conservée. PostgreSQL reste la base de l'application. |
| T6 | Gemini Code Assist ou autonomie | Le montage MCP fait de l'IDE le moteur : une rédaction attend qu'un humain ait l'IDE ouvert. | Gemini Code Assist, en autonomie. | Mode autonome : Gemini CLI sans tête, authentifié par la licence Gemini Code Assist. Mode accompagné : l'IDE par MCP. Les deux passent par le même port moteur (D21, H7, AM-16). |
| T7 | Souveraineté ou moteur externe (a2t/T1) | L'exécution locale et souveraine contre un moteur hébergé : des extraits de code quittent le poste. | Souveraineté de l'exécution et des données ; Gemini reste le moteur. | Agents, stockage, journal, mémoire et instance restent sur le poste ; seul un contexte borné et masqué part vers Gemini. Un moteur local (Ollama) reste branchable par le même port : c'est le profil `souverain`. L'envoi est autorisé par la mission (H16, confirmée le 4 octobre). |
| T8 | Socle commun ou indépendance | L'absence de redondance structurelle contre des têtes découplables : un socle partagé lie leurs versions. | Indépendance : des spécifications communes, aucun code commun. | Chaque tête a son noyau et son cycle de versions, et peut vivre dans son propre dépôt. Seules des spécifications sont communes : cycle 7E, contrat, ligne de journal, politique de stockage, clés de l'application, convention documentaire, avec leurs vecteurs de conformité (D1, `01-architecture.md` §3). Le noyau existe en deux implémentations : la redondance est assumée entre les têtes, jamais à l'intérieur d'une tête. |
| T9 | Documents normatifs ou agilité | La documentation sert de modèle de soi au système : changer un document change le système. | Agilité : le système écrit les réglages ratifiés. | Après ratification au point de gouvernance de la tête (a2d/CP-4, a2t/CP-4), son `referentiel` reporte lui-même les valeurs ajustées dans ses documents. La constitution — invariants, points de contrôle et planchers, bornes des règles — reste écrite par l'humain seul. Une constitution modifiée attend sa ratification, sans empêcher le démarrage (I7, D12, AM-18). |
| T10 | Parallélisme ou simplicité | Préparer les tests pendant la réalisation, ou avancer la demande suivante pendant une campagne, raccourcit la boucle mais multiplie les états. | Parallélisme en pipeline, sur une instance. | Plusieurs demandes actives, chacune dans son arbre ; l'instance est prise de la livraison au rapport, une campagne à la fois ; le plan de tests part dès sa production (D22, H4). Un recouvrement de fichiers entre demandes actives est signalé en a2d/CP-2 (a2d/T7). |

### 5.2 Arbitrée le 4 octobre

| # | Tension | Exigences en conflit | Arbitrage | Conséquence |
|---|---|---|---|---|
| T2 | Co-dérive des deux têtes | Deux systèmes qui s'ajustent l'un à l'autre peuvent converger vers un état faux mais cohérent : un code et des tests d'accord sur un comportement que personne n'a demandé. Le même moteur (T3) et l'autonomie (T1) aggravent le risque : la panne de mode commun devient possible, et les décisions humaines qui permettent de voir la dérive se raréfient. | Audit par échantillon à chaque clôture, en plus des parades proposées. | Oracle ancré par l'humain (I2), jamais négocié entre têtes. Attendus dérivés de l'oracle, jamais du code ni d'une réparation (AM-11), vérifiés à l'import (AM-17). Contextes séparés (I8). Fiabilité croisée mesurée contre l'arbitrage humain. À chaque clôture, une personne confirme un critère « conforme » tiré au hasard : la dérive reste mesurable. Un désaccord rouvre la tâche et compte contre la fiabilité croisée des têtes. Mécanisme et parades : `01-architecture.md` §6.4. |

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
| 3 | Spécifications détaillées : spécifications communes (contrat, journal, stockage, convention documentaire) et leurs vecteurs de conformité ; modules d'Agent2Dev ; module `liaison` d'Agent2Test ; outils MCP ; algorithmes du dossier technique et de la convergence ; la file relève de n8n | contrats et formats |
| 4 | Backlog modulaire priorisé, roadmap de maturité, stratégie et plan de tests du binôme | priorités, paliers, stratégie |
| 5 | Prompts système : les sept fiches d'Agent2Dev, `GEMINI.md`, consignes du mode accompagné, posture de réfutation pour Agent2Test | rôles, consignes, schémas de sortie |
| 6 | Code exécutable par lots, chacun jouable en simulation avec ses tests : 6a noyau d'Agent2Dev · 6b substrat · 6c fiches et orchestrateur · 6d liaison et simulateur d'Agent2Test · 6e premier et second ordres · 6f tableau de bord, vue binôme, MCP | un point par lot |
| 7 | Déploiement : Docker Compose (profils `souverain` et `conteneur`), scripts bash et `.cmd` en ASCII, configuration Gemini (CLI et IDE), application témoin | démarrage sur votre poste |
| 8 | Recette contre la Definition of Done : dialogue complet Agent2Dev ↔ Agent2Test, d'abord avec le simulateur, puis avec Agent2Test quand il existe ; guide de démarrage | Definition of Done |

Le contrat entre les têtes est `binome-7e/1` (§3.2) : le protocole binôme de l'étape 2 établit la correspondance des messages du contrat d'échange avec cette enveloppe, et le déploiement de l'étape 7 compte n8n, Postgres et Gitea.

## 8. Registre de ratification

| Objet | Où | Statut |
|---|---|---|
| Réponses du 27 septembre et leurs conséquences | §3.1 | ratifiées le 4 octobre |
| Couplage par n8n | §3.2 | ratifié le 4 octobre ; conséquences reportées le même jour |
| Hypothèses H1 à H17 | §4 | ratifiées le 4 octobre ; H4, H6 à H8, H11 et H13 révisées le 28 septembre ; H16 et H17, nouvelles le 28, confirmées le 4 octobre ; H1, H4, H7 et H11 révisées le 4 octobre |
| Tensions T1 et T3 à T10 | §5.1 | arbitrées le 28 septembre |
| Tension T2 | §5.2 | arbitrée le 4 octobre |
| Décisions D1 à D22 | `01-architecture.md` §11 | ratifiées le 4 octobre ; D1, D2, D4, D5, D9, D19 et D22 amendées pour le couplage par n8n |
| Invariants I1 à I8 du binôme | `01-architecture.md` §6.5 | ratifiés le 4 octobre |
| Spécifications communes et vecteurs de conformité | `01-architecture.md` §3.2 | ratifiés le 4 octobre |
| Contrat d'échange | `01-architecture.md` §4 | ratifié le 4 octobre ; porté entre les têtes par `binome-7e/1` |
| Régimes de contrôle et enveloppe d'autonomie | `01-architecture.md` §5 | ratifiés le 4 octobre |
| Convention documentaire | `01-architecture.md` §9 | ratifiée le 4 octobre |
| Amendements AM-1 à AM-18 d'Agent2Test | `01-architecture.md` §12 | ratifiés le 4 octobre, à appliquer à l'étape 2 ; AM-7 retiré |
| Plan des étapes | §7 | ratifié le 4 octobre |
| Documents d'Agent2Dev | `agent2dev/docs/`, leur propre registre | ratifiés le 4 octobre |
