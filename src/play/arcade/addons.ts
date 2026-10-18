/**
 * Doplňky arkády (P26D): druhá mechanika nad základním ovládáním – „jump and
 * shoot“, „run and collect“, „chased by a bear“, „three lives“.
 *
 * Doplněk je post-process: dostane hotové části základního ovládání (úroveň,
 * pravidla, robota) a přidá do nich těla, pravidla a počítadla. Robota obalí
 * kus `addon_bot` – ten zeptá základního robota a jeho vstup doplní (střela,
 * úhyb, cesta k minci). Hra bez doplňků se tudy nedotkne ničeho, takže hash
 * jejího světa zůstává. Které ovládání který doplněk bere: `CAPABILITIES`.
 */

import { z } from 'zod';
import { guardLanes } from './pieces/behaviours';
import { pacedBotBase } from './pieces/phase-pieces';

import type { GameSpecV1 } from '@/play/spec';

import {
  ABILITY_SLOTS,
  ADDONS,
  ARCADE_LIMITS,
  type AddonId,
  type ArcadeInput,
  type ArcadeLevel,
  type ArcadeObservation,
  BODY,
  BUTTON,
  type BodyInit,
  type BotPiece,
  COUNTER,
  type ControlPiece,
  FLAG,
  HEADER,
  HIT_GRACE,
  type PieceRef,
  ROLE,
  type RulePiece,
  UNIT,
  bodyBase,
} from './contract';
import { GRAVITY } from './kernel';
import { ARENA } from './pieces/arena';
import { FLAP } from './pieces/flap';
import { GLIDE, glideControlParams, glidePathOf, glideVelocity } from './pieces/glide';
import { centerAt, courseOf, courseSchema, type SteerCourse, type SteerSegment, steerRoute } from './pieces/steer';
import { RUNNER_FOES } from './pieces/pacing-parts';
import { RUNNER, type RunnerSpeed, SPEED } from './pieces/runner';
import { type Row, nextRow } from './pieces/runner-bot';
import { BULLET_LIFETIME, SHOOTER } from './pieces/shooter';
import { census, shotHit } from './pieces/shots';
import { abilityBotParams, abilityButton, abilityControlParams, tickAbilities } from './abilities/state';
import { powerupControlParams, tickPowerup } from './powerups/state';

// Sloty jednou za modul: import pod vitestem čte každý přístup getterem a pronásledovatel jde přes všechna těla každý tik.
const FIRST_BODY = bodyBase(0);
const STRIDE = bodyBase(1) - FIRST_BODY;
const { role: ROLE_SLOT, flags: FLAGS_SLOT } = BODY;
const ALIVE = FLAG.alive;
const CHASER = ROLE.chaser;

/** Parametry kusu pod obalem, přečtené jednou: obal běží každý tik a zod parse by ho zpomalil. */
const parsedParams = new WeakMap<object, unknown>();
function paramsOf(piece: { readonly params: { parse(input: unknown): unknown } }, raw: Readonly<Record<string, unknown>>): unknown {
  if (!parsedParams.has(raw)) parsedParams.set(raw, piece.params.parse(raw));
  return parsedParams.get(raw);
}

/** Části hry, které staví základní ovládání a doplněk je rozšíří. */
export interface ArcadeParts {
  readonly control: PieceRef;
  readonly bot: PieceRef;
  readonly level: ArcadeLevel;
  readonly rules: PieceRef[];
  /** Úroveň neprošla kontrolou hratelnosti z konstrukce – svět se nestaví. */
  readonly issues?: readonly string[];
  /** Životy, které ovládání samo určí (rytmus je zastropuje, souboj bez nich nejde). */
  readonly health?: number;
}

/**
 * Základní ovládání pod obalem `addon_control` – doplněk po `+shoot` musí dál
 * poznat běžce a scéna podle něj volí kameru a vstup.
 */
export const baseControlOf = (control: PieceRef): PieceRef =>
  control.id === 'addon_control' || control.id === 'phase_control' || control.id === 'pacing_control' || control.id === 'assembly_control' ? baseControlOf((control.params as { base: PieceRef }).base) : control;
/** Základní robot pod obaly doplňků, fází, průběhu a skládání – scéna z něj čte trať (`course`). */
export const baseBotOf = (bot: PieceRef): PieceRef =>
  bot.id === 'addon_bot' || bot.id === 'phase_bot' || bot.id === 'pacing_bot' || bot.id === 'assembly_bot' ? baseBotOf((bot.params as { base: PieceRef }).base) : bot;
const baseControl = (parts: ArcadeParts): PieceRef => baseControlOf(parts.control);

export { mapUnderlying, underlyingRule } from './contract';

export interface AddonContext {
  readonly spec: GameSpecV1;
  readonly seed: number;
  /** Životy hry – náraz do nového nepřítele pak ubere život místo prohry. */
  readonly health: number | undefined;
}

/**
 * Úprava vstupu základního robota: dostane, co robot viděl a co zvolil, a
 * vrátí vstup s doplňkem (třeba přidá střelu). Čistá funkce jako `decide`.
 */
export type AddonBotStep = (observation: ArcadeObservation, input: ArcadeInput, base: PieceRef) => ArcadeInput;

export interface AddonPiece<P = unknown> {
  readonly id: AddonId;
  /** Parametry, které doplněk čte ze specu (počty, hustota). */
  readonly params: z.ZodType<P>;
  /** Životy, které doplněk dá, když je spec nemá (mechanika `health` má přednost). */
  readonly lives?: number;
  /** Parametry ovládání, které doplněk potřebuje (mince v úrovni). */
  readonly controlParams?: Readonly<Record<string, unknown>>;
  /** Přidá do úrovně těla, pravidla a počítadla. */
  apply?(parts: ArcadeParts, params: P, context: AddonContext): ArcadeParts;
  /** Úprava robota; doplněk bez ní robota neobaluje. */
  readonly bot?: AddonBotStep;
}

const noParams = z.object({}).strict();

/** Náraz do nového nepřítele: bez životů prohra, se životy ztráta života a vteřina milosti (P36A T2). */
export const hitParamsFor = (role: 'enemy' | 'chaser', health: number | undefined): Readonly<Record<string, unknown>> =>
  health === undefined ? { role, effect: 'lose' } : { role, effect: 'damage', grace: HIT_GRACE };

