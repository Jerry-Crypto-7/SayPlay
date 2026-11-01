/**
 * Střelnice z očí na kolejích (P68-F T2, kategorie `prvni-osoba`). Hráč stojí v počátku a dívá se po +z; mezi vlnami
 * ho kolej poveze dál (jen kamera scény, ne stav). Rozhlíží se **jen vodorovně po 9 sektorech** a ťukem střílí: osa
 * nastaví cílový sektor, natočení k němu jde o krok za tik a rána padne, až natočení dorazí (západka spouště).
 * Zásah je po sektorech (hitscan): rána do sektoru srazí nejbližší živý terč nebo nepřítele v něm. Výška terčů
 * (`HEIGHT_ROWS`) je jen pro oko – kamera bez naklánění ukáže všechny řádky.
 *
 * Terče stojí od začátku kola, nepřátelé z věty vycházejí po jednom a jdou po paprsku svého sektoru k hráči; kdo dojde
 * na `RAILFPS.reach`, vezme život a zmizí. Vlny jsou kola háčků (`withHooks`, `clear: 'win'`): pravidlo `railfps_round`
 * vyhlásí výhru, když kolo nemá nic živého ani čekající příchod, háčky z ní před posledním kolem udělají přestávku
 * s bannerem a další kolo. Poslední vlna končí bossem (víc HP, pomalejší). Prohra = životy na nule, nebo časový
 * limit hry.
 *
 * **Kdo co dělá v tiku:**
 * - ovládání `railfps`: hodiny kola, míření (`aimTick`: cíl, západka, natočení, odpočet, výstřel do slotu držáku),
 *   chůze nepřátel po paprscích;
 * - `railfps_shot` (stisk, hned za ovládáním): rána z tohoto tiku srazí nejbližší cíl v sektoru (boss ztratí HP);
 * - `railfps_round` (tik): nepřítel na dosah vezme život a zmizí, příchody vlny podle hodin kola, výhra kola.
 *
 * Determinismus: celá čísla, náhoda jen při stavbě (`createCompileRng` ze semínek kol), čas v tikách, žádné čtení
 * kamery. Míry a čtení stavu jsou v `railfps-world.ts`, hratelnost z konstrukce v `railfps-level.ts`.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeLevel,
  type ArcadeState,
  BODY,
  type BodyInit,
  type ControlPiece,
  type ModeGeneratorPiece,
  type ModeParts,
  type PieceRef,
  ROLE,
  type RulePiece,
  START_LIVES,
  bodyBase,
  bodyHp,
} from '../contract';
import { ROUNDS } from '../hooks/contract';
import { roundOf, roundSeeds, withHooks } from '../hooks';
import { nextMultiplier } from './rules';
import { type RailfpsArrival, checkRailfpsLevel } from './railfps-level';
import {
  RAILFPS,
  RAILFPS_BODIES,
  RAILFPS_RIG_KIND,
  RIG,
  YAW,
  aimOf,
  aimTick,
  bossSpeedOf,
  clockOf,
  enemySpeedAt,
  foeDistance,
  foeSector,
  foesOf,
  isEnemy,
  rayPoint,
  sameKind,
  shotOf,
  targetY,
  walkEnemy,
  writeAim,
} from './railfps-world';

export * from './railfps-world';
export * from './railfps-level';

const template = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);

// ---------------------------------------------------------------------------
// Ovládání

const controlParams = z
  .object({
    /** Držák stavu míření a hodin kola (`RIG`) a počítadlo háčků (kolo). */
    keeper: template,
    hooks: template,
    /** Předloha bosse – boss jde pomaleji. */
    boss: template,
    /** Rychlost nepřátel v kolech (jednotek za tik). */
    speeds: z.array(z.int().min(10).max(200)).min(1).max(ROUNDS.max),
  })
  .strict();
export type RailfpsControlParams = z.infer<typeof controlParams>;

/** Hodiny kola: nové kolo (háčky ho po přestávce zvedly) je vynulují, každý tik mimo přestávku přičte jeden. */
function tickClock(state: ArcadeState, keeper: number, hooks: number): void {
  const base = bodyBase(keeper);
  const round = roundOf(state, hooks);
  if (state[base + RIG.round] !== round) {
    state[base + RIG.round] = round;
    state[base + RIG.clock] = 0;
  }
  state[base + RIG.clock] = (state[base + RIG.clock] as number) + 1;
}

