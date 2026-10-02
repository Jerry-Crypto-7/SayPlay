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
 *   volitelní pronásledovatelé útěku P32E (role `chaser`, scéna je kreslí
 *   modelem pronásledovatele – duchy čaroděje): `move_free` s `chase` je vede
 *   rychlostí `chaserSpeed` (40 % hráčovy) a `arena_eat` s `grace` dotek počítá
 *   jako chycení. **Férový start** jako v útěku: za zády hráče, aspoň 40 %
 *   poloviny strany daleko, celé 2 s ochrany stojí, nečinného hráče nedostihnou
 *   dřív než za 5 s. Zpomalení, dokud hráč drží „Use“, `move_free` neumí –
 *   požadavek v plánu P32G.
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
import { ARENA, type ChaseParams, DIRECTIONS, ESCAPE, GRACE_COUNTER, checkEscapeLevel, fairReach } from './arena';

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
  /** 40 % hráčovy rychlosti, jako lovec arény; útěk P32E má výchozích 70. */
  chaserSpeed: 60,
  /** Nečinného hráče první pronásledovatel nedostihne dřív (AC T2; útěk sám drží 5 s). */
  idleContactTicks: 4 * ARCADE_HZ,
  /** Pronásledovatel od jiného (útěk: dva směry po 11,25° na férové vzdálenosti, ~5 m), od cíle a od kamene. */
  chaserSpacing: 4 * UNIT,
  chaserTargetClearance: 3 * UNIT,
  chaserRockClearance: 3 * UNIT,
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
    chasers: z.int().min(0).max(ESCAPE.chasers.max).default(0),
    chaserSpeed: z.int().min(ESCAPE.chaserSpeed.min).max(ESCAPE.chaserSpeed.max).default(QUEST.chaserSpeed),
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

const CHASER = { w: ESCAPE.chaserSize, d: ESCAPE.chaserSize } as const;

/** Nejbližší férový start pronásledovatele útěku: 40 % poloviny strany, nebo 5 s pro nečinného hráče – co je dál. */
export const chaserStartDistance = (speed: number): number => Math.max((QUEST.half * ESCAPE.minDistancePct) / 100, fairReach(speed, PLAYER(0, 0), CHASER)) + ESCAPE.distanceMargin;

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
  const clear = (p: { x: number; z: number }, others: readonly { x: number; z: number }[], gap: number): boolean => others.every((o) => Math.hypot(o.x - p.x, o.z - p.z) >= gap);

  // Pronásledovatelé první – za zády hráče (směry 16 ± `backArc`, −z) je místa málo; cíle a kameny se jim vyhnou.
  const far = chaserStartDistance(params.chaserSpeed);
  const chasers: { x: number; z: number }[] = [];
  for (let k = 0; k < params.chasers; k += 1) {
    const at = place(
      `chaser ${k + 1}`,
      (p) => clear(p, chasers, QUEST.chaserSpacing),
      () => {
        const dir = DIRECTIONS[16 + rng.int(-ESCAPE.backArc, ESCAPE.backArc)]!;
        const reach = far + rng.int(0, ESCAPE.distanceJitter);
        return { x: Math.trunc((dir.dx * reach) / 1000), z: Math.trunc((dir.dz * reach) / 1000) };
      },
    );
    if (at !== null) chasers.push(at);
  }

  const targets: { x: number; z: number }[] = [];
  for (let k = 0; k < params.count; k += 1) {
    const at = place(
      `target ${k + 1}`,
      (p) => {
        const r = Math.hypot(p.x, p.z);
        return r >= QUEST.targetRing[0] && r <= QUEST.targetRing[1] && clear(p, targets, QUEST.targetSpacing) && clear(p, chasers, QUEST.chaserTargetClearance);
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
        clear(p, [start], QUEST.rockClearance.start) &&
        clear(p, targets, QUEST.rockClearance.target) &&
        clear(p, rocks, QUEST.rockClearance.rock) &&
        clear(p, chasers, QUEST.chaserRockClearance),
      pickIn(edge),
    );
    if (at !== null) rocks.push(at);
  }
  for (const r of rocks) bodies.push({ role: 'obstacle', kind: 'rock', x: r.x, y: 0, z: r.z, ...QUEST.rock, solid: true });
  for (const c of chasers) bodies.push({ role: 'chaser', kind: 'chaser', x: c.x, y: 0, z: c.z, ...CHASER, h: ESCAPE.chaserHeight, solid: false, kinematic: true });
  const level: ArcadeLevel = chasers.length === 0 ? { bodies, length: 0 } : { bodies, length: 0, counters: { [GRACE_COUNTER]: ESCAPE.graceTicks } };
  return { level, issues: [...issues, ...checkQuestLevel(level, params.chaserSpeed)] };
}

