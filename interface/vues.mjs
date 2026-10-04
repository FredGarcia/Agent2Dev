/**
 * Gabarits HTML de l'interface de recette : rendu serveur, sans JavaScript.
 *
 * Accessibilité (RGAA 4.1 / WCAG 2.1 AA) :
 *   - langue déclarée, titre de page unique et descriptif, un seul h1 ;
 *   - lien d'évitement, régions (en-tête, navigation, contenu, pied), fil
 *     d'Ariane, page courante signalée (aria-current) ;
 *   - tableaux avec légende (caption) et en-têtes de colonne ou de ligne (scope) ;
 *   - chaque champ a son étiquette, son aide reliée (aria-describedby), son
 *     erreur reliée et signalée (aria-invalid) ; un récapitulatif des erreurs
 *     en tête de formulaire, avec un lien vers chaque champ ;
 *   - un statut n'est jamais porté par la seule couleur : symbole et mot ;
 *   - messages de confirmation en région de statut (role="status").
 *
 * Toute valeur insérée passe par h() (échappement) ; seul brut() marque un
 * fragment déjà rendu.
 */

const ECHAPPEMENTS = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const h = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ECHAPPEMENTS[c]);

class Brut {
  constructor(texte) { this.texte = texte; }
  toString() { return this.texte; }
}
/** Fragment HTML déjà sûr. */
export const brut = (texte) => new Brut(String(texte));

function rendre(v) {
  if (v instanceof Brut) return v.texte;
  if (Array.isArray(v)) return v.map(rendre).join('');
  if (v === null || v === undefined || v === false) return '';
  return h(v);
}

/** Gabarit : les valeurs interpolées sont échappées, sauf les fragments brut() et html``. */
export function html(chaines, ...valeurs) {
  let r = '';
  chaines.forEach((c, i) => {
    r += c;
    if (i < valeurs.length) r += rendre(valeurs[i]);
  });
  return new Brut(r);
}

// ── Formats ──────────────────────────────────────────────────────────────────
const NOMBRE = new Intl.NumberFormat('fr-FR');
const DATE = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeStyle: 'short' });
export const nombre = (n) => (n === null || n === undefined ? '—' : NOMBRE.format(Number(n)));
export function duree(s) {
  if (s === null || s === undefined) return '—';
  const v = Number(s);
  if (v < 1) return `${NOMBRE.format(Math.round(v * 1000))} ms`;
  if (v < 120) return `${v.toFixed(1).replace('.', ',')} s`;
  return `${Math.floor(v / 60)} min ${Math.round(v % 60)} s`;
}
const JOUR = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'UTC' });
/** Date seule (AAAA-MM-JJ) → élément <time>, sans heure ni décalage de fuseau. */
export function jour(texte) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(texte ?? ''));
  if (!m) return html`<span>${texte ?? '—'}</span>`;
  return html`<time datetime="${m[0]}">${JOUR.format(new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))))}</time>`;
}

/** Nombre en lettres, de zéro à douze (au-delà : en chiffres). */
const LETTRES = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze'];
export const enLettres = (n) => LETTRES[n] ?? nombre(n);

/** Horodatage PostgreSQL (texte) → élément <time>. */
export function date(texte) {
  if (!texte) return html`<span>—</span>`;
  const d = new Date(String(texte).replace(' ', 'T').replace(/([+-]\d\d)$/, '$1:00'));
  if (Number.isNaN(d.getTime())) return html`<span>${texte}</span>`;
  return html`<time datetime="${d.toISOString()}">${DATE.format(d)}</time>`;
}

// ── Statuts : un symbole et un mot, la couleur en plus ──────────────────────
const LIBELLES = {
  reussi: ['✔', 'réussi'], echoue: ['✖', 'en échec'], erreur: ['⚠', 'en erreur'], omis: ['○', 'omis'], a_faire: ['◌', 'à faire'],
  reussie: ['✔', 'réussie'], echouee: ['✖', 'en échec'], en_cours: ['…', 'en cours'], interrompue: ['■', 'interrompue'],
  non_executee: ['·', 'non exécutée'],
  en_attente: ['⧗', 'en attente'], annulee: ['⊘', 'annulée'], executee: ['✔', 'exécutée'], bloquee: ['■', 'bloquée'],
  ratifiee: ['✔', 'ratifiée'], a_ratifier: ['◌', 'à ratifier'], autre_voie: ['↔', 'autre voie retenue'],
  actif: ['●', 'actif'], absent: ['○', 'absent'], ouverte: ['◌', 'ouverte'], close: ['✔', 'close'],
  viable: ['✔', 'viable'], non_viable: ['✖', 'non viable'], a_blanc: ['◇', 'à blanc, non versionné'],
  regression: ['↘', 'régression'], correction: ['↗', 'correction'], changement: ['↔', 'changement'], nouveau: ['+', 'nouveau'], disparu: ['−', 'disparu'], identique: ['=', 'identique'],
};
export function statut(s) {
  const [symbole, mot] = LIBELLES[s] ?? ['?', s ?? '—'];
  return html`<span class="statut statut-${s ?? 'inconnu'}"><span aria-hidden="true">${symbole}</span> ${mot}</span>`;
}
export const libelleStatut = (s) => (LIBELLES[s] ?? [null, s])[1];

