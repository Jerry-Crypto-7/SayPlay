/**
 * Kontrakt žánrů (P32-0 T3): každý pahýl žánru přeloží vzorový `GenreSpec` na
 * dnešní `GameSpecV1`, ten projde `readGameSpec`, zkompiluje se a robot ho
 * dohraje. Pole `genre` ve specu nesmí pohnout hashem žádné dnešní fixtury –
 * jinak by se sdílené hry přestaly přehrávat.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compileArcade } from '@/play/arcade/compile';
import { readGameSpec } from '@/play/spec';

import { GENRES, GENRE_COMPILER_VERSION, GENRE_MODES, type GenreSpec, genreSpecSchema } from '../contract';
import { GENRE_MODULES, compileGenre, readGenreSpec } from '../index';

/** Vzorový `GenreSpec` pro každý žánr a režim – tvar, jaký napíše AI. */
const SAMPLES: readonly GenreSpec[] = [
  { genre: 'runner', mode: 'default', hero: 'penguin', enemy: 'rock', collectible: 'snowflake', setting: 'icy mountain slope', palette: 'snow' },
  { genre: 'platformer', mode: 'default', hero: 'firefighter robot', enemy: 'fallen log', collectible: 'water drop', setting: 'burning forest' },
  { genre: 'arena', mode: 'escape', hero: 'cat', enemy: 'polar bear', collectible: 'glowing fish', setting: 'frozen lake' },
  { genre: 'arena', mode: 'collect', hero: 'little fish', enemy: 'shark', collectible: 'plankton', setting: 'coral reef' },
  { genre: 'arena', mode: 'fight', hero: 'knight', enemy: 'black knight', setting: 'castle courtyard', palette: 'castle' },
  { genre: 'voyage', mode: 'race', hero: 'pirate ship', enemy: 'cannonball', collectible: 'treasure', setting: 'sea between islands' },
  { genre: 'voyage', mode: 'land', hero: 'rocket', enemy: 'meteor', setting: 'surface of Mars', palette: 'space' },
  { genre: 'quest', mode: 'spatial', hero: 'tiny wizard', enemy: 'ghost', target: { label: 'candle', verb: 'light', states: 2 }, setting: 'haunted castle' },
  { genre: 'quest', mode: 'station', hero: 'chef', target: { label: 'pancake', verb: 'flip', states: 3 }, setting: 'restaurant kitchen' },
  { genre: 'shooter', mode: 'default', hero: 'space marine', enemy: 'alien bug', setting: 'mining colony', palette: 'space' },
  { genre: 'throw', mode: 'default', hero: 'kid', target: { label: 'snowman', verb: 'hit', states: 2 }, collectible: 'snowball', setting: 'snowy backyard', palette: 'snow' },
];

/** První semínko, na kterém se hra zkompiluje – dveře publikace dělají totéž. */
function firstWinningSeed(spec: Parameters<typeof compileArcade>[0]): ReturnType<typeof compileArcade> {
  let last: ReturnType<typeof compileArcade> | null = null;
  for (let seed = 1; seed <= 8; seed += 1) {
    last = compileArcade(spec, seed);
    if (last.ok) return last;
  }
  return last as ReturnType<typeof compileArcade>;
}

describe('genre contract (P32-0 T3)', () => {
  it('registers exactly the five genres with the modes of the contract', () => {
    expect(Object.keys(GENRE_MODULES).sort()).toEqual([...GENRES].sort());
    for (const genre of GENRES) {
      expect(GENRE_MODULES[genre].id).toBe(genre);
      expect(GENRE_MODULES[genre].modes).toEqual(GENRE_MODES[genre]);
    }
  });

  it('has a sample for every genre and mode', () => {
    const covered = SAMPLES.map((sample) => `${sample.genre}.${sample.mode}`);
    const expected = GENRES.flatMap((genre) => GENRE_MODES[genre].map((mode) => `${genre}.${mode}`));
    expect(covered.sort()).toEqual(expected.sort());
  });

  it.each(SAMPLES.map((sample) => [`${sample.genre}.${sample.mode}`, sample] as const))(
    '%s compiles to a spec that reads, compiles and the bot wins',
    (_name, sample) => {
      expect(genreSpecSchema.safeParse(sample).success).toBe(true);
      const read = readGameSpec(compileGenre(sample));
      if (!read.ok) throw new Error(`${read.reason}: ${read.issues.join('; ')}`);
      expect(read.value.genre).toEqual({ id: sample.genre, mode: sample.mode, compilerVersion: GENRE_COMPILER_VERSION });
      const compiled = firstWinningSeed(read.value);
      if (!compiled.ok) throw new Error(`${compiled.reason}: ${compiled.issues.join('; ')}`);
      expect(compiled.value.winsAtTick).toBeGreaterThan(0);
    },
  );

  it('the hero of the sentence is the player role', () => {
    for (const sample of SAMPLES) {
      const player = compileGenre(sample).roles.find((role) => role.kind === 'player');
      expect(player?.label, `${sample.genre}.${sample.mode}`).toBe(sample.hero);
    }
  });

  it('a stub mode that plays a stand-in reports fallback, a translated one ready', () => {
    expect(GENRE_MODULES.runner.availability('default')).toBe('ready');
    expect(GENRE_MODULES.arena.availability('fight')).toBe('ready');
    expect(GENRE_MODULES.voyage.availability('land')).toBe('ready');
    expect(GENRE_MODULES.quest.availability('spatial')).toBe('ready');
    expect(GENRE_MODULES.quest.availability('station')).toBe('ready');
  });

  it('the schema refuses a mode the genre does not have', () => {
    expect(genreSpecSchema.safeParse({ genre: 'runner', mode: 'fight', hero: 'cat', setting: 'city' }).success).toBe(false);
  });

  it('readGenreSpec holds params inside the bounds of the genre', () => {
    const [lengthKey, bounds] = Object.entries(GENRE_MODULES.runner.paramBounds)[0] as [string, { min: number; max: number }];
    const base = SAMPLES[0] as GenreSpec;
    expect(readGenreSpec({ ...base, params: { [lengthKey]: bounds.max } }).ok).toBe(true);
    const over = readGenreSpec({ ...base, params: { [lengthKey]: bounds.max + 1 } });
    expect(over.ok).toBe(false);
    expect(!over.ok && over.issues.join(' ')).toContain(lengthKey);
    const unknown = readGenreSpec({ ...base, params: { wobble: 1 } });
    expect(!unknown.ok && unknown.issues.join(' ')).toContain('wobble');
  });

  it('readGameSpec refuses a genre whose mode belongs to another genre', () => {
    const spec = { ...compileGenre(SAMPLES[0] as GenreSpec), genre: { id: 'runner', mode: 'fight', compilerVersion: GENRE_COMPILER_VERSION } };
    const read = readGameSpec(spec);
    expect(read.ok).toBe(false);
    expect(!read.ok && read.reason).toBe('MALFORMED_SPEC');
  });

  it('draftFill reads the hero and the setting of a sentence', () => {
    const fill = GENRE_MODULES.arena.draftFill('A cat collects glowing fish on a frozen lake while a polar bear chases it', null);
    expect(fill.genre).toBe('arena');
    expect(fill.hero).toBe('cat');
  });
});

