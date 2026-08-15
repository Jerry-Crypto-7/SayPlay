/**
 * Sdílená herní vrstva fallbacku: pevný tik, čistý krok, seedované streamy.
 *
 * Tři archetypy z T203 se do ní zapojí přes `Game<S>`. Všechno, co je společné —
 * odpočet tiků, ukončení, projekce do HUD, přehrání scriptované stopy — je tady
 * jednou, takže se to nedá ve třech hrách napsat třikrát a třikrát jinak.
 *
 * **Duplicita generátoru streamů z jádra je záměrná.** Axiom architektonické
 * nezávislosti (`plans/P2-fallback-tri-hry.md`) zakazuje fallbacku importovat
 * cokoliv z modulů jádra — `sim`, `ir`, `verify`, `patch`. Sdílený generátor by
 * znamenal, že fallback spadne se stejnou komponentou, proti jejímuž selhání má
 * pojistit. Patnáct řádek navíc je za to levná cena.
 *
 * Cesty k těm modulům se tu záměrně nepíšou v úplném tvaru: AC úlohy T202 je
 * doslovný grep nad `src/fallback`, a poznámka o zákazu by ho shodila stejně
 * jako skutečný import.
 */

import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';
import type { JumpableRandomGenerator } from 'pure-rand/types/JumpableRandomGenerator';

import type { ArchetypeId, CapabilityToken, Manifest } from './manifests';

/** 20 Hz, `VERIFY.md` §3.3. Simulovaný tik je jediná jednotka času ve hře. */
export const TICK_HZ = 20;
export const MS_PER_TICK = 1000 / TICK_HZ;

/** Kolik tiků je daný počet sekund. Časovače v manifestech jsou v sekundách. */
export function ticksForSeconds(seconds: number): number {
  return Math.round(seconds * TICK_HZ);
}

export const FALLBACK_STREAMS = ['layout', 'spawn', 'hazard', 'shuffle'] as const;

export type FallbackStream = (typeof FALLBACK_STREAMS)[number];

export type Streams = Readonly<Record<FallbackStream, JumpableRandomGenerator>>;

/**
 * Jeden oddělený stream na subsystém. `jump()` je posune tak daleko od sebe, že
 * se nepřekryjí — díky tomu smí rozmístění překážek spotřebovat libovolný počet
 * losů, aniž se tím pohne rozmístění sběratelných předmětů.
 */
export function createStreams(seed: number): Streams {
  const source = xoroshiro128plus(seed);
  const streams = {} as Record<FallbackStream, JumpableRandomGenerator>;
  for (const name of FALLBACK_STREAMS) {
    streams[name] = source.clone();
    source.jump();
  }
  return streams;
}

/** Jediná povolená distribuce, ať se `pure-rand` neimportuje po celém fallbacku. */
export function nextInt(stream: JumpableRandomGenerator, from: number, to: number): number {
  return uniformInt(stream, from, to);
}

/**
 * Vstup hráče přeložený do záměru. Hry nevidí myš ani klávesnici — vidí tohle,
 * a proto je scriptovaná stopa plnohodnotná náhrada člověka.
 */
export type Intent =
  | { readonly kind: 'move'; readonly dx: number; readonly dy: number }
  | { readonly kind: 'point'; readonly target: string }
  | { readonly kind: 'drag'; readonly from: string; readonly to: string };

export type Phase = 'running' | 'won' | 'lost';

/**
 * Natočení entity po mřížce. Čtyři směry, celočíselné — je to stav, ne úhel.
 *
 * **Kde se to jinak vymstí** (`DESIGN-BOOK.md` §12, řádek UE her, `REUSE.md`):
 * kusy kitu nemají společně normalizovaný „dopředu", takže se to u čtyřiceti
 * kusů zjistí až u dvanáctého. Konvence se proto píše na jedno místo a tady
 * je: **actor kusy kitu míří na +Z**, takže `yaw` pro `north` je 0 a roste po
 * čtvrtinách otáčky. Hry drží směr, vykreslení k němu přičte offset kusu.
 */
