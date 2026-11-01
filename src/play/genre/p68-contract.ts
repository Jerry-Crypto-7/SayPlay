/**
 * Zmrazená rozhraní pěti her P68 (T1). Jen typy a konstanty: kategorie P68-V (`stunt`, `minigolf`), P68-F
 * (`railfps`) a P68-S (`buildshift`, `drawsave`) podle nich píšou své soubory a P68-I je zapojuje. Změna tady
 * jde jen přes `evals/play/p68/<kategorie>/integration.md` → úloha zapojení v P68-I.
 *
 * Všechno chování těchto her platí od `genre.v7` (`P68_GENRE_VERSION`, kontrola `genreAtLeast`); staré žánry
 * pod `genre.v7` hrají beze změny.
 */

import { BODY } from '../arcade/contract';

import type { GenreId } from './contract';

/** Pět her P68 v pořadí kategorií. */
export const P68_GENRES = ['stunt', 'minigolf', 'railfps', 'buildshift', 'drawsave'] as const satisfies readonly GenreId[];
export type P68Genre = (typeof P68_GENRES)[number];

/** Kategorie (pruh P68), která hru staví – adresář `evals/play/p68/<kategorie>/`. */
export const P68_LANE: Readonly<Record<P68Genre, 'vozidla-sport' | 'prvni-osoba' | 'stavba'>> = {
  stunt: 'vozidla-sport',
  minigolf: 'vozidla-sport',
  railfps: 'prvni-osoba',
  buildshift: 'stavba',
  drawsave: 'stavba',
};

/**
 * Vstup hry na plátně (zmrazený): `steer` = náklon jako plavba, `throw-rig` = nabití a odpal jako hod,
 * `lanes` = klepnutí s buňkou mřížky v ose (`cellAxisAt`, jako šipky), `genre` = vlastní dotykový adaptér hry
 * z `src/components/play/arcade/genres/touch-registry.ts`, který volá jen `session.press` / `session.hold`.
 */
export const P68_INPUT = { stunt: 'steer', minigolf: 'throw-rig', railfps: 'genre', buildshift: 'lanes', drawsave: 'genre' } as const satisfies Readonly<Record<P68Genre, string>>;

/** Pohled kamery na hru. Kamera je jen kresba – do hashovaného stavu nejde. */
export type P68View = 'chase' | 'shoulder' | 'top' | 'first' | 'side';

/**
 * Povolené pohledy na hru; první je výchozí. Další pohled jen přes `integration.md` a úlohu zapojení.
 */
export const P68_VIEWS: Readonly<Record<P68Genre, readonly [P68View, ...P68View[]]>> = {
  stunt: ['chase'],
  minigolf: ['shoulder', 'top'],
  railfps: ['first'],
  buildshift: ['top'],
  drawsave: ['side'],
};

/**
 * Osa natočení `railfps`: jedna osa `ArcadeInput.axis`, celočíselný krok `yawStep` ∈ −16..16 (33 kroků).
 * Adaptér posílá přes `session.hold(axis)` jen hodnoty z `RAILFPS_AXES` (krok × 1000 / 16, oříznuto k nule na celé
 * číslo), jádro z osy vezme nejbližší krok a drží ho v celočíselném stavu hry (`RAILFPS_SLOTS.yawStep`). Kamera krok
 * jen sleduje. Tvar `ArcadeInput`, záznam, `packInputs` ani serverový replay se nemění; opakovaná hodnota osy se v Dare
 * slučuje do jednoho běhu, takže stopa drží pod stropem 64 kB.
 */
export const RAILFPS_YAW_STEPS = 16;

/** Hodnoty osy, které adaptér `railfps` smí poslat: index `step + 16` → osa. */
export const RAILFPS_AXES: readonly number[] = Array.from({ length: 2 * RAILFPS_YAW_STEPS + 1 }, (_, index) => Math.trunc(((index - RAILFPS_YAW_STEPS) * 1000) / RAILFPS_YAW_STEPS));

/** Role tělesa-držáku, na kterém `railfps` nese svůj celočíselný stav (jako háčky P66 na `keeper`). */
export const RAILFPS_KEEPER_ROLE = 'railfps_rig';

/** Sloty stavu `railfps` na držáku: `yawStep` −16..16. */
export const RAILFPS_SLOTS = { yawStep: BODY.x } as const;

/** Rozpočet trosek `stunt`: nejvýš tolik dynamických těl trosek ve světě naráz. Nastavení solveru Rapieru se nemění. */
export const STUNT_DEBRIS_MAX = 24;

/** Kreslení `drawsave`: tah = posloupnost buněk mřížky v ose (`cellAxisAt`) s `HOLD` po dobu tahu. */
export const DRAWSAVE_STROKE = { input: 'cell-axis', hold: 'HOLD' } as const;

/** Délka běhu, do které hra rozhodne výhru i prohru (90 s při 60 tikách). */
export const P68_MAX_TICKS = 5400;
