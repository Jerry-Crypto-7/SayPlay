/**
 * Švy jádra P32-0 T4: pahýly všech režimů jsou registrované a vybírá je
 * `controlParams.generator`; HP a stav cíle žijí v hashovaném stavu a starý
 * svět v nich má všude 0. Kdyby šev chyběl, stopa E–G by musela sahat do
 * sdílených souborů – a kdyby nová pole nebyla neutrální, přestaly by se
 * přehrávat sdílené hry.
 */

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { canonicalHash } from '@/ir/worlddoc';
import { remixPatch } from '@/play/director/remix';
import { type GenreSpec } from '@/play/genre/contract';
import { compileGenre } from '@/play/genre/index';
import { CONTROL_PARAMS, type GameSpecV1, readGameSpec } from '@/play/spec';

import duelFixture from '../__fixtures__/duel.json';
import { baseControlOf } from '../addons';
import { arcadeWorldOf, compileArcade, generatorOf } from '../compile';
import { type ArcadeLevel, BODY, BUTTON, FLAG, HEADER, HP_MAX, NO_INPUT, type RulePiece, TARGET_STATE_MAX, bodyBase, bodyHp, targetStateOf } from '../contract';
import { type ArcadeLibrary, buildWorld, instantiate, loadProgram, step } from '../kernel';
import { ARCADE_LIBRARY, MODE_GENERATORS } from '../library';
import { modeNotBuilt } from '../pieces/mode-stub';
import { compileRules } from '../rules/compile';
import { ruleWhenSchema } from '../rules/schema';

const SAMPLE: Readonly<Record<string, GenreSpec>> = {
  platformer: { genre: 'platformer', mode: 'default', hero: 'firefighter robot', cast: [{ label: 'fallen log', does: 'avoid' }, { label: 'water drop', does: 'collect' }], setting: 'burning forest' },
  escape: { genre: 'arena', mode: 'escape', hero: 'cat', cast: [{ label: 'polar bear', does: 'chase_me' }, { label: 'glowing fish', does: 'collect' }], setting: 'frozen lake' },
  collect: { genre: 'arena', mode: 'collect', hero: 'little fish', cast: [{ label: 'shark', does: 'chase_me' }, { label: 'plankton', does: 'collect' }], setting: 'coral reef' },
  fight: { genre: 'arena', mode: 'fight', hero: 'knight', cast: [{ label: 'black knight', does: 'fight' }], setting: 'castle courtyard' },
  race: { genre: 'voyage', mode: 'race', hero: 'pirate ship', cast: [{ label: 'cannonball', does: 'avoid' }, { label: 'treasure', does: 'collect' }], setting: 'sea between islands' },
  land: { genre: 'voyage', mode: 'land', hero: 'rocket', cast: [{ label: 'meteor', does: 'avoid' }], setting: 'surface of Mars' },
  spatial: { genre: 'quest', mode: 'spatial', hero: 'tiny wizard', cast: [{ label: 'ghost', does: 'chase_me' }, { label: 'candle', does: 'reach', verb: 'light', states: 2 }], setting: 'haunted castle' },
  station: { genre: 'quest', mode: 'station', hero: 'chef', cast: [{ label: 'pancake', does: 'reach', verb: 'flip', states: 3 }], setting: 'restaurant kitchen' },
};

/** Režim → (vzorek, generátor). Platforma `feel: 2` jede dnešním generátorem s `tuning`. */
const MODES = [
  ['escape', 'arena_escape'],
  ['collect', 'arena_collect'],
  ['fight', 'fight'],
  ['race', 'voyage_race'],
  ['land', 'voyage_land'],
  ['spatial', 'quest_spatial'],
  ['station', 'quest_station'],
] as const;

const delegate = (spec: GameSpecV1, extra: Record<string, unknown>): unknown => ({ ...spec, controlParams: { ...spec.controlParams, ...extra } });

function read(input: unknown): GameSpecV1 {
  const result = readGameSpec(input);
  if (!result.ok) throw new Error(`${result.reason}: ${result.issues.join('; ')}`);
  return result.value;
}

const PLAYER = { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: 1000, h: 1000, d: 1000, solid: false } as const;
const CANDLE = { role: 'target', kind: 'candle', x: 5000, y: 0, z: 0, w: 500, h: 500, d: 500, solid: false, hp: 5 } as const;

