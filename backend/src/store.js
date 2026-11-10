// Stockage de l'état des parties.
// - Avec REDIS_URL : l'état est partagé entre tous les pods du backend.
// - Sans REDIS_URL : repli sur une Map en mémoire (dev local, 1 seul process).
const { createClient } = require('redis');
const net = require('net');

const TTL_SECONDS = 24 * 3600; // une partie expire après 24h
const memory = new Map();
let client = null;

// Sur Kubernetes, Redis peut démarrer après le backend. On attend que le port réponde
// avant de créer le client (client.connect() réessaie sinon indéfiniment).
const CONNECT_ATTEMPTS = 10;
const CONNECT_DELAY_MS = 2000;

function tcpReachable(host, port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(1000, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function init(redisUrl) {
  if (!redisUrl) {
    console.warn('[store] REDIS_URL absent : stockage en mémoire (1 seul réplica possible)');
    return null;
  }
  const { hostname, port } = new URL(redisUrl);
  for (let attempt = 1; !(await tcpReachable(hostname, Number(port) || 6379)); attempt++) {
    if (attempt >= CONNECT_ATTEMPTS) throw new Error(`Redis injoignable sur ${hostname}:${port}`);
    console.warn(`[store] Redis injoignable (tentative ${attempt}), nouvel essai dans 2 s`);
    await new Promise((r) => setTimeout(r, CONNECT_DELAY_MS));
  }
  client = createClient({ url: redisUrl });
  client.on('error', (err) => console.error('[redis]', err.message));
  await client.connect();
  console.log('[store] connecté à Redis');
  return client;
}

async function getGame(id) {
  if (client) {
    const raw = await client.get(`game:${id}`);
    return raw ? JSON.parse(raw) : null;
  }
  return memory.get(id) || null;
}

async function saveGame(id, game) {
  if (client) {
    await client.set(`game:${id}`, JSON.stringify(game), { EX: TTL_SECONDS });
  } else {
    memory.set(id, game);
  }
}

module.exports = { init, getGame, saveGame };