/** `+lives`: tři životy. Náraz pak ubere život místo prohry – pravidla ovládání to podle `health` udělají sama. */
export const livesAddon: AddonPiece<z.infer<typeof noParams>> = {
  id: 'lives',
  params: noParams,
  lives: 3,
};

// ---------------------------------------------------------------------------
// +collect

/** Podíl mincí úrovně, které `+collect` chce, když věta počet neřekne. */
export const COLLECT_SHARE = 0.5;

const collectParams = z.object({ need: z.int().min(1).max(ARCADE_LIMITS.maxBodies).optional() }).strict();

/**
 * Běžec k minci uhne, jen když je mince před příští řadou překážek a její
 * pruh je v té řadě stejně dobrý jako nejlepší – robot pak z pruhu nemusí
 * zpátky a skok či skluz za něj dál řeší základní robot.
 */
const collectStep: AddonBotStep = ({ state, player, recent }, input, base) => {
  if (base.id !== 'runner_bot' || (input.buttons & (BUTTON.TAP | BUTTON.DOWN)) !== 0) return input;
  const p = bodyBase(player);
  let lane = state[p + BODY.aux0] as number;
  for (const seen of recent) {
    if ((seen.buttons & BUTTON.LEFT) !== 0) lane = Math.max(-1, lane - 1);
    if ((seen.buttons & BUTTON.RIGHT) !== 0) lane = Math.min(1, lane + 1);
  }
  const pz = (state[p + BODY.z] as number) + (state[p + BODY.vz] as number) * recent.length;
  const row = nextRow(state, player);
  let coinZ = Number.POSITIVE_INFINITY;
  let coinLane = lane;
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    const b = bodyBase(i);
    if (state[b + BODY.role] !== ROLE.collectible || ((state[b + BODY.flags] as number) & FLAG.alive) === 0) continue;
    const z = state[b + BODY.z] as number;
    if (z <= pz || z >= coinZ || (row !== null && z >= row.z)) continue;
    coinZ = z;
    coinLane = Math.round((state[b + BODY.x] as number) / RUNNER.laneWidth);
  }
  if (coinZ === Number.POSITIVE_INFINITY) return input;
  if (row !== null) {
    const status = (l: number) => (row.lanes[l + 1] as Row['lanes'][number]).status;
    if (status(coinLane) !== Math.min(status(-1), status(0), status(1))) return input;
  }
  if (coinLane < lane) return { buttons: BUTTON.LEFT, axis: 0 };
  if (coinLane > lane) return { buttons: BUTTON.RIGHT, axis: 0 };
  return input;
};

/**
 * Mince běžce do pruhu, který příští řada překážek nechává volný (nejbližší
 * k původnímu) – stopa mincí pak ukazuje bezpečnou cestu a hráč, který ji
 * sbírá, nemusí před řadou přebíhat. Řada bez volného pruhu mince nechá.
 */
function coinsOnFreeLanes(level: ArcadeLevel): ArcadeLevel {
  const rows = new Map<number, Set<number>>();
  for (const body of level.bodies) {
    if (body.role !== 'obstacle') continue;
    rows.set(body.z, (rows.get(body.z) ?? new Set()).add(Math.round(body.x / RUNNER.laneWidth)));
  }
  const zs = [...rows.keys()].sort((a, b) => a - b);
  const bodies = level.bodies.map((body) => {
    if (body.role !== 'collectible') return body;
    const next = zs.find((z) => z > body.z);
    const taken = next === undefined ? undefined : rows.get(next);
    const lane = Math.round(body.x / RUNNER.laneWidth);
    if (taken === undefined || !taken.has(lane)) return body;
    const free = [0, -1, 1].filter((candidate) => !taken.has(candidate)).sort((a, b) => Math.abs(a - lane) - Math.abs(b - lane));
    return free.length === 0 ? body : { ...body, x: (free[0] as number) * RUNNER.laneWidth };
  });
  return { ...level, bodies };
}

/**
 * `+collect`: mince, které generátor už klade na dosažitelná místa (běžec
 * mezi řady, plošinovka na desky, poletování do průletu), se počítají do
 * `items` a cíl pustí dál jen s aspoň `need` mincemi – jinak prohra.
 */
export const collectAddon: AddonPiece<z.infer<typeof collectParams>> = {
  id: 'collect',
  params: collectParams,
  controlParams: { coins: true },
  apply: (input, params) => {
    const parts = baseControl(input).id === 'runner' ? { ...input, level: coinsOnFreeLanes(input.level) } : input;
    const kinds = [...new Set(parts.level.bodies.map((body) => body.kind))];
    const coins = parts.level.bodies.filter((body) => body.role === 'collectible' && body.kind === 'coin').length;
    if (coins === 0) return { ...parts, issues: [...(parts.issues ?? []), 'collect: the level has no coins to collect'] };
    const need = Math.min(coins, params.need ?? Math.max(1, Math.round(coins * COLLECT_SHARE)));
    const rules = parts.rules.map((rule) => (rule.id === 'finish' ? { id: 'finish_collected', params: { need } } : rule));
    rules.push({ id: 'collect_count', params: { kind: kinds.indexOf('coin') } });
    return { ...parts, rules };
  },
  bot: collectStep,
};

const countParams = z.object({ kind: z.int().min(0).max(ARCADE_LIMITS.maxBodies) }).strict();

/** Sebraná mince (předmět role `collectible` s modelem `kind`) → `items` + 1. Zmizení řeší `pickup`. */
export const collectCount: RulePiece<z.infer<typeof countParams>> = {
  id: 'collect_count',
  params: countParams,
  roles: ['player', 'collectible'],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, other }, params) => {
    const b = bodyBase(other);
    return state[b + BODY.role] === ROLE.collectible && state[b + BODY.kind] === params.kind ? [{ kind: 'count', counter: 'items', amount: 1 }] : [];
  },
};

const needParams = z.object({ need: z.int().min(1).max(ARCADE_LIMITS.maxBodies) }).strict();

/** Cíl s mincemi: aspoň `need` sebraných = výhra, míň = prohra (hráč vidí, kolik chybělo). */
export const finishCollected: RulePiece<z.infer<typeof needParams>> = {
  id: 'finish_collected',
  params: needParams,
  roles: ['player', 'goal'],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, other }, params) => {
    if (state[bodyBase(other) + BODY.role] !== ROLE.goal) return [];
    return (state[HEADER.counters + COUNTER.items] as number) >= params.need ? [{ kind: 'win' }] : [{ kind: 'lose' }];
  },
};

