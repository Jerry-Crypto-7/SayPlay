/**
 * Úkol – režimy `quest_spatial` a `quest_station` (P32G T2).
 *
 * Oba hrají na ovládání `move_free` a cíle mění stav pravidlem `interact`
 * (`rules/interact.ts`): hráč dojde k cíli, drží „Use“ a stav 0..2 v `flags`
 * těla (`targetStateOf`) se posune. Výhru vydá pravidlo, až jsou všechny cíle
 * v konečném stavu; prohru skládá svět zvenku – časovač specu (`timer`,
 * `arcade/compile.ts`) a v prostoru chycení pronásledovatelem (`arena_eat`).
 *
 * - **V prostoru:** 1–8 cílů po aréně 40 × 40 m, pevné kameny mezi nimi a
 *   volitelní pronásledovatelé. Pronásledovatel je buňka arény větší než hráč –
 *   `move_free` ho vede na hráče rychlostí `ARENA.hunterSpeed` (40 % hráčovy)
 *   a `arena_eat` dotek počítá jako chycení. **Férový start:** stojí tak daleko,
 *   že nečinného hráče nedostihne dřív než za `QUEST.idleContactTicks` (4 s,
 *   tedy i celé 2 s ochrany na startu). Zpomalení, dokud hráč drží „Use“,
 *   `move_free` neumí – požadavek v plánu P32G.
 * - **Na místě:** 1–3 stanoviště v řadě na pultu před hrdinou (palačinky na
 *   sporáku, díly na stole), v pořadí zleva. Krok ze stavu 1 dál jde jen v okně
 *   připravenosti (`ready`): nalít (držet), počkat, obrátit, až je zlatá.
 *   Pult přes celou šířku drží hrdinu za ním.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import { ARCADE_HZ, type ArcadeLevel, type BodyInit, type ModeGeneratorPiece, type ModeParts, type PieceRef, ROLE, UNIT } from '../contract';
import type { CompiledRule } from '../rules/compile';
import type { CompiledInteract } from '../rules/interact';
import { verbSchema } from '../rules/schema';
import { ARENA } from './arena';

export const QUEST = {
  /** Dosah „Use“: mezera mezi obrysy hráče a cíle. */
  radius: UNIT,
  /** Délka držení, když ji spec neříká: 0,75 s na krok. */
  hold: 45,
  // V prostoru
  half: ARENA.half,
  target: { w: 800, h: 1200, d: 800 },
  /** Cíle leží v mezikruží kolem startu, aspoň `targetSpacing` od sebe a `wallClearance` od stěny. */
  targetRing: [4 * UNIT, 15 * UNIT] as const,
  targetSpacing: 4 * UNIT,
  wallClearance: 2 * UNIT,
  rock: { w: 1600, h: 1200, d: 1600 },
  /** Kámen stojí aspoň tak daleko od startu, od cíle (místo, odkud se „Use“ dosáhne, zůstane volné) a od jiného kamene. */
  rockClearance: { start: 3 * UNIT, target: 3500, rock: 3 * UNIT },
  chaser: { w: 1400, h: 1600 },
  /** Nečinného hráče první pronásledovatel nedostihne dřív (test T2). */
  idleContactTicks: 4 * ARCADE_HZ,
  /** Pronásledovatelé od sebe a od cíle. */
  chaserSpacing: 6 * UNIT,
  chaserTargetClearance: 3 * UNIT,
  // Na místě
  stationHalf: 5 * UNIT,
  stationSpacing: 2 * UNIT,
  counter: { z: UNIT, h: 900, d: 800 },
  station: { w: 600, h: 300, d: 600 },
  /** Peče se 1,5 s, pak je 1 s zlatá; minutou chvíli se peče znovu. */
  ready: { after: 90, window: 60 },
} as const;

/** Tolik pokusů má každé náhodné umístění, pak generátor úroveň odmítne. */
const ATTEMPTS = 200;

const states = z.union([z.literal(2), z.literal(3)]);
const hold = z.int().min(0).max(5 * ARCADE_HZ);

const spatialParams = z
  .object({
    count: z.int().min(1).max(8).default(5),
    states: states.default(2),
    hold: hold.default(QUEST.hold),
    chasers: z.int().min(0).max(4).default(0),
    rocks: z.int().min(0).max(6).default(3),
    verb: verbSchema.default('use'),
    /** Délku kola nese časovač specu; generátor ji jen přijme z `controlParams` arény. */
    seconds: z.int().min(20).max(80).optional(),
  })
  .strict();
export type QuestSpatialParams = z.infer<typeof spatialParams>;

