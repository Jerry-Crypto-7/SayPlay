/**
 * Háčky v jádře (P66 T3): kola, výběr vylepšení mezi koly, vzácnost sebrané věci, moment bosse a zprávy pro
 * obrazovku (létající skóre, hlášky). Kontrakt (sloty, konstanty, druhy zpráv) je `hooks/contract.ts`, chování
 * v `rounds.ts`, `upgrades.ts`, `rarity.ts`, `boss.ts`; tady je pravidlo, které háčky nese, jejich stavba a tři
 * místa, kudy je volá jádro (`kernel.ts`).
 *
 * **Svět s háčky** má za tělesy úrovně počítadlo háčků (mrtvá předloha jako počítadlo komba) a pravidlo `hooks`
 * s jejich parametry; s výběrem vylepšení i robota `hooks_bot`. Uložené hry ho nemají, takže jejich hash se nehne.
 * Staví ho jen hra `genre.v6` a novější: dosavadní žánr klíči `tuning` (`hookTuningOf`, `arcade/compile.ts`),
 * nový žánr sám ve svém generátoru (`withHooks`).
 */

import { z } from 'zod';

import {
  ARCADE_LIMITS,
  type ArcadeEffect,
  type ArcadeInput,
  type ArcadeLevel,
  BODY_STRIDE,
  type BodyInit,
  COMBO,
  COUNTER,
  HEADER,
  type PieceRef,
  type RulePiece,
  comboOf,
  nativeRule,
  underlyingRule,
} from '../contract';
import { bossEntries, bossTemplateOf } from './boss';
import { type CalloutId, type HookEffect, RARITY_SCORE, ROUNDS, UPGRADES, UPGRADE_OFFER, type UpgradeId } from './contract';
import { addFound, assignRarities, collectedAt, drawRarities, rarityBonus } from './rarity';
import { breakTick, inBreak, roundsEnd } from './rounds';
import { type Swing, boostHero, drawOffers, shortenSwing } from './upgrades';

export { foundOf, rarityOf } from './rarity';
export { inBreak, roundOf, roundSeeds } from './rounds';
export { offerOf, upgradeLevel } from './upgrades';

const body = z.int().min(1).max(ARCADE_LIMITS.maxBodies - 1);

const hookParams = z
  .object({
    /** Počítadlo háčků (index těla) se sloty `HOOK_SLOTS`. */
    keeper: body,
    rounds: z.int().min(ROUNDS.min).max(ROUNDS.max),
    /** Co kolo končí (`rounds.ts`): zvednutá vlna žánru, nebo výhra pravidla žánru. */
    clear: z.enum(['wave', 'win']),
    /** Výběr vylepšení: pořadí zásoby žánru na každou přestávku (`drawOffers`). */
    upgrades: z
      .object({ offers: z.array(z.array(z.enum(UPGRADES)).min(3).max(UPGRADES.length)).min(1).max(ROUNDS.max - 1) })
      .strict()
      .optional(),
    /** Vzácnost: losy věcí v pořadí vzniku (`drawRarities`). */
    rarity: z.object({ draws: z.string().regex(/^[012]{1,256}$/) }).strict().optional(),
    /** Počítadlo komba (hlášky „Combo x2“…); doplní `completeHooks`. */
    combo: body.optional(),
    /** Předloha bosse finále (`boss_enter`); doplní `completeHooks`. */
    boss: body.optional(),
    /** Rána hrdiny, kterou `fire_rate` zkrátí (`Swing`): slot těla hráče a plná délka rozestupu. */
    swing: z.object({ slot: z.int().min(0).max(BODY_STRIDE - 1), ticks: z.int().min(2).max(ARCADE_LIMITS.maxTicks) }).strict().optional(),
  })
  .strict();
export type HookParams = z.infer<typeof hookParams>;

/**
 * Pravidlo, které háčky nese: samo nevystřelí nic, jeho parametry čte jádro (`loadProgram`), jako `score_bonus`.
 * Počítá se do stropu pravidel světa.
 */
export const hooksRule: RulePiece<HookParams> = {
  id: 'hooks',
  params: hookParams,
  roles: ['player'],
  trigger: 'tick',
  cost: () => ({ bodies: 1, rules: 1 }),
  fire: () => [],
};

