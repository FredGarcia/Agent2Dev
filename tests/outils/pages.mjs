/**
 * Outils des suites qui éprouvent l'interface : l'accessibilité structurelle
 * d'une page rendue, ce qu'un audit automatique vérifie d'abord (langue, titre,
 * h1 unique, lien d'évitement, étiquettes, légendes et portées des tableaux,
 * alternatives des images). L'audit complet (axe-core) se fait à part.
 */

export function defautsAccessibilite(html) {
  const defauts = [];
  if (!/<html lang="fr">/.test(html)) defauts.push('langue');
  if (!/<title>[^<]+<\/title>/.test(html)) defauts.push('titre');
  if ((html.match(/<h1[\s>]/g) ?? []).length !== 1) defauts.push('h1 unique');
  if (!html.includes('href="#contenu"') || !html.includes('id="contenu"')) defauts.push('lien d’évitement');
  for (const [, id] of html.matchAll(/<(?:input|select|textarea)\b[^>]*\bid="([^"]+)"[^>]*>/g)) if (!html.includes(`for="${id}"`)) defauts.push(`étiquette de ${id}`);
  for (const m of html.matchAll(/<input\b(?![^>]*\btype="hidden")(?![^>]*\bid=)[^>]*>/g)) {
    const avant = html.slice(Math.max(0, m.index - 7), m.index);
    if (avant !== '<label>') defauts.push(`champ sans étiquette : ${m[0].slice(0, 40)}`);
  }
  if ((html.match(/<table[\s>]/g) ?? []).length !== (html.match(/<caption>/g) ?? []).length) defauts.push('légende de tableau');
  if (/<th(?![^>]*\bscope=)[\s>]/.test(html)) defauts.push('en-tête sans portée');
  if (/<img(?![^>]*\balt=)/.test(html)) defauts.push('image sans alternative');
  return defauts;
}