/** Ovládání střelnice z očí. Pořadí v tiku: hodiny kola → míření → chůze nepřátel. Hráč stojí. */
export const railfpsControl: ControlPiece<RailfpsControlParams> = {
  id: 'railfps',
  params: controlParams,
  roles: ['player', 'target', 'enemy'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    tickClock(state, params.keeper, params.hooks);
    const p = bodyBase(player);
    state[p + BODY.vx] = 0;
    state[p + BODY.vz] = 0;
    const { next, shot } = aimTick(aimOf(state, params.keeper), input);
    writeAim(state, params.keeper, next, shot);
    const speed = params.speeds[Math.min(params.speeds.length - 1, roundOf(state, params.hooks))] as number;
    for (const i of foesOf(state)) if (isEnemy(state, i)) walkEnemy(state, i, sameKind(state, i, params.boss) ? bossSpeedOf(speed) : speed);
  },
};

// ---------------------------------------------------------------------------
// Pravidla

/** Živé cíle v sektoru, které rána zasáhne (dál než `reach`, do dostřelu), od nejbližšího. */
export function foesInSector(state: ArcadeState, sector: number): number[] {
  return foesOf(state)
    .filter((body) => foeSector(state, body) === sector)
    .map((body) => ({ body, distance: foeDistance(state, body) }))
    .filter(({ distance }) => distance > RAILFPS.reach && distance <= RAILFPS.range)
    .sort((a, b) => a.distance - b.distance || a.body - b.body)
    .map(({ body }) => body);
}

const shotParams = z
  .object({
    keeper: template,
    boss: template,
    /** Počítadlo komba: série zásahů zvedá násobič; doplní ho `withCombo`, až P68-I zapojí pravidlo jako zdroj komba. */
    combo: template.optional(),
  })
  .strict();
export type RailfpsShotParams = z.infer<typeof shotParams>;

/** Body za sražený cíl: terč, nepřítel, boss. */
function pointsOf(state: ArcadeState, body: number, boss: number): number {
  if (sameKind(state, body, boss)) return RAILFPS.points.boss;
  return state[bodyBase(body) + BODY.role] === ROLE.target ? RAILFPS.points.target : RAILFPS.points.enemy;
}

/**
 * Rána z tohoto tiku (slot `shot` držáku): nejbližší cíl v sektoru. Boss s víc HP jen ztratí HP; poslední HP
 * (a terč či nepřítel bez HP) = body (s kombem), cíl zmizí. Celé v obalu `ifAlive`.
 */
export const railfpsShot: RulePiece<RailfpsShotParams> = {
  id: 'railfps_shot',
  params: shotParams,
  roles: ['player', 'target', 'enemy'],
  trigger: 'press',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }, params) => {
    const sector = shotOf(state, params.keeper);
    if (sector === null) return [];
    const body = foesInSector(state, sector)[0];
    if (body === undefined) return [];
    if (bodyHp(state, body) > 1) return [{ kind: 'hit', body, by: player, amount: 1 }];
    const multiplier = params.combo === undefined ? 1 : nextMultiplier(state, params.combo);
    const effects: ArcadeEffect[] = [
      { kind: 'score', amount: pointsOf(state, body, params.boss) * multiplier },
      { kind: 'despawn', body },
    ];
    if (params.combo !== undefined) effects.push({ kind: 'combo', body: params.combo, multiplier });
    return [{ kind: 'ifAlive', body, effects }];
  },
};

const arrival = z.tuple([
  z.int().min(1).max(ARCADE_LIMITS.maxTicks),
  template,
  z.int().min(-YAW.maxSector).max(YAW.maxSector),
  z.int().min(0).max(2),
  z.int().min(1).max(RAILFPS.range),
]);

const roundParams = z
  .object({
    keeper: template,
    hooks: template,
    /** Příchody po kolech, seřazené podle hodin kola. */
    waves: z.array(z.array(arrival).min(1).max(RAILFPS.waveMax)).min(1).max(ROUNDS.max),
  })
  .strict();
export type RailfpsRoundParams = z.infer<typeof roundParams>;

/** Příchod: terč v řádku výšky na paprsku sektoru, nepřítel a boss na zemi. */
function arriveEffect(entry: RailfpsArrival): ArcadeEffect {
  const [, from, sector, row, distance] = entry;
  const at = rayPoint(sector, distance);
  return { kind: 'spawn', template: from, x: at.x, y: from === RAILFPS_BODIES.target ? targetY(row) : 0, z: at.z, vx: 0, vy: 0, vz: 0 };
}

