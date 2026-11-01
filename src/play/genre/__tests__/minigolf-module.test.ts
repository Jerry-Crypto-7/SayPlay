/**
 * Modul žánru Minigolf (P68 T7): narážky a meze, brána aktivace kostry, doplnění z věty, překlad parametrů do generátoru
 * a publikační brána (`compileArcade` + `verifyArcade`, totéž co `POST /api/play/games`) na 10 semínkách vzorového specu
 * pro T9 – dráha L s odrazníky z věty a jednou pohyblivou překážkou.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compileArcade } from '../../arcade/compile';
import { minigolfEvidence, minigolfLayoutOf } from '../../arcade/pieces/minigolf-trace';
import { verifyArcade } from '../../arcade/verify';
import { type GameSpecV1, readGameSpec } from '../../spec';
import { type GenreSpecOf, genreSpecSchema } from '../contract';
import { compileMinigolf, minigolfGenre } from '../minigolf';

const DEV = (JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p68/vozidla-sport/dev.json'), 'utf8')) as { sentences: { game: string; text: string }[] }).sentences
  .filter((row) => row.game === 'minigolf')
  .map((row) => row.text);

/** Věta → `GenreSpec` jako rychlý návrh: doplnění modulu, výchozí místo žánru (`draft.ts`), parametry navrch. */
function specOf(sentence: string, params?: Readonly<Record<string, number>>): GenreSpecOf<'minigolf'> {
  const fill = minigolfGenre.draftFill(sentence, null);
  return genreSpecSchema.parse({ setting: 'mini golf course', ...fill, ...(params === undefined ? {} : { params: { ...fill.params, ...params } }) }) as GenreSpecOf<'minigolf'>;
}

const tuningOf = (spec: GameSpecV1): unknown => (spec.controlParams as { tuning?: unknown } | undefined)?.tuning;

/** Vzorový spec pro T9 (`e2e/fixtures/p68-minigolf-spec.json`): dráha L, 3 odrazníky-dýně, pohyblivá rakev. */
const SAMPLE = {
  schema: 'gamespec.v1',
  control: 'minigolf',
  controlParams: { generator: 'minigolf_course', tuning: { shape: 'L', obstacles: 3, moving: true, bumper: 'cc0-pumpkin', mover: 'gen3d-coffin' } },
  genre: { id: 'minigolf', mode: 'default', compilerVersion: 'genre.v7' },
  title: 'Haunted House Mini Golf',
  archetype: 'hazard_crossing',
  targetDurationSec: 30,
  theme: { setting: 'haunted house', mood: 'playful' },
  objective: { kind: 'reach', description: 'Putt the ball around the obstacles into the hole in as few strokes as you can.', role: 'hole' },
  mechanics: [],
  roles: [
    { id: 'player', kind: 'player', label: 'golf ball', count: 1 },
    { count: 1, id: 'hole', kind: 'destination', label: 'hole' },
    { count: 3, id: 'bumper', kind: 'prop', label: 'pumpkin' },
    { count: 1, id: 'mover', kind: 'prop', label: 'coffin' },
  ],
  scoring: {},
  tutorial: { goalLine: 'Sink the ball in as few strokes as you can!', controlsHint: 'Drag back from the ball and let go. Keys: arrows aim, hold Space.' },
  verification: [{ id: 'winnable', kind: 'reachability', assert: { runState: 'won' } }],
  budgets: { maxEntities: 40, maxRules: 120, maxTriangles: 200000 },
} as const;
const SAMPLE_SENTENCE = 'mini golf in a haunted house with pumpkins and a moving coffin';

