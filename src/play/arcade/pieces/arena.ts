/**
 * Aréna (P25F, T4): volný pohyb po ploše, rosteš pojídáním menších a utíkáš
 * větším. Ovládání `move_free`, generátor `arena`, pravidla.
 *
 * Pohled shora, bez gravitace (hráč stojí na zemi a jen jezdí po `x/z`). Osa
 * nese **směr** pohybu: 32 směrů po 11,25°, osa 0 = stát (`arenaAxis` převede
 * směr na osu – tah, šipky i robot jdou přes ni). Směry jsou z celočíselné
 * tabulky, ne z `Math.sin`: stejný vstup musí dát stejný tik v každém prohlížeči.
 *
 * Velikost hráče je čítač: `size = start + score × grow` (strop `maxSize`),
 * skóre jen roste, takže růst je monotónní. Menší tělo (potrava, menší
 * buňka) sníst = skóre a zmizí; větší se dotkne = prohra, nebo se životy
 * ztráta života a návrat na start. Buňky jsou kinematické a vede je
 * ovládání (jádro jiné místo pro pohyb cizích těl nemá – Findings P25F):
 * větší než hráč pronásledují, menší bloudí a před hráčem utíkají.
 *
 * **Hratelné z konstrukce:** kolem startu leží věnec potravy a větší buňky
 * startují daleko – hladová cesta po nejbližší potravě vyroste nad první
 * větší buňku dřív, než k hráči dojede. `checkArenaLevel` to přepočítá.
 *
 * **Útěk a sběr (P32E T1)** jsou režimy téže arény (generátory `arena_escape`
 * a `arena_collect`, konec souboru): hráč pevné velikosti sbírá věci a v útěku
 * ho honí pronásledovatelé. Ovládání, pravidla i robot jsou tytéž kusy – nový
 * svět je pozná podle parametrů (`size`, `chase`, `grace`, `wake`), které agar
 * nikdy nenese, takže uložené agar hry mají parametry i hash beze změny.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_HZ,
  ARCADE_LIMITS,
  type ArcadeCounter,
  type ArcadeEffect,
  type ArcadeLevel,
  AXIS_MAX,
  BODY,
  BUTTON,
  type BodyInit,
  COUNTER,
  type ControlPiece,
  FLAG,
  type GeneratorPiece,
  HEADER,
  type ModeGeneratorPiece,
  type ModeParts,
  type PieceRef,
  ROLE,
  type RulePiece,
  UNIT,
  bodyBase,
} from '../contract';
import { guardParams, guardedHit } from '../abilities/state';
import { WAVE_LIMITS, WAVE_PLAN, collectClock, entrySpots, wavePositions, waveOf, waveSpeedStep, wavesChasers } from './waves';

export const ARENA_DENSITIES = ['sparse', 'normal', 'dense'] as const;
export type ArenaDensity = (typeof ARENA_DENSITIES)[number];
export const ARENA_GOALS = ['grow', 'survive'] as const;
export type ArenaGoal = (typeof ARENA_GOALS)[number];

export const ARENA = {
  /** Polovina strany čtvercové arény. */
  half: 20 * UNIT,
  /** Rychlost hráče (9 m/s) a jak rychle se rozjede a zastaví. */
  speed: 150,
  accel: 25,
  friction: 25,
  startSize: 1000,
  /** O kolik hráč vyroste za bod skóre, a nejvýš na kolik. */
  grow: 250,
  maxSize: 6000,
  height: 600,
  /** Buňky: větší pronásledují, menší bloudí a do `fleeRadius` od hráče utíkají. */
  hunterSpeed: 60,
  preySpeed: 45,
  fleeRadius: 4 * UNIT,
  /** Bloudící buňka mění směr každých tolik tiků (posunuto podle indexu). */
  wanderTicks: 90,
  /** Body za snědení. */
  pelletPoints: 1,
  preyPoints: 2,
  hunterPoints: 3,
  reactionTicks: 8,
} as const;

/**
 * Útěk a sběr (P32E T1). **Férový start** (29. 9.: čaroděj prohrál za 3,2 s,
 * pes chytil lišku za 3,5 s): pronásledovatelé startují za zády hráče (−z;
 * kamera stojí za ním a dívá se po +z) tak daleko, aby nečinného hráče
 * nedostihli dřív než za `idleContactTicks`, a celou ochranu `graceTicks` stojí.
 */
export const ESCAPE = {
  /** Ochrana na startu a po chycení se životem navíc: pronásledovatelé stojí, chycení neplatí. */
  graceTicks: 2 * ARCADE_HZ,
  /** Odhoz chyceného hráče se životy (P36A T2): dvojnásobek jeho rychlosti, třením dojede asi 2 m od pronásledovatele. */
  knockback: 2 * ARENA.speed,
  /** Nečinného hráče první pronásledovatel nesmí dostihnout dřív (UI audit 29. 9.). */
  idleContactTicks: 5 * ARCADE_HZ,
  /** Pronásledovatel startuje aspoň tolik procent poloviny strany arény od hráče. */
  minDistancePct: 40,
  /** Pevný a náhodný přídavek ke startovní vzdálenosti pronásledovatele nad férovou mez. */
  distanceMargin: 300,
  distanceJitter: UNIT,
  playerSize: ARENA.startSize,
  chasers: { min: 1, max: 4, default: 2 },
  /** Kolik věcí sebrat; 0 = útěk se vyhrává přežitím. */
  items: { max: 30, collectDefault: 10 },
  /** Výseč za zády: ± tolik směrů po 11,25° od přímého −z (směr 16); sousední pronásledovatelé aspoň `chaserSpacing` směrů od sebe. */
  backArc: 5,
  chaserSpacing: 2,
  chaserSize: 1200,
  chaserHeight: 1400,
  /** Rychlost pronásledovatele za tik – vždy pod hráčovou (`ARENA.speed`), jinak z něj nejde utéct. */
  chaserSpeed: { min: 50, max: 90, default: 70 },
  /**
   * Řízení (T2): předvídání nejvýš `lead` tiků, zrychlení za tik a osu (zatáčka
   * tedy trvá – hráč může kličkovat), sondy dopředu a odstup od ostatních.
   */
  lead: ARCADE_HZ / 2,
  chaserAccel: 6,
  probes: [UNIT, 2 * UNIT] as readonly number[],
  /** Kolik směrů po 11,25° na každou stranu sonda zkusí, než to vzdá. */
  probeTurns: 12,
  /** Odstup: od bližšího než `separation` tlačí až `separationPush` (tah za hráčem má 1000) – při dotyku převáží. */
  separation: 3 * UNIT,
  separationPush: 4000,
  /** Hlídka (P36A T8): na kolik jednotek strážný hráče zahlédne a začne honit; dál bloudí. */
  patrolSight: 7 * UNIT,
  itemSize: 500,
  /** Věc leží aspoň tak daleko od startu hráče, od místa pronásledovatele, od jiné věci a od stěny. */
  itemClearance: { start: 2 * UNIT, chaser: 5 * UNIT, item: 2 * UNIT, wall: UNIT },
} as const;

/**
 * Čítač ochrany: jediný, který v aréně nic jiného nečte – `cooldown` a `trigger`
 * patří střelbě doplňku `+shoot`, `items` pravidlům specu. Ovládání ho odpočítává,
 * `arena_eat` v něm chycení nepočítá a chycení se životem navíc ho znovu nabije.
 */
