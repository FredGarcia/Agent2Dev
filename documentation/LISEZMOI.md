# Documentation · méta-projet 12 facteurs × 7E

Ce dossier accompagne le dépôt, livré à côté de lui dans la même archive. La documentation du méta-projet vit dans le dépôt ; les rendus PDF, la spécification du binôme, la ratification destinée au dépôt d'Agent2Dev et le kit du profil localhost.

## Où est quoi

| Chemin | Contenu |
| --- | --- |
| `../meta-12f-7e/docs/` | Dans le dépôt, versionnés avec lui : le modèle exécutif (export du document Claude Docs), la vue d'ensemble (Mermaid et son rendu SVG), le profil localhost. Index : `docs/README.md` |
| `pdf/modele-executif-12f-7e.pdf` | Le document « Modèle exécutif 12 facteurs × 7E », export PDF de Claude Docs, révision 41 (14 pages) |
| `pdf/profil-localhost-12-facteurs-7e.pdf` | Le profil localhost, rendu A4 du Markdown du dépôt (46 pages) |
| `pdf/binome-cybernetique-7e-12-facteurs.pdf` | La spécification du binôme, export PDF de Claude Docs, révision 44 (20 pages) |
| `binome/` | La même spécification en Markdown, avec ses deux schémas |
| `agent2dev/` | La ratification du 4 octobre pour le dépôt `FredGarcia/Agent2Dev` : la branche `ratification-etape-1` en bundle git, les mêmes commits en patchs, le texte de la PR |
| `kit-profil-localhost/` | Les 30 fichiers de référence du profil localhost (annexes A.1 à A.30), prêts à copier |

## Pourquoi deux endroits

Le dépôt ne porte que ce qui décrit le méta-projet. Le binôme est un projet distinct, qui aura son propre dépôt, comme Agent2Dev et Agent2Test. Le kit est le squelette d'un autre projet, un rang plus bas. Placés dans le dépôt, ses Dockerfile, fichiers compose et fichiers .conf seraient lus par les contrôles de motif du modèle et compteraient dans le cycle du méta-projet ; le Markdown, le SVG et le PNG de `docs/` ne le sont pas.

## La ratification pour Agent2Dev

Le connecteur GitHub de la session n'a pas le droit d'écrire sur `FredGarcia/Agent2Dev` : la branche est livrée ici. Elle part du `main` actuel du dépôt (commit `49e4ca3`) et porte deux commits : `a8cee64`, la ratification de l'étape 1, puis `de9daf0`, le régime d'a2d/CP-1 à la mission arbitré le même jour (le plancher, `differe`). Depuis un clone à jour du dépôt :

```bash
git fetch <chemin>/documentation/agent2dev/agent2dev-ratification-etape-1.bundle ratification-etape-1:ratification-etape-1
git push -u origin ratification-etape-1
```

Puis ouvrir la PR vers `main` avec le texte de `agent2dev/PR.md`. Les deux patchs (`git am 0001-*.patch 0002-*.patch`) donnent les mêmes commits, si l'on préfère partir de son propre clone.

## Le kit du profil localhost

| Dans le kit | Sur le poste |
| --- | --- |
| `app/` | La racine du dépôt de l'application, la cellule de rang N |
| `observabilite/` | Le projet d'observabilité du poste, rang N-1 (Alloy, Loki, Grafana) |
| `consommateur/` | L'épreuve du service exposé, rang N+1 (FR.1) |
| `poste/systemd/7e-cycle.service`, `7e-cycle.timer` | `~/.config/systemd/user/` |
| `poste/config-7e/gitea.env` | `~/.config/7e/gitea.env`, hors de tout dépôt |

Chaque fichier est identique, à l'octet, à son annexe dans la section 11 du profil. Les copies locales `.env.dev` et `.env.prod` ne sont pas livrées : `scripts/7e-init.sh` les crée depuis `.env.example`, et Git les ignore.

Le 1er octobre 2026, les fichiers compose ont été validés par Compose, le proxy par `nginx -t`, la collecte par Alloy, les scripts par ShellCheck et le workflow par actionlint. La logique des scripts n'a été éprouvée que contre un faux démon Docker : elle reste à confirmer au premier lancement sur le poste.

## Ce qui fait foi

Les deux documents Claude Docs sont vivants. Le Markdown et les PDF livrés ici en sont des instantanés, faits le 4 octobre 2026 :

- Modèle exécutif 12 facteurs × 7E : <https://claude.ai/code/artifact/0afadfec-2686-44c8-beb2-11c96474b8d0>
- Binôme cybernétique 7E × 12 facteurs : <https://claude.ai/code/artifact/6ebc715b-9431-4106-bac5-108df8374258>

Le modèle que le résolveur exécute est `meta-12f-7e/modele-executif-12f-7e.yaml`, en version 0.5.0, en attente de son cycle (cycle 5) et de sa publication ; le document en est la lecture humaine. Les versions publiées sont les tags du dépôt, `v0.2.1`, `v0.2.2`, `v0.3.0` et `v0.4.0`, chacun posé après un cycle clos (README du dépôt, « Versions publiées »). La spécification du binôme est ratifiée : sa décision 2 le 3 octobre 2026, les neuf autres le 4 octobre 2026. L'interface de recette en montre l'état, d'après l'extrait `meta-12f-7e/recette/workflows.yaml`.