/** Parametry háčků světa (`world.rules`), nebo `null` – svět bez háčků. Jádro, obrazovka i výsledek čtou tudy. */
export const hooksOf = (rules: readonly PieceRef[]): HookParams | null => (nativeRule(rules, 'hooks')?.params as HookParams | undefined) ?? null;

// ---------------------------------------------------------------------------
// Stavba

/** Co hra od háčků chce: kola, zásoba vylepšení (≥ 3 různá), vzácnost, signál konce kola. */
export interface HookRequest {
  readonly rounds: number;
  readonly upgrades?: readonly UpgradeId[];
  readonly rarity?: boolean;
  readonly clear?: 'wave' | 'win';
  readonly swing?: Swing;
}

export interface HookedParts {
  readonly level: ArcadeLevel;
  readonly rules: PieceRef[];
  readonly bot: PieceRef;
  /** Index počítadla háčků – kusy žánru ho dostanou do parametrů. */
  readonly keeper: number;
}

/**
 * Přidá hře háčky: počítadlo za tělesa úrovně (mrtvá předloha s modelem hráče – nic ho nekreslí ani nesrazí), pravidlo
 * `hooks` s nabídkami a losy vzácnosti ze streamů hry `seed` a s výběrem vylepšení robota `hooks_bot`. Volá ho
 * `arcade/compile.ts` (klíče `tuning`) i generátor nového žánru.
 */
export function withHooks(parts: { readonly level: ArcadeLevel; readonly rules: readonly PieceRef[]; readonly bot: PieceRef }, seed: number, request: HookRequest): HookedParts {
  const keeper = parts.level.bodies.length;
  const hero = parts.level.bodies[0] as BodyInit;
  const counter: BodyInit = { role: 'thing', kind: hero.kind, x: 0, y: 0, z: 0, w: 1, h: 1, d: 1, solid: false, template: true };
  const upgrades = request.upgrades !== undefined && request.rounds > 1 ? { offers: drawOffers(seed, request.upgrades, request.rounds - 1) } : undefined;
  const params: HookParams = {
    keeper,
    rounds: request.rounds,
    clear: request.clear ?? 'win',
    ...(upgrades === undefined ? {} : { upgrades }),
    ...(request.rarity === true ? { rarity: { draws: drawRarities(seed) } } : {}),
    ...(upgrades !== undefined && request.swing !== undefined && request.upgrades?.includes('fire_rate') === true ? { swing: request.swing } : {}),
  };
  return {
    level: { ...parts.level, bodies: [...parts.level.bodies, counter] },
    rules: [...parts.rules, { id: 'hooks', params }],
    bot: upgrades === undefined ? parts.bot : { id: 'hooks_bot', params: { base: parts.bot, keeper } },
    keeper,
  };
}

/** Doplní háčkům počítadlo komba (pravidla `COMBO_SOURCES` ho nesou v `combo`) a předlohu bosse finále. */
export function completeHooks(rules: readonly PieceRef[]): PieceRef[] {
  const combo = rules.map((ref) => underlyingRule(ref).params.combo).find((value): value is number => typeof value === 'number');
  const boss = bossTemplateOf(rules);
  return rules.map((ref) =>
    ref.id !== 'hooks' ? ref : { id: 'hooks', params: { ...ref.params, ...(combo === undefined ? {} : { combo }), ...(boss === undefined ? {} : { boss }) } },
  );
}

/** Klíče `controlParams.tuning`, kterými hra `genre.v6` háčky dosavadního žánru zapne. Generátor je nevidí. */
export const HOOK_TUNING = ['hookRounds', 'hookUpgrades', 'hookRarity'] as const;

export function withoutHookTuning(tuning: Readonly<Record<string, unknown>> | undefined): Readonly<Record<string, unknown>> | undefined {
  if (tuning === undefined || !HOOK_TUNING.some((key) => key in tuning)) return tuning;
  return Object.fromEntries(Object.entries(tuning).filter(([key]) => !(HOOK_TUNING as readonly string[]).includes(key)));
}

