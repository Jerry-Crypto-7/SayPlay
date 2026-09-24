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

import { ADDONS, type AddonId, type GameSpecV1 } from '@/play/spec';

import {
  ARCADE_LIMITS,
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
  type PieceRef,
  ROLE,
  type RulePiece,
  UNIT,
  bodyBase,
} from './contract';
import { GRAVITY } from './kernel';
import { FLAP } from './pieces/flap';
import { RUNNER } from './pieces/runner';
import { type Row, nextRow } from './pieces/runner-bot';
import { BULLET_LIFETIME, SHOOTER } from './pieces/shooter';
import { census } from './pieces/shots';

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

/** Základní ovládání pod obalem `addon_control` – doplněk po `+shoot` musí dál poznat běžce. */
const baseControl = (parts: ArcadeParts): PieceRef =>
  parts.control.id === 'addon_control' ? (parts.control.params as { base: PieceRef }).base : parts.control;

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

export const ADDON_RULES = { collect_count: collectCount, finish_collected: finishCollected } as const;

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
 * mezery trubky. Každý druhý úsek, ať mezi nimi zbude čas.
 */
function enemiesFor(control: string, level: ArcadeLevel): BodyInit[] {
  if (control === 'runner') {
    const rows = runnerRows(level);
    const zs = [...rows.keys()].sort((a, b) => a - b);
    return zs.slice(0, -1).flatMap((from, index) => {
      const to = zs[index + 1] as number;
      const free = [0, -1, 1].filter((lane) => !(rows.get(to) as Set<number>).has(lane));
      if (index % 2 === 1 || free.length === 0) return [];
      const z = Math.min(Math.floor((from + to) / 2) + 2500, to - 2000);
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
 * střílí ve směru pohybu na cokoli v ráně, jen když nic neletí.
 */
const shootStep: AddonBotStep = ({ state, player, recent }, input, base) => {
  if (recent.some((seen) => (seen.buttons & BUTTON.FIRE) !== 0)) return input;
  if (base.id === 'arena_bot' && census(state).projectiles > 0) return input;
  const p = bodyBase(player);
  const px = state[p + BODY.x] as number;
  const pz = (state[p + BODY.z] as number) + (state[p + BODY.vz] as number) * recent.length;
  let py = state[p + BODY.y] as number;
  const grounded = ((state[p + BODY.flags] as number) & FLAG.grounded) !== 0;
  if (base.id === 'runner_bot' && (px % RUNNER.laneWidth !== 0 || recent.some((seen) => (seen.buttons & (BUTTON.LEFT | BUTTON.RIGHT)) !== 0))) return input;
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
    if (!covered(state, i) && clearShot(state, player, from, i)) return { ...input, buttons: input.buttons | BUTTON.FIRE };
  }
  return input;
};

/**
 * `+shoot`: nepřátelé v cestě (aréna má svoje), blaster a tlačítko střelby
 * `FIRE`. Náraz do nepřítele je prohra, se životy ztráta života.
 */
export const shootAddon: AddonPiece<z.infer<typeof noParams>> = {
  id: 'shoot',
  params: noParams,
  apply: (parts, _params, { health }) => {
    const control = baseControl(parts).id;
    const enemies = enemiesFor(control, parts.level);
    // Nová těla jen na konec: index modelu (`kinds`), který si dřívější doplněk zapsal, se tak nepohne.
    const bodies = [...parts.level.bodies, ...enemies];
    const template = bodies.length;
    bodies.push({ role: 'projectile', kind: 'bullet', x: 0, y: 0, z: 0, w: SHOOTER.bulletSize, h: SHOOTER.bulletSize, d: SHOOTER.bulletSize, solid: false, template: true, lifetime: BULLET_LIFETIME });
    const foes = control === 'move_free' ? bodies.filter((body) => body.role === 'enemy').length : enemies.length;
    const rules: PieceRef[] = [
      ...parts.rules,
      { id: 'blaster', params: { template, aim: control === 'move_free' ? 'heading' : 'forward' } },
      { id: 'shot_hit', params: {} },
    ];
    // Aréna náraz do buňky řeší sama (`arena_eat`).
    if (control !== 'move_free') rules.push({ id: 'hit', params: { role: 'enemy', effect: health === undefined ? 'lose' : 'damage' } });
    return {
      ...parts,
      control: { id: 'addon_control', params: { base: baseControl(parts) } },
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

export const ADDON_PIECES: Readonly<Record<AddonId, AddonPiece | undefined>> = {
  lives: livesAddon as AddonPiece,
  collect: collectAddon as AddonPiece,
  shoot: shootAddon as AddonPiece,
  chaser: undefined,
};

const wrappedControlParams = z.object({ base: z.object({ id: z.string(), params: z.record(z.string(), z.unknown()) }).strict() }).strict();

/**
 * Ovládání s tlačítkem střelby: základní ovládání pohne hráčem, obal zapíše
 * `FIRE` do čítače `trigger`, odkud ho čte pravidlo `blaster`.
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
      state[HEADER.counters + COUNTER.trigger] = (input.buttons & BUTTON.FIRE) !== 0 ? 1 : 0;
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
    addons: z.array(z.enum(ADDONS)).min(1).max(3),
  })
  .strict();

/**
 * Robot s doplňky: základní robot rozhodne, doplňky v pořadí vstup upraví.
 * `bases` jsou roboti knihovny – předávají se zvenku, ať knihovna a doplňky
 * nemají kruhový import.
 */
export function makeAddonBot(bases: Readonly<Record<string, BotPiece>>): BotPiece<z.infer<typeof addonBotParams>> {
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
      let input = base.decide(observation, paramsOf(base, params.base.params));
      for (const id of params.addons) {
        const step = ADDON_PIECES[id]?.bot;
        if (step !== undefined) input = step(observation, input, params.base);
      }
      return input;
    },
  };
}
