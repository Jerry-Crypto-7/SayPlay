/**
 * Souboj zblízka (P25H, T4): ovládání, vzorec soupeře a generátor.
 *
 * Soupeř útočí ve vzorci ze semínka, který se opakuje dokola: nápřah
 * (`windup` tiků – okno na úhyb), úder, pak mezera (`recover` tiků – okno
 * na úder hráče). Hráč: ťuk = úder, dolů/držení = úhyb.
 *
 * - Úder v mezeře zasáhne (jednou za mezeru): soupeř ztratí život, hráč bod.
 * - Úder mimo mezeru soupeř vykryje a hráč se zapotácí: `stagger` tiků
 *   nemůže uhnout (mačkat úder pořád se nevyplatí).
 * - Úhyb trvá `dodge` tiků, pak `cooldown` tiků nejde znovu (držet úhyb
 *   pořád taky ne). Úder soupeře, který hráče nezastihne v úhybu, bere život.
 *
 * **Hratelné z konstrukce:** nápřah i mezera jsou delší než reakce robota
 * (8 tiků) s rezervou a útok + mezera stačí na úhyb i jeho zotavení.
 * `checkDuelPattern` to samé přepočítá nad hotovým vzorcem.
 *
 * Stav: soupeř (tělo 1) má fázi v `aux0` (`DUEL_PHASE`) a zbylé tiky fáze
 * v `aux1`; hráč má výsledek tiku v `aux0` (pro `judge`) a časovač úhybu
 * v `aux1` (> 0 uhýbá, < 0 zotavení nebo potácení). Zásahy soupeře jsou `z`
 * hráče v metrech, životy soupeře a pořadí útoku jsou čítače `DUEL_COUNTER`.
 */

import { z } from 'zod';

import { createCompileRng } from '@/play/compile/rng';

import { ARCADE_HZ, type ArcadeLevel, BODY, BUTTON, type BodyInit, type ControlPiece, type GeneratorPiece, HEADER, UNIT, bodyBase } from '../contract';
import { judgeRules } from './timing';

export const DUEL_DIFFICULTIES = ['easy', 'normal', 'hard'] as const;
export type DuelDifficulty = (typeof DUEL_DIFFICULTIES)[number];

export const DUEL = {
  /** Náběh před prvním útokem (1,5 s). */
  lead: 90,
  dodge: 20,
  cooldown: 12,
  stagger: 24,
  /** Reakce robota; nápřah i mezera musí být delší s rezervou. */
  reaction: 8,
  /** Kolik tiků navíc nad reakci chce kontrola u nápřahu a u mezery. */
  margin: 2,
  playerH: 1800,
  crouchH: 1000,
  /** Výchozí životy hráče, když spec žádné neurčí. */
  lives: 3,
  gap: 2200,
  /** Soupeřů za sebou nejvýš (žánr Souboj, P36A T11). */
  maxRounds: 10,
  /** O kolik tiků každý další soupeř zkrátí nápřah i mezeru. */
  rise: 3,
  /** Kratší nápřah a mezeru zrychlení neudělá: obojí nad reakcí robota a mezera + nápřah stačí na úhyb i zotavení. */
  minWindup: 18,
  minRecover: 17,
} as const;

/** Fáze soupeře v `aux0`. */
export const DUEL_PHASE = { ready: 0, windup: 1, open: 2, struck: 3 } as const;
/** Sloty čítačů: životy soupeře a pořadí útoku. */
export const DUEL_COUNTER = { foeHealth: 2, attack: 3 } as const;
/** Index soupeře. */
export const DUEL_FOE = 1;

const attack = z.object({ windup: z.int().min(0).max(ARCADE_HZ * 5), recover: z.int().min(0).max(ARCADE_HZ * 5) }).strict();
export type DuelAttack = z.infer<typeof attack>;

const controlParams = z
  .object({
    pattern: z.array(attack).min(1).max(8),
    foeHealth: z.int().min(1).max(20),
    /** Soupeřů za sebou, každý s `foeHealth` životy (žánr Souboj, P36A T11); bez toho jeden. */
    rounds: z.int().min(1).max(DUEL.maxRounds).optional(),
    /** O kolik tiků další soupeř zkrátí nápřah i mezeru (nejvýš na `minWindup` / `minRecover`). */
    rise: z.int().min(0).max(10).optional(),
  })
  .strict();