/** Valeur JSON lisible, repliée au-delà de quelques lignes. */
export function valeurJson(v, { resume = 'voir la valeur' } = {}) {
  if (v === null || v === undefined) return html`<span class="vide">—</span>`;
  const compact = JSON.stringify(v);
  if (compact.length <= 80) return html`<code>${compact}</code>`;
  const texte = typeof v === 'string' ? compact : JSON.stringify(v, null, 2);
  return html`<details><summary>${resume} (${nombre(texte.length)} caractères)</summary><pre><code>${texte}</code></pre></details>`;
}

// ── Page ─────────────────────────────────────────────────────────────────────
const NAVIGATION = [
  ['/', 'tableau', 'Tableau de bord'],
  ['/workflows', 'workflows', 'Workflows'],
  ['/declencheurs', 'declencheurs', 'Déclencheurs'],
  ['/suivi', 'suivi', 'Suivi'],
  ['/campagnes', 'campagnes', 'Campagnes'],
  ['/tests', 'tests', 'Tests'],
  ['/comparer', 'comparer', 'Comparer'],
  ['/donnees', 'donnees', 'Données'],
  ['/echange', 'echange', 'Import et export'],
];

/**
 * La page entière. `fil` : [[href, texte], …, [null, texte courant]].
 * `message` : texte de confirmation (role="status").
 * `rafraichir` : secondes avant rechargement ; seulement quand la personne l'a
 * demandé et qu'un lien sur la page l'arrête (RGAA 13.1, WCAG 2.2.1).
 */
export function page({ titre, actif, fil = [], contenu, message = null, alerte = null, rafraichir = null }) {
  const nav = NAVIGATION.map(([href, cle, texte]) => (cle === actif
    ? html`<li><a href="${href}" aria-current="page">${texte}</a></li>`
    : html`<li><a href="${href}">${texte}</a></li>`));
  const ariane = fil.length ? html`<nav class="ariane" aria-label="Fil d’Ariane"><ol>${fil.map(([href, texte], i) => (href && i < fil.length - 1
    ? html`<li><a href="${href}">${texte}</a></li>`
    : html`<li><span aria-current="page">${texte}</span></li>`))}</ol></nav>` : '';
  return `<!doctype html>
${html`<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
${rafraichir ? html`<meta http-equiv="refresh" content="${String(Number(rafraichir))}">` : ''}
<title>${titre} · Pilotage 12 facteurs × 7E</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<a class="evitement" href="#contenu">Aller au contenu</a>
<header class="entete">
  <p class="marque"><a href="/">Pilotage 12 facteurs × 7E</a></p>
  <nav aria-label="Navigation principale"><ul>${nav}</ul></nav>
</header>
<main id="contenu" tabindex="-1">
${ariane}
${message ? html`<div class="message" role="status"><p>${message}</p></div>` : ''}
${alerte ? html`<div class="alerte" role="alert"><p>${alerte}</p></div>` : ''}
${contenu}
</main>
<footer class="pied">
  <p>Méta-projet 12 facteurs × 7E · pilotage et recette · données locales (PostgreSQL)</p>
</footer>
</body>
</html>`}`;
}

// ── Composants ───────────────────────────────────────────────────────────────
/** Tableau accessible : légende, en-têtes de colonnes, première cellule en en-tête de ligne. */
export function tableau({ legende, colonnes, lignes, vide = 'Aucune ligne.', classe = '' }) {
  if (!lignes.length) return html`<p class="vide">${vide}</p>`;
  return html`<div class="defilement"><table class="${classe}">
<caption>${legende}</caption>
<thead><tr>${colonnes.map((c) => html`<th scope="col"${typeof c === 'object' && c.nombre ? brut(' class="nombre"') : ''}>${typeof c === 'object' ? c.texte : c}</th>`)}</tr></thead>
<tbody>${lignes.map((cellules) => html`<tr>${cellules.map((v, i) => {
    const nombreCol = typeof colonnes[i] === 'object' && colonnes[i].nombre;
    const attr = nombreCol ? brut(' class="nombre"') : '';
    return i === 0 ? html`<th scope="row"${attr}>${v}</th>` : html`<td${attr}>${v}</td>`;
  })}</tr>`)}</tbody>
</table></div>`;
}