/**
 * Průběh kola (tik): nepřítel na dosah vezme život a zmizí; příchody vlny podle hodin kola; výhra kola = všechny
 * příchody za sebou a nic živého. Háčky z výhry před posledním kolem udělají konec kola.
 */
export const railfpsRound: RulePiece<RailfpsRoundParams> = {
  id: 'railfps_round',
  params: roundParams,
  roles: ['player', 'target', 'enemy'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params) => {
    const effects: ArcadeEffect[] = [];
    const alive = foesOf(state);
    for (const body of alive) {
      if (isEnemy(state, body) && foeDistance(state, body) <= RAILFPS.reach) {
        effects.push({ kind: 'ifAlive', body, effects: [{ kind: 'damage', amount: 1 }, { kind: 'despawn', body }] });
      }
    }
    const wave = params.waves[roundOf(state, params.hooks)];
    if (wave === undefined) return effects;
    const clock = clockOf(state, params.keeper);
    for (const entry of wave) if (entry[0] === clock) effects.push(arriveEffect(entry));
    if (clock > (wave[wave.length - 1] as RailfpsArrival)[0] && alive.length === 0) effects.push({ kind: 'win' });
    return effects;
  },
};

/** Pravidla střelnice z očí – `library.ts` je rozbalí do `rules`. */
export const RAILFPS_RULES: Readonly<Record<string, RulePiece>> = {
  railfps_shot: railfpsShot as RulePiece,
  railfps_round: railfpsRound as RulePiece,
};

// ---------------------------------------------------------------------------
// Generátor

const generatorParams = z
  .object({
    /** Terčů a nepřátel dohromady (věta „shoot 20 aliens“, `COUNT_PARAMS.railfps`). */
    targets: z.int().min(RAILFPS.targets.min).max(RAILFPS.targets.max).default(RAILFPS.targets.default),
    /** Vln (kol háčků); poslední končí bossem. */
    waves: z.int().min(RAILFPS.waves.min).max(RAILFPS.waves.max).default(RAILFPS.waves.default),
  })
  .strict();
export type RailfpsParams = z.infer<typeof generatorParams>;

/** Kolik věcí do které vlny: rovným dílem, zbytek do pozdějších vln, každá nejvýš `waveMax`. */
export function railfpsWaveSizes(targets: number, waves: number): number[] {
  const base = Math.floor(targets / waves);
  const extra = targets - base * waves;
  return Array.from({ length: waves }, (_, k) => Math.min(RAILFPS.waveMax, base + (k >= waves - extra ? 1 : 0)));
}

/** Věcí ke zničení, jak je generátor opravdu postaví (texty cíle čtou tentýž součet). */
export const railfpsFoes = (targets: number, waves: number): number => railfpsWaveSizes(targets, waves).reduce((sum, size) => sum + size, 0);

const SECTORS = Array.from({ length: YAW.sectors }, (_, index) => index - YAW.maxSector);
const STEP = 500;

/** Průměrný rozestup příchodů (tiky) ve hře s `total` věcmi: `pace` na celou hru, v mezích `gapMin`..`gapMax`. */
export const railfpsGap = (total: number): number => Math.min(RAILFPS.gapMax, Math.max(RAILFPS.gapMin, Math.floor(RAILFPS.pace / Math.max(1, total))));

/**
 * Příchody vlny `k`: terče a nepřátelé po jednom napřeskáčku (pořadí druhů ze streamu, sektory bez opakování, dokud
 * jich je dost, řádky výšky ze streamu), první v tiku 1, další po rozestupu `gap` (s každým kolem o `gapShrink`
 * kratším, ne pod `gapMin`) ± ¼. Poslední vlna končí bossem.
 */