export type DuelControlParams = z.infer<typeof controlParams>;

const S = BODY;

/** Útok vzorce u soupeře `round` (od 0): o `rise` tiků za soupeře kratší, ne pod mez – co už pod ní je, zůstane. */
export function duelAttackAt(move: DuelAttack, round: number, rise: number): DuelAttack {
  const shorter = (ticks: number, floor: number): number => Math.max(Math.min(ticks, floor), ticks - round * rise);
  return { windup: shorter(move.windup, DUEL.minWindup), recover: shorter(move.recover, DUEL.minRecover) };
}

export const duelControl: ControlPiece<DuelControlParams> = {
  id: 'duel',
  params: controlParams,
  roles: ['player', 'enemy'],
  cost: () => ({ bodies: 2, rules: 0 }),
  step: (state, player, input, params) => {
    const p = bodyBase(player);
    const foe = bodyBase(DUEL_FOE);
    state[p + S.aux0] = 0;

    // Časovač úhybu: uhýbání dojde do zotavení, zotavení a potácení dojdou k nule.
    let timer = state[p + S.aux1] as number;
    if (timer > 0) timer = timer === 1 ? -DUEL.cooldown : timer - 1;
    else if (timer < 0) timer += 1;
    if ((input.buttons & (BUTTON.DOWN | BUTTON.HOLD)) !== 0 && timer === 0) timer = DUEL.dodge;

    let phase = state[foe + S.aux0] as number;
    let left = state[foe + S.aux1] as number;
    if ((input.buttons & BUTTON.TAP) !== 0) {
      if (phase === DUEL_PHASE.open) {
        state[p + S.aux0] = 1;
        state[p + S.z] = (state[p + S.z] as number) + UNIT;
        phase = DUEL_PHASE.struck;
      } else if (phase !== DUEL_PHASE.struck) timer = -DUEL.stagger;
    }

    const hits = Math.floor((state[p + S.z] as number) / UNIT);
    // Soupeř, se kterým se teď bojuje (od 0): každý další útočí rychleji.
    const round = Math.floor(hits / params.foeHealth);
    const moveAt = (index: number): DuelAttack => duelAttackAt(params.pattern[index] as DuelAttack, round, params.rise ?? 0);
    if ((state[HEADER.tick] as number) >= DUEL.lead) {
      if (left > 0) left -= 1;
      if (left === 0) {
        if (phase === DUEL_PHASE.windup) {
          // Úder: kdo zrovna neuhýbá, přijde o život.
          if (timer <= 0) state[p + S.aux0] = -1;
          const index = (state[HEADER.counters + DUEL_COUNTER.attack] as number) % params.pattern.length;
          phase = DUEL_PHASE.open;
          left = moveAt(index).recover;
          state[HEADER.counters + DUEL_COUNTER.attack] = (state[HEADER.counters + DUEL_COUNTER.attack] as number) + 1;
        }
        // Mezera (nebo start) skončila: další nápřah. Mezera 0 = nápřah hned po úderu.
        if (left === 0) {
          const index = (state[HEADER.counters + DUEL_COUNTER.attack] as number) % params.pattern.length;
          phase = DUEL_PHASE.windup;
          left = Math.max(1, moveAt(index).windup);
        }
      }
    }

    state[foe + S.aux0] = phase;
    state[foe + S.aux1] = left;
    state[p + S.aux1] = timer;
    state[p + S.h] = timer > 0 ? DUEL.crouchH : DUEL.playerH;
    // Životy soupeře, se kterým se bojuje; s jedním soupeřem prostě zbylé zásahy.
    const remaining = params.foeHealth * (params.rounds ?? 1) - hits;
    state[HEADER.counters + DUEL_COUNTER.foeHealth] = remaining <= 0 ? 0 : ((remaining - 1) % params.foeHealth) + 1;
  },
};

// ---------------------------------------------------------------------------
// Generátor a vzorec

interface Tier {
  readonly windup: readonly [number, number];
  readonly recover: readonly [number, number];
  readonly foeHealth: number;
}

