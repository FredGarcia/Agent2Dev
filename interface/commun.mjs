/**
 * Ce que les pages de l'interface partagent : erreurs HTTP, réponses, en-têtes
 * de sécurité, messages de confirmation. Sans dépendance aux pages elles-mêmes.
 */

export const SECURITE = {
  'Content-Security-Policy': "default-src 'none'; style-src 'self'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Cache-Control': 'no-store',
};

/** Messages de confirmation, choisis par le paramètre « fait » de l'adresse. */
export const MESSAGES = {
  'test-cree': 'Test créé. Ajoutez-lui ses opérations : seize au plus.',
  'test-modifie': 'Test enregistré.',
  'test-supprime': 'Test supprimé, avec ses opérations et son historique.',
  'operation-ajoutee': 'Opération ajoutée.',
  'operation-modifiee': 'Opération enregistrée.',
  'operation-supprimee': 'Opération supprimée ; les suivantes ont été renumérotées.',
  'operation-deplacee': 'Opération déplacée.',
  importe: 'Tests définis importés.',
  'demande-deposee': 'Demande déposée : l’exécuteur la prendra dès qu’il sera libre.',
  'demande-annulee': 'Demande annulée.',
  'arret-demande': 'Arrêt demandé : l’exécuteur interrompt la demande dans les secondes qui viennent.',
  'validation-enregistree': 'Validation finale enregistrée : la release est en production, et la mesure 10.2 s’arrête à cette date.',
};

export class ErreurHttp extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function envoyer(res, code, corps, type = 'text/html; charset=utf-8', entetes = {}) {
  const contenu = Buffer.isBuffer(corps) ? corps : Buffer.from(String(corps));
  res.writeHead(code, { 'Content-Type': type, 'Content-Length': contenu.length, ...SECURITE, ...entetes });
  res.end(contenu);
}

export const rediriger = (res, lieu) => { res.writeHead(303, { Location: lieu, ...SECURITE }); res.end(); };
export const entier = (v, defaut = null) => (/^\d{1,15}$/.test(String(v ?? '')) ? Number(v) : defaut);
export const messageDe = (url) => MESSAGES[url.searchParams.get('fait')] ?? null;
