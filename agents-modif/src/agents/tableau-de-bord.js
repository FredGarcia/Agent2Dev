import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Agent } from '../agent.js';

/**
 * Agent tableau de bord — interface opérateur.
 *
 * Il ne décide de rien : il relaie les décisions de l'opérateur vers
 * l'orchestrateur et l'apprenant, et diffuse les événements du bus en SSE.
 *
 *   GET  /                              interface
 *   GET  /api/flux                      événements (text/event-stream)
 *   GET  /api/demandes                  file et historique
 *   POST /api/demandes                  { titre, texte, indices[] }
 *   GET  /api/demandes/:id              état complet
 *   GET  /api/demandes/:id/livrable.md  livrable Markdown
 *   GET  /api/attentes                  propositions en attente de décision
 *   POST /api/decisions                 { demandeId, phase, decision, commentaire }
 *   GET  /api/lecons                    leçons
 *   POST /api/lecons/:id/ratifier       { regle? }
 *   POST /api/lecons/:id/suspendre      { motif? }
 *   GET  /api/bilan                     mesures de l'observant
 */
export class AgentTableauDeBord extends Agent {
  constructor({ config, racineWeb }) {
    super('tableau-de-bord', { config });
    this.racineWeb = racineWeb;
    this.clients = new Set();
    this.serveur = null;
  }

  attacher(bus) {
    super.attacher(bus);
    bus.abonner((e) => this.diffuser(e));
  }

  diffuser(e) {
    const ligne = `data: ${JSON.stringify(e)}\n\n`;
    for (const r of this.clients) r.write(ligne);
  }

  async ouvrir() {
    const { hote, port } = this.config.tableauDeBord;
    this.serveur = createServer((req, res) => this.router(req, res));
    await new Promise((ok) => this.serveur.listen(port, hote, ok));
  }

  async fermer() {
    for (const r of this.clients) r.end();
    if (this.serveur) await new Promise((ok) => this.serveur.close(ok));
  }

  async router(req, res) {
    const url = new URL(req.url, 'http://local');
    const p = url.pathname;
    const m = (motif) => p.match(motif);
    try {
      if (req.method === 'GET' && p === '/') {
        return envoyer(res, 200, await readFile(path.join(this.racineWeb, 'index.html')), 'text/html; charset=utf-8');
      }
      if (req.method === 'GET' && p === '/api/flux') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
        res.write(': ouvert\n\n');
        this.clients.add(res);
        req.on('close', () => this.clients.delete(res));
        return;
      }
      if (req.method === 'GET' && p === '/api/demandes') return json(res, await this.demander('ordonnanceur', 'lister', {}));
      if (req.method === 'POST' && p === '/api/demandes') {
        const demande = await corps(req);
        return json(res, await this.demander('ordonnanceur', 'soumettre', { demande }), 201);
      }
      let r;
      if (req.method === 'GET' && (r = m(/^\/api\/demandes\/([^/]+)\/livrable\.md$/))) {
        const md = await this.demander('ordonnanceur', 'livrable', { id: r[1] });
        return md ? envoyer(res, 200, md, 'text/markdown; charset=utf-8', `${r[1]}.md`) : json(res, { erreur: 'Livrable pas encore produit' }, 404);
      }
      if (req.method === 'GET' && (r = m(/^\/api\/demandes\/([^/]+)$/))) {
        return json(res, await this.demander('ordonnanceur', 'etat', { id: r[1] }));
      }
      if (req.method === 'GET' && p === '/api/attentes') return json(res, await this.demander('orchestrateur', 'attentes', {}));
      if (req.method === 'GET' && p === '/api/phases') return json(res, await this.demander('orchestrateur', 'phases', {}));
      if (req.method === 'POST' && p === '/api/decisions') {
        return json(res, await this.demander('orchestrateur', 'decider', await corps(req)));
      }
      if (req.method === 'GET' && p === '/api/lecons') return json(res, await this.demander('apprenant', 'lister', {}));
      if (req.method === 'POST' && (r = m(/^\/api\/lecons\/([^/]+)\/(ratifier|suspendre)$/))) {
        return json(res, await this.demander('apprenant', r[2], { id: r[1], ...(await corps(req)) }));
      }
      if (req.method === 'GET' && p === '/api/bilan') return json(res, await this.demander('observant', 'bilan', {}));
      return json(res, { erreur: 'Route inconnue' }, 404);
    } catch (erreur) {
      const code = ['PAS_EN_ATTENTE', 'DECISION_INCONNUE', 'COMMENTAIRE_REQUIS', 'DEMANDE_VIDE'].includes(erreur.code)
        ? 400
        : ['DEMANDE_INCONNUE', 'LECON_INCONNUE'].includes(erreur.code)
          ? 404
          : 500;
      return json(res, { erreur: erreur.message, code: erreur.code ?? null }, code);
    }
  }
}

function envoyer(res, statut, contenu, type, telechargement = null) {
  const entetes = { 'content-type': type };
  if (telechargement) entetes['content-disposition'] = `attachment; filename="${telechargement}"`;
  res.writeHead(statut, entetes);
  res.end(contenu);
}

const json = (res, donnees, statut = 200) => envoyer(res, statut, JSON.stringify(donnees), 'application/json; charset=utf-8');

async function corps(req) {
  let brut = '';
  for await (const morceau of req) brut += morceau;
  return brut ? JSON.parse(brut) : {};
}
