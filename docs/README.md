# Documentation du méta-projet 12 facteurs × 7E

Le modèle que le résolveur exécute est [`modele-executif-12f-7e.yaml`](../modele-executif-12f-7e.yaml). Les documents ci-dessous en donnent la lecture humaine, la vue d'ensemble et l'application à un poste en localhost.

| Document | Ce qu'il dit | À lire |
| --- | --- | --- |
| [Modèle exécutif 12 facteurs × 7E](modele-executif-12f-7e.md) | La finalité, la fractale, le protocole en sept phases, ce que chaque projet déclare, ce que la boucle peut modifier, les 35 critères et leurs preuves attendues | En premier |
| [Vue d'ensemble](vue-ensemble.svg) | Les rangs du méta-projet, les 12 facteurs sur les sept termes et le cycle 7E, sur un seul schéma | Pour situer une pièce dans l'ensemble |
| [Profil localhost](profil-localhost-12-facteurs-7e.md) | Le modèle sur un poste Windows 11 et WSL2, avec Docker et Gitea : preuve de chaque critère, configuration de référence, boucle, fractale, ordre de mise en œuvre, 30 fichiers de référence en annexe | Pour exécuter le modèle sur un projet en local |

Le fonctionnement du dépôt (exécuter un cycle, la recette) est décrit dans le [README](../README.md) à sa racine.

## Provenance

| Fichier | Origine | Pour le mettre à jour |
| --- | --- | --- |
| `modele-executif-12f-7e.md` | Export du document Claude Docs « Modèle exécutif 12 facteurs × 7E » ; la révision exportée figure dans son en-tête | Réexporter le document après chaque révision : il fait foi |
| `images/modele-vue-ensemble.png` | Le schéma de sa section Vue d'ensemble, tel que Claude Docs le rend | Le reprendre avec l'export |
| `vue-ensemble.mmd` | Source Mermaid de la vue d'ensemble détaillée | Éditer ce fichier |
| `vue-ensemble.svg` | Rendu de `vue-ensemble.mmd` par mermaid-cli 11.14.0 | `npx -y @mermaid-js/mermaid-cli@11.14.0 -i docs/vue-ensemble.mmd -o docs/vue-ensemble.svg -b white` |
| `profil-localhost-12-facteurs-7e.md` | Rédigé le 1er octobre 2026 ; ses annexes sont les fichiers de référence, éprouvés à cette date | Éditer ce fichier ; une annexe modifiée se revalide avec l'outil cité dans l'en-tête |

Ces fichiers ne changent aucun contrôle du modèle : les contrôles de motif lisent le code, les Dockerfile, les fichiers YAML et de config, jamais le Markdown, le SVG ni le PNG. Le scan de secrets du critère 3.2 les lit, comme tout le dépôt.