export const GRACE_COUNTER = 'reserve' satisfies ArcadeCounter;

/** Zbývající tiky ochrany. */
export const graceLeft = (state: Int32Array): number => state[HEADER.counters + COUNTER[GRACE_COUNTER]] as number;

// ---------------------------------------------------------------------------
// Směry

/** sin(k × 11,25°) × 1000 pro k = 0..8 (čtvrtina kruhu). */
const QUARTER = [0, 195, 383, 556, 707, 831, 924, 981, 1000] as const;
const sinOf = (k: number): number => {
  const i = ((k % 32) + 32) % 32;
  return i <= 8 ? QUARTER[i]! : i <= 16 ? QUARTER[16 - i]! : i <= 24 ? -QUARTER[i - 16]! : -QUARTER[32 - i]!;
};
/** Jednotkové směry × 1000: `dx = sin`, `dz = cos`; směr 0 míří po +z. */
export const DIRECTIONS: readonly { readonly dx: number; readonly dz: number }[] = Array.from({ length: 32 }, (_, k) => ({ dx: sinOf(k), dz: sinOf(k + 8) }));

/** Osa → směr 0..31, nebo −1 (stát). ±1000 = 180°. */
export function directionOfAxis(axis: number): number {
  if (axis === 0) return -1;
  const clamped = Math.max(-AXIS_MAX, Math.min(AXIS_MAX, axis));
  return (((Math.round((clamped * 16) / AXIS_MAX) % 32) + 32) % 32);
}

/** Směr (celočíselně: největší skalární součin) nejbližší vektoru `(dx, dz)`; nulový vektor = −1. */
export function directionToward(dx: number, dz: number): number {
  if (dx === 0 && dz === 0) return -1;
  let best = 0;
  let bestDot = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < 32; k += 1) {
    const dir = DIRECTIONS[k]!;
    const dot = dx * dir.dx + dz * dir.dz;
    if (dot > bestDot) {
      bestDot = dot;
      best = k;
    }
  }
  return best;
}

/** Směr → osa (0 → 1, protože osa 0 znamená stát). */
export function axisOfDirection(direction: number): number {
  if (direction < 0) return 0;
  if (direction === 0) return 1;
  return direction <= 16 ? Math.round((direction * AXIS_MAX) / 16) : Math.round(((direction - 32) * AXIS_MAX) / 16);
}

/** Osa pro pohyb po vektoru `(dx, dz)` jádra – tah, šipky, robot. */
export const arenaAxis = (dx: number, dz: number): number => axisOfDirection(directionToward(dx, dz));

export const sizeOf = (score: number): number => Math.min(ARENA.maxSize, ARENA.startSize + Math.max(0, score) * ARENA.grow);

/** Kolik bodů hráč potřebuje, aby byl větší než tělo velikosti `size`. */
export const pointsToBeat = (size: number): number => Math.max(0, Math.floor((size - ARENA.startSize) / ARENA.grow) + 1);

const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));

// ---------------------------------------------------------------------------
// Ovládání

export const chaseParams = z
  .object({
    speed: z.int().min(ESCAPE.chaserSpeed.min).max(ESCAPE.chaserSpeed.max),
    ceiling: z.int().min(90).max(140).optional(),
    /** Horizont předvídání v ticích: míří tam, kde hráč bude, nejvýš tak daleko dopředu. */
    lead: z.int().min(0).max(2 * ARCADE_HZ),
    /** Úkol (P32G G-R1): dokud hráč drží „Use“ (`BUTTON.INTERACT`), běží pronásledovatelé poloviční rychlostí. */
    slowWhileUse: z.boolean().optional(),
    /** Vlny (P36A T4): o kolik každá další vlna (`waveOf`) zrychlí, nejvýš na strop `ESCAPE.chaserSpeed`. */
    step: z.int().min(1).max(ESCAPE.chaserSpeed.max - ESCAPE.chaserSpeed.min).optional(),
    /** Hlídka (P36A T8): hráče dál než `patrol` jednotek nevidí – bloudí poloviční rychlostí; bez pole honí vždy. */
    patrol: z.int().min(UNIT).max(40 * UNIT).optional(),
  })
  .strict();
export type ChaseParams = z.infer<typeof chaseParams>;

/** Rychlost pronásledovatelů v běžící vlně; svět bez vln (`step`) jede stálou `speed`. */
export const chaseSpeedOf = (chase: ChaseParams, state: Int32Array): number =>
  chase.step === undefined ? chase.speed : Math.min(chase.ceiling ?? ESCAPE.chaserSpeed.max, chase.speed + chase.step * waveOf(state));

const controlParams = z
  .object({
    half: z.int().min(5 * UNIT).max(40 * UNIT).default(ARENA.half),
    /** Útěk a sběr: hráč má pevnou velikost; bez ní roste se skóre (agar). */
    size: z.int().min(ESCAPE.itemSize).max(ARENA.maxSize).optional(),
    /** Útěk: pronásledovatele vede ovládání a odpočítává ochranu (`GRACE_COUNTER`). */
    preySpeed: z.int().min(20).max(300).optional(),
    chase: chaseParams.optional(),
  })
  .strict();
export type ArenaControlParams = z.infer<typeof controlParams>;

/** Deterministický „náhodný“ směr bloudění z indexu a tiku (celá čísla, žádná náhoda za běhu). */
const wanderDirection = (index: number, tick: number): number => (((Math.imul(index + 1, 73_856_093) ^ Math.imul(Math.floor(tick / ARENA.wanderTicks) + 1, 19_349_663)) >>> 0) % 32);

/** Rychlost, která udrží tělo velikosti `size` v aréně (u stěny se složka otočí dovnitř). */
function bounce(position: number, velocity: number, size: number, half: number): number {
  const limit = half - Math.ceil(size / 2);
  if (position + velocity > limit) return -Math.abs(velocity);
  if (position + velocity < -limit) return Math.abs(velocity);
  return velocity;
}

function moveCells(state: Int32Array, player: number, half: number, preySpeed: number = ARENA.preySpeed): void {
  const count = state[HEADER.bodyCount] as number;
  const tick = state[HEADER.tick] as number;
  const p = bodyBase(player);
  const px = state[p + BODY.x] as number;
  const pz = state[p + BODY.z] as number;
  const psize = state[p + BODY.w] as number;
  for (let i = 0; i < count; i += 1) {
    if (i === player) continue;
    const base = bodyBase(i);
    const flags = state[base + BODY.flags] as number;
    if ((flags & (FLAG.alive | FLAG.kinematic)) !== (FLAG.alive | FLAG.kinematic) || state[base + BODY.role] !== ROLE.enemy) continue;
    const x = state[base + BODY.x] as number;
    const zz = state[base + BODY.z] as number;
    const size = state[base + BODY.w] as number;
    let direction: number;
    let speed: number;
    if (size > psize) {
      direction = directionToward(px - x, pz - zz);
      speed = ARENA.hunterSpeed;
    } else if (Math.abs(px - x) + Math.abs(pz - zz) < ARENA.fleeRadius) {
      direction = directionToward(x - px, zz - pz);
      speed = preySpeed;
    } else {
      direction = wanderDirection(i, tick + i * 7);
      speed = preySpeed;
    }
    const dir = direction < 0 ? { dx: 0, dz: 0 } : DIRECTIONS[direction]!;
    state[base + BODY.vx] = bounce(x, Math.trunc((dir.dx * speed) / 1000), size, half);
    state[base + BODY.vz] = bounce(zz, Math.trunc((dir.dz * speed) / 1000), size, half);
  }
}

