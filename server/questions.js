'use strict';

/**
 * Chargement et préparation de la banque de questions.
 * Aucune donnée n'est écrite : tout est préparé en mémoire au démarrage
 * et à chaque nouvelle partie.
 */

const fs = require('node:fs');
const path = require('node:path');

const DATA_FILE = path.join(__dirname, '..', 'data', 'questions.json');
const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));

const TYPE_LABELS = {
  open: 'Culture générale',
  mcq: 'QCM',
  petitbac: 'Petit Bac',
  image: 'Image mystère',
  rebus: 'Rébus',
};

const VALID_TYPES = new Set(Object.keys(TYPE_LABELS));
const DEFAULT_PETIT_BAC = {
  categories: ['Pays', 'Animal', 'Métier', 'Célébrité'],
  categoryHints: {
    Pays: 'Un pays',
    Animal: 'Un animal',
    Métier: 'Un métier',
    Célébrité: 'Une célébrité',
  },
  letterPool: ['B', 'C', 'D', 'F', 'G', 'M', 'P', 'R', 'S', 'T', 'V'],
};

const petitBac = {
  categories: raw.petitBac?.categories?.length ? raw.petitBac.categories : DEFAULT_PETIT_BAC.categories,
  categoryHints: { ...DEFAULT_PETIT_BAC.categoryHints, ...(raw.petitBac?.categoryHints || {}) },
  letterPool: raw.petitBac?.letterPool?.length ? raw.petitBac.letterPool : DEFAULT_PETIT_BAC.letterPool,
};

const questions = Array.isArray(raw.questions) ? raw.questions : [];

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

if (questions.length === 0) {
  throw new Error('data/questions.json ne contient aucune question.');
}

const seenIds = new Set();
for (const [i, q] of questions.entries()) {
  const where = `questions[${i}] (${q?.id || 'sans id'})`;
  if (!q || typeof q !== 'object') throw new Error(`${where} : objet invalide.`);
  if (!q.id || seenIds.has(q.id)) throw new Error(`${where} : id manquant ou dupliqué.`);
  seenIds.add(q.id);
  if (!VALID_TYPES.has(q.type)) throw new Error(`${where} : type inconnu « ${q.type} ».`);
  if (typeof q.prompt !== 'string' || !q.prompt.trim()) throw new Error(`${where} : énoncé manquant.`);

  switch (q.type) {
    case 'mcq':
      if (!Array.isArray(q.choices) || q.choices.length !== 4) {
        throw new Error(`${where} : un QCM doit proposer exactement 4 choix.`);
      }
      if (!q.choices.includes(q.correct)) {
        throw new Error(`${where} : la bonne réponse doit figurer parmi les choix.`);
      }
      break;
    case 'petitbac':
      if (q.categories !== undefined) {
        if (!Array.isArray(q.categories) || q.categories.length < 2 || q.categories.length > 6) {
          throw new Error(`${where} : un Petit Bac doit avoir entre 2 et 6 catégories.`);
        }
        if (q.categories.some((category) => typeof category !== 'string' || !category.trim())) {
          throw new Error(`${where} : catégories de Petit Bac invalides.`);
        }
        if (new Set(q.categories).size !== q.categories.length) {
          throw new Error(`${where} : catégories de Petit Bac dupliquées.`);
        }
      }
      if (q.categoryHints !== undefined) {
        if (
          !q.categoryHints ||
          typeof q.categoryHints !== 'object' ||
          Array.isArray(q.categoryHints)
        ) {
          throw new Error(`${where} : indices de Petit Bac invalides.`);
        }
      }
      if (q.letterPool !== undefined) {
        if (
          !Array.isArray(q.letterPool) ||
          q.letterPool.length === 0 ||
          q.letterPool.some((letter) => typeof letter !== 'string' || !letter.trim())
        ) {
          throw new Error(`${where} : réserve de lettres de Petit Bac invalide.`);
        }
      }
      break;
    case 'image':
      if (!q.image) throw new Error(`${where} : URL d'image manquante.`);
      if (!q.expected) throw new Error(`${where} : réponse attendue manquante.`);
      break;
    default:
      if (!q.expected) throw new Error(`${where} : réponse attendue manquante.`);
  }
}

