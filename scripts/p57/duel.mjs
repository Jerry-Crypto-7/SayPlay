/**
 * P57 T8r: souboj starý × nový model. Oba na jednom listu (`qa-sheets --grid 2`, buňky 1 a 2,
 * pořadí losuje `pure-rand` ze semínka páru), slepá otázka „který byste dali do hotové hry“
 * přes `ask()` z `judge-sheet.mjs` – prázdný mkdtemp jen se `sheet.png`. Soudí Opus a Codex
 * (v denním stropu), po stropu Opus dvakrát s prohozeným pořadím. Nový nahradí starý, jen když
 * vyhraje oba soudy a má absolutní skóre aspoň `DUEL_FLOOR`; 8+ zůstává měřený cíl, ne brána.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
export const DUEL_FLOOR = 6;

export const duelQuestion = 'The attached image is a contact sheet of 3D game models; only cells 1 and 2 hold a model (ignore empty cells). Both are meant to be the same object. '
  + 'Our game has a "Toy Box" look: chunky, tactile, toy-like low-poly models with clean readable silhouettes and bright solid colours – not glassy, techy, photo-scanned or noisy. '
  + 'Which of the two would you rather ship in a finished mobile game? Weigh how recognisable it is, a clean silhouette, the Toy Box style and broken geometry (torn mesh, holes, loose fragments, a melted blob). '
  + 'Reply only with the JSON the schema asks for: better (1 or 2) and reason (at most 15 words).';

export const DUEL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['better', 'reason'],
  properties: { better: { type: 'integer' }, reason: { type: 'string' } },
};

export const isDuelAnswer = (value) => value?.better === 1 || value?.better === 2;

/** Je starý model v buňce 1? Tentýž pár (semínko) dostane vždy totéž pořadí. */
export const oldFirst = (seed) => uniformInt(xoroshiro128plus(seed), 0, 1) === 0;

/** Soudy jednoho souboje: Opus + Codex; bez Codexu Opus dvakrát, podruhé s prohozeným pořadím. */
export const duelJudges = (codex) => (codex
  ? [{ judge: 'claude', swap: false }, { judge: 'codex', swap: false }]
  : [{ judge: 'claude', swap: false }, { judge: 'claude', swap: true }]);

/** Hlas soudu: `new`, `old`, nebo `null`, když odpověď nepřišla. */
export const voteOf = (answer, oldCell) => (isDuelAnswer(answer) ? (answer.better === oldCell ? 'old' : 'new') : null);

/** Výměna: nový vyhrál oba soudy (chybějící hlas = prohra) a má skóre aspoň `DUEL_FLOOR`. */
export const duelWins = (score, votes) => typeof score === 'number' && score >= DUEL_FLOOR && votes.length >= 2 && votes.every((vote) => vote === 'new');

/**
 * Odsoudí jeden pár. `takeCodex()` vezme volání z denního stropu (false = strop vyčerpán).
 * Vrátí `[{ judge, oldCell, vote, reason }]`; listy a odpovědi leží pod `dir`.
 */
export async function runDuel({ key, oldGlb, newGlb, leaf, dir, seed, takeCodex }) {
  const { ask } = await import('../p37d/judge-sheet.mjs');
  mkdirSync(path.join(dir, 'answers'), { recursive: true });
  const schemaFile = path.join(dir, 'duel-schema.json');
  writeFileSync(schemaFile, JSON.stringify(DUEL_SCHEMA));
  const first = oldFirst(seed);
  const votes = [];
  for (const [index, { judge, swap }] of duelJudges(takeCodex()).entries()) {
    const oldIn1 = swap ? !first : first;
    const sheets = path.join(dir, `${key}-${oldIn1 ? 'old1' : 'new1'}`);
    if (!existsSync(path.join(sheets, 'grid-index.json'))) {
      mkdirSync(sheets, { recursive: true });
      const glbs = oldIn1 ? [oldGlb, newGlb] : [newGlb, oldGlb];
      writeFileSync(path.join(sheets, 'glb-list.json'), JSON.stringify(glbs.map((glb, cell) => ({ id: `p${cell + 1}`, glb }))));
      writeFileSync(path.join(sheets, 'ids.json'), JSON.stringify(glbs.map((glb, cell) => (leaf ? { id: `p${cell + 1}`, leaf } : { id: `p${cell + 1}` }))));
      spawnSync(process.execPath, [path.join(ROOT, 'scripts/assets/qa-sheets.mjs'), '--grid', '2', '--glb-list', path.join(sheets, 'glb-list.json'), '--ids', path.join(sheets, 'ids.json'), '--out', sheets], { stdio: 'inherit' });
    }
    const [sheet] = JSON.parse(readFileSync(path.join(sheets, 'grid-index.json'), 'utf8')).sheets;
    const answerFile = path.join(dir, 'answers', `${key}-${judge}-${index}.json`);
    if (!existsSync(answerFile)) await ask(path.join(sheets, `${sheet.sheet}.png`), schemaFile, answerFile, duelQuestion, judge, isDuelAnswer);
    const answer = existsSync(answerFile) ? JSON.parse(readFileSync(answerFile, 'utf8')) : null;
    votes.push({ judge, oldCell: oldIn1 ? 1 : 2, vote: voteOf(answer, oldIn1 ? 1 : 2), reason: answer?.reason ?? null });
  }
  return votes;
}
