import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.0.0/+esm';

const PIECE_URL = 'https://chessboardjs.com/img/chesspieces/wikipedia/{piece}.png';
const pieceImg = (code) => PIECE_URL.replace('{piece}', code);

const $ = (id) => document.getElementById(id);

// --- Identifiants : partie (dans l'URL, absent = menu) et joueur (dans le navigateur) ---
const params = new URLSearchParams(location.search);
let gameId = params.get('game');
let playerId = localStorage.getItem('playerId');
if (!playerId) {
  playerId = crypto.randomUUID();
  localStorage.setItem('playerId', playerId);
}

// --- État local ---
const game = new Chess();
let board = null;
let myColor = null; // 'white' | 'black' | 'spectator'
let over = false;
let resultDismissed = false;
// Horloge : temps restant reçu du serveur + instant de réception, on interpole entre deux messages
let clockState = { clocks: { white: 600000, black: 600000 }, running: false, turn: 'w', receivedAt: Date.now() };
let lastTimeoutEmit = 0;

const $status = $('status');
const $meta = $('meta');
const $moves = $('moves');
const $copy = $('copy');

// WebSocket direct : sans sticky session, le transport HTTP polling casse dès qu'il y a
// plusieurs pods backend (la session du transport est locale au pod, pas dans Redis).
const socket = io({ transports: ['websocket'] });

// ---------- Menu / vue partie ----------
function showMenu(notice = '') {
  $('game').hidden = true;
  $('menu').hidden = false;
  $('menu-notice').textContent = notice;
}

function showGame() {
  $('menu').hidden = true;
  $('game').hidden = false;
  ensureBoard(); // l'échiquier doit être créé une fois son conteneur visible
  board.resize();
}

$('create').addEventListener('click', () => {
  const minutes = Number(document.querySelector('input[name="minutes"]:checked').value);
  const side = document.querySelector('input[name="side"]:checked').value;

  gameId = Math.random().toString(36).slice(2, 8).padEnd(6, '0');
  history.replaceState(null, '', `?game=${gameId}`);
  showGame();
  socket.emit('create', { gameId, playerId, minutes, side });
});

// ---------- Échiquier ----------
function ensureBoard() {
  if (board) return;
  board = Chessboard('board', {
    draggable: true,
    position: 'start',
    pieceTheme: PIECE_URL,
    onDragStart(source, piece) {
      if (over || !myColor || myColor === 'spectator') return false;
      if (game.turn() !== myColor[0]) return false;      // pas mon tour
      if (!piece.startsWith(myColor[0])) return false;   // pas ma pièce
    },
    onDrop(source, target) {
      // Validation locale pour un retour visuel immédiat ; le serveur revalide.
      try {
        game.move({ from: source, to: target, promotion: 'q' });
        game.undo();
      } catch {
        return 'snapback';
      }
      socket.emit('move', { from: source, to: target, promotion: 'q' });
    },
  });
}
window.addEventListener('resize', () => board?.resize());

// ---------- Pièces prises (déduites de la position FEN) ----------
const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const ORDER = ['q', 'r', 'b', 'n', 'p'];

function renderCaptured(fen) {
  const placement = fen.split(' ')[0];
  const onBoard = {};
  for (const ch of placement) onBoard[ch] = (onBoard[ch] || 0) + 1;

  // Les blancs ont pris les pièces noires manquantes, et inversement
  const lists = { white: '', black: '' };
  for (const type of ORDER) {
    const missingBlack = Math.max(0, START_COUNT[type] - (onBoard[type] || 0));
    const missingWhite = Math.max(0, START_COUNT[type] - (onBoard[type.toUpperCase()] || 0));
    lists.white += `<img src="${pieceImg('b' + type.toUpperCase())}" alt="">`.repeat(missingBlack);
    lists.black += `<img src="${pieceImg('w' + type.toUpperCase())}" alt="">`.repeat(missingWhite);
  }
  $('captured-white').innerHTML = lists.white;
  $('captured-black').innerHTML = lists.black;
}

// ---------- Horloges ----------
function fmt(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = String(Math.floor(total / 60)).padStart(2, '0');
  const s = String(total % 60).padStart(2, '0');
  return `${m}:${s}`;
}

function tick() {
  const { clocks, running, turn, receivedAt } = clockState;
  const elapsed = running ? Date.now() - receivedAt : 0;
  const active = turn === 'w' ? 'white' : 'black';

  for (const color of ['white', 'black']) {
    const remaining = clocks[color] - (color === active ? elapsed : 0);
    const el = $(`clock-${color}`);
    el.textContent = fmt(remaining);
    el.classList.toggle('low', remaining < 60000 && clocks[color] > 60000);

    // Mon affichage atteint 0 : on demande au serveur de vérifier (pas plus d'1 fois par seconde)
    if (running && color === active && remaining <= 0 && Date.now() - lastTimeoutEmit > 1000) {
      lastTimeoutEmit = Date.now();
      socket.emit('timeout');
    }
  }
}
setInterval(tick, 200);