describe('minigolf genre module (P68 T7)', () => {
  it('lists its cues and param bounds and stays staged: compile throws like the scaffold until "wire minigolf"', () => {
    expect(minigolfGenre.cues).toEqual(['mini golf', 'minigolf', 'putt', 'golf course', 'hole in one', 'golf ball through']);
    expect(minigolfGenre.paramBounds).toEqual({ bends: { min: 0, max: 2 }, obstacles: { min: 1, max: 3 }, moving: { min: 0, max: 1 }, par: { min: 2, max: 4 } });
    expect(minigolfGenre.availability('default')).toBe('staged');
    const spec = specOf(SAMPLE_SENTENCE);
    expect(() => minigolfGenre.compile(spec)).toThrow(/not live/);
    expect(compileMinigolf(spec).control).toBe('minigolf');
  });

  it('fills the place, the obstacles and the moving one from the sentence; the player is always the golf ball', () => {
    const cases: readonly [string, string, readonly string[], boolean][] = [
      ['putt the golf ball past a spinning windmill on a candy island', 'candy island', ['windmill'], true],
      ['a mini golf hole inside a pirate ship with cannon barrels as bumpers', 'pirate ship', ['cannon barrel'], false],
      ['putt a ball around the dinosaur bones in a museum mini golf course', 'museum', ['dinosaur bone'], false],
      ['minigolf on the moon with craters and a rocket blocking the hole', 'moon', ['crater', 'rocket'], false],
      ['a crazy golf course in the jungle with logs and a sliding snake', 'jungle', ['log', 'snake'], true],
      ['sink a hole in one on a mini golf green under the sea between coral rocks', 'sea', ['coral rock'], false],
      ['putt a golf ball across a snowy hill past the penguins to the flag', 'snowy hill', ['penguin'], false],
    ];
    for (const [sentence, setting, things, moving] of cases) {
      const fill = minigolfGenre.draftFill(sentence, null);
      expect(fill.hero, sentence).toBe('golf ball');
      expect(fill.setting, sentence).toBe(setting);
      expect(fill.cast?.map((item) => item.label), sentence).toEqual(things);
      expect(fill.params?.moving === 1, sentence).toBe(moving);
      expect(fill.cast?.some((item) => item.patrol === true), sentence).toBe(moving);
    }
  });

  it('compiles params into generator tuning: bends → shape, par alone → shape, par never below the legs, moving and models', () => {
    expect(tuningOf(compileMinigolf(specOf('mini golf in a haunted house', { bends: 2, obstacles: 1 })))).toEqual({ shape: 'S', obstacles: 1 });
    expect(tuningOf(compileMinigolf(specOf('mini golf in a haunted house', { par: 3 })))).toEqual({ shape: 'L', par: 3 });
    expect(tuningOf(compileMinigolf(specOf('mini golf in a haunted house', { bends: 2, par: 2 })))).toEqual({ shape: 'S', par: 3 });
    expect(tuningOf(compileMinigolf(specOf('mini golf in a haunted house')))).toBeUndefined();
    // Bez modelu v katalogu (kráter) vezme odrazník první věc, která model má.
    expect(tuningOf(compileMinigolf(specOf('minigolf on the moon with craters and a rocket blocking the hole')))).toEqual({ bumper: 'rocket' });
    expect(tuningOf(compileMinigolf(specOf('a crazy golf course in the jungle with logs and a sliding snake', { moving: 0 })))).toEqual({ bumper: 'cc0-wood-log' });
    for (const sentence of DEV) expect(readGameSpec(compileMinigolf(specOf(sentence))).ok, sentence).toBe(true);
  });

  it('the T9 sample spec is exactly what the module writes for its sentence, and a valid game spec', () => {
    expect(compileMinigolf(specOf(SAMPLE_SENTENCE, { bends: 1, obstacles: 3 }))).toEqual(SAMPLE);
    expect(readGameSpec(SAMPLE).ok).toBe(true);
  });

  it('the sample passes the publication gate on 10 seeds: an L hole with 3 bumpers and a moving obstacle, holed with evidence from state', () => {
    for (let seed = 1; seed <= 10; seed += 1) {
      const made = compileArcade(SAMPLE as unknown as GameSpecV1, seed);
      if (!made.ok || made.value.arcade === undefined) throw new Error(`seed ${String(seed)}: ${JSON.stringify(made)}`);
      const world = made.value.arcade;
      const layout = minigolfLayoutOf(world);
      expect(layout.route, `seed ${String(seed)}`).toHaveLength(2);
      expect(layout.bumpers[1], `seed ${String(seed)}`).toBe(3);
      expect(layout.mover, `seed ${String(seed)}`).toBeDefined();
      const verdict = verifyArcade(world);
      expect(verdict.failures, `seed ${String(seed)}`).toEqual([]);
      expect(verdict.publishEligible).toBe(true);
      expect(verdict.idle.outcome).toBe('lost');
      const evidence = minigolfEvidence(world, verdict.bot.inputs);
      expect(evidence, `seed ${String(seed)}`).toMatchObject({ outcome: 'won', holed: true, outOfBounds: 0, bounces: 0 });
      expect(evidence.strokes).toBe(evidence.shots);
      expect(evidence.aimChanges).toBeGreaterThanOrEqual(1);
    }
  }, 300_000);

  it('every minigolf dev sentence compiles to a game that passes the publication gate', () => {
    for (const sentence of DEV) {
      const made = compileArcade(compileMinigolf(specOf(sentence)), 3);
      if (!made.ok || made.value.arcade === undefined) throw new Error(`${sentence}: ${JSON.stringify(made)}`);
      expect(verifyArcade(made.value.arcade).failures, sentence).toEqual([]);
    }
  }, 300_000);
});