/* ------------------------------------------------------------------ */
/* Utilitaires                                                         */
/* ------------------------------------------------------------------ */

function shuffle(list) {
  const copy = [...list];
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function pick(list) {
  return list[Math.floor(Math.random() * list.length)];
}

/** Prépare une question jouable : slots, lettre tirée au sort, choix mélangés. */
function prepare(rawQuestion) {
  const q = { ...rawQuestion };

  if (q.type === 'petitbac') {
    const categories = q.categories?.length ? [...q.categories] : [...petitBac.categories];
    const hints = { ...petitBac.categoryHints, ...(q.categoryHints || {}) };
    const letterPool = q.letterPool?.length ? q.letterPool : petitBac.letterPool;

    q.categories = categories;
    q.letter = pick(letterPool);
    q.slots = categories.map((category) => ({ key: category, label: category }));
    q.expectedBySlot = Object.fromEntries(
      categories.map((category) => [
        category,
        `${hints[category] || 'Un mot'} commençant par « ${q.letter} »`,
      ]),
    );
    return q;
  }

  q.slots = [{ key: 'answer', label: 'Réponse' }];

  if (q.type === 'mcq') {
    q.choices = shuffle(q.choices);
    q.correctIndex = q.choices.indexOf(q.correct);
    q.expectedBySlot = { answer: q.correct };
    return q;
  }

  q.expectedBySlot = { answer: q.expected };
  return q;
}

/**
 * Construit le deck d'une partie.
 * - mode « mixte » : au moins un exemplaire de chacun des formats disponibles
 *   (dès que la partie compte assez de questions)
 * - mode « petitbac » : uniquement des grilles de Petit Bac
 * - tirage aléatoire sans répétition tant que la banque le permet
 * - au-delà de la taille de la banque, les questions sont réutilisées
 *   (nouvelle lettre / nouvel ordre des choix)
 */
function buildDeck(count, options = {}) {
  const onlyPetitBac = options.mode === 'petitbac';
  const bank = onlyPetitBac ? questions.filter((q) => q.type === 'petitbac') : questions;
  if (bank.length === 0) throw new Error('Aucune question disponible pour ce mode de jeu.');

  const picked = [];

  if (!onlyPetitBac) {
    const types = shuffle([...new Set(bank.map((q) => q.type))]);
    for (const type of types) {
      if (picked.length >= count) break;
      picked.push(prepare(pick(bank.filter((q) => q.type === type))));
    }
  }

  const used = new Set(picked.map((q) => q.id));
  let pool = shuffle(bank.filter((q) => !used.has(q.id)));

  while (picked.length < count) {
    if (pool.length === 0) pool = shuffle(bank);
    picked.push(prepare(pool.pop()));
  }

  return shuffle(picked.slice(0, count));
}

/** Version « publique » : ne contient jamais la correction. */
function publicQuestion(question, index) {
  const q = {
    index,
    type: question.type,
    typeLabel: TYPE_LABELS[question.type],
    prompt: question.prompt,
    slots: question.slots,
  };

  switch (question.type) {
    case 'mcq':
      q.choices = question.choices;
      break;
    case 'image':
      q.image = question.image;
      break;
    case 'rebus':
      q.emojis = question.emojis;
      break;
    case 'petitbac':
      q.letter = question.letter;
      q.categories = question.categories;
      break;
    default:
      break;
  }

  return q;
}

/** Version « correction » : contient la réponse attendue et les tolérances. */
function reviewQuestion(question, index) {
  const q = publicQuestion(question, index);
  q.expectedBySlot = question.expectedBySlot;
  q.accepted = question.accepted || null;
  q.hint = question.hint || null;
  q.correct = question.correct || null;
  return q;
}

module.exports = {
  TYPE_LABELS,
  buildDeck,
  publicQuestion,
  reviewQuestion,
  questionCount: questions.length,
};