/** Rivals remain physical race opponents even when a stray shot touches them. */
export const glideShotHit: RulePiece = {
  ...shotHit,
  id: 'glide_shot_hit',
  // Střelba jako akce hrdiny (P46A T9) nese sloveso jako `shot_hit`.
  params: z.object({ verb: z.literal('shoot').optional() }).strict(),
  fire(ctx) {
    if (ctx.other < 0) return [];
    const at = bodyBase(ctx.other);
    if (ctx.state[at + BODY.role] === ROLE.enemy && (ctx.state[at + BODY.flags]! & FLAG.kinematic)) return [];
    return shotHit.fire(ctx, {});
  },
};

export const ADDON_RULES = { collect_count: collectCount, finish_collected: finishCollected, glide_shot_hit: glideShotHit } as const;

// ---------------------------------------------------------------------------
// +shoot

export const SHOOT = {
  enemyW: SHOOTER.enemyW,
  enemyH: SHOOTER.enemyH,
  /** Létající nepřítel poletování má velikost ptáka. */
  flyerSize: 800,
  /** Robot střílí na nepřítele blíž než tohle – střela doletí (`BULLET_LIFETIME` × rychlost). */
  range: 30 * UNIT,
  /** Náboje navíc k počtu nepřátel × 3 (minutí, rána do zdi). */
  spareAmmo: 10,
  /** Střel ve vzduchu naráz: život střely / rozestup ran. */
  spawnSlots: Math.ceil(BULLET_LIFETIME / SHOOTER.fireInterval) + 1,
  /** Cíl řízení stojí aspoň tolik za místem, kde se silnice zúží (`settledZ`). */
  settle: 15 * UNIT,
  /**
   * Cíle řízení na okruhu ze vzorů za cílem na rovince startu, v ‰ délky. Třetí cíl (350 ‰, P46H) vrací střelbě
   * obtížnost, kterou po sloučení P46B × P46D dělal jen shoz vedle cíle (`DROPPER.targetClear`): bez něj začátečník
   * vyhrál 0,72, s ním 0,48, intermediate 0,92 → 0,87 (`drive.race+shoot`, 60 semínek).
   */
  patternTargets: [550, 350] as const,
} as const;

const enemy = (x: number, y: number, z: number, size?: number): BodyInit => ({
  role: 'enemy',
  kind: 'enemy',
  x,
  y,
  z,
  w: size ?? SHOOT.enemyW,
  h: size ?? SHOOT.enemyH,
  d: size ?? SHOOT.enemyW,
  solid: false,
});

/**
 * Cíl řízení ne hned za zúžením (P46H): okruh ze vzorů P46D zúží silnici kdekoli a cíl na ose zúžení robot nestihne
 * po vjezdu do něj srovnat a trefit (`drive.test` se střelbou, semínko 16). Cíl se posune na první místo aspoň
 * `SHOOT.settle` za každým zúžením. Jen okruh ze vzorů (`patterns`), uložené hry staví cíle jako dřív.
 */
function settledZ(route: readonly SteerSegment[], from: number): number {
  let z = from;
  for (let moved = true; moved; ) {
    moved = false;
    route.forEach((segment, index) => {
      const narrows = index > 0 && segment.width < (route[index - 1] as SteerSegment).width;
      if (narrows && segment.near <= z && z < segment.near + SHOOT.settle) {
        z = segment.near + SHOOT.settle;
        moved = true;
      }
    });
  }
  return z;
}

export interface EnemyOptions {
  readonly patterned?: boolean;
  readonly finaleFrom?: number;
  /** Klouzání: terč u každého kruhu tunelu finále (jen doplněk `shoot`). */
  readonly tunnel?: boolean;
}

/** Nová hra se vzory (P46D, značka `patterns` ve spec): řízení i běžec; uložená hra dostane nepřátele jako dřív. */
export function enemyOptions(spec: GameSpecV1, control: string): EnemyOptions {
  if ((spec.controlParams as { patterns?: unknown } | undefined)?.patterns !== 1) return {};
  // Čte se až při volání: `pacing-parts` a doplňky se navzájem importují.
  return control === 'runner' ? { finaleFrom: RUNNER_FOES.bossAt } : { patterned: true };
}

/** Řady překážek běžce: z → obsazené pruhy. */
function runnerRows(level: ArcadeLevel): Map<number, Set<number>> {
  const rows = new Map<number, Set<number>>();
  for (const body of level.bodies) {
    if (body.role !== 'obstacle') continue;
    rows.set(body.z, (rows.get(body.z) ?? new Set()).add(Math.round(body.x / RUNNER.laneWidth)));
  }
  return rows;
}

/**
 * Nepřátelé tam, kudy hráč musí: běžci do pruhu, který příští řada nechává
 * volný (za mince), plošinovce na vzdálený konec desky, poletování do
 * mezery trubky. Každý druhý úsek, ať mezi nimi zbude čas. Nová hra (`enemyOptions`): `patterned` = řízení
 * na okruhu ze vzorů (P46D), `finaleFrom` = od kolika ‰ trati běžce patří finále bossovi (bez nepřátel).
 */
