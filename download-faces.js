// download-faces.js  (Node 18+)
const fs = require('fs');

const DIR = 'public/assets/images/celebs';
const EMAIL = 'wahliocean30@gmail.com'; // <-- mets ton vrai email ici
const PER_CATEGORY = 60;

const categories = {
  chanteur: 'Q177220',
  acteur: 'Q33999',
  footballeur: 'Q937857',
  politique: 'Q82955',
  basketteur: 'Q3665646',
  tennisman: 'Q10833314',
  youtubeur: 'Q17125263',
};

const headers = { 'User-Agent': `MonJeuDeQuiz/1.0 (${EMAIL})` };

async function fetchCategory(qid) {
  // Requête allégée : plus de tri sur tout Wikidata, on filtre plus fort et on limite
  const query = `
    SELECT ?personLabel ?image ?sitelinks WHERE {
      ?person wdt:P106 wd:${qid};
              wdt:P18 ?image;
              wikibase:sitelinks ?sitelinks.
      FILTER(?sitelinks > 60)
      SERVICE wikibase:label { bd:serviceParam wikibase:language "fr,en". }
    }
    LIMIT ${PER_CATEGORY}`;

  const url = 'https://query.wikidata.org/sparql?format=json&query=' + encodeURIComponent(query);

  // 3 tentatives, avec une pause entre chaque
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers });
      const text = await res.text();
      return JSON.parse(text).results.bindings;
    } catch (e) {
      console.log(`Tentative ${attempt} échouée pour ${qid}, nouvel essai...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
  console.log(`Catégorie ${qid} ignorée (Wikidata trop lent)`);
  return [];
}

async function main() {
  fs.mkdirSync(DIR, { recursive: true });
  const celebrities = [];
  const seen = new Set();

  for (const [cat, qid] of Object.entries(categories)) {
    const rows = await fetchCategory(qid);

    for (const row of rows) {
      const name = row.personLabel.value;
      if (seen.has(name) || /^Q\d+$/.test(name)) continue;
      seen.add(name);

      try {
        const img = await fetch(row.image.value + '?width=500', { headers, redirect: 'follow' });
        if (!img.ok) continue;

        const fileName = `${celebrities.length}.jpg`;
        fs.writeFileSync(`${DIR}/${fileName}`, Buffer.from(await img.arrayBuffer()));

        celebrities.push({
          name,
          category: cat,
          file: `${DIR}/${fileName}`,            // chemin sur le disque (pour sharp)
          url: `/assets/images/celebs/${fileName}`, // chemin pour le navigateur
        });
      } catch (e) {
        console.log('Ignoré :', name);
      }
    }
    console.log(`${cat} : fait`);
  }

  fs.writeFileSync('celebrities.json', JSON.stringify(celebrities, null, 2));
  console.log(`${celebrities.length} célébrités téléchargées`);
}

main();