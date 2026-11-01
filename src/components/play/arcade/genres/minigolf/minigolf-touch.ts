/**
 * Natažení zpět minigolfu (P68 T8) – čisté funkce gesto → `ArcadeInput`, které sdílí dotyk i klávesnice
 * (`MinigolfTouch.tsx`), takže tvar záznamu je pro obě ruce týž.
 *
 * - **Prst** táhne od míčku dozadu: úhel tahu proti směru, kterým kamera kouká, dá osu míření (rána jde **proti**
 *   tahu – tah dolů = rána vpřed), délka tahu za mrtvou zónou dá nabití 1–60 (`pullBack`). Puštění pod mrtvou zónou
 *   ránu zruší. Tah se měří vůči ose míření ze stavu v okamžiku stisku (`base`): kamera se během tahu otáčí za
 *   mířením, prst ale drží rámec, ve kterém začal.
 * - **Klávesnice**: šipky otáčejí osu (`turnAxis`), mezerník držený nabíjí, puštěný odpálí (`keyPutt`).
 * - **Tik** (`puttInput`): dokud nabití ve stavu nedosáhne délky tahu, jde `HOLD` s osou; pak osa bez tlačítek,
 *   po puštění `TAP` s osou. Puštění dřív, než nabití tah dožene, ránu jen odloží (nejvýš o 60 tiků) – síla je délka
 *   tahu, ne rychlost prstu. Zkrácený tah nabití shodí (`DOWN`) a nabije znovu na novou délku.
 *
 * Jádro (`minigolf.ts`) chce osu v každém tiku s `HOLD` / `TAP` (jinak by míření spadlo na 0 = +z) – `puttInput` ji
 * nese vždy. Scéna zrcadlí x jádra (jako aréna), takže kladná osa míří na obrazovce doprava.
 */

import { AXIS_MAX, type ArcadeInput, BUTTON, NO_INPUT } from '@/play/arcade/contract';
import { BALL } from '@/play/arcade/pieces/ball';
import { minigolfAim, minigolfAxisToward } from '@/play/arcade/pieces/minigolf-roll';

export const MINIGOLF_PULL = {
  /** Tah kratší než tohle (CSS px) je zrušení: puštění nedá ránu. */
  deadZone: 24,
  /** Px tahu za mrtvou zónou na jeden tik nabití: plná síla (60) na 24 + 180 = 204 px. */
  pxPerCharge: 3,
  /** O kolik nabití smí stav přetéct délku tahu (víc tiků v jednom snímku), než se nabití shodí a nabije znovu. */
  slack: 4,
  /** Krok osy šipkou za tik: 2000 = celé kolo, 5 = 0,9° (54°/s). */
  turn: 5,
} as const;

/** Zamýšlená rána: osa míření a nabití 1–60 (u klávesnice až do puštění plných 60). */
export interface PuttAim {
  readonly axis: number;
  readonly charge: number;
}

/** Gesto jedné rány: kam a jak silně (`null` = v mrtvé zóně) a jestli už ruka pustila. */
export interface Putt {
  readonly aim: PuttAim | null;
  readonly released: boolean;
}

/** Jednotkový směr míření osy `axis` v rovině jádra (x, z). */
function unitAim(axis: number): readonly [number, number] {
  const [x, z] = minigolfAim(axis);
  const length = Math.hypot(x, z);
  return [x / length, z / length];
}

/**
 * Tah prstu o (`dx`, `dy`) CSS px od startu (y dolů) při kameře mířící osou `base` → zamýšlená rána, nebo `null` pod
 * mrtvou zónou. Vpravo na obrazovce je směr míření otočený doprava, v jádře `(fz, −fx)`; rána = vpřed × `dy` +
 * vpravo × (−`dx`), tedy proti tahu.
 */
export function pullBack(base: number, dx: number, dy: number): PuttAim | null {
  const length = Math.hypot(dx, dy);
  if (length < MINIGOLF_PULL.deadZone) return null;
  const [fx, fz] = unitAim(base);
  const sx = fx * dy - fz * dx;
  const sz = fz * dy + fx * dx;
  const charge = Math.min(BALL.maxCharge, Math.max(1, Math.ceil((length - MINIGOLF_PULL.deadZone) / MINIGOLF_PULL.pxPerCharge)));
  return { axis: minigolfAxisToward(Math.round(sx * 1000), Math.round(sz * 1000)), charge };
}

/**
 * Opak `pullBack`: tah (px, y dolů), který při kameře `base` dá osu `axis` a nabití `charge`. Pro prst e2e, který
 * hraje podle `botWants` – délka leží uprostřed pásma nabití, ať zaokrouhlení souřadnic dotyku nabití nezmění.
 */
export function pullFor(base: number, axis: number, charge: number): { readonly dx: number; readonly dy: number } {
  const [fx, fz] = unitAim(base);
  const [sx, sz] = unitAim(axis);
  const length = MINIGOLF_PULL.deadZone + (Math.min(BALL.maxCharge, Math.max(1, charge)) - 0.5) * MINIGOLF_PULL.pxPerCharge;
  // Rána = vpřed × dy − vpravo × dx, vpřed (fx, fz), vpravo (fz, −fx).
  return { dx: -(sx * fz - sz * fx) * length, dy: (sx * fx + sz * fz) * length };
}

/** Osa po kroku `step` (kladný = doprava); za ±1000 (= −z) pokračuje z druhé strany. */
export function turnAxis(axis: number, step: number): number {
  const next = axis + step;
  return next > AXIS_MAX ? next - 2 * AXIS_MAX : next < -AXIS_MAX ? next + 2 * AXIS_MAX : next;
}

/** Klávesnice: mezerník držený = nabíjet do plna, puštěný = rána s nabitím `charge`, které stav má v tu chvíli. */
export function keyPutt(axis: number, held: boolean, charge: number): Putt {
  return held ? { aim: { axis, charge: BALL.maxCharge }, released: false } : { aim: { axis, charge }, released: true };
}

/**
 * Vstup příštího tiku pro gesto `putt` při nabití `charge` ve stavu; `done` = gesto skončilo (rána nebo zrušení)
 * a ruka už nic nedrží.
 */
export function puttInput(putt: Putt, charge: number): { readonly input: ArcadeInput; readonly done: boolean } {
  const { aim, released } = putt;
  if (aim === null) return { input: charge > 0 ? { buttons: BUTTON.DOWN, axis: 0 } : NO_INPUT, done: released };
  if (charge > aim.charge + MINIGOLF_PULL.slack) return { input: { buttons: BUTTON.DOWN, axis: aim.axis }, done: false };
  if (charge < aim.charge) return { input: { buttons: BUTTON.HOLD, axis: aim.axis }, done: false };
  return released ? { input: { buttons: BUTTON.TAP, axis: aim.axis }, done: true } : { input: { buttons: 0, axis: aim.axis }, done: false };
}
