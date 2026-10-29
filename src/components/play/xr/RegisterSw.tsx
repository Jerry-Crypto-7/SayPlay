/**
 * Instalace Sayplay jako aplikace na Questu (P67 T11). Service worker `public/play-sw.js` jen propouští síť; registruje
 * se jen v prohlížeči, který umí immersive VR, takže telefon a desktop zůstanou přesně jako dřív. Volá ho kód XR
 * (`XrRoot`, P67 T4): ten se stahuje jen tam, kde VR je, a telefon tak registraci nemá ani v prvním JS.
 */

import { type XrSystemLike, xrSupported } from '@/play/xr/flag';

export const SW_URL = '/play-sw.js';
export const SW_SCOPE = '/play';

/** Část `navigator`, kterou registrace potřebuje. */
export interface SwNavigatorLike {
  readonly xr?: XrSystemLike;
  readonly serviceWorker?: { register(url: string, options: { scope: string }): Promise<unknown> };
}

/** Zaregistruje worker, když prohlížeč umí VR. Vrátí, jestli registrace proběhla. */
export async function registerSw(nav: SwNavigatorLike = navigator as SwNavigatorLike): Promise<boolean> {
  if (nav.serviceWorker === undefined || !(await xrSupported(nav.xr))) return false;
  try {
    await nav.serviceWorker.register(SW_URL, { scope: SW_SCOPE });
    return true;
  } catch {
    return false;
  }
}
