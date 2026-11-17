# WahliQuiz

Quiz multijoueur en temps réel, mobile-first, inspiré de Kculture. Quatre formats de questions,
correction collaborative par vote et podium révélé du dernier au vainqueur.

- **Front** : HTML/CSS/JS vanilla (aucun build, aucune dépendance front).
- **Back** : Node.js + Express + Socket.io.
- **Données** : 100 % en mémoire vive (une `Map` côté serveur). Aucune base de données,
  aucun fichier écrit à l'exécution.

```
public/                 interface (une seule page)
  index.html
  css/app.css
  js/app.js
  assets/images/        illustrations SVG locales (drapeaux, monuments, logos…)
data/questions.json     347 questions, 4 formats
server/index.js         Express + Socket.io
server/rooms.js         salons, joueurs, réponses, votes, timers, nettoyage
server/questions.js     chargement / validation / tirage des questions
scripts/flow-test.js    test de bout en bout (3 joueurs simulés)
```

## Lancer

```bash
npm install
npm start
```

Ouvrir <http://localhost:3000>. En `npm run dev`, le serveur redémarre à chaque modification.
Le terminal affiche aussi l'adresse du réseau local pour tester depuis un téléphone
(les deux appareils doivent être sur le même Wi-Fi).

## Règles implémentées

### Salons

- Pseudo obligatoire, 2 à 16 caractères, unique dans un salon.
- **Créer un salon** génère un code à 4 chiffres et un lien `/?room=1234`.
  Le lien pré-remplit le code ; il suffit de saisir son pseudo et de valider.
- Lobby en direct : liste des joueurs (hôte, vous, hors ligne), 10 joueurs maximum.
- L'hôte choisit le **mode de jeu** (**tous les formats** ou **Petit Bac uniquement**),
  le nombre de questions (**3, 10, 15, 20 ou 30**) et le temps par réponse
  (**5, 10, 20 ou 30 secondes**). Lui seul peut lancer la partie.
- Reconnexion : un identifiant de joueur est conservé dans le navigateur. Un rafraîchissement
  ou une coupure réseau permet de retrouver sa place (et ses réponses) tant que le salon existe.

### Phase de jeu

- Toutes les questions sont tirées au début de la partie. En mode **tous les formats**,
  elles mélangent les quatre formats ; en mode **Petit Bac uniquement**, toutes les manches
  sont des grilles de Petit Bac.
  Une partie courte (3 questions) utilise les formats tirés au sort pour cette manche.
- Chaque question a un compte à rebours commun, visible par tous. C'est le seul chronomètre
  de la partie : aucune autre étape n'est limitée dans le temps.
- Personne ne voit les réponses des autres ni la correction : seuls les pseudos des joueurs
  ayant répondu sont affichés.
- La question se termine quand le temps est écoulé, ou plus tôt si tout le monde a validé.
  On peut modifier sa réponse tant que le chrono tourne.
- Petit Bac : une lettre est tirée au sort à chaque manche. Chaque grille a ses propres
  catégories (pays, animaux, métiers, culture pop, cuisine, etc.), ses indices et sa réserve
  de lettres.
  Il bénéficie de **100 % de temps en plus** : 10 s de réglage donnent 20 s pour la manche.

### Correction collaborative

- Après la dernière question, les questions sont revues une par une.
- La réponse attendue par le jeu est affichée, ainsi que la réponse de chaque joueur.
- Chaque joueur vote **Valider** ou **Refuser** pour chaque réponse (une réponse = un « slot »).
  - QCM : corrigé automatiquement (objectif), pas de vote.
  - Petit Bac : un vote par catégorie, donc 1 point par catégorie validée.
  - Réponse vide : automatiquement 0 point, sans vote.
- **Majorité stricte** : `oui × 2 > nombre de votants connectés`.
  En cas d'égalité, la réponse est refusée.
- Un vote peut être retiré tant que la réponse n'est pas résolue. Dès que tout le monde
  a voté, le résultat est figé et les points sont attribués.
- Aucun passage automatique : quand tout est corrigé, l'écran reste affiché sans limite
  de temps. L'hôte clique sur **Question suivante** (ou **Voir le classement**) pour avancer ;
  les votes encore en attente sont alors refusés. Aucune confirmation n'est demandée.
- **Précédent** permet à l'hôte de revenir sur une correction déjà passée pour la revoir.
  Seul l'hôte voit et peut utiliser les boutons de navigation.

### Classement

- Scores triés, podium animé : révélation **du dernier au vainqueur**, une carte à la fois.
- Clic sur la scène pour accélérer. Podium top 3 + classement complet.
- **Revanche immédiate** : l'hôte relance une nouvelle partie dans le **même salon**, avec
  les mêmes joueurs et réglages, sans repasser par le lobby. Les scores repartent de zéro.
