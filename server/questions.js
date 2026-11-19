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
const PROJECT_DIR = path.join(__dirname, '..');
const PUBLIC_DIR = path.join(PROJECT_DIR, 'public');
const CELEBRITY_IMAGE_DIR = path.join(PUBLIC_DIR, 'assets', 'images', 'celebs');
const CELEBRITIES_FILE = path.join(PROJECT_DIR, 'celebrities.json');
const rawCelebrities = JSON.parse(fs.readFileSync(CELEBRITIES_FILE, 'utf8'));

if (!Array.isArray(rawCelebrities)) {
  throw new Error('celebrities.json doit contenir une liste de célébrités.');
}

const celebrities = rawCelebrities.map((celebrity, index) => {
  const where = `celebrities[${index}]`;
  if (!celebrity || typeof celebrity.name !== 'string' || !celebrity.name.trim()) {
    throw new Error(`${where} : nom manquant.`);
  }
  if (typeof celebrity.file !== 'string' || !celebrity.file.trim()) {
    throw new Error(`${where} : fichier image manquant.`);
  }

  const imagePath = path.resolve(PROJECT_DIR, celebrity.file);
  const relativePath = path.relative(CELEBRITY_IMAGE_DIR, imagePath);
  const isImageFile = fs.existsSync(imagePath) && fs.statSync(imagePath).isFile();
  if (
    relativePath.startsWith(`..${path.sep}`)
    || relativePath === '..'
    || path.isAbsolute(relativePath)
    || !isImageFile
  ) {
    throw new Error(`${where} : image absente ou située hors de public/assets/images/celebs.`);
  }

  return {
    name: celebrity.name.trim(),
    url: `/${path.relative(PUBLIC_DIR, imagePath).split(path.sep).join('/')}`,
  };
});

if (celebrities.length === 0) {
  throw new Error('celebrities.json doit contenir au moins une célébrité avec une image.');
}

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

const questions = Array.isArray(raw.questions) ? [...raw.questions] : [];

for (const [index, celebrity] of celebrities.entries()) {
  questions.push({
    id: `celebrity-image-${index + 1}`,
    type: 'image',
    prompt: 'Qui est cette célébrité ?',
    image: celebrity.url,
    expected: celebrity.name,
    slots: [{ key: 'answer', label: 'Nom de la célébrité', expected: celebrity.name }],
  });
}

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
      if (q.slots !== undefined) {
        if (!Array.isArray(q.slots) || q.slots.length < 1 || q.slots.length > 6) {
          throw new Error(`${where} : une question image doit avoir entre 1 et 6 champs de réponse.`);
        }
        if (q.slots.some((slot) => (
          !slot
          || typeof slot.key !== 'string'
          || !slot.key.trim()
          || typeof slot.label !== 'string'
          || !slot.label.trim()
          || !slot.expected
        ))) {
          throw new Error(`${where} : champs de réponse d'image invalides.`);
        }
        if (new Set(q.slots.map((slot) => slot.key)).size !== q.slots.length) {
          throw new Error(`${where} : clés de champs d'image dupliquées.`);
        }
      } else if (!q.expected) {
        throw new Error(`${where} : réponse attendue manquante.`);
      }
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

  if (q.type === 'image' && Array.isArray(q.slots)) {
    const rawSlots = q.slots.map((slot) => ({
      key: slot.key,
      label: slot.label,
      expected: slot.expected,
      accepted: slot.accepted,
    }));
    q.slots = rawSlots.map((slot) => ({ key: slot.key, label: slot.label }));
    q.expectedBySlot = Object.fromEntries(
      rawSlots.map((slot) => [slot.key, slot.expected]),
    );
    q.acceptedBySlot = Object.fromEntries(
      rawSlots.map((slot) => [slot.key, slot.accepted || null]),
    );
    return q;
  }

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
  q.acceptedBySlot = question.acceptedBySlot || null;
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