export function enemiesFor(control: string, level: ArcadeLevel, options: EnemyOptions = {}): BodyInit[] {
  const { patterned = false } = options;
  if (control === 'glide') {
    // Actual XYZ ring apertures, not a floor-level track: there is enough time
    // to settle into the next ring's lane and fire before reaching its target.
    // Střelba (`tunnel`): tunel finále nové hry (`GLIDE_FINALE`, kruhy blíž než `GLIDE.spacing`) má terč u každého
    // kruhu – po každém druhém by zásahy po celé trati rozředily hustotu konce pod `CLIMAX_FACTOR` (P51 T3).
    // Akce hrdiny ne: nepřítel po 44 tikách přijde dashi v cooldownu (60) a robot prohraje.
    const size = 2 * GLIDE.size;
    return glidePathOf(level).filter((node, index, path) => index % 2 === 0 || (options.tunnel === true && node.z - path[index - 1]!.z < GLIDE.spacing))
      .map(node => enemy(node.x, node.y - size / 2, node.z, size));
  }
  if (control === 'steer') {
    const course = courseOf(level);
    // A target on the opening straight gives the driver a clear forward shot;
    // later targets use the actual track center, never an off-road decoration.
    if (!patterned) return [25 * UNIT, Math.floor(level.length * 0.55)].map(z => enemy(centerAt(course, z), 0, z));
    // Okruh ze vzorů (P46D, nová hra): cíle mimo ústí zúžení a třetí cíl v úseku 2 (`SHOOT.patternTargets`).
    const route = steerRoute(level);
    return [25 * UNIT, ...SHOOT.patternTargets.map((permille) => settledZ(route, Math.floor((level.length * permille) / 1000)))].map(z => enemy(centerAt(course, z), 0, z));
  }
  if (control === 'runner') {
    const rows = runnerRows(level);
    const zs = [...rows.keys()].sort((a, b) => a - b);
    return zs.slice(0, -1).flatMap((from, index) => {
      const to = zs[index + 1] as number;
      const free = [0, -1, 1].filter((lane) => !(rows.get(to) as Set<number>).has(lane));
      if (index % 2 === 1 || free.length === 0) return [];
      const z = Math.min(Math.floor((from + to) / 2) + 2500, to - 2000);
      // Finále bosse (P46H): nepřítel ve volném pruhu stojí tam, kudy boss útočí, a úder na něj vybije akci právě
      // v jediném okně, kdy je boss v dosahu (`boss-abilities.test`, semínko 1).
      if (options.finaleFrom !== undefined && z * 1000 >= level.length * options.finaleFrom) return [];
      return [enemy((free[0] as number) * RUNNER.laneWidth, 0, z)];
    });
  }
  if (control === 'platform') {
    const slabs = level.bodies.filter((body) => body.role === 'platform' && body.kinematic !== true).sort((a, b) => a.z - b.z);
    return slabs.slice(1, -1).flatMap((slab, index) => (index % 2 === 0 ? [enemy(0, slab.y + slab.h, slab.z + slab.d / 2 - 900)] : []));
  }
  if (control === 'flap') {
    const lower = level.bodies.filter((body) => body.role === 'obstacle' && body.y === 0).sort((a, b) => a.z - b.z);
    return lower.flatMap((pipe, index) => {
      const upper = level.bodies.find((body) => body.role === 'obstacle' && body.z === pipe.z && body.y > 0);
      if (index % 2 === 0 || upper === undefined) return [];
      return [enemy(0, pipe.h + Math.floor((upper.y - pipe.h - SHOOT.flyerSize) / 2), pipe.z, SHOOT.flyerSize)];
    });
  }
  return [];
}

/** Střela do volného místa: `true`, když mezi hráčem a nepřítelem v ose z nestojí pevné tělo. */
function clearShot(state: Int32Array, player: number, from: { x: number; y: number; z: number }, target: number): boolean {
  const t = bodyBase(target);
  const tz = state[t + BODY.z] as number;
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    if (i === player || i === target) continue;
    const b = bodyBase(i);
    if ((((state[b + BODY.flags] as number) & (FLAG.alive | FLAG.solid)) !== (FLAG.alive | FLAG.solid))) continue;
    const z = state[b + BODY.z] as number;
    const d = state[b + BODY.d] as number;
    if (z + d / 2 < from.z || z - d / 2 > tz) continue;
    if (Math.abs((state[b + BODY.x] as number) - from.x) * 2 >= (state[b + BODY.w] as number) + SHOOTER.bulletSize) continue;
    const y = state[b + BODY.y] as number;
    if (from.y < y + (state[b + BODY.h] as number) && y < from.y + SHOOTER.bulletSize) return false;
  }
  return true;
}

/** Na nepřítele už letí střela: živý projektil před ním, v jeho šířce a výšce. */
function covered(state: Int32Array, target: number): boolean {
  const t = bodyBase(target);
  const tx = state[t + BODY.x] as number;
  const ty = state[t + BODY.y] as number;
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    const b = bodyBase(i);
    if (state[b + BODY.role] !== ROLE.projectile || ((state[b + BODY.flags] as number) & FLAG.alive) === 0) continue;
    if ((state[b + BODY.z] as number) > (state[t + BODY.z] as number)) continue;
    if (Math.abs((state[b + BODY.x] as number) - tx) * 2 >= (state[t + BODY.w] as number) + SHOOTER.bulletSize) continue;
    const y = state[b + BODY.y] as number;
    if (y + SHOOTER.bulletSize > ty && y < ty + (state[t + BODY.h] as number)) return true;
  }
  return false;
}

/**
 * Robot střílí, když má čistou ránu na nepřítele před sebou, na kterého
 * ještě žádná jeho střela neletí – střela na vzdáleného nepřítele letí až
 * 90 tiků a bližší nepřítel v novém pruhu nesmí čekat, až dopadne. Pohled je
 * 8 tiků starý: běžec proto nestřílí při přebíhání, plošinovka jen ze země,
 * poletování dopočítá výšku z vlastních ťuků (jako jeho robot). Aréna
 * střílí ve směru pohybu na cokoli v ráně, jen když nic neletí. `owns` omezí
 * cíle na nepřátele, které robot akcí přidělil střelbě (R4).
 */