/** Celočíselná délka vektoru (`Math.sqrt` je v IEEE 754 přesně zaokrouhlená – všude stejné číslo). */
const length = (dx: number, dz: number): number => Math.floor(Math.sqrt(dx * dx + dz * dz));

/** Pevná tělesa, kterým se pronásledovatel vyhne: `[x, z, w, d]` po čtveřicích. */
function solidsOf(state: Int32Array, count: number): number[] {
  const solids: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = bodyBase(i);
    if (((state[base + BODY.flags] as number) & (FLAG.alive | FLAG.solid)) !== (FLAG.alive | FLAG.solid)) continue;
    solids.push(state[base + BODY.x] as number, state[base + BODY.z] as number, state[base + BODY.w] as number, state[base + BODY.d] as number);
  }
  return solids;
}

/** Stojí by tělo `w × d` se středem `(x, z)` ve stěně arény nebo v pevném tělese? */
function blocked(x: number, zz: number, w: number, d: number, half: number, solids: readonly number[]): boolean {
  if (Math.abs(x) * 2 + w > half * 2 || Math.abs(zz) * 2 + d > half * 2) return true;
  for (let k = 0; k < solids.length; k += 4) {
    if (Math.abs(x - solids[k]!) * 2 < w + solids[k + 2]! && Math.abs(zz - solids[k + 1]!) * 2 < d + solids[k + 3]!) return true;
  }
  return false;
}

/**
 * Sondy dopředu: směr nejblíž chtěnému, ve kterém obě sondy leží volně. Když
 * tělo už zatáčí na jednu stranu (rychlost je jediná paměť řízení), prohledá
 * napřed celou tu stranu – podél stěny tak jede jedním směrem a v kapse
 * nekmitá. Z klidu vyhraje strana s menší zatáčkou. Všechno zavřené → chtěný směr.
 */
function probeDirection(direction: number, x: number, zz: number, w: number, d: number, vx: number, vz: number, half: number, solids: readonly number[]): number {
  const free = (k: number): boolean => ESCAPE.probes.every((reach) => !blocked(x + Math.trunc((DIRECTIONS[k]!.dx * reach) / 1000), zz + Math.trunc((DIRECTIONS[k]!.dz * reach) / 1000), w, d, half, solids));
  if (free(direction)) return direction;
  const want = DIRECTIONS[direction]!;
  const cross = vx * want.dz - vz * want.dx;
  const turned = (s: number, turn: number): number => (((direction + s * turn) % 32) + 32) % 32;
  const sides = cross === 0 ? [] : [cross < 0 ? -1 : 1];
  for (const s of sides) {
    for (let turn = 1; turn <= ESCAPE.probeTurns; turn += 1) if (free(turned(s, turn))) return turned(s, turn);
  }
  for (let turn = 1; turn <= ESCAPE.probeTurns; turn += 1) {
    for (const s of [1, -1]) if (free(turned(s, turn))) return turned(s, turn);
  }
  return direction;
}

/**
 * Pronásledovatelé útěku (P32E T1–T2): v ochraně stojí a ovládání ji odpočítá.
 * Pak celočíselné řízení: míří tam, kde hráč bude (nejvýš `lead` tiků dopředu),
 * odstupují od ostatních pronásledovatelů, sondami obcházejí stěny a pevná
 * tělesa a rychlost mění nejvýš o `chaserAccel` za tik a osu. Stav řízení je jen
 * rychlost těla – nic mimo snímek. Do stěny ani do tělesa nevjedou nikdy: složka
 * rychlosti, která by je tam zanesla, se vynuluje (klouzání podél).
 */
function steerChasers(state: Int32Array, player: number, half: number, chase: ChaseParams, buttons: number): void {
  const top = chaseSpeedOf(chase, state);
  const speed = chase.slowWhileUse === true && (buttons & BUTTON.INTERACT) !== 0 ? Math.trunc(top / 2) : top;
  const at = HEADER.counters + COUNTER[GRACE_COUNTER];
  const grace = state[at] as number;
  if (grace > 0) state[at] = grace - 1;
  const count = state[HEADER.bodyCount] as number;
  const tick = state[HEADER.tick] as number;
  const p = bodyBase(player);
  const px = state[p + BODY.x] as number;
  const pz = state[p + BODY.z] as number;
  const chasers: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const base = bodyBase(i);
    if (state[base + BODY.role] === ROLE.chaser && ((state[base + BODY.flags] as number) & FLAG.alive) !== 0) chasers.push(i);
  }
  const solids = grace > 0 || chasers.length === 0 ? [] : solidsOf(state, count);
  for (const i of chasers) {
    const base = bodyBase(i);
    if (grace > 0) {
      state[base + BODY.vx] = 0;
      state[base + BODY.vz] = 0;
      continue;
    }
    const x = state[base + BODY.x] as number;
    const zz = state[base + BODY.z] as number;
    const w = state[base + BODY.w] as number;
    const d = state[base + BODY.d] as number;
    const vx = state[base + BODY.vx] as number;
    const vz = state[base + BODY.vz] as number;
    // Předvídání: kam hráč dojde, než k němu pronásledovatel doběhne.
    // Hlídka (P36A T8): hráče mimo dohled nevidí – bloudí směrem z indexu a tiku (jako kořist agaru), poloviční rychlostí.
    const patrolling = chase.patrol !== undefined && length(px - x, pz - zz) > chase.patrol;
    const pace = patrolling ? Math.trunc(speed / 2) : speed;
    const ahead = Math.min(chase.lead, Math.floor(length(px - x, pz - zz) / top));
    const wx = px + (state[p + BODY.vx] as number) * ahead - x;
    const wz = pz + (state[p + BODY.vz] as number) * ahead - zz;
    const aim = Math.max(1, length(wx, wz));
    const wander = patrolling ? DIRECTIONS[wanderDirection(i, tick + i * 7)]! : null;
    let sx = wander === null ? Math.trunc((wx * 1000) / aim) : wander.dx;
    let sz = wander === null ? Math.trunc((wz * 1000) / aim) : wander.dz;
    // Odstup: od každého bližšího než `separation` tím silněji, čím je blíž. Ve vlnách (P36A T4)
    // u hráče neplatí – dva pronásledovatelé z opačných stran by se jinak zastavili těsně
    // před dotykem a stojícího hráče by nikdy nechytili. Svět bez vln jede jako dřív.
    const near = chase.step !== undefined && length(px - x, pz - zz) < ESCAPE.separation;
    for (const j of chasers) {
      if (j === i || near) continue;
      const other = bodyBase(j);
      const ox = x - (state[other + BODY.x] as number);
      const oz = zz - (state[other + BODY.z] as number);
      const gap = length(ox, oz);
      if (gap >= ESCAPE.separation) continue;
      const push = Math.trunc(((ESCAPE.separation - gap) * ESCAPE.separationPush) / ESCAPE.separation);
      // Na stejném místě rozhodne pořadí těl, ať se rozejdou na opačné strany.
      if (gap === 0) sx += j < i ? push : -push;
      else {
        sx += Math.trunc((ox * push) / gap);
        sz += Math.trunc((oz * push) / gap);
      }
    }
    const want = directionToward(sx, sz);
    const direction = want < 0 ? -1 : probeDirection(want, x, zz, w, d, vx, vz, half, solids);
    const dir = direction < 0 ? { dx: 0, dz: 0 } : DIRECTIONS[direction]!;
    let nvx = toward(vx, Math.trunc((dir.dx * pace) / 1000), ESCAPE.chaserAccel);
    let nvz = toward(vz, Math.trunc((dir.dz * pace) / 1000), ESCAPE.chaserAccel);
    // Zrychlení po osách by v zatáčce přetáhlo rychlost přes strop – zkrátit na `speed` (délka zaokrouhlená nahoru).
    // Zpomalení při „Use“ platí hned: strop stáhne i rozjetého pronásledovatele.
    const over = Math.ceil(Math.sqrt(nvx * nvx + nvz * nvz));
    if (over > pace) {
      nvx = Math.trunc((nvx * pace) / over);
      nvz = Math.trunc((nvz * pace) / over);
    }
    if (blocked(x + nvx, zz + nvz, w, d, half, solids)) {
      if (!blocked(x + nvx, zz, w, d, half, solids)) nvz = 0;
      else if (!blocked(x, zz + nvz, w, d, half, solids)) nvx = 0;
      else {
        nvx = 0;
        nvz = 0;
      }
    }
    state[base + BODY.vx] = nvx;
    state[base + BODY.vz] = nvz;
  }
}

