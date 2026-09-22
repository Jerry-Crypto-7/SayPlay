import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ARCADE_LIMITS,
  type ArcadeLevel,
  BODY,
  BUTTON,
  type BodyInit,
  COUNTER,
  type ControlPiece,
  FLAG,
  HEADER,
  type InputEvent,
  NO_INPUT,
  bodyBase,
} from '../contract';
import { type ArcadeLibrary, buildWorld, hashArcade, instantiate, loadProgram, replay, step } from '../kernel';
import { RULES } from '../pieces/rules';

/** Testovací ovládání: stálý běh vpřed, ťuk ze země = skok, vlevo/vpravo = krok o metr. */
const testControl: ControlPiece<{ vz: number }> = {
  id: 'test',
  params: z.object({ vz: z.int() }),
  roles: ['player'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    const base = bodyBase(player);
    state[base + BODY.vz] = params.vz;
    const grounded = ((state[base + BODY.flags] as number) & FLAG.grounded) !== 0;
    if ((input.buttons & BUTTON.TAP) !== 0 && grounded) state[base + BODY.vy] = 140;
    if ((input.buttons & BUTTON.LEFT) !== 0) state[base + BODY.x] = (state[base + BODY.x] as number) - 1000;
    if ((input.buttons & BUTTON.RIGHT) !== 0) state[base + BODY.x] = (state[base + BODY.x] as number) + 1000;
  },
};

const library: ArcadeLibrary = { controls: { test: testControl }, rules: RULES, generators: {}, bots: { idle: { id: 'idle', params: z.object({}), roles: [], reactionTicks: 0, cost: () => ({ bodies: 0, rules: 0 }), decide: () => NO_INPUT } } };

const body = (role: BodyInit['role'], z: number, extra: Partial<BodyInit> = {}): BodyInit => ({
  role,
  kind: role,
  x: 0,
  y: 0,
  z,
  w: 800,
  h: 1000,
  d: 400,
  solid: role === 'obstacle',
  ...extra,
});

const player = body('player', 0, { w: 600, h: 1600, d: 500 });

