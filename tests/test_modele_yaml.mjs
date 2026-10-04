/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  test_modele_yaml.mjs : recette du modèle exécutif (modele-executif-12f-7e.yaml)
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Le modèle est un Élément du système (finalite.regles) : il se versionne, se
 *  révise et doit rester exécutable. Cette suite vérifie sa forme et sa
 *  cohérence interne, sans passer par le résolveur sauf pour les constantes
 *  qu'ils partagent (phases, termes) :
 *
 *     1. Lecture            YAML 1.2 = YAML 1.1, sections dans l'ordre
 *     2. Identité           version, date, en-tête, paquet npm
 *     3. Axiome et termes   7 termes, 12 facteurs, 27 critères
 *     4. Second ordre       8 critères, phases de la boucle
 *     5. Contrôles          paramètres par type, documentés, sans faute de frappe
 *     6. Expressions        grep -E, jq et sh acceptent tout ce qu'ils exécuteront
 *     7. Placeholders       formes connues, champs du contrat du manifeste
 *     8. Assertions         comportement des assertions jq sur des données d'essai
 *     9. Boucle et cycle    prérequis, ordre, porteurs, gardes
 *    10. Structure          mutabilité, échelle, fractale, contrats, observation,
 *                           amorçage, versionnage
 *
 *  Une révision du modèle (EQ.2) qui change sa structure doit changer ces tests
 *  dans le même commit : c'est voulu, la révision se voit et se relit.
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, test } from 'node:test';

import { NOMS_PHASES, NOMS_TERMES, PHASES } from '../resolveur7e.mjs';
import { scenario, table } from './outils/etapes.mjs';
import { CHEMIN_MODELE, RACINE } from './outils/depot.mjs';
import { controles, criteres, divergences, jqEvaluer, jqInvalide, lireDocument, neutraliser, nomControle, placeholders, regexInvalide, shellsQuiRefusent } from './outils/yaml.mjs';

const { texte: TEXTE, donnees: M, donnees11: M11 } = lireDocument(CHEMIN_MODELE);
const CONTROLES = controles(M);
const CRITERES = criteres(M);

/** Paramètres de chaque type de contrôle : requis, au moins un de, permis. */
const SCHEMA = {
  commande: { requis: ['commande'], permis: ['attendu', 'pour_chaque', 'pour_chaque_image', 'requiert', 'heuristique'] },
  fichier: { unDe: ['versionne', 'ignore', 'paires'], permis: ['versionne', 'exclure', 'ignore', 'paires', 'requiert', 'heuristique'] },
  motif: { requis: ['motif', 'fichiers'], permis: ['exclure', 'attendu', 'pour_chaque', 'requiert', 'heuristique'] },
  compose: { requis: ['environnement', 'assertion'], permis: ['requiert', 'heuristique'] },
  manifeste: { requis: ['assertion'], permis: ['requiert', 'heuristique'] },
  journal: { requis: ['assertion'], permis: ['requiert'] },
  scenario: { requis: ['script'], permis: ['requiert', 'pour_chaque', 'heuristique'] },
  metrique: { requis: ['indicateur', 'mesure'], permis: ['comparaison', 'ordre_de_grandeur', 'pour_chaque', 'requiert'] },
  declaration: { requis: ['question'], permis: [] },
};
/** Paramètres communs à tous les types, non documentés type par type. */
const COMMUNS = new Set(['type', 'requiert', 'heuristique', 'pour_chaque', 'pour_chaque_image']);

// ════════════════════════════════════════════════════════════════════════════
describe('1. Lecture', () => {
  const ecarts11 = divergences(M, M11);

  // Depuis la 0.2.2, la clé « n » des facteurs est citée : un lecteur YAML 1.1
  // conforme (go-yaml v2, le paquet yaml en mode 1.1…) la lisait comme le
  // booléen false, et les douze numéros de facteur y disparaissaient.
  test('le modèle se lit à l’identique en YAML 1.2 et en YAML 1.1', (t) => table(t, [
    ['une table YAML', () => M !== null && typeof M === 'object' && !Array.isArray(M), true],
    ['lecture 1.1 = lecture 1.2, sans exception (aucun yes/no, octal, date)', () => ecarts11.map((d) => d.chemin), []],
    ['les douze numéros de facteur, lus en 1.1 comme en 1.2', () => M11.termes.flatMap((x) => x.facteurs.map((f) => f.n)).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]],
    ['encodage UTF-8 sans BOM', () => TEXTE.charCodeAt(0) !== 0xfeff, true],
    ['fin de ligne Unix', () => TEXTE.includes('\r\n'), false],
  ]));

  test('les dix-sept sections, dans l’ordre de l’en-tête', (t) => table(t, [
    ['ordre des sections', () => Object.keys(M), ['modele', 'axiome', 'finalite', 'mutabilite', 'echelle', 'synthese', 'chemins', 'types_de_controle', 'termes', 'second_ordre', 'boucle', 'cycle', 'fractale', 'contrats', 'observation_du_modele', 'amorcage', 'versionnage']],
    ['chaque section est nommée dans l’en-tête', () => Object.keys(M).filter((k) => !TEXTE.split('# ───')[0].includes(k)), []],
  ]));
});

// ════════════════════════════════════════════════════════════════════════════
describe('2. Identité', () => {
  const entete = /Version (\S+) \(([^)]+)\) · (\d{4}-\d{2}-\d{2}) · (\S+)/.exec(TEXTE) ?? [];

  test('identifiant, version, date, auteur', (t) => table(t, [
    ['identifiant', () => M.modele.id, 'modele-executif-12f-7e'],
    ['version semver', () => /^\d+\.\d+\.\d+$/.test(String(M.modele.version)), true],
    ['version écrite en texte, jamais en nombre', () => typeof M.modele.version, 'string'],
    ['date ISO entre guillemets (texte)', () => typeof M.modele.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(M.modele.date), true],
    ['auteur', () => M.modele.auteur, 'Fred'],
    ['statut « essai » tant que la version est 0.x', () => String(M.modele.version).startsWith('0.') ? M.modele.statut.startsWith('essai') : true, true],
  ]));

  test('l’en-tête du fichier dit la même chose que la section modele', (t) => table(t, [
    ['version', () => entete[1], String(M.modele.version)],
    ['statut', () => M.modele.statut.startsWith(entete[2]), true],
    ['date', () => entete[3], M.modele.date],
    ['auteur', () => entete[4], M.modele.auteur],
    ['doc compagnon nommé pareil', () => TEXTE.includes(`Compagnon du ${M.modele.compagnon}`), true],
    ['le résolveur nommé dans l’en-tête existe', () => /\(resolveur7e\.mjs/.test(TEXTE) && readFileSync(join(RACINE, 'resolveur7e.mjs'), 'utf8').length > 0, true],
  ]));

  test('le paquet npm du méta-projet porte la version du modèle', (t) => table(t, [
    ['package.json.version = modele.version', () => JSON.parse(readFileSync(join(RACINE, 'package.json'), 'utf8')).version, String(M.modele.version)],
  ]));
});

