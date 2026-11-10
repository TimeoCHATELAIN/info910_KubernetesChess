// Archivage des parties terminées dans MongoDB (actif si MONGO_URL est défini).
const { MongoClient } = require('mongodb');

let games = null;

// Sur Kubernetes, Mongo peut démarrer après le backend : on réessaie quelques fois
// avant d'abandonner (l'échec reste non bloquant, on perd juste l'archivage).
const CONNECT_ATTEMPTS = 5;
const CONNECT_DELAY_MS = 3000;

async function init(mongoUrl) {
  if (!mongoUrl) {
    console.warn('[db] MONGO_URL absent : les parties ne seront pas archivées');
    return;
  }
  for (let attempt = 1; ; attempt++) {
    const client = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 5000 });
    try {
      await client.connect();
      games = client.db(process.env.MONGO_DB || 'chess').collection('games');
      console.log('[db] connecté à MongoDB');
      return;
    } catch (err) {
      await client.close().catch(() => {});
      if (attempt >= CONNECT_ATTEMPTS) throw err;
      console.warn(`[db] MongoDB indisponible (tentative ${attempt}), nouvel essai dans 3 s`);
      await new Promise((r) => setTimeout(r, CONNECT_DELAY_MS));
    }
  }
}

async function archiveGame(gameId, game) {
  if (!games) return;
  try {
    await games.updateOne(
      { _id: gameId },
      {
        $set: {
          moves: game.moves,
          finalFen: game.fen,
          result: game.result,
          endedAt: new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.error('[db] échec archivage :', err.message);
  }
}

// Utilisé par la sonde de readiness
async function ping() {
  if (!games) return true;
  await games.estimatedDocumentCount();
  return true;
}

module.exports = { init, archiveGame, ping };
