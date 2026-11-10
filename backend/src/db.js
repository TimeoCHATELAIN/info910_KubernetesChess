// Archivage des parties terminées dans MongoDB (actif si MONGO_URL est défini).
//
// Sur Kubernetes, MongoDB peut être encore en train de télécharger son image quand le
// backend démarre. Plutôt que d'abandonner définitivement, on retente la connexion au
// prochain archivage (et à la prochaine sonde) : l'archivage se répare tout seul dès que
// Mongo répond, sans redémarrer le pod et sans bloquer le jeu entre-temps.
const { MongoClient } = require('mongodb');

let games = null;      // collection, null tant que MongoDB n'a pas répondu
let mongoUrl = null;
let connecting = null; // tentative en cours, pour ne pas en lancer plusieurs en parallèle

async function ensure() {
  if (games) return games;
  if (!mongoUrl) return null;
  if (!connecting) {
    connecting = (async () => {
      const client = new MongoClient(mongoUrl, { serverSelectionTimeoutMS: 5000 });
      await client.connect();
      games = client.db(process.env.MONGO_DB || 'chess').collection('games');
      console.log('[db] connecté à MongoDB');
      return games;
    })().finally(() => { connecting = null; });
  }
  return connecting;
}

async function init(mongoUrlFromEnv) {
  if (!mongoUrlFromEnv) {
    console.warn('[db] MONGO_URL absent : les parties ne seront pas archivées');
    return;
  }
  mongoUrl = mongoUrlFromEnv;
  await ensure().catch((err) =>
    console.warn('[db] MongoDB indisponible pour le moment :', err.message)
  );
}

async function archiveGame(gameId, game) {
  const collection = await ensure().catch(() => null);
  if (!collection) return;
  try {
    await collection.updateOne(
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

module.exports = { init, archiveGame };
