/**
 * Řádek „jak prohraješ“ (P70C T1). Co by vypadalo dobře a bylo špatně: karta slíbí „Lose all 3 lives.“ hře, která
 * končí jen hodinami, ukáže dva životy jako tři, nebo nový žánr nedostane žádný řádek a karta tiše zůstane bez prohry.
 * Proto test jde přes registr žánrů (každý hratelný režim, ne ruční seznam) a řádek srovnává se světem, ze kterého
 * vznikl: životy z čítače jádra, hodiny z pravidla `time_limit`.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { arcadeWorldOf } from '@/play/arcade/compile';
import { type ArcadeWorld, COUNTER, HEADER, nativeRule } from '@/play/arcade/contract';
import { loadRapier } from '@/play/arcade/physics/world';
import { GENRES, type GenreModule } from '@/play/genre/contract';
import { GENRE_MODULES, compileGenre, readGenreSpec } from '@/play/genre/index';
import { loseClausesOf, loseLineOf, lostLineOf } from '@/play/lose-line';
import { type GameSpecV1, readGameSpec } from '@/play/spec';

/** Každý režim, který registr pouští – nový žánr se sem dostane sám. */
const PLAYABLE = GENRES.flatMap((genre) => {
  const module = GENRE_MODULES[genre] as GenreModule;
  return module.modes.filter((mode) => module.availability(mode as never) !== 'staged').map((mode) => ({ genre, mode, module }));
});

/** Hra režimu z věty bez modelu, jak ji složí rychlá cesta, a její svět. */
function built(entry: (typeof PLAYABLE)[number]): { readonly spec: GameSpecV1; readonly world: ArcadeWorld } {
  const read = readGenreSpec({ hero: 'cat', setting: 'park', ...entry.module.draftFill('a cat in the park', null), genre: entry.genre, mode: entry.mode });
  if (!read.ok) throw new Error(read.issues.join('; '));
  const spec = compileGenre(read.value);
  const world = arcadeWorldOf(spec, 1);
  if (!world.ok) throw new Error(world.issues.join('; '));
  return { spec, world: world.world };
}

const fixture = (name: string): GameSpecV1 => {
  const read = readGameSpec(JSON.parse(readFileSync(join(process.cwd(), 'src', 'play', '__fixtures__', `${name}.json`), 'utf8')));
  if (!read.ok) throw new Error(read.reason);
  return read.value;
};

beforeAll(async () => {
  await loadRapier();
});

describe('every playable genre says how you win, how you lose and how to play (P70C T1)', () => {
  it('covers the registry', () => {
    // 34 režimů 29 žánrů na `main` 4. 11.; méně = registr něco tiše přestal pouštět.
    expect(PLAYABLE.length).toBeGreaterThanOrEqual(34);
  });

  it.each(PLAYABLE.map((entry) => [`${entry.genre}.${entry.mode}`, entry] as const))('%s', (_name, entry) => {
    const { spec, world } = built(entry);
    const line = loseLineOf(spec, world);
    expect(spec.tutorial.goalLine.trim()).not.toBe('');
    expect(spec.tutorial.controlsHint.trim()).not.toBe('');
    expect(line).toMatch(/^[A-Z][^.!?]*\.$/);
    expect((line as string).length).toBeLessThanOrEqual(80);
    // Řádek říká pravdu o světě: počet životů z čítače jádra, hodiny jen tam, kde je pravidlo `time_limit`.
    const lives = world.initial[HEADER.counters + COUNTER.health] as number;
    const causes = loseClausesOf(spec, world).map((entry) => entry.cause);
    expect(causes.includes('lives')).toBe(lives > 0);
    if (lives > 2) expect(line).toContain(`Lose all ${String(lives)} lives`);
    if (lives === 2) expect(line).toContain('Lose both lives');
    if (nativeRule(world.rules, 'time_limit') !== undefined) expect(causes).toContain('time');
  });
});

describe('the lose line', () => {
  const of = (genre: string): ReturnType<typeof built> => built(PLAYABLE.find((entry) => entry.genre === genre) as (typeof PLAYABLE)[number]);

  it('joins lives and the clock, and two ways to run out into one', () => {
    const platformer = of('platformer');
    const thrown = of('throw');
    expect(loseLineOf(platformer.spec, platformer.world)).toBe('Lose all 3 lives or run out of time.');
    expect(loseLineOf(thrown.spec, thrown.world)).toBe('Run out of shots or time.');
    const crowd = of('crowd');
    expect(loseLineOf(crowd.spec, crowd.world)).toBe('Lose all 3 lives or your whole crowd.');
  });

  it('a spec that carries its own line wins, and the schema holds it to 80 characters', () => {
    const sample = of('platformer');
    const own = { ...sample.spec, tutorial: { ...sample.spec.tutorial, loseLine: "Don't fall." } };
    const read = readGameSpec(own);
    expect(read.ok).toBe(true);
    expect(loseLineOf(read.ok ? read.value : sample.spec, sample.world)).toBe("Don't fall.");
    expect(readGameSpec({ ...own, tutorial: { ...own.tutorial, loseLine: 'x'.repeat(81) } }).ok).toBe(false);
  });

  it('a stored spec without the field derives the line on load, no migration', () => {
    // Hash uložených her beze změny pinuje `genre/__tests__/contract.test.ts` (`FIXTURE_HASHES`).
    const old = fixture('chase_escape');
    expect(old.tutorial.loseLine).toBeUndefined();
    expect(loseLineOf(old, null)).toBe('Get caught by the giant Roomba.');
    expect(loseLineOf(fixture('survival_timer'), null)).toBe('Touch the red floor tile.');
  });

  it('a game nobody can lose has no line instead of a made-up one', () => {
    expect(loseLineOf(fixture('collect_exit'), null)).toBeNull();
  });
});

describe('lostLineOf (P70C T2)', () => {
  const LIVES = { cause: 'lives', text: 'lose all 3 lives' } as const;
  const TIME = { cause: 'time', text: 'run out of time' } as const;
  const FALL = { cause: 'fall', text: 'fall' } as const;
  const CAUGHT = { cause: 'caught', text: 'get caught by the wolf' } as const;
  const none = { livesOut: false, timeOut: false };

  it('names the cause that really ended the run, in the past tense', () => {
    expect(lostLineOf([LIVES, TIME], { livesOut: true, timeOut: false })).toBe('You lost all 3 lives.');
    expect(lostLineOf([LIVES, TIME], { livesOut: false, timeOut: true })).toBe('You ran out of time.');
    expect(lostLineOf([LIVES, FALL], none)).toBe('You fell.');
    expect(lostLineOf([CAUGHT], none)).toBe('You got caught by the wolf.');
  });

  it('says nothing rather than guess', () => {
    // Dvě možné příčiny pravidel, životy i čas zbývají.
    expect(lostLineOf([FALL, CAUGHT], none)).toBeNull();
    // Životy došly, ale hra životy nemá – příčina se neví.
    expect(lostLineOf([FALL, CAUGHT], { livesOut: true, timeOut: false })).toBeNull();
    // Sloveso pravidla mimo seznam minulých časů.
    expect(lostLineOf([{ cause: 'rule', text: 'squish the bug' }], none)).toBeNull();
    expect(lostLineOf([], none)).toBeNull();
  });
});
