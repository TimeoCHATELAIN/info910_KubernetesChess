const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { createAdapter } = require('@socket.io/redis-adapter');
const { Chess } = require('chess.js');

const store = require('./store');
const db = require('./db');

const PORT = process.env.PORT || 3000;

// Réglages autorisés à la création d'une partie
const ALLOWED_MINUTES = [1, 3, 5, 10, 15, 30];
const ALLOWED_SIDES = ['white', 'black', 'random'];
const DEFAULT_MINUTES = 10;
const GAME_ID_RE = /^[a-z0-9]{4,12}$/;

const NAMES = { white: 'blancs', black: 'noirs' };
const other = (color) => (color === 'white' ? 'black' : 'white');

// Texte de résultat (archivé dans MongoDB et affiché aux clients)
const REASON_LABELS = {
  checkmate: 'Échec et mat',
  timeout: 'Temps écoulé',
  resignation: 'Abandon',
  stalemate: 'Pat',
  insufficient: 'Matériel insuffisant',
  fifty: 'Règle des 50 coups',
  draw: 'Partie nulle',
};

function newGame(minutes) {
  const clockMs = minutes * 60 * 1000;
  return {
    fen: new Chess().fen(),
    minutes,
    white: null, // playerId du joueur blanc
    black: null, // playerId du joueur noir
    moves: [],   // coups en notation SAN
    lastMove: null,
    over: false,
    winner: null, // 'white' | 'black' | null (nulle)
    reason: null, // checkmate | timeout | resignation | stalemate | insufficient | fifty | draw
    result: null, // texte lisible
    clocks: { white: clockMs, black: clockMs }, // temps restant (ms) au dernier coup
    turnStartedAt: null, // horodatage (ms) du début du tour en cours, null = horloge arrêtée
  };
}

function turnColor(game) {
  return game.fen.split(' ')[1] === 'w' ? 'white' : 'black';
}

// Temps restant à l'instant présent (on retire le temps écoulé au joueur dont c'est le tour).
// L'horloge est entièrement stockée dans l'état partagé : n'importe quel pod peut la calculer.
function currentClocks(game) {
  const clocks = { ...game.clocks };
  if (!game.over && game.turnStartedAt) {
    const color = turnColor(game);
    clocks[color] = Math.max(0, clocks[color] - (Date.now() - game.turnStartedAt));
  }
  return clocks;
}

// Ce qu'on envoie aux clients (jamais les playerId)
function publicState(game) {
  return {
    fen: game.fen,
    turn: game.fen.split(' ')[1], // 'w' ou 'b'
    minutes: game.minutes,
    moves: game.moves,
    lastMove: game.lastMove,
    over: game.over,
    winner: game.winner,
    reason: game.reason,
    result: game.result,
    players: { white: !!game.white, black: !!game.black },
    clocks: currentClocks(game),
    running: !game.over && !!game.turnStartedAt,
  };
}

async function endGame(gameId, game, winner, reason) {
  game.clocks = currentClocks(game);
  game.over = true;
  game.winner = winner;
  game.reason = reason;
  game.result = winner
    ? `${REASON_LABELS[reason]}, victoire des ${NAMES[winner]}`
    : REASON_LABELS[reason];
  game.turnStartedAt = null;
  await db.archiveGame(gameId, game);
}

function drawReason(chess) {
  if (chess.isStalemate()) return 'stalemate';
  if (chess.isInsufficientMaterial()) return 'insufficient';
  if (chess.isThreefoldRepetition()) return 'draw';
  if (chess.isDrawByFiftyMoves()) return 'fifty';
  return 'draw';
}

