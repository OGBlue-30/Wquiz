'use strict';

/**
 * Tous les salons vivent ici, uniquement en RAM.
 * Aucune base de données, aucun fichier écrit : la Map disparaît avec le process.
 */

const crypto = require('node:crypto');
const {
  buildDeck,
  publicQuestion,
  reviewQuestion,
  questionCount,
} = require('./questions');

const MAX_PLAYERS = 10;
const EMPTY_ROOM_TTL = Number(process.env.EMPTY_ROOM_TTL_MS) || 20_000;
const FINISHED_ROOM_TTL = 15 * 60_000;
const STALE_LOBBY_TTL = 4 * 60 * 60_000;
const EARLY_END_DELAY = 800;
const PETIT_BAC_TIME_MULTIPLIER = 2;

const QUESTION_COUNTS = [3, 10, 15, 20, 30];
const ANSWER_TIMES = [5, 10, 20, 30];
const GAME_MODES = ['mixte', 'petitbac'];
const AVATAR_EMOJIS = ['😀', '😎', '🥳', '🐱', '🐶', '🦊', '🐼', '🐸', '🦄', '🐙', '🚀', '⭐'];

const rooms = new Map();
let hooks = { notify() {}, removed() {} };

class RoomError extends Error {}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function fail(message) {
  throw new RoomError(message);
}

function setHooks(next) {
  hooks = { ...hooks, ...next };
}

function notify(room) {
  room.updatedAt = Date.now();
  hooks.notify(room);
}

function cleanName(value) {
  const name = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (name.length < 2) fail('Choisissez un pseudo d’au moins 2 caractères.');
  if (name.length > 16) fail('16 caractères maximum pour le pseudo.');
  return name;
}

function cleanPlayerId(value) {
  const id = String(value ?? '').trim();
  return /^[A-Za-z0-9_-]{6,64}$/.test(id) ? id : crypto.randomUUID();
}

function cleanCode(value) {
  const code = String(value ?? '').trim();
  if (!/^\d{4}$/.test(code)) fail('Le code du salon doit contenir 4 chiffres.');
  return code;
}

function normalizeName(name) {
  return name.toLocaleLowerCase('fr-FR');
}

function assertNameFree(room, name, exceptId) {
  const taken = room.players.some(
    (p) => p.id !== exceptId && normalizeName(p.name) === normalizeName(name),
  );
  if (taken) fail('Ce pseudo est déjà utilisé dans ce salon.');
}

function newRoomCode() {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const code = String(1000 + Math.floor(Math.random() * 9000));
    if (!rooms.has(code)) return code;
  }
  fail('Impossible de créer un salon pour le moment. Réessayez.');
}

function makePlayer(id, name, socketId) {
  return {
    id,
    name,
    socketId,
    connected: true,
    score: 0,
    emoji: '',
    joinedAt: Date.now(),
  };
}

function getPlayer(room, playerId) {
  return room.players.find((p) => p.id === playerId) || null;
}

function assertHost(room, playerId) {
  if (room.hostId !== playerId) fail('Seul l’hôte peut faire cette action.');
}

function assertLobby(room) {
  if (room.phase !== 'lobby') fail('La partie a déjà commencé.');
}

function addPoint(room, playerId) {
  const player = getPlayer(room, playerId);
  if (player) player.score += 1;
}

/** Le Petit Bac reçoit 100 % de temps en plus (temps de base × 2). */
function questionTimeSeconds(question, answerTime) {
  const multiplier = question.type === 'petitbac' ? PETIT_BAC_TIME_MULTIPLIER : 1;
  return answerTime * multiplier;
}

function formatAnswer(question, slotKey, raw) {
  if (question.type === 'mcq') {
    return question.choices[raw] ?? '—';
  }
  return String(raw ?? '').trim();
}

function stopTimer(handle) {
  if (handle) clearTimeout(handle);
}

function clearPlayTimers(room) {
  stopTimer(room.playTimer);
  stopTimer(room.earlyEndTimer);
  room.playTimer = null;
  room.earlyEndTimer = null;
}

function clearRoomTimers(room) {
  clearPlayTimers(room);
  stopTimer(room.emptyTimer);
  room.emptyTimer = null;
}

function deleteRoom(code, reason) {
  const room = rooms.get(code);
  if (!room) return false;
  clearRoomTimers(room);
  rooms.delete(code);
  hooks.removed(room, reason);
  return true;
}