// ════════════════════════════════════════════════════════════════════════════
describe('3. Axiome, termes, facteurs, critères', () => {
  const NOMS = ['Éléments', 'Espace', 'Engendrent', 'État', 'Expression', 'Évolutif', 'Environnement'];

  test('l’axiome et ses sept termes', (t) => table(t, [
    ['sept termes, dans l’ordre', () => M.axiome.termes, NOMS],
    ['chaque terme figure dans l’énoncé', () => NOMS.filter((n) => !M.axiome.enonce.includes(n.slice(0, -1))), []],
    ['la section termes suit l’axiome', () => M.termes.map((x) => x.nom), NOMS],
    ['identifiants des termes = ceux du résolveur', () => M.termes.map((x) => x.id), Object.keys(NOMS_TERMES).filter((k) => k !== 'second_ordre')],
    ['l’axiome n’est jamais modifiable (statut)', () => /jamais parmi les éléments modifiables/.test(M.axiome.statut), true],
  ]));

  test('les douze facteurs, chacun une fois, sous le bon terme', (t) => {
    const facteurs = M.termes.flatMap((x) => x.facteurs.map((f) => [f.n, f.nom, x.id]));
    table(t, [
      ['12 facteurs, numérotés 1 à 12 une seule fois', () => facteurs.map(([n]) => n).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]],
      ['noms des facteurs', () => Object.fromEntries(facteurs.map(([n, nom]) => [n, nom])), { 1: 'Codebase', 2: 'Dépendances', 3: 'Config', 4: 'Services externes', 5: 'Build, release, run', 6: 'Processus', 7: 'Port binding', 8: 'Concurrence', 9: 'Jetabilité', 10: 'Parité dev/prod', 11: 'Logs', 12: "Processus d'admin" }],
      ['rattachement aux termes', () => Object.fromEntries(facteurs.map(([n, , terme]) => [n, terme])), { 1: 'elements', 2: 'elements', 3: 'espace', 4: 'espace', 5: 'engendrent', 12: 'engendrent', 6: 'etat', 7: 'expression', 11: 'expression', 8: 'evolutif', 9: 'evolutif', 10: 'environnement' }],
      ['chaque terme a un sens', () => M.termes.filter((x) => typeof x.sens !== 'string' || x.sens.length < 10).map((x) => x.id), []],
    ]);
  });

  test('les 27 critères des termes', (t) => {
    const duTerme = M.termes.flatMap((x) => x.criteres.map((c) => [c, x]));
    table(t, [
      ['27 critères', () => duTerme.length, 27],
      ['identifiants en texte (une clé 1.10 non citée deviendrait 1.1)', () => duTerme.filter(([c]) => typeof c.id !== 'string').length, 0],
      ['forme <facteur>.<rang>', () => duTerme.filter(([c]) => !/^\d{1,2}\.\d$/.test(c.id)).map(([c]) => c.id), []],
      ['le préfixe est le facteur déclaré', () => duTerme.filter(([c]) => Number(c.id.split('.')[0]) !== c.facteur).map(([c]) => c.id), []],
      ['le facteur appartient au terme', () => duTerme.filter(([c, x]) => !x.facteurs.some((f) => f.n === c.facteur)).map(([c]) => c.id), []],
      ['rangs consécutifs par facteur, à partir de 1', () => {
        const parFacteur = {};
        for (const [c] of duTerme) (parFacteur[c.facteur] ??= []).push(Number(c.id.split('.')[1]));
        return Object.entries(parFacteur).filter(([, r]) => r.some((x, i) => x !== i + 1)).map(([f]) => f);
      }, []],
    ]);
  });

  test('chacun des 35 critères est complet', (t) => table(t, [
    ['35 critères, identifiants uniques', () => new Set(CRITERES.map(([id]) => id)).size, 35],
    ['un énoncé', () => CRITERES.filter(([, c]) => typeof c.enonce !== 'string' || c.enonce.length < 10).map(([id]) => id), []],
    ['une preuve attendue', () => CRITERES.filter(([, c]) => typeof c.preuve_attendue !== 'string' || c.preuve_attendue.length < 10).map(([id]) => id), []],
    ['au moins un contrôle', () => CRITERES.filter(([, c]) => !Array.isArray(c.controles) || c.controles.length === 0).map(([id]) => id), []],
    ['critères à déclaration : 1.2, 5.3, 10.3', () => CRITERES.filter(([, c]) => c.controles.some((k) => k.type === 'declaration')).map(([id]) => id), ['1.2', '5.3', '10.3']],
    ['une déclaration au plus par critère', () => CRITERES.filter(([, c]) => c.controles.filter((k) => k.type === 'declaration').length > 1).map(([id]) => id), []],
  ]));
});

// ════════════════════════════════════════════════════════════════════════════
describe('4. Second ordre', () => {
  test('huit critères hors des 12 facteurs', (t) => table(t, [
    ['identifiants, dans l’ordre', () => M.second_ordre.criteres.map((c) => c.id), ['EX.1', 'EX.2', 'EV.1', 'EV.2', 'EQ.1', 'EQ.2', 'IN.1', 'FR.1']],
    ['phase de la boucle pour EX, EV, EQ', () => M.second_ordre.criteres.slice(0, 6).map((c) => c.phase), ['examiner', 'examiner', 'evoluer', 'evoluer', 'equilibrer', 'equilibrer']],
    ['IN.1 porte sur l’invariant, FR.1 sur la fractale', () => M.second_ordre.criteres.slice(6).map((c) => c.porte_sur), ['invariant', 'fractale']],
    ['la viabilité se juge sur les six critères de la boucle', () => M.finalite.viabilite.criteres, ['EX.1', 'EX.2', 'EV.1', 'EV.2', 'EQ.1', 'EQ.2']],
    ['l’assertion de viabilité cite les mêmes six critères', () => M.finalite.viabilite.assertion.includes('["EX.1", "EX.2", "EV.1", "EV.2", "EQ.1", "EQ.2"]'), true],
  ]));
});

