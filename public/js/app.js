/* global io */
(() => {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Références DOM & état                                              */
  /* ------------------------------------------------------------------ */

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

  const els = {
    views: $$('.view'),
    home: $('#view-home'),
    lobby: $('#view-lobby'),
    play: $('#view-play'),
    review: $('#view-review'),
    results: $('#view-results'),
    name: $('#input-name'),
    code: $('#input-code'),
    joinRow: $('#join-row'),
    inviteHint: $('#invite-hint'),
    btnCreate: $('#btn-create'),
    btnToggleJoin: $('#btn-toggle-join'),
    btnJoin: $('#btn-join'),
    btnQuit: $('#btn-quit'),
    connDot: $('#conn-dot'),
    roomCode: $('#room-code'),
    playerCount: $('#player-count'),
    playersList: $('#players-list'),
    btnCopy: $('#btn-copy'),
    hostSettings: $('#host-settings'),
    guestSettings: $('#guest-settings'),
    guestSummary: $('#guest-summary'),
    chipsCount: $('#chips-count'),
    chipsTime: $('#chips-time'),
    chipsMode: $('#chips-mode'),
    btnStart: $('#btn-start'),
    startHint: $('#start-hint'),
    playIndex: $('#play-index'),
    timer: $('#timer'),
    timerValue: $('#timer-value'),
    progressFill: $('#progress-fill'),
    questionCard: $('#question-card'),
    btnAnswer: $('#btn-answer'),
    answeredCount: $('#answered-count'),
    answeredList: $('#answered-list'),
    reviewIndex: $('#review-index'),
    reviewVoters: $('#review-voters'),
    reviewQuestion: $('#review-question'),
    reviewNotice: $('#review-notice'),
    reviewItems: $('#review-items'),
    btnPrevReview: $('#btn-prev-review'),
    btnNextReview: $('#btn-next-review'),
    reviewHostHint: $('#review-host-hint'),
    reviewGuestHint: $('#review-guest-hint'),
    revealStage: $('#reveal-stage'),
    podiumWrap: $('#podium-wrap'),
    winnerCard: $('#winner-card'),
    podium: $('#podium'),
    resultsList: $('#results-list'),
    btnRematch: $('#btn-rematch'),
    btnReplay: $('#btn-replay'),
    btnLeave: $('#btn-leave'),
    toast: $('#toast'),
    overlay: $('#overlay'),
    overlayText: $('#overlay-text'),
  };

  const NAME_KEY = 'wahliquiz:name';
  const PID_KEY = 'wahliquiz:player-id';
  const SESSION_KEY = 'wahliquiz:session';
  const AVATAR_EMOJIS = ['😀', '😎', '🥳', '🐱', '🐶', '🦊', '🐼', '🐸', '🦄', '🐙', '🚀', '⭐'];

  const state = {
    snapshot: null,
    playerId: readPlayerId(),
    code: null,
    view: 'home',
    answers: {},
    draftSavedKey: '',
    clockOffset: 0,
    questionKey: '',
    toastTimer: null,
    reveal: null,
    revealKey: null,
    revealFinished: false,
    joinInFlight: false,
    inviteCode: null,
  };

  /* ------------------------------------------------------------------ */
  /* Petits utilitaires                                                 */
  /* ------------------------------------------------------------------ */

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function setText(selector, text) {
    const node = $(selector);
    if (node) node.textContent = text;
  }

  function initials(name) {
    const parts = String(name || '?')
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    if (parts.length === 0) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }

  function avatar(name, className = 'avatar', emoji = '') {
    return el('span', `${className}${emoji ? ' avatar-emoji' : ''}`, emoji || initials(name));
  }

  function plural(count, singular, pluralForm) {
    return `${count} ${count > 1 ? pluralForm : singular}`;
  }

  function ordinal(rank) {
    return rank === 1 ? '1re' : `${rank}e`;
  }

  function readPlayerId() {
    try {
      const stored = localStorage.getItem(PID_KEY);
      if (stored && /^[A-Za-z0-9_-]{6,64}$/.test(stored)) return stored;
    } catch {
      /* stockage indisponible */
    }
    const generated =
      window.crypto && typeof window.crypto.randomUUID === 'function'
        ? window.crypto.randomUUID()
        : `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    try {
      localStorage.setItem(PID_KEY, generated);
    } catch {
      /* ignore */
    }
    return generated;
  }

  function readSession() {
    try {
      const raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || !/^\d{4}$/.test(parsed.code || '')) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function saveSession() {
    if (!state.code) return;
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify({ code: state.code, playerId: state.playerId }));
    } catch {
      /* ignore */
    }
  }

  function clearSession() {
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }
  }

  function showToast(message, kind = 'info') {
    els.toast.textContent = message;
    els.toast.className = `toast show${kind === 'error' ? ' error' : ''}`;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => {
      els.toast.className = 'toast';
    }, 2900);
  }

  function showOverlay(text) {
    els.overlayText.textContent = text;
    els.overlay.hidden = false;
  }

  function hideOverlay() {
    els.overlay.hidden = true;
  }

  function showView(name) {
    state.view = name;
    for (const view of els.views) {
      view.hidden = view.id !== `view-${name}`;
    }
    const inRoom = name !== 'home';
    els.btnQuit.hidden = !inRoom;
    els.connDot.hidden = !inRoom;
  }

  function readName() {
    const raw = els.name.value.replace(/\s+/g, ' ').trim();
    if (raw.length < 2) {
      showToast('Entrez un pseudo de 2 caractères minimum.', 'error');
      els.name.focus();
      return null;
    }
    if (raw.length > 16) {
      showToast('Votre pseudo ne doit pas dépasser 16 caractères.', 'error');
      els.name.focus();
      return null;
    }
    try {
      localStorage.setItem(NAME_KEY, raw);
    } catch {
      /* ignore */
    }
    return raw;
  }

  function emit(event, payload, onOk) {
    if (!socket.connected) {
      showToast('Connexion en cours… réessayez dans un instant.', 'error');
      return;
    }
    socket.emit(event, payload, (response) => {
      if (!response || response.ok === false) {
        showToast(response?.error || 'Action impossible.', 'error');
        return;
      }
      if (onOk) onOk(response);
    });
  }

  /* ------------------------------------------------------------------ */
  /* Navigation / session                                               */
  /* ------------------------------------------------------------------ */

  function saveUnconfirmedAnswer() {
    const snapshot = state.snapshot;
    if (
      !snapshot ||
      snapshot.phase !== 'playing' ||
      snapshot.submitted
    ) {
      return;
    }

    const key = `${snapshot.code}:${snapshot.startedAt}:${snapshot.index}`;
    if (state.draftSavedKey === key) return;
    state.draftSavedKey = key;

    const answers = {};
    if (snapshot.question.type === 'mcq') {
      if (Number.isInteger(state.answers.answer)) answers.answer = state.answers.answer;
    } else {
      for (const slot of snapshot.question.slots) {
        const value = String(state.answers[slot.key] ?? '').trim();
        if (value) answers[slot.key] = value;
      }
    }
    emit('game:answer', { index: snapshot.index, answers, autosave: true });
  }

  function resetToHome() {
    state.snapshot = null;
    state.code = null;
    state.questionKey = '';
    state.draftSavedKey = '';
    state.answers = {};
    stopReveal();
    state.revealKey = null;
    hideOverlay();
    showView('home');
    els.podiumWrap.hidden = true;
    els.revealStage.hidden = false;
    if (window.location.search) {
      history.replaceState({}, '', window.location.pathname);
    }
  }

  function leaveRoom(requireConfirm = true) {
    if (!state.snapshot) {
      resetToHome();
      return;
    }
    if (requireConfirm && !window.confirm('Quitter le salon ?')) return;
    const done = () => {
      clearSession();
      resetToHome();
    };
    if (socket.connected) {
      socket.emit('room:leave', {}, () => done());
      setTimeout(done, 700);
    } else {
      done();
    }
  }

  function createRoom() {
    const name = readName();
    if (!name) return;
    emit('room:create', { name, playerId: state.playerId }, (response) => {
      state.code = response.code;
      state.playerId = response.playerId || state.playerId;
      saveSession();
      showToast('Salon créé ! Partagez le lien.');
    });
  }

  function joinRoom() {
    const name = readName();
    if (!name) return;
    const code = (els.code.value || state.inviteCode || '').trim();
    if (!/^\d{4}$/.test(code)) {
      els.joinRow.hidden = false;
      els.btnToggleJoin.setAttribute('aria-expanded', 'true');
      els.code.focus();
      showToast('Entrez un code à 4 chiffres.', 'error');
      return;
    }
    doJoin(code, name);
  }

  function doJoin(code, name, playerId = state.playerId) {
    if (state.joinInFlight) return;
    state.joinInFlight = true;
    socket.emit('room:join', { code, name, playerId }, (response) => {
      state.joinInFlight = false;
      if (!response || response.ok === false) {
        if (state.snapshot) {
          showToast(response?.error || 'Impossible de rejoindre le salon.', 'error');
        } else {
          clearSession();
          resetToHome();
          showToast(response?.error || 'Impossible de rejoindre le salon.', 'error');
          if (state.inviteCode) {
            els.joinRow.hidden = false;
            els.code.value = state.inviteCode;
          }
        }
        return;
      }
      state.playerId = response.playerId || state.playerId;
      hideOverlay();
    });
  }

  /* ------------------------------------------------------------------ */
  /* Rendu                                                              */
  /* ------------------------------------------------------------------ */

  function render() {
    const snapshot = state.snapshot;
    if (!snapshot) {
      showView('home');
      return;
    }

    if (snapshot.phase !== 'results') {
      stopReveal();
      state.revealKey = null;
      state.revealFinished = false;
      els.podiumWrap.hidden = true;
      els.revealStage.hidden = false;
    }

    if (snapshot.phase === 'lobby') renderLobby(snapshot);
    else if (snapshot.phase === 'playing') renderPlay(snapshot);
    else if (snapshot.phase === 'review') renderReview(snapshot);
    else if (snapshot.phase === 'results') renderResults(snapshot);
    else showView('home');
  }

  /* ------------------------------ Lobby ------------------------------ */

  function renderLobby(snapshot) {
    showView('lobby');

    setText('#room-code', snapshot.code);
    setText('#player-count', `${snapshot.players.length} / ${snapshot.maxPlayers}`);
    els.playersList.innerHTML = '';

    for (const player of snapshot.players) {
      const li = el('li', `player${player.id === snapshot.me.id ? ' self' : ''}${player.connected ? '' : ' offline'}`);
      li.append(avatar(player.name, 'avatar', player.emoji));
      li.append(el('span', 'player-name', player.name));
      if (player.isHost) li.append(el('span', 'player-tag host', 'Hôte'));
      if (player.id === snapshot.me.id) li.append(el('span', 'player-tag you', 'Vous'));
      else if (!player.connected) li.append(el('span', 'player-tag', 'hors ligne'));
      if (player.id === snapshot.me.id) {
        const picker = el('div', 'avatar-picker');
        picker.setAttribute('role', 'group');
        picker.setAttribute('aria-label', 'Choisir votre avatar');
        for (const emoji of AVATAR_EMOJIS) {
          const option = el('button', `avatar-option${player.emoji === emoji ? ' selected' : ''}`, emoji);
          option.type = 'button';
          option.setAttribute('aria-label', `Choisir ${emoji} comme avatar`);
          option.setAttribute('aria-pressed', String(player.emoji === emoji));
          option.addEventListener('click', () => emit('room:avatar', { emoji }));
          picker.append(option);
        }
        li.append(picker);
      }
      els.playersList.append(li);
    }

    const isHost = snapshot.me.isHost;
    const mode = snapshot.config.mode || 'mixte';
    const modeLabels = {
      mixte: 'tous les formats',
      petitbac: 'Petit Bac uniquement',
      list: 'Citez-en 3 uniquement',
    };
    const modeLabel = modeLabels[mode] || modeLabels.mixte;
    els.hostSettings.hidden = !isHost;
    els.guestSettings.hidden = isHost;
    els.btnStart.hidden = !isHost;
    els.guestSummary.textContent = `${plural(snapshot.config.questionCount, 'question', 'questions')} · ${snapshot.config.answerTime} s par réponse · ${modeLabel}`;

    for (const chip of $$('.chip', els.chipsMode)) {
      chip.setAttribute('aria-pressed', String(chip.dataset.value === mode));
      chip.disabled = !isHost;
    }
    for (const chip of $$('.chip', els.chipsCount)) {
      chip.setAttribute('aria-pressed', String(Number(chip.dataset.value) === snapshot.config.questionCount));
      chip.disabled = !isHost;
    }
    for (const chip of $$('.chip', els.chipsTime)) {
      chip.setAttribute('aria-pressed', String(Number(chip.dataset.value) === snapshot.config.answerTime));
      chip.disabled = !isHost;
    }

    if (isHost) {
      els.startHint.textContent =
        snapshot.players.length < 2
          ? 'Vous pouvez lancer en solo, mais c’est plus drôle à plusieurs.'
          : `${plural(snapshot.players.length, 'joueur', 'joueurs')} prêt${snapshot.players.length > 1 ? 's' : ''}.`;
    } else {
      els.startHint.textContent = 'En attente du lancement par l’hôte…';
    }
  }

  /* ------------------------------ Jeu ------------------------------ */

  function remainingMs(snapshot) {
    return Math.max(0, snapshot.endsAt - (Date.now() + state.clockOffset));
  }

  function renderPlay(snapshot) {
    showView('play');
    setText('#play-index', `Question ${snapshot.index + 1} / ${snapshot.questionCount}`);

    const key = `${snapshot.code}:${snapshot.startedAt}:${snapshot.index}`;
    if (state.questionKey !== key) {
      state.questionKey = key;
      state.draftSavedKey = '';
      state.answers = {};
      for (const [slot, value] of Object.entries(snapshot.myAnswers || {})) {
        state.answers[slot] = value;
      }
      buildQuestion(snapshot);
    }

    updateAnswered(snapshot);
    updateAnswerState(snapshot);
    tickTimer(snapshot);
  }

  function buildQuestion(snapshot) {
    const question = snapshot.question;
    const card = els.questionCard;
    card.innerHTML = '';
    card.className = 'card question-card';

    if (!question) {
      card.append(el('h2', 'q-prompt', 'Préparation de la question…'));
      card.append(el('p', 'hint', 'Patientez quelques instants.'));
      return;
    }

    const head = el('div', 'q-head');
    head.append(el('span', `qtype qtype-${question.type}`, question.typeLabel));
    head.append(el('span', 'muted', pointsHint(question)));
    card.append(head);

    card.append(el('h2', 'q-prompt', question.prompt));

    const media = buildMedia(question);
    if (media) card.append(media);

    card.append(buildInputs(question));

    const status = el(
      'p',
      'answer-state',
      '✓ Réponse envoyée — validez à nouveau pour enregistrer vos modifications.',
    );
    status.id = 'answer-state';
    status.hidden = true;
    card.append(status);

    requestAnimationFrame(() => {
      const firstInput = card.querySelector('input, button.choice');
      if (firstInput && window.matchMedia('(min-width: 720px)').matches) firstInput.focus();
    });
  }

  function pointsHint(question) {
    if (question.type === 'petitbac') return '1 pt par catégorie · temps doublé';
    if (question.type === 'image' && question.slots?.length > 1) return '1 point par réponse correcte';
    return '1 point';
  }

  function buildMedia(question) {
    if (question.type === 'image') {
      const wrap = el('div', 'media');
      const img = el('img');
      img.src = question.image;
      img.alt = 'Image à deviner';
      img.draggable = false;
      wrap.append(img);
      return wrap;
    }

    if (question.type === 'rebus') {
      const wrap = el('div', 'media');
      wrap.append(el('div', 'rebus', question.emojis));
      return wrap;
    }

    if (question.type === 'lyrics') {
      return buildLyricsExcerpt(question.excerpt);
    }

    if (question.type === 'petitbac') {
      const row = el('div', 'letter-row');
      row.append(el('span', 'letter-hero', question.letter));
      row.append(
        el(
          'p',
          '',
          `Trouvez un mot pour chacune des ${question.categories.length} catégories, commençant par la lettre ${question.letter}.`,
        ),
      );
      return row;
    }

    return null;
  }

  function buildLyricsExcerpt(excerpt) {
    return el('blockquote', 'lyrics-excerpt', excerpt);
  }

  function buildInputs(question) {
    const wrap = el('div', 'answer-fields');

    if (question.type === 'mcq') {
      const choices = el('div', 'choices');
      question.choices.forEach((choice, index) => {
        const button = el('button', 'choice');
        button.type = 'button';
        button.dataset.index = String(index);
        button.append(el('span', 'choice-key', String.fromCharCode(65 + index)));
        button.append(el('span', '', choice));
        button.addEventListener('click', () => {
          state.answers.answer = index;
          for (const other of $$('.choice', choices)) {
            other.classList.toggle('selected', other === button);
          }
        });
        choices.append(button);
      });
      wrap.append(choices);
      return wrap;
    }

    for (const slot of question.slots) {
      const field = el('div', 'answer-field');
      const label = el('label', 'slot-label', slot.label);
      const inputId = `answer-${question.type}-${slot.key}`;
      label.setAttribute('for', inputId);
      const input = el('input', 'input');
      input.id = inputId;
      input.type = 'text';
      input.maxLength = 60;
      input.autocomplete = 'off';
      input.spellcheck = false;
      input.value = state.answers[slot.key] ?? '';
      input.placeholder =
        question.type === 'petitbac' ? `En ${question.letter}…` : 'Votre réponse…';
      input.addEventListener('input', () => {
        state.answers[slot.key] = input.value;
      });
      field.append(label, input);
      wrap.append(field);
    }

    return wrap;
  }

  function updateAnswerState(snapshot) {
    const status = $('#answer-state');
    if (!status) return;
    status.hidden = !snapshot.submitted;
  }

  function updateAnswered(snapshot) {
    const answered = snapshot.players.filter((player) => player.submitted);
    setText('#answered-count', `${answered.length} / ${snapshot.players.filter((p) => p.connected).length}`);
    els.answeredList.innerHTML = '';
    for (const player of snapshot.players) {
      if (!player.connected) continue;
      const chip = el('li', `pchip${player.submitted ? ' done' : ''}`, player.name);
      els.answeredList.append(chip);
    }
  }

  function tickTimer(snapshot) {
    const total = Math.max(1, snapshot.answerTime * 1000);
    const remain = remainingMs(snapshot);
    const seconds = Math.ceil(remain / 1000);

    els.timerValue.textContent = String(seconds);
    els.timer.classList.toggle('warn', remain > 0 && remain <= Math.min(5000, total * 0.4));
    els.progressFill.style.width = `${Math.max(0, Math.min(100, (remain / total) * 100))}%`;

    const locked = remain <= 0;
    els.questionCard.classList.toggle('locked', locked);
    for (const node of $$('input, button', els.questionCard)) node.disabled = locked;

    if (locked) {
      els.btnAnswer.disabled = true;
      els.btnAnswer.textContent = 'Temps écoulé';
      saveUnconfirmedAnswer();
    } else {
      els.btnAnswer.disabled = false;
      els.btnAnswer.textContent = snapshot.submitted ? 'Mettre à jour ma réponse' : 'Valider ma réponse';
    }
  }

  function submitAnswer() {
    const snapshot = state.snapshot;
    if (!snapshot || snapshot.phase !== 'playing') return;
    if (remainingMs(snapshot) <= 0) {
      showToast('Temps écoulé !', 'error');
      return;
    }

    const question = snapshot.question;
    const payload = {};

    if (question.type === 'mcq') {
      if (!Number.isInteger(state.answers.answer)) {
        showToast('Choisissez une réponse.', 'error');
        return;
      }
      payload.answer = state.answers.answer;
    } else {
      let filled = 0;
      for (const slot of question.slots) {
        const value = String(state.answers[slot.key] ?? '').trim();
        if (value) {
          payload[slot.key] = value;
          filled += 1;
        }
      }
      if (question.type === 'image' && question.slots?.length > 1 && filled < question.slots.length) {
        showToast('Écrivez les deux personnalités.', 'error');
        return;
      }
      if (question.type === 'list' && filled < question.slots.length) {
        showToast('Remplissez les trois réponses.', 'error');
        return;
      }
      if (filled === 0) {
        showToast('Écrivez au moins une réponse.', 'error');
        return;
      }
    }

    emit('game:answer', { index: snapshot.index, answers: payload }, () => {
      showToast('Réponse envoyée');
    });
  }

  /* ------------------------------ Correction ------------------------------ */

  function renderReview(snapshot) {
    showView('review');
    const review = snapshot.review;

    setText('#review-index', `Correction ${review.index + 1} / ${review.total}`);
    setText('#review-voters', `${review.voters.voted} / ${review.voters.total} ont voté`);

    renderReviewQuestion(review.question, review.autoGraded);
    buildReviewItems(review, snapshot.me.id);

    if (review.allResolved) {
      els.reviewNotice.hidden = false;
      els.reviewNotice.className = 'notice ok';
      els.reviewNotice.textContent =
        review.index + 1 === review.total
          ? 'Toutes les réponses sont corrigées. L’hôte peut afficher le classement.'
          : 'Toutes les réponses sont corrigées. L’hôte peut passer à la question suivante.';
    } else {
      els.reviewNotice.hidden = true;
    }

    const isHost = snapshot.me.isHost;
    els.btnPrevReview.hidden = !isHost || review.index === 0;
    els.btnNextReview.hidden = !isHost;
    els.btnNextReview.textContent = review.index + 1 === review.total ? 'Voir le classement' : 'Question suivante';
    els.reviewHostHint.hidden = !isHost;
    els.reviewGuestHint.hidden = isHost;
  }

  function renderReviewQuestion(question, autoGraded) {
    const card = els.reviewQuestion;
    card.innerHTML = '';

    const head = el('div', 'q-head');
    head.append(el('span', `qtype qtype-${question.type}`, question.typeLabel));
    card.append(head);
    card.append(el('h2', 'q-prompt', question.prompt));

    const media = buildMedia(question);
    if (media) card.append(media);

    const expected = el('div', 'expected');
    if (question.type === 'list') {
      expected.classList.add('expected-examples');
      expected.append(el('p', 'expected-title', 'Exemples (non exhaustifs) :'));
      expected.append(el('p', 'expected-note', question.examples.join(' · ')));
    } else {
      expected.append(el('p', 'expected-title', 'Réponse attendue par le jeu'));

      for (const slot of question.slots) {
        const row = el('div', 'expected-row');
        if (question.slots.length > 1) {
          row.append(el('span', '', `${slot.label} :`));
        }
        row.append(el('strong', '', question.expectedBySlot?.[slot.key] ?? '—'));
        expected.append(row);
      }
    }

    if (question.accepted && question.accepted.length > 1) {
      const variants = question.accepted.slice(0, 8).join(', ');
      expected.append(el('p', 'expected-note', `Tolérances : ${variants}`));
    }
    if (question.acceptedBySlot) {
      for (const slot of question.slots) {
        const variants = question.acceptedBySlot[slot.key];
        if (Array.isArray(variants) && variants.length > 1) {
          expected.append(el('p', 'expected-note', `${slot.label} — Tolérances : ${variants.slice(0, 8).join(', ')}`));
        }
      }
    }
    if (question.hint) {
      expected.append(el('p', 'expected-note', `Indice du rébus : ${question.hint}`));
    }
    if (autoGraded) {
      expected.append(el('p', 'expected-note', 'QCM corrigé automatiquement : inutile de voter.'));
    }

    card.append(expected);
  }

  function buildReviewItems(review, myId) {
    const container = els.reviewItems;
    container.innerHTML = '';

    const groups = new Map();
    for (const item of review.items) {
      if (!groups.has(item.pid)) groups.set(item.pid, { name: item.name, emoji: item.emoji, items: [] });
      groups.get(item.pid).items.push(item);
    }

    for (const [pid, group] of groups) {
      const card = el('div', 'review-player');
      const head = el('div', 'review-player-head');
      head.append(avatar(group.name, 'avatar', group.emoji));
      head.append(el('strong', '', group.name));
      if (pid === myId) head.append(el('span', 'player-tag you', 'Vous'));
      card.append(head);

      for (const item of group.items) {
        card.append(buildReviewRow(review, item, pid === myId));
      }

      container.append(card);
    }
  }

  function buildReviewRow(review, item, isOwnAnswer) {
    const row = el('div', `rv-row ${item.status}`);

    const top = el('div', 'rv-top');
    const left = el('div');
    if (review.question.slots.length > 1) left.append(el('p', 'rv-label', item.slotLabel));
    const value = el('p', `rv-value${item.value ? '' : ' none'}`, item.value || 'Aucune réponse');
    left.append(value);
    top.append(left);

    if (item.status === 'accepted') top.append(el('span', 'badge badge-ok', '+1 pt'));
    else if (item.status === 'refused') top.append(el('span', 'badge badge-bad', 'Refusée'));
    else if (item.status === 'empty') top.append(el('span', 'badge badge-auto', 'Sans réponse'));
    if (item.skipped && item.status !== 'empty') top.append(el('span', 'badge badge-skip', 'Vote clos'));

    row.append(top);

    const bottom = el('div', 'rv-bottom');
    const myVote = review.myVotes?.[`${item.pid}|${item.slot}`];

    if (item.status === 'pending' && isOwnAnswer) {
      bottom.append(el('span', 'tally', 'Vous ne pouvez pas voter pour votre réponse'));
    } else if (item.status === 'pending') {
      const buttons = el('div', 'vote-btns');
      const yes = el('button', `vote-btn yes${myVote === 'yes' ? ' active' : ''}`, '✓ Valider');
      yes.type = 'button';
      yes.setAttribute('aria-pressed', String(myVote === 'yes'));
      yes.addEventListener('click', () => vote(review, item, myVote === 'yes' ? 'clear' : 'yes'));

      const no = el('button', `vote-btn no${myVote === 'no' ? ' active' : ''}`, '✗ Refuser');
      no.type = 'button';
      no.setAttribute('aria-pressed', String(myVote === 'no'));
      no.addEventListener('click', () => vote(review, item, myVote === 'no' ? 'clear' : 'no'));

      buttons.append(yes, no);
      bottom.append(buttons);
      bottom.append(el('span', 'tally', 'En attente des votes'));
    } else if (item.status === 'empty') {
      bottom.append(el('span', 'tally', 'Aucun point attribué'));
    } else {
      const tally = el('span', 'tally');
      if (item.resolvedBy === 'auto') tally.textContent = 'Corrigé automatiquement';
      else if (item.total == null) tally.textContent = 'Vote clos';
      else tally.textContent = `${item.yes} ✓ · ${item.no} ✗`;
      bottom.append(tally);
      if (item.status === 'accepted') bottom.append(el('span', 'tally', `+1 pt pour ${item.name}`));
      else if (item.skipped) bottom.append(el('span', 'tally', 'Vote non terminé'));
    }

    if (bottom.childElementCount > 0) row.append(bottom);
    return row;
  }

  function vote(review, item, value) {
    emit('review:vote', {
      index: review.index,
      pid: item.pid,
      slot: item.slot,
      value,
    });
  }

  /* ------------------------------ Résultats ------------------------------ */

  function renderResults(snapshot) {
    showView('results');
    els.btnRematch.hidden = !snapshot.me.isHost;
    els.btnReplay.hidden = !snapshot.me.isHost;

    const key = `${snapshot.code}:${snapshot.finishedAt}`;
    if (state.revealKey !== key) {
      state.revealKey = key;
      state.revealFinished = false;
      startReveal(snapshot);
    } else if (state.revealFinished) {
      renderPodium(snapshot.results);
    }
  }

  function stopReveal() {
    if (state.reveal?.timer) clearTimeout(state.reveal.timer);
    state.reveal = null;
  }

  function startReveal(snapshot) {
    stopReveal();
    els.revealStage.hidden = false;
    els.revealStage.onclick = null;
    els.podiumWrap.hidden = true;

    const queue = [...snapshot.results].reverse();
    state.reveal = {
      queue,
      index: 0,
      total: queue.length,
      timer: null,
      finished: false,
    };
    renderRevealStep();
  }

  function renderRevealStep() {
    const reveal = state.reveal;
    if (!reveal) return;

    const entry = reveal.queue[reveal.index];
    if (!entry) {
      finishReveal();
      return;
    }

    const isWinner = entry.rank === 1;
    const isTie = isWinner && reveal.queue.filter((item) => item.rank === 1).length > 1;
    const stage = els.revealStage;
    stage.innerHTML = '';
    stage.onclick = finishReveal;

    const card = el('div', `reveal-card${isWinner ? ' winner' : ''}`);
    card.append(el('p', 'reveal-rank', isTie ? '🏆 Ex æquo' : isWinner ? '🏆 Vainqueur' : `${ordinal(entry.rank)} place`));
    card.append(avatar(entry.name, 'reveal-avatar', entry.emoji));
    card.append(el('p', 'reveal-name', entry.name));

    const score = el('p', 'reveal-score', String(entry.score));
    score.append(el('small', '', entry.score > 1 ? 'points' : 'point'));
    card.append(score);

    card.append(
      el(
        'p',
        'reveal-meta',
        isWinner
          ? 'Meilleur score de la partie'
          : `${plural(reveal.queue.length - reveal.index - 1, 'joueur', 'joueurs')} avant le vainqueur`,
      ),
    );

    stage.append(card);

    const dots = el('div', 'reveal-progress');
    for (let i = 0; i < reveal.total; i += 1) {
      dots.append(el('i', i <= reveal.index ? 'on' : ''));
    }
    stage.append(dots);
    if (!isWinner) stage.append(el('p', 'skip-hint', 'Touchez l’écran pour accélérer'));

    const delay = isWinner ? 1450 : 1100;
    reveal.timer = setTimeout(() => {
      if (state.reveal !== reveal) return;
      if (reveal.index < reveal.queue.length - 1) {
        reveal.index += 1;
        renderRevealStep();
      } else {
        finishReveal();
      }
    }, delay);
  }

  function finishReveal() {
    const reveal = state.reveal;
    if (!reveal || reveal.finished) return;
    reveal.finished = true;
    state.revealFinished = true;
    clearTimeout(reveal.timer);
    reveal.timer = null;

    els.revealStage.hidden = true;
    els.revealStage.onclick = null;
    els.podiumWrap.hidden = false;
    renderPodium(reveal.queue);
  }

  function renderPodium(results) {
    const ordered = [...results].sort((a, b) => a.rank - b.rank);
    const winner = ordered[0];
    if (winner) {
      els.winnerCard.innerHTML = '';
      const trophy = el('span', 'winner-trophy', '🏆');
      trophy.setAttribute('aria-hidden', 'true');
      const text = el('div');
      const winners = ordered.filter((entry) => entry.rank === winner.rank);
      const isTie = winners.length > 1;
      text.append(el('p', 'winner-title', isTie ? 'Ex æquo' : 'Vainqueur'));
      text.append(el('p', 'winner-name', isTie ? winners.map((entry) => entry.name).join(' · ') : winner.name));
      text.append(el('p', 'winner-sub', `${winner.score} ${winner.score > 1 ? 'points' : 'point'} · ${plural(ordered.length, 'joueur', 'joueurs')}`));
      els.winnerCard.append(trophy, text);
    }

    const top = ordered.slice(0, 3);
    const layout = [];
    if (top[1]) layout.push(top[1]);
    if (top[0]) layout.push(top[0]);
    if (top[2]) layout.push(top[2]);

    els.podium.innerHTML = '';
    for (const entry of layout) {
      const place = entry.rank === 1 ? 'first' : entry.rank === 2 ? 'second' : 'third';
      const pod = el('div', `pod ${place}`);
      pod.append(el('p', 'pod-name', entry.name));
      pod.append(el('div', 'pod-bar', String(entry.score)));
      pod.append(el('p', 'pod-rank', `${ordinal(entry.rank)} place`));
      els.podium.append(pod);
    }

    els.resultsList.innerHTML = '';
    for (const entry of ordered) {
      const li = el(
        'li',
        `result-row${entry.rank === 1 ? ' gold' : ''}${entry.connected ? '' : ' left'}`,
      );
      li.append(el('span', 'result-rank', `${ordinal(entry.rank)}`));
      li.append(el('span', 'result-name', entry.name));
      li.append(el('span', 'result-score', `${entry.score} pt${entry.score > 1 ? 's' : ''}`));
      els.resultsList.append(li);
    }
  }

  /* ------------------------------------------------------------------ */
  /* Socket                                                             */
  /* ------------------------------------------------------------------ */

  const socket = io();

  socket.on('connect', () => {
    hideOverlay();
    if (state.code) {
      const name = state.snapshot?.me?.name || els.name.value.trim() || 'Joueur';
      doJoin(state.code, name);
    }
  });

  socket.on('disconnect', () => {
    state.joinInFlight = false;
    if (state.snapshot) showOverlay('Connexion perdue… nouvelle tentative');
  });

  socket.on('state', (snapshot) => {
    state.snapshot = snapshot;
    state.code = snapshot.code;
    state.playerId = snapshot.me.id;
    state.clockOffset = snapshot.serverNow - Date.now();
    hideOverlay();
    saveSession();

    if (window.location.search !== `?room=${snapshot.code}`) {
      history.replaceState({}, '', `?room=${snapshot.code}`);
    }

    render();
  });

  socket.on('room:closed', (payload) => {
    clearSession();
    resetToHome();
    showToast(payload?.reason || 'Le salon a été fermé.', 'error');
  });

  socket.on('app:error', (payload) => {
    showToast(payload?.message || 'Une erreur est survenue.', 'error');
  });

  /* ------------------------------------------------------------------ */
  /* Écouteurs UI                                                       */
  /* ------------------------------------------------------------------ */

  els.btnCreate.addEventListener('click', createRoom);

  els.btnToggleJoin.addEventListener('click', () => {
    if (!els.joinRow.hidden && els.code.value.trim().length === 4) {
      joinRoom();
      return;
    }
    if (state.inviteCode) {
      els.code.value = state.inviteCode;
      joinRoom();
      return;
    }
    const open = els.joinRow.hidden;
    els.joinRow.hidden = !open;
    els.btnToggleJoin.setAttribute('aria-expanded', String(open));
    if (open) {
      els.code.value = '';
      els.code.focus();
    }
  });

  els.btnJoin.addEventListener('click', joinRoom);

  els.code.addEventListener('input', () => {
    els.code.value = els.code.value.replace(/\D/g, '').slice(0, 4);
    if (els.code.value.length === 4) els.code.blur();
  });

  els.code.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      joinRoom();
    }
  });

  els.name.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (!els.joinRow.hidden || state.inviteCode) joinRoom();
    else createRoom();
  });

  els.btnCopy.addEventListener('click', async () => {
    const code = state.snapshot?.code || state.code;
    if (!code) return;
    const url = `${window.location.origin}/?room=${code}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Lien d’invitation copié');
    } catch {
      window.prompt('Copiez ce lien d’invitation :', url);
    }
  });

  els.chipsCount.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip || !state.snapshot) return;
    emit('room:config', {
      questionCount: Number(chip.dataset.value),
      answerTime: state.snapshot.config.answerTime,
      mode: state.snapshot.config.mode,
    });
  });

  els.chipsTime.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip || !state.snapshot) return;
    emit('room:config', {
      questionCount: state.snapshot.config.questionCount,
      answerTime: Number(chip.dataset.value),
      mode: state.snapshot.config.mode,
    });
  });

  els.chipsMode.addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip || !state.snapshot) return;
    emit('room:config', {
      questionCount: state.snapshot.config.questionCount,
      answerTime: state.snapshot.config.answerTime,
      mode: chip.dataset.value,
    });
  });

  els.btnStart.addEventListener('click', () => emit('game:start', {}));
  els.btnAnswer.addEventListener('click', submitAnswer);
  els.btnPrevReview.addEventListener('click', () => emit('review:previous', {}));
  els.btnNextReview.addEventListener('click', () => emit('review:next', {}));
  els.btnRematch.addEventListener('click', () => {
    if (!window.confirm('Lancer une revanche immédiate avec le même salon ?')) return;
    emit('game:restart', {});
  });
  els.btnReplay.addEventListener('click', () => emit('game:replay', {}));
  els.btnLeave.addEventListener('click', () => leaveRoom(true));
  els.btnQuit.addEventListener('click', () => leaveRoom(true));

  els.revealStage.addEventListener('click', finishReveal);

  window.addEventListener('beforeunload', () => {
    if (socket.connected) socket.emit('room:leave', {});
  });

  /* ------------------------------------------------------------------ */
  /* Démarrage                                                          */
  /* ------------------------------------------------------------------ */

  function boot() {
    const params = new URLSearchParams(window.location.search);
    const invite = (params.get('room') || '').trim();
    if (/^\d{4}$/.test(invite)) {
      state.inviteCode = invite;
      els.joinRow.hidden = false;
      els.code.value = invite;
      els.btnToggleJoin.setAttribute('aria-expanded', 'true');
      els.inviteHint.hidden = false;
      els.inviteHint.textContent = `Invitation pour le salon ${invite}. Entrez votre pseudo puis validez.`;
    }

    let storedName = '';
    try {
      storedName = localStorage.getItem(NAME_KEY) || '';
    } catch {
      /* ignore */
    }
    if (storedName) els.name.value = storedName;

    const session = readSession();

    if (session && storedName && (!invite || invite === session.code)) {
      state.playerId = session.playerId || state.playerId;
      state.code = session.code;
      showOverlay('Reconnexion au salon…');
      doJoin(session.code, storedName || 'Joueur', state.playerId);
      return;
    }

    if (session && invite && invite !== session.code) {
      clearSession();
    }

    if (invite) {
      els.name.focus();
    }
  }

  setInterval(() => {
    const snapshot = state.snapshot;
    if (!snapshot || snapshot.phase !== 'playing' || state.view !== 'play') return;
    tickTimer(snapshot);
  }, 200);

  boot();

  // Exposé pour le débogage manuel dans la console, sans effet sur le jeu.
  window.__wahliquiz = { state, socket };
})();
