/**
 * Kontrakt háčků (P66 T2): kola „Round N of M“, výběr 1 ze 3 vylepšení mezi vlnami, vzácnost sebrané věci,
 * moment bosse a zprávy pro obrazovku (létající skóre, hlášky). Jen typy, konstanty a rozložení stavu – chování
 * v jádře píše T3 (`rounds.ts`, `upgrades.ts`, `rarity.ts`, `boss.ts`), obrazovku T4.
 *
 * **Ve stavu a hashi je jen to, co mění hru:** kolo a přestávka, nabídka a volba vylepšení, stupně vylepšení, počty
 * nálezů podle vzácnosti. Volba je vstup v záznamu (`UPGRADE_PICK_BUTTONS`), čas se měří v ticích (60 Hz), náhoda
 * jde z vlastních streamů `pure-rand` (`HOOK_STREAMS`, připsané za dosavadní v `src/sim/rng.ts`). Létající čísla,
 * hlášky, rámečky vzácnosti, rekord a cíl vyzvání jsou jen zprávy (`HookEffect`) a DOM, mimo hash.
 *
 * Platí jen pro hry `genre.v6` a novější (`HOOKS_GENRE_VERSION`, `genreAtLeast`); uložené `genre.v5` háčky nemají
 * a hrají bit po bitu jako dřív.
 */

import type { Subsystem } from '@/sim/rng';

import { ARCADE_HZ, BODY, BUTTON } from '../contract';

/** Verze překladu žánru, od které hra háčky smí mít. */
export const HOOKS_GENRE_VERSION = 'genre.v6';

/** Streamy háčků (`createStreams(seed)[…]`): nabídky vylepšení, vzácnost věci při jejím vzniku, rozvrh kol. */
export const HOOK_STREAMS = ['upgrades', 'rarity', 'rounds'] as const satisfies readonly Subsystem[];

// ---------------------------------------------------------------------------
// Kola

export const ROUNDS = {
  /** Kol na úroveň: 1 = hra bez kol (jako dosud), nejvýš 5. */
  min: 1,
  max: 5,
  /** Přestávka po vyčištěném kole (1,5 s): banner „Round N of M“, pak hned další kolo bez nového načtení. */
  breakTicks: 90,
} as const;

// ---------------------------------------------------------------------------
// Vylepšení mezi vlnami

/** Uzavřený seznam vylepšení; žánr nabízí jen ta, která jeho hrdina umí (survivor střelbu, krádež náklad). */
export const UPGRADES = ['speed', 'fire_rate', 'range', 'extra_life', 'magnet', 'carry'] as const;
export type UpgradeId = (typeof UPGRADES)[number];

/**
 * Co jeden stupeň vylepšení přidá; T3 to promítne do parametrů hrdiny. `speed` +15 % pohybu, `fire_rate` o 20 %
 * kratší rozestup ran, `range` +20 % dostřelu, `extra_life` +1 život, `magnet` +1,5 m dosahu sběru (jednotky jádra),
 * `carry` +1 nesená věc (a o stupeň menší zpomalení s nákladem).
 */
export const UPGRADE_STEP: Readonly<Record<UpgradeId, number>> = { speed: 15, fire_rate: 20, range: 20, extra_life: 1, magnet: 1500, carry: 1 };

export const UPGRADE_OFFER = {
  /** Karet v jedné nabídce, bez opakování; los ze streamu `upgrades`. */
  size: 3,
  /** Tiků na volbu (5 s) – přestávka mezi vlnami trvá, dokud hráč nevybere, nejdéle tolik. */
  pickTicks: 5 * ARCADE_HZ,
  /** Kdo do konce přestávky nevybere, dostane první kartu: nečinný hráč i robot jsou tak deterministické. */
  defaultCard: 0,
  /** Kolikrát se jedno vylepšení smí vzít; vylepšení na stropu už nabídka nedá. */
  maxLevel: 3,
} as const;

/** Vstup volby karty 0–2 (tlačítka 1–3 v záznamu, klávesy 1/2/3 i klepnutí na kartu posílají totéž). */
export const UPGRADE_PICK_BUTTONS = [BUTTON.PICK_1, BUTTON.PICK_2, BUTTON.PICK_3] as const;

// ---------------------------------------------------------------------------
// Vzácnost

