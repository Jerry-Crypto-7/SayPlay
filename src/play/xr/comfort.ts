/**
 * Pohodlí ve VR (P67 T9): volby panelu „Comfort“ (`XrComfort`) a co z nich čte rig.
 *
 * - **Volby** (`Comfort`): vsedě nebo vestoje, velikost světa, vibrace, vinětace. Drží se v `localStorage`
 *   (`sp-vr-comfort`); úložiště, které nejde číst ani psát (soukromé okno, zakázané cookies, poškozený záznam),
 *   dá výchozí hodnoty a volba pak platí do konce stránky.
 * - **Recenter** (`recenterTo`): svět se otočí k pohledu hráče a postaví se před něj. Jen na stisk hráče, nikdy sám,
 *   a neukládá se – každá relace má vlastní počátek prostoru (`XrRoot` ho po relaci vrátí).
 * - **Panel otevřený** (`openComfort`): karta stojí místo lobby nebo výsledku.
 *
 * Nic z toho nejde do hashovaného stavu, je to jen kresba a vibrace. Soubor je jen v kódu XR (chunk `XrRoot`), ne
 * v `xr-context.ts`: ten je v prvním JS každého telefonu, a to dvakrát.
 */

import { useMemo } from 'react';

import { shared, useShared } from '@/components/play/xr/xr-context';

import { type DeskPose, type Layout, type Room, worldOfDesk } from './diorama-scale';
import { DESK_MODE, type XrModeEntry } from './modes';

export type Stance = 'standing' | 'seated';
export type WorldSize = 'small' | 'medium' | 'large';

export interface Comfort {
  readonly stance: Stance;
  readonly size: WorldSize;
  readonly haptics: boolean;
  readonly vignette: boolean;
}

export const COMFORT_DEFAULTS: Comfort = { stance: 'standing', size: 'medium', haptics: true, vignette: true };

export const COMFORT_KEY = 'sp-vr-comfort';

/**
 * Vsedě má hráč oči ~40 cm níž (1,2 m místo 1,6 m). Stůl, pódium i svět kolem hráče klesnou o tolik, takže vsedě
 * vidí totéž co vestoje. Hry rukou se nemění: jejich svět je v dosahu ruky nebo 1:1 na podlaze.
 */
export const SEATED_DROP = 0.4;

/**
 * Velikost světa: násobí měřítko stolu, pódia i světa kolem hráče (ten nejvýš 1:1). `small` navíc dá tratě a hry
 * kolem hráče na stůl – v pohybu je menší kus zorného pole.
 */
export const SIZES: Readonly<Record<WorldSize, number>> = { small: 0.75, medium: 1, large: 1.25 };

const STANCES: readonly Stance[] = ['standing', 'seated'];
const SIZE_IDS = Object.keys(SIZES) as WorldSize[];
const SWITCH: readonly boolean[] = [true, false];

type KeyStore = Pick<Storage, 'getItem' | 'setItem'>;

/** Už samotný přístup k `localStorage` smí vyhodit (Safari private, zakázané cookies), proto přes funkci v `try`. */
const browserStorage = (): KeyStore => window.localStorage;

const pick = <T>(value: unknown, allowed: readonly T[], fallback: T): T => (allowed.includes(value as T) ? (value as T) : fallback);

/** Uložené volby; co chybí nebo nesedí, má výchozí hodnotu. Chyba úložiště = výchozí volby. */
export function loadComfort(storage: () => KeyStore = browserStorage): Comfort {
  try {
    const raw = storage().getItem(COMFORT_KEY);
    if (raw === null) return COMFORT_DEFAULTS;
    const saved: unknown = JSON.parse(raw);
    if (typeof saved !== 'object' || saved === null) return COMFORT_DEFAULTS;
    const { stance, size, haptics, vignette } = saved as Partial<Record<keyof Comfort, unknown>>;
    return {
      stance: pick(stance, STANCES, COMFORT_DEFAULTS.stance),
      size: pick(size, SIZE_IDS, COMFORT_DEFAULTS.size),
      haptics: pick(haptics, SWITCH, COMFORT_DEFAULTS.haptics),
      vignette: pick(vignette, SWITCH, COMFORT_DEFAULTS.vignette),
    };
  } catch {
    return COMFORT_DEFAULTS;
  }
}

