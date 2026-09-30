/**
 * Souboj – režim `arena.fight` (P32E T3): hráč a nepřátelé na ohraničeném
 * nádvoří, pohled shora jako v aréně (`move_free`: osa = směr, stejná rychlost).
 *
 * **Hráč** úderem (`BUTTON.ATTACK`) zasáhne v oblouku před sebou – směrem, kam
 * naposled šel – a pak `attackCooldown` tiků čeká. Zasažený nepřítel ztratí HP,
 * odletí po směru úderu a na chvíli vrávorá (útok, který zrovna chystal, propadne).
 *
 * **Nepřítel** je stavový automat v jádře: přiblíží se, zastaví a telegrafuje
 * úder (`telegraph` tiků ≥ 400 ms, směr zamčený na jeho začátku), udeří
 * výpadem a krátce ustoupí. Úder zasáhne, jen když hráč v okamžiku úderu stojí
 * v zamčeném oblouku a dosahu – úhyb v okně telegrafu ho vždy odvrátí.
 *
 * Stav je jen ve snímku: HP v `flags` (`bodyHp`), u hráče `aux0` = směr pohledu
 * a `aux1` = tiky do dalšího úderu; u nepřítele `aux0` = fáze | směr << 4 |
 * `LANDED` a `aux1` = tiky do konce fáze. Rozhoduje ovládání; pravidlo
 * `fight_hits` jen ohlásí zásahy tohoto tiku efektem `hit` (ubere HP, scéna ho
 * vidí na sběrnici) a `fight_end` rozhodne o výhře a prohře.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import {
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeLevel,
  type ArcadeState,
  BODY,
  BUTTON,
  type BodyInit,
  type ControlPiece,
  FLAG,
  HEADER,
  HP_MAX,
  type ModeGeneratorPiece,
  ROLE,
  type RulePiece,
  UNIT,
  bodyBase,
  bodyHp,
} from '../contract';
import { ARENA, DIRECTIONS, directionOfAxis, directionToward } from './arena';

export const FIGHT = {
  /** Polovina strany nádvoří. */
  half: 9 * UNIT,
  bodySize: 1000,
  bodyHeight: 1800,
  playerHp: { min: 1, max: 9, default: 5 },
  enemyHp: { min: 1, max: 9, default: 3 },
  enemies: { min: 1, max: 3, default: 1 },
  /** Rychlost nepřítele za tik – vždy pod hráčovou (`ARENA.speed`), jinak z úderu neuteče. */
  enemySpeed: { min: 40, max: 110, default: 70 },
  enemyAccel: 10,
  /** Úder hráče: rozestup, dosah (střed ke středu), oblouk (kosinus polovičního úhlu × 1000 = ±60°). */
  attackCooldown: 24,
  attackReach: 2000,
  attackArc: 500,
  /** Kolik tiků po úderu scéna kreslí švih (stav `aux1` hráče). */
  swingTicks: 8,
  damage: 1,
  /** Odhození po úderu (jednotek za tik), útlum za tik a jak dlouho zasažený vrávorá. */
  knockback: 260,
  knockbackDecay: 16,
  stagger: 20,
  /** Nepřítel začne chystat úder na tuhle vzdálenost (střed ke středu). */
  engage: 2300,
  /** Telegraf: 500 ms (≥ 400 ms, UI audit 29. 9.) – i s reakcí 270 ms zbude na úkrok stranou z dosahu. */
  telegraph: 30,
  /** Úder nepřítele: dosah a oblouk ±45°, výpad a jeho délka. */
  strikeReach: 2400,
  strikeArc: 707,
  strike: 10,
  lunge: 100,
  /** Odhození hráče zasaženého úderem. */
  playerKnockback: 220,
  /** Ústup po úderu: tiky a rychlost. */
  retreat: 30,
  retreatSpeed: 45,
  /** Nepřátelé se drží aspoň tak daleko od sebe. */
  separation: 2000,
  /** Start: hráč vzadu uprostřed, nepřátelé před ním (+z, kamera stojí za hráčem) aspoň tak daleko. */
  playerStartZ: -3 * UNIT,
  enemyStartZ: 4 * UNIT,
  enemySpacing: 3 * UNIT,
  startJitter: 500,
  minStartDistance: 6 * UNIT,
} as const;

/** Fáze nepřítele v `aux0 & 0xf`. Čísla jsou součást hashe, nepřečíslovat. */
export const FIGHT_PHASE = { approach: 0, telegraph: 1, strike: 2, retreat: 3, stagger: 4, down: 5 } as const;
export type FightPhase = (typeof FIGHT_PHASE)[keyof typeof FIGHT_PHASE];