export const RARITY = ['common', 'rare', 'epic'] as const;
export type Rarity = (typeof RARITY)[number];
/** Váhy losu ze streamu `rarity` při vzniku věci (ne při sebrání); součet 100. */
export const RARITY_WEIGHTS: Readonly<Record<Rarity, number>> = { common: 70, rare: 25, epic: 5 };
/** Násobič skóre sebrané věci. */
export const RARITY_SCORE: Readonly<Record<Rarity, number>> = { common: 1, rare: 3, epic: 10 };

// ---------------------------------------------------------------------------
// Rozložení stavu

/**
 * Stav háčků nese tělo-počítadlo `hookKeeper` jako kombo a akce (`COMBO`, `ABILITY_SLOTS`): mrtvá předloha za
 * tělesy úrovně, jen ve světě s háčky, takže uložené hry ho nemají a jejich hash se nepohne. Sloty jsou posun od
 * prvního slotu těla; vzácnost jednotlivé věci nese věc sama (rozhodne T3, `rarity.ts`).
 */
export const HOOK_SLOTS = {
  /** Index běžícího kola 0..rounds−1 (`roundIndex`). */
  round: BODY.x,
  /** Zbylé tiky přestávky po vyčištěném kole; 0 = kolo běží. */
  breakLeft: BODY.y,
  /** Nabídka: tři kódy karet po `OFFER_BITS` (index v `UPGRADES` + 1, karta 0 v nejnižších bitech); 0 = žádná nabídka. */
  offer: BODY.z,
  /** Zbylé tiky na volbu karty; 0 = nic se nenabízí. */
  pickLeft: BODY.vx,
  /** Stupně vylepšení po `LEVEL_BITS` v pořadí `UPGRADES`. */
  levels: BODY.vy,
  /** Nalezené věci podle vzácnosti po `FOUND_BITS` v pořadí `RARITY`. */
  found: BODY.vz,
} as const;
export const OFFER_BITS = 8;
export const LEVEL_BITS = 4;
export const FOUND_BITS = 10;

// ---------------------------------------------------------------------------
// Zprávy pro obrazovku

/** Hlášky z uzavřeného seznamu; viditelný text (anglicky, `11-voice-copy.md`) drží obrazovka (T4, T11). */
export const CALLOUTS = ['combo_2', 'combo_3', 'combo_max', 'round_clear', 'epic_find', 'boss', 'new_best', 'beat_it'] as const;
export type CalloutId = (typeof CALLOUTS)[number];

/** Efekty tiku, které stav nemění – jádro je propustí scéně a HUD (`ArcadeEffect`). */
export type HookEffect =
  /** Létající „+30“ nad tělem `body` za přírůstek skóre `amount`. */
  | { readonly kind: 'score_pop'; readonly amount: number; readonly body: number }
  | { readonly kind: 'callout'; readonly callout: CalloutId }
  /** Kolo `round` (0..`rounds`−1) začalo, nebo je vyčištěné. */
  | { readonly kind: 'round_start'; readonly round: number; readonly rounds: number }
  | { readonly kind: 'round_clear'; readonly round: number; readonly rounds: number }
  /** Tři karty na výběr (karta 0 = výchozí volba). */
  | { readonly kind: 'upgrade_offer'; readonly offer: readonly [UpgradeId, UpgradeId, UpgradeId] }
  /** Vzatá karta `card` a její vylepšení – volbou hráče, nebo výchozí po `pickTicks`. */
  | { readonly kind: 'upgrade_pick'; readonly card: number; readonly upgrade: UpgradeId }
  /** Sebraná vzácná nebo epická věc `body`. */
  | { readonly kind: 'rare_found'; readonly rarity: Exclude<Rarity, 'common'>; readonly body: number }
  /** Boss `body` vstoupil do hry (útoky a finále zůstávají `BOSS_ATTACKS` a `pacing-parts`). */
  | { readonly kind: 'boss_enter'; readonly body: number };

/** Všechny druhy zpráv háčků – typ hlídá, že žádný nechybí. */
const HOOK_KINDS: Readonly<Record<HookEffect['kind'], true>> = {
  score_pop: true,
  callout: true,
  round_start: true,
  round_clear: true,
  upgrade_offer: true,
  upgrade_pick: true,
  rare_found: true,
  boss_enter: true,
};

export const isHookEffect = (effect: { readonly kind: string }): effect is HookEffect => Object.hasOwn(HOOK_KINDS, effect.kind);