// ════════════════════════════════════════════════════════════════════════════
describe('5. Contrôles', () => {
  test('types connus, paramètres requis présents', (t) => table(t, [
    ['les neuf types documentés', () => Object.keys(M.types_de_controle.types), Object.keys(SCHEMA)],
    ['chaque contrôle a un type documenté', () => CONTROLES.filter((k) => !Object.hasOwn(SCHEMA, k.ctl.type)).map(nomControle), []],
    ['paramètres requis présents', () => CONTROLES.filter((k) => (SCHEMA[k.ctl.type].requis ?? []).some((p) => k.ctl[p] === undefined)).map(nomControle), []],
    ['fichier : au moins versionne, ignore ou paires', () => CONTROLES.filter((k) => k.ctl.type === 'fichier' && !SCHEMA.fichier.unDe.some((p) => k.ctl[p] !== undefined)).map(nomControle), []],
    ['aucun paramètre inconnu (faute de frappe)', () => CONTROLES.flatMap((k) => Object.keys(k.ctl).filter((p) => p !== 'type' && !(SCHEMA[k.ctl.type].requis ?? []).includes(p) && !SCHEMA[k.ctl.type].permis.includes(p)).map((p) => `${nomControle(k)} : ${p}`)), []],
    ['pour_chaque et pour_chaque_image jamais ensemble', () => CONTROLES.filter((k) => k.ctl.pour_chaque !== undefined && k.ctl.pour_chaque_image !== undefined).map(nomControle), []],
  ]));

  test('valeurs des paramètres', (t) => table(t, [
    ['attendu d’une commande', () => CONTROLES.filter((k) => k.ctl.type === 'commande' && k.ctl.attendu !== undefined && !['code_retour_0', 'sortie_non_vide', 'sortie_vide'].includes(k.ctl.attendu)).map(nomControle), []],
    ['attendu d’un motif', () => CONTROLES.filter((k) => k.ctl.type === 'motif' && k.ctl.attendu !== undefined && !['absent', 'present'].includes(k.ctl.attendu)).map(nomControle), []],
    ['comparaison d’une métrique : <= ou >=', () => CONTROLES.filter((k) => k.ctl.comparaison !== undefined && !['<=', '>='].includes(k.ctl.comparaison)).map(nomControle), []],
    ['heuristique booléen', () => CONTROLES.filter((k) => k.ctl.heuristique !== undefined && typeof k.ctl.heuristique !== 'boolean').map(nomControle), []],
    ['requiert : liste de chemins non vides', () => CONTROLES.filter((k) => k.ctl.requiert !== undefined && (!Array.isArray(k.ctl.requiert) || k.ctl.requiert.some((p) => typeof p !== 'string' || !p))).map(nomControle), []],
    ['requiert : la racine est un champ du contrat du manifeste', () => CONTROLES.flatMap((k) => (k.ctl.requiert ?? []).filter((p) => !Object.hasOwn(M.contrats.manifeste.champs, p.split('.')[0])).map((p) => `${nomControle(k)} : ${p}`)), []],
    ['compose : environnement nommé ou « tous »', () => CONTROLES.filter((k) => k.ctl.type === 'compose' && !(typeof k.ctl.environnement === 'string' && k.ctl.environnement)).map(nomControle), []],
    ['paires : si et alors_un_de non vide', () => CONTROLES.filter((k) => k.ctl.paires && !k.ctl.paires.every((p) => typeof p.si === 'string' && Array.isArray(p.alors_un_de) && p.alors_un_de.length > 0)).map(nomControle), []],
    ['métriques : indicateurs du contrat (seuils.requis)', () => CONTROLES.filter((k) => k.ctl.type === 'metrique').map((k) => k.ctl.indicateur).sort(), M.contrats.manifeste.champs.seuils.requis.filter((i) => i !== 'periode_revue_cycles').sort()],
  ]));

  test('chaque paramètre propre à un type est documenté dans types_de_controle', (t) => table(t, [
    ['paramètres utilisés ⊆ paramètres documentés', () => CONTROLES.flatMap((k) => Object.keys(k.ctl).filter((p) => !COMMUNS.has(p) && !Object.hasOwn(M.types_de_controle.types[k.ctl.type].parametres ?? {}, p)).map((p) => `${nomControle(k)} : ${p}`)), []],
    ['chaque type documente sa résolution, sauf la déclaration', () => Object.entries(M.types_de_controle.types).filter(([, v]) => typeof v.resolution !== 'string').map(([k]) => k), []],
    ['les cinq résultats', () => M.types_de_controle.resultats, ['conforme', 'partiel', 'absent', 'sans_objet', 'erreur']],
    ['les règles du protocole', () => Object.keys(M.types_de_controle.regles), ['requiert', 'sans_objet_automatique', 'erreur', 'pour_chaque', 'heuristique', 'insertion', 'exclusion', 'gardes', 'scenario', 'commandes_du_manifeste', 'delai', 'fichiers_temporaires']],
  ]));

  // regles.gardes (0.3.0) : des deux contrôles d'un critère, avec et sans compose,
  // un seul s'applique. Les gardes sont éprouvées sur des manifestes d'essai ; la
  // 0.4.0 les aligne sur le résolveur (valeur nulle, table vide, false, formes
  // inattendues), et test_resolveur7e.mjs les compare à ses options compose.
  test('gardes : avec compose ou sans, jamais les deux', (t) => {
    const { avec_compose: avec, sans_compose: sans } = M.types_de_controle.gardes;
    const sur = (environnements, test = 'dev') => {
      const m = { environnements, ...(test === null ? {} : { environnement_test: test }) };  // null : non déclaré
      return [jqEvaluer(avec, m), jqEvaluer(sans, m)];
    };
    const garde22 = (cle) => criteres(M).find(([id]) => id === '2.2')[1].controles.filter((k) => k.pour_chaque === cle).map((k) => k.type);
    const garde53 = (cle) => criteres(M).find(([id]) => id === '5.3')[1].controles.filter((k) => k.pour_chaque === cle).map((k) => k.type);
    return table(t, [
      ['deux gardes', () => Object.keys(M.types_de_controle.gardes), ['avec_compose', 'sans_compose']],
      ['environnement de test sans fichiers compose → sans compose', () => sur({ dev: { fichiers: [] } }), [null, { nom: 'dev' }]],
      ['fichiers compose en liste → avec compose', () => sur({ dev: { fichiers: ['compose.yaml'] } }), [{ nom: 'dev' }, null]],
      ['fichier compose en texte → avec compose', () => sur({ dev: { fichiers: 'compose.yaml' } }), [{ nom: 'dev' }, null]],
      ['texte vide ou champ absent → sans compose', () => [sur({ dev: { fichiers: '' } }), sur({ dev: {} })], [[null, { nom: 'dev' }], [null, { nom: 'dev' }]]],
      ['environnement de test inconnu → avec compose, qui le signalera', () => sur({ prod: { fichiers: [] } }), [{ nom: 'dev' }, null]],
      ['environnement de test non déclaré → avec compose, qui le signalera', () => sur({ dev: { fichiers: [] } }, null), [{ nom: null }, null]],
      ['environnement à valeur nulle (dev:) → sans compose', () => sur({ dev: null }), [null, { nom: 'dev' }]],
      ['fichiers : table vide → sans compose ; false → avec compose, qui le signalera', () => [sur({ dev: { fichiers: {} } }), sur({ dev: { fichiers: false } })], [[null, { nom: 'dev' }], [{ nom: 'dev' }, null]]],
      ['environnement écrit en texte → sans compose, sans erreur jq', () => sur({ dev: 'compose.yaml' }), [null, { nom: 'dev' }]],
      ['environnements en liste → avec compose, qui le signalera, sans erreur jq', () => sur([{ dev: {} }]), [{ nom: 'dev' }, null]],
      ['2.2 : scénario avec compose, commande sans', () => [garde22(avec), garde22(sans)], [['scenario'], ['commande']]],
      ['5.3 : scénario avec compose, commande sans', () => [garde53(avec), garde53(sans)], [['scenario'], ['commande']]],
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('6. Expressions : acceptées par les outils qui les exécuteront', () => {
  const champ = (types, cle) => CONTROLES.filter((k) => types.includes(k.ctl.type) && typeof k.ctl[cle] === 'string');

  test('expressions régulières : grep -E les accepte toutes', (t) => table(t, [
    ['chemins partagés', () => Object.entries(M.chemins).filter(([, v]) => regexInvalide(v)).map(([k]) => k), []],
    ['exclusion globale, placeholder neutralisé', () => regexInvalide(neutraliser(M.types_de_controle.exclusion_globale)), false],
    ['l’exclusion globale écarte le journal de l’instance (manifeste.journal)', () => /\^\{\{ manifeste\.journal \}\}\//.test(M.types_de_controle.exclusion_globale), true],
    ['chemins.logging lit toutes les extensions de chemins.code, cjs compris', () => {
      const exts = /\\\.\(([^)]*)\)\$/.exec(M.chemins.code)[1].split('|');
      return [exts.includes('cjs'), exts.filter((e) => !new RegExp(M.chemins.logging).test(`a/b.${e}`)), exts.filter((e) => !new RegExp(M.chemins.code_app).test(`a/b.${e}`))];
    }, [true, [], []]],
    ['chemins.dockerfile_hors écarte ce qui n’est pas un Dockerfile, et seulement cela', () => {
      const [dockerfile, hors] = [new RegExp(M.chemins.dockerfile), new RegExp(M.chemins.dockerfile_hors)];
      const vrais = ['Dockerfile', 'Dockerfile.recette', 'outils/Dockerfile.dev', 'déploiement/Dockerfile'];
      const faux = ['Dockerfile.recette.dockerignore', 'Dockerfile.md', 'docker/Dockerfile.j2', 'Dockerfile.orig'];
      return [vrais.filter((f) => !dockerfile.test(f) || hors.test(f)), faux.filter((f) => !dockerfile.test(f) || !hors.test(f))];
    }, [[], []]],
    ['2.2 : le Dockerfile qu’on versionne et ceux qu’on construit sans compose suivent les mêmes chemins', () => {
      const ctl = CRITERES.find(([id]) => id === '2.2')[1].controles;
      return [ctl[0].versionne === M.chemins.dockerfile && ctl[0].exclure === M.chemins.dockerfile_hors, /\{\{ chemins\.dockerfile \}\}.*\{\{ chemins\.dockerfile_hors \}\}/.test(ctl[2].commande)];
    }, [true, true]],
    ['fichiers des motifs', () => champ(['motif'], 'fichiers').filter((k) => regexInvalide(k.ctl.fichiers)).map(nomControle), []],
    ['exclusions des motifs', () => champ(['motif'], 'exclure').filter((k) => regexInvalide(k.ctl.exclure)).map(nomControle), []],
    ['motifs, placeholders neutralisés', () => champ(['motif'], 'motif').filter((k) => regexInvalide(neutraliser(k.ctl.motif))).map(nomControle), []],
    ['versionne, placeholders neutralisés', () => champ(['fichier'], 'versionne').filter((k) => regexInvalide(neutraliser(k.ctl.versionne))).map(nomControle), []],
  ]));

  test('assertions jq : jq les compile toutes', (t) => table(t, [
    ['assertions compose', () => champ(['compose'], 'assertion').filter((k) => jqInvalide(k.ctl.assertion)).map(nomControle), []],
    ['assertions sur le manifeste', () => champ(['manifeste'], 'assertion').filter((k) => jqInvalide(k.ctl.assertion)).map(nomControle), []],
    ['assertions sur le journal', () => champ(['journal'], 'assertion').filter((k) => jqInvalide(k.ctl.assertion)).map(nomControle), []],
    ['expressions pour_chaque', () => CONTROLES.filter((k) => typeof k.ctl.pour_chaque === 'string' && jqInvalide(k.ctl.pour_chaque)).map(nomControle), []],
    ['assertion de viabilité', () => jqInvalide(M.finalite.viabilite.assertion), false],
    ['le contrôle d’épreuve refuse bien une expression fausse', () => jqInvalide('.['), true],
  ]));

  test('commandes, scénarios et mesures : sh et bash en acceptent la syntaxe', (t) => table(t, [
    ['commandes', () => champ(['commande'], 'commande').filter((k) => shellsQuiRefusent(neutraliser(k.ctl.commande)).length).map(nomControle), []],
    ['scénarios', () => champ(['scenario'], 'script').filter((k) => shellsQuiRefusent(neutraliser(k.ctl.script)).length).map(nomControle), []],
    ['mesures', () => champ(['metrique'], 'mesure').filter((k) => shellsQuiRefusent(neutraliser(k.ctl.mesure)).length).map(nomControle), []],
    ['le piège de nettoyage documenté', () => shellsQuiRefusent(neutraliser(M.types_de_controle.types.scenario.resolution)), []],
    ['le contrôle d’épreuve refuse bien un script faux', () => shellsQuiRefusent('if then fi'), ['sh', 'bash']],
  ]));
});

// ════════════════════════════════════════════════════════════════════════════
describe('7. Placeholders', () => {
  const tous = CONTROLES.flatMap((k) => Object.entries(k.ctl).filter(([, v]) => typeof v === 'string').flatMap(([p, v]) => placeholders(v).map((cle) => ({ k, p, cle }))));
  const FORME = /^(item|item\.[a-z_]+(\.[a-z_]+)*|manifeste\.[a-z_]+(\.[a-z_<>]+)*|compose\.[a-z_]+|cycle\.(id|release)|chemins\.[a-z_]+)$/;

  test('formes connues, champs du contrat', (t) => table(t, [
    ['des placeholders sont utilisés', () => tous.length > 10, true],
    ['chaque clé a une forme documentée', () => tous.filter((x) => !FORME.test(x.cle)).map((x) => `${nomControle(x.k)} : ${x.cle}`), []],
    ['manifeste.* : la racine est un champ du contrat', () => tous.filter((x) => x.cle.startsWith('manifeste.') && !Object.hasOwn(M.contrats.manifeste.champs, x.cle.split('.')[1])).map((x) => `${nomControle(x.k)} : ${x.cle}`), []],
    ['compose.* jamais dans une expression régulière', () => tous.filter((x) => x.cle.startsWith('compose.') && ['motif', 'versionne', 'fichiers', 'exclure'].includes(x.p)).map((x) => nomControle(x.k)), []],
    ['item seulement sous un pour_chaque', () => tous.filter((x) => x.cle.startsWith('item') && x.k.ctl.pour_chaque === undefined && x.k.ctl.pour_chaque_image === undefined).map((x) => nomControle(x.k)), []],
    ['compose.<env> : test, depot ou un environnement', () => tous.filter((x) => x.cle.startsWith('compose.')).every((x) => /^compose\.(test|depot|[a-z_]+)$/.test(x.cle)), true],
    ['chemins.<nom> : une clé de la section chemins', () => tous.filter((x) => x.cle.startsWith('chemins.') && !Object.hasOwn(M.chemins, x.cle.slice(8))).map((x) => `${nomControle(x.k)} : ${x.cle}`), []],
    ['chemins.* jamais dans une expression régulière (inséré cité pour le shell)', () => tous.filter((x) => x.cle.startsWith('chemins.') && ['motif', 'versionne', 'fichiers', 'exclure'].includes(x.p)).map((x) => nomControle(x.k)), []],
  ]));

  // regles.commandes_du_manifeste (0.4.0) : chaque commande de test du manifeste
  // s'insère entre parenthèses, la fermante seule sur sa ligne, éventuellement
  // suivie d'une redirection.
  test('commandes du manifeste : chacune dans son sous-shell', (t) => {
    const insertions = CONTROLES.flatMap((k) => ['commande', 'script', 'mesure'].filter((p) => typeof k.ctl[p] === 'string').flatMap((p) => {
      const lignes = k.ctl[p].split('\n');
      return lignes.flatMap((l, i) => (/\{\{ manifeste\.tests\./.test(l) ? [{ k, lignes, i }] : []));
    }));
    const ouverte = ({ lignes, i }) => /^\( \{\{ manifeste\.tests\./.test(lignes[i]) || (/^\{\{ manifeste\.tests\.[a-z_.]+ \}\}$/.test(lignes[i]) && /^\( /.test(lignes[i - 1] ?? ''));
    const fermee = ({ lignes, i }) => /^\)( [>&0-9/a-z ]*)?$/.test(lignes[i + 1] ?? '');
    return table(t, [
      ['des insertions de commandes du manifeste', () => insertions.length >= 10, true],
      ['chacune ouvre un sous-shell', () => insertions.filter((x) => !ouverte(x)).map((x) => nomControle(x.k)), []],
      ['la parenthèse fermante seule sur la ligne suivante', () => insertions.filter((x) => !fermee(x)).map((x) => nomControle(x.k)), []],
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('8. Assertions du modèle, éprouvées sur des données d’essai', () => {
  const entree = (scores) => ({ scores: Object.fromEntries(Object.entries(scores).map(([c, score]) => [c, { score }])) });
  const viabilite = (...entrees) => jqEvaluer(M.finalite.viabilite.assertion, entrees);
  const assertionDe = (cid, type) => CRITERES.find(([id]) => id === cid)[1].controles.find((k) => k.type === type).assertion;

  test('viabilité (finalite.viabilite)', (t) => table(t, [
    ['un seul cycle → null', () => viabilite(entree({ 'EX.1': 1 })), null],
    ['EX.1 monte → viable et en progrès', () => viabilite(entree({ 'EX.1': 0 }), entree({ 'EX.1': 1 })), { viable: true, progresse: true }],
    ['rien ne bouge → viable, sans progrès', () => viabilite(entree({ 'EX.1': 1 }), entree({ 'EX.1': 1 })), { viable: true, progresse: false }],
    ['EQ.2 baisse → non viable', () => viabilite(entree({ 'EQ.2': 2 }), entree({ 'EQ.2': 1, 'EX.1': 3 })), { viable: false, progresse: false }],
    ['un score absent ou sans objet d’un côté ne compte pas (0.5.0)', () => [viabilite(entree({}), entree({ 'EV.2': 1 })), viabilite(entree({ 'EV.1': 2 }), entree({ 'EV.1': null }))], [{ viable: true, progresse: false }, { viable: true, progresse: false }]],
    ['seuls les deux derniers cycles comptent', () => viabilite(entree({ 'EX.1': 3 }), entree({ 'EX.1': 0 }), entree({ 'EX.1': 0 })), { viable: true, progresse: false }],
    ['un critère hors de la boucle ne compte pas', () => viabilite(entree({ '3.1': 3 }), entree({ '3.1': 0 })), { viable: true, progresse: false }],
  ]));

  test('assertions sur le manifeste : IN.1, EQ.1, EX.2', (t) => {
    const m = { invariants: ['axiome', 'cycle', 'contrats'], seuils: { periode_revue_cycles: { valeur: 3 }, delai: { valeur: 24 } }, retroaction: [{ indicateur: 'delai', correction: 'ticket' }] };
    table(t, [
      ['IN.1 : axiome, cycle, contrats exemptés', () => jqEvaluer(assertionDe('IN.1', 'manifeste'), m), true],
      ['IN.1 : contrats manquant', () => jqEvaluer(assertionDe('IN.1', 'manifeste'), { invariants: ['axiome', 'cycle'] }), false],
      ['EQ.1 : chaque seuil a sa correction', () => jqEvaluer(assertionDe('EQ.1', 'manifeste'), m), true],
      ['EQ.1 : un seuil sans correction', () => jqEvaluer(assertionDe('EQ.1', 'manifeste'), { ...m, seuils: { ...m.seuils, cout: { valeur: 1 } } }), false],
      ['EQ.1 : correction hors liste', () => jqEvaluer(assertionDe('EQ.1', 'manifeste'), { ...m, retroaction: [{ indicateur: 'delai', correction: 'redemarrer' }] }), false],
      ['EQ.1 : aucune rétroaction', () => jqEvaluer(assertionDe('EQ.1', 'manifeste'), { seuils: {} }), false],
      ['EX.2 : seuils requis présents', () => jqEvaluer(M.second_ordre.criteres[1].controles[0].assertion, m, { requis: ['delai', 'periode_revue_cycles'] }), true],
      ['EX.2 : un seuil requis manque', () => jqEvaluer(M.second_ordre.criteres[1].controles[0].assertion, m, { requis: ['temps_demarrage_s'] }), false],
      ['EX.2 : une valeur nulle', () => jqEvaluer(M.second_ordre.criteres[1].controles[0].assertion, { seuils: { delai: { valeur: null } } }, { requis: ['delai'] }), false],
    ]);
  });

  test('assertions sur le journal : EV.1, EV.2, EQ.1, EQ.2, IN.1', (t) => {
    const close = (extra = {}) => ({ cycle: { contrat_version: '0.2', fin: '2026-10-01T00:00:00Z' }, release: 'r', mesures: [], incidents: [], scores: {}, regressions: [], decisions: [], seuils_revises: [], propositions_modele: [], ...extra });
    table(t, [
      ['EV.1 : un seul cycle → null', () => jqEvaluer(assertionDe('EV.1', 'journal'), [close()]), null],
      ['EV.1 : deux cycles comparables et complets', () => jqEvaluer(assertionDe('EV.1', 'journal'), [close(), close()]), true],
      ['EV.1 : une entrée incomplète', () => jqEvaluer(assertionDe('EV.1', 'journal'), [close(), close({ mesures: null })]), false],
      ['EV.1 : depuis le contrat 0.5, au rang instance, le ticket de la demande est cité', () => [
        jqEvaluer(assertionDe('EV.1', 'journal'), [close(), close({ cycle: { contrat_version: '0.5', niveau: 'instance', fin: 'x' } })]),
        jqEvaluer(assertionDe('EV.1', 'journal'), [close(), close({ cycle: { contrat_version: '0.5', niveau: 'instance', fin: 'x' }, demande: { lien: '0001/jira.mhtml', empreinte: 'ab' } })]),
        jqEvaluer(assertionDe('EV.1', 'journal'), [close(), close({ cycle: { contrat_version: '0.5', niveau: 'meta', fin: 'x' }, demande: null })]),
      ], [false, true, true]],
      ['EV.1 : depuis le contrat 0.5, chaque fichier cité a son lien, sa taille et son empreinte', () => jqEvaluer(assertionDe('EV.1', 'journal'), [close(), close({ cycle: { contrat_version: '0.5', niveau: 'meta', fin: 'x' }, fichiers: [{ lien: '0001/temp/a', octets: 3 }] })]), false],
      ['EV.2 : baisse rattachée à sa release', () => jqEvaluer(assertionDe('EV.2', 'journal'), [close({ scores: { '3.1': { score: 2 } } }), close({ scores: { '3.1': { score: 1 } }, regressions: [{ critere: '3.1', release: 'v2' }] })]), true],
      ['EV.2 : baisse non rattachée', () => jqEvaluer(assertionDe('EV.2', 'journal'), [close({ scores: { '3.1': { score: 2 } } }), close({ scores: { '3.1': { score: 1 } } })]), false],
      ['EV.2 : d’un contrat à l’autre, une baisse se compare aussi (0.5.0)', () => jqEvaluer(assertionDe('EV.2', 'journal'), [close({ scores: { '3.1': { score: 2 } } }), close({ cycle: { contrat_version: '0.3', fin: 'x' }, scores: { '3.1': { score: 1 } } })]), false],
      ['EQ.1 : mesure hors seuil suivie d’une décision', () => jqEvaluer(assertionDe('EQ.1', 'journal'), [close({ mesures: [{ indicateur: 'd', hors_seuil: true }], decisions: [{ indicateur: 'd' }] })]), true],
      ['EQ.1 : mesure hors seuil sans décision', () => jqEvaluer(assertionDe('EQ.1', 'journal'), [close({ mesures: [{ indicateur: 'd', hors_seuil: true }] })]), false],
      ['EQ.2 : révision dans la période de revue', () => jqEvaluer(assertionDe('EQ.2', 'journal'), [close(), close({ propositions_modele: [{ critere: '1.1' }] })], { m: { seuils: { periode_revue_cycles: { valeur: 2 } } } }), true],
      ['EQ.2 : aucune révision sur la période', () => jqEvaluer(assertionDe('EQ.2', 'journal'), [close(), close()], { m: { seuils: { periode_revue_cycles: { valeur: 2 } } } }), false],
      ['EQ.2 : historique plus court que la période → null', () => jqEvaluer(assertionDe('EQ.2', 'journal'), [close()], { m: { seuils: { periode_revue_cycles: { valeur: 3 } } } }), null],
      ['IN.1 : aucune décision ne vise un invariant', () => jqEvaluer(assertionDe('IN.1', 'journal'), [close({ decisions: [{ cible: 'axiome' }] })], { m: { invariants: ['axiome'] } }), false],
    ]);
  });
});

// ════════════════════════════════════════════════════════════════════════════
describe('9. Boucle et cycle', () => {
  test('boucle de second ordre : critères et prérequis', (t) => {
    const deLaBoucle = new Set(M.second_ordre.criteres.map((c) => c.id));
    const desTermes = new Set(M.termes.flatMap((x) => x.criteres.map((c) => c.id)));
    table(t, [
      ['trois phases', () => Object.keys(M.boucle.phases), ['examiner', 'evoluer', 'equilibrer']],
      ['critères propres : du second ordre, de la même phase', () => Object.entries(M.boucle.phases).flatMap(([ph, d]) => d.criteres.filter((c) => !deLaBoucle.has(c) || M.second_ordre.criteres.find((x) => x.id === c).phase !== ph)), []],
      ['prérequis : des critères des 12 facteurs', () => Object.values(M.boucle.phases).flatMap((d) => d.prerequis.filter((p) => !desTermes.has(p))), []],
      ['prérequis d’Examiner : les logs', () => M.boucle.phases.examiner.prerequis, ['11.1', '11.2']],
      ['prérequis d’Évoluer : codebase et releases', () => M.boucle.phases.evoluer.prerequis, ['1.1', '5.2']],
      ['prérequis d’Équilibrer : rollback, concurrence, jetabilité', () => M.boucle.phases.equilibrer.prerequis, ['5.3', '8.1', '9.2', '9.3']],
      ['le blocage plafonne à 1 et ouvre un ticket', () => /plafonnés à 1/.test(M.boucle.blocage) && /ticket/.test(M.boucle.blocage), true],
    ]);
  });

  test('cycle 7E : ordre, noms, porteurs, gardes', (t) => table(t, [
    ['ordre = phases du résolveur', () => M.cycle.ordre, PHASES],
    ['une description par phase, dans l’ordre', () => Object.keys(M.cycle.phases), PHASES],
    ['noms = ceux du résolveur', () => PHASES.map((p) => M.cycle.phases[p].nom), PHASES.map((p) => NOMS_PHASES[p])],
    ['porteurs', () => PHASES.map((p) => M.cycle.phases[p].porteur), ['résolveur', 'résolveur, puis une personne', 'pipeline du projet', 'résolveur', 'résolveur', 'résolveur', 'résolveur, puis une personne']],
    ['gardes : cinq phases sur sept', () => PHASES.filter((p) => M.cycle.phases[p].garde), ['evaluer', 'elaborer', 'executer', 'emettre', 'equilibrer']],
    ['chaque phase a un rôle et une sortie', () => PHASES.filter((p) => !M.cycle.phases[p].role || !M.cycle.phases[p].sortie), []],
    ['Élaborer et Équilibrer gardent l’organisation (IN.1)', () => [M.cycle.phases.elaborer.garde, M.cycle.phases.equilibrer.garde].every((g) => g.includes('IN.1')), true],
  ]));
});

// ════════════════════════════════════════════════════════════════════════════
describe('10. Structure du modèle', () => {
  test('mutabilité : quatre classes, chaque section rangée', (t) => {
    const classes = M.mutabilite;
    const strictes = ['organisation', 'contrats', 'structure'];
    const couvert = (section) => strictes.some((c) => classes[c].elements.some((e) => e === section || e.startsWith(`${section}.`)));
    // Depuis la 0.3.0, la section modele est rangée ; depuis la 0.4.0, champ par
    // champ : son identité est un contrat, sa fiche de version (version, date,
    // statut) suit la structure, et toute publication la met à jour (versionnage.fiche).
    table(t, [
      ['quatre classes, de la plus stricte à la plus libre', () => Object.keys(classes).filter((k) => k !== 'recouvrement'), ['organisation', 'contrats', 'structure', 'local']],
      ['organisation : axiome, ordre du cycle, sa propre liste', () => classes.organisation.elements, ['axiome', 'cycle.ordre', 'mutabilite.organisation']],
      ['chaque section est rangée dans une classe stricte', () => Object.keys(M).filter((s) => !couvert(s)), []],
      ['l’identité du modèle est un contrat ; sa fiche de version, de structure', () => [classes.contrats.elements.filter((e) => e.startsWith('modele.')), classes.structure.elements.filter((e) => e.startsWith('modele.'))], [['modele.id', 'modele.auteur', 'modele.nature', 'modele.role', 'modele.compagnon'], ['modele.version', 'modele.date', 'modele.statut']]],
      ['chaque champ de la section modele, rangé une seule fois', () => Object.keys(M.modele).map((k) => strictes.filter((c) => classes[c].elements.includes(`modele.${k}`)).length), Object.keys(M.modele).map(() => 1)],
      ['le cycle est partagé : l’ordre figé, les phases révisables', () => [classes.organisation.elements.includes('cycle.ordre'), classes.structure.elements.includes('cycle.phases')], [true, true]],
      ['recouvrement : la plus stricte l’emporte', () => /plus stricte/.test(classes.recouvrement), true],
      ['local : les seuils et la rétroaction de l’instance', () => ['manifeste.seuils', 'manifeste.retroaction'].every((e) => classes.local.elements.includes(e)), true],
    ]);
  });

  test('échelle, agrégation, synthèse', (t) => table(t, [
    ['scores 0 à 3', () => M.echelle.scores.map((s) => [s.score, s.nom]), [[0, 'Absent'], [1, 'Partiel'], [2, 'Conforme'], [3, 'Automatisé']]],
    ['règles d’agrégation, dans l’ordre', () => M.echelle.agregation.map((r) => r.score), [null, 2, 0, 1]],
    ['le 3 exige la CI et l’absence de déclaration', () => /en CI/.test(M.echelle.agregation[1].puis) && /déclaration/.test(M.echelle.agregation[1].puis), true],
    ['un écart : score ≤ 1', () => M.synthese.ecart, 'score inférieur ou égal à 1'],
    ['ordre de traitement : prérequis, puis terme le plus faible', () => M.synthese.ordre_de_traitement.length, 2],
  ]));

  test('fractale : deux rangs, trois positions, un bouclage fermé', (t) => table(t, [
    ['rangs', () => Object.keys(M.fractale.rangs), ['meta', 'instance']],
    ['chaque rang dit ses éléments, son espace, ce qu’il exprime et devient', () => Object.values(M.fractale.rangs).every((r) => ['nom', 'elements', 'espace', 'exprime', 'devient'].every((k) => typeof r[k] === 'string')), true],
    ['au rang méta, la release est un tag et la production une publication', () => [/tag/.test(M.fractale.rangs.meta.release), /publication/.test(M.fractale.rangs.meta.production)], [true, true]],
    ['positions N-1, N, N+1', () => Object.keys(M.fractale.positions), ['N-1', 'N', 'N+1']],
    ['bouclage : chaque ligne devient Élément ou Espace', () => M.fractale.bouclage.filter((b) => !['Élément', 'Espace'].includes(b.devient)).length, 0],
    ['le journal de l’instance devient Élément du méta-projet (EQ.2)', () => M.fractale.bouclage.some((b) => b.de === 'instance' && b.vers === 'meta' && b.critere === 'EQ.2'), true],
    ['le modèle révisé redevient Élément de l’instance (facteur 2)', () => M.fractale.bouclage.some((b) => b.de === 'meta' && b.vers === 'instance' && b.facteur === 2), true],
  ]));

  test('contrats : manifeste et journal', (t) => table(t, [
    ['fichier du manifeste', () => M.contrats.manifeste.fichier, '7e-instance.yaml'],
    ['six champs obligatoires', () => M.contrats.manifeste.obligatoires, ['instance', 'modele', 'journal', 'invariants', 'seuils', 'retroaction']],
    ['chaque obligatoire est décrit', () => M.contrats.manifeste.obligatoires.filter((c) => !Object.hasOwn(M.contrats.manifeste.champs, c)), []],
    ['seuils requis = indicateurs des métriques + revue', () => [...M.contrats.manifeste.champs.seuils.requis].sort(), [...new Set([...CONTROLES.filter((k) => k.ctl.type === 'metrique').map((k) => k.ctl.indicateur), 'periode_revue_cycles'])].sort()],
    ['champs de l’entrée de journal, dans l’ordre', () => Object.keys(M.contrats.journal.champs), ['cycle', 'release', 'demande', 'fichiers', 'plan', 'phases', 'scores', 'synthese', 'mesures', 'incidents', 'remarques', 'outils', 'tendance', 'regressions', 'viabilite', 'decisions', 'seuils_revises', 'propositions_modele']],
    ['champs de la section cycle', () => Object.keys(M.contrats.journal.champs.cycle), ['id', 'numero', 'instance', 'niveau', 'modele_version', 'contrat_version', 'en_ci', 'debut', 'fin']],
    ['emplacement : <journal>/<instance>/<numéro sur 4 chiffres>.yaml', () => M.contrats.journal.emplacement.startsWith('<manifeste.journal>/<instance.id>/<numéro sur 4 chiffres>.yaml'), true],
    ['une décision nomme son critère et son motif', () => Object.keys(M.contrats.journal.champs.decisions[0]), ['indicateur', 'critere', 'correction', 'reversible', 'cible', 'motif']],
    // 0.5.0 : le répertoire du cycle (ticket au rang instance, temp) n'est jamais versionné ; l'entrée le cite
    ['le répertoire du cycle : ticket et temp, conservés, jamais versionnés, cités par lien', () => [/jira\.mhtml/, /temp\//, /jamais versionné/, /empreinte/].map((r) => r.test(M.contrats.journal.cycle)), [true, true, true, true]],
    ['toutes les entrées closes se comparent, d’un contrat à l’autre sur les critères communs', () => /critères communs/.test(M.contrats.journal.cloture) && !/même contrat_version/.test(M.contrats.journal.cloture), true],
    ['au rang méta, la proposition « retour » revient sur une version du modèle', () => M.contrats.journal.champs.propositions_modele[0].nature.endsWith('| retour'), true],
  ]));

  test('observation du modèle, amorçage, versionnage', (t) => table(t, [
    ['quatre indicateurs d’observation', () => Object.keys(M.observation_du_modele.indicateurs), ['sans_objet_frequent', 'non_discriminant', 'controle_muet', 'ecart_persistant']],
    ['chacun avec sa mesure et sa proposition', () => Object.values(M.observation_du_modele.indicateurs).every((i) => i.mesure && i.proposition), true],
    ['publication après un cycle clos, IN.1 au moins à 2', () => /IN\.1 au moins à 2/.test(M.amorcage.publication), true],
    ['le résolveur est publié avec le modèle', () => /publié avec le modèle/.test(M.amorcage.resolveur), true],
    ['versionnage semver : majeure, mineure, correctif', () => [M.versionnage.schema, ...['majeure', 'mineure', 'correctif'].map((k) => typeof M.versionnage[k])], ['semver', 'string', 'string', 'string']],
    ['avant 1.0.0, le contrat est 0.<mineure>', () => /0\.<mineure>/.test(M.versionnage.contrat_version), true],
    ['toute publication met à jour la fiche de version, sans révision de structure', () => ['modele.version', 'modele.date', 'modele.statut'].every((c) => M.versionnage.fiche.includes(c)) && /correctif compris/.test(M.versionnage.fiche), true],
  ]));
});

// Une assertion vide prouverait n'importe quoi : la suite exige assert à charger.
assert.ok(CONTROLES.length > 60);
