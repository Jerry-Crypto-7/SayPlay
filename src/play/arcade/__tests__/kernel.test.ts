import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeLevel,
  BODY,
  BODY_STRIDE,
  BUTTON,
  type BodyInit,
  COUNTER,
  type ControlPiece,
  FLAG,
  HEADER,
  HEADER_SIZE,
  type InputEvent,
  NO_INPUT,
  PROJECTILE_LIFETIME,
  ROLE,
  type RulePiece,
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

  it('strop těl počítá i rezervu pro spawn', () => {
    const built = buildWorld(
      { seed: 1, control: { id: 'test', params: { vz: 100 } }, rules: [], bot: { id: 'idle', params: {} }, level: { bodies: [player], length: 0, spawnSlots: ARCADE_LIMITS.maxBodies } },
      library,
    );
    expect(built.ok).toBe(false);
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

// ---------------------------------------------------------------------------
// Jádro v2 (P25C): boky a strop, vezení, spawn, respawn

/** Ovládání pro v2: osa = `vx`, stálé `vz`, ťuk ze země = skok. Pohyb jen rychlostí, aby ho kolize viděla. */
const moveControl: ControlPiece<{ vz: number }> = {
  id: 'move',
  params: z.object({ vz: z.int() }),
  roles: ['player'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, p, input, params) => {
    const base = bodyBase(p);
    state[base + BODY.vx] = input.axis;
    state[base + BODY.vz] = params.vz;
    if ((input.buttons & BUTTON.TAP) !== 0 && ((state[base + BODY.flags] as number) & FLAG.grounded) !== 0) state[base + BODY.vy] = 140;
  },
};

const touchParams = z.object({ role: z.enum(['obstacle', 'hazard', 'checkpoint', 'platform']), effect: z.enum(['score', 'respawn', 'checkpoint']) }).strict();
/** Dotek role → efekt; `checkpoint` míří na tělo dotyku. */
const touch: RulePiece<z.infer<typeof touchParams>> = {
  id: 'touch',
  params: touchParams,
  roles: [],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, other }, params): readonly ArcadeEffect[] => {
    if (state[bodyBase(other) + BODY.role] !== ROLE[params.role]) return [];
    if (params.effect === 'score') return [{ kind: 'score', amount: 1 }];
    if (params.effect === 'respawn') return [{ kind: 'respawn' }];
    return [{ kind: 'checkpoint', body: other }];
  },
};

const spawnerParams = z.object({ every: z.int().min(1), template: z.int() }).strict();
/** Každých `every` tiků vypustí kopii předlohy před hráče. */
const spawner: RulePiece<z.infer<typeof spawnerParams>> = {
  id: 'spawner',
  params: spawnerParams,
  roles: [],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params): readonly ArcadeEffect[] =>
    (state[HEADER.tick] as number) % params.every === 0 ? [{ kind: 'spawn', template: params.template, x: 0, y: 3000, z: 20_000, vx: 0, vy: 0, vz: -50 }] : [],
};

const v2Library: ArcadeLibrary = { ...library, controls: { move: moveControl }, rules: { ...RULES, touch, spawner } };