const PHASE_MASK = 0xf;
const DIRECTION_SHIFT = 4;
/** Úder, který právě začal, hráče zasáhl. */
const LANDED = 1 << 9;

export const phaseOf = (state: ArcadeState, body: number): FightPhase => ((state[bodyBase(body) + BODY.aux0] as number) & PHASE_MASK) as FightPhase;
/** Směr úderu zamčený na začátku telegrafu (0..31). */
export const strikeDirectionOf = (state: ArcadeState, body: number): number => ((state[bodyBase(body) + BODY.aux0] as number) >> DIRECTION_SHIFT) & 31;
export const phaseTicksLeft = (state: ArcadeState, body: number): number => state[bodyBase(body) + BODY.aux1] as number;
/** Tiky do dalšího úderu hráče; 0 = může udeřit. */
export const attackCooldownOf = (state: ArcadeState, player: number): number => state[bodyBase(player) + BODY.aux1] as number;
/** Směr pohledu hráče (0..31) – kam naposled šel, na startu po +z. */
export const facingOf = (state: ArcadeState, player: number): number => state[bodyBase(player) + BODY.aux0] as number;

const toward = (value: number, target: number, step: number): number => (value < target ? Math.min(target, value + step) : Math.max(target, value - step));
/** Celočíselná délka vektoru (`Math.sqrt` je v IEEE 754 přesně zaokrouhlená – všude stejné číslo). */
const length = (dx: number, dz: number): number => Math.floor(Math.sqrt(dx * dx + dz * dz));

/** Leží bod `(dx, dz)` od útočníka v dosahu `reach` a v oblouku `arc` kolem směru `direction`? */
export function inArc(dx: number, dz: number, direction: number, reach: number, arc: number): boolean {
  const gap = length(dx, dz);
  if (gap > reach) return false;
  if (gap === 0) return true;
  const dir = DIRECTIONS[direction]!;
  return dx * dir.dx + dz * dir.dz >= arc * gap;
}

function setPhase(state: ArcadeState, body: number, phase: FightPhase, ticks: number, direction: number, landed = false): void {
  const base = bodyBase(body);
  state[base + BODY.aux0] = phase | (direction << DIRECTION_SHIFT) | (landed ? LANDED : 0);
  state[base + BODY.aux1] = ticks;
}

/** Nepřátelé světa: živá těla role `enemy`. */
export function enemiesOf(state: ArcadeState): number[] {
  const enemies: number[] = [];
  for (let i = 0; i < (state[HEADER.bodyCount] as number); i += 1) {
    const base = bodyBase(i);
    if (state[base + BODY.role] === ROLE.enemy && ((state[base + BODY.flags] as number) & FLAG.alive) !== 0) enemies.push(i);
  }
  return enemies;
}

/** Rychlost, se kterou tělo `size` zůstane v aréně: složka, která by ho vynesla ven, se zkrátí. */
function keepInside(state: ArcadeState, body: number, half: number): void {
  const base = bodyBase(body);
  const limit = half - Math.ceil((state[base + BODY.w] as number) / 2);
  const x = state[base + BODY.x] as number;
  const zz = state[base + BODY.z] as number;
  state[base + BODY.vx] = Math.max(-limit - x, Math.min(limit - x, state[base + BODY.vx] as number));
  state[base + BODY.vz] = Math.max(-limit - zz, Math.min(limit - zz, state[base + BODY.vz] as number));
}

function setVelocity(state: ArcadeState, body: number, direction: number, speed: number): void {
  const base = bodyBase(body);
  const dir = direction < 0 ? { dx: 0, dz: 0 } : DIRECTIONS[direction]!;
  state[base + BODY.vx] = Math.trunc((dir.dx * speed) / 1000);
  state[base + BODY.vz] = Math.trunc((dir.dz * speed) / 1000);
}

/** Úder hráče: každý nepřítel s HP v oblouku vrávorá a odletí po směru úderu. */
function swing(state: ArcadeState, player: number, enemies: readonly number[]): void {
  const p = bodyBase(player);
  const facing = state[p + BODY.aux0] as number;
  for (const i of enemies) {
    const base = bodyBase(i);
    if (bodyHp(state, i) === 0) continue;
    const dx = (state[base + BODY.x] as number) - (state[p + BODY.x] as number);
    const dz = (state[base + BODY.z] as number) - (state[p + BODY.z] as number);
    if (!inArc(dx, dz, facing, FIGHT.attackReach, FIGHT.attackArc)) continue;
    setPhase(state, i, FIGHT_PHASE.stagger, FIGHT.stagger, facing);
    setVelocity(state, i, facing, FIGHT.knockback);
  }
}