/** Hra dosavadního žánru, jak ji háčky z `tuning` potřebují znát: pravidla, úroveň, životy, rána hrdiny. */
export interface TunedGame {
  readonly rules: readonly PieceRef[];
  readonly level: ArcadeLevel;
  readonly lives: number | undefined;
  readonly swing: Swing | undefined;
}

/**
 * Háčky z klíčů `tuning` (jen hra `genre.v6`, rozhoduje volající): `hookRounds` 1–5, `hookUpgrades` = zásoba
 * vylepšení čárkami (`"speed,fire_rate,extra_life"`), `hookRarity` = `true`. Kola dosavadního žánru jsou jeho vlny
 * (`clear: 'wave'`), takže chtějí `arena_waves` s právě tolika vlnami. Karta musí v té hře něco dělat: `extra_life`
 * chce životy, `magnet` sbírané věci, `fire_rate` ránu hrdiny (`Swing`); `range` a `carry` dosavadní žánr nemá.
 */
export function hookTuningOf(tuning: Readonly<Record<string, unknown>> | undefined, game: TunedGame): { readonly request: HookRequest } | { readonly issues: readonly string[] } | null {
  if (tuning === undefined || !HOOK_TUNING.some((key) => key in tuning)) return null;
  const at = (key: string): string => `/controlParams/tuning/${key}`;
  const issues: string[] = [];
  const rounds = tuning.hookRounds ?? 1;
  if (typeof rounds !== 'number' || !Number.isInteger(rounds) || rounds < ROUNDS.min || rounds > ROUNDS.max) issues.push(`${at('hookRounds')}: ${String(rounds)} rounds, not ${ROUNDS.min}–${ROUNDS.max}`);
  const raw = tuning.hookUpgrades;
  const upgrades = typeof raw === 'string' ? raw.split(',').map((id) => id.trim()) : undefined;
  if (raw !== undefined && upgrades === undefined) issues.push(`${at('hookUpgrades')}: a comma list of ${UPGRADES.join(', ')}`);
  if (upgrades !== undefined) {
    const unknown = upgrades.filter((id) => !(UPGRADES as readonly string[]).includes(id));
    if (unknown.length > 0) issues.push(`${at('hookUpgrades')}: no upgrade ${unknown.join(', ')} (${UPGRADES.join(', ')})`);
    if (new Set(upgrades).size !== upgrades.length || upgrades.length < UPGRADE_OFFER.size) issues.push(`${at('hookUpgrades')}: an offer shows ${UPGRADE_OFFER.size} different cards, so list at least ${UPGRADE_OFFER.size} different upgrades once each`);
    if (rounds === 1) issues.push(`${at('hookUpgrades')}: upgrades are picked between rounds – set hookRounds 2–5`);
    const idle: Readonly<Record<UpgradeId, boolean>> = {
      speed: false,
      extra_life: (game.lives ?? 0) <= 0,
      magnet: !game.level.bodies.some((body) => body.role === 'collectible'),
      fire_rate: game.swing === undefined,
      range: true,
      carry: true,
    };
    const useless = upgrades.filter((id) => Object.hasOwn(idle, id) && idle[id as UpgradeId]);
    if (useless.length > 0) issues.push(`${at('hookUpgrades')}: ${useless.join(', ')} would do nothing in this game (extra_life needs lives, magnet things to collect, fire_rate a strike; range and carry belong to the new genres)`);
  }
  if (tuning.hookRarity !== undefined && tuning.hookRarity !== true) issues.push(`${at('hookRarity')}: true or absent`);
  const waves = nativeRule(game.rules, 'arena_waves')?.params.waves as readonly unknown[] | undefined;
  if (rounds !== 1 && waves === undefined) issues.push(`${at('hookRounds')}: rounds of an existing genre are its waves, and this game has none`);
  else if (rounds !== 1 && waves !== undefined && waves.length + 1 !== rounds) issues.push(`${at('hookRounds')}: ${String(rounds)} rounds but the game has ${String(waves.length + 1)} waves – set tuning waves to the same number`);
  if (issues.length > 0) return { issues };
  return {
    request: {
      rounds: rounds as number,
      clear: 'wave',
      ...(upgrades === undefined ? {} : { upgrades: upgrades as UpgradeId[] }),
      ...(tuning.hookRarity === true ? { rarity: true } : {}),
      ...(game.swing === undefined ? {} : { swing: game.swing }),
    },
  };
}

