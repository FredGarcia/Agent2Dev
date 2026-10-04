import fs from 'node:fs/promises';
import Docker from 'dockerode';
import Redis from 'ioredis';
import yaml from 'js-yaml';

// Configuration de l'environnement
const CONFIG_PATH = process.env.META_CONFIG_PATH || '/etc/meta/system.yaml';
const DOCKER_SOCKET = process.env.DOCKER_SOCKET || '/var/run/docker.sock';
const REDIS_URL = process.env.REDIS_URL || 'redis://redis:6379/0';

// Initialisation des clients
const docker = new Docker({ socketPath: DOCKER_SOCKET });
const redis = new Redis(REDIS_URL);

// Clés des bus Redis (Compatibles architecture S0 - Mémoire Vive)
const STREAM_KEY = 'gm:stream:7e:transitions';
const PUBSUB_CHANNEL = 'meta:events:7e';

/**
 * 1. CHARGEMENT DU MANIFESTE 7E
 */
async function loadMetaSpec() {
  try {
    const fileContent = await fs.readFile(CONFIG_PATH, 'utf8');
    return yaml.load(fileContent);
  } catch (error) {
    console.error(`[MÉTA-AGENT][ERREUR] Lecture YAML impossible : ${error.message}`);
    return null;
  }
}

/**
 * 2. PERCEPTION : Capture de l'État & Expression (7E)
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
 * 3. ÉMISSION DE L'ÉTAT 7E(n+1) AUX AUTRES AGENTS (Redis Stream & Pub/Sub)
 */
async function publishStateTransition(cycleIndex, previousState, newState, actionTriggered = null) {
  const payload = {
    cycle: String(cycleIndex),
    timestamp: new Date().toISOString(),
    previous_state: JSON.stringify(previousState),
    new_state: JSON.stringify(newState),
    action: actionTriggered ? JSON.stringify(actionTriggered) : 'NONE'
  };

  try {
    // A. Redis Stream (Persistant, traçable pour S2, S3, S4)
    const streamId = await redis.xadd(
      STREAM_KEY,
      '*', // ID automatique horodaté
      'cycle', payload.cycle,
      'timestamp', payload.timestamp,
      'previous_state', payload.previous_state,
      'new_state', payload.new_state,
      'action', payload.action
    );

    // B. Redis Pub/Sub (Éphémère pour le Dashboard Temps Réel S6-VueJS / WebSockets)
    await redis.publish(PUBSUB_CHANNEL, JSON.stringify({
      streamId,
      ...payload,
      previous_state: previousState,
      new_state: newState,
      action: actionTriggered
    }));

    console.log(`[ÉMETTEUR 7E] Transition v${cycleIndex} publiée -> Stream ID: ${streamId}`);
  } catch (err) {
    console.error(`[ÉMETTEUR 7E][ERREUR] Échec de publication Redis :`, err.message);
  }
}

/**
 * 4. ÉVALUATION CYBERNÉTIQUE ET AUTOTÉLIE
 */
async function evaluateAndRegulate(spec, metrics, currentCycle) {
  const metaObs = spec.cybernetic_sidecar?.agents?.meta_observer?.thresholds || {};
  let actionTaken = null;

  // Modèle d'État courant $7E(n)$
  const currentState = {
    status: metrics.running === metrics.total ? 'HEALTHY' : 'DEGRADED',
    running_instances: metrics.running,
    total_restarts: metrics.restarts
  };

  // Traitement d'anomalie
  if (metaObs.max_restart_frequency && metrics.restarts > metaObs.max_restart_frequency) {
    console.warn(`[CYBERNÉTIQUE 2] Seuil dépassé (${metrics.restarts} redémarrages). Action de régulation...`);
    actionTaken = { type: 'SCALE_OR_ROLLBACK', target: 'app_web', reason: 'RESTART_THRESHOLD' };
  }

  // Calcul du nouvel état $7E(n+1)$
  const nextState = {
    ...currentState,
    status: actionTaken ? 'ADAPTING' : currentState.status,
    evaluated_at: metrics.timestamp
  };

  // Diffusion aux autres organes/agents
  await publishStateTransition(currentCycle, currentState, nextState, actionTaken);
}

/**
 * 5. BOUCLE PRINCIPALE DE RÉGULATION (Cycle 7E)
 */
async function startCyberneticLoop() {
  console.log('[MÉTA-AGENT] Démarrage du Sidecar Cybernétique avec bus Redis Streams...');
  let cycleIndex = 1;

  while (true) {
    const spec = await loadMetaSpec();
    
    if (spec) {
      const metrics = await observeSystem(spec);
      await evaluateAndRegulate(spec, metrics, cycleIndex);
      cycleIndex++;
    }

    const intervalSeconds = spec?.cybernetic_sidecar?.evaluation_interval_seconds || 10;
    await new Promise(resolve => setTimeout(resolve, intervalSeconds * 1000));
  }
}

startCyberneticLoop().catch(err => {
  console.error('[FATAL] Erreur boucle cybernétique :', err);
  process.exit(1);
});