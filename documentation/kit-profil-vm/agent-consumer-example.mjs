import Redis from 'ioredis';

const redis = new Redis(process.env.REDIS_URL || 'redis://redis:6379/0');
const STREAM_KEY = 'gm:stream:7e:transitions';
const GROUP_NAME = 'group:cortex-agents';
const CONSUMER_NAME = 'agent-cortex-01';

async function initConsumerGroup() {
  try {
    // Création du groupe de consommateurs s'il n'existe pas
    await redis.xgroup('CREATE', STREAM_KEY, GROUP_NAME, '$', 'MKSTREAM');
  } catch (err) {
    if (!err.message.includes('BUSYGROUP')) throw err;
  }
}

async function listenToTransitions() {
  await initConsumerGroup();
  console.log(`[AGENT RECEVEUR] À l'écoute du stream '${STREAM_KEY}'...`);

  while (true) {
    // Lecture des nouveaux messages non lus
    const response = await redis.xreadgroup(
      'GROUP', GROUP_NAME, CONSUMER_NAME,
      'BLOCK', 2000,
      'COUNT', 1,
      'STREAMS', STREAM_KEY, '>'
    );

    if (response) {
      const [stream, messages] = response[0];
      for (const [id, fields] of messages) {
        // Transformation des paires [cle, valeur] en objet JavaScript
        const data = {};
        for (let i = 0; i < fields.length; i += 2) {
          data[fields[i]] = fields[i + 1];
        }

        console.log(`\n[AGENT RECEVEUR] Nouvelle transition 7E reçue [ID: ${id}] :`);
        console.log(` - Cycle : ${data.cycle}`);
        console.log(` - Nouvel état :`, JSON.parse(data.new_state));
        console.log(` - Action :`, JSON.parse(data.action));

        // Acquittement du message
        await redis.xack(STREAM_KEY, GROUP_NAME, id);
      }
    }
  }
}

listenToTransitions().catch(console.error);