async function main() {
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);

  // --- Connexions Redis / Mongo ---
  const redisClient = await store.init(process.env.REDIS_URL);
  if (redisClient) {
    // Le client "subscriber" de l'adaptateur doit être connecté explicitement
    const subClient = redisClient.duplicate();
    subClient.on('error', (err) => console.error('[redis-sub]', err.message));
    await subClient.connect();
    // Permet aux pods de se relayer les événements Socket.IO
    io.adapter(createAdapter(redisClient, subClient));
  }
  await db.init(process.env.MONGO_URL).catch((e) => console.error('[db]', e.message));

  // --- Sondes Kubernetes ---
  app.get('/healthz', (_req, res) => res.send('ok'));           // liveness
  app.get('/readyz', async (_req, res) => {                     // readiness
    try {
      await db.ping();
      res.send('ready');
    } catch {
      res.status(503).send('not ready');
    }
  });
  // Utile en démo : voir quel pod répond
  app.get('/api/whoami', (_req, res) => res.json({ pod: process.env.HOSTNAME }));

  // Installe un joueur dans une partie existante (ou le reconnaît s'il y est déjà)
  async function enter(socket, gameId, playerId, game) {
    let color = 'spectator';
    if (game.white === playerId) color = 'white';
    else if (game.black === playerId) color = 'black';
    else if (!game.white) { game.white = playerId; color = 'white'; }
    else if (!game.black) { game.black = playerId; color = 'black'; }

    // Les deux joueurs sont là : l'horloge des blancs démarre
    if (game.white && game.black && !game.turnStartedAt && !game.over) {
      game.turnStartedAt = Date.now();
    }

    await store.saveGame(gameId, game);

    socket.data = { gameId, playerId, color };
    socket.join(gameId);
    socket.emit('joined', { color, minutes: game.minutes });
    io.to(gameId).emit('state', publicState(game));
  }

  // --- Temps réel ---
  io.on('connection', (socket) => {
    // Création d'une partie avec ses réglages (cadence, camp du créateur)
    socket.on('create', async ({ gameId, playerId, minutes, side } = {}) => {
      if (!GAME_ID_RE.test(gameId || '') || !playerId) return;

      const existing = await store.getGame(gameId);
      if (existing) return enter(socket, gameId, playerId, existing);

      const mins = ALLOWED_MINUTES.includes(minutes) ? minutes : DEFAULT_MINUTES;
      const creatorColor =
        side === 'white' || side === 'black'
          ? side
          : Math.random() < 0.5 ? 'white' : 'black'; // 'random' (ou valeur invalide)

      const game = newGame(mins);
      game[creatorColor] = playerId;
      await enter(socket, gameId, playerId, game);
    });

    // Rejoindre une partie existante via son lien : jamais de création implicite
    socket.on('join', async ({ gameId, playerId } = {}) => {
      if (!gameId || !playerId) return;

      const game = await store.getGame(gameId);
      if (!game) return socket.emit('notfound');

      await enter(socket, gameId, playerId, game);
    });

    // Resynchronisation à la demande (filet de sécurité si un message a été manqué)
    socket.on('sync', async () => {
      const { gameId } = socket.data || {};
      if (!gameId) return;
      const game = await store.getGame(gameId);
      if (game) socket.emit('state', publicState(game));
    });

    socket.on('move', async ({ from, to, promotion }) => {
      const { gameId, color } = socket.data || {};
      if (!gameId) return;

      const game = await store.getGame(gameId);
      if (!game || game.over || !game.turnStartedAt) return;

      const mover = turnColor(game);
      if (color !== mover) return socket.emit('illegal', publicState(game));

      // Temps écoulé avant que le coup n'arrive ?
      if (currentClocks(game)[mover] <= 0) {
        await endGame(gameId, game, other(mover), 'timeout');
        await store.saveGame(gameId, game);
        return io.to(gameId).emit('state', publicState(game));
      }

      const chess = new Chess(game.fen);
      let move;
      try {
        move = chess.move({ from, to, promotion: promotion || 'q' });
      } catch {
        return socket.emit('illegal', publicState(game));
      }

      // On fige le temps du joueur qui vient de jouer, puis on lance l'horloge de l'autre
      game.clocks = currentClocks(game);
      game.fen = chess.fen();
      game.moves.push(move.san);
      game.lastMove = { from: move.from, to: move.to };
      game.turnStartedAt = Date.now();

      if (chess.isCheckmate()) {
        await endGame(gameId, game, mover, 'checkmate');
      } else if (chess.isGameOver()) {
        await endGame(gameId, game, null, drawReason(chess));
      }

      await store.saveGame(gameId, game);
      io.to(gameId).emit('state', publicState(game));
    });

    // Un client dont l'affichage atteint 0 le signale ; le serveur vérifie avec sa propre horloge
    socket.on('timeout', async () => {
      const { gameId } = socket.data || {};
      if (!gameId) return;

      const game = await store.getGame(gameId);
      if (!game || game.over || !game.turnStartedAt) return;

      const loser = turnColor(game);
      if (currentClocks(game)[loser] <= 0) {
        await endGame(gameId, game, other(loser), 'timeout');
        await store.saveGame(gameId, game);
        io.to(gameId).emit('state', publicState(game));
      } else {
        socket.emit('state', publicState(game)); // le client était en avance : on resynchronise
      }
    });

    socket.on('resign', async () => {
      const { gameId, color } = socket.data || {};
      if (!gameId || color === 'spectator') return;

      const game = await store.getGame(gameId);
      if (!game || game.over) return;

      await endGame(gameId, game, other(color), 'resignation');
      await store.saveGame(gameId, game);
      io.to(gameId).emit('state', publicState(game));
    });
  });

  server.listen(PORT, () => console.log(`[server] backend sur le port ${PORT}`));

  // Arrêt propre (Kubernetes envoie SIGTERM avant de tuer le pod)
  process.on('SIGTERM', () => {
    console.log('[server] SIGTERM reçu, arrêt...');
    io.close(() => process.exit(0));
  });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});