- **Retour au lobby** : l'hôte peut aussi ramener tout le monde dans le salon pour modifier
  les réglages avant de relancer. Tout le monde peut quitter le salon à tout moment.

## Cycle de vie des salons (RAM)

Tout est stocké dans `server/rooms.js` :

| Situation | Comportement |
| --- | --- |
| Tous les joueurs se déconnectent | suppression après **20 s** (laisse le temps à un rafraîchissement de page) |
| Un joueur quitte explicitement le lobby | retrait immédiat ; le salon est supprimé s'il devient vide |
| Partie terminée | le salon reste au maximum **15 min** pour consulter le podium / rejouer, puis purge |
| Lobby inactif | purge après **4 h** |
| Serveur arrêté | tout disparaît (aucune persistance) |

Un balayage toutes les 30 s supprime les salons expirés. Le passage en `results` transfère
automatiquement le rôle d'hôte si nécessaire.

## Protocole Socket.io

| Client → serveur | Payload | Réponse (ack) |
| --- | --- | --- |
| `room:create` | `{ name, playerId }` | `{ ok, code, playerId }` |
| `room:join` | `{ code, name, playerId }` | `{ ok, code, playerId }` |
| `room:config` | `{ questionCount, answerTime, mode }` | `{ ok }` |
| `room:leave` | `{}` | `{ ok }` |
| `game:start` | `{}` | `{ ok }` |
| `game:answer` | `{ index, answers: { slot: valeur } }` | `{ ok }` |
| `review:vote` | `{ index, pid, slot, value: "yes" \| "no" \| "clear" }` | `{ ok }` |
| `review:next` | `{}` | `{ ok }` |
| `review:previous` | `{}` | `{ ok }` (hôte uniquement) |
| `game:replay` | `{}` | `{ ok }` |
| `game:restart` | `{}` | `{ ok }` (revanche immédiate, même salon) |
| `room:sync` | `{}` | état renvoyé sur `state` |

| Serveur → client | Contenu |
| --- | --- |
| `state` | instantané personnalisé : phase, joueurs, question en cours, correction, résultats |
| `room:closed` | raison de la suppression du salon |
| `app:error` | message d'erreur sans ack |

L'état envoyé pendant la phase de jeu ne contient **jamais** la correction ni les réponses
des autres joueurs. Les compteurs de votes restent masqués tant qu'une réponse n'est pas résolue.

## Ajouter des questions

Éditer `data/questions.json`, puis redémarrer le serveur (validation au démarrage).
Identifiants uniques obligatoires. Formats :

```jsonc
// 1. Question ouverte
{ "id": "q-open", "type": "open", "prompt": "…", "expected": "Réponse", "accepted": ["variante"] }

// 2. QCM — exactement 4 choix
{ "id": "q-mcq", "type": "mcq", "prompt": "…", "choices": ["A", "B", "C", "D"], "correct": "A" }

// 3. Petit Bac — catégories, indices et lettres optionnels (sinon valeurs globales)
{ "id": "q-bac", "type": "petitbac", "prompt": "…",
  "categories": ["Pays", "Animal"], "categoryHints": { "Pays": "Un pays" },
  "letterPool": ["B", "C", "D"] }

// 4. Image
{ "id": "q-img", "type": "image", "prompt": "…", "image": "/assets/images/mon-image.svg",
  "expected": "…", "accepted": ["…"] }
```

La banque contient 347 questions : 140 ouvertes, 124 QCM, 51 grilles de Petit Bac
et 32 images (dont 30 drapeaux). Le mode 30 questions peut donc se jouer
sans réutiliser deux fois la même question. Une grille de Petit Bac possède ses propres
catégories, indices et réserve de lettres.

## Tests

```bash
npm run test:flow
```

Le script démarre un serveur isolé sur le port 3111, simule trois joueurs, vérifie :
création / jointure / doublons, droits de l'hôte, déroulé des 10 questions, votes,
classement, retour au lobby, reconnexion, partie courte de 3 questions en mode
Petit Bac uniquement, revanche immédiate dans le même salon, puis suppression du salon
quand tout le monde part.

## Choix de conception

- **QCM corrigé automatiquement** : voter sur une réponse objectivement fausse n'aurait pas
  de sens. Les autres formats passent par le vote collaboratif, comme demandé.
- **Un vote par slot** : cela généralise proprement « 1 point par catégorie du Petit Bac »
  tout en gardant un seul champ de vote par réponse.
- **Images** : les questions image affichent une illustration SVG locale ou une URL externe
  (par exemple les drapeaux servis par `flagcdn.com`), avec un rendu cohérent en clair comme
  en sombre.
- **Design** : thème clair doux et variante sombre automatique (`prefers-color-scheme`),
  cartes arrondies, boutons contrastés, interface pensée d'abord pour le mobile.
- **Pas d'authentification** : le pseudo et un identifiant local suffisent ; adapté à un
  jeu entre amis, pas à un usage public à grande échelle.
