'use strict';

/**
 * Test de rendu DOM (jsdom) : vérifie les 5 écrans sans navigateur.
 *   npm run test:ui
 */

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const appScript = fs.readFileSync(path.join(ROOT, 'public', 'js', 'app.js'), 'utf8');

let failures = 0;
function ok(condition, label, extra = '') {
  if (condition) console.log(`  ✓ ${label}`);
  else {
    failures += 1;
    console.error(`  ✗ ${label}${extra ? ` — ${extra}` : ''}`);
  }
}
function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/* ----------------------------- faux socket ----------------------------- */

const handlers = new Map();
const emitted = [];

const fakeSocket = {
  connected: true,
  on(event, callback) {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(callback);
    return fakeSocket;
  },
  emit(event, payload, ack) {
    emitted.push({ event, payload });
    if (typeof ack === 'function') {
      ack({ ok: true, code: '1234', playerId: 'player-1' });
    }
    return fakeSocket;
  },
};

function pushState(snapshot) {
  for (const callback of handlers.get('state') || []) callback(snapshot);
}

function lastEmit(event) {
  return [...emitted].reverse().find((entry) => entry.event === event);
}

/* ----------------------------- DOM ----------------------------- */

const dom = new JSDOM(html, {
  url: 'http://localhost:3000/',
  runScripts: 'outside-only',
  pretendToBeVisual: true,
});

const { window } = dom;
window.io = () => fakeSocket;
window.matchMedia = () => ({
  matches: false,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
});
let confirmCalls = 0;
window.confirm = () => {
  confirmCalls += 1;
  return true;
};
window.HTMLElement.prototype.scrollIntoView = () => {};
window.eval(appScript);

const document = window.document;
const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

/* ----------------------------- snapshots ----------------------------- */

const PLAYERS = [
  { id: 'player-1', name: 'Alice', isHost: true, connected: true, score: 0, submitted: false },
  { id: 'player-2', name: 'Bob', isHost: false, connected: true, score: 0, submitted: false },
];

function snapshot(phase, extra = {}) {
  return {
    code: '1234',
    phase,
    serverNow: Date.now(),
    config: { questionCount: 10, answerTime: 10, mode: 'mixte' },
    questionCount: 10,
    hostId: 'player-1',
    maxPlayers: 10,
    me: { id: 'player-1', name: 'Alice', isHost: true },
    players: PLAYERS.map((player) => ({ ...player })),
    ...extra,
  };
}

const viewVisible = (name) => !$(`#view-${name}`).hidden;

/* ----------------------------- scénario ----------------------------- */