export const shootStep = ({ state, player, recent }: ArcadeObservation, input: ArcadeInput, base: PieceRef, owns?: (body: number) => boolean): ArcadeInput => {
  if (recent.some((seen) => (seen.buttons & BUTTON.FIRE) !== 0)) return input;
  if (base.id === 'arena_bot' && census(state).projectiles > 0) return input;
  const p = bodyBase(player);
  let px = state[p + BODY.x] as number;
  let pz = (state[p + BODY.z] as number) + (state[p + BODY.vz] as number) * recent.length;
  let py = state[p + BODY.y] as number;
  if (base.id === 'glide_bot') {
    // Fáze smí rychlost zvednout nad autorský strop 240; tvar se ověří, rychlost zůstane běhová.
    const topSpeed = typeof base.params.topSpeed === 'number' ? base.params.topSpeed : GLIDE.speed;
    const params = { ...paramsOf({ params: glideControlParams }, { ...base.params, topSpeed: GLIDE.speed }) as ReturnType<typeof glideControlParams.parse>, topSpeed };
    let now = { x: px, y: py, z: state[p + BODY.z]!, vx: state[p + BODY.vx]!, vy: state[p + BODY.vy]!, vz: state[p + BODY.vz]! };
    // Blaster fires after control and movement, not at the stale observation.
    for (const seen of [...recent, input]) {
      const velocity = glideVelocity(now, seen, params);
      now = { ...velocity, x: now.x + velocity.vx, y: now.y + velocity.vy, z: now.z + velocity.vz };
    }
    px = now.x; py = now.y; pz = now.z;
  }
  const grounded = ((state[p + BODY.flags] as number) & FLAG.grounded) !== 0;
  if (base.id === 'runner_bot') {
    // Přeběh pruhu dopočítá z vlastních stisků (jako ovládání běžce): nepřítel
    // čeká v pruhu, do kterého robot přebíhá až před řadou, a robot se
    // zpožděným pohledem by jinak vystřelil pozdě (R1). Stejně skok (R4): po
    // dopadu je na ránu málo času, starý pohled by ho ještě viděl ve vzduchu.
    let lane = state[p + BODY.aux0] as number;
    let vy = state[p + BODY.vy] as number;
    let ground = ((state[p + BODY.flags] as number) & FLAG.grounded) !== 0;
    for (const seen of [...recent, input]) {
      if ((seen.buttons & BUTTON.LEFT) !== 0) lane = Math.max(-1, lane - 1);
      if ((seen.buttons & BUTTON.RIGHT) !== 0) lane = Math.min(1, lane + 1);
      px += Math.max(-RUNNER.laneSpeed, Math.min(RUNNER.laneSpeed, lane * RUNNER.laneWidth - px));
      if (ground && (seen.buttons & (BUTTON.TAP | BUTTON.UP)) !== 0) vy = RUNNER.jumpVy;
      vy -= GRAVITY;
      py += vy;
      ground = py <= 0;
      if (ground) [py, vy] = [0, 0];
    }
    if (px !== lane * RUNNER.laneWidth) return input;
  }
  if (base.id === 'platform_bot' && (!grounded || recent.some((seen) => (seen.buttons & (BUTTON.TAP | BUTTON.UP)) !== 0))) return input;
  if (base.id === 'flap_bot') {
    let vy = state[p + BODY.vy] as number;
    for (const seen of recent) {
      if ((seen.buttons & BUTTON.TAP) !== 0) vy = FLAP.flapVy;
      vy -= GRAVITY;
      py += vy;
    }
  }
  const from = { x: px, y: py + Math.floor(((state[p + BODY.h] as number) - SHOOTER.bulletSize) / 2), z: pz };
  const vx = state[p + BODY.vx] as number;
  const vz = state[p + BODY.vz] as number;
  const heading = base.id === 'arena_bot' && (vx !== 0 || vz !== 0);
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    const b = bodyBase(i);
    if (i === player || state[b + BODY.role] !== ROLE.enemy || ((state[b + BODY.flags] as number) & FLAG.alive) === 0) continue;
    if (owns !== undefined && !owns(i)) continue;
    // The moving race opponent is not a shooting target.
    if (base.id === 'glide_bot' && (state[b + BODY.flags]! & FLAG.kinematic)) continue;
    const ex = (state[b + BODY.x] as number) - from.x;
    const ez = (state[b + BODY.z] as number) - from.z;
    const w = state[b + BODY.w] as number;
    if (heading) {
      const speed = Math.hypot(vx, vz);
      const along = (ex * vx + ez * vz) / speed;
      const across = Math.abs(ex * vz - ez * vx) / speed;
      if (along > 0 && along < SHOOT.range && across * 2 < w) return { ...input, buttons: input.buttons | BUTTON.FIRE };
      continue;
    }
    if (ez <= 0 || ez > SHOOT.range || Math.abs(ex) * 2 >= w + SHOOTER.bulletSize) continue;
    const y = state[b + BODY.y] as number;
    // Střela musí celá projít výškou nepřítele, ne ho jen škrtnout.
    if (from.y < y || from.y + SHOOTER.bulletSize > y + (state[b + BODY.h] as number)) continue;
    if (!covered(state, i) && clearShot(state, player, from, i) && (owns === undefined || !screened(state, from, i, owns))) return { ...input, buttons: input.buttons | BUTTON.FIRE };
  }
  return input;
};

/** Stojí mezi hráčem a cílem v dráze střely živý nepřítel, kterého střelba nevlastní (R4)? Střela by zabila jeho. */
function screened(state: Int32Array, from: { x: number; y: number; z: number }, target: number, owns: (body: number) => boolean): boolean {
  const tz = state[bodyBase(target) + BODY.z] as number;
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    const b = bodyBase(i);
    if (i === target || owns(i) || state[b + BODY.role] !== ROLE.enemy || ((state[b + BODY.flags] as number) & FLAG.alive) === 0) continue;
    const z = state[b + BODY.z] as number;
    if (z < from.z || z > tz || Math.abs((state[b + BODY.x] as number) - from.x) * 2 >= (state[b + BODY.w] as number) + SHOOTER.bulletSize) continue;
    const y = state[b + BODY.y] as number;
    if (from.y < y + (state[b + BODY.h] as number) && y < from.y + SHOOTER.bulletSize) return true;
  }
  return false;
}

/**
 * `+shoot`: nepřátelé v cestě (aréna má svoje), blaster a tlačítko střelby
 * `FIRE`. Náraz do nepřítele je prohra, se životy ztráta života.
 */
