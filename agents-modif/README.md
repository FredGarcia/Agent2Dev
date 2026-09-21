# Atelier de modification — agents génériques, observant, apprenant

Une demande de modification de code entre ; quatre livrables sortent, chacun
ratifié par l'opérateur avant d'alimenter le suivant :

1. **Analyse** — périmètre, fichiers impactés, risques, questions ;
2. **Cahier des charges** — règle métier, hypothèses, décisions, US avec critères
   d'acceptation numérotés ;
3. **Préconisations** — options, recommandation, points de vigilance ;
4. **Code à modifier** — remplacements « avant / après » vérifiés contre le dépôt,
   appliqués sur une copie.

Même socle que le banc de test : Node 20, aucune dépendance, un bus, des agents
qui ne se connaissent que par leur nom, un journal, un tableau de bord opérateur,
un orchestrateur et un ordonnanceur distincts, un mode simulation complet.

## Agents

| Agent | Rôle |
|---|---|
| `analyste`, `redacteur`, `preconisateur`, `developpeur` | **Une seule classe** (`AgentGenerique`), quatre fiches (`fiches/*.json`) : rôle, consignes, entrées retenues, schéma de sortie, contrôles de cohérence. |
| `depot` | Seul accès au code : explore et classe les fichiers pertinents, vérifie que chaque bloc « avant » existe exactement une fois, applique sur une copie. Lecture seule sur le dépôt, chemins confinés. |
| `orchestrateur` | Déroule une demande : leçons → proposition → vérification du code → point de contrôle → décision transmise à l'apprenant. |
| `ordonnanceur` | File des demandes, une à la fois ; écrit `livrable.md` et `resultat.json`. |
| `observant` | Ne produit rien. Lit les traces du bus et les événements ; mesure par phase le taux de validation et de premier passage, lève une alerte en cas de dérive, **mesure l'effet de chaque leçon**. |
| `apprenant` | Transforme une correction ou un rejet commenté en leçon ; l'injecte dans la fiche de sa phase une fois ratifiée ; la suspend si l'observant montre qu'elle dégrade le taux de validation. |
| `journal` | Une ligne JSON par trace et par événement, un fichier par jour. |
| `tableau-de-bord` | Interface opérateur (HTTP + SSE) : soumettre, trancher, gérer les leçons, lire les mesures. |

## Les trois boucles

- **Premier ordre, sans humain** — une sortie non conforme au schéma ou aux
  contrôles (`criteresUniques`, `recommandationConnue`, `avantNonVide`…) est
  renvoyée au moteur avec ses écarts (`tentativesSchema`).
- **Point de contrôle opérateur** — valider, renvoyer avec correction (commentaire
  obligatoire), rejeter. Aucune phase ne consomme une sortie non validée.
- **Second ordre** — l'apprenant apprend des corrections ; l'observant observe
  l'apprentissage lui-même. Une leçon active, exposée au moins `expositionMin`
  fois, dont le taux de validation est inférieur à la référence de plus de
  `margeRetrait`, est suspendue avec son motif. Cycle d'une leçon :
  `candidate → active (ratifiée) → suspendue (mesure ou opérateur)`.

## Lancer

Le dépôt à analyser est obligatoire (`DEPOT` ou `depot.racine` dans
`config/atelier.json`) ; sans lui, l'atelier refuse de démarrer.

```bash
DEPOT=/chemin/vers/cockpit-ca npm start                                # simulation
DEPOT=/chemin/vers/cockpit-ca MODE=reel ANTHROPIC_API_KEY=… npm start  # moteur réel
```

Tableau de bord : http://127.0.0.1:4600

Variables : `MODE`, `DEPOT`, `AUTO=1` (points de contrôle validés automatiquement),
`PORT`, `DONNEES` (leçons et journal).

## Moteur

`src/moteurs/` : `simulation` (déterministe, sans réseau, sorties marquées
`[simulation]`) et `claude` (API Messages). Tout moteur respecte
`completer({ systeme, message }) → { texte, usage }` : une passerelle LLM interne
se branche en ajoutant un fichier et une ligne dans `creerMoteur`.

**Avant tout usage en mode réel sur le code de la mission, faire valider que
l'envoi d'extraits de code source vers le moteur choisi est autorisé.** L'agent
dépôt borne ce qui part (`maxFichiers`, `maxCaracteresParFichier`), mais ne
remplace pas cette autorisation.

## Étendre

Ajouter une phase = ajouter `fiches/5-xxx.json` (`code`, `ordre`, `agent`,
`livrable`, `entrees`, `role`, `consignes`, `schema`, `controles`). Un nouveau
contrôle de cohérence s'ajoute dans `src/validateur.js`.

## Limites connues

- L'exploration du dépôt est lexicale (racines de 6 caractères + indices
  fournis). Sur un gros dépôt, renseigner `indices` avec les classes visées.
- Les remplacements « avant / après » supposent des blocs uniques ; un bloc
  ambigu ou introuvable est signalé à l'opérateur, jamais appliqué.
- L'état des demandes est en mémoire ; seuls leçons, journal et livrables persistent.