/** Liste de définitions (fiche). */
export const fiche = (paires) => html`<dl class="fiche">${paires.filter(Boolean).map(([t, d]) => html`<div><dt>${t}</dt><dd>${d}</dd></div>`)}</dl>`;

/**
 * Récapitulatif des erreurs d'un formulaire, avec un lien vers chaque champ.
 * `niveau` : celui de son titre, sous le titre qui porte le formulaire.
 */
export function recapitulatifErreurs(erreurs, champs, { niveau = 2 } = {}) {
  const entrees = Object.entries(erreurs ?? {});
  if (!entrees.length) return '';
  const n = Math.min(6, Math.max(2, Number(niveau) || 2));
  const titre = entrees.length > 1 ? `${entrees.length} erreurs à corriger` : 'Une erreur à corriger';
  return html`<div class="erreurs" role="alert" aria-labelledby="erreurs-titre">
${brut(`<h${n} id="erreurs-titre">`)}${titre}${brut(`</h${n}>`)}
<ul>${entrees.map(([champ, m]) => html`<li><a href="#${champs[champ] ?? champ}">${m}</a></li>`)}</ul>
</div>`;
}

/** Un champ de formulaire étiqueté, avec aide et erreur reliées. */
export function champ({ id, nom = id, etiquette, valeur = '', type = 'text', aide = null, erreur = null, requis = false, zone = false, code = false, lignes = 4, options = null, attributs = '' }) {
  const decrit = [aide ? `${id}-aide` : null, erreur ? `${id}-erreur` : null].filter(Boolean).join(' ');
  const communs = brut(`id="${h(id)}" name="${h(nom)}"${decrit ? ` aria-describedby="${h(decrit)}"` : ''}${erreur ? ' aria-invalid="true"' : ''}${requis ? ' required' : ''} ${attributs}`);
  let controle;
  if (options) {
    controle = html`<select ${communs}>${options.map(([v, t]) => html`<option value="${v}"${String(v) === String(valeur) ? brut(' selected') : ''}>${t}</option>`)}</select>`;
  } else if (zone) {
    controle = code
      ? html`<textarea ${communs} class="code" rows="${lignes}" spellcheck="false">${valeur}</textarea>`
      : html`<textarea ${communs} rows="${lignes}">${valeur}</textarea>`;
  } else {
    controle = html`<input type="${type}" ${communs} value="${valeur}">`;
  }
  return html`<div class="champ${erreur ? ' champ-erreur' : ''}">
<label for="${id}">${etiquette}${requis ? html` <span class="requis">(obligatoire)</span>` : ''}</label>
${aide ? html`<p class="aide" id="${id}-aide">${aide}</p>` : ''}
${erreur ? html`<p class="erreur" id="${id}-erreur"><span aria-hidden="true">⚠</span> ${erreur}</p>` : ''}
${controle}
</div>`;
}

/** Bouton d'action dans son propre formulaire POST (jeton anti-rejeu compris). */
export const boutonPost = ({ action, texte, csrf, classe = '', champs = {}, etiquette = null }) => html`<form method="post" action="${action}" class="en-ligne">
<input type="hidden" name="_csrf" value="${csrf}">
${Object.entries(champs).map(([k, v]) => html`<input type="hidden" name="${k}" value="${v}">`)}
<button type="submit" class="${classe}"${etiquette ? html` aria-label="${etiquette}"` : ''}>${texte}</button>
</form>`;

/** Pagination simple, annoncée. */
export function pagination({ page: n, total, parPage, base }) {
  const pages = Math.max(1, Math.ceil(total / parPage));
  if (pages <= 1) return '';
  const lien = (p, t) => html`<a href="${base}${base.includes('?') ? '&' : '?'}page=${p}">${t}</a>`;
  return html`<nav class="pagination" aria-label="Pagination"><p>Page ${n} sur ${pages}</p><ul>
${n > 1 ? html`<li>${lien(n - 1, 'Page précédente')}</li>` : ''}
${n < pages ? html`<li>${lien(n + 1, 'Page suivante')}</li>` : ''}
</ul></nav>`;
}
