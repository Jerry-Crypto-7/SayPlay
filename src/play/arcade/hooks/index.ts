/**
 * Háčky v jádře (P66 T3): kola, výběr vylepšení mezi koly, vzácnost sebrané věci, moment bosse a zprávy pro
 * obrazovku (létající skóre, hlášky). Kontrakt (sloty, konstanty, druhy zpráv) je `hooks/contract.ts`, chování
 * v `rounds.ts`, `upgrades.ts`, `rarity.ts`, `boss.ts`; tady je pravidlo, které háčky nese, jejich stavba a tři
 * místa, kudy je volá jádro (`kernel.ts`).
 *
 * **Svět s háčky** má pravidlo `hooks` s jejich parametry, háčky se stavem (kola, vylepšení, vzácnost) i počítadlo
 * háčků za tělesy úrovně (mrtvá předloha jako počítadlo komba); s výběrem vylepšení i robota `hooks_bot`. Uložené hry ho nemají, takže jejich hash se nehne.
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
    /**
     * Počítadlo háčků (index těla) se sloty `HOOK_SLOTS`. Jen háčky se stavem – kola, vylepšení, vzácnost (`stateful`);
     * jedno kolo bez nich (létající skóre, hlášky) tělo nemá, ať nové tělo neposune indexy vzniklých těl (T10a).
     */
    keeper: body.optional(),
    rounds: z.int().min(ROUNDS.min).max(ROUNDS.max),
    /** Co kolo končí (`rounds.ts`): zvednutá vlna žánru, výhra pravidla žánru, nebo značka postupu `goal`. */
    clear: z.enum(['wave', 'win', 'goal']),
    /**
     * Jen `clear: 'goal'` (P66 T10): postup žánru – vlna, skóre, nebo padlí soupeři role `role` z `need` – a značka
     * konce každého kola kromě posledního (`marks[r]`, rostoucí).
     */
    goal: z
      .object({
        by: z.enum(['wave', 'score', 'fallen']),
        role: z.int().min(1).optional(),
        need: z.int().min(1),
        marks: z.array(z.int().min(1)).min(1).max(ROUNDS.max - 1),
      })
      .strict()
      .optional(),
    /** Počítadlo háčků počítá tiky přestávek (`worldTickOf`): žánr pouští věci v pevných ticích (P66 T10). */
    clock: z.literal(true).optional(),
    /** `extra_life` život jen vrátí, nejvýš do tolika (počet na startu, dosavadní žánr P66 T10); bez pole +1 navíc. */
    lifeCap: z.int().min(1).max(99).optional(),
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
  .strict()
  .refine((params) => params.keeper !== undefined || !stateful(params), { message: 'hooks with rounds, upgrades or rarity need a keeper' });
export type HookParams = z.infer<typeof hookParams>;

/** Píšou háčky stav do počítadla? Kola (přestávky, `clock`), vylepšení (`swing`, `lifeCap`) a vzácnost ano. */
const stateful = (hooks: { readonly rounds: number; readonly upgrades?: object; readonly rarity?: object }): boolean =>
  hooks.rounds > 1 || hooks.upgrades !== undefined || hooks.rarity !== undefined;

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
  readonly clear?: HookParams['clear'];
  /** Jen `clear: 'goal'`: postup a značky kol (`hookRequestOf` je spočítá z `TunedGame.goal`). */
  readonly goal?: HookParams['goal'];
  readonly clock?: true;
  readonly lifeCap?: number;
  readonly swing?: Swing;
}