const stationParams = z
  .object({
    count: z.int().min(1).max(3).default(2),
    states: states.default(3),
    hold: hold.default(30),
    after: z.int().min(1).max(10 * ARCADE_HZ).default(QUEST.ready.after),
    window: z.int().min(ARCADE_HZ / 2).max(10 * ARCADE_HZ).default(QUEST.ready.window),
    verb: verbSchema.default('use'),
    seconds: z.int().min(20).max(80).optional(),
  })
  .strict();
export type QuestStationParams = z.infer<typeof stationParams>;

const PLAYER = (x: number, zz: number): BodyInit => ({ role: 'player', kind: 'player', x, y: 0, z: zz, w: ARENA.startSize, h: ARENA.height, d: ARENA.startSize, solid: false });

/** Chebyševova vzdálenost středů – obrysy se překryjí, až klesne pod součet polovin. */
const cheb = (a: { readonly x: number; readonly z: number }, b: { readonly x: number; readonly z: number }): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.z - b.z));

/**
 * Jak daleko (Chebyševovsky) musí pronásledovatel startovat, aby nečinného
 * hráče nedostihl dřív než za `idleContactTicks`: za tik se v každé ose přiblíží
 * nejvýš o `hunterSpeed`.
 */
export const chaserStartDistance = (): number => QUEST.idleContactTicks * ARENA.hunterSpeed + Math.ceil((QUEST.chaser.w + ARENA.startSize) / 2) + UNIT / 2;

// ---------------------------------------------------------------------------
// V prostoru

function spatialLevel(seed: number, params: QuestSpatialParams): { level: ArcadeLevel; issues: string[] } {
  const rng = createCompileRng(seed);
  const issues: string[] = [];
  const bodies: BodyInit[] = [PLAYER(0, 0)];
  const start = { x: 0, z: 0 };
  const edge = QUEST.half - QUEST.wallClearance;
  const place = (what: string, fits: (at: { x: number; z: number }) => boolean, pick: () => { x: number; z: number }): { x: number; z: number } | null => {
    for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
      const at = pick();
      if (fits(at)) return at;
    }
    issues.push(`no room for ${what}`);
    return null;
  };
  const pickIn = (limit: number) => () => ({ x: rng.int(-limit, limit), z: rng.int(-limit, limit) });

  const targets: { x: number; z: number }[] = [];
  for (let k = 0; k < params.count; k += 1) {
    const at = place(
      `target ${k + 1}`,
      (p) => {
        const r = Math.hypot(p.x, p.z);
        return r >= QUEST.targetRing[0] && r <= QUEST.targetRing[1] && targets.every((t) => Math.hypot(t.x - p.x, t.z - p.z) >= QUEST.targetSpacing);
      },
      pickIn(edge),
    );
    if (at !== null) targets.push(at);
  }
  for (const t of targets) bodies.push({ role: 'target', kind: 'target', x: t.x, y: 0, z: t.z, ...QUEST.target, solid: false });

  const rocks: { x: number; z: number }[] = [];
  for (let k = 0; k < params.rocks; k += 1) {
    const at = place(
      `rock ${k + 1}`,
      (p) =>
        Math.hypot(p.x - start.x, p.z - start.z) >= QUEST.rockClearance.start &&
        targets.every((t) => Math.hypot(t.x - p.x, t.z - p.z) >= QUEST.rockClearance.target) &&
        rocks.every((r) => Math.hypot(r.x - p.x, r.z - p.z) >= QUEST.rockClearance.rock),
      pickIn(edge),
    );
    if (at !== null) rocks.push(at);
  }
  for (const r of rocks) bodies.push({ role: 'obstacle', kind: 'rock', x: r.x, y: 0, z: r.z, ...QUEST.rock, solid: true });

  const far = chaserStartDistance();
  const chasers: { x: number; z: number }[] = [];
  for (let k = 0; k < params.chasers; k += 1) {
    const at = place(
      `chaser ${k + 1}`,
      (p) =>
        cheb(p, start) >= far &&
        chasers.every((c) => Math.hypot(c.x - p.x, c.z - p.z) >= QUEST.chaserSpacing) &&
        targets.every((t) => Math.hypot(t.x - p.x, t.z - p.z) >= QUEST.chaserTargetClearance),
      pickIn(QUEST.half - QUEST.chaser.w / 2),
    );
    if (at !== null) chasers.push(at);
  }
  for (const c of chasers) bodies.push({ role: 'enemy', kind: 'chaser', x: c.x, y: 0, z: c.z, w: QUEST.chaser.w, h: QUEST.chaser.h, d: QUEST.chaser.w, solid: false, kinematic: true });
  return { level: { bodies, length: 0 }, issues: [...issues, ...checkQuestLevel({ bodies, length: 0 }, QUEST.half)] };
}

