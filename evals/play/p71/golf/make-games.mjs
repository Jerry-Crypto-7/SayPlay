// P71C T5: publish the oracle sentences on the running server (games live only in its memory) and write
// `games.json` (sentence → /play/<id>, genre, control). Usage: node evals/play/p71/golf/make-games.mjs [baseUrl]
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const BASE = process.argv[2] ?? 'http://127.0.0.1:3012';
const OUT = join(dirname(fileURLToPath(import.meta.url)), 'games.json');

const SENTENCES = {
  'golf-golf': 'golf',
  'golf-mini': 'play mini golf',
  'golf-ball': 'a golf ball rolls into the hole',
  'timing-rope': 'cut the rope at the right moment to feed the monster',
  'timing-platform': 'tap at the right time to stop the moving platform',
  'timing-pancakes': 'stack pancakes as high as you can',
  rhythm: 'A drummer frog plays on lily pads and the pond lights up with the beat',
  drawsave: 'draw walls to save a puppy from bees',
};

const games = {};
for (const [key, sentence] of Object.entries(SENTENCES)) {
  const posted = await fetch(`${BASE}/api/play/games`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sentence }) });
  if (posted.status >= 300) throw new Error(`${key}: ${String(posted.status)} ${await posted.text()}`);
  const { url } = await posted.json();
  const game = await (await fetch(`${BASE}/api/play/games/${url.split('/').pop()}`)).json();
  const spec = game.spec ?? {};
  games[key] = { sentence, url, genre: spec.genre ?? spec.arcade?.genre ?? null, control: spec.control ?? spec.arcade?.control ?? null, specKeys: Object.keys(spec) };
  console.log(key, url, JSON.stringify(games[key].genre), JSON.stringify(games[key].control));
}
writeFileSync(OUT, `${JSON.stringify({ base: BASE, created: new Date().toISOString(), games }, null, 1)}\n`);