const TIERS: Readonly<Record<DuelDifficulty, Tier>> = {
  easy: { windup: [40, 50], recover: [36, 44], foeHealth: 4 },
  normal: { windup: [28, 38], recover: [24, 32], foeHealth: 5 },
  hard: { windup: [18, 26], recover: [16, 22], foeHealth: 6 },
};

const generatorParams = z
  .object({
    difficulty: z.enum(DUEL_DIFFICULTIES).default('normal'),
    /** Actual ticks removed from each successive opponent's windows. */
    roundRise: z.int().min(1).max(3).optional(),
    /** Žánr Souboj (P36A T11): soupeřů za sebou, každý rychlejší o `DUEL.rise`; bez toho jeden soupeř. */
    rounds: z.int().min(1).max(DUEL.maxRounds).optional(),
  })
  .strict();
export type DuelLevelParams = z.infer<typeof generatorParams>;

/** Vzorec čtyř útoků ze semínka; za běhu se jen opakuje, žádná náhoda. */
export function duelPattern(seed: number, params: DuelLevelParams): DuelAttack[] {
  const rng = createCompileRng(seed);
  const tier = TIERS[params.difficulty];
  return Array.from({ length: 4 }, () => ({ windup: rng.int(tier.windup[0], tier.windup[1]), recover: rng.int(tier.recover[0], tier.recover[1]) }));
}

export const duelArena: GeneratorPiece<DuelLevelParams> = {
  id: 'duel_arena',
  params: generatorParams,
  roles: ['player', 'enemy'],
  cost: () => ({ bodies: 2, rules: 2 }),
  generate: (_seed, params) => {
    const bodies: BodyInit[] = [
      { role: 'player', kind: 'fighter', x: 0, y: 0, z: 0, w: 800, h: DUEL.playerH, d: 600, solid: false },
      { role: 'enemy', kind: 'foe', x: 0, y: 0, z: DUEL.gap, w: 800, h: DUEL.playerH, d: 600, solid: false },
    ];
    return { bodies, length: TIERS[params.difficulty].foeHealth * (params.rounds ?? 1) * UNIT };
  },
};

/**
 * Tvrzení „hratelné z konstrukce“ nad vzorcem; prázdné pole = hratelný. Se
 * zrychlením platí i pro posledního soupeře – tam jsou nápřah i mezera nejkratší.
 */
export function checkDuelPattern(base: readonly DuelAttack[], last = 0, rise = 0): string[] {
  const issues: string[] = [];
  const need = DUEL.reaction + DUEL.margin;
  const pattern = base.map((move) => duelAttackAt(move, last, rise));
  pattern.forEach((move, index) => {
    const next = pattern[(index + 1) % pattern.length] as DuelAttack;
    if (move.windup <= need) issues.push(`attack ${index + 1} winds up for ${move.windup} ticks – a dodge needs more than ${need}`);
    if (move.recover <= need) issues.push(`attack ${index + 1} leaves ${move.recover} ticks between attacks – a strike needs more than ${need}`);
    // Po úhybu musí úhyb i zotavení doběhnout dřív, než přijde další úder.
    if (move.recover + next.windup < DUEL.dodge + DUEL.cooldown + DUEL.margin) issues.push(`attack ${index + 2 > pattern.length ? 1 : index + 2} comes ${move.recover + next.windup} ticks after the last – too soon to dodge again`);
  });
  return issues;
}

/** Díly světa pro kompilátor. Souboj bez životů nejde: bez mechaniky `health` má hráč tři. */
export function duelParts(seed: number, raw: Readonly<Record<string, unknown>>, health: number | undefined) {
  const params = duelArena.params.parse(raw);
  const level: ArcadeLevel = duelArena.generate(seed, params);
  const pattern = duelPattern(seed, params);
  const foeHealth = TIERS[params.difficulty].foeHealth;
  const lives = health ?? DUEL.lives;
  const rounds = params.rounds ?? 1;
  const ramp = params.rounds === undefined ? {} : { rounds, rise: params.roundRise ?? DUEL.rise };
  return {
    control: { id: 'duel', params: { pattern, foeHealth, ...ramp } },
    bot: { id: 'duel_bot', params: {} },
    level,
    rules: judgeRules(foeHealth * rounds, lives),
    issues: checkDuelPattern(pattern, rounds - 1, params.rounds === undefined ? 0 : params.roundRise ?? DUEL.rise),
    health: lives,
  };
}