function scheduleEmptyCleanup(room) {
  if (room.emptyTimer) return;
  room.emptyTimer = setTimeout(() => {
    room.emptyTimer = null;
    if (!room.players.some((p) => p.connected)) {
      deleteRoom(room.code, 'Tous les joueurs se sont déconnectés : le salon a été supprimé.');
    }
  }, EMPTY_ROOM_TTL);
  room.emptyTimer.unref?.();
}

/* ------------------------------------------------------------------ */
/* Salons                                                              */
/* ------------------------------------------------------------------ */

function createRoom({ name, playerId, socketId }) {
  const cleanPlayerName = cleanName(name);
  const id = cleanPlayerId(playerId);
  const code = newRoomCode();
  const player = makePlayer(id, cleanPlayerName, socketId);

  const room = {
    code,
    hostId: id,
    phase: 'lobby',
    config: { questionCount: 10, answerTime: 10, mode: 'mixte' },
    players: [player],
    createdAt: Date.now(),
    updatedAt: Date.now(),
    startedAt: null,
    finishedAt: null,
    questions: [],
    currentIndex: 0,
    answers: {},
    submitted: {},
    questionStartedAt: 0,
    endsAt: 0,
    playTimer: null,
    earlyEndTimer: null,
    emptyTimer: null,
    review: null,
    reviews: [],
    results: null,
  };

  rooms.set(code, room);
  return { room, player };
}

function joinRoom({ code, name, playerId, socketId }) {
  const room = rooms.get(cleanCode(code));
  if (!room) fail('Salon introuvable. Vérifiez le code.');

  const id = cleanPlayerId(playerId);
  let player = getPlayer(room, id);

  if (player) {
    // Reconnexion (rafraîchissement de page, coupure réseau…)
    player.socketId = socketId;
    player.connected = true;
    if (room.phase === 'lobby' && name) {
      const cleanPlayerName = cleanName(name);
      if (normalizeName(cleanPlayerName) !== normalizeName(player.name)) {
        assertNameFree(room, cleanPlayerName, player.id);
        player.name = cleanPlayerName;
      }
    }
    stopTimer(room.emptyTimer);
    room.emptyTimer = null;
    notify(room);
    return { room, player };
  }

  if (room.phase !== 'lobby') fail('La partie a déjà commencé dans ce salon.');
  if (room.players.length >= MAX_PLAYERS) fail(`Ce salon est complet (${MAX_PLAYERS} joueurs).`);

  const cleanPlayerName = cleanName(name);
  assertNameFree(room, cleanPlayerName);

  player = makePlayer(id, cleanPlayerName, socketId);
  room.players.push(player);
  notify(room);
  return { room, player };
}

function handleDisconnect(socketId) {
  const room = findRoomBySocket(socketId);
  if (!room) return;

  const player = room.players.find((p) => p.socketId === socketId);
  if (!player) return;

  player.connected = false;
  player.socketId = null;

  if (!room.players.some((p) => p.connected)) {
    scheduleEmptyCleanup(room);
    return;
  }

  if (room.hostId === player.id) {
    const nextHost = room.players.find((p) => p.connected);
    if (nextHost) room.hostId = nextHost.id;
  }

  if (room.phase === 'review') {
    resolvePendingItems(room);
  }

  notify(room);
}

function findRoomBySocket(socketId) {
  for (const room of rooms.values()) {
    if (room.players.some((p) => p.socketId === socketId)) return room;
  }
  return null;
}

function leaveRoom(room, playerId) {
  const player = getPlayer(room, playerId);
  if (!player) return;

  player.connected = false;
  player.socketId = null;

  if (room.phase === 'lobby') {
    room.players = room.players.filter((p) => p.id !== playerId);
    if (room.players.length === 0) {
      deleteRoom(room.code, 'Le salon a été fermé.');
      return;
    }
    if (room.hostId === playerId) room.hostId = room.players[0].id;
    notify(room);
    return;
  }

  if (!room.players.some((p) => p.connected)) {
    scheduleEmptyCleanup(room);
    return;
  }

  if (room.hostId === playerId) {
    const nextHost = room.players.find((p) => p.connected);
    if (nextHost) room.hostId = nextHost.id;
  }

  if (room.phase === 'review') resolvePendingItems(room);
  notify(room);
}