function v2World(bodies: readonly BodyInit[], rules: readonly { id: string; params: Record<string, unknown> }[] = [], opts: { vz?: number; spawnSlots?: number; start?: Partial<BodyInit> } = {}) {
  const built = buildWorld(
    {
      seed: 1,
      control: { id: 'move', params: { vz: opts.vz ?? 0 } },
      rules,
      bot: { id: 'idle', params: {} },
      level: { bodies: [{ ...player, ...opts.start }, ...bodies], length: 0, spawnSlots: opts.spawnSlots },
    },
    v2Library,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

function run(w: ReturnType<typeof v2World>, ticks: number, input: (tick: number) => { buttons: number; axis: number } = () => NO_INPUT) {
  const program = loadProgram(w, v2Library);
  const state = instantiate(w);
  for (let t = 0; t < ticks; t += 1) step(state, input(t), program);
  return state;
}

const P = bodyBase(0);
const scoreOf = (state: Int32Array): number => state[HEADER.counters + COUNTER.score] as number;

describe('arkádové jádro v2', () => {
  it('pevné tělo z boku hráče zastaví na hraně a kontakt hlásí dál', () => {
    // Zeď v x = 3 m, hráč jde +x 100 j./tik: hrana = 3000 − (600 + 800) / 2.
    const wall = body('obstacle', 0, { x: 3000, h: 3000 });
    const state = run(v2World([wall], [{ id: 'touch', params: { role: 'obstacle', effect: 'score' } }]), 60, () => ({ buttons: 0, axis: 100 }));
    expect(state[P + BODY.x]).toBe(2300);
    expect(state[P + BODY.vx]).toBe(0);
    expect(scoreOf(state)).toBeGreaterThan(0);
    expect(state[HEADER.runState]).toBe(0);
  });

  it('náraz zepředu (po z) zastaví stejně', () => {
    const block = body('obstacle', 3000, { h: 3000 });
    const state = run(v2World([block], [], { vz: 100 }), 60);
    expect(state[P + BODY.z]).toBe(3000 - (500 + 400) / 2);
    expect(state[P + BODY.vz]).toBe(0);
  });

  it('strop zastaví skok a hráč dopadne zpět', () => {
    // Spodní stěna stropu 2,5 m, hráč vysoký 1,6 m: hlava narazí ve výšce 0,9 m.
    const ceiling = body('obstacle', 0, { y: 2500, h: 500, w: 4000, d: 4000 });
    const w = v2World([ceiling], [{ id: 'touch', params: { role: 'obstacle', effect: 'score' } }]);
    const program = loadProgram(w, v2Library);
    const state = instantiate(w);
    step(state, { buttons: BUTTON.TAP, axis: 0 }, program);
    let peak = 0;
    for (let t = 0; t < 80; t += 1) {
      step(state, NO_INPUT, program);
      peak = Math.max(peak, state[P + BODY.y] as number);
    }
    expect(peak).toBe(900);
    expect(state[P + BODY.y]).toBe(0);
    expect(scoreOf(state)).toBeGreaterThan(0);
  });

  it('hráč na kinematické plošině se veze s ní', () => {
    const lift = body('platform', 0, { w: 4000, d: 4000, h: 500, solid: true, kinematic: true, vx: 20 });
    const state = run(v2World([lift], [], { start: { y: 500 } }), 100);
    expect(state[bodyBase(1) + BODY.x]).toBe(2000);
    expect(state[P + BODY.x]).toBe(2000);
    expect(state[P + BODY.y]).toBe(500);
  });

  it('kinematické tělo s periodou kyvadlově jezdí tam a zpět', () => {
    const shuttle = body('platform', 0, { w: 2000, d: 2000, h: 500, solid: true, kinematic: true, vz: 20, period: 50 });
    const state = run(v2World([{ ...shuttle, x: 5000 }]), 50);
    expect(state[bodyBase(1) + BODY.z]).toBe(1000);
    expect(state[bodyBase(1) + BODY.vz]).toBe(-20);
    for (let t = 0; t < 50; t += 1) step(state, NO_INPUT, loadProgram(v2World([{ ...shuttle, x: 5000 }]), v2Library));
    expect(state[bodyBase(1) + BODY.z]).toBe(0);
    expect(state[bodyBase(1) + BODY.vz]).toBe(20);
  });

  it('plošina jedoucí nahoru hráče zvedá, gravitace ji nestáhne', () => {
    const lift = body('platform', 0, { w: 4000, d: 4000, h: 500, solid: true, kinematic: true, gravity: true, vy: 10 });
    const state = run(v2World([lift], [], { start: { y: 500 } }), 50);
    expect(state[bodyBase(1) + BODY.y]).toBe(500);
    expect(state[P + BODY.y]).toBe(1000);
    expect((state[P + BODY.flags] as number) & FLAG.grounded).not.toBe(0);
  });

  it('spawn plní jen rezervu a mrtvé spawnuté sloty, přes mez se zahodí', () => {
    const template = body('projectile', 0, { template: true, solid: false, h: 300, w: 300, d: 300 });
    const coin = body('collectible', 3000, { solid: false });
    const w = v2World([template, coin], [{ id: 'spawner', params: { every: 10, template: 1 } }, { id: 'pickup', params: {} }], { spawnSlots: 3, vz: 100 });
    const program = loadProgram(w, v2Library);
    const state = instantiate(w);
    const capacity = (state.length - HEADER_SIZE) / BODY_STRIDE;
    expect(capacity).toBe(6);
    expect((state[bodyBase(1) + BODY.flags] as number) & FLAG.alive).toBe(0);
    // Mince sebraná v tiku ~25 uvolní slot úrovně – spawn ho nesmí vzít.
    for (let t = 0; t < 100; t += 1) step(state, NO_INPUT, program);
    expect((state[bodyBase(2) + BODY.flags] as number) & FLAG.alive).toBe(0);
    expect(state[bodyBase(2) + BODY.role]).toBe(ROLE.collectible);
    expect(state[HEADER.bodyCount]).toBe(capacity);
    for (let i = 3; i < capacity; i += 1) {
      const base = bodyBase(i);
      expect(state[base + BODY.role]).toBe(ROLE.projectile);
      expect((state[base + BODY.flags] as number) & FLAG.alive).not.toBe(0);
    }
    // Spawnuté tělo zanikne → další spawn jde do jeho slotu, počet neroste.
    state[bodyBase(4) + BODY.flags] = (state[bodyBase(4) + BODY.flags] as number) & ~FLAG.alive;
    for (let t = 0; t < 10; t += 1) step(state, NO_INPUT, program);
    expect(state[HEADER.bodyCount]).toBe(capacity);
    expect((state[bodyBase(4) + BODY.flags] as number) & FLAG.alive).not.toBe(0);
    expect(state[bodyBase(4) + BODY.z]).toBeLessThan(20_000);
  });

  it('respawn vrátí hráče na start, po checkpointu na checkpoint', () => {
    const spikes = body('hazard', 0, { x: 3000, h: 300, solid: false });
    const flag = body('checkpoint', 0, { x: 1500, h: 200, w: 200, solid: false });
    const rules = [
      { id: 'touch', params: { role: 'hazard', effect: 'respawn' } },
      { id: 'touch', params: { role: 'checkpoint', effect: 'checkpoint' } },
    ];
    // Bez checkpointu (vlajka mimo cestu): zpět na start.
    const plain = v2World([spikes, { ...flag, z: 9000 }], rules);
    const program = loadProgram(plain, v2Library);
    const state = instantiate(plain);
    let back = -1;
    for (let t = 0; t < 40 && back < 0; t += 1) {
      step(state, { buttons: 0, axis: 100 }, program);
      if (state[P + BODY.x] === 0) back = t;
    }
    expect(back).toBeGreaterThan(20);
    expect(state[P + BODY.vx]).toBe(0);

    // Přes vlajku: zpět na její horní hranu.
    const saved = v2World([spikes, flag], rules);
    const program2 = loadProgram(saved, v2Library);
    const state2 = instantiate(saved);
    let respawned = false;
    for (let t = 0; t < 40 && !respawned; t += 1) {
      const x = state2[P + BODY.x] as number;
      step(state2, { buttons: 0, axis: 100 }, program2);
      respawned = (state2[P + BODY.x] as number) < x;
    }
    expect(respawned).toBe(true);
    expect(state2[P + BODY.x]).toBe(1500);
    expect(state2[P + BODY.y]).toBe(200);
  });

  it('hra uložená pod arcade-v1 se načte ve v2 rozložení', () => {
    const w = world([body('obstacle', 3000), body('collectible', 5000, { solid: false })], { health: 3 });
    // v1 = hlavička bez spawnBase a místa návratu (sloty 4–7).
    const v1 = [...w.initial.slice(0, 4), ...w.initial.slice(HEADER.counters)];
    const upgraded = instantiate({ ...w, runtimeVersion: 'arcade-v1' as never, initial: v1 });
    expect(Array.from(upgraded)).toEqual(Array.from(instantiate(w)));

    // Počet těl je uložené číslo: vadný záznam musí spadnout na kontrole,
    // ne si podle něj nejdřív vyžádat pole.
    const forged = [...v1];
    forged[HEADER.bodyCount] = 2 ** 28;
    expect(() => instantiate({ ...w, runtimeVersion: 'arcade-v1' as never, initial: forged })).toThrow(/malformed initial state/);
  });

  it('stejný záznam dá stejný hash i s plošinami, spawnem a respawnem (200 záznamů)', () => {
    const w = v2World(
      [
        body('platform', 4000, { w: 3000, d: 3000, h: 500, solid: true, kinematic: true, vx: 15 }),
        body('obstacle', 9000, { x: 1500, h: 1200 }),
        body('obstacle', 12000, { x: -1500, y: 2200, h: 400 }),
        body('hazard', 15000, { h: 300, solid: false }),
        body('checkpoint', 7000, { w: 4000, h: 200, solid: false }),
        body('projectile', 0, { template: true, solid: true, h: 400, w: 400, d: 400 }),
      ],
      [
        { id: 'touch', params: { role: 'hazard', effect: 'respawn' } },
        { id: 'touch', params: { role: 'checkpoint', effect: 'checkpoint' } },
        { id: 'spawner', params: { every: 45, template: 6 } },
      ],
      { vz: 60, spawnSlots: 8 },
    );
    const rng = xoroshiro128plus(20260923);
    const hashes = new Set<string>();
    for (let r = 0; r < 200; r += 1) {
      const inputs: InputEvent[] = [];
      for (let tick = 0; tick < 400; tick += 1) {
        if (uniformInt(rng, 0, 7) !== 0) continue;
        inputs.push({ tick, buttons: uniformInt(rng, 0, 1) === 0 ? BUTTON.TAP : 0, axis: uniformInt(rng, -120, 120) });
      }
      const first = replay(w, inputs, v2Library, 600);
      expect(replay(w, inputs, v2Library, 600)).toEqual(first);
      hashes.add(first.hash);
    }
    expect(hashes.size).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// Projektil (P25G)

const shotParams = z.object({ every: z.int().min(1), template: z.int(), vy: z.int(), vz: z.int() }).strict();
/** Každých `every` tiků (od tiku 0) vystřelí kopii předlohy z hráče ve výšce 1 m. */
const shot: RulePiece<z.infer<typeof shotParams>> = {
  id: 'shot',
  params: shotParams,
  roles: ['projectile'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params): readonly ArcadeEffect[] => {
    if ((state[HEADER.tick] as number) % params.every !== 0) return [];
    const base = bodyBase(player);
    return [{ kind: 'spawn', template: params.template, x: state[base + BODY.x] as number, y: 1000, z: state[base + BODY.z] as number, vx: 0, vy: params.vy, vz: params.vz }];
  },
};

/** Zásah terče = bod a terč zmizí; konec bez zásahu = „životy“ −1 (počítadlo minutí). */
const struck: RulePiece<Record<string, never>> = {
  id: 'struck',
  params: z.object({}).strict(),
  roles: ['projectile', 'target'],
  trigger: 'hit',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, other, source }): readonly ArcadeEffect[] => {
    expect(state[bodyBase(source) + BODY.role]).toBe(ROLE.projectile);
    if (other < 0) return [{ kind: 'damage', amount: 1 }];
    return state[bodyBase(other) + BODY.role] === ROLE.target
      ? [
          { kind: 'score', amount: 1 },
          { kind: 'despawn', body: other },
        ]
      : [];
  },
};

const shotLibrary: ArcadeLibrary = { ...v2Library, rules: { ...v2Library.rules, shot, struck } };
const bullet = (extra: Partial<BodyInit> = {}): BodyInit => body('projectile', 0, { template: true, solid: false, w: 200, h: 200, d: 200, ...extra });

function shotWorld(bodies: readonly BodyInit[], fire: z.infer<typeof shotParams>, spawnSlots = 8) {
  const built = buildWorld(
    {
      seed: 1,
      control: { id: 'move', params: { vz: 0 } },
      rules: [
        { id: 'shot', params: fire },
        { id: 'struck', params: {} },
      ],
      bot: { id: 'idle', params: {} },
      level: { bodies: [player, ...bodies], length: 0, spawnSlots },
    },
    shotLibrary,
  );
  if (!built.ok) throw new Error(built.issues.join('; '));
  return built.world;
}

const missesOf = (state: Int32Array): number => 0 - (state[HEADER.counters + COUNTER.health] as number);
const aliveAt = (state: Int32Array, index: number): boolean => ((state[bodyBase(index) + BODY.flags] as number) & FLAG.alive) !== 0;

describe('projektil v jádře', () => {
  it('let s gravitací je parabola, dopad bez odrazu ho ukončí jako minutí', () => {
    // Výstřel v tiku 0 (spawn na konci tiku), první integrace v tiku 1.
    const w = shotWorld([bullet({ gravity: true })], { every: 10_000, template: 1, vy: 120, vz: 150 });
    const program = loadProgram(w, shotLibrary);
    const state = instantiate(w);
    step(state, NO_INPUT, program);
    const slot = 2;
    expect(aliveAt(state, slot)).toBe(true);
    let y = 1000;
    let vy = 120;
    let landed = -1;
    for (let t = 1; t < 200 && landed < 0; t += 1) {
      step(state, NO_INPUT, program);
      vy -= 8;
      y += vy;
      if (!aliveAt(state, slot)) landed = t;
      else {
        expect(state[bodyBase(slot) + BODY.y]).toBe(y);
        expect(state[bodyBase(slot) + BODY.z]).toBe(150 * t);
      }
    }
    // y(t) = 1000 + 120t − 4t(t+1) ≤ 0 poprvé v t = 36.
    expect(landed).toBe(36);
    expect(missesOf(state)).toBe(1);
    expect(replay(w, [], shotLibrary, 120)).toEqual(replay(w, [], shotLibrary, 120));
  });

  it('životnost končí despawnem přesně po stanovených ticích', () => {
    const w = shotWorld([bullet({ lifetime: 30 })], { every: 10_000, template: 1, vy: 0, vz: 100 });
    const program = loadProgram(w, shotLibrary);
    const state = instantiate(w);
    step(state, NO_INPUT, program);
    for (let t = 1; t < 30; t += 1) step(state, NO_INPUT, program);
    expect(aliveAt(state, 2)).toBe(true);
    expect(missesOf(state)).toBe(0);
    step(state, NO_INPUT, program);
    expect(aliveAt(state, 2)).toBe(false);
    expect(state[bodyBase(2) + BODY.z]).toBe(3000);
    expect(missesOf(state)).toBe(1);
  });

  it('zásah terče spustí pravidlo, projektil i terč zmizí; tenký terč rychlá střela nepropadne', () => {
    const target = body('target', 5000, { y: 500, w: 1000, h: 1000, d: 50, solid: false });
    const w = shotWorld([bullet({ d: 50 }), target], { every: 10_000, template: 1, vy: 0, vz: 700 });
    const state = run2(w, 20);
    expect(scoreOf(state)).toBe(1);
    expect(aliveAt(state, 2)).toBe(false);
    expect(aliveAt(state, 3)).toBe(false);
    expect(missesOf(state)).toBe(0);
  });

  it('pevné tělo střelu zastaví bez bodu, netečné tělo propustí', () => {
    const wall = body('obstacle', 3000, { w: 3000, h: 3000 });
    const coin = body('collectible', 1500, { y: 800, solid: false });
    const w = shotWorld([bullet(), coin, wall], { every: 10_000, template: 1, vy: 0, vz: 200 });
    const state = run2(w, 30);
    expect(aliveAt(state, 2)).toBe(true);
    expect(aliveAt(state, 3)).toBe(true);
    expect(aliveAt(state, 4)).toBe(false);
    expect(state[bodyBase(4) + BODY.z]).toBeLessThanOrEqual(3000);
    expect(scoreOf(state)).toBe(0);
  });

  it('odraz: vyskočí zmenšenou rychlostí a po pár dopadech skončí', () => {
    const w = shotWorld([bullet({ gravity: true, bounce: 600 })], { every: 10_000, template: 1, vy: 0, vz: 60 });
    const program = loadProgram(w, shotLibrary);
    const state = instantiate(w);
    let bounces = 0;
    let end = -1;
    let prevVy = 0;
    for (let t = 0; t < 400 && end < 0; t += 1) {
      step(state, NO_INPUT, program);
      if (!aliveAt(state, 2)) {
        if (t > 0) end = t;
        continue;
      }
      const vy = state[bodyBase(2) + BODY.vy] as number;
      if (vy > 0 && prevVy < 0) {
        bounces += 1;
        expect(state[bodyBase(2) + BODY.y]).toBe(0);
        expect(vy).toBe(Math.trunc((-(prevVy - 8) * 600) / 1000));
      }
      prevVy = vy;
    }
    expect(bounces).toBeGreaterThanOrEqual(2);
    expect(end).toBeGreaterThan(0);
    expect(missesOf(state)).toBe(1);
  });

  it('strop těl zahodí další střelu, po zániku se slot znovu použije', () => {
    const w = shotWorld([bullet({ lifetime: 100 })], { every: 5, template: 1, vy: 0, vz: 10 }, 3);
    const program = loadProgram(w, shotLibrary);
    const state = instantiate(w);
    const capacity = (state.length - HEADER_SIZE) / BODY_STRIDE;
    expect(capacity).toBe(5);
    for (let t = 0; t < 60; t += 1) step(state, NO_INPUT, program);
    // 12 výstřelů, místo jen pro 3.
    expect(state[HEADER.bodyCount]).toBe(capacity);
    const aliveCount = (): number => [2, 3, 4].filter((i) => aliveAt(state, i)).length;
    expect(aliveCount()).toBe(3);
    for (let t = 60; t < 101; t += 1) step(state, NO_INPUT, program);
    // První střela (tik 0) dohasla v tiku 100, další výstřel v tiku 100 vzal její slot.
    expect(missesOf(state)).toBe(1);
    expect(aliveCount()).toBe(3);
    expect(state[bodyBase(2) + BODY.aux1]).toBe(100);
    expect(state[HEADER.bodyCount]).toBe(capacity);
  });

  it('palba každý tik celých 90 s skončí v mezích, stejně dvakrát', () => {
    const w = shotWorld([bullet({ gravity: true, bounce: 900 }), body('target', 20_000, { solid: true, kinematic: true, vx: 30, period: 90 })], { every: 1, template: 1, vy: 90, vz: 120 }, ARCADE_LIMITS.maxBodies - 3);
    const first = replay(w, [], shotLibrary);
    expect(first.tick).toBe(ARCADE_LIMITS.maxTicks);
    expect(replay(w, [], shotLibrary)).toEqual(first);
    const state = instantiate(w);
    const program = loadProgram(w, shotLibrary);
    for (let t = 0; t < ARCADE_LIMITS.maxTicks; t += 1) step(state, NO_INPUT, program);
    expect(state[HEADER.bodyCount]).toBeLessThanOrEqual(ARCADE_LIMITS.maxBodies);
    for (let i = 3; i < (state[HEADER.bodyCount] as number); i += 1) {
      const life = state[bodyBase(i) + BODY.aux1] as number;
      expect(life).toBeGreaterThanOrEqual(0);
      expect(life).toBeLessThanOrEqual(PROJECTILE_LIFETIME);
    }
  });

  it('úroveň nastaví počáteční čítače, efekt count k nim přičte', () => {
    const counting: RulePiece<Record<string, never>> = {
      id: 'counting',
      params: z.object({}).strict(),
      roles: [],
      trigger: 'tick',
      cost: () => ({ bodies: 0, rules: 1 }),
      fire: () => [
        { kind: 'count', counter: 'ammo', amount: -1 },
        { kind: 'count', counter: 'cooldown', amount: 2 },
      ],
    };
    const lib: ArcadeLibrary = { ...shotLibrary, rules: { ...shotLibrary.rules, counting } };
    const built = buildWorld(
      { seed: 1, control: { id: 'move', params: { vz: 0 } }, rules: [{ id: 'counting', params: {} }], bot: { id: 'idle', params: {} }, level: { bodies: [player], length: 0, counters: { ammo: 10, reserve: 7 } }, health: 3 },
      lib,
    );
    if (!built.ok) throw new Error(built.issues.join('; '));
    const state = instantiate(built.world);
    expect([COUNTER.ammo, COUNTER.reserve, COUNTER.health].map((c) => state[HEADER.counters + c])).toEqual([10, 7, 3]);
    const program = loadProgram(built.world, lib);
    for (let t = 0; t < 4; t += 1) step(state, NO_INPUT, program);
    expect(state[HEADER.counters + COUNTER.ammo]).toBe(6);
    expect(state[HEADER.counters + COUNTER.cooldown]).toBe(8);
    expect(state[HEADER.counters + COUNTER.reserve]).toBe(7);
  });

  it('buildWorld odmítne nekonečný nebo nesmyslný projektil', () => {
    const issuesOf = (extra: Partial<BodyInit>, role: BodyInit['role'] = 'projectile'): readonly string[] => {
      const built = buildWorld(
        { seed: 1, control: { id: 'move', params: { vz: 0 } }, rules: [], bot: { id: 'idle', params: {} }, level: { bodies: [player, body(role, 0, extra)], length: 0 } },
        shotLibrary,
      );
      return built.ok ? [] : built.issues;
    };
    expect(issuesOf({ lifetime: 0 })).toHaveLength(1);
    expect(issuesOf({ lifetime: ARCADE_LIMITS.maxTicks + 1 })).toHaveLength(1);
    expect(issuesOf({ lifetime: 1.5 })).toHaveLength(1);
    expect(issuesOf({ bounce: 1001 })).toHaveLength(1);
    expect(issuesOf({ bounce: -1 })).toHaveLength(1);
    expect(issuesOf({ kinematic: true })).toHaveLength(1);
    expect(issuesOf({ lifetime: 10 }, 'target')).toHaveLength(1);
    expect(issuesOf({ lifetime: ARCADE_LIMITS.maxTicks, bounce: 1000 })).toEqual([]);
    expect(issuesOf({})).toEqual([]);
  });
});

function run2(w: ReturnType<typeof shotWorld>, ticks: number) {
  const program = loadProgram(w, shotLibrary);
  const state = instantiate(w);
  for (let t = 0; t < ticks; t += 1) step(state, NO_INPUT, program);
  return state;
}