/** Ovládání volného pohybu: osa = směr, velikost ze skóre (nebo pevná), hráč zůstane v aréně. */
export const moveFreeControl: ControlPiece<ArenaControlParams> = {
  id: 'move_free',
  params: controlParams,
  roles: ['player', 'enemy', 'collectible', 'chaser'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    const base = bodyBase(player);
    const size = params.size ?? sizeOf(state[HEADER.counters + COUNTER.score] as number);
    state[base + BODY.w] = size;
    state[base + BODY.d] = size;

    const direction = directionOfAxis(input.axis);
    const dir = direction < 0 ? null : DIRECTIONS[direction]!;
    const tx = dir === null ? 0 : Math.trunc((dir.dx * ARENA.speed) / 1000);
    const tz = dir === null ? 0 : Math.trunc((dir.dz * ARENA.speed) / 1000);
    const rate = dir === null ? ARENA.friction : ARENA.accel;
    const limit = params.half - Math.ceil(size / 2);
    const x = state[base + BODY.x] as number;
    const zz = state[base + BODY.z] as number;
    // Stěna arény: tělo se do ní nezaboří ani po růstu.
    const vx = toward(state[base + BODY.vx] as number, tx, rate);
    const vz = toward(state[base + BODY.vz] as number, tz, rate);
    state[base + BODY.vx] = Math.max(-limit - x, Math.min(limit - x, vx));
    state[base + BODY.vz] = Math.max(-limit - zz, Math.min(limit - zz, vz));

    moveCells(state, player, params.half, params.preySpeed);
    if (params.chase !== undefined) steerChasers(state, player, params.half, params.chase, input.buttons);
  },
};

// ---------------------------------------------------------------------------
// Pravidla

const eatParams = z
  .object({
    effect: z.enum(['lose', 'damage']),
    /** Útěk: dotek pronásledovatele mimo ochranu je chycení; se životy ho ochrana těchto tiků následuje. */
    grace: z.int().min(1).max(10 * ARCADE_HZ).optional(),
    /** Odhoz chyceného hráče od pronásledovatele, jednotek za tik (P36A T2); bez něj jako dřív. */
    knockback: z.int().min(1).max(ARENA.speed * 4).optional(),
    /** Dash a štít hrdiny (P46A T9): chycení pronásledovatelem v ochraně nic nevezme. */
    guard: guardParams.optional(),
  })
  .strict();

const touches = (state: Int32Array, a: number, b: number): boolean =>
  Math.abs((state[a + BODY.x] as number) - (state[b + BODY.x] as number)) * 2 < (state[a + BODY.w] as number) + (state[b + BODY.w] as number) &&
  Math.abs((state[a + BODY.z] as number) - (state[b + BODY.z] as number)) * 2 < (state[a + BODY.d] as number) + (state[b + BODY.d] as number);

/**
 * Chycení v útěku: v ochraně nic, jinak prohra, se životy život a nová ochrana.
 * Dva pronásledovatelé v témže tiku berou jeden život – chytá ten s nejnižším indexem.
 */
function caught(state: Int32Array, player: number, chaser: number, effect: 'lose' | 'damage', grace: number, knockback: number | undefined): readonly ArcadeEffect[] {
  if (graceLeft(state) > 0) return [];
  const p = bodyBase(player);
  for (let i = 0; i < chaser; i += 1) {
    const base = bodyBase(i);
    if (state[base + BODY.role] === ROLE.chaser && ((state[base + BODY.flags] as number) & FLAG.alive) !== 0 && touches(state, p, base)) return [];
  }
  if (effect === 'lose') return [{ kind: 'lose' }];
  const lost: ArcadeEffect[] = [
    { kind: 'damage', amount: 1 },
    { kind: 'count', counter: GRACE_COUNTER, amount: grace },
  ];
  if (knockback !== undefined) lost.push({ kind: 'knockback', body: chaser, speed: knockback });
  return lost;
}

/**
 * Dotek potravy nebo buňky: menší sníst (body podle druhu, zmizí), větší buňka
 * hráče sní (prohra, se životy ztráta života a návrat na start). Stejně velké
 * se minou. S `grace` (útěk) chytá i pronásledovatel; bez něj ho pravidlo míjí
 * jako dřív (doplněk `+chaser` má svoje `hit`).
 */
export const arenaEat: RulePiece<z.infer<typeof eatParams>> = {
  id: 'arena_eat',
  params: eatParams,
  roles: ['player', 'enemy', 'collectible', 'chaser'],
  trigger: 'contact',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player, other }, params): readonly ArcadeEffect[] => {
    const role = state[bodyBase(other) + BODY.role];
    if (role === ROLE.chaser && params.grace !== undefined) return guardedHit(state, params.guard, other, [...caught(state, player, other, params.effect, params.grace, params.knockback)]);
    if (role !== ROLE.enemy && role !== ROLE.collectible) return [];
    const mine = state[bodyBase(player) + BODY.w] as number;
    const theirs = state[bodyBase(other) + BODY.w] as number;
    if (theirs < mine) {
      const points = role === ROLE.collectible ? ARENA.pelletPoints : theirs >= ARENA.startSize ? ARENA.hunterPoints : ARENA.preyPoints;
      return [
        { kind: 'score', amount: points },
        { kind: 'despawn', body: other },
      ];
    }
    if (theirs > mine && role === ROLE.enemy) return params.effect === 'lose' ? [{ kind: 'lose' }] : [{ kind: 'damage', amount: 1 }, { kind: 'respawn' }];
    return [];
  },
};

/**
 * Probuzení (P32E T1): když ochrana doběhne, každý spící pronásledovatel úrovně
 * zmizí a na jeho místě stojí kopie od `spawnBase`, která honí. Sběrnice efektů
 * tak vydá `spawn` a scéna ukáže zřetelné probuzení. Kopie už pod `spawnBase`
 * nejsou, takže se probouzí jednou.
 */
function wakeChasers(state: Int32Array): ArcadeEffect[] {
  if (graceLeft(state) !== 0) return [];
  const effects: ArcadeEffect[] = [];
  for (let i = 0; i < (state[HEADER.spawnBase] as number); i += 1) {
    const base = bodyBase(i);
    if (state[base + BODY.role] !== ROLE.chaser || ((state[base + BODY.flags] as number) & FLAG.alive) === 0) continue;
    const x = state[base + BODY.x] as number;
    const y = state[base + BODY.y] as number;
    const zz = state[base + BODY.z] as number;
    effects.push({ kind: 'despawn', body: i }, { kind: 'spawn', template: i, x, y, z: zz, vx: 0, vy: 0, vz: 0 });
  }
  return effects;
}