try {
  console.log('\nWahliQuiz — test de rendu DOM\n');
  assert(viewVisible('home'), 'l’accueil doit être visible au démarrage');
  ok(true, 'écran d’accueil affiché');

  /* --- Lobby --- */
  pushState(snapshot('lobby'));
  ok(viewVisible('lobby'), 'écran lobby affiché');
  ok($('#room-code').textContent === '1234', 'code du salon affiché');
  ok($$('#players-list .player').length === 2, 'deux joueurs listés');
  ok($('#chips-count .chip[data-value="10"]').getAttribute('aria-pressed') === 'true', 'config 10 questions sélectionnée');
  ok($('#chips-count .chip[data-value="3"]') !== null, 'option 3 questions disponible');
  ok($('#chips-mode .chip[data-value="mixte"]').getAttribute('aria-pressed') === 'true', 'mode tous les formats sélectionné');
  ok($('#chips-mode .chip[data-value="petitbac"]') !== null, 'option Petit Bac uniquement disponible');
  ok($('#btn-start').hidden === false, 'bouton lancer visible pour l’hôte');
  ok($('#btn-test-celebrities') === null, 'le bouton de test de célébrités a été retiré');
  ok($$('#players-list .avatar-picker').length === 1, 'seul son propre joueur peut choisir un avatar');
  $('.avatar-option[aria-label="Choisir 🐱 comme avatar"]').click();
  ok(lastEmit('room:avatar')?.payload?.emoji === '🐱', 'choisir un emoji émet room:avatar');
  pushState(
    snapshot('lobby', {
      players: PLAYERS.map((player) => ({
        ...player,
        emoji: player.id === 'player-1' ? '🐱' : '',
      })),
    }),
  );
  ok($('#players-list .player.self .avatar').textContent === '🐱', 'l’emoji choisi apparaît sur le joueur');
  ok(
    $('.avatar-option[aria-label="Choisir 🐱 comme avatar"]').getAttribute('aria-pressed') === 'true',
    'l’emoji choisi est marqué comme sélectionné',
  );

  $('#chips-count .chip[data-value="20"]').click();
  const configEvent = lastEmit('room:config');
  ok(configEvent?.payload?.questionCount === 20, 'changer le nombre de questions émet room:config');

  $('#chips-count .chip[data-value="3"]').click();
  ok(lastEmit('room:config')?.payload?.questionCount === 3, 'le mode 3 questions émet room:config');

  $('#chips-mode .chip[data-value="petitbac"]').click();
  ok(lastEmit('room:config')?.payload?.mode === 'petitbac', 'le mode Petit Bac uniquement émet room:config');

  $('#btn-start').click();
  ok(lastEmit('game:start') !== undefined, 'le bouton lancer émet game:start');

  /* --- QCM --- */
  const mcqStartedAt = Date.now();
  const mcqQuestion = {
    index: 0,
    type: 'mcq',
    typeLabel: 'QCM',
    prompt: 'Quel est le plus grand océan ?',
    slots: [{ key: 'answer', label: 'Réponse' }],
    choices: ['Pacifique', 'Atlantique', 'Indien', 'Arctique'],
  };
  pushState(
    snapshot('playing', {
      index: 0,
      endsAt: Date.now() + 10000,
      startedAt: mcqStartedAt,
      answerTime: 10,
      question: mcqQuestion,
      myAnswers: {},
      submitted: false,
    }),
  );
  ok(viewVisible('play'), 'écran de jeu affiché');
  ok($$('.choice').length === 4, 'quatre choix de QCM rendus');
  ok($('#play-index').textContent === 'Question 1 / 10', 'compteur de question correct');

  $$('.choice')[1].click();
  ok($$('.choice')[1].classList.contains('selected'), 'le choix sélectionné est mis en évidence');
  ok(
    emitted.filter((entry) => entry.event === 'game:answer' && entry.payload.autosave).length === 0,
    'le choix QCM n’est pas envoyé pendant la réflexion',
  );
  pushState(
    snapshot('playing', {
      index: 0,
      endsAt: Date.now() - 1,
      startedAt: mcqStartedAt,
      answerTime: 10,
      question: mcqQuestion,
      myAnswers: {},
      submitted: false,
    }),
  );
  ok(
    lastEmit('game:answer')?.payload?.autosave === true &&
      lastEmit('game:answer')?.payload?.answers?.answer === 1,
    'la réponse QCM est prise en compte à la fin du temps sans confirmation',
  );

  /* --- Question image --- */
  pushState(
    snapshot('playing', {
      index: 1,
      endsAt: Date.now() + 8000,
      startedAt: Date.now(),
      answerTime: 10,
      question: {
        index: 1,
        type: 'image',
        typeLabel: 'Image mystère',
        prompt: 'Qui est cette célébrité ?',
        image: '/assets/images/celebs/8.jpg',
        slots: [
          { key: 'answer', label: 'Nom de la célébrité' },
        ],
      },
      myAnswers: {},
      submitted: false,
    }),
  );
  ok(
    $('#question-card img')?.getAttribute('src') === '/assets/images/celebs/8.jpg',
    'la photo de célébrité est affichée depuis son fichier local',
  );
  ok($$('#question-card input').length === 1, 'un seul champ pour le nom de la célébrité');
  const answersBeforeTyping = emitted.filter((entry) => entry.event === 'game:answer').length;
  const imageInputs = $$('#question-card input');
  imageInputs[0].value = 'Charlie Chaplin';
  imageInputs[0].dispatchEvent(new window.Event('input', { bubbles: true }));
  imageInputs[0].dispatchEvent(new window.Event('change', { bubbles: true }));
  imageInputs[0].dispatchEvent(new window.FocusEvent('blur', { bubbles: true }));
  ok(
    emitted.filter((entry) => entry.event === 'game:answer').length === answersBeforeTyping,
    'saisir une réponse et quitter le champ ne l’envoie pas',
  );
  $('#btn-answer').click();
  ok(
    lastEmit('game:answer')?.payload?.answers?.answer === 'Charlie Chaplin',
    'le nom est envoyé après confirmation explicite',
  );

  /* --- Petit Bac (temps doublé) --- */
  const petitBacStartedAt = Date.now();
  const autosavesBeforePetitBac = emitted.filter(
    (entry) => entry.event === 'game:answer' && entry.payload.autosave,
  ).length;
  pushState(
    snapshot('playing', {
      index: 2,
      endsAt: Date.now() + 20000,
      startedAt: petitBacStartedAt,
      answerTime: 20,
      question: {
        index: 2,
        type: 'petitbac',
        typeLabel: 'Petit Bac',
        prompt: 'Petit Bac',
        letter: 'B',
        categories: ['Pays', 'Animal', 'Métier', 'Célébrité'],
        slots: [
          { key: 'Pays', label: 'Pays' },
          { key: 'Animal', label: 'Animal' },
          { key: 'Métier', label: 'Métier' },
          { key: 'Célébrité', label: 'Célébrité' },
        ],
      },
      myAnswers: {},
      submitted: false,
    }),
  );
  ok($$('#question-card input').length === 4, 'quatre champs pour le Petit Bac');
  ok($('.letter-hero')?.textContent === 'B', 'la lettre tirée est affichée');
  ok($('#timer-value').textContent === '20', 'le Petit Bac affiche son temps doublé');
  const petitBacInput = $('#question-card input');
  petitBacInput.value = 'Belgique';
  petitBacInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  petitBacInput.dispatchEvent(new window.FocusEvent('blur', { bubbles: true }));
  ok(
    emitted.filter((entry) => entry.event === 'game:answer' && entry.payload.autosave).length ===
      autosavesBeforePetitBac,
    'le Petit Bac ne transmet pas les mots pendant la saisie',
  );
  ok($('#answer-state').hidden, 'la sauvegarde du Petit Bac ne marque pas la réponse comme confirmée');
  pushState(
    snapshot('playing', {
      index: 2,
      endsAt: Date.now() - 1,
      startedAt: petitBacStartedAt,
      answerTime: 20,
      question: {
        index: 2,
        type: 'petitbac',
        typeLabel: 'Petit Bac',
        prompt: 'Petit Bac',
        letter: 'B',
        categories: ['Pays', 'Animal', 'Métier', 'Célébrité'],
        slots: [
          { key: 'Pays', label: 'Pays' },
          { key: 'Animal', label: 'Animal' },
          { key: 'Métier', label: 'Métier' },
          { key: 'Célébrité', label: 'Célébrité' },
        ],
      },
      myAnswers: {},
      submitted: false,
    }),
  );
  ok(
    lastEmit('game:answer')?.payload?.autosave === true &&
      lastEmit('game:answer')?.payload?.answers?.Pays === 'Belgique',
    'le Petit Bac transmet les réponses non confirmées à la fin du temps',
  );

  /* --- Rébus --- */
  const rebusStartedAt = Date.now();
  pushState(
    snapshot('playing', {
      index: 3,
      endsAt: Date.now() + 8000,
        startedAt: rebusStartedAt,
      answerTime: 10,
      question: {
        index: 3,
        type: 'rebus',
        typeLabel: 'Rébus',
        prompt: 'Quel mot se cache derrière ce rébus ?',
        emojis: '🐱💧',
        slots: [{ key: 'answer', label: 'Réponse' }],
      },
      myAnswers: {},
      submitted: false,
    }),
  );
  ok($('.rebus')?.textContent === '🐱💧', 'le rébus est affiché');
  ok($$('#question-card input').length === 1, 'un champ texte pour le rébus');
  const rebusInput = $('#question-card input');
  rebusInput.value = 'chaton';
  rebusInput.dispatchEvent(new window.Event('input', { bubbles: true }));
  ok(
    emitted.filter((entry) => entry.event === 'game:answer' && entry.payload.autosave).length === 2,
    'la réponse texte du rébus n’est pas envoyée pendant la saisie',
  );
  pushState(
    snapshot('playing', {
      index: 3,
      endsAt: Date.now() - 1,
      startedAt: rebusStartedAt,
      answerTime: 10,
      question: {
        index: 3,
        type: 'rebus',
        typeLabel: 'Rébus',
        prompt: 'Quel mot se cache derrière ce rébus ?',
        emojis: '🐱💧',
        slots: [{ key: 'answer', label: 'Réponse' }],
      },
      myAnswers: {},
      submitted: false,
    }),
  );
  ok(
    lastEmit('game:answer')?.payload?.autosave === true &&
      lastEmit('game:answer')?.payload?.answers?.answer === 'chaton',
    'la réponse texte est prise en compte à la fin du temps sans confirmation',
  );

  /* --- Correction --- */
  const reviewQuestion = {
    index: 0,
    type: 'image',
    typeLabel: 'Image mystère',
    prompt: 'Qui est cette célébrité ?',
    image: '/assets/images/celebs/8.jpg',
    slots: [{ key: 'answer', label: 'Nom de la célébrité' }],
    expectedBySlot: { answer: 'Charlie Chaplin' },
    acceptedBySlot: { answer: null },
    hint: null,
  };
  pushState(
    snapshot('review', {
      review: {
        index: 0,
        total: 10,
        question: reviewQuestion,
        items: [
          {
            pid: 'player-1',
            name: 'Alice',
            slot: 'answer',
            slotLabel: 'Réponse',
            value: 'Charlie Chaplin',
            status: 'pending',
            resolvedBy: 'vote',
            skipped: false,
            yes: null,
            no: null,
            total: null,
          },
          {
            pid: 'player-2',
            name: 'Bob',
            slot: 'answer',
            slotLabel: 'Réponse',
            value: '',
            status: 'empty',
            resolvedBy: 'vote',
            skipped: false,
            yes: null,
            no: null,
            total: null,
          },
        ],
        myVotes: {},
        autoGraded: false,
        allResolved: false,
        voters: { voted: 0, total: 2 },
      },
    }),
  );
  ok(viewVisible('review'), 'écran de correction affiché');
  ok(
    $('#review-question').textContent.includes('Charlie Chaplin'),
    'le nom de la célébrité attendue est affiché',
  );
  ok($$('.vote-btn.yes').length === 0, 'aucun bouton de vote pour sa propre réponse');
  ok(
    $$('.tally').some((item) => item.textContent.includes('ne pouvez pas voter')),
    'l’avertissement indique qu’on ne peut pas voter pour sa propre réponse',
  );
  ok($$('.rv-row.empty').length === 1, 'la réponse vide est marquée sans réponse');

  const acceptedReview = {
    index: 0,
    total: 10,
    question: reviewQuestion,
    items: [
      {
        pid: 'player-1',
        name: 'Alice',
        slot: 'answer',
        slotLabel: 'Réponse',
        value: 'Japon',
        status: 'accepted',
        resolvedBy: 'vote',
        skipped: false,
        yes: 2,
        no: 0,
        total: 2,
      },
      {
        pid: 'player-2',
        name: 'Bob',
        slot: 'answer',
        slotLabel: 'Réponse',
        value: '',
        status: 'empty',
        resolvedBy: 'vote',
        skipped: false,
        yes: null,
        no: null,
        total: null,
      },
    ],
    myVotes: { 'player-1|answer': 'yes' },
    autoGraded: false,
    allResolved: true,
    voters: { voted: 2, total: 2 },
  };
  pushState(snapshot('review', { review: acceptedReview }));
  ok($$('.rv-row.accepted').length === 1, 'la réponse validée est mise en évidence');
  ok($('#review-notice').hidden === false, 'le message de fin de correction apparaît');
  ok($('#btn-prev-review').hidden === true, 'pas de bouton Précédent sur la première correction');

  const confirmsBeforeNext = confirmCalls;
  $('#btn-next-review').click();
  ok(lastEmit('review:next') !== undefined, 'le bouton suivant émet review:next');
  ok(confirmCalls === confirmsBeforeNext, 'aucune confirmation pour passer à la correction suivante');

  pushState(snapshot('review', { review: { ...acceptedReview, index: 1 } }));
  ok($('#btn-prev-review').hidden === false, 'le bouton Précédent est visible pour l’hôte');
  $('#btn-prev-review').click();
  ok(lastEmit('review:previous') !== undefined, 'le bouton Précédent émet review:previous');

  pushState(
    snapshot('review', {
      me: { id: 'player-2', name: 'Bob', isHost: false },
      review: { ...acceptedReview, index: 1 },
    }),
  );
  ok($('#btn-prev-review').hidden === true, 'un invité ne voit pas le bouton Précédent');
  ok($('#btn-next-review').hidden === true, 'un invité ne voit pas le bouton Question suivante');
  ok($('#review-guest-hint').hidden === false, 'l’invité voit que seul l’hôte fait avancer la correction');

  /* --- Résultats --- */
  pushState(
    snapshot('results', {
      finishedAt: 1750000000000,
      results: [
        { id: 'player-1', name: 'Alice', score: 5, rank: 1, connected: true },
        { id: 'player-2', name: 'Bob', score: 3, rank: 2, connected: true },
      ],
    }),
  );
  ok(viewVisible('results'), 'écran de résultats affiché');
  ok($('#reveal-stage .reveal-card') !== null, 'la révélation commence par le dernier joueur');
  ok($('#reveal-stage').textContent.includes('Bob'), 'le dernier du classement est révélé en premier');

  $('#reveal-stage').click();
  ok($('#podium-wrap').hidden === false, 'le podium apparaît après la révélation');
  ok($('#winner-card').textContent.includes('Alice'), 'le vainqueur est affiché');
  ok($$('#podium .pod').length === 2, 'les barres du podium sont rendues');
  ok($$('#results-list .result-row').length === 2, 'le classement complet est listé');
  ok($('#btn-rematch').hidden === false, 'l’hôte peut lancer une revanche immédiate');
  ok($('#btn-replay').hidden === false, 'l’hôte peut revenir au lobby');

  $('#btn-rematch').click();
  ok(lastEmit('game:restart') !== undefined, 'le bouton revanche émet game:restart');
  $('#btn-replay').click();
  ok(lastEmit('game:replay') !== undefined, 'le bouton retour au lobby émet game:replay');

  /* --- Retour au lobby après replay --- */
  pushState(snapshot('lobby'));
  ok(viewVisible('lobby'), 'le retour au lobby fonctionne');
  ok($('#podium-wrap').hidden === true, 'le podium est masqué hors résultats');

  dom.window.close();
  console.log(failures === 0 ? '\n✓ Tous les rendus sont valides.\n' : `\n✗ ${failures} test(s) en échec.\n`);
  process.exitCode = failures === 0 ? 0 : 1;
} catch (error) {
  console.error('\n✗ Test DOM interrompu :', error);
  process.exitCode = 1;
  dom.window.close();
}
