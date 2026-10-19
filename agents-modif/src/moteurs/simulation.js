import { court, decamel, normaliser, occurrences, racines } from '../texte.js';

/**
 * Moteur de simulation : déterministe, sans réseau.
 *
 * Il produit des sorties conformes aux fiches à partir des entrées structurées,
 * de manière à exercer toute la chaîne — validation, points de contrôle, boucle
 * observant / apprenant, vérification et application du code — sans modèle.
 * Il réagit aux leçons et aux corrections pour que leur effet soit visible.
 * Ses productions sont marquées [simulation] et n'ont aucune valeur métier.
 */
export class MoteurSimulation {
  constructor() {
    this.nom = 'simulation';
  }

  async completer({ phase, entree = {}, lecons = [], correction = null }) {
    const producteur = this[phase];
    if (!producteur) throw new Error(`Simulation : phase inconnue ${phase}`);
    return { texte: JSON.stringify(producteur.call(this, entree, lecons, correction)), usage: null };
  }

  analyse({ demande, contexteCode }) {
    const fichiers = contexteCode?.fichiers ?? [];
    return {
      resume: `[simulation] ${court(demande.texte, 160)}`,
      perimetre: fichiers.slice(0, 3).map((f) => `Comportement porté par ${f.chemin}`),
      horsPerimetre: ['Écrans et composants Angular non cités par la demande'],
      fichiersImpactes: (fichiers.length ? fichiers.slice(0, 3) : [{ chemin: 'À identifier', score: 0 }]).map((f) => ({
        chemin: f.chemin,
        raison: `${f.score} correspondance(s) avec les termes de la demande`
      })),
      risques: ['Régression sur les appels existants de la méthode modifiée'],
      questions: []
    };
  }

  cahier({ demande }, lecons, correction) {
    const criteres = [
      { code: 'CA-1.1', texte: `Le comportement demandé est observable : ${court(demande.texte, 100)}` },
      { code: 'CA-1.2', texte: 'Les cas hors du périmètre de la demande restent inchangés.' }
    ];
    lecons.forEach((l, i) => criteres.push({ code: `CA-1.${3 + i}`, texte: `[leçon ${l.id}] ${l.regle}` }));
    if (correction) criteres.push({ code: `CA-1.${criteres.length + 1}`, texte: `[correction] ${correction}` });
    return {
      demandeReformulee: `[simulation] ${court(demande.texte, 200)}`,
      hypotheses: [{ code: 'H1', texte: 'Le comportement actuel est celui décrit par le code fourni.' }],
      decisions: correction ? [`Correction opérateur intégrée : ${correction}`] : [],
      us: [
        {
          code: 'US-1',
          titre: court(demande.titre ?? demande.texte, 60),
          enTantQue: 'utilisateur de Cockpit CA',
          jeVeux: court(demande.texte, 120),
          afinDe: 'disposer du comportement attendu',
          criteres
        }
      ]
    };
  }

  preconisation({ analyse }) {
    const cible = analyse?.fichiersImpactes?.[0]?.chemin ?? 'le service concerné';
    return {
      options: [
        {
          code: 'O1',
          libelle: `Modification ciblée dans ${cible}`,
          avantages: ['Changement localisé', 'Testable unitairement'],
          inconvenients: ['Règle portée par la couche service uniquement'],
          effort: 'faible'
        },
        {
          code: 'O2',
          libelle: 'Validation en amont, au niveau du contrôleur ou du DTO',
          avantages: ['Rejet au plus tôt'],
          inconvenients: ['Ne protège pas les appels internes au service'],
          effort: 'faible'
        }
      ],
      recommandation: { option: 'O1', justification: '[simulation] Changement le plus localisé, couvre tous les appelants.' },
      pointsDeVigilance: ['Conserver le caractère transactionnel de la méthode modifiée']
    };
  }

  developpement({ demande, cahier, contexteCode }) {
    const critere = cahier?.us?.[0]?.criteres?.[0]?.code ?? 'CA-1.1';
    const cles = racines(demande.texte);
    for (const fichier of contexteCode?.fichiers ?? []) {
      const ligne = choisirLigne(fichier.contenu, cles);
      if (!ligne) continue;
      const retrait = ligne.match(/^\s*/)[0];
      return {
        modifications: [
          {
            fichier: fichier.chemin,
            avant: ligne,
            apres: `${ligne}\n${retrait}    // [simulation] point d'insertion — ${court(demande.texte, 80)}`,
            justification: '[simulation] Ancre unique choisie dans la méthode la plus proche de la demande.',
            critere
          }
        ],
        nouveauxFichiers: []
      };
    }
    return {
      modifications: [],
      nouveauxFichiers: [
        { fichier: 'NOTE-SIMULATION.md', contenu: `Aucune ancre trouvée pour : ${demande.texte}\n`, critere }
      ]
    };
  }

  distillation({ commentaire }) {
    return { regle: court(commentaire, 300) };
  }
}

/** Signature de méthode unique dans le fichier, de préférence proche des termes de la demande. */
function choisirLigne(contenu = '', cles = []) {
  const candidates = contenu
    .split('\n')
    .filter((l) => /\)\s*(throws\s+[\w.,\s]+)?\{\s*$/.test(l))
    .filter((l) => !/^\s*(if|for|while|switch|catch|else|try)\b/.test(l))
    .filter((l) => !/^\s*(public|protected|private)\s+[A-Z]\w*\s*\(/.test(l)) // constructeurs
    .filter((l) => occurrences(contenu, l) === 1);
  const nom = (l) => normaliser(decamel(l.match(/(\w+)\s*\(/)?.[1] ?? ''));
  const score = (l) => cles.filter((c) => nom(l).includes(c)).length * 10 + cles.filter((c) => normaliser(l).includes(c)).length;
  return candidates.sort((a, b) => score(b) - score(a))[0] ?? null;
}