function updateConfig(room, playerId, config) {
  assertHost(room, playerId);
  assertLobby(room);

  const questionCount = Number(config?.questionCount ?? room.config.questionCount);
  const answerTime = Number(config?.answerTime ?? room.config.answerTime);
  const mode = config?.mode ?? room.config.mode;

  if (!QUESTION_COUNTS.includes(questionCount)) {
    fail('Nombre de questions invalide (3, 10, 15, 20 ou 30).');
  }
  if (!ANSWER_TIMES.includes(answerTime)) {
    fail('Temps par réponse invalide (5, 10, 20 ou 30 secondes).');
  }
  if (!GAME_MODES.includes(mode)) {
    fail('Mode de jeu invalide (tous les formats ou Petit Bac uniquement).');
  }

  room.config = { questionCount, answerTime, mode };
  notify(room);
}

function setPlayerEmoji(room, playerId, emoji) {
  assertLobby(room);
  if (!AVATAR_EMOJIS.includes(emoji)) fail('Cet emoji n’est pas disponible.');

  const player = getPlayer(room, playerId);
  if (!player || !player.connected) fail('Vous ne participez plus à ce salon.');
  player.emoji = emoji;
  notify(room);
}

/* ------------------------------------------------------------------ */
/* Phase de jeu                                                        */
/* ------------------------------------------------------------------ */

function beginGame(room) {
  room.questions = buildDeck(room.config.questionCount, { mode: room.config.mode });
  room.answers = {};
  room.submitted = {};
  room.results = null;
  room.review = null;
  room.reviews = [];
  room.currentIndex = 0;
  room.startedAt = Date.now();
  room.finishedAt = null;
  for (const player of room.players) player.score = 0;

  startQuestion(room, 0);
}

function startGame(room, playerId) {
  assertHost(room, playerId);
  assertLobby(room);

  if (!room.players.some((p) => p.connected)) fail('Il n’y a personne dans le salon.');

  beginGame(room);
}

/**
 * Revanche immédiate : même salon, mêmes joueurs connectés, mêmes réglages,
 * scores remis à zéro et nouvelle partie lancée sans repasser par le lobby.
 */
function restartGame(room, playerId) {
  assertHost(room, playerId);
  if (room.phase !== 'results') fail('La partie n’est pas terminée.');

  clearRoomTimers(room);

  room.players = room.players.filter((p) => p.connected);
  if (room.players.length === 0) {
    deleteRoom(room.code, 'Le salon a été fermé.');
    return;
  }
  if (!room.players.some((p) => p.id === room.hostId)) {
    room.hostId = room.players[0].id;
  }

  beginGame(room);
}

function startQuestion(room, index) {
  clearPlayTimers(room);
  room.phase = 'playing';
  room.currentIndex = index;
  room.submitted = {};
  room.answers[index] = {};
  room.questionStartedAt = Date.now();

  const durationMs =
    questionTimeSeconds(room.questions[index], room.config.answerTime) * 1000;
  room.endsAt = room.questionStartedAt + durationMs;

  room.playTimer = setTimeout(() => endQuestion(room, index), durationMs + 600);

  notify(room);
}

function endQuestion(room, index) {
  if (room.phase !== 'playing' || room.currentIndex !== index) return;
  clearPlayTimers(room);

  if (index + 1 < room.questions.length) {
    startQuestion(room, index + 1);
  } else {
    startReview(room, 0);
  }
}

function sanitizeAnswers(question, input) {
  const out = {};
  if (!input || typeof input !== 'object') return out;

  for (const slot of question.slots) {
    const raw = input[slot.key];

    if (question.type === 'mcq') {
      const choice = Number(raw);
      if (Number.isInteger(choice) && choice >= 0 && choice < question.choices.length) {
        out[slot.key] = choice;
      }
      continue;
    }

    if (typeof raw !== 'string') continue;
    const value = raw
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    if (value) out[slot.key] = value;
  }

  return out;
}