/** Zapíše volby; úložiště, které zápis odmítne, nevadí – volba platí do konce stránky. */
export function saveComfort(comfort: Comfort, storage: () => KeyStore = browserStorage): void {
  try {
    storage().setItem(COMFORT_KEY, JSON.stringify(comfort));
  } catch {
    // Bez úložiště jen v paměti.
  }
}

const options = shared<Comfort>(loadComfort());

export const comfortNow = (): Comfort => options.get();

export function setComfort(next: Comfort, storage: () => KeyStore = browserStorage): void {
  options.set(next);
  saveComfort(next, storage);
}

export const useComfort = (): Comfort => useShared(options, COMFORT_DEFAULTS);

/** Kde hráč stál a kam se díval při „Recenter“ (m; rad kolem svislé osy jako three.js). Výchozí: počátek, pohled −z. */
export interface Heading {
  readonly x: number;
  readonly z: number;
  readonly yaw: number;
}

const AHEAD: Heading = { x: 0, z: 0, yaw: 0 };
const heading = shared<Heading>(AHEAD);

export function recenterTo(next: Heading): void {
  heading.set(next);
}

export function resetRecenter(): void {
  if (heading.get() !== AHEAD) heading.set(AHEAD);
}

export const useHeading = (): Heading => useShared(heading, AHEAD);

/** Otočení hlavy kolem svislé osy z kvaternionu pózy brýlí; hlava svisle nahoru nebo dolů směr nemá (`null`). */
export function yawOfHead(q: { readonly x: number; readonly y: number; readonly z: number; readonly w: number }): number | null {
  // Pohled (−z otočené kvaternionem) ve vodorovné rovině.
  const x = -2 * (q.x * q.z + q.w * q.y);
  const z = -(1 - 2 * (q.x * q.x + q.y * q.y));
  return Math.hypot(x, z) < 1e-3 ? null : Math.atan2(-x, -z);
}

/**
 * Rám hráče jako póza desky (`worldOfDesk`): bod a směr z „Recenter“, `top` = podlaha světa (vsedě `−SEATED_DROP`).
 * Výchozí rám je identita, takže bez voleb se nic nemění.
 */
export const frameOf = (stance: Stance, at: Heading): DeskPose => ({ x: at.x, top: stance === 'seated' ? -SEATED_DROP : 0, z: at.z, yaw: at.yaw });

export function usePlayerFrame(): DeskPose {
  const { stance } = useComfort();
  const at = useHeading();
  return useMemo(() => frameOf(stance, at), [stance, at]);
}

/** Výchozí poloha desky (stůl nebo pódium) v rámu hráče: před ním, otočená k němu, vsedě níž. */
export function deskHome(room: Room, frame: DeskPose): DeskPose {
  const at = worldOfDesk(frame, { x: room.x, y: room.top, z: room.z });
  return { x: at.x, top: at.y, z: at.z, yaw: frame.yaw };
}

/** Režim podle velikosti světa: `small` dá tratě a hry kolem hráče na stůl; hry rukou a stolní zůstanou. */
export const sizedMode = (entry: XrModeEntry, size: WorldSize): XrModeEntry => (size === 'small' && (entry.mode === 'room' || entry.mode === 'surround') ? DESK_MODE : entry);

/** Rozvržení desky s měřítkem násobeným velikostí světa; `medium` vrátí totéž rozvržení. */
export function sizedLayout(layout: Layout, size: WorldSize): Layout {
  const factor = SIZES[size];
  return factor === 1 ? layout : { ...layout, scale: (area) => layout.scale(area) * factor };
}

/** Měřítko světa kolem hráče podle velikosti; větší než 1:1 nikdy. */
export const sizedRoomScale = (scale: number, size: WorldSize): number => Math.min(1, scale * SIZES[size]);

const open = shared(false);

export function openComfort(): void {
  open.set(true);
}

export function closeComfort(): void {
  if (open.get()) open.set(false);
}

export const useComfortOpen = (): boolean => useShared(open, false);