export function railfpsWave(seed: number, k: number, size: number, waves: number, gap: number): RailfpsArrival[] {
  const rng = createCompileRng(seed, 'spawn');
  const enemies = Math.ceil((size * RAILFPS.enemyPct) / 100);
  const sectors: number[] = [];
  while (sectors.length < size) sectors.push(...rng.shuffle(SECTORS));
  const last = k === waves - 1;
  // Boss stojí mimo míchání: vždy poslední příchod poslední vlny.
  const kinds: number[] = rng.shuffle([...Array.from({ length: size - enemies }, () => RAILFPS_BODIES.target), ...Array.from({ length: last ? enemies - 1 : enemies }, () => RAILFPS_BODIES.enemy)]);
  if (last) kinds.push(RAILFPS_BODIES.boss);
  const step = Math.max(RAILFPS.gapMin, gap - k * RAILFPS.gapShrink);
  const out: RailfpsArrival[] = [];
  let at = 1;
  kinds.forEach((from, n) => {
    const sector = sectors[n] as number;
    if (from === RAILFPS_BODIES.target) out.push([at, from, sector, rng.int(0, 2), rng.int(RAILFPS.targetNear / STEP, RAILFPS.targetFar / STEP) * STEP]);
    else out.push([at, from, sector, 0, rng.int(RAILFPS.enemyNear / STEP, RAILFPS.enemyFar / STEP) * STEP]);
    at += rng.int(step - (step >> 2), step + (step >> 2));
  });
  return out;
}

const body = (role: BodyInit['role'], kind: string, size: { readonly w: number; readonly h: number; readonly d: number }, extra: Partial<BodyInit> = {}): BodyInit => ({ role, kind, x: 0, y: 0, z: 0, ...size, solid: false, ...extra });

/** Tělesa úrovně: hráč, držák stavu, předlohy terče, nepřítele a bosse (`RAILFPS_BODIES`). */
export function railfpsBodies(): BodyInit[] {
  return [
    body('player', 'player', RAILFPS.player),
    body('thing', RAILFPS_RIG_KIND, { w: 1, h: 1, d: 1 }, { template: true }),
    body('target', 'target', RAILFPS.target, { template: true }),
    body('enemy', 'enemy', RAILFPS.enemy, { template: true }),
    body('enemy', 'boss', RAILFPS.boss, { template: true, hp: RAILFPS.bossHp }),
  ];
}

/** Volné sloty spawnu: celá vlna naráz s rezervou. */
export const RAILFPS_SPAWN_SLOTS = RAILFPS.waveMax + 4;

/**
 * Režim `railfps.default` (generátor `railfps_rail`): `waves` vln z `targets` věcí, poslední s bossem. Háčky nese
 * generátor sám (`withHooks`, kolo končí výhrou pravidla, bez vylepšení). Životy ze specu (výchozí `START_LIVES`);
 * prohra = životy na nule, nebo časový limit (`RAILFPS.seconds`).
 */
export const railfpsRail: ModeGeneratorPiece<RailfpsParams> = {
  id: 'railfps_rail',
  params: generatorParams,
  roles: ['player', 'target', 'enemy'],
  cost: () => ({ bodies: RAILFPS_BODIES.boss + 2 + RAILFPS_SPAWN_SLOTS, rules: 5 }),
  generate: () => ({ bodies: railfpsBodies(), length: 0, spawnSlots: RAILFPS_SPAWN_SLOTS }),
  parts: (seed, params, health): ModeParts => {
    const level: ArcadeLevel = { bodies: railfpsBodies(), length: 0, spawnSlots: RAILFPS_SPAWN_SLOTS };
    const seeds = roundSeeds(seed, params.waves);
    const sizes = railfpsWaveSizes(params.targets, params.waves);
    const gap = railfpsGap(sizes.reduce((sum, size) => sum + size, 0));
    const schedule = sizes.map((size, k) => railfpsWave(seeds[k] as number, k, size, params.waves, gap));
    const { keeper, boss } = RAILFPS_BODIES;
    // Počítadlo háčků přidá `withHooks` hned za tělesa úrovně – ovládání, pravidla i robot ho znají už teď.
    const hooks = level.bodies.length;
    const bot: PieceRef = { id: 'railfps_bot', params: { keeper, hooks, boss } };
    const hooked = withHooks({ level, rules: [], bot }, seed, { rounds: params.waves, clear: 'win' });
    const speeds = Array.from({ length: params.waves }, (_, k) => enemySpeedAt(k));
    const rules: PieceRef[] = [
      { id: 'railfps_shot', params: { keeper, boss } },
      { id: 'railfps_round', params: { keeper, hooks, waves: schedule } },
      { id: 'out_of_health', params: {} },
      { id: 'time_limit', params: { seconds: RAILFPS.seconds } },
      ...hooked.rules,
    ];
    return {
      control: { id: 'railfps', params: { keeper, hooks, boss, speeds } },
      bot: hooked.bot,
      level: hooked.level,
      rules,
      issues: checkRailfpsLevel(level, schedule),
      health: health ?? START_LIVES,
    };
  },
};