function submitAnswer(room, playerId, payload) {
  if (room.phase !== 'playing') fail('Ce n’est pas le moment de répondre.');

  const index = Number(payload?.index);
  if (index !== room.currentIndex) fail('Cette question est déjà terminée.');
  if (Date.now() > room.endsAt + 600) fail('Temps écoulé !');

  const player = getPlayer(room, playerId);
  if (!player || !player.connected) fail('Vous ne participez plus à ce salon.');

  const question = room.questions[index];
  if (payload?.autosave === true) {
    if (room.submitted[playerId] || Date.now() < room.endsAt) {
      return;
    }
    room.answers[index] ||= {};
    const answers = sanitizeAnswers(question, payload?.answers);
    if (
      question.type === 'image'
      && Array.isArray(question.slots)
      && question.slots.length > 1
      && question.slots.some((slot) => !answers[slot.key])
    ) {
      fail('Vous devez écrire les deux personnalités.');
    }
    room.answers[index][playerId] = answers;
    return;
  }

  room.answers[index] ||= {};
  room.answers[index][playerId] = sanitizeAnswers(question, payload?.answers);

  room.submitted[playerId] = true;

  maybeEndEarly(room, index);
  notify(room);
}

function maybeEndEarly(room, index) {
  const connected = room.players.filter((p) => p.connected);
  if (connected.length === 0) return;
  if (!connected.every((p) => room.submitted[p.id])) return;
  if (room.earlyEndTimer) return;

  room.earlyEndTimer = setTimeout(() => {
    room.earlyEndTimer = null;
    endQuestion(room, index);
  }, EARLY_END_DELAY);
  room.earlyEndTimer.unref?.();
}

/* ------------------------------------------------------------------ */
/* Phase de correction                                                 */
/* ------------------------------------------------------------------ */

function startReview(room, index) {
  clearPlayTimers(room);

  const question = room.questions[index];
  room.phase = 'review';

  let review = room.reviews[index];
  if (!review) {
    review = { index, startedAt: Date.now(), votes: {}, items: [] };
    room.review = review;

    const items = [];
    for (const player of room.players) {
      const answers = room.answers[index]?.[player.id] || {};
      for (const slot of question.slots) {
        const raw = answers[slot.key];
        const empty = raw === undefined || raw === null || String(raw).trim() === '';
        items.push({
          pid: player.id,
          name: player.name,
          emoji: player.emoji,
          slot: slot.key,
          slotLabel: slot.label,
          value: empty ? '' : formatAnswer(question, slot.key, raw),
          status: empty ? 'empty' : question.type === 'mcq' ? 'auto' : 'pending',
          resolvedBy: question.type === 'mcq' ? 'auto' : 'vote',
          skipped: false,
          yes: 0,
          no: 0,
          total: 0,
        });
      }
    }

    review.items = items;
    room.reviews[index] = review;
    if (question.type === 'mcq') autoGrade(room, question, index);
  }

  room.review = review;
  resolvePendingItems(room);
  notify(room);
}

function autoGrade(room, question, index) {
  for (const item of room.review.items) {
    if (item.status === 'empty') continue;
    const answer = room.answers[index]?.[item.pid]?.answer;
    const correct = answer === question.correctIndex;
    item.status = correct ? 'accepted' : 'refused';
    item.resolvedBy = 'auto';
    if (correct) addPoint(room, item.pid);
  }
}

function castVote(room, voterId, payload) {
  if (room.phase !== 'review' || !room.review) fail('Le vote n’est pas ouvert.');
  if (Number(payload?.index) !== room.review.index) fail('Cette correction est terminée.');

  const voter = getPlayer(room, voterId);
  if (!voter || !voter.connected) fail('Vous ne participez plus à ce salon.');

  const { pid, slot } = payload || {};
  if (pid === voterId) fail('Vous ne pouvez pas voter pour votre propre réponse.');
  const item = room.review.items.find((i) => i.pid === pid && i.slot === slot);
  if (!item) fail('Réponse introuvable.');
  if (item.status !== 'pending') fail('Cette réponse est déjà corrigée.');

  const value = payload?.value;
  if (!['yes', 'no', 'clear'].includes(value)) fail('Vote invalide.');

  const key = `${pid}|${slot}`;
  const votes = (room.review.votes[key] ||= {});
  if (value === 'clear') delete votes[voterId];
  else votes[voterId] = value;

  resolvePendingItems(room);
  notify(room);
}