function world(bodies: readonly BodyInit[], opts: { vz?: number; length?: number; rules?: string[]; health?: number } = {}) {
  const level: ArcadeLevel = { bodies: [player, ...bodies], length: opts.length ?? 100_000 };
  const built = buildWorld(
    {
      seed: 1,
      control: { id: 'test', params: { vz: opts.vz ?? 100 } },
      rules: (opts.rules ?? ['hit', 'pickup', 'finish']).map((id) => ({ id, params: id === 'hit' ? { role: 'obstacle', effect: opts.health ? 'damage' : 'lose' } : {} })),
      bot: { id: 'idle', params: {} },
      level,
      health: opts.health,
    },
    library,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

describe('arkádové jádro', () => {
  it('stejný záznam dá stejný hash (200 náhodných záznamů)', () => {
    const w = world([
      body('obstacle', 8000, { x: -1000 }),
      body('obstacle', 15000, { x: 1000, h: 500 }),
      body('collectible', 5000, { h: 500, w: 500, solid: false }),
      body('collectible', 12000, { x: 1000, h: 500, w: 500, solid: false }),
      body('goal', 30000, { w: 6000, h: 3000, solid: false }),
    ]);
    const rng = xoroshiro128plus(20260922);
    const hashes = new Set<string>();
    for (let r = 0; r < 200; r += 1) {
      const inputs: InputEvent[] = [];
      for (let tick = 0; tick < 400; tick += 1) {
        if (uniformInt(rng, 0, 9) !== 0) continue;
        const buttons = [BUTTON.TAP, BUTTON.LEFT, BUTTON.RIGHT][uniformInt(rng, 0, 2)] as number;
        inputs.push({ tick, buttons, axis: 0 });
      }
      const first = replay(w, inputs, library);
      const second = replay(w, inputs, library);
      expect(second).toEqual(first);
      hashes.add(first.hash);
    }
    // Hash opravdu nese stav: různé záznamy nekončí v jednom stavu.
    expect(hashes.size).toBeGreaterThan(50);
  });

  it('skok vystoupá a dopadne zpět na zem', () => {
    const w = world([]);
    const program = loadProgram(w, library);
    const state = instantiate(w);
    const y = bodyBase(0) + BODY.y;
    step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
    let peak = 0;
    let landedAt = -1;
    for (let t = 1; t < 120 && landedAt < 0; t += 1) {
      step(state, NO_INPUT, program);
      peak = Math.max(peak, state[y] as number);
      if (state[y] === 0) landedAt = t;
    }
    expect(peak).toBeGreaterThan(1000);
    expect(landedAt).toBeGreaterThan(20);
    expect((state[bodyBase(0) + BODY.flags] as number) & FLAG.grounded).not.toBe(0);
  });

  it('náraz do překážky vyvolá pravidlo a běh prohraje', () => {
    const w = world([body('obstacle', 3000)]);
    expect(replay(w, [], library).outcome).toBe('lost');
  });

  it('přeskočená překážka nevadí a páska na konci vyhraje', () => {
    const w = world([body('obstacle', 3000, { h: 500 }), body('goal', 6000, { w: 6000, h: 3000, solid: false })]);
    // Skok ~1,2 m nad překážkou 0,5 m: ťuk kolem tiku 20 (překážka v 3 m, 100 j./tik).
    const result = replay(w, [{ tick: 20, buttons: BUTTON.TAP, axis: 0 }], library);
    expect(result.outcome).toBe('won');
  });

  it('dopad shora na pevné tělo není náraz', () => {
    const crate = body('obstacle', 2500, { h: 500, d: 3000 });
    const w = world([crate]);
    const program = loadProgram(w, library);
    const state = instantiate(w);
    step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
    for (let t = 0; t < 40; t += 1) step(state, NO_INPUT, program);
    expect(state[HEADER.runState]).toBe(0);
    expect(state[bodyBase(0) + BODY.y]).toBe(500);
  });

  it('sebraný předmět dá bod a zmizí; životy ubírá náraz a na nule je prohra', () => {
    const w = world([body('collectible', 2000, { solid: false }), body('obstacle', 4000), body('obstacle', 6000)], { health: 2, rules: ['hit', 'pickup', 'out_of_health'] });
    const program = loadProgram(w, library);
    const state = instantiate(w);
    for (let t = 0; t < 30; t += 1) step(state, NO_INPUT, program);
    expect(state[HEADER.counters + COUNTER.score]).toBe(1);
    expect((state[bodyBase(1) + BODY.flags] as number) & FLAG.alive).toBe(0);
    for (let t = 0; t < 20; t += 1) step(state, NO_INPUT, program);
    expect(state[HEADER.counters + COUNTER.health]).toBe(1);
    expect(state[HEADER.runState]).toBe(0);
    for (let t = 0; t < 20; t += 1) step(state, NO_INPUT, program);
    expect(state[HEADER.runState]).toBe(2);
  });

  it('strop těl a pravidel odmítne svět', () => {
    const many = Array.from({ length: ARCADE_LIMITS.maxBodies }, (_, i) => body('collectible', 2000 + i * 1000));
    const built = buildWorld({ seed: 1, control: { id: 'test', params: { vz: 100 } }, rules: [], bot: { id: 'idle', params: {} }, level: { bodies: [player, ...many], length: 0 } }, library);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.issues.join()).toMatch(/body limit/);
    const rules = Array.from({ length: ARCADE_LIMITS.maxRules + 1 }, () => ({ id: 'finish', params: {} }));
    const tooManyRules = buildWorld({ seed: 1, control: { id: 'test', params: { vz: 100 } }, rules, bot: { id: 'idle', params: {} }, level: { bodies: [player], length: 0 } }, library);
    expect(tooManyRules.ok).toBe(false);
  });

  it('neznámý kus nebo špatné parametry svět odmítnou', () => {
    const built = buildWorld({ seed: 1, control: { id: 'nope', params: {} }, rules: [{ id: 'hit', params: { role: 'ghost' } }], bot: { id: 'idle', params: {} }, level: { bodies: [player], length: 0 } }, library);
    expect(built.ok).toBe(false);
    if (!built.ok) expect(built.issues).toHaveLength(2);
  });

  it('běh bez konce se zastaví na horizontu', () => {
    const result = replay(world([]), [], library);
    expect(result).toMatchObject({ outcome: 'running', tick: ARCADE_LIMITS.maxTicks });
  });

  it('hash se změní s každým slotem stavu', () => {
    const state = instantiate(world([]));
    const before = hashArcade(state);
    state[state.length - 1] = (state[state.length - 1] as number) + 1;
    expect(hashArcade(state)).not.toBe(before);
  });

  it('modul nesahá na globální náhodu ani na hodiny', () => {
    const root = join(__dirname, '..');
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === '__tests__') continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (path.endsWith('.ts')) files.push(path);
      }
    };
    walk(root);
    expect(files.length).toBeGreaterThan(2);
    const banned = new RegExp(['Math', 'random'].join('\\.') + '|Date\\.now|performance\\.now');
    for (const file of files) expect(readFileSync(file, 'utf8'), file).not.toMatch(banned);
  });
});