/** Svět s pravidlem, které v tiku `at` vydá dané efekty – efekty jádra dřív, než je vydá kus souboje nebo úkolu. */
function scriptedWorld(level: ArcadeLevel, plan: readonly { readonly at: number; readonly effects: readonly unknown[] }[]) {
  const script = z.object({ at: z.int(), effects: z.array(z.unknown()) });
  const scripted: RulePiece<{ plan: z.infer<typeof script>[] }> = {
    id: 'scripted',
    params: z.object({ plan: z.array(script) }),
    roles: ['player'],
    trigger: 'tick',
    cost: () => ({ bodies: 0, rules: 1 }),
    fire: (ctx, params) => (params.plan.find((entry) => entry.at === ctx.state[HEADER.tick])?.effects ?? []) as never,
  };
  const library: ArcadeLibrary = { ...ARCADE_LIBRARY, rules: { ...ARCADE_LIBRARY.rules, scripted } };
  const built = buildWorld({ seed: 1, control: { id: 'fight', params: {} }, rules: [{ id: 'scripted', params: { plan } }], bot: { id: 'fight_bot', params: {} }, level }, library);
  if (!built.ok) throw new Error(built.issues.join('; '));
  return { state: instantiate(built.world), program: loadProgram(built.world, library) };
}

describe('P32-0 T4 kernel seams', () => {
  it('keeps every original planned mode registered when native modes are added', () => {
    expect(Object.keys(MODE_GENERATORS)).toEqual(expect.arrayContaining(MODES.map(([, id]) => id)));
    for (const [, id] of MODES) {
      expect(MODE_GENERATORS[id]?.id).toBe(id);
      expect(ARCADE_LIBRARY.generators[id]).toBe(MODE_GENERATORS[id]);
    }
    expect(ARCADE_LIBRARY.controls.fight?.id).toBe('fight');
    expect(ARCADE_LIBRARY.bots.fight_bot?.id).toBe('fight_bot');
    expect(ARCADE_LIBRARY.bots.quest_bot?.id).toBe('quest_bot');
    expect(ARCADE_LIBRARY.rules.interact?.trigger).toBe('press');
  });

  /**
   * Postavený režim (P32E–G) svět postaví, nebo ho odmítne jeho vlastní schéma
   * (`(generator <id>)` – klíč starého specu, který nový režim nezná); pahýl
   * odmítne `modeNotBuilt`. Všechno tři dokazují, že delegace došla k tomu generátoru.
   */
  const reachedMode = (made: ReturnType<typeof arcadeWorldOf>, id: string): boolean =>
    made.ok || (made.issues.length === 1 && made.issues[0] === modeNotBuilt(id)) || made.issues.every((issue) => issue.endsWith(`(generator ${id})`));

  it.each(MODES)('%s: GenreSpec → readGameSpec with generator %s → that generator, built or refusing as a stub', (sample, id) => {
    const spec = read(delegate(compileGenre(SAMPLE[sample] as GenreSpec), { generator: id }));
    expect(generatorOf(spec)).toBe(id);
    const made = arcadeWorldOf(spec, 1);
    expect(reachedMode(made, id), made.ok ? 'ok' : made.issues.join('; ')).toBe(true);
  });

  // Revize T4 kolo 2: `chaser` četl `level.bodies[0]` z prázdné úrovně pahýlu → TypeError → 500.
  // Základ z `escape`: jeho ovládání `chaser` bere, takže doplněk projde čtením a dojde až ke kompilaci.
  // Postavený režim, jehož ovládání pronásledovatele nebere (souboj, P32E T3), doplněk odmítne hláškou.
  it.each(MODES)('%s: a mode with the chaser addon builds or refuses cleanly (generator %s)', (_sample, id) => {
    const spec = read(delegate({ ...compileGenre(SAMPLE.escape as GenreSpec), addons: ['chaser'] } as never, { generator: id }));
    const made = arcadeWorldOf(spec, 1);
    const noChaser = !made.ok && made.issues.length === 1 && made.issues[0] === 'chaser: the level has no place for a chaser';
    expect(reachedMode(made, id) || noChaser, made.ok ? 'ok' : made.issues.join('; ')).toBe(true);
  });

  it('the platformer takes feel: 2 through tuning, validated by the platform generator, not by spec.ts', () => {
    const plain = compileGenre(SAMPLE.platformer as GenreSpec);
    const felt = read(delegate(plain, { tuning: { feel: 2 } }));
    expect(generatorOf(felt)).toBe('platform_level');
    const made = arcadeWorldOf(felt, 1);
    expect(made.ok ? 'ok' : made.issues.join('; ')).toBe('ok');
    // Od P36A T6 pocit dojde až k ovládání (dřív stub bez účinku): bez `tuning` je to jiný svět.
    const { tuning: _tuning, ...untuned } = plain.controlParams as Record<string, unknown>;
    const before = arcadeWorldOf(read({ ...plain, controlParams: untuned }), 1);
    expect(made.ok && baseControlOf(made.world.control).params).toMatchObject({ feel: 2 });
    expect(made.ok && before.ok && canonicalHash(made.world)).not.toBe(before.ok && canonicalHash(before.world));
    const wrong = arcadeWorldOf(read(delegate(plain, { tuning: { feel: 3 } })), 1);
    expect(!wrong.ok && wrong.issues.join(' ')).toMatch(/feel.*platform_level/);
  });

  it('tuning may not carry a key the control already validates in spec.ts, so it cannot slip past its bounds', () => {
    // 30 s výherní časovač + `tuning: {seconds: 60}` hrál na růst; timing `tuning: {tolerance: 50}` obešel mez 100 (revize T4).
    const runner = compileGenre({ genre: 'runner', mode: 'default', hero: 'penguin', cast: [{ label: 'rock', does: 'avoid' }, { label: 'snowflake', does: 'collect' }], setting: 'icy mountain slope' });
    // Souboj už jde přes `move_free` (P32E T4); `duel` pokrývá uložený duel.
    const plains = [runner, read(duelFixture), ...Object.values(SAMPLE).map((sample) => compileGenre(sample))];
    const controls = new Set(plains.map((plain) => plain.control));
    expect([...controls].sort()).toEqual(['duel', 'move_free', 'platform', 'runner', 'steer']);
    for (const plain of plains) {
      const control = plain.control as keyof typeof CONTROL_PARAMS;
      for (const key of Object.keys(CONTROL_PARAMS[control].shape)) {
        const result = readGameSpec(delegate(plain, { tuning: { [key]: 1 } }));
        expect(!result.ok && result.issues.join(' '), `${control}.${key}`).toContain(`/controlParams/tuning/${key}`);
      }
    }
  });

  it('an unknown generator is refused, not silently replaced', () => {
    const made = arcadeWorldOf(read(delegate(compileGenre(SAMPLE.escape as GenreSpec), { generator: 'maze_walk' })), 1);
    expect(!made.ok && made.issues.join(' ')).toContain('no generator maze_walk');
  });

  it('a generator named after an Object prototype key is refused, not a crash', () => {
    // Jiné klíče prototypu (`toString`, `__proto__`) odmítne už vzor jména v `spec.ts`.
    for (const generator of ['constructor']) {
      const made = arcadeWorldOf(read(delegate(compileGenre(SAMPLE.escape as GenreSpec), { generator })), 1);
      expect(!made.ok && made.issues.join(' '), generator).toContain(`no generator ${generator}`);
    }
  });

  it('remix chips leave a game with a delegated generator alone instead of crashing', () => {
    const runner = compileGenre({ genre: 'runner', mode: 'default', hero: 'penguin', cast: [{ label: 'rock', does: 'avoid' }, { label: 'snowflake', does: 'collect' }], setting: 'icy mountain slope' });
    for (const extra of [{ generator: 'runner_track' }, { tuning: { coins: false } }]) {
      const spec = read(delegate(runner, extra));
      for (const chip of ['harder', 'twist', 'swap_enemy'] as const) expect(remixPatch(chip, spec, 1), `${chip} ${JSON.stringify(extra)}`).toEqual([]);
    }
    expect(remixPatch('harder', read(runner), 1).length).toBeGreaterThan(0);
  });

  it('a spec without the new fields reads back unchanged, so its hash does not move', () => {
    // Od fáze 1 A, E, F a G nesou nová pole všechny žánry; bez nich zůstává uložený starý svět (duel).
    const plain = (spec: GameSpecV1): boolean => spec.controlParams === undefined || !('generator' in spec.controlParams || 'tuning' in spec.controlParams);
    const duel = read(duelFixture);
    expect(plain(duel)).toBe(true);
    for (const spec of [duel, ...Object.values(SAMPLE).map((sample) => compileGenre(sample))]) {
      const back = read(spec);
      expect(plain(back)).toBe(plain(spec));
      expect(canonicalHash(back)).toBe(canonicalHash(read(JSON.parse(JSON.stringify(spec)))));
    }
  });

  it('an old world keeps HP and target state at 0 in every body', () => {
    // Souboj z žánru HP nese (P32E); starý svět souboje je uložený duel. Starý svět žánru = uložený
    // před průběhem (`genre.v1`): nová hra útěku nese od P45C T12 bosse s HP.
    const stored = (spec: GameSpecV1): GameSpecV1 => ({ ...spec, genre: { ...spec.genre!, compilerVersion: 'genre.v1' } });
    for (const spec of [stored(compileGenre(SAMPLE.escape as GenreSpec)), read(duelFixture), stored(compileGenre(SAMPLE.platformer as GenreSpec))]) {
      const compiled = compileArcade(read(spec), 1);
      if (!compiled.ok || compiled.value.arcade === undefined) throw new Error('fixture did not compile');
      const state = instantiate(compiled.value.arcade);
      const count = state[HEADER.bodyCount] as number;
      for (let body = 0; body < count; body += 1) {
        expect(bodyHp(state, body)).toBe(0);
        expect(targetStateOf(state, body)).toBe(0);
      }
    }
  });

  it('the kernel applies hit to HP (floor 0) and stateChange to the target state (0..2)', () => {
    const { state, program } = scriptedWorld({ bodies: [PLAYER, CANDLE], length: 0 }, [
      { at: 0, effects: [{ kind: 'hit', body: 1, by: 0, amount: 2 }] },
      { at: 1, effects: [{ kind: 'hit', body: 1, by: 0, amount: 9 }] },
      { at: 2, effects: [{ kind: 'stateChange', body: 1, state: 1 }] },
      { at: 3, effects: [{ kind: 'stateChange', body: 1, state: 7 }, { kind: 'hit', body: 9, by: 0, amount: 1 }] },
    ]);
    expect(bodyHp(state, 1)).toBe(5);
    const seen: number[][] = [];
    for (let tick = 0; tick < 4; tick += 1) {
      step(state, tick === 0 ? { buttons: BUTTON.ATTACK | BUTTON.INTERACT, axis: 0 } : NO_INPUT, program);
      seen.push([bodyHp(state, 1), targetStateOf(state, 1)]);
    }
    expect(seen).toEqual([
      [3, 0],
      [0, 0],
      [0, 1],
      [0, TARGET_STATE_MAX],
    ]);
    // Ostatní bity `flags` zůstaly: tělo žije dál.
    expect((state[bodyBase(1) + BODY.flags] as number) & FLAG.alive).toBe(FLAG.alive);
  });

  it('hit and stateChange touch only live bodies, and a negative hit does not heal', () => {
    // Zásah předlohy by snížil HP každé další kopii; záporný `amount` léčil až na HP_MAX (revize T4).
    const bodies = [PLAYER, CANDLE, { ...CANDLE, template: true }, { ...CANDLE, x: 9000 }];
    const { state, program } = scriptedWorld({ bodies, length: 0, spawnSlots: 1 }, [
      { at: 0, effects: [{ kind: 'despawn', body: 3 }, { kind: 'hit', body: 1, by: 0, amount: -3 }] },
      {
        at: 1,
        effects: [
          { kind: 'hit', body: 2, by: 0, amount: 2 },
          { kind: 'stateChange', body: 2, state: 1 },
          { kind: 'hit', body: 3, by: 0, amount: 2 },
          { kind: 'stateChange', body: 3, state: 2 },
        ],
      },
      { at: 2, effects: [{ kind: 'spawn', template: 2, x: 7000, y: 0, z: 0, vx: 0, vy: 0, vz: 0 }] },
      { at: 3, effects: [{ kind: 'hit', body: 4, by: 0, amount: 1 }, { kind: 'stateChange', body: 4, state: 1 }] },
    ]);
    for (let tick = 0; tick < 4; tick += 1) step(state, NO_INPUT, program);
    expect([1, 2, 3, 4].map((body) => [bodyHp(state, body), targetStateOf(state, body)])).toEqual([
      [5, 0],
      [5, 0],
      [5, 0],
      [4, 1],
    ]);
  });

  it('buildWorld refuses HP outside 1..HP_MAX', () => {
    const player = { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: 1000, h: 1000, d: 1000, solid: false } as const;
    for (const hp of [0, HP_MAX + 1, 1.5]) {
      const built = buildWorld({ seed: 1, control: { id: 'fight', params: {} }, rules: [], bot: { id: 'fight_bot', params: {} }, level: { bodies: [player, { ...player, role: 'enemy', hp }], length: 0 } }, ARCADE_LIBRARY);
      expect(built.ok, `hp ${hp}`).toBe(false);
    }
  });

  it('the spec rule language takes interact from rules/interact.ts and compiles it to the interact piece', () => {
    const when = { interact: { role: 'candle', radius: 2, hold: 30, states: 2 } };
    expect(ruleWhenSchema.safeParse(when).success).toBe(true);
    const base = compileGenre(SAMPLE.escape as GenreSpec);
    const spec = read({
      ...base,
      roles: [...base.roles, { id: 'candle', kind: 'target', label: 'candle' }],
      // `interact` čtení pustí jen jako vítězné pravidlo dvorku (P32B, revize fáze 3).
      rules: [{ id: 'light', verb: 'light', when, do: [{ win: true }] }],
    });
    const player = { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: 1000, h: 1000, d: 1000, solid: false } as const;
    const compiled = compileRules(spec, { bodies: [player], length: 0 }, 1);
    expect(compiled.issues).toEqual([]);
    const ref = compiled.rules.find((rule) => rule.id === 'interact');
    expect(ref?.params).toMatchObject({ when: { interact: { radius: 2000, hold: 30, states: 2 } } });
  });
});