/** Tvrzení „hratelné z konstrukce“ nad hotovou úrovní; prázdné pole = hratelná. */
export function checkQuestLevel(level: ArcadeLevel, half: number): string[] {
  const issues: string[] = [];
  const player = level.bodies[0];
  if (player === undefined || player.role !== 'player') return ['no player'];
  if (!level.bodies.some((body) => body.role === 'target')) issues.push('no target to work on');
  for (const body of level.bodies) {
    if (Math.abs(body.x) + body.w / 2 > half || Math.abs(body.z) + body.d / 2 > half) issues.push(`a ${body.kind} at ${body.x}, ${body.z} sits outside the arena`);
  }
  const contact = Math.ceil((QUEST.chaser.w + player.w) / 2);
  for (const chaser of level.bodies.filter((body) => body.role === 'enemy')) {
    const ticks = Math.floor((cheb(chaser, player) - contact) / ARENA.hunterSpeed);
    if (ticks < QUEST.idleContactTicks) issues.push(`a chaser reaches the idle player in ${ticks} ticks, before ${QUEST.idleContactTicks}`);
    if (chaser.w <= player.w) issues.push('a chaser no bigger than the player would not chase');
  }
  return issues;
}

// ---------------------------------------------------------------------------
// Na místě

function stationLevel(params: QuestStationParams): ArcadeLevel {
  const { counter, station, stationHalf, stationSpacing } = QUEST;
  const bodies: BodyInit[] = [PLAYER(0, 0)];
  // Pult přes celou šířku: hrdina zůstane za ním a chodí podél.
  bodies.push({ role: 'obstacle', kind: 'counter', x: 0, y: 0, z: counter.z, w: 2 * stationHalf, h: counter.h, d: counter.d, solid: true });
  for (let k = 0; k < params.count; k += 1) {
    const x = Math.round((k - (params.count - 1) / 2) * stationSpacing);
    bodies.push({ role: 'target', kind: 'target', x, y: counter.h, z: counter.z, ...station, solid: false });
  }
  return { bodies, length: 0 };
}

// ---------------------------------------------------------------------------
// Díly režimů

const interactRule = (verb: string, interact: CompiledInteract): PieceRef => {
  const params: CompiledRule = { id: 'quest', verb, when: { interact }, if: [], do: [] };
  return { id: 'interact', params };
};

function questParts(level: ArcadeLevel, half: number, verb: string, interact: CompiledInteract, catchRules: PieceRef[], issues: readonly string[]): ModeParts {
  return {
    control: { id: 'move_free', params: { half } },
    bot: { id: 'quest_bot', params: { half, interact } },
    level,
    rules: [interactRule(verb, interact), ...catchRules],
    ...(issues.length > 0 ? { issues } : {}),
  };
}

export const questSpatial: ModeGeneratorPiece<QuestSpatialParams> = {
  id: 'quest_spatial',
  params: spatialParams,
  roles: ['player', 'target', 'obstacle', 'enemy'],
  cost: (params) => ({ bodies: 1 + params.count + params.rocks + params.chasers, rules: 1 + (params.chasers > 0 ? 1 : 0) }),
  generate: (seed, params) => spatialLevel(seed, params).level,
  parts: (seed, params, health) => {
    const { level, issues } = spatialLevel(seed, params);
    const interact: CompiledInteract = { role: ROLE.target, radius: QUEST.radius, hold: params.hold, states: params.states };
    // Chycení: dotek větší buňky arény – prohra, se životy ztráta života a návrat na start.
    const catches: PieceRef[] =
      params.chasers === 0 ? [] : [{ id: 'arena_eat', params: { effect: health === undefined ? 'lose' : 'damage' } }, ...(health === undefined ? [] : [{ id: 'out_of_health', params: {} }])];
    return questParts(level, QUEST.half, params.verb, interact, catches, issues);
  },
};

export const questStation: ModeGeneratorPiece<QuestStationParams> = {
  id: 'quest_station',
  params: stationParams,
  roles: ['player', 'target', 'obstacle'],
  cost: (params) => ({ bodies: 2 + params.count, rules: 1 }),
  generate: (_seed, params) => stationLevel(params),
  parts: (_seed, params) => {
    const interact: CompiledInteract = {
      role: ROLE.target,
      radius: QUEST.radius,
      hold: params.hold,
      states: params.states,
      order: true,
      ready: { after: params.after, window: params.window },
    };
    return questParts(stationLevel(params), QUEST.stationHalf, params.verb, interact, [], []);
  },
};