export const FACINGS = {
  north: { dx: 0, dy: 1, yaw: 0 },
  east: { dx: 1, dy: 0, yaw: 1 },
  south: { dx: 0, dy: -1, yaw: 2 },
  west: { dx: -1, dy: 0, yaw: 3 },
} as const;

export type Facing = keyof typeof FACINGS;

/** Směr z posunu o jedno pole. Nulový posun směr nemění, proto vrací `null`. */
export function facingFromDelta(dx: number, dy: number): Facing | null {
  if (dx === 0 && dy === 0) return null;
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 'east' : 'west';
  return dy > 0 ? 'north' : 'south';
}

export type Counter = {
  readonly label: string;
  readonly value: number;
  /** `null` = veličina bez stropu (počet chyb bez limitu, uplynulý čas). */
  readonly max: number | null;
};

/** Co vidí HUD. Hry si drží vlastní stav, ven dávají tuhle projekci. */
export type GameView = {
  readonly archetype: ArchetypeId;
  readonly title: string;
  readonly goal: string;
  readonly phase: Phase;
  readonly tick: number;
  readonly counters: readonly Counter[];
  readonly timeLeftTicks: number | null;
  readonly message: string | null;
  readonly sceneLayout: string;
};

/**
 * Kontrakt archetypu. `advance` je **čistá funkce jednoho tiku** — bez hodin,
 * bez globální náhody, bez sítě. Stejný seed a stejná stopa musí dát stejný
 * průběh, jinak nejde tvrdit, že enumerace n-tic něco dokázala.
 */
export interface Game<S> {
  readonly manifest: Manifest;
  readonly goal: string;
  create(seed: number): S;
  advance(state: S, intents: readonly Intent[]): S;
  project(state: S): GameView;
}

/** Stopa: jeden záznam na tik, uvnitř nula až N záměrů. Prázdné pole = čekání. */
export type Trace = readonly (readonly Intent[])[];

/**
 * Archetyp = manifest + doména parametrů + hra + řešitel.
 *
 * `solve` je tu proto, že tvrzení „žádná n-tice nevede k nedohratelnému světu"
 * se nedá doložit ručně psanou stopou pro 624 n-tic. Řešitel ji vyrobí a
 * enumerace ji přehraje; když neprojde, je to nález, ne chybějící test.
 */
export interface Archetype<P = unknown, S = unknown> {
  readonly id: ArchetypeId;
  readonly manifest: Manifest;
  /** Tokeny, které hra skutečně používá. Musí sedět do `supported` manifestu. */
  readonly uses: readonly CapabilityToken[];
  /** Všechny n-tice parametrické domény z `ARCHETYPES.md` §6. */
  tuples(): readonly P[];
  game(params: P): Game<S>;
  /** Vítězná stopa pro danou n-tici a seed, nebo `null`, když neexistuje. */
  solve(params: P, seed: number): Trace | null;
}

export type TraceResult<S> = {
  readonly state: S;
  readonly view: GameView;
  /** Kolik tiků se skutečně odehrálo, než hra skončila nebo došel strop. */
  readonly ticks: number;
};

/** Tři minuty při 20 Hz. Strop existuje proto, aby se test nedal zaseknout. */
export const DEFAULT_MAX_TICKS = ticksForSeconds(180);

/**
 * Přehraje stopu nad hrou a vrátí, kde skončila.
 *
 * Tiky za koncem stopy běží bez vstupu — to je záměr: hra s časovačem musí umět
 * dojet do prohry i po posledním hráčově pohybu.
 */
export function runTrace<S>(
  game: Game<S>,
  seed: number,
  trace: Trace,
  maxTicks: number = DEFAULT_MAX_TICKS,
): TraceResult<S> {
  let state = game.create(seed);
  let view = game.project(state);
  let ticks = 0;

  while (view.phase === 'running' && ticks < maxTicks) {
    state = game.advance(state, trace[ticks] ?? []);
    ticks += 1;
    view = game.project(state);
  }

  return { state, view, ticks };
}