export interface HookedParts {
  readonly level: ArcadeLevel;
  readonly rules: PieceRef[];
  readonly bot: PieceRef;
  /** Index počítadla háčků – kusy žánru ho dostanou do parametrů; háčky bez stavu (`stateful`) ho nemají. */
  readonly keeper: number | undefined;
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
  const params: Omit<HookParams, 'keeper'> = {
    rounds: request.rounds,
    clear: request.clear ?? 'win',
    ...(request.clear === 'goal' && request.goal !== undefined ? { goal: request.goal } : {}),
    ...(request.clock === true ? { clock: true as const } : {}),
    ...(upgrades !== undefined && request.lifeCap !== undefined ? { lifeCap: request.lifeCap } : {}),
    ...(upgrades === undefined ? {} : { upgrades }),
    ...(request.rarity === true ? { rarity: { draws: drawRarities(seed) } } : {}),
    ...(upgrades !== undefined && request.swing !== undefined && request.upgrades?.includes('fire_rate') === true ? { swing: request.swing } : {}),
  };
  // Háčky bez stavu tělo nedostanou: posunulo by indexy vzniklých těl a s nimi hru (bloudění hlídky je z indexu).
  if (!stateful(params)) return { level: parts.level, rules: [...parts.rules, { id: 'hooks', params }], bot: parts.bot, keeper: undefined };
  return {
    level: { ...parts.level, bodies: [...parts.level.bodies, counter] },
    rules: [...parts.rules, { id: 'hooks', params: { keeper, ...params } }],
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
  /**
   * Postup, na jehož stejné díly jdou kola, když to nejsou vlny (P66 T10, `breakGoal` v `pacing-parts`): skóre sběru,
   * padlí nepřátelé střelnice. Bez něj kola = vlny (`arena_waves`, obrana pruhů).
   */
  readonly goal?: { readonly by: 'wave' | 'score' | 'fallen'; readonly role?: number; readonly need: number };
  /** Vylepšení, která čte kus žánru sám (`upgradeLevel`, P66 T10: zbraň střelnice, obrana pruhů). */
  readonly own?: readonly UpgradeId[];
  /** Žánr pouští věci v pevných ticích a chce hodiny světa (`worldTickOf`). */
  readonly clock?: true;
}

/** Co hra od háčků chce, než se ověří proti hře (`hookRequestOf`): klíče `tuning`, nebo nabídka žánru. */
export interface HookAsk {
  readonly rounds: number;
  readonly upgrades?: readonly string[];
  readonly rarity?: boolean;
  /** Kola na stejné díly vln, i když jich je víc než kol (nabídka žánru; klíče `tuning` chtějí kolo = vlna). */
  readonly byWaves?: true;
  /** `extra_life` jen vrátí život do počtu na startu (`lifeCap`): dosavadní žánr drží své pásmo obtížnosti. */
  readonly heal?: true;
}

/** Vlny dosavadního žánru: vlny arény (`arena_waves`), nebo začátky vln obrany pruhů (`defense_shot`). */
function wavesOf(rules: readonly PieceRef[]): readonly unknown[] | undefined {
  return (nativeRule(rules, 'arena_waves')?.params.waves ?? nativeRule(rules, 'defense_shot')?.params.waves) as readonly unknown[] | undefined;
}

/**
 * Ověří žádost proti hře. Karta musí v té hře něco dělat: `extra_life` chce životy, `magnet` sbírané věci, `fire_rate`
 * ránu hrdiny (`Swing`) nebo zbraň žánru (`own`), `range` a `carry` kus žánru, který je čte (`own`). Kola dosavadního
 * žánru jsou jeho vlny (`clear: 'wave'`, právě tolik vln), nebo stejné díly postupu `goal` (`clear: 'goal'`).
 * `at` pojmenuje klíč chyby.
 */
export function hookRequestOf(ask: HookAsk, game: TunedGame, at: (key: string) => string = (key) => `/controlParams/tuning/${key}`): { readonly request: HookRequest } | { readonly issues: readonly string[] } {
  const issues: string[] = [];
  const { rounds, upgrades } = ask;
  if (!Number.isInteger(rounds) || rounds < ROUNDS.min || rounds > ROUNDS.max) issues.push(`${at('hookRounds')}: ${String(rounds)} rounds, not ${ROUNDS.min}–${ROUNDS.max}`);
  if (upgrades !== undefined) {
    const unknown = upgrades.filter((id) => !(UPGRADES as readonly string[]).includes(id));
    if (unknown.length > 0) issues.push(`${at('hookUpgrades')}: no upgrade ${unknown.join(', ')} (${UPGRADES.join(', ')})`);
    if (new Set(upgrades).size !== upgrades.length || upgrades.length < UPGRADE_OFFER.size) issues.push(`${at('hookUpgrades')}: an offer shows ${UPGRADE_OFFER.size} different cards, so list at least ${UPGRADE_OFFER.size} different upgrades once each`);
    if (rounds === 1) issues.push(`${at('hookUpgrades')}: upgrades are picked between rounds – set hookRounds 2–5`);
    const own = (id: UpgradeId): boolean => game.own?.includes(id) === true;
    const idle: Readonly<Record<UpgradeId, boolean>> = {
      speed: false,
      extra_life: (game.lives ?? 0) <= 0,
      magnet: !game.level.bodies.some((body) => body.role === 'collectible'),
      fire_rate: game.swing === undefined && !own('fire_rate'),
      range: !own('range'),
      carry: !own('carry'),
    };
    const useless = upgrades.filter((id) => Object.hasOwn(idle, id) && idle[id as UpgradeId]);
    if (useless.length > 0) issues.push(`${at('hookUpgrades')}: ${useless.join(', ')} would do nothing in this game (extra_life needs lives, magnet things to collect, fire_rate a strike or a gun; range and carry a genre that reads them)`);
  }
  const waves = wavesOf(game.rules);
  const shares: TunedGame['goal'] = ask.byWaves === true && waves !== undefined && waves.length + 1 !== rounds ? { by: 'wave', need: waves.length + 1 } : undefined;
  const goal = rounds !== 1 ? (game.goal ?? shares) : undefined;
  if (goal !== undefined && goal.need < rounds) issues.push(`${at('hookRounds')}: ${String(rounds)} rounds need a goal of at least ${String(rounds)}, this game has ${String(goal.need)}`);
  else if (rounds !== 1 && goal === undefined && waves === undefined) issues.push(`${at('hookRounds')}: rounds of an existing genre are its waves, and this game has none`);
  else if (rounds !== 1 && goal === undefined && waves !== undefined && waves.length + 1 !== rounds) issues.push(`${at('hookRounds')}: ${String(rounds)} rounds but the game has ${String(waves.length + 1)} waves – set tuning waves to the same number`);
  if (issues.length > 0) return { issues };
  // Značky kol: stejné díly cíle; `need ≥ rounds`, takže rostou a první je aspoň 1.
  const marks = goal === undefined ? undefined : Array.from({ length: rounds - 1 }, (_, k) => Math.floor((goal.need * (k + 1)) / rounds));
  return {
    request: {
      rounds,
      clear: goal === undefined ? 'wave' : 'goal',
      ...(goal === undefined || marks === undefined ? {} : { goal: { by: goal.by, ...(goal.role === undefined ? {} : { role: goal.role }), need: goal.need, marks } }),
      ...(game.clock === true && rounds !== 1 ? { clock: true as const } : {}),
      ...(ask.heal === true && game.lives !== undefined && game.lives > 0 ? { lifeCap: game.lives } : {}),
      ...(upgrades === undefined ? {} : { upgrades: upgrades as UpgradeId[] }),
      ...(ask.rarity === true ? { rarity: true } : {}),
      ...(game.swing === undefined ? {} : { swing: game.swing }),
    },
  };
}

/**
 * Háčky z klíčů `tuning` (jen hra `genre.v6`, rozhoduje volající): `hookRounds` 1–5, `hookUpgrades` = zásoba
 * vylepšení čárkami (`"speed,fire_rate,extra_life"`), `hookRarity` = `true`. Ověří je `hookRequestOf`; chyba je
 * chyba specu s důvodem.
 */
export function hookTuningOf(tuning: Readonly<Record<string, unknown>> | undefined, game: TunedGame): { readonly request: HookRequest } | { readonly issues: readonly string[] } | null {
  if (tuning === undefined || !HOOK_TUNING.some((key) => key in tuning)) return null;
  const at = (key: string): string => `/controlParams/tuning/${key}`;
  const issues: string[] = [];
  const rounds = tuning.hookRounds ?? 1;
  if (typeof rounds !== 'number') issues.push(`${at('hookRounds')}: ${String(rounds)} rounds, not ${ROUNDS.min}–${ROUNDS.max}`);
  const raw = tuning.hookUpgrades;
  const upgrades = typeof raw === 'string' ? raw.split(',').map((id) => id.trim()) : undefined;
  if (raw !== undefined && upgrades === undefined) issues.push(`${at('hookUpgrades')}: a comma list of ${UPGRADES.join(', ')}`);
  if (tuning.hookRarity !== undefined && tuning.hookRarity !== true) issues.push(`${at('hookRarity')}: true or absent`);
  if (issues.length > 0) return { issues };
  return hookRequestOf({ rounds: rounds as number, ...(upgrades === undefined ? {} : { upgrades }), ...(tuning.hookRarity === true ? { rarity: true } : {}) }, game, at);
}

/**
 * Háčky, které hra `genre.v6` dosavadního žánru dostane sama, bez klíčů (P66 T10, nabídka žánru `genreHookOffer`
 * v `pacing-parts`). Hra kvůli nim nikdy neselže: co hra neunese, ustoupí – nejdřív kola s výběrem, pak vzácnost;
 * létající skóre a hlášky komba (kolo 1) zůstanou vždy.
 */
export function offeredHooks(ask: HookAsk, game: TunedGame): HookRequest {
  const tries: HookAsk[] = [ask, { rounds: 1, ...(ask.rarity === true ? { rarity: true } : {}) }, { rounds: 1 }];
  for (const tried of tries) {
    const made = hookRequestOf(tried, game);
    if ('request' in made) return made.request;
  }
  return { rounds: 1, clear: 'wave' };
}

// ---------------------------------------------------------------------------
// Tik (volá `kernel.ts`)

/**
 * Začátek tiku. V přestávce svět stojí: vrátí zprávy tiku přestávky a jádro tik jen odpočte (`true`). Jinak promítne
 * vylepšení do hrdiny (`boostHero`) a vrátí `false`.
 */
export function hooksStart(state: Int32Array, input: ArcadeInput, params: HookParams, out: ArcadeEffect[]): boolean {
  const { keeper } = params;
  if (keeper === undefined) return false;
  if (inBreak(state, keeper)) {
    out.push(...breakTick(state, input, params, keeper));
    return true;
  }
  boostHero(state, state[HEADER.player] as number, keeper);
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
  // Vzácnost, rána a kola mají počítadlo vždy (schéma `hookParams`).
  const { keeper } = params;
  for (let i = 0; i < effects.length; i += 1) {
    const effect = effects[i] as ArcadeEffect;
    const amount = effect.kind === 'score' || (effect.kind === 'count' && effect.counter === 'score') ? effect.amount : 0;
    if (amount <= 0) continue;
    const found = params.rarity === undefined || keeper === undefined ? undefined : collectedAt(state, effects, i);
    if (found === undefined) {
      out.push({ kind: 'score_pop', amount, body: popBody(state, effects, i) });
      continue;
    }
    state[score] = (state[score] as number) + rarityBonus(amount, found.rarity);
    addFound(state, keeper as number, found.rarity);
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
  if (keeper !== undefined) {
    if (params.swing !== undefined) shortenSwing(state, state[HEADER.player] as number, keeper, params.swing);
    if (params.rarity !== undefined) assignRarities(state, keeper, params.rarity.draws);
    if (params.rounds > 1) roundsEnd(state, params, keeper, out);
  }
  effects.push(...out);
}