/** Jeden tik nepřítele `i` (ne toho, kterého hráč právě zasáhl). */
function stepEnemy(state: ArcadeState, i: number, player: number, enemies: readonly number[], speed: number): void {
  const base = bodyBase(i);
  const p = bodyBase(player);
  const x = state[base + BODY.x] as number;
  const zz = state[base + BODY.z] as number;
  const dx = (state[p + BODY.x] as number) - x;
  const dz = (state[p + BODY.z] as number) - zz;
  const aux = state[base + BODY.aux0] as number;
  const phase = (aux & PHASE_MASK) as FightPhase;
  const locked = (aux >> DIRECTION_SHIFT) & 31;
  const left = (state[base + BODY.aux1] as number) - 1;

  if (bodyHp(state, i) === 0) {
    setPhase(state, i, FIGHT_PHASE.down, 0, locked);
    setVelocity(state, i, -1, 0);
    return;
  }
  if (phase === FIGHT_PHASE.approach) {
    if (length(dx, dz) <= FIGHT.engage) {
      setPhase(state, i, FIGHT_PHASE.telegraph, FIGHT.telegraph, Math.max(0, directionToward(dx, dz)));
      setVelocity(state, i, -1, 0);
      return;
    }
    // Za hráčem, s odstupem od ostatních nepřátel (tím silněji, čím jsou blíž).
    const aim = Math.max(1, length(dx, dz));
    let sx = Math.trunc((dx * 1000) / aim);
    let sz = Math.trunc((dz * 1000) / aim);
    for (const j of enemies) {
      if (j === i || bodyHp(state, j) === 0) continue;
      const other = bodyBase(j);
      const ox = x - (state[other + BODY.x] as number);
      const oz = zz - (state[other + BODY.z] as number);
      const gap = length(ox, oz);
      if (gap >= FIGHT.separation) continue;
      const push = Math.trunc(((FIGHT.separation - gap) * 2000) / FIGHT.separation);
      if (gap === 0) sx += j < i ? push : -push;
      else {
        sx += Math.trunc((ox * push) / gap);
        sz += Math.trunc((oz * push) / gap);
      }
    }
    const want = directionToward(sx, sz);
    const dir = want < 0 ? { dx: 0, dz: 0 } : DIRECTIONS[want]!;
    state[base + BODY.vx] = toward(state[base + BODY.vx] as number, Math.trunc((dir.dx * speed) / 1000), FIGHT.enemyAccel);
    state[base + BODY.vz] = toward(state[base + BODY.vz] as number, Math.trunc((dir.dz * speed) / 1000), FIGHT.enemyAccel);
    return;
  }
  if (phase === FIGHT_PHASE.telegraph) {
    if (left > 0) {
      state[base + BODY.aux1] = left;
      return;
    }
    // Úder: zasáhne hráče, který teď stojí v zamčeném oblouku a dosahu.
    const landed = inArc(dx, dz, locked, FIGHT.strikeReach, FIGHT.strikeArc);
    setPhase(state, i, FIGHT_PHASE.strike, FIGHT.strike, locked, landed);
    setVelocity(state, i, locked, FIGHT.lunge);
    if (landed) setVelocity(state, player, locked, FIGHT.playerKnockback);
    return;
  }
  if (phase === FIGHT_PHASE.strike) {
    if (left > 0) state[base + BODY.aux1] = left;
    else {
      setPhase(state, i, FIGHT_PHASE.retreat, FIGHT.retreat, locked);
      setVelocity(state, i, Math.max(0, directionToward(-dx, -dz)), FIGHT.retreatSpeed);
    }
    return;
  }
  if (phase === FIGHT_PHASE.retreat) {
    if (left > 0) {
      state[base + BODY.aux1] = left;
      setVelocity(state, i, directionToward(-dx, -dz), FIGHT.retreatSpeed);
    } else setPhase(state, i, FIGHT_PHASE.approach, 0, locked);
    return;
  }
  if (phase === FIGHT_PHASE.stagger) {
    state[base + BODY.vx] = toward(state[base + BODY.vx] as number, 0, FIGHT.knockbackDecay);
    state[base + BODY.vz] = toward(state[base + BODY.vz] as number, 0, FIGHT.knockbackDecay);
    if (left > 0) state[base + BODY.aux1] = left;
    else setPhase(state, i, FIGHT_PHASE.approach, 0, locked);
  }
}

