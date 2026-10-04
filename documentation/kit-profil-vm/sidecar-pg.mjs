import fs from 'node:fs/promises';
import http from 'node:http';
import Docker from 'dockerode';
import yaml from 'js-yaml';
import pg from 'pg';

const { Pool } = pg;

// Configuration
const CONFIG_PATH = process.env.META_CONFIG_PATH || '/etc/meta/system.yaml';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const PORT = process.env.PORT || 3000;

const docker = new Docker({ socketPath: DOCKER_SOCKET });
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || 'postgres://postgres:postgres@postgres:5432/gitmanager'
});

// Clients SSE connectés (Angular Dashboard)
const sseClients = new Set();

/**
 * 1. CHARGEMENT SPÉCIFICATION YAML 7E
 */
async function loadMetaSpec() {
  try {
    const fileContent = await fs.readFile(CONFIG_PATH, 'utf8');
    return yaml.load(fileContent);
  } catch (error) {
    console.error(`[MÉTA-AGENT][ERREUR] Lecture YAML : ${error.message}`);
    return null;
  }
}

/**
 * 2. PERCEPTION DOCKER (Observation 7E)
 */
async function observeSystem(spec) {
  const containers = await docker.listContainers({ all: true });
  const targetApp = spec.meta?.name || 'gitmanager';
  
  const targetContainers = containers.filter(c => 
    c.Names.some(name => name.includes(targetApp))
  );

  let totalRestarts = 0;
  let runningCount = 0;

  for (const c of targetContainers) {
    if (c.State === 'running') runningCount++;
    const containerRef = docker.getContainer(c.Id);
    const inspectData = await containerRef.inspect();
    totalRestarts += inspectData.RestartCount || 0;
  }

  return {
    total: targetContainers.length,
    running: runningCount,
    restarts: totalRestarts,
    timestamp: new Date().toISOString()
  };
}

/**
 * 3. PERSISTANCE POSTGRESQL ET NOTIFICATION
 */
async function recordCycleInPostgres(cycleNumber, stateData, metrics, actionTaken) {
  const query = `
    INSERT INTO cycles_7e (cycle_number, status, state_data, metrics, action_taken)
    VALUES ($1, $2, $3, $4, $5)
    RETURNING *;
  `;
  const values = [
    cycleNumber,
    stateData.status,
    JSON.stringify(stateData),
    JSON.stringify(metrics),
    actionTaken ? JSON.stringify(actionTaken) : null
  ];

  try {
    const res = await pool.query(query, values);
    const newRecord = res.rows[0];

    // Diffusion SSE vers le Dashboard Angular
    broadcastToAngular('cycle_update', newRecord);
  } catch (err) {
    console.error('[DATABASE][ERREUR] Échec de l\'insertion PostgreSQL :', err.message);
  }
}

function broadcastToAngular(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

/**
 * 4. BOUCLE CYBERNÉTIQUE DE SECOND ORDRE
 */
async function startCyberneticLoop() {
  let cycleIndex = 1;

  while (true) {
    const spec = await loadMetaSpec();
    if (spec) {
      const metrics = await observeSystem(spec);
      
      const metaObs = spec.cybernetic_sidecar?.agents?.meta_observer?.thresholds || {};
      let actionTaken = null;

      if (metaObs.max_restart_frequency && metrics.restarts > metaObs.max_restart_frequency) {
        actionTaken = { type: 'ADAPTATION_TRIGGERED', rule: 'UNHEALTHY_REPEATED' };
      }

      const currentState = {
        status: metrics.running === metrics.total ? 'HEALTHY' : 'DEGRADED',
        running_instances: metrics.running,
        evaluated_at: metrics.timestamp
      };

      await recordCycleInPostgres(cycleIndex, currentState, metrics, actionTaken);
      cycleIndex++;
    }

    const intervalSeconds = spec?.cybernetic_sidecar?.evaluation_interval_seconds || 10;
    await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
  }
}

/**
 * 5. SERVEUR HTTP / SSE POUR ANGULAR
 */
const server = http.createServer((req, res) => {
  if (req.url === '/api/7e/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  } else if (req.url === '/api/7e/history') {
    pool.query('SELECT * FROM cycles_7e ORDER BY cycle_number DESC LIMIT 20')
      .then(dbRes => {
        res.writeHead(200, { 
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*' 
        });
        res.end(JSON.stringify(dbRes.rows));
      })
      .catch(err => {
        res.writeHead(500);
        res.end(err.message);
      });
  } else {
    res.writeHead(404);
    res.end();
  }
});

server.listen(PORT, () => {
  console.log(`[API NODE.JS] Serveur & Flux SSE actif sur le port ${PORT}`);
  startCyberneticLoop().catch(console.error);
});