function resolvePendingItems(room) {
  if (room.phase !== 'review' || !room.review) return;

  const voters = room.players.filter((p) => p.connected);

  for (const item of room.review.items) {
    if (item.status !== 'pending') continue;
    const eligibleVoters = voters.filter((p) => p.id !== item.pid);
    if (eligibleVoters.length === 0) continue;
    const voterIds = new Set(eligibleVoters.map((p) => p.id));

    const votes = room.review.votes[`${item.pid}|${item.slot}`] || {};
    const cast = Object.entries(votes).filter(
      ([id, value]) => voterIds.has(id) && (value === 'yes' || value === 'no'),
    );
    if (cast.length < eligibleVoters.length) continue;

    settleItem(room, item, cast, eligibleVoters.length);
  }
}

function settleItem(room, item, cast, total) {
  const yes = cast.filter(([, value]) => value === 'yes').length;
  const no = cast.length - yes;

  item.yes = yes;
  item.no = no;
  item.total = total;

  // Majorité stricte : en cas d'égalité, la réponse est refusée.
  const accepted = yes * 2 > total;
  item.status = accepted ? 'accepted' : 'refused';
  item.resolvedBy = 'vote';
  if (accepted) addPoint(room, item.pid);
  return accepted;
}

function skipReview(room, playerId) {
  assertHost(room, playerId);
  if (room.phase !== 'review' || !room.review) fail('Aucune correction en cours.');

  const voters = room.players.filter((p) => p.connected);

  for (const item of room.review.items) {
    if (item.status !== 'pending') continue;
    const eligibleVoters = voters.filter((p) => p.id !== item.pid);
    const voterIds = new Set(eligibleVoters.map((p) => p.id));
    const votes = room.review.votes[`${item.pid}|${item.slot}`] || {};
    const cast = Object.entries(votes).filter(
      ([id, value]) => voterIds.has(id) && (value === 'yes' || value === 'no'),
    );
    if (eligibleVoters.length === 0) {
      item.status = 'refused';
      item.resolvedBy = 'vote';
      item.yes = 0;
      item.no = 0;
      item.total = 0;
    } else {
      settleItem(room, item, cast, eligibleVoters.length);
    }
    item.skipped = true;
  }

  const next = room.review.index + 1;
  if (next < room.questions.length) startReview(room, next);
  else finishGame(room);
}

/** Revenir à la correction précédente (hôte uniquement). */
function previousReview(room, playerId) {
  assertHost(room, playerId);
  if (room.phase !== 'review' || !room.review) fail('Aucune correction en cours.');

  const index = room.review.index;
  if (index <= 0) fail('Vous êtes déjà à la première correction.');

  const previous = room.reviews[index - 1];
  if (!previous) fail('Correction précédente introuvable.');

  room.review = previous;
  resolvePendingItems(room);
  notify(room);
}

/* ------------------------------------------------------------------ */
/* Fin de partie                                                       */
/* ------------------------------------------------------------------ */

function finishGame(room) {
  clearPlayTimers(room);

  room.phase = 'results';
  room.finishedAt = Date.now();
  room.results = room.players
    .map((p) => ({
      id: p.id,
      name: p.name,
      score: p.score,
      connected: p.connected,
    }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, 'fr'));
  room.results.forEach((entry, i) => {
    if (i === 0 || entry.score !== room.results[i - 1].score) {
      entry.rank = i + 1;
    } else {
      entry.rank = room.results[i - 1].rank;
    }
  });

  notify(room);
}

function replayGame(room, playerId) {
  assertHost(room, playerId);
  if (room.phase !== 'results') fail('La partie n’est pas terminée.');

  clearRoomTimers(room);

  room.players = room.players.filter((p) => p.connected);
  if (room.players.length === 0) {
    deleteRoom(room.code, 'Le salon a été fermé.');
    return;
  }
  if (!room.players.some((p) => p.id === room.hostId)) {
    room.hostId = room.players[0].id;
  }

  room.phase = 'lobby';
  room.questions = [];
  room.answers = {};
  room.submitted = {};
  room.currentIndex = 0;
  room.results = null;
  room.review = null;
  room.reviews = [];
  room.finishedAt = null;
  room.startedAt = null;
  room.endsAt = 0;
  for (const player of room.players) player.score = 0;

  notify(room);
}

/* ------------------------------------------------------------------ */
/* Vues                                                                */
/* ------------------------------------------------------------------ */