const controlParams = z
  .object({
    half: z.int().min(5 * UNIT).max(20 * UNIT).default(FIGHT.half),
    enemySpeed: z.int().min(FIGHT.enemySpeed.min).max(FIGHT.enemySpeed.max).default(FIGHT.enemySpeed.default),
  })
  .strict();
export type FightControlParams = z.infer<typeof controlParams>;

/**
 * Ovládání souboje: pohyb jako `move_free` (osa = směr), úder a nepřátelé.
 * Pořadí v tiku: pohyb hráče → jeho úder (zasažený nepřítel vrávorá už v tomto
 * tiku, takže úder, který chystal, propadne) → ostatní nepřátelé.
 */
export const fightControl: ControlPiece<FightControlParams> = {
  id: 'fight',
  params: controlParams,
  roles: ['player', 'enemy'],
  cost: () => ({ bodies: 1, rules: 0 }),
  step: (state, player, input, params) => {
    const p = bodyBase(player);
    const direction = directionOfAxis(input.axis);
    const dir = direction < 0 ? null : DIRECTIONS[direction]!;
    const rate = dir === null ? ARENA.friction : ARENA.accel;
    state[p + BODY.vx] = toward(state[p + BODY.vx] as number, dir === null ? 0 : Math.trunc((dir.dx * ARENA.speed) / 1000), rate);
    state[p + BODY.vz] = toward(state[p + BODY.vz] as number, dir === null ? 0 : Math.trunc((dir.dz * ARENA.speed) / 1000), rate);
    if (direction >= 0) state[p + BODY.aux0] = direction;

    const enemies = enemiesOf(state);
    const cooldown = state[p + BODY.aux1] as number;
    const swung = (input.buttons & BUTTON.ATTACK) !== 0 && cooldown === 0;
    if (swung) {
      state[p + BODY.aux1] = FIGHT.attackCooldown;
      swing(state, player, enemies);
    } else if (cooldown > 0) state[p + BODY.aux1] = cooldown - 1;

    for (const i of enemies) {
      if (!(swung && phaseOf(state, i) === FIGHT_PHASE.stagger && phaseTicksLeft(state, i) === FIGHT.stagger)) stepEnemy(state, i, player, enemies, params.enemySpeed);
      keepInside(state, i, params.half);
    }
    keepInside(state, player, params.half);
  },
};

// ---------------------------------------------------------------------------
// Pravidla

const noParams = z.object({}).strict();

/**
 * Zásahy tohoto tiku (spouštěč `press`, hned za ovládáním): nepřítel, který
 * právě začal vrávorat, dostal úder hráče; nepřítel, jehož úder právě začal a
 * dopadl, zasáhl hráče.
 */
export const fightHits: RulePiece<z.infer<typeof noParams>> = {
  id: 'fight_hits',
  params: noParams,
  roles: ['player', 'enemy'],
  trigger: 'press',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }) => {
    const effects: ArcadeEffect[] = [];
    for (const i of enemiesOf(state)) {
      const phase = phaseOf(state, i);
      const left = phaseTicksLeft(state, i);
      if (phase === FIGHT_PHASE.stagger && left === FIGHT.stagger) effects.push({ kind: 'hit', body: i, by: player, amount: FIGHT.damage });
      else if (phase === FIGHT_PHASE.strike && left === FIGHT.strike && ((state[bodyBase(i) + BODY.aux0] as number) & LANDED) !== 0) {
        effects.push({ kind: 'hit', body: player, by: i, amount: FIGHT.damage });
      }
    }
    return effects;
  },
};

/** Hráč na 0 HP = prohra, všichni nepřátelé na 0 = výhra. */
export const fightEnd: RulePiece<z.infer<typeof noParams>> = {
  id: 'fight_end',
  params: noParams,
  roles: ['player', 'enemy'],
  trigger: 'tick',
  cost: () => ({ bodies: 0, rules: 1 }),
  fire: ({ state, player }) => {
    if (bodyHp(state, player) === 0) return [{ kind: 'lose' }];
    const enemies = enemiesOf(state);
    return enemies.length > 0 && enemies.every((i) => bodyHp(state, i) === 0) ? [{ kind: 'win' }] : [];
  },
};

/** Pravidla souboje – `library.ts` je rozbalí do `rules`. */
export const FIGHT_RULES: Readonly<Record<string, RulePiece>> = { fight_hits: fightHits, fight_end: fightEnd };

// ---------------------------------------------------------------------------
// Generátor