export const shootAddon: AddonPiece<z.infer<typeof noParams>> = {
  id: 'shoot',
  params: noParams,
  apply: (parts, _params, { health, spec }) => {
    const control = baseControl(parts).id;
    const enemies = enemiesFor(control, parts.level, { ...enemyOptions(spec, control), tunnel: true });
    // Nová těla jen na konec: index modelu (`kinds`), který si dřívější doplněk zapsal, se tak nepohne.
    const bodies = [...parts.level.bodies, ...enemies];
    const template = bodies.length;
    bodies.push({ role: 'projectile', kind: 'bullet', x: 0, y: 0, z: 0, w: SHOOTER.bulletSize, h: SHOOTER.bulletSize, d: SHOOTER.bulletSize, solid: false, template: true, lifetime: BULLET_LIFETIME });
    const foes = control === 'move_free' ? bodies.filter((body) => body.role === 'enemy').length : enemies.length;
    const rules: PieceRef[] = [
      ...parts.rules,
      { id: 'blaster', params: { template, aim: control === 'move_free' ? 'heading' : 'forward' } },
      { id: control === 'glide' ? 'glide_shot_hit' : 'shot_hit', params: {} },
    ];
    // Aréna náraz do buňky řeší sama (`arena_eat`).
    if (control !== 'move_free') rules.push({ id: 'hit', params: hitParamsFor('enemy', health) });
    return {
      ...parts,
      control: wrapControl(parts, {}),
      level: {
        ...parts.level,
        bodies,
        spawnSlots: (parts.level.spawnSlots ?? 0) + SHOOT.spawnSlots,
        counters: { ...parts.level.counters, ammo: foes * 3 + SHOOT.spareAmmo },
      },
      rules,
    };
  },
  bot: shootStep,
};

// ---------------------------------------------------------------------------
// +chaser

/**
 * Rychlost pronásledovatele za tik: `along` po trati (z), `across` do stran a
 * nahoru. Vždy pod rychlostí hráče (běžec 117–183, plošinovka 110, aréna 150),
 * takže před ním jde utéct; běžci jde naproti, protože zezadu by ho nedohnal.
 */
export const CHASE = {
  runner: { along: 100, across: 60, oncoming: true, commit: 6500 },
  platform: { along: 55, across: 40 },
  move_free: { along: 80, across: 80 },
  w: 1000,
  h: 1400,
  d: 1000,
  /** Plošinovka: náskok hráče na startu. */
  platformLead: 12 * UNIT,
  /** Aréna: odstup od stěny v protějším rohu. */
  arenaInset: 3 * UNIT,
  /** Běžec uhne, když ho pronásledovatel mine do tolika tiků (už se nestáčí), a nejpozději za tolik. */
  dodgeTicks: 20,
  dodgeLatest: 6,
  /** Rezerva k šířce obou těl, se kterou robot pruh považuje za zasažený. */
  dodgeMargin: 100,
} as const;

/** `oncoming`: běží jen proti hráči a pruh dorovnává, jen dokud je dál než `commit` – pak se rozběhne rovně. */
type ChaseSpeed = { readonly along: number; readonly across: number; readonly oncoming?: boolean; readonly commit?: number; readonly course?: SteerCourse };

/** Kde pronásledovatel startuje: běžci naproti tak, aby se potkali v mezeře mezi řadami; plošinovce za zády; aréně v protějším rohu. */
function chaserFor(control: PieceRef, level: ArcadeLevel): { body: BodyInit; speed: ChaseSpeed } | null {
  const player = level.bodies[0] as BodyInit;
  const at = (x: number, y: number, z: number): BodyInit => ({ role: 'chaser', kind: 'chaser', x, y, z, w: CHASE.w, h: CHASE.h, d: CHASE.d, solid: false, kinematic: true });
  if (control.id === 'steer' && control.params.land === undefined) {
    const course = courseOf(level);
    const z = player.z - 18 * UNIT;
    return { body: at(centerAt(course, z), player.y, z), speed: { along: Math.floor(((control.params.topSpeed as number | undefined) ?? 300) * 0.7), across: 160, course } };
  }
  if (control.id === 'runner') {
    const zs = [...runnerRows(level).keys()].sort((a, b) => a - b);
    if (zs.length < 2) return null;
    const gap = Math.max(1, Math.floor(zs.length / 3));
    const meet = Math.floor(((zs[gap - 1] as number) + (zs[gap] as number)) / 2);
    const speed = SPEED[(control.params.speed as RunnerSpeed | undefined) ?? 'normal'];
    const ticks = Math.floor((meet - player.z) / speed);
    return { body: at(0, 0, meet + CHASE.runner.along * ticks), speed: CHASE.runner };
  }
  if (control.id === 'platform') return { body: at(0, player.y, player.z - CHASE.platformLead), speed: CHASE.platform };
  if (control.id === 'move_free') {
    const corner = ((control.params.half as number | undefined) ?? ARENA.half) - CHASE.arenaInset;
    return { body: at(player.x > 0 ? -corner : corner, 0, player.z > 0 ? -corner : corner), speed: CHASE.move_free };
  }
  return null;
}

/**
 * Pronásledovatel míří na hráče po každé ose zvlášť, nejvýš svou rychlostí.
 * Hýbe jím obal ovládání. `oncoming` (běžec) běží jen proti hráči: zamíří do
 * jeho pruhu a od `commit` pádí rovně, i když ho mine – kdyby se otočil,
 * zůstal by hráči v patách a boční dorovnání by ho dostihlo, i když je
 * pomalejší; kdyby se stáčel až do střetu, skončil by mezi pruhy a nešlo by
 * mu uhnout.
 */
function chase(state: Int32Array, player: number, speed: ChaseSpeed): void {
  const p = bodyBase(player);
  const clamp = (delta: number, limit: number) => Math.max(-limit, Math.min(limit, delta));
  const bodies = state[HEADER.bodyCount] as number;
  for (let i = 0; i < bodies; i += 1) {
    const b = FIRST_BODY + i * STRIDE;
    if (state[b + ROLE_SLOT] !== CHASER || ((state[b + FLAGS_SLOT] as number) & ALIVE) === 0) continue;
    if (speed.oncoming === true) {
      const aiming = (state[b + BODY.z] as number) - (state[p + BODY.z] as number) > (speed.commit ?? 0);
      state[b + BODY.vx] = aiming ? clamp((state[p + BODY.x] as number) - (state[b + BODY.x] as number), speed.across) : 0;
      state[b + BODY.vz] = -speed.along;
      continue;
    }
    if (speed.course !== undefined) {
      const z = state[b + BODY.z] as number;
      const playerZ = state[p + BODY.z] as number;
      const offset = Math.max(-speed.course.halfWidth / 2, Math.min(speed.course.halfWidth / 2, (state[p + BODY.x] as number) - centerAt(speed.course, playerZ)));
      state[b + BODY.vx] = clamp(centerAt(speed.course, z + 6000) + offset - (state[b + BODY.x] as number), speed.across);
      state[b + BODY.vz] = clamp(playerZ - z, speed.along);
      continue;
    }
    state[b + BODY.vx] = clamp((state[p + BODY.x] as number) - (state[b + BODY.x] as number), speed.across);
    state[b + BODY.vy] = clamp((state[p + BODY.y] as number) - (state[b + BODY.y] as number), speed.across);
    state[b + BODY.vz] = clamp((state[p + BODY.z] as number) - (state[b + BODY.z] as number), speed.along);
  }
}