const growToParams = z.object({ points: z.int().min(1).max(100), wake: z.literal(true).optional() }).strict();

/** Skóre (= velikost, v útěku sebrané věci) dosáhlo cíle → výhra. S `wake` probouzí pronásledovatele. */
export const growTo: RulePiece<z.infer<typeof growToParams>> = {
  id: 'grow_to',
  params: growToParams,
  roles: ['player'],
  trigger: 'counter',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params) => {
    const woken = params.wake === true ? wakeChasers(state) : [];
    return (state[HEADER.counters + COUNTER.score] as number) >= params.points ? [...woken, { kind: 'win' }] : woken;
  },
};

const surviveParams = z.object({ seconds: z.int().min(10).max(90), wake: z.literal(true).optional() }).strict();

/** Přežil do limitu → výhra (opak `time_limit`). S `wake` probouzí pronásledovatele. */
export const surviveTime: RulePiece<z.infer<typeof surviveParams>> = {
  id: 'survive_time',
  params: surviveParams,
  roles: ['player'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state }, params) => {
    const woken = params.wake === true ? wakeChasers(state) : [];
    return (state[HEADER.tick] as number) + 1 >= params.seconds * ARCADE_HZ ? [...woken, { kind: 'win' }] : woken;
  },
};

// ---------------------------------------------------------------------------
// Generátor

interface Tier {
  readonly pellets: number;
  readonly prey: number;
  readonly hunters: number;
  readonly hunterSize: readonly [number, number];
}

const TIERS: Readonly<Record<ArenaDensity, Tier>> = {
  sparse: { pellets: 26, prey: 4, hunters: 2, hunterSize: [1400, 2200] },
  normal: { pellets: 36, prey: 6, hunters: 3, hunterSize: [1500, 2500] },
  dense: { pellets: 50, prey: 8, hunters: 4, hunterSize: [1600, 2700] },
};

export const ARENA_LEVEL = {
  /** Věnec potravy kolem startu. */
  ringRadius: [2000, 4500] as const,
  /** Větší buňky startují aspoň tak daleko od středu. */
  hunterDistance: 16 * UNIT,
  /** Menší buňky aspoň tak daleko. */
  preyDistance: 6 * UNIT,
  preySize: [500, 850] as const,
  pelletSize: 400,
  /** Hladová cesta k růstu smí trvat nejvýš tenhle podíl doby, za kterou dorazí první větší. */
  growMargin: 0.7,
  /** Cíl růstu: tolik bodů nad největší buňku. */
  targetExtra: 3,
} as const;

const generatorParams = z
  .object({
    density: z.enum(ARENA_DENSITIES).default('normal'),
    goal: z.enum(ARENA_GOALS).default('grow'),
    seconds: z.int().min(20).max(80).default(40),
  })
  .strict();
export type ArenaParams = z.infer<typeof generatorParams>;

const cell = (role: 'enemy' | 'collectible', kind: string, x: number, zz: number, size: number): BodyInit => ({
  role,
  kind,
  x,
  y: 0,
  z: zz,
  w: size,
  h: role === 'enemy' ? ARENA.height : 200,
  d: size,
  solid: false,
  ...(role === 'enemy' ? { kinematic: true } : {}),
});

export const arenaLevel: GeneratorPiece<ArenaParams> = {
  id: 'arena',
  params: generatorParams,
  roles: ['player', 'enemy', 'collectible'],
  cost: (params) => {
    const tier = TIERS[params.density];
    return { bodies: 1 + tier.pellets + tier.prey + tier.hunters, rules: 3 };
  },
  generate: (seed, params) => {
    const rng = createCompileRng(seed);
    const tier = TIERS[params.density];
    const { half } = ARENA;
    const bodies: BodyInit[] = [{ role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: ARENA.startSize, h: ARENA.height, d: ARENA.startSize, solid: false }];

    const hunterSizes = Array.from({ length: tier.hunters }, () => 2 * rng.int(tier.hunterSize[0] / 2, tier.hunterSize[1] / 2));
    // Věnec: tolik potravy, kolik je potřeba přerůst největší buňku, + rezerva.
    const ring = pointsToBeat(Math.max(...hunterSizes)) + 2;
    for (let k = 0; k < ring; k += 1) {
      const angle = (k * 32) / ring;
      const dir = DIRECTIONS[Math.floor(angle) % 32]!;
      const radius = rng.int(ARENA_LEVEL.ringRadius[0], ARENA_LEVEL.ringRadius[1]);
      bodies.push(cell('collectible', 'food', Math.trunc((dir.dx * radius) / 1000), Math.trunc((dir.dz * radius) / 1000), ARENA_LEVEL.pelletSize));
    }
    // Menší buňky (index hned za věncem) a zbytek potravy po celé aréně.
    for (let k = 0; k < tier.prey; k += 1) {
      const size = 2 * rng.int(ARENA_LEVEL.preySize[0] / 2, ARENA_LEVEL.preySize[1] / 2);
      const edge = half - size;
      for (;;) {
        const x = rng.int(-edge, edge);
        const zz = rng.int(-edge, edge);
        if (x * x + zz * zz >= ARENA_LEVEL.preyDistance ** 2) {
          bodies.push(cell('enemy', 'cell', x, zz, size));
          break;
        }
      }
    }
    const edge = half - ARENA_LEVEL.pelletSize;
    for (let k = ring; k < tier.pellets; k += 1) bodies.push(cell('collectible', 'food', rng.int(-edge, edge), rng.int(-edge, edge), ARENA_LEVEL.pelletSize));

    // Větší buňky až nad hotovou potravou: tak daleko, aby hladová cesta vyrostla
    // nad každou dřív, než dojede (`checkArenaLevel`); nejde-li to náhodně, roh.
    const pending: ArcadeLevel = { bodies, length: 0 };
    for (const size of hunterSizes) {
      const far = half - size;
      const grow = greedyGrowTicks(pending, pointsToBeat(size));
      const reach = Math.max(ARENA_LEVEL.hunterDistance, Math.ceil((grow / ARENA_LEVEL.growMargin + 1) * ARENA.hunterSpeed + (size + ARENA.startSize) / 2));
      let placed: BodyInit | null = null;
      for (let attempt = 0; attempt < 64 && placed === null; attempt += 1) {
        const x = rng.int(-far, far);
        const zz = rng.int(-far, far);
        if (x * x + zz * zz >= reach * reach) placed = cell('enemy', 'cell', x, zz, size);
      }
      bodies.push(placed ?? cell('enemy', 'cell', rng.int(0, 1) === 0 ? -far : far, rng.int(0, 1) === 0 ? -far : far, size));
    }
    return { bodies, length: 0 };
  },
};

/** Cíl růstu: větší než největší buňka a ještě `targetExtra` bodů. */
export function arenaTarget(level: ArcadeLevel): number {
  const largest = Math.max(ARENA.startSize, ...level.bodies.filter((b) => b.role === 'enemy').map((b) => b.w));
  return Math.min(pointsToBeat(ARENA.maxSize - 1), pointsToBeat(largest) + ARENA_LEVEL.targetExtra);
}

