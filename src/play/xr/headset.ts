/**
 * Profil brýlí (P67 T10): Quest 3 a 3S kreslí ve vyšším rozlišení a na 90 Hz, Quest 2 a neznámé brýle mají
 * profil Questu 2 (`XR_QUALITY`) beze změny.
 *
 * Samostatný modul, ne `quality.ts`: ten je v prvním JS telefonu (`Effects.tsx` z něj bere strop částic), tohle
 * načítá jen kód XR (`XrRoot.tsx`).
 */

import { XR_QUALITY } from './quality';

/**
 * Quest 3 a 3S: GPU má asi dvojnásobný výkon Questu 2, takže unese 1,2× rozlišení prohlížeče a 90 Hz
 * (11,1 ms na snímek). Foveace a strop částic zůstávají jako na Questu 2. Na skutečném Questu 3 neověřeno.
 */
export const QUEST3_QUALITY = { ...XR_QUALITY, hz: 90, scale: 1.2 } as const;

export interface XrProfile {
  readonly hz: number;
  readonly foveation: number;
  readonly scale: number;
  readonly particles: number;
}

/** Prohlížeč Questu má model v UA: `(X11; Linux x86_64; Quest 3)`, `(…; Quest 3S)`. */
const QUEST3 = /\bQuest 3/;

/**
 * Profil podle prohlížeče a frekvencí relace. `supportedFrameRates` zná až relace; bez nich (rozlišení se volí
 * před relací) a bez 90 Hz v seznamu má Quest 3 frekvenci Questu 2 – `updateTargetFrameRate` s frekvencí mimo
 * seznam relaci odmítne.
 */
export function profileFor({
  userAgent,
  supportedFrameRates = [],
}: {
  readonly userAgent: string;
  readonly supportedFrameRates?: ArrayLike<number>;
}): XrProfile {
  if (!QUEST3.test(userAgent)) return XR_QUALITY;
  return Array.from(supportedFrameRates).includes(QUEST3_QUALITY.hz) ? QUEST3_QUALITY : { ...QUEST3_QUALITY, hz: XR_QUALITY.hz };
}