function reviewView(room, viewer) {
  const review = room.review;
  const question = room.questions[review.index];
  const voters = room.players.filter((p) => p.connected);
  const voterIds = new Set(voters.map((p) => p.id));

  const myVotes = {};
  const votersWhoVoted = new Set();
  for (const [key, votes] of Object.entries(review.votes)) {
    for (const [voterId, value] of Object.entries(votes)) {
      if (!voterIds.has(voterId)) continue;
      if (value === 'yes' || value === 'no') votersWhoVoted.add(voterId);
      if (voterId === viewer.id) myVotes[key] = value;
    }
  }

  return {
    index: review.index,
    total: room.questions.length,
    question: reviewQuestion(question, review.index),
    items: review.items.map((item) => ({
      pid: item.pid,
      name: item.name,
      emoji: item.emoji,
      slot: item.slot,
      slotLabel: item.slotLabel,
      value: item.value,
      status: item.status,
      resolvedBy: item.resolvedBy,
      skipped: item.skipped,
      yes: item.status === 'pending' ? null : item.yes,
      no: item.status === 'pending' ? null : item.no,
      total: item.status === 'pending' ? null : item.total,
    })),
    myVotes,
    autoGraded: question.type === 'mcq',
    allResolved: review.items.every((item) => item.status !== 'pending'),
    voters: { voted: votersWhoVoted.size, total: voters.length },
  };
}

function snapshotFor(room, viewer) {
  const base = {
    code: room.code,
    phase: room.phase,
    serverNow: Date.now(),
    config: { ...room.config },
    questionCount: room.questions.length || room.config.questionCount,
    hostId: room.hostId,
    maxPlayers: MAX_PLAYERS,
    me: {
      id: viewer.id,
      name: viewer.name,
      isHost: viewer.id === room.hostId,
    },
    players: room.players.map((p) => ({
      id: p.id,
      name: p.name,
      isHost: p.id === room.hostId,
      emoji: p.emoji,
      connected: p.connected,
      score: p.score,
      emoji: p.emoji,
      submitted: Boolean(room.submitted?.[p.id]),
    })),
  };

  if (room.phase === 'playing') {
    const question = room.questions[room.currentIndex];
    base.index = room.currentIndex;
    base.endsAt = room.endsAt;
    base.startedAt = room.questionStartedAt;
    const durationMs = room.endsAt - room.questionStartedAt;
    base.answerTime = Math.round(durationMs / 1000);
    base.question = publicQuestion(question, room.currentIndex);
    base.myAnswers = room.answers[room.currentIndex]?.[viewer.id] || {};
    base.submitted = Boolean(room.submitted?.[viewer.id]);
  } else if (room.phase === 'review') {
    base.review = reviewView(room, viewer);
  } else if (room.phase === 'results') {
    base.results = room.results || [];
    base.finishedAt = room.finishedAt;
  }

  return base;
}

/* ------------------------------------------------------------------ */
/* Nettoyage / stats                                                   */
/* ------------------------------------------------------------------ */

function sweep() {
  const now = Date.now();
  for (const room of [...rooms.values()]) {
    const hasConnected = room.players.some((p) => p.connected);

    if (!hasConnected && now - room.updatedAt > EMPTY_ROOM_TTL) {
      deleteRoom(room.code, 'Salon inactif : supprimé de la mémoire.');
      continue;
    }
    if (room.phase === 'results' && now - (room.finishedAt || now) > FINISHED_ROOM_TTL) {
      deleteRoom(room.code, 'Salon terminé : supprimé de la mémoire.');
      continue;
    }
    if (room.phase === 'lobby' && now - room.createdAt > STALE_LOBBY_TTL) {
      deleteRoom(room.code, 'Salon expiré : supprimé de la mémoire.');
    }
  }
}

const sweeper = setInterval(sweep, 30_000);
sweeper.unref?.();

function stats() {
  let players = 0;
  for (const room of rooms.values()) {
    players += room.players.filter((p) => p.connected).length;
  }
  return {
    rooms: rooms.size,
    connectedPlayers: players,
    questions: questionCount,
  };
}

module.exports = {
  RoomError,
  MAX_PLAYERS,
  QUESTION_COUNTS,
  ANSWER_TIMES,
  GAME_MODES,
  setHooks,
  stats,
  createRoom,
  joinRoom,
  handleDisconnect,
  findRoomBySocket,
  leaveRoom,
  updateConfig,
  setPlayerEmoji,
  startGame,
  restartGame,
  submitAnswer,
  castVote,
  skipReview,
  previousReview,
  replayGame,
  finishGame,
  snapshotFor,
  deleteRoom,
  sweep,
};