/** Tvrzení „hratelné z konstrukce“ nad hotovou úrovní; prázdné pole = hratelná. Pronásledovatele soudí jako útěk. */
export function checkQuestLevel(level: ArcadeLevel, chaserSpeed: number): string[] {
  const issues = checkEscapeLevel(level, { items: 0, chaserSpeed });
  if (!level.bodies.some((body) => body.role === 'target')) issues.push('no target to work on');
  if (level.bodies.some((body) => body.role === 'chaser') && level.counters?.[GRACE_COUNTER] !== ESCAPE.graceTicks) issues.push('chasers without the 2 s start grace');
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

/** Hráč má pevnou velikost jako v útěku: skóre z `do` pravidla ho nezvětší. */
function questParts(level: ArcadeLevel, half: number, verb: string, interact: CompiledInteract, chase: ChaseParams | undefined, catchRules: PieceRef[], issues: readonly string[]): ModeParts {
  const moving = { half, size: ESCAPE.playerSize, ...(chase === undefined ? {} : { chase }) };
  return {
    control: { id: 'move_free', params: moving },
    bot: { id: 'quest_bot', params: { half, interact, ...(chase === undefined ? {} : { chase }) } },
    level,
    rules: [interactRule(verb, interact), ...catchRules],
    ...(issues.length > 0 ? { issues } : {}),
  };
}

/**
 * Životy úkolu (P36A T2): hra žánru začíná se třemi; bez pronásledovatelů je
 * dnes nic nebere – nebezpečí úkolu přidá T3. Pravidlo prohry ale svět nese
 * vždy, ať jde život i živě přidat (`live.ts`).
 */
const livesRules = (health: number | undefined): PieceRef[] => (health === undefined ? [] : [{ id: 'out_of_health', params: {} }]);

export const questSpatial: ModeGeneratorPiece<QuestSpatialParams> = {
  id: 'quest_spatial',
  params: spatialParams,
  roles: ['player', 'target', 'obstacle', 'chaser'],
  cost: (params) => ({ bodies: 1 + params.count + params.rocks + params.chasers, rules: 1 + (params.chasers > 0 ? 1 : 0) }),
  generate: (seed, params) => spatialLevel(seed, params).level,
  parts: (seed, params, health) => {
    const { level, issues } = spatialLevel(seed, params);
    const interact: CompiledInteract = { role: ROLE.target, radius: QUEST.radius, hold: params.hold, states: params.states };
    // Kdo drží „Use“, stojí u cíle: pronásledovatelé zatím běží poloviční rychlostí (G-R1).
    const chase: ChaseParams | undefined = params.chasers === 0 ? undefined : { speed: params.chaserSpeed, lead: ESCAPE.lead, slowWhileUse: true };
    // Chycení jako v útěku: mimo ochranu prohra, se životy ztráta života, nová ochrana a odhoz (P36A T2).
    const catches: PieceRef[] =
      chase === undefined
        ? []
        : [{ id: 'arena_eat', params: health === undefined ? { effect: 'lose', grace: ESCAPE.graceTicks } : { effect: 'damage', grace: ESCAPE.graceTicks, knockback: ESCAPE.knockback } }];
    return questParts(level, QUEST.half, params.verb, interact, chase, [...catches, ...livesRules(health)], issues);
  },
};

export const questStation: ModeGeneratorPiece<QuestStationParams> = {
  id: 'quest_station',
  params: stationParams,
  roles: ['player', 'target', 'obstacle'],
  cost: (params) => ({ bodies: 2 + params.count, rules: 1 }),
  generate: (_seed, params) => stationLevel(params),
  parts: (_seed, params, health) => {
    const interact: CompiledInteract = {
      role: ROLE.target,
      radius: QUEST.radius,
      hold: params.hold,
      states: params.states,
      order: true,
      ready: { after: params.after, window: params.window },
    };
    return questParts(stationLevel(params), QUEST.stationHalf, params.verb, interact, undefined, livesRules(health), []);
  },
};
