'use strict';

/**
 * Test de bout en bout : lance un serveur isolé, simule 3 joueurs,
 * joue une partie complète, vérifie la correction par vote puis le classement.
 *
 *   npm run test:flow
 */

const { spawn } = require('node:child_process');
const path = require('node:path');
const { io } = require('socket.io-client');

const questionBank = require(path.join(__dirname, '..', 'data', 'questions.json'));
const EXPECTED_QUESTIONS = questionBank.questions.length;

const PORT = Number(process.env.TEST_PORT) || 3111;
const BASE = `http://127.0.0.1:${PORT}`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let serverProcess;
let failures = 0;

function ok(condition, label, extra = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
  } else {
    failures += 1;
    console.error(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function waitForHealth(timeout = 15000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    try {
      const response = await fetch(`${BASE}/api/health`);
      if (response.ok) return response.json();
    } catch {
      /* pas encore prêt */
    }
    await sleep(150);
  }
  throw new Error('Le serveur de test ne répond pas.');
}

function startServer() {
  serverProcess = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: {
      ...process.env,
      PORT: String(PORT),
      HOST: '127.0.0.1',
      EMPTY_ROOM_TTL_MS: '700',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  serverProcess.stdout.on('data', () => {});
  serverProcess.stderr.on('data', (chunk) => console.error('[serveur]', String(chunk).trim()));
}

function connectPlayer(name, playerId) {
  const socket = io(BASE, {
    transports: ['websocket'],
    forceNew: true,
    reconnection: false,
  });

  const client = {
    name,
    playerId,
    socket,
    state: null,
    answered: new Set(),
    voted: new Set(),
    connected: false,
  };

  client.ready = new Promise((resolve, reject) => {
    socket.on('connect', () => {
      client.connected = true;
      resolve(client);
    });
    socket.on('connect_error', (error) => reject(error));
  });

  socket.on('state', (snapshot) => {
    client.state = snapshot;
    client.id = snapshot.me.id;
  });

  return client;
}

function emitAck(socket, event, payload) {
  return new Promise((resolve) => {
    socket.emit(event, payload, resolve);
  });
}

async function waitUntil(predicate, label, timeout = 30000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    if (predicate()) return;
    await sleep(60);
  }
  throw new Error(`Timeout en attendant : ${label}`);
}

function buildAnswers(state) {
  const question = state.question;
  if (question.type === 'mcq') {
    return { answer: state.index % question.choices.length };
  }
  const answers = {};
  for (const slot of question.slots) {
    answers[slot.key] = `Réponse ${slot.label}`;
  }
  return answers;
}

async function main() {
  console.log('\nWahliQuiz — test de flux complet\n');

  startServer();
  const health = await waitForHealth();
  ok(
    health.ok && health.questions === EXPECTED_QUESTIONS,
    `serveur démarré, ${EXPECTED_QUESTIONS} questions chargées`,
    JSON.stringify(health),
  );

  const host = connectPlayer('Alice', 'test-alice-0001');
  const bob = connectPlayer('Bob', 'test-bob-0002');
  const cara = connectPlayer('Cara', 'test-cara-0003');
  await Promise.all([host.ready, bob.ready, cara.ready]);

  // Code invalide
  const badJoin = await emitAck(host.socket, 'room:join', {
    code: '0000',
    name: 'Alice',
    playerId: host.playerId,
  });
  ok(badJoin.ok === false, 'un code inconnu est refusé');

  // Création du salon
  const created = await emitAck(host.socket, 'room:create', { name: host.name, playerId: host.playerId });
  ok(created.ok === true && /^\d{4}$/.test(created.code), `salon créé avec le code ${created.code}`);
  const code = created.code;

  for (const player of [bob, cara]) {
    const joined = await emitAck(player.socket, 'room:join', {
      code,
      name: player.name,
      playerId: player.playerId,
    });
    assert(joined.ok, `échec de connexion de ${player.name}`);
  }

  await waitUntil(
    () => host.state && host.state.phase === 'lobby' && host.state.players.length === 3,
    'les 3 joueurs dans le lobby',
  );
  ok(host.state.players.length === 3, '3 joueurs connectés dans le lobby');

  // Doublon de pseudo
  const duplicate = connectPlayer('Bob', 'test-doublon-04');
  await duplicate.ready;
  const duplicateJoin = await emitAck(duplicate.socket, 'room:join', {
    code,
    name: 'bob',
    playerId: duplicate.playerId,
  });
  ok(duplicateJoin.ok === false, 'un pseudo déjà pris est refusé');
  duplicate.socket.close();

  // Configuration
  const config = await emitAck(host.socket, 'room:config', { questionCount: 10, answerTime: 5 });
  assert(config.ok, 'configuration refusée');
  await waitUntil(() => host.state.config.questionCount === 10, 'configuration appliquée');
  ok(true, 'hôte : 10 questions / 5 s par réponse');

  const guestConfig = await emitAck(bob.socket, 'room:config', { questionCount: 20, answerTime: 10 });
  ok(guestConfig.ok === false, 'un joueur non-hôte ne peut pas modifier les réglages');

  // Lancement
  const started = await emitAck(host.socket, 'game:start', {});
  assert(started.ok, 'lancement refusé');

  const players = [host, bob, cara];
  await waitUntil(
    () => host.state?.phase === 'playing' && bob.state?.phase === 'playing',
    'première question',
  );
  const initialAnswers = buildAnswers(host.state);
  const autosave = await emitAck(host.socket, 'game:answer', {
    index: host.state.index,
    answers: initialAnswers,
    autosave: true,
  });
  assert(autosave.ok, 'autosave accepté sans confirmation');

  const bobAnswer = await emitAck(bob.socket, 'game:answer', {
    index: bob.state.index,
    answers: buildAnswers(bob.state),
  });
  assert(bobAnswer.ok, 'réponse confirmée de Bob refusée');
  await waitUntil(
    () => host.state.players.find((player) => player.id === bob.playerId)?.submitted,
    'confirmation de Bob',
  );
  const autosaveWasStored =
    Object.keys(host.state.myAnswers).length === Object.keys(initialAnswers).length &&
    Object.entries(initialAnswers).every(([slot, value]) => host.state.myAnswers[slot] === value);
  ok(
    !host.state.submitted && !autosaveWasStored,
    'un autosave avant la fin du temps n’envoie ni ne confirme la réponse',
  );

  async function playGame(participants, verifyPetitBacDraft = false) {
    const answered = new Set();
    const voted = new Set();
    const seen = new Set();
    const types = new Set();
    let revealedReview = false;
    let sawPetitBac = false;
    let petitBacDraftIndex = null;
    let petitBacDraftExpected = null;
    let petitBacDraftIncluded = false;
    let timingOk = true;
    let nextReview = -1;

    await waitUntil(() => host.state?.phase === 'playing', 'démarrage de la partie');

    await waitUntil(
      () => {
        const state = host.state;
        if (!state) return false;
        if (state.phase === 'playing') {
          seen.add(state.index);
          types.add(state.question.type);
          const expectedTime =
            state.config.answerTime * (state.question.type === 'petitbac' ? 2 : 1);
          if (state.question.type === 'petitbac') sawPetitBac = true;
          if (state.answerTime !== expectedTime) timingOk = false;
          if (Math.abs(state.endsAt - state.startedAt - expectedTime * 1000) > 150) {
            timingOk = false;
          }

          for (const player of participants) {
            if (!player.state || player.state.phase !== 'playing') continue;
            const key = `${player.playerId}:${player.state.startedAt}:${player.state.index}`;
            if (answered.has(key)) continue;
            answered.add(key);
            const answers = buildAnswers(player.state);
            if (
              verifyPetitBacDraft &&
              player === host &&
              player.state.question.type === 'petitbac' &&
              petitBacDraftIndex === null
            ) {
              petitBacDraftIndex = player.state.index;
              petitBacDraftExpected = Object.values(answers)[0];
              const draftIndex = player.state.index;
              const draftAnswers = answers;
              setTimeout(() => {
                player.socket.emit(
                  'game:answer',
                  { index: draftIndex, answers: draftAnswers, autosave: true },
                  () => {},
                );
              }, Math.max(0, player.state.endsAt - Date.now()) + 50);
            } else {
              player.socket.emit('game:answer', { index: player.state.index, answers }, () => {});
            }
          }
        }
        if (state.phase === 'review') {
          revealedReview = true;
          for (const player of participants) {
            const review = player.state?.review;
            if (!review) continue;
            if (
              verifyPetitBacDraft &&
              player === host &&
              review.index === petitBacDraftIndex &&
              review.items.some(
                (item) => item.pid === host.playerId && item.value === petitBacDraftExpected,
              )
            ) {
              petitBacDraftIncluded = true;
            }
            for (const item of review.items) {
              if (item.status !== 'pending') continue;
              const key = `${player.playerId}:${review.index}:${item.pid}:${item.slot}`;
              if (voted.has(key)) continue;
              voted.add(key);
              player.socket.emit(
                'review:vote',
                { index: review.index, pid: item.pid, slot: item.slot, value: 'yes' },
                () => {},
              );
            }
          }

          // Plus aucun passage automatique : c'est l'hôte qui lance la suite.
          const allResolved = participants.every(
            (player) => player.state?.phase === 'review' && player.state.review?.allResolved,
          );
          if (allResolved && nextReview !== state.review.index) {
            nextReview = state.review.index;
            host.socket.emit('review:next', {}, () => {});
          }
        }
        return state.phase === 'results';
      },
      'fin de partie et classement',
      90000,
    );

    return {
      questionsSeen: seen.size,
      typesSeen: [...types],
      revealedReview,
      sawPetitBac,
      timingOk,
      petitBacDraftIncluded,
    };
  }

  const firstGame = await playGame(players, true);
  ok(firstGame.questionsSeen >= 10, `${firstGame.questionsSeen} questions vues (au moins 10)`);
  ok(firstGame.revealedReview, 'la phase de correction collaborative a eu lieu');
  ok(firstGame.sawPetitBac, 'au moins une manche de Petit Bac a été jouée');
  ok(firstGame.petitBacDraftIncluded, 'un brouillon Petit Bac est pris en compte sans validation');
  ok(firstGame.timingOk, 'Petit Bac : 100 % de temps en plus ; autres formats : temps de base');

  const results = host.state.results;
  ok(Array.isArray(results) && results.length === 3, 'classement de 3 joueurs');
  ok(
    results.every((entry, i) => i === 0 || results[i - 1].score >= entry.score),
    'classement trié par score décroissant',
  );
  ok(results[0].score > 0, 'des points ont été attribués par les votes');
  ok(
    results.reduce((sum, entry) => sum + entry.score, 0) > 0,
    `score total distribué : ${results.reduce((sum, entry) => sum + entry.score, 0)} pt`,
  );
  console.log(`  → podium : ${results.map((r) => `${r.rank}. ${r.name} (${r.score})`).join(' · ')}`);

  // Retour au lobby (hôte)
  const replay = await emitAck(host.socket, 'game:replay', {});
  assert(replay.ok, 'replay refusé');
  await waitUntil(() => host.state.phase === 'lobby', 'retour au lobby');
  ok(host.state.phase === 'lobby' && host.state.players.length === 3, 'rejouer ramène tout le monde au lobby');

  // Reconnexion d'un joueur (rafraîchissement)
  const bobId = bob.id;
  bob.socket.close();
  await sleep(120);
  const bobAgain = connectPlayer('Bob', bob.playerId);
  await bobAgain.ready;
  const rejoin = await emitAck(bobAgain.socket, 'room:join', {
    code,
    name: 'Bob',
    playerId: bob.playerId,
  });
  ok(rejoin.ok === true, 'reconnexion avec le même identifiant acceptée');
  await waitUntil(() => bobAgain.state && bobAgain.state.me.id === bobId, 'état restauré après reconnexion');
  ok(true, 'le joueur retrouve son état après reconnexion');

  // Partie courte : 3 questions, uniquement des grilles de Petit Bac
  const shortConfig = await emitAck(host.socket, 'room:config', {
    questionCount: 3,
    answerTime: 5,
    mode: 'petitbac',
  });
  assert(shortConfig.ok, 'configuration 3 questions refusée');
  await waitUntil(
    () => host.state.config.questionCount === 3 && host.state.config.mode === 'petitbac',
    'configuration 3 questions appliquée',
  );
  ok(true, 'hôte : partie à 3 questions, mode Petit Bac uniquement');

  const shortStart = await emitAck(host.socket, 'game:start', {});
  assert(shortStart.ok, 'lancement de la partie courte refusé');
  const shortGame = await playGame([host, bobAgain, cara]);
  ok(shortGame.questionsSeen === 3, `la partie courte contient ${shortGame.questionsSeen} questions`);
  ok(
    shortGame.typesSeen.length > 0 && shortGame.typesSeen.every((type) => type === 'petitbac'),
    'le mode Petit Bac uniquement ne propose que des grilles de Petit Bac',
  );
  ok(shortGame.revealedReview, 'la correction de la partie courte a eu lieu');

  // Revanche immédiate : même salon, sans repasser par le lobby
  const restart = await emitAck(host.socket, 'game:restart', {});
  assert(restart.ok, 'revanche immédiate refusée');
  await waitUntil(() => host.state.phase === 'playing', 'revanche immédiate lancée');
  ok(host.state.code === code, 'la revanche conserve le même salon');
  ok(host.state.players.length === 3, 'la revanche conserve les 3 joueurs');
  ok(host.state.players.every((p) => p.score === 0), 'les scores repartent de zéro');
  ok(host.state.questionCount === 3, 'la revanche conserve les réglages (3 questions)');
  ok(host.state.config.mode === 'petitbac', 'la revanche conserve le mode Petit Bac uniquement');

  // Navigation dans la correction : seul l'hôte avance, et il peut revenir en arrière
  await waitUntil(
    () =>
      [host, bobAgain, cara].every(
        (player) => player.state?.phase === 'playing' && player.state.index === 0,
      ),
    'première question de la revanche',
  );
  for (const player of [host, bobAgain, cara]) {
    const answers = buildAnswers(player.state);
    player.socket.emit('game:answer', { index: player.state.index, answers }, () => {});
  }
  await waitUntil(() => host.state.phase === 'review', 'correction de la revanche');

  const guestNext = await emitAck(bobAgain.socket, 'review:next', {});
  ok(guestNext.ok === false, 'un joueur non-hôte ne peut pas passer à la suite');
  const guestPrev = await emitAck(bobAgain.socket, 'review:previous', {});
  ok(guestPrev.ok === false, 'un joueur non-hôte ne peut pas revenir en arrière');

  const nextFromFirst = await emitAck(host.socket, 'review:next', {});
  assert(nextFromFirst.ok, 'passage à la correction suivante refusé');
  await waitUntil(() => host.state.review?.index === 1, 'deuxième correction');

  const back = await emitAck(host.socket, 'review:previous', {});
  assert(back.ok, 'retour à la correction précédente refusé');
  await waitUntil(() => host.state.review?.index === 0, 'retour à la première correction');
  ok(true, 'la correction permet de revenir en arrière');

  const forward = await emitAck(host.socket, 'review:next', {});
  assert(forward.ok, 'retour à la deuxième correction refusé');
  await waitUntil(() => host.state.review?.index === 1, 'retour à la deuxième correction');
  ok(true, 'on peut repasser à la correction suivante');

  // Nettoyage : tous les joueurs partent
  for (const player of [host, cara, bobAgain]) {
    player.socket.emit('room:leave', {});
    player.socket.close();
  }
  await sleep(2200);
  const after = await fetch(`${BASE}/api/health`).then((response) => response.json());
  ok(after.rooms === 0, 'le salon est supprimé de la mémoire quand tout le monde part');

  console.log(
    failures === 0
      ? '\n✓ Tous les tests sont passés.\n'
      : `\n✗ ${failures} test(s) en échec.\n`,
  );
  process.exitCode = failures === 0 ? 0 : 1;
}

main()
  .catch((error) => {
    console.error('\n✗ Test interrompu :', error.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await sleep(200);
    if (serverProcess) serverProcess.kill();
    setTimeout(() => process.exit(process.exitCode || 0), 300);
  });
