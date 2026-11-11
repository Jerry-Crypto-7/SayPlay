/**
 * P85B T3: the sentences in `docs/submission/judge-prompts.md`, read by the quick version in Node (no browser,
 * no model, no keys) exactly as `POST /api/play/games` reads them: chain or single game, the start card
 * ("You · Against · Place · Played as"), the goal line, what the strip admits, whether the publish gate
 * (robot wins, idle loses, replays equal) passes, and whether the same sentence gives the same game twice.
 *
 *   node --experimental-strip-types --no-warnings --import ./scripts/ts-paths.mjs evals/play/p85b/prompts-check.ts           print
 *   … evals/play/p85b/prompts-check.ts --write    save evals/play/p85b/prompts-check.json
 *   … evals/play/p85b/prompts-check.ts --check    compare with the saved file, exit 1 on any difference
 *
 * `@/` resolves to the `src/` next to the loader, so `--import <other tree>/scripts/ts-paths.mjs` reads that tree's code.
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { derivedSeeds, playabilityIssues, seedFrom } from '@/app/api/play/_publish';
import { readFacts } from '@/components/play/lab';
import { arcadeWorldOf } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { chainOrSingle } from '@/play/chain/decide';
import { readForChain } from '@/play/chain/read';
import { draftGameSpecWithMeta } from '@/play/draft';
import { honestyForSpec } from '@/play/draft/unsupported';
import { classifyGenre } from '@/play/genre/classify';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, 'prompts-check.json');

/** `in`: inside the declared scope; `out`: outside it, the doc says honestly what happens. */
export const PROMPTS = [
  { id: 'r1', group: 'reading-fix', scope: 'in', text: 'A goalkeeper penguin blocks snowballs thrown by a polar bear until the whistle blows' },
  { id: 'r2', group: 'reading-fix', scope: 'in', text: 'An aquarium where tapping a fish makes it swim to the surface and blow a bubble' },
  { id: 'r3', group: 'reading-fix', scope: 'in', text: 'A bakery where I pack twelve cupcakes into boxes of four and it shows how many boxes are full' },
  { id: 'm1', group: 'morning', scope: 'in', text: 'A knight collects three keys in a castle' },
  { id: 'm2', group: 'morning', scope: 'in', text: 'a solar system where clicking a planet shows its name and makes it orbit faster' },
  { id: 'm3', group: 'morning', scope: 'in', text: 'A small shop where I pick up three items and put them on the counter to see the total price' },
  { id: 'm4', group: 'morning', scope: 'in', text: 'A fox gathers glowing berries in a snowy forest while owls swoop down' },
  { id: 'm5', group: 'morning', scope: 'in', text: 'Mini golf on a pirate ship deck' },
  // From `evals/play/p30/test-200.json` (t102, t144, t145, t140): no swap on the strip, hero and opponent from the sentence.
  { id: 's1', group: 'set-200', scope: 'in', text: 'an elf archer defends the forest gate from orcs' },
  { id: 's2', group: 'set-200', scope: 'in', text: 'a turtle dodges falling coconuts on a tropical beach' },
  { id: 's3', group: 'set-200', scope: 'in', text: 'a boxer fights a robot in an underground ring' },
  { id: 's4', group: 'set-200', scope: 'in', text: 'a paper airplane glides through an office without hitting the ceiling fans' },
  { id: 'o1', group: 'outside', scope: 'out', text: 'Write a long story about a dragon who learns to forgive his brother over many years' },
  { id: 'o2', group: 'outside', scope: 'out', text: 'A marble rolls down a ramp, knocks over ten dominoes, the last domino pulls a string and the string rings a bell' },
  { id: 'o3', group: 'outside', scope: 'out', text: 'Simulate a car engine with pistons, a crankshaft and a gearbox that shifts at the right revs' },
] as const;

export interface PromptReading {
  readonly id: string;
  readonly group: string;
  readonly scope: 'in' | 'out';
  readonly sentence: string;
  readonly chain: boolean;
  readonly card: string | null;
  readonly genre: string | null;
  readonly goal: string | null;
  readonly strip: string | null;
  readonly gate: 'pass' | string;
  readonly sameTwice: boolean;
}