/**
 * Běžec uhne o pruh, když ho pronásledovatel mine za `dodgeLatest`–`dodgeTicks`
 * tiků v pruhu, kam běžec míří; pruh vybere podle příští řady překážek. Dokud
 * je pronásledovatel blízko, nepustí ho základní robot zpátky do jeho pruhu.
 * Plošinovka a aréna úhyb nepotřebují: plošinovka je rychlejší, robot arény
 * před pronásledovatelem utíká sám (`arena-bot.ts`).
 */
const chaseStep: AddonBotStep = ({ state, player, recent }, input, base) => {
  if (base.id !== 'runner_bot') return input;
  const p = bodyBase(player);
  const lag = recent.length;
  let lane = state[p + BODY.aux0] as number;
  for (const seen of recent) {
    if ((seen.buttons & BUTTON.LEFT) !== 0) lane = Math.max(-1, lane - 1);
    if ((seen.buttons & BUTTON.RIGHT) !== 0) lane = Math.min(1, lane + 1);
  }
  const pz = (state[p + BODY.z] as number) + (state[p + BODY.vz] as number) * lag;
  const reach = (CHASE.w + RUNNER.playerW) / 2 + CHASE.dodgeMargin;
  // Pruhy, kam pronásledovatel stihne dorazit, než hráče mine – a za kolik tiků ho mine.
  let soonest = Number.POSITIVE_INFINITY;
  const danger = new Set<number>();
  const bodies = state[HEADER.bodyCount] as number;
  for (let i = 0; i < bodies; i += 1) {
    const b = FIRST_BODY + i * STRIDE;
    if (state[b + ROLE_SLOT] !== CHASER || ((state[b + FLAGS_SLOT] as number) & ALIVE) === 0) continue;
    const closing = (state[p + BODY.vz] as number) + CHASE.runner.along;
    const seenDz = (state[b + BODY.z] as number) - (state[p + BODY.z] as number);
    const dz = seenDz - closing * lag;
    const ticks = Math.floor((dz + (CHASE.d + RUNNER.playerD) / 2) / closing);
    if (ticks < 0 || ticks > CHASE.dodgeTicks) continue;
    soonest = Math.min(soonest, ticks);
    // Od pohledu se pronásledovatel ještě stáčel, dokud nebyl blíž než `commit`.
    const turning = Math.max(0, Math.min(lag, Math.ceil((seenDz - CHASE.runner.commit) / closing)));
    const cx = (state[b + BODY.x] as number) + (state[b + BODY.vx] as number) * turning;
    for (const l of [-1, 0, 1]) if (Math.abs(cx - l * RUNNER.laneWidth) < reach) danger.add(l);
  }
  if (danger.size === 0) return input;
  const wants = (input.buttons & BUTTON.LEFT) !== 0 ? lane - 1 : (input.buttons & BUTTON.RIGHT) !== 0 ? lane + 1 : lane;
  if (!danger.has(lane)) return danger.has(wants) ? { ...input, buttons: input.buttons & ~(BUTTON.LEFT | BUTTON.RIGHT) } : input;
  if (soonest < CHASE.dodgeLatest) return input;
  const row = nextRow(state, player);
  const status = (l: number) => (row === null ? 0 : (row.lanes[l + 1] as Row['lanes'][number]).status);
  const safe = [-1, 0, 1].filter((l) => !danger.has(l)).sort((a, b) => Math.abs(a - lane) - Math.abs(b - lane) || status(a) - status(b));
  if (safe.length === 0) return input;
  return { buttons: (safe[0] as number) < lane ? BUTTON.LEFT : BUTTON.RIGHT, axis: 0 };
};

/**
 * `+chaser`: jeden pronásledovatel (medvěd, duch), který hráče honí pod jeho
 * rychlostí. Dotek je prohra, se životy ztráta života (a pronásledovatel zmizí).
 */
export const chaserAddon: AddonPiece<z.infer<typeof noParams>> = {
  id: 'chaser',
  params: noParams,
  apply: (parts, _params, { health }) => {
    const made = chaserFor(baseControl(parts), parts.level);
    if (made === null) return { ...parts, issues: [...(parts.issues ?? []), 'chaser: the level has no place for a chaser'] };
    return {
      ...parts,
      control: wrapControl(parts, { chase: made.speed }),
      level: { ...parts.level, bodies: [...parts.level.bodies, made.body] },
      rules: [...parts.rules, { id: 'hit', params: hitParamsFor('chaser', health) }],
    };
  },
  bot: chaseStep,
};

export const ADDON_PIECES: Readonly<Record<AddonId, AddonPiece | undefined>> = {
  lives: livesAddon as AddonPiece,
  collect: collectAddon as AddonPiece,
  shoot: shootAddon as AddonPiece,
  chaser: chaserAddon as AddonPiece,
};

const wrappedControlParams = z
  .object({
    base: z.object({ id: z.string(), params: z.record(z.string(), z.unknown()) }).strict(),
    chase: z.object({ along: z.int().min(1), across: z.int().min(0), oncoming: z.boolean().optional(), commit: z.int().min(0).optional(), course: courseSchema.optional() }).strict().optional(),
    /** Akce hrdiny (P46A): počítadlo a akce v pořadí tlačítek A, B. */
    abilities: abilityControlParams.optional(),
    /** Power-up (P46C): počítadlo a zrychlení žánru. */
    powerups: powerupControlParams.optional(),
    /**
     * `false` (P46C, jen svět s power-upy bez blasteru): obal čítač `trigger` nepřepisuje – drží v něm
     * rozdělanou práci `interact`. Bez klíče ho zapisuje každý tik jako dřív (hash uložených her).
     */
    trigger: z.literal(false).optional(),
  })
  .strict();

/** Obalí ovládání `addon_control`, nebo doplní parametry obalu, který už tam je. */
export function wrapControl(parts: ArcadeParts, extra: Partial<z.infer<typeof wrappedControlParams>>): PieceRef {
  const params = parts.control.id === 'addon_control' ? parts.control.params : { base: parts.control };
  return { id: 'addon_control', params: { ...params, ...extra } };
}