// Filet de sécurité : on redemande l'état au serveur toutes les 4 s
// (rattrape un message de diffusion éventuellement manqué et recale les horloges)
setInterval(() => { if (socket.connected && gameId) socket.emit('sync'); }, 4000);

// ---------- Fin de partie ----------
const WINNER_NAME = { white: 'blancs', black: 'noirs' };

function renderResult(state) {
  const { over, winner } = state;

  // Cartes : vainqueur doré, perdant estompé
  for (const color of ['white', 'black']) {
    $(`card-${color}`).classList.toggle('winner', over && winner === color);
    $(`card-${color}`).classList.toggle('loser', over && !!winner && winner !== color);
    $(`badge-${color}`).hidden = !(over && winner === color);
  }

  if (!over) {
    resultDismissed = false;
    $('result').hidden = true;
    return;
  }

  let title;
  let cls = '';
  if (!winner) {
    title = 'Partie nulle';
  } else if (myColor === 'spectator' || !myColor) {
    title = `Victoire des ${WINNER_NAME[winner]}`;
  } else if (myColor === winner) {
    title = 'Vous avez gagné !';
    cls = 'win';
  } else {
    title = 'Vous avez perdu';
    cls = 'loss';
  }

  $('result-title').textContent = title;
  $('result-title').className = cls;
  $('result-detail').textContent = state.result; // ex. « Échec et mat, victoire des blancs »
  $('result').hidden = resultDismissed;
}

$('result-view').addEventListener('click', () => { resultDismissed = true; $('result').hidden = true; });
$('result-new').addEventListener('click', () => { location.href = location.pathname; }); // retour au menu

// ---------- Rendu de l'état reçu du serveur ----------
function render(state) {
  if (!board) return;
  game.load(state.fen);
  // On ne touche à l'échiquier que si la position a changé (évite de gêner un glisser-déposer)
  if (board.fen() !== state.fen.split(' ')[0]) board.position(state.fen);
  over = state.over;

  clockState = { clocks: state.clocks, running: state.running, turn: state.turn, receivedAt: Date.now() };
  tick();

  // Bordure autour du roi du joueur dont c'est le tour
  const active = !state.over && state.players.white && state.players.black;
  $('card-white').classList.toggle('active', active && state.turn === 'w');
  $('card-black').classList.toggle('active', active && state.turn === 'b');

  renderCaptured(state.fen);
  renderResult(state);

  document.querySelectorAll('#board .highlight').forEach((s) => s.classList.remove('highlight'));
  if (state.lastMove) {
    for (const sq of [state.lastMove.from, state.lastMove.to]) {
      document.querySelector(`#board .square-${sq}`)?.classList.add('highlight');
    }
  }

  if (state.over) {
    $status.textContent = state.result;
  } else if (!state.players.white || !state.players.black) {
    $status.textContent = "En attente d'un adversaire…";
  } else {
    const myTurn = game.turn() === myColor?.[0];
    const who = game.turn() === 'w' ? 'aux blancs' : 'aux noirs';
    $status.textContent = myColor === 'spectator' ? `Trait ${who}` : myTurn ? 'À vous de jouer' : `Trait ${who}`;
  }

  $moves.innerHTML = state.moves.map((m) => `<li>${m}</li>`).join('');
  $moves.scrollTop = $moves.scrollHeight;
}

// ---------- Socket ----------
socket.on('connect', () => {
  if (gameId) socket.emit('join', { gameId, playerId }); // (re)connexion à une partie existante
});

socket.on('joined', ({ color, minutes }) => {
  myColor = color;
  board.orientation(color === 'black' ? 'black' : 'white');
  const cadence = minutes ? ` · ${minutes} min par joueur` : '';
  $meta.textContent = (color === 'spectator'
    ? 'Vous regardez la partie.'
    : `Vous jouez les ${color === 'white' ? 'blancs' : 'noirs'}.`) + cadence;
  $('label-white').textContent = color === 'white' ? 'Blancs (vous)' : 'Blancs';
  $('label-black').textContent = color === 'black' ? 'Noirs (vous)' : 'Noirs';
});

socket.on('notfound', () => {
  gameId = null;
  history.replaceState(null, '', location.pathname);
  showMenu("Cette partie n'existe pas ou a expiré. Vous pouvez en créer une nouvelle.");
});

socket.on('state', render);
socket.on('illegal', render); // le serveur renvoie l'état de référence : on resynchronise

socket.on('disconnect', () => { if (gameId) $status.textContent = 'Connexion perdue, reconnexion…'; });

$copy.addEventListener('click', async () => {
  await navigator.clipboard.writeText(location.href);
  $copy.textContent = 'Lien copié';
  setTimeout(() => ($copy.textContent = 'Copier le lien de la partie'), 1500);
});

$('resign').addEventListener('click', () => {
  if (confirm('Abandonner la partie ?')) socket.emit('resign');
});

// ---------- Démarrage : lien de partie => partie, sinon menu ----------
if (gameId) showGame();
else showMenu();