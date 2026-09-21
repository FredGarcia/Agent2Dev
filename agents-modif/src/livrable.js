/**
 * Livrable Markdown d'une demande — fonction pure, sans entrée/sortie.
 * Sections : analyse, cahier des charges (règle, hypothèses, US, CA),
 * préconisations, code à modifier, traçabilité de la boucle.
 */
export function genererLivrable({ demande, resultat, lecons = [], bilan = null }) {
  const L = resultat.livrables ?? {};
  const s = [];
  s.push(`# ${demande.id} — ${demande.titre}`, '');
  s.push(`Statut : **${resultat.statut}**${resultat.phase ? ` (phase ${resultat.phase})` : ''}`, '');
  s.push('> ' + demande.texte.split('\n').join('\n> '), '');

  if (L.analyse) {
    const a = L.analyse;
    s.push('## 1. Analyse', '', a.resume, '');
    liste(s, 'Périmètre', a.perimetre);
    liste(s, 'Hors périmètre', a.horsPerimetre);
    s.push('Fichiers impactés :', '', '| Fichier | Raison |', '|---|---|');
    for (const f of a.fichiersImpactes) s.push(`| \`${f.chemin}\` | ${cellule(f.raison)} |`);
    s.push('');
    liste(s, 'Risques', a.risques);
    liste(s, 'Questions ouvertes', a.questions);
  }

  if (L.cahier) {
    const c = L.cahier;
    s.push('## 2. Cahier des charges', '', `**Règle** : ${c.demandeReformulee}`, '');
    if (c.hypotheses?.length) liste(s, 'Hypothèses', c.hypotheses.map((h) => `**${h.code}** — ${h.texte}`));
    liste(s, 'Décisions', c.decisions);
    for (const us of c.us) {
      s.push(`### ${us.code} — ${us.titre}`, '', `En tant que ${us.enTantQue}, je veux ${us.jeVeux}, afin de ${us.afinDe}.`, '');
      for (const ca of us.criteres) s.push(`- **${ca.code}** ${ca.texte}`);
      s.push('');
    }
  }

  if (L.preconisation) {
    const p = L.preconisation;
    s.push('## 3. Préconisations', '', '| Option | Libellé | Effort | Avantages | Inconvénients |', '|---|---|---|---|---|');
    for (const o of p.options) {
      s.push(`| ${o.code} | ${cellule(o.libelle)} | ${o.effort} | ${cellule(o.avantages.join(' ; '))} | ${cellule(o.inconvenients.join(' ; '))} |`);
    }
    s.push('', `**Recommandation : ${p.recommandation.option}** — ${p.recommandation.justification}`, '');
    liste(s, 'Points de vigilance', p.pointsDeVigilance);
  }

  if (L.developpement) {
    const d = L.developpement;
    const statuts = new Map((resultat.verification?.resultats ?? []).map((r) => [r.index, r.statut]));
    s.push('## 4. Code à modifier', '');
    d.modifications.forEach((m, i) => {
      s.push(`### ${i + 1}. \`${m.fichier}\` — ${m.critere}`, '', m.justification, '', `Vérification : **${statuts.get(i) ?? 'non vérifiée'}**`, '');
      s.push('```diff', ...m.avant.split('\n').map((l) => `- ${l}`), ...m.apres.split('\n').map((l) => `+ ${l}`), '```', '');
    });
    for (const n of d.nouveauxFichiers ?? []) {
      s.push(`### Nouveau fichier \`${n.fichier}\`${n.critere ? ` — ${n.critere}` : ''}`, '', '```', n.contenu, '```', '');
    }
    if (resultat.application) {
      s.push(`Fichiers écrits dans \`fichiers/\`, à côté de ce livrable (le dépôt n'est jamais modifié) : ${resultat.application.ecrits.map((e) => `\`${e}\``).join(', ') || 'aucun'}.`);
      if (resultat.application.ignorees.length) {
        s.push('', 'Modifications non appliquées :', ...resultat.application.ignorees.map((x) => `- \`${x.fichier}\` : ${x.motif}`));
      }
      s.push('');
    }
  }

  s.push('## 5. Traçabilité de la boucle', '', '| Phase | Itération | Décision | Commentaire | Leçons injectées | Tentatives |', '|---|---|---|---|---|---|');
  for (const h of resultat.historique ?? []) {
    s.push(`| ${h.phase} | ${h.iteration} | ${h.decision} | ${cellule(h.commentaire ?? '')} | ${h.lecons.join(', ') || '—'} | ${h.tentatives} |`);
  }
  s.push('');

  const actives = lecons.filter((l) => l.statut === 'active');
  if (actives.length) {
    s.push('### Leçons actives à la livraison', '');
    for (const l of actives) s.push(`- **${l.id}** (${l.phase}, ${l.occurrences} occurrence(s)) ${l.regle}`);
    s.push('');
  }
  if (bilan?.phases) {
    s.push('### Observation', '', '| Phase | Propositions | Validées | Corrigées | Rejetées | 1er passage | Échecs schéma |', '|---|---|---|---|---|---|---|');
    for (const [phase, b] of Object.entries(bilan.phases)) {
      s.push(`| ${phase} | ${b.propositions} | ${b.validees} | ${b.corrigees} | ${b.rejetees} | ${pct(b.premierPassage)} | ${b.echecsSchema} |`);
    }
    s.push('');
  }
  return s.join('\n');
}

function liste(s, titre, elements) {
  if (!elements?.length) return;
  s.push(`${titre} :`, '', ...elements.map((e) => `- ${e}`), '');
}

const cellule = (t) => String(t ?? '').replaceAll('|', '\\|').replaceAll('\n', ' ');
const pct = (x) => (x === null || x === undefined ? '—' : `${Math.round(x * 100)} %`);