const generatorParams = z
  .object({
    enemies: z.int().min(FIGHT.enemies.min).max(FIGHT.enemies.max).default(FIGHT.enemies.default),
    enemyHp: z.int().min(FIGHT.enemyHp.min).max(FIGHT.enemyHp.max).default(FIGHT.enemyHp.default),
    enemySpeed: z.int().min(FIGHT.enemySpeed.min).max(FIGHT.enemySpeed.max).default(FIGHT.enemySpeed.default),
    playerHp: z.int().min(FIGHT.playerHp.min).max(FIGHT.playerHp.max).default(FIGHT.playerHp.default),
  })
  .strict();
export type FightParams = z.infer<typeof generatorParams>;

const fighter = (role: 'player' | 'enemy', x: number, zz: number, hp: number): BodyInit => ({
  role,
  kind: role,
  x,
  y: 0,
  z: zz,
  w: FIGHT.bodySize,
  h: FIGHT.bodyHeight,
  d: FIGHT.bodySize,
  solid: false,
  hp,
});

/** Nádvoří: hráč vzadu uprostřed, nepřátelé v řadě před ním s drobným rozptylem. */
function courtyard(seed: number, params: FightParams, playerHp: number): ArcadeLevel {
  const rng = createCompileRng(seed);
  const bodies: BodyInit[] = [fighter('player', 0, FIGHT.playerStartZ, playerHp)];
  for (let k = 0; k < params.enemies; k += 1) {
    const x = (2 * k - (params.enemies - 1)) * Math.trunc(FIGHT.enemySpacing / 2) + rng.int(-FIGHT.startJitter, FIGHT.startJitter);
    bodies.push(fighter('enemy', x, FIGHT.enemyStartZ + rng.int(-FIGHT.startJitter, FIGHT.startJitter), params.enemyHp));
  }
  return { bodies, length: 0 };
}

/** Tvrzení „férové a hratelné z konstrukce“ nad nádvořím; prázdné pole = hratelné. */
export function checkFightLevel(level: ArcadeLevel, half: number = FIGHT.half): string[] {
  const issues: string[] = [];
  const m = (units: number): string => `${(units / UNIT).toFixed(1)} m`;
  const player = level.bodies[0];
  if (player === undefined || player.role !== 'player') return ['no player'];
  if ((player.hp ?? 0) < 1) issues.push('the player has no HP');
  const enemies = level.bodies.filter((body) => body.role === 'enemy');
  if (enemies.length === 0) issues.push('no enemy to fight');
  for (const body of level.bodies) {
    if (Math.abs(body.x) + body.w / 2 > half || Math.abs(body.z) + body.d / 2 > half) issues.push(`a ${body.kind} at ${m(body.x)}, ${m(body.z)} sits outside the arena`);
  }
  for (const enemy of enemies) {
    if ((enemy.hp ?? 0) < 1 || (enemy.hp ?? 0) > HP_MAX) issues.push(`an enemy at ${m(enemy.x)}, ${m(enemy.z)} has no HP to lose`);
    const gap = Math.hypot(enemy.x - player.x, enemy.z - player.z);
    if (gap < FIGHT.minStartDistance) issues.push(`an enemy starts ${m(gap)} from the player but needs ${m(FIGHT.minStartDistance)}`);
  }
  if (level.bodies.length > ARCADE_LIMITS.maxBodies) issues.push(`${level.bodies.length} bodies exceed the ${ARCADE_LIMITS.maxBodies} body limit`);
  return issues;
}

/**
 * Režim `arena.fight`: poraz všechny nepřátele dřív, než oni tebe. Životy ze
 * specu (`health`) jsou HP hráče; čítač životů režim nepoužívá.
 */
export const fightArena: ModeGeneratorPiece<FightParams> = {
  id: 'fight',
  params: generatorParams,
  roles: ['player', 'enemy'],
  cost: (params) => ({ bodies: 1 + params.enemies, rules: 2 }),
  generate: (seed, params) => courtyard(seed, params, params.playerHp),
  parts: (seed, params, health) => {
    const playerHp = health === undefined ? params.playerHp : Math.max(FIGHT.playerHp.min, Math.min(FIGHT.playerHp.max, health));
    const level = courtyard(seed, params, playerHp);
    return {
      control: { id: 'fight', params: { half: FIGHT.half, enemySpeed: params.enemySpeed } },
      bot: { id: 'fight_bot', params: {} },
      level,
      rules: [
        { id: 'fight_hits', params: {} },
        { id: 'fight_end', params: {} },
      ],
      issues: checkFightLevel(level),
      health: undefined,
    };
  },
};
