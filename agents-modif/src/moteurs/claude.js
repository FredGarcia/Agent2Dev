/**
 * Moteur de génération par l'API Messages d'Anthropic.
 *
 * Interface commune à tous les moteurs :
 *   nom : texte
 *   completer({ systeme, message, phase, entree, lecons, correction }) → { texte, usage }
 * Seuls systeme et message servent ici ; les autres champs existent pour le
 * moteur de simulation. Un moteur interne (passerelle d'entreprise) se branche
 * en respectant la même interface.
 */
export class MoteurClaude {
  constructor({ url, modele, maxTokens = 8000, cle = process.env.ANTHROPIC_API_KEY } = {}) {
    this.url = url;
    this.modele = modele;
    this.maxTokens = maxTokens;
    this.cle = cle;
    this.nom = `claude:${modele}`;
  }

  async completer({ systeme, message }) {
    if (!this.cle) throw new Error('ANTHROPIC_API_KEY absente : moteur réel indisponible');
    const reponse = await fetch(this.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.cle,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: this.modele,
        max_tokens: this.maxTokens,
        system: systeme,
        messages: [{ role: 'user', content: message }]
      })
    });
    if (!reponse.ok) {
      throw new Error(`Moteur ${this.nom} : HTTP ${reponse.status} ${(await reponse.text()).slice(0, 300)}`);
    }
    const donnees = await reponse.json();
    const texte = (donnees.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return { texte, usage: donnees.usage ?? null };
  }
}