export function arenaControlRef(): PieceRef {
  return { id: 'move_free', params: { half: ARENA.half } };
}

export function arenaBotRef(): PieceRef {
  return { id: 'arena_bot', params: { half: ARENA.half } };
}

/** Pravidla arény: jíst a být sněden, výhra růstem nebo přežitím; se životy prohra až po posledním. */
export function arenaRules(level: ArcadeLevel, params: Pick<ArenaParams, 'goal' | 'seconds'>, health?: number): PieceRef[] {
  const rules: PieceRef[] = [{ id: 'arena_eat', params: { effect: health === undefined ? 'lose' : 'damage' } }];
  rules.push(params.goal === 'grow' ? { id: 'grow_to', params: { points: arenaTarget(level) } } : { id: 'survive_time', params: { seconds: params.seconds } });
  if (health !== undefined) rules.push({ id: 'out_of_health', params: {} });
  return rules;
}

// ---------------------------------------------------------------------------
// Kontrola hratelnosti

const distance = (a: { readonly x: number; readonly z: number }, b: { readonly x: number; readonly z: number }): number => Math.hypot(a.x - b.x, a.z - b.z);

/**
 * Hladová cesta od startu po nejbližší potravě: kolik tiků trvá sníst `points`
 * bodů (plnou rychlostí, s reakcí na každé sousto). Nekonečno, když potrava nestačí.
 */
export function greedyGrowTicks(level: ArcadeLevel, points: number): number {
  const player = level.bodies[0]!;
  const food = level.bodies.filter((b) => b.role === 'collectible');
  let at = { x: player.x, z: player.z };
  let ticks = 0;
  for (let eaten = 0; eaten < points; eaten += 1) {
    let best = -1;
    for (let i = 0; i < food.length; i += 1) if (best < 0 || distance(at, food[i]!) < distance(at, food[best]!)) best = i;
    if (best < 0) return Number.POSITIVE_INFINITY;
    const next = food.splice(best, 1)[0]!;
    ticks += Math.ceil(distance(at, next) / ARENA.speed) + ARENA.reactionTicks;
    at = { x: next.x, z: next.z };
  }
  return ticks;
}

/** Za kolik tiků dojede větší buňka ke startu (vzdálenost okrajů / její rychlost). */
export const hunterArrivalTicks = (level: ArcadeLevel, hunter: BodyInit): number => {
  const player = level.bodies[0]!;
  return Math.floor((distance(player, hunter) - (hunter.w + player.w) / 2) / ARENA.hunterSpeed);
};

/** Tvrzení „hratelné z konstrukce“ nad hotovou arénou; prázdné pole = hratelná. */
export function checkArenaLevel(level: ArcadeLevel, half: number = ARENA.half): string[] {
  const issues: string[] = [];
  const m = (units: number): string => `${(units / UNIT).toFixed(1)} m`;
  const player = level.bodies[0];
  if (player === undefined || player.role !== 'player') return ['no player'];
  for (const body of level.bodies) {
    if (Math.abs(body.x) + body.w / 2 > half || Math.abs(body.z) + body.d / 2 > half) issues.push(`a ${body.kind} at ${m(body.x)}, ${m(body.z)} sits outside the arena`);
  }
  const cells = level.bodies.filter((b) => b.role === 'enemy');
  const hunters = cells.filter((b) => b.w > player.w);
  if (hunters.length === 0) issues.push('no bigger cell – nothing to run from');
  for (const prey of cells.filter((b) => b.w <= player.w)) if (distance(prey, player) < ARENA_LEVEL.preyDistance) issues.push(`a smaller cell starts ${m(distance(prey, player))} from the player`);

  // Vyrůst nad první větší buňku dřív, než dojede.
  const first = [...hunters].sort((a, b) => hunterArrivalTicks(level, a) - hunterArrivalTicks(level, b))[0];
  if (first !== undefined) {
    const grow = greedyGrowTicks(level, pointsToBeat(first.w));
    const arrive = hunterArrivalTicks(level, first);
    if (grow > ARENA_LEVEL.growMargin * arrive) issues.push(`growing past the first hunter takes ${grow} ticks but it arrives in ${arrive}`);
  }
  // Na výhru růstem musí potrava (bez buněk) stačit.
  const food = level.bodies.filter((b) => b.role === 'collectible').length * ARENA.pelletPoints;
  if (food < arenaTarget(level)) issues.push(`only ${food} points of food for a target of ${arenaTarget(level)}`);
  if (level.bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}

// ---------------------------------------------------------------------------
// Útěk a sběr (P32E T1)

/**
 * Nejbližší start pronásledovatele, ze kterého nečinného hráče nedostihne dřív
 * než za `idleContactTicks`: celou ochranu stojí, pak ujede nejvýš `speed` za
 * tik a dotyk AABB nastane nejdál na úhlopříčce součtu polovin.
 */
export const fairReach = (speed: number, player: Pick<BodyInit, 'w' | 'd'>, chaser: Pick<BodyInit, 'w' | 'd'>): number =>
  (ESCAPE.idleContactTicks - ESCAPE.graceTicks) * speed + Math.ceil(Math.hypot((player.w + chaser.w) / 2, (player.d + chaser.d) / 2));

/** Věcí na zemi: cíl + rezerva, ať poslední nemusí hráč lovit v rohu u pronásledovatele. */
const itemCount = (items: number): number => (items === 0 ? 0 : items + 2 + Math.floor(items / 4));

/**
 * Otevřená aréna: hráč uprostřed, pronásledovatelé za jeho zády (směry 16 ±
 * `backArc`, −z) na férové vzdálenosti, věci rozeseté s odstupem od startu,
 * od pronásledovatelů, od sebe a od stěny. Vzdálenosti celočíselně na druhou.
 */
function openArena(seed: number, chasers: number, speed: number, items: number, count: number = itemCount(items)): ArcadeLevel {
  const rng = createCompileRng(seed);
  const player: BodyInit = { role: 'player', kind: 'player', x: 0, y: 0, z: 0, w: ESCAPE.playerSize, h: ARENA.height, d: ESCAPE.playerSize, solid: false };
  const bodies: BodyInit[] = [player];
  const directions: number[] = [];
  while (directions.length < chasers) {
    const k = 16 + rng.int(-ESCAPE.backArc, ESCAPE.backArc);
    if (directions.every((taken) => Math.abs(taken - k) >= ESCAPE.chaserSpacing)) directions.push(k);
  }
  const size = { w: ESCAPE.chaserSize, d: ESCAPE.chaserSize };
  for (const k of directions) {
    const reach = fairReach(speed, player, size) + ESCAPE.distanceMargin + rng.int(0, ESCAPE.distanceJitter);
    const dir = DIRECTIONS[k]!;
    bodies.push({ role: 'chaser', kind: 'chaser', x: Math.trunc((dir.dx * reach) / 1000), y: 0, z: Math.trunc((dir.dz * reach) / 1000), ...size, h: ESCAPE.chaserHeight, solid: false, kinematic: true });
  }
  const starts = bodies.slice(1);
  const edge = ARENA.half - ESCAPE.itemSize / 2 - ESCAPE.itemClearance.wall;
  const far = (x: number, zz: number, from: { readonly x: number; readonly z: number }, gap: number): boolean => (x - from.x) ** 2 + (zz - from.z) ** 2 >= gap * gap;
  const placed: BodyInit[] = [];
  for (let k = 0; k < count; k += 1) {
    // Místa je dost (39 věcí po 2 m v aréně 38 × 38 m); strop pokusů jen pojistka, chybějící věc nahlásí kontrola.
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const x = rng.int(-edge, edge);
      const zz = rng.int(-edge, edge);
      if (!far(x, zz, player, ESCAPE.itemClearance.start) || !starts.every((c) => far(x, zz, c, ESCAPE.itemClearance.chaser)) || !placed.every((i) => far(x, zz, i, ESCAPE.itemClearance.item))) continue;
      placed.push({ role: 'collectible', kind: 'item', x, y: 0, z: zz, w: ESCAPE.itemSize, h: 200, d: ESCAPE.itemSize, solid: false });
      break;
    }
  }
  bodies.push(...placed);
  return chasers === 0 ? { bodies, length: 0 } : { bodies, length: 0, spawnSlots: chasers, counters: { [GRACE_COUNTER]: ESCAPE.graceTicks } };
}