// ---------------------------------------------------------------------------
// Tik (volá `kernel.ts`)

/**
 * Začátek tiku. V přestávce svět stojí: vrátí zprávy tiku přestávky a jádro tik jen odpočte (`true`). Jinak promítne
 * vylepšení do hrdiny (`boostHero`) a vrátí `false`.
 */
export function hooksStart(state: Int32Array, input: ArcadeInput, params: HookParams, out: ArcadeEffect[]): boolean {
  if (inBreak(state, params.keeper)) {
    out.push(...breakTick(state, input, params));
    return true;
  }
  boostHero(state, state[HEADER.player] as number, params.keeper);
  return false;
}

/** Násobič komba před tikem (hlášky komba porovnávají s ním); bez komba 1. */
export const comboBefore = (state: Int32Array, params: HookParams): number => (params.combo === undefined ? 1 : comboOf(state, params.combo));

/** Milníky komba: ×2, ×3 a strop. */
const COMBO_CALLOUTS: readonly (readonly [number, CalloutId])[] = [
  [2, 'combo_2'],
  [3, 'combo_3'],
  [COMBO.max, 'combo_max'],
];

/** Tělo, nad kterým se ukáže létající skóre efektu `i`: věc nebo cíl hned za ním, jinak hráč. */
function popBody(state: Int32Array, effects: readonly ArcadeEffect[], i: number): number {
  const next = effects[i + 1];
  return next !== undefined && (next.kind === 'despawn' || next.kind === 'hit') ? next.body : (state[HEADER.player] as number);
}

/**
 * Konec tiku, po průchodech pravidel a před bonusem výhry: sebrané věci se vzácností (body navíc, nález), létající
 * skóre za každý přírůstek, hlášky komba, vstup bosse, losy nově vzniklých věcí a kola. Zprávy jdou na konec efektů
 * tiku; stav mění jen sloty háčků, skóre (násobič vzácnosti), stav běhu (výhra před posledním kolem) a vzácnost věcí.
 */
export function hooksEnd(state: Int32Array, effects: ArcadeEffect[], params: HookParams, combo: number): void {
  const out: HookEffect[] = [];
  const score = HEADER.counters + COUNTER.score;
  for (let i = 0; i < effects.length; i += 1) {
    const effect = effects[i] as ArcadeEffect;
    const amount = effect.kind === 'score' || (effect.kind === 'count' && effect.counter === 'score') ? effect.amount : 0;
    if (amount <= 0) continue;
    const found = params.rarity === undefined ? undefined : collectedAt(state, effects, i);
    if (found === undefined) {
      out.push({ kind: 'score_pop', amount, body: popBody(state, effects, i) });
      continue;
    }
    state[score] = (state[score] as number) + rarityBonus(amount, found.rarity);
    addFound(state, params.keeper, found.rarity);
    out.push({ kind: 'score_pop', amount: amount * RARITY_SCORE[found.rarity], body: found.body });
    if (found.rarity !== 'common') out.push({ kind: 'rare_found', rarity: found.rarity, body: found.body });
    if (found.rarity === 'epic') out.push({ kind: 'callout', callout: 'epic_find' });
  }
  if (params.combo !== undefined) {
    let before = combo;
    for (const effect of effects) {
      if (effect.kind !== 'combo' || effect.body !== params.combo) continue;
      for (const [at, callout] of COMBO_CALLOUTS) if (before < at && effect.multiplier >= at) out.push({ kind: 'callout', callout });
      before = effect.multiplier;
    }
  }
  if (params.boss !== undefined) bossEntries(state, effects, params.boss, out);
  if (params.swing !== undefined) shortenSwing(state, state[HEADER.player] as number, params.keeper, params.swing);
  if (params.rarity !== undefined) assignRarities(state, params.keeper, params.rarity.draws);
  if (params.rounds > 1) roundsEnd(state, params, out);
  effects.push(...out);
}