const sha = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 16);

/** The start card line, as `readLineOf` in `src/components/play/StartRead.tsx` joins it. */
function cardOf(facts: ReturnType<typeof readFacts>): string {
  return [facts.you === null ? null : `You: ${facts.you}`, facts.against.length === 0 ? null : `Against: ${facts.against.join(', ')}`, `Place: ${facts.place}`, `Played as: ${facts.game.toLowerCase()}`]
    .filter((part) => part !== null)
    .join(' · ');
}

/** One draft and its first world, as the publish path builds them; the fingerprint is what "the same game" means. */
function drafted(sentence: string) {
  const meta = draftGameSpecWithMeta(sentence, 1, { reading: null });
  const seeds = derivedSeeds(seedFrom(sentence.trim()));
  const made = seeds.map((seed) => ({ seed, made: arcadeWorldOf(meta.spec, seed) })).find(({ made }) => made.ok);
  return { meta, seeds, seed: made?.seed ?? seeds[0]!, fingerprint: sha({ spec: meta.spec, world: made?.made.ok ? made.made.world : null }) };
}

export async function readPrompt(prompt: { readonly id: string; readonly group: string; readonly scope: 'in' | 'out'; readonly text: string }): Promise<PromptReading> {
  const sentence = prompt.text;
  const chain = chainOrSingle(sentence, readForChain(sentence, null), classifyGenre(sentence, null)) === 'chain';
  const first = drafted(sentence);
  const second = drafted(sentence);
  const { spec, genre } = first.meta;
  const issues = playabilityIssues(spec, first.seeds);
  const honesty = await honestyForSpec(sentence, spec, first.seed);
  const mode = genre === null ? null : `${genre.genre}${'mode' in genre && typeof genre.mode === 'string' && genre.mode !== 'default' ? `.${genre.mode}` : ''}`;
  return {
    id: prompt.id,
    group: prompt.group,
    scope: prompt.scope,
    sentence,
    chain,
    card: chain ? null : cardOf(readFacts(spec, 'draft', sentence)),
    genre: chain ? 'chain' : (mode ?? (spec.control ?? spec.archetype)),
    goal: chain ? null : spec.tutorial.goalLine,
    strip: chain ? null : (honesty?.reason ?? null),
    gate: issues.length === 0 ? 'pass' : issues.map((issue) => issue.code).join(', '),
    sameTwice: first.fingerprint === second.fingerprint,
  };
}

/** The commit of the tree whose `src/` was read: the loader's `scripts/` sits in it. */
function codeCommit(): string {
  const at = process.execArgv.indexOf('--import');
  const loader = at === -1 ? './scripts/ts-paths.mjs' : process.execArgv[at + 1]!;
  return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: resolve(dirname(loader), '..'), encoding: 'utf8' }).trim();
}

if (process.argv[1]?.endsWith('prompts-check.ts')) {
  await loadRapier();
  const readings: PromptReading[] = [];
  for (const prompt of PROMPTS) readings.push(await readPrompt(prompt));
  const mode = process.argv.includes('--write') ? 'write' : process.argv.includes('--check') ? 'check' : 'print';
  if (mode === 'print') for (const reading of readings) console.log(JSON.stringify(reading));
  if (mode === 'write') {
    writeFileSync(OUT, `${JSON.stringify({ measuredOn: new Date().toISOString().slice(0, 10), codeCommit: codeCommit(), readings }, null, 1)}\n`);
    console.log(`prompts-check: ${readings.length} sentences written to ${OUT}`);
  }
  if (mode === 'check') {
    const saved = (JSON.parse(readFileSync(OUT, 'utf8')) as { readings: PromptReading[] }).readings;
    const differ = readings.filter((reading) => JSON.stringify(reading) !== JSON.stringify(saved.find(({ id }) => id === reading.id)));
    for (const reading of differ) console.log(`DIFFERS  ${reading.id}: ${JSON.stringify(reading)}`);
    console.log(`prompts-check: ${readings.length} sentences, ${differ.length} differ from ${OUT}`);
    process.exit(differ.length === 0 && saved.length === readings.length ? 0 : 1);
  }
}
