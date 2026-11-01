/**
 * Kontrakt žánrů (P32-0 T3): každý pahýl žánru přeloží vzorový `GenreSpec` na
 * dnešní `GameSpecV1`, ten projde `readGameSpec`, zkompiluje se a robot ho
 * dohraje. Pole `genre` ve specu nesmí pohnout hashem žádné dnešní fixtury –
 * jinak by se sdílené hry přestaly přehrávat.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { beforeAll, describe, expect, it } from 'vitest';

import { compileArcade } from '@/play/arcade/compile';
import { loadRapier } from '@/play/arcade/physics/world';
import { readGameSpec } from '@/play/spec';

import { ALLOWED, liveCells } from '@/play/compose/allowed';

import { classifyGenre } from '../classify';
import { COUNT_PARAMS, FOE_DOES, GENRES, GENRE_COMPILER_VERSION, GENRE_MODES, type GenreId, type GenreSpec, genreSpecSchema } from '../contract';
import penguin from '../__fixtures__/penguin.json';
import { GENRE_MODULES, compileGenre, readGenreSpec } from '../index';

/** Vzorový `GenreSpec` pro každý žánr a režim – tvar, jaký napíše AI. */
const SAMPLES: readonly GenreSpec[] = [
  { genre: 'runner', mode: 'default', hero: 'penguin', cast: [{ label: 'rock', does: 'avoid' }, { label: 'snowflake', does: 'collect' }], setting: 'icy mountain slope', palette: 'snow' },
  { genre: 'platformer', mode: 'default', hero: 'firefighter robot', cast: [{ label: 'fallen log', does: 'avoid' }, { label: 'water drop', does: 'collect' }], setting: 'burning forest' },
  { genre: 'arena', mode: 'escape', hero: 'cat', cast: [{ label: 'polar bear', does: 'chase_me' }, { label: 'glowing fish', does: 'collect' }], setting: 'frozen lake' },
  { genre: 'arena', mode: 'collect', hero: 'little fish', cast: [{ label: 'shark', does: 'chase_me' }, { label: 'plankton', does: 'collect' }], setting: 'coral reef' },
  { genre: 'arena', mode: 'fight', hero: 'knight', cast: [{ label: 'black knight', does: 'fight' }], setting: 'castle courtyard', palette: 'castle' },
  { genre: 'voyage', mode: 'race', hero: 'pirate ship', cast: [{ label: 'cannonball', does: 'avoid' }, { label: 'treasure', does: 'collect' }], setting: 'sea between islands' },
  { genre: 'voyage', mode: 'land', hero: 'rocket', cast: [{ label: 'meteor', does: 'avoid' }], setting: 'surface of Mars', palette: 'space' },
  { genre: 'quest', mode: 'spatial', hero: 'tiny wizard', cast: [{ label: 'ghost', does: 'chase_me' }, { label: 'candle', does: 'reach', verb: 'light', states: 2 }], setting: 'haunted castle' },
  { genre: 'quest', mode: 'station', hero: 'chef', cast: [{ label: 'pancake', does: 'reach', verb: 'flip', states: 3 }], setting: 'restaurant kitchen' },
  { genre: 'shooter', mode: 'default', hero: 'space marine', cast: [{ label: 'alien bug', does: 'shoot_at' }], setting: 'mining colony', palette: 'space' },
  { genre: 'throw', mode: 'default', hero: 'kid', cast: [{ label: 'snowman', does: 'throw_at', verb: 'hit', states: 2 }, { label: 'snowball', does: 'collect' }], setting: 'snowy backyard', palette: 'snow' },
  { genre: 'timing', mode: 'stack', hero: 'crane operator', cast: [{ label: 'container', does: 'collect' }], setting: 'harbour in a storm' },
  { genre: 'timing', mode: 'precision', hero: 'monkey', setting: 'jungle temple' },
  { genre: 'timing', mode: 'bridge', hero: 'ninja', setting: 'mountain gorge' },
  { genre: 'rhythm', mode: 'default', hero: 'drummer frog', cast: [{ label: 'lily pad', does: 'collect' }], setting: 'pond at night' },
  { genre: 'duel', mode: 'default', hero: 'cowboy', cast: [{ label: 'outlaw', does: 'fight' }], setting: 'dusty town' },
  { genre: 'flap', mode: 'default', hero: 'fish', cast: [{ label: 'pearl', does: 'collect' }], setting: 'underwater reef' },
  // P54C T5: chytání v pěti pruzích.
  { genre: 'catch', mode: 'default', hero: 'bear', cast: [{ label: 'apple', does: 'collect' }, { label: 'bomb', does: 'avoid' }], setting: 'orchard' },
  // P54C T6: bouchání do pěti děr.
  { genre: 'whack', mode: 'default', hero: 'farmer', cast: [{ label: 'mole', does: 'shoot_at' }, { label: 'bunny', does: 'avoid' }], setting: 'garden' },
  // P54C T7: obrana pěti pruhů.
  { genre: 'defense', mode: 'default', hero: 'knight', cast: [{ label: 'goblin', does: 'chase_me' }, { label: 'castle', does: 'reach' }], setting: 'castle walls' },
  // P54C T8: krájení v pěti pruzích.
  { genre: 'slice', mode: 'default', hero: 'ninja', cast: [{ label: 'watermelon', does: 'collect' }, { label: 'bomb', does: 'avoid' }], setting: 'dojo' },
  // P54C T9: přeskákání silnice.
  { genre: 'hop', mode: 'default', hero: 'chicken', cast: [{ label: 'taxi', does: 'avoid' }, { label: 'barn', does: 'reach' }], setting: 'farm road' },
  // P54C T10: dav a brány.
  { genre: 'crowd', mode: 'default', hero: 'penguin', cast: [{ label: 'saw', does: 'avoid' }, { label: 'giant', does: 'fight' }], setting: 'icy road' },
  // P54C T11: pouštění a slučování (Rapier – načtený v `beforeAll`).
  { genre: 'merge', mode: 'default', hero: 'cat', cast: [{ label: 'planet', does: 'collect' }], setting: 'outer space' },
  // P54C T12: vytlačování z ringu (Rapier).
  { genre: 'push', mode: 'default', hero: 'sumo wrestler', cast: [{ label: 'bull', does: 'fight' }], setting: 'bouncy ring' },
  // P66 T12: pět nových žánrů je živých – přežití ve vlnách, díra, krádež, třídění a šipky.
  { genre: 'survivor', mode: 'default', hero: 'knight', cast: [{ label: 'skeleton', does: 'shoot_at' }], setting: 'ruined castle' },
  { genre: 'hole', mode: 'default', hero: 'black hole', cast: [{ label: 'car', does: 'collect' }], setting: 'busy city' },
  { genre: 'steal', mode: 'default', hero: 'cat', cast: [{ label: 'fish', does: 'collect' }, { label: 'dog', does: 'chase_me' }], setting: 'fish market' },
  { genre: 'sort', mode: 'default', hero: 'shop clerk', cast: [{ label: 'teddy bear', does: 'collect' }, { label: 'ball', does: 'collect' }], setting: 'toy shop' },
  { genre: 'arrows', mode: 'default', hero: 'valet', cast: [{ label: 'car', does: 'scenery' }], setting: 'parking lot' },
  // P68 T9: minigolf je zapojený.
  { genre: 'minigolf', mode: 'default', hero: 'golf ball', cast: [{ label: 'windmill', does: 'scenery' }], setting: 'pirate island' },
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
  // Slučování (P54C T11) hraje na Rapieru; dveře publikace ho čekají vždy (`preloadPhysics`).
  beforeAll(async () => {
    await loadRapier();
  });

  it('registers exactly the genres with the modes of the contract', () => {
    expect(Object.keys(GENRE_MODULES).sort()).toEqual([...GENRES].sort());
    for (const genre of GENRES) {
      expect(GENRE_MODULES[genre].id).toBe(genre);
      expect(GENRE_MODULES[genre].modes).toEqual(GENRE_MODES[genre]);
    }
  });

  it('has a sample for every genre and mode that plays', () => {
    const covered = SAMPLES.map((sample) => `${sample.genre}.${sample.mode}`);
    const expected = GENRES.flatMap((genre) => GENRE_MODES[genre].filter((mode) => GENRE_MODULES[genre].availability(mode as never) !== 'staged').map((mode) => `${genre}.${mode}`));
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
 * Kostra P54C T4: osm žánrů je v kontraktu, ale nehraje – nikdo je nevybere, dokud jejich úloha nepřepne buňku.
 * T5 přepnulo chytání (`catch`), T6 bouchání (`whack`), T7 obranu pruhů (`defense`), T8 krájení (`slice`),
 * T9 přeskákání silnice (`hop`), T10 dav a brány (`crowd`), T11 pouštění a slučování (`merge`), T12 vytlačování
 * (`push`) – kostra už žádný žánr nedrží; brány níž hlídají, kdyby se úloha žánru musela vrátit na kostru.
 */
const STAGED: readonly GenreId[] = [];

describe('staged genres (P54C T4)', () => {
  it('registers the remaining new genres with one default mode, staged, and a compile that refuses', () => {
    for (const genre of STAGED) {
      expect(GENRES).toContain(genre);
      expect(GENRE_MODES[genre]).toEqual(['default']);
      const module = GENRE_MODULES[genre];
      expect(module.availability('default' as never)).toBe('staged');
      expect(module.cues).toEqual([]);
      expect(() => module.compile({ genre, mode: 'default', hero: 'fox', setting: 'forest' } as never)).toThrow(/not live/);
      expect(FOE_DOES[genre]).toBeDefined();
      expect(COUNT_PARAMS[genre]).toBeDefined();
      expect(genreSpecSchema.safeParse({ genre, mode: 'default', hero: 'fox', setting: 'forest' }).success).toBe(true);
    }
  });

  it('the classifier never ranks a staged genre, even when the sentence names it', () => {
    const sentences = ['whack the moles before they hide', 'slice the flying fruit but not the bombs', 'catch the falling apples', 'defend the castle from waves of goblins', 'merge the fruits in a jar', 'a crowd runs through gates', 'hop across the busy road', 'push rivals out of the ring', 'a cozy game'];
    for (const sentence of sentences) {
      const ranked = classifyGenre(sentence, null).ranked;
      expect(ranked.filter((choice) => (STAGED as readonly string[]).includes(choice.genre)), sentence).toEqual([]);
    }
  });

  it('every staged genre has a staged cell and no live one', () => {
    for (const genre of STAGED) {
      const cell = ALLOWED.find((entry) => entry.id === `${genre}.default`);
      expect(cell?.status, genre).toBe('staged');
      expect(liveCells().some((entry) => entry.preset.genre === genre)).toBe(false);
    }
  });
});

describe('cast list (P39 T4)', () => {
  it('the schema has no single enemy, collectible, target or enemyMoves slot', () => {
    const base = { genre: 'runner', mode: 'default', hero: 'penguin', setting: 'icy mountain slope' };
    expect(genreSpecSchema.safeParse({ ...base, cast: [{ label: 'rock', does: 'avoid' }] }).success).toBe(true);
    for (const old of [{ enemy: 'rock' }, { collectible: 'snowflake' }, { target: { label: 'flag', verb: 'reach', states: 2 } }, { enemyMoves: 'chase' }]) {
      expect(genreSpecSchema.safeParse({ ...base, ...old }).success, Object.keys(old)[0]).toBe(false);
    }
    expect(genreSpecSchema.safeParse({ ...base, cast: [{ label: 'rock', does: 'dance' }] }).success).toBe(false);
  });

  it('reads an old-shape spec into the cast – the penguin fixture keeps its rock and snowflake', () => {
    const read = readGenreSpec(penguin);
    if (!read.ok) throw new Error(read.issues.join('; '));
    expect(read.value.cast).toEqual([
      { label: 'rock', does: 'avoid' },
      { label: 'snowflake', does: 'collect' },
    ]);
    expect(Object.keys(read.value)).not.toEqual(expect.arrayContaining(['enemy']));
  });

  it.each([
    ['runner', 'default', { enemy: 'wolf', enemyMoves: 'shoot' }, [{ label: 'wolf', does: 'shoot_at' }]],
    ['runner', 'default', { enemy: 'wolf', enemyMoves: 'chase' }, [{ label: 'wolf', does: 'chase_me' }]],
    ['arena', 'escape', { enemy: 'guard', enemyMoves: 'patrol' }, [{ label: 'guard', does: 'chase_me', patrol: true }]],
    ['quest', 'spatial', { enemy: 'ghost', enemyMoves: 'still' }, [{ label: 'ghost', does: 'avoid' }]],
    ['arena', 'escape', { enemy: 'polar bear' }, [{ label: 'polar bear', does: 'chase_me' }]],
    ['arena', 'fight', { enemy: 'black knight' }, [{ label: 'black knight', does: 'fight' }]],
    ['shooter', 'default', { enemy: 'alien bug' }, [{ label: 'alien bug', does: 'shoot_at' }]],
    ['platformer', 'default', { enemy: 'fallen log' }, [{ label: 'fallen log', does: 'avoid' }]],
    ['quest', 'spatial', { target: { label: 'candle', verb: 'light', states: 2 } }, [{ label: 'candle', verb: 'light', states: 2, does: 'reach' }]],
    ['throw', 'default', { target: { label: 'snowman', verb: 'hit', states: 2 }, collectible: 'snowball' }, [{ label: 'snowball', does: 'collect' }, { label: 'snowman', verb: 'hit', states: 2, does: 'throw_at' }]],
  ] as const)('old %s.%s %j becomes the cast %j', (genre, mode, old, cast) => {
    const read = readGenreSpec({ genre, mode, hero: 'fox', setting: 'forest', ...old });
    if (!read.ok) throw new Error(read.issues.join('; '));
    expect(read.value.cast).toEqual(cast);
  });

  it('a malformed old slot is refused, not dropped', () => {
    expect(readGenreSpec({ genre: 'runner', mode: 'default', hero: 'fox', setting: 'forest', enemy: '' }).ok).toBe(false);
    expect(readGenreSpec({ genre: 'quest', mode: 'spatial', hero: 'fox', setting: 'forest', target: 42 }).ok).toBe(false);
    expect(readGenreSpec({ genre: 'quest', mode: 'spatial', hero: 'fox', setting: 'forest', target: { label: 'candle', states: 7 } }).ok).toBe(false);
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
