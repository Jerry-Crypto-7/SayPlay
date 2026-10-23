/**
 * Souhrn viditelnosti P58A (T1 výchozí stav, T8 dev kontrola, T9 brána) z adresářů `evals/play/p56a/visible.mjs
 * play` + `judge`: po sadách i dohromady, kolik vět soudce viděl celých, kolik slov, a zvlášť hrdinu a protivníka
 * (bez protivníka věc). Řádky nesou i scénu a co soudce viděl místo slova – z nich čte příčiny `scripts/p58a/why-unseen.mjs`.
 *
 *   node evals/play/p58a/visibility.mjs --run <adresář>=<sada.json> [--run …] --out evals/play/p58a/baseline.json [--commit <sha>] [--setup <text>]
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { nounsOf, PLAY_TICKS, verdictOf } from '../p56a/visible.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

/** Počty jedné skupiny řádků; slovo je „hrdina“, když je to hrdina věty, jinak protivník nebo věc. */
export function tally(rows) {
  const nouns = rows.flatMap((row) => row.nouns);
  const of = (role) => nouns.filter((item) => item.role === role);
  const seen = (list) => list.filter((item) => item.visible).length;
  return {
    sentences: rows.length,
    allSeen: rows.filter((row) => row.all).length,
    nouns: nouns.length,
    nounsSeen: seen(nouns),
    hero: of('hero').length,
    heroSeen: seen(of('hero')),
    other: of('other').length,
    otherSeen: seen(of('other')),
    judges: Object.fromEntries([...new Set(rows.map((row) => row.judge))].map((judge) => [judge, rows.filter((row) => row.judge === judge).length])),
  };
}

/** Řádky jedné sady: záznam hry z `play` + odpověď soudce, slova s rolí. */
export function rowsOf(dir, setPath) {
  return readJson(resolve(ROOT, setPath)).sentences.map((sentence) => {
    const row = readJson(join(dir, `${sentence.id}.json`));
    const answer = readJson(join(dir, `${sentence.id}.answer.json`));
    const verdict = verdictOf(nounsOf(sentence), answer);
    return {
      set: setPath,
      id: sentence.id,
      text: sentence.text,
      readBy: row.readBy,
      genre: row.genre,
      title: row.title,
      heroRole: row.hero,
      roles: row.roles,
      robot: row.robot,
      tick: row.tick,
      frame: row.frame ?? null,
      judge: answer.judge ?? 'codex',
      scene: answer.scene,
      all: verdict.all,
      nouns: verdict.nouns.map((item) => ({ ...item, role: item.noun === sentence.hero ? 'hero' : 'other' })),
    };
  });
}

function main() {
  const list = process.argv.slice(2);
  const flag = (name) => {
    const at = list.indexOf(`--${name}`);
    return at === -1 ? undefined : list[at + 1];
  };
  const runs = list.flatMap((value, index) => (list[index - 1] === '--run' ? [value.split('=')] : []));
  const sets = runs.map(([dir, setPath]) => ({ set: setPath, rows: rowsOf(resolve(ROOT, dir), setPath) }));
  const rows = sets.flatMap((entry) => entry.rows);
  const result = {
    schema: 'p58a-visibility.v1',
    commit: flag('commit') ?? null,
    setup: flag('setup') ?? null,
    question: 'blind judge (scripts/p37d/judge-sheet.mjs ask, empty mkdtemp with only sheet.png) sees each noun of the sentence: hero (subject) and foe, or the item when the sentence names no foe',
    frame: `canvas only, page text hidden, 1280x800, robot ("Show me how") after ${PLAY_TICKS} ticks (3 s of play) on the probe's hand clock`,
    total: tally(rows),
    sets: Object.fromEntries(sets.map((entry) => [entry.set, tally(entry.rows)])),
    rows,
  };
  const out = flag('out');
  writeFileSync(resolve(ROOT, out), `${JSON.stringify(result, null, 1)}\n`);
  const t = result.total;
  console.log(`visibility: all ${t.allSeen}/${t.sentences}, nouns ${t.nounsSeen}/${t.nouns}, hero ${t.heroSeen}/${t.hero}, foe/item ${t.otherSeen}/${t.other} -> ${out}`);
  for (const [set, s] of Object.entries(result.sets)) console.log(`  ${set}: all ${s.allSeen}/${s.sentences}, nouns ${s.nounsSeen}/${s.nouns}, judges ${JSON.stringify(s.judges)}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