/** Tvrzení „férové a hratelné z konstrukce“ nad útěkem nebo sběrem; prázdné pole = hratelná. */
export function checkEscapeLevel(level: ArcadeLevel, params: { readonly items: number; readonly chaserSpeed: number }): string[] {
  const issues: string[] = [];
  const m = (units: number): string => `${(units / UNIT).toFixed(1)} m`;
  const player = level.bodies[0];
  if (player === undefined || player.role !== 'player') return ['no player'];
  for (const body of level.bodies) {
    if (Math.abs(body.x) + body.w / 2 > ARENA.half || Math.abs(body.z) + body.d / 2 > ARENA.half) issues.push(`a ${body.kind} at ${m(body.x)}, ${m(body.z)} sits outside the arena`);
  }
  const least = (ARENA.half * ESCAPE.minDistancePct) / 100;
  // Předloha pronásledovatelů dalších vln (sběr ve vlnách) na startu neběží.
  for (const chaser of level.bodies.filter((body) => body.role === 'chaser' && body.template !== true)) {
    const gap = distance(chaser, player);
    if (chaser.z >= player.z) issues.push(`a chaser at ${m(chaser.x)}, ${m(chaser.z)} starts in front of the player, not behind`);
    const fair = Math.max(least, fairReach(params.chaserSpeed, player, chaser));
    if (gap < fair) issues.push(`a chaser starts ${m(gap)} from the player but needs ${m(fair)} to give an idle player 5 s`);
  }
  const items = level.bodies.filter((body) => body.role === 'collectible');
  if (items.length < params.items) issues.push(`only ${items.length} items for a target of ${params.items}`);
  for (const item of items) if (distance(item, player) < ESCAPE.itemClearance.start) issues.push(`an item starts ${m(distance(item, player))} from the player`);
  if (level.bodies.length + (level.spawnSlots ?? 0) > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}

const escapeParams = z
  .object({
    entryDistance: z.int().min(6000).max(20000).optional(),
    chaseLead: z.int().min(0).max(2 * ARCADE_HZ).optional(),
    pursuitCeiling: z.int().min(90).max(140).optional(),
    itemSizePct: z.int().min(100).max(150).optional(),
    chasers: z.int().min(ESCAPE.chasers.min).max(ESCAPE.chasers.max).default(ESCAPE.chasers.default),
    chaserSpeed: z.int().min(ESCAPE.chaserSpeed.min).max(ESCAPE.chaserSpeed.max).default(ESCAPE.chaserSpeed.default),
    items: z.int().min(0).max(ESCAPE.items.max).default(0),
    seconds: z.int().min(20).max(80).default(40),
    /** Vlny (P36A T4, píše je žánr): `items` věcí v každé vlně, nebo přežití rozdělené na vlny; bez nich jako dřív. */
    waves: z.int().min(2).max(WAVE_LIMITS.waves).optional(),
    /** Hlídka (P36A T8, píše žánr): pronásledovatelé honí až hráče v dohledu (`ChaseParams.patrol`). */
    patrol: z.int().min(UNIT).max(40 * UNIT).optional(),
  })
  .strict().superRefine((params, context) => {
    if (params.entryDistance !== undefined && params.waves === undefined) context.addIssue({ code: 'custom', path: ['entryDistance'], message: 'entryDistance requires reinforcement waves' });
  });
export type EscapeParams = z.infer<typeof escapeParams>;

interface WaveSetup {
  readonly entryDistance?: number;
  readonly chaseLead?: number;
  readonly pursuitCeiling?: number;
  readonly itemSizePct?: number;
  /** Pronásledovatelů na startu (sběr 0) a jejich rychlost v první vlně. */
  readonly chasers: number;
  readonly speed: number;
  /** Věcí v každé vlně; 0 = přežití `seconds` sekund. */
  readonly items: number;
  readonly seconds: number;
  readonly waves: number;
  readonly patrol?: number;
}

/** Sběr nemá na startu pronásledovatele: předloha těch z dalších vln leží mrtvá za zády hráče. */
const chaserTemplate: BodyInit = { role: 'chaser', kind: 'chaser', x: 0, y: 0, z: ESCAPE.chaserSize - ARENA.half, w: ESCAPE.chaserSize, h: ESCAPE.chaserHeight, d: ESCAPE.chaserSize, solid: false, kinematic: true, template: true };

/** První vlna: přesně `items` věcí (bez rezervy – vlna končí poslední sebranou), u sběru předloha pronásledovatele. */
function waveLevel(seed: number, setup: WaveSetup): ArcadeLevel {
  const original = openArena(seed, setup.chasers, setup.speed, setup.items, setup.items);
  const level = setup.itemSizePct === undefined ? original : { ...original, bodies: original.bodies.map(body => body.role === 'collectible' ? { ...body, w: Math.round(body.w * setup.itemSizePct! / 100), d: Math.round(body.d * setup.itemSizePct! / 100) } : body) };
  // Sloty pro probuzené a nové pronásledovatele (nejvýš `chasers.max`) a pro věci jedné vlny.
  return { ...level, bodies: setup.chasers === 0 ? [...level.bodies, chaserTemplate] : level.bodies, spawnSlots: ESCAPE.chasers.max + setup.items };
}

/**
 * Útěk a sběr ve vlnách (P36A T4). Vlna věcí přijde, až hráč sebere všechny
 * z předchozí (přežití: na třetinách času); pronásledovatelé v každé další
 * běží o `step` rychleji a každá druhá jich přivede víc (`wavesChasers`, sběr
 * začíná bez nich). Místa věcí a vstupů losuje stream `spawn`, takže první
 * vlna leží jako dřív. Sběr má hodiny: nečinný hráč prohraje, robot je
 * stihne s rezervou.
 */
function waveParts(seed: number, setup: WaveSetup, health: number | undefined): ModeParts {
  const { chasers, speed, items, waves } = setup;
  const level = waveLevel(seed, setup);
  const rng = createCompileRng(seed, 'spawn');
  const spots = entrySpots(rng, ARENA.half - ESCAPE.chaserSize);
  const edge = ARENA.half - ESCAPE.itemSize / 2 - WAVE_PLAN.itemInset;
  const chase: ChaseParams = { speed, lead: setup.chaseLead ?? ESCAPE.lead, step: setup.pursuitCeiling === undefined ? waveSpeedStep(waves) : Math.min(40, Math.ceil((setup.pursuitCeiling - speed) / 2)), ...(setup.pursuitCeiling === undefined ? {} : { ceiling: setup.pursuitCeiling }), ...(setup.patrol === undefined ? {} : { patrol: setup.patrol }) };
  const later = Array.from({ length: waves - 1 }, (_, k) => ({
    ...(items > 0 ? { items: wavePositions(rng, items, edge, ESCAPE.itemClearance.item) } : { at: Math.round(((k + 1) * setup.seconds * ARCADE_HZ) / waves) }),
    chasers: wavesChasers(chasers, k + 1) - wavesChasers(chasers, k),
  }));
  const rules: PieceRef[] = [
    { id: 'arena_eat', params: health === undefined ? { effect: 'lose', grace: ESCAPE.graceTicks } : { effect: 'damage', grace: ESCAPE.graceTicks, knockback: ESCAPE.knockback } },
    items > 0 ? { id: 'grow_to', params: { points: items * waves, ...(chasers > 0 ? { wake: true } : {}) } } : { id: 'survive_time', params: { seconds: setup.seconds, wake: true } },
  ];
  if (chasers === 0) rules.push({ id: 'time_limit', params: { seconds: collectClock(items, waves) } });
  if (health !== undefined) rules.push({ id: 'out_of_health', params: {} });
  // Předlohy: první věc leží za pronásledovateli, pronásledovatel je první tělo za hráčem (u sběru mrtvá předloha na konci).
  const template = { item: 1 + chasers, chaser: chasers === 0 ? level.bodies.length - 1 : 1 };
  rules.push({ id: 'arena_waves', params: { until: items > 0 ? 'items' : 'ticks', ...(items > 0 ? { item: template.item } : {}), chaser: template.chaser, spots, waves: later, ...(setup.entryDistance === undefined ? {} : { entryDistance: setup.entryDistance }) } });
  return {
    control: { id: 'move_free', params: { half: ARENA.half, size: ESCAPE.playerSize, chase } },
    bot: { id: 'arena_bot', params: { half: ARENA.half, chase } },
    level,
    rules,
    issues: checkEscapeLevel(level, { items, chaserSpeed: speed }),
    ...(chasers === 0 ? { health } : {}),
  };
}

/** Režim `arena.escape`: sbírej N věcí (nebo přežij N s), než tě pronásledovatelé chytí; s `waves` ve vlnách. */
export const arenaEscape: ModeGeneratorPiece<EscapeParams> = {
  id: 'arena_escape',
  params: escapeParams,
  roles: ['player', 'chaser', 'collectible'],
  cost: (params) => ({ bodies: 1 + 2 * params.chasers + itemCount(params.items), rules: 3 }),
  generate: (seed, params) =>
    params.waves === undefined ? openArena(seed, params.chasers, params.chaserSpeed, params.items) : waveLevel(seed, { chasers: params.chasers, speed: params.chaserSpeed, items: params.items, seconds: params.seconds, waves: params.waves, ...(params.pursuitCeiling === undefined ? {} : { pursuitCeiling: params.pursuitCeiling }), ...(params.entryDistance === undefined ? {} : { entryDistance: params.entryDistance }), ...(params.chaseLead === undefined ? {} : { chaseLead: params.chaseLead }), ...(params.itemSizePct === undefined ? {} : { itemSizePct: params.itemSizePct }) }),
  parts: (seed, params, health) => {
    const patrol = params.patrol === undefined ? {} : { patrol: params.patrol };
    if (params.waves !== undefined) return waveParts(seed, { chasers: params.chasers, speed: params.chaserSpeed, items: params.items, seconds: params.seconds, waves: params.waves, ...patrol, ...(params.pursuitCeiling === undefined ? {} : { pursuitCeiling: params.pursuitCeiling }), ...(params.entryDistance === undefined ? {} : { entryDistance: params.entryDistance }), ...(params.chaseLead === undefined ? {} : { chaseLead: params.chaseLead }), ...(params.itemSizePct === undefined ? {} : { itemSizePct: params.itemSizePct }) }, health);
    const level = arenaEscape.generate(seed, params);
    const chase: ChaseParams = { speed: params.chaserSpeed, lead: params.chaseLead ?? ESCAPE.lead, ...patrol };
    const rules: PieceRef[] = [
      { id: 'arena_eat', params: health === undefined ? { effect: 'lose', grace: ESCAPE.graceTicks } : { effect: 'damage', grace: ESCAPE.graceTicks, knockback: ESCAPE.knockback } },
      params.items > 0 ? { id: 'grow_to', params: { points: params.items, wake: true } } : { id: 'survive_time', params: { seconds: params.seconds, wake: true } },
    ];
    if (health !== undefined) rules.push({ id: 'out_of_health', params: {} });
    return {
      control: { id: 'move_free', params: { half: ARENA.half, size: ESCAPE.playerSize, chase } },
      bot: { id: 'arena_bot', params: { half: ARENA.half, chase } },
      level,
      rules,
      issues: checkEscapeLevel(level, params),
    };
  },
};

const collectParams = z
  .object({
    pursuitCeiling: z.int().min(90).max(140).optional(),
    itemSizePct: z.int().min(100).max(150).optional(),
    items: z.int().min(1).max(ESCAPE.items.max).default(ESCAPE.items.collectDefault),
    /** Vlny (P36A T4, píše je žánr): `items` věcí v každé vlně, pronásledovatelé od druhé, hodiny; bez nich jako dřív. */
    waves: z.int().min(2).max(WAVE_LIMITS.waves).optional(),
  })
  .strict();
export type CollectParams = z.infer<typeof collectParams>;

const collectSetup = (items: number, waves: number, params: Pick<CollectParams, 'pursuitCeiling' | 'itemSizePct'>): WaveSetup => ({ chasers: 0, speed: WAVE_PLAN.collectSpeed, items, seconds: 0, waves, ...(params.pursuitCeiling === undefined ? {} : { pursuitCeiling: params.pursuitCeiling }), ...(params.itemSizePct === undefined ? {} : { itemSizePct: params.itemSizePct }) });

/**
 * Režim `arena.collect`: sbírej N věcí, v první vlně tě nikdo nehoní. Ve vlnách
 * (P36A T4) od druhé vbíhají pronásledovatelé a hodiny dají prohrát i hráči,
 * který stojí; bez vln jako dřív (životy svět nese, ale nic je nebere).
 */
export const arenaCollect: ModeGeneratorPiece<CollectParams> = {
  id: 'arena_collect',
  params: collectParams,
  roles: ['player', 'collectible'],
  cost: (params) => ({ bodies: 1 + itemCount(params.items), rules: 2 }),
  generate: (seed, params) => (params.waves === undefined ? openArena(seed, 0, 0, params.items) : waveLevel(seed, collectSetup(params.items, params.waves, params))),
  parts: (seed, params, health) => {
    if (params.waves !== undefined) return waveParts(seed, collectSetup(params.items, params.waves, params), health);
    const level = arenaCollect.generate(seed, params);
    const rules: PieceRef[] = [
      { id: 'arena_eat', params: { effect: health === undefined ? 'lose' : 'damage' } },
      { id: 'grow_to', params: { points: params.items } },
    ];
    if (health !== undefined) rules.push({ id: 'out_of_health', params: {} });
    return {
      control: { id: 'move_free', params: { half: ARENA.half, size: ESCAPE.playerSize } },
      bot: { id: 'arena_bot', params: { half: ARENA.half } },
      level,
      rules,
      issues: checkEscapeLevel(level, { items: params.items, chaserSpeed: 0 }),
      health,
    };
  },
};