/**
 * Hash každé fixtury před P32 (29. 9. 2026, `readGameSpec(...).specHash`).
 * Nová fixtura se sem dopíše; posunutý hash je vada, ne aktualizace.
 */
const FIXTURE_HASHES: Readonly<Record<string, string>> = {
  '__fixtures__/chase_escape.json': '267af65b',
  '__fixtures__/checkpoint_race.json': '7e15eaf3',
  '__fixtures__/collect_exit.json': '99c980c9',
  '__fixtures__/collect_exit_stealth.json': '8675182b',
  '__fixtures__/combat_lite.json': 'f0769364',
  '__fixtures__/delivery.json': 'caab341c',
  '__fixtures__/delivery_orders.json': '4e214ce7',
  '__fixtures__/hazard_crossing.json': '9ba231a2',
  '__fixtures__/invalid-dangling-role.json': 'REJECT:OBJECTIVE_MISMATCH',
  '__fixtures__/invalid-over-budget.json': 'REJECT:BUDGET_EXCEEDED',
  '__fixtures__/invalid-unknown-mechanic.json': 'REJECT:MALFORMED_SPEC',
  '__fixtures__/p25d/collect_exit_hidden.json': 'b0a1f698',
  '__fixtures__/p25d/collect_exit_moving_walls.json': 'a103c818',
  '__fixtures__/p25d/collect_exit_red_light.json': '728c5fcb',
  '__fixtures__/survival_timer.json': '08e105bd',
  '__fixtures__/switch_puzzle.json': '114acf30',
  '__fixtures__/switch_puzzle_crates.json': '45db810f',
  '__fixtures__/switch_puzzle_ordered.json': 'bfe1dcb8',
  'arcade/__fixtures__/arena.json': '490c2bcb',
  'arcade/__fixtures__/duel.json': 'ff0c2946',
  'arcade/__fixtures__/flap.json': '1512755d',
  'arcade/__fixtures__/platform.json': 'd77f7e9a',
  'arcade/__fixtures__/rhythm.json': 'fe6e7964',
  'arcade/__fixtures__/rules/carry-key.json': 'ab226acb',
  'arcade/__fixtures__/rules/collect-gate.json': '5601e746',
  'arcade/__fixtures__/rules/give-flower.json': 'd4061a29',
  'arcade/__fixtures__/rules/lever-bridge.json': '677caddf',
  'arcade/__fixtures__/rules/push-crate.json': '6b0c8db3',
  'arcade/__fixtures__/rules/set-lantern.json': '51b03138',
  'arcade/__fixtures__/rules/throw-rock.json': 'f45ad6b2',
  'arcade/__fixtures__/runner.json': 'fc27e276',
  'arcade/__fixtures__/shooter.json': 'b415b831',
  'arcade/__fixtures__/steer.json': 'daa4cef0',
  'arcade/__fixtures__/throw.json': '17af0cc8',
  'arcade/__fixtures__/timing.json': '7362f1df',
};

function jsonFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? jsonFiles(path) : path.endsWith('.json') ? [path] : [];
  });
}

describe('saved games keep their hash (P32-0 T3)', () => {
  const root = join(process.cwd(), 'src', 'play');
  const files = ['__fixtures__', join('arcade', '__fixtures__')].flatMap((dir) => jsonFiles(join(root, dir)));

  it('every fixture is pinned', () => {
    expect(files.map((file) => relative(root, file).replace(/\\/g, '/')).sort()).toEqual(Object.keys(FIXTURE_HASHES).sort());
  });

  it.each(files.map((file) => [relative(root, file).replace(/\\/g, '/'), file] as const))('%s', (name, file) => {
    const read = readGameSpec(JSON.parse(readFileSync(file, 'utf8')));
    expect(read.ok ? read.specHash : `REJECT:${read.reason}`).toBe(FIXTURE_HASHES[name]);
  });
});