/**
 * Ovládání s doplňky: základní ovládání pohne hráčem, obal zapíše `FIRE` do
 * čítače `trigger` (odkud ho čte pravidlo `blaster`) a pohne pronásledovatelem.
 */
export function makeAddonControl(bases: Readonly<Record<string, ControlPiece>>): ControlPiece<z.infer<typeof wrappedControlParams>> {
  return {
    id: 'addon_control',
    params: wrappedControlParams,
    roles: ['player'],
    cost: () => ({ bodies: 1, rules: 0 }),
    step: (state, player, input, params) => {
      const base = bases[params.base.id];
      if (base === undefined) throw new Error(`arcade: unknown control ${params.base.id}`);
      base.step(state, player, input, paramsOf(base, params.base.params));
      let trigger = (input.buttons & BUTTON.FIRE) !== 0;
      if (params.abilities !== undefined) {
        // Střelba jako akce hrdiny (P46A) spouští blaster svým tlačítkem A nebo B, ale jen
        // novým stiskem: `held` jsou tlačítka minulého tiku, `tickAbilities` je hned přepíše.
        const held = state[bodyBase(params.abilities.keeper) + ABILITY_SLOTS.held] as number;
        trigger ||= (input.buttons & ~held & abilityButton(params.abilities.ids, 'shoot')) !== 0;
        tickAbilities(state, input.buttons, params.abilities);
      }
      if (params.powerups !== undefined) tickPowerup(state, player, params.powerups, params.abilities);
      if (params.trigger !== false) state[HEADER.counters + COUNTER.trigger] = trigger ? 1 : 0;
      if (params.chase !== undefined) chase(state, player, params.chase);
    },
  };
}

/** Parametry ovládání, které doplňky vyžadují (mince pro `+collect`), přes ty ze specu. */
export function addonControlParams(spec: GameSpecV1): Readonly<Record<string, unknown>> | undefined {
  const forced = piecesOf(spec).flatMap((piece) => (piece.controlParams === undefined ? [] : [piece.controlParams]));
  return forced.length === 0 ? spec.controlParams : Object.assign({}, spec.controlParams, ...forced);
}

const piecesOf = (spec: GameSpecV1): AddonPiece[] =>
  (spec.addons ?? []).map((id) => ADDON_PIECES[id]).filter((piece): piece is AddonPiece => piece !== undefined);

/** Životy od doplňků, když spec nemá mechaniku `health`. */
export function addonLives(spec: GameSpecV1): number | undefined {
  const lives = piecesOf(spec).flatMap((piece) => (piece.lives === undefined ? [] : [piece.lives]));
  return lives.length === 0 ? undefined : Math.max(...lives);
}

/** Aplikuje doplňky v pořadí `spec.addons` a obalí robota, pokud to některý chce. */
export function applyAddons(parts: ArcadeParts, context: AddonContext): ArcadeParts {
  const pieces = piecesOf(context.spec);
  let next = parts;
  for (const piece of pieces) if (piece.apply !== undefined) next = piece.apply(next, piece.params.parse({}), context);
  const botted = pieces.filter((piece) => piece.bot !== undefined).map((piece) => piece.id);
  if (botted.length === 0) return next;
  return { ...next, bot: { id: 'addon_bot', params: { base: next.bot, addons: botted } } };
}

const addonBotParams = z
  .object({
    base: z.object({ id: z.string(), params: z.record(z.string(), z.unknown()) }).strict(),
    // Bez doplňků jen u robota s akcemi (P46A).
    addons: z.array(z.enum(ADDONS)).max(3),
    abilities: abilityBotParams.optional(),
  })
  .strict();

/** Krok robota akcí (`abilities/bot.ts`); předává se zvenku kvůli kruhovému importu. `fire` = svět má doplněk `+shoot`. */
export type AbilityBotStep = (observation: ArcadeObservation, input: ArcadeInput, base: PieceRef, params: z.infer<typeof abilityBotParams>, fire: boolean) => ArcadeInput;

/** Obalí robota `addon_bot` s akcemi, nebo jim doplní obal, který už tam je. */
export function wrapBot(parts: ArcadeParts, abilities: z.infer<typeof abilityBotParams>): PieceRef {
  const params = parts.bot.id === 'addon_bot' ? parts.bot.params : { base: parts.bot, addons: [] };
  return { id: 'addon_bot', params: { ...params, abilities } };
}

/**
 * Robot s doplňky: základní robot rozhodne, doplňky v pořadí vstup upraví.
 * `bases` jsou roboti knihovny – předávají se zvenku, ať knihovna a doplňky
 * nemají kruhový import.
 */
export function makeAddonBot(bases: Readonly<Record<string, BotPiece>>, abilityStep?: AbilityBotStep): BotPiece<z.infer<typeof addonBotParams>> {
  return {
    id: 'addon_bot',
    params: addonBotParams,
    roles: ['player'],
    // Všichni základní roboti reagují s 8 tiky; obal musí vidět stejně staré stavy.
    reactionTicks: 8,
    cost: () => ({ bodies: 0, rules: 0 }),
    decide: (observation, params) => {
      const base = bases[params.base.id];
      if (base === undefined) throw new Error(`arcade: unknown bot ${params.base.id}`);
      const decided = base.decide(observation, paramsOf(base, params.base.params));
      let input = decided;
      for (const id of params.addons) {
        const step = ADDON_PIECES[id]?.bot;
        if (step !== undefined) input = step(observation, input, pacedBotBase(params.base, observation));
      }
      // Průběh (P45C R2): tah doplňku do jiného pruhu běžce ještě projde plánovačem pruhů – doplněk hrozby chování nevidí.
      const lanes = BUTTON.LEFT | BUTTON.RIGHT;
      const guarded = (input.buttons & lanes) === (decided.buttons & lanes) ? input : guardLanes(observation, params.base, input);
      // Akce hrdiny (P46A T6) až po plánovači pruhů: robot s připravenou akcí smí neuhnout.
      return params.abilities === undefined || abilityStep === undefined ? guarded : abilityStep(observation, guarded, pacedBotBase(params.base, observation), params.abilities, params.addons.includes('shoot'));
    },
  };
}
