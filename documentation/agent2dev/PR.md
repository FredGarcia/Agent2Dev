# Étape 1 ratifiée le 4 octobre : couplage des deux têtes par n8n

Cette PR reporte la ratification du 4 octobre 2026 dans les documents de l'étape 1. Les quatre documents actifs passent en version 0.3.0, statut `ratifie` ; l'ancien cadrage du binôme (0.1.0) passe au statut `remplace`.

## Ce qui change

| Document | Changements |
|---|---|
| `01-cadrageBinome.md` | §3.2 « La ratification du 4 octobre » (15 points) ; T2 arbitrée par l'audit par échantillon ; H16 et H17 confirmées ; H1, H4, H7 et H11 révisées ; registre à jour |
| `01-architectureBinome.md` | n8n porte le couplage : transport, PR, points humains, limites du catalogue, suspension ; enveloppe `binome-7e/1` entre les têtes ; contestation tranchée par une personne en a2d/CP-5 ; Gitea local, poussée humaine vers GitLab ; licences ; D1, D2, D4, D5, D9, D18, D19, D20 et D22 amendées ; diagrammes §3.1 et §10 redessinés |
| `00-cadrage.md` | T1 à T7 arbitrées ; demande entrée par une issue « à faire » en mode binôme (H1) ; Gitea local (H2, H7) ; registre à jour |
| `01-architecture.md` | file et verrou de l'instance gérés par n8n ; poussée de la branche dédiée vers le Gitea local, après la sonde ; contestation en CP-5 ; modèle réellement utilisé journalisé ; I3, I6 et I14 amendés ; D3, D6 et D20 amendées ; diagramme de la livraison redessiné |
| `binome-etape1-diagrammes.pdf` | régénéré en version 0.3.0, même mise en page |

Amendements constitutionnels à relire en premier : a2d/I3 (seule poussée permise : la branche dédiée vers le Gitea local), a2d/I6 (une contestation est tranchée par une personne ; Agent2Test n'en reçoit que la décision), a2d/I14 (modèle réellement utilisé), bin/D1 (n8n, troisième processus).

## Arbitré le 4 octobre

- **Régime d'a2d/CP-1 à la mission : le plancher, `differe` (D20).** La boucle avance et seule la clôture « conforme » attend l'oracle. La spécification n8n, qui faisait valider les critères avant le plan (`presenter`), est lue avec ce régime : `01-cadrageBinome.md` §3.2, point 15 ; `01-architectureBinome.md` §5.2.

## À trancher

1. **Allers-retours entre les têtes.** Le catalogue de n8n en permet 3 par tâche ; Agent2Dev permet 5 itérations par demande (§6.6). La correspondance entre tâche du catalogue et demande ou itération d'Agent2Dev est renvoyée à l'étape 2 ; la valeur aussi.

## À confirmer

- `binome/` rejoint le dépôt du binôme (H11) : déduit de la clause « si elle est fausse » de l'ancienne H11.
- Les budgets d'appels au moteur et de jetons, que cite la spécification n8n, n'existent pas encore au §6.6 d'Agent2Dev.
- n8n est sous Sustainable Use License, qui permet l'usage interne mais n'est pas open source.
- Le montage réseau qui permet à n8n, dans son conteneur, de joindre les têtes sur `127.0.0.1` est renvoyé à l'étape 7.
- Les points bloquants du binôme (ratifier une PR, fusionner à la mission, auditer) n'ont encore ni identifiant, ni régime, ni plancher.
- L'ancien cadrage 0.1.0 garde ses tableaux normatifs : le vérificateur devra ignorer les documents au statut `remplace`.

## Vérifications

- En-têtes, statuts et `amont` cohérents ; tableaux complets ; aucun identifiant réutilisé.
- Les 13 diagrammes Mermaid se rendent sans erreur (mermaid-cli 11), et chaque légende annonce le bon type UML.
- Relecture indépendante : une quarantaine de constats, tous corrigés ou listés ci-dessus.

🤖 Generated with [Claude Code](https://claude.com/claude-code)

https://claude.ai/code/session_01MC2Pzo3gAnjXYUJLxZ6AdR
