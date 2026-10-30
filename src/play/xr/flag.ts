/**
 * Brána VR (P67 T1): „Enter VR“ dostane každý prohlížeč, který umí `immersive-vr`. Rozhoduje schopnost, ne adresa;
 * `?vr=0` je jen vypínač pro ladění. Na telefonu a desktopu bez brýlí odpoví prohlížeč „ne“ a kód XR se vůbec
 * nenačte (dynamický import v `XrGate.tsx`), takže první snímek nezaplatí ani bajt.
 */

/** Adresa VR nevypnula (`?vr=0`). */
export function xrWanted(url: string | URL): boolean {
  return new URL(url, 'http://play.invalid/').searchParams.get('vr') !== '0';
}

/** Adresa žádá panel FPS ve VR (`?vrhud=1`, P65 T6) – pro měření v brýlích, ruční brána T8. */
export function fpsHudWanted(url: string | URL): boolean {
  return new URL(url, 'http://play.invalid/').searchParams.get('vrhud') === '1';
}

/** Část `navigator.xr`, na kterou se brána ptá. */
export interface XrSystemLike {
  isSessionSupported(mode: 'immersive-vr'): Promise<boolean>;
}

const navigatorXr = (): XrSystemLike | undefined => (typeof navigator === 'undefined' ? undefined : (navigator as { xr?: XrSystemLike }).xr);

/** Prohlížeč umí immersive VR; chybějící `navigator.xr` i výjimka z dotazu = ne. */
export async function xrSupported(xr: XrSystemLike | undefined = navigatorXr()): Promise<boolean> {
  if (xr === undefined) return false;
  try {
    return (await xr.isSessionSupported('immersive-vr')) === true;
  } catch {
    return false;
  }
}

/** Načíst kód XR: adresa VR nevypnula a prohlížeč ho umí. Jediné místo, kde se to rozhoduje (`XrGate`; worker PWA registruje kód XR za ní). */
export async function xrGateOpen(url: string | URL, xr: XrSystemLike | undefined = navigatorXr()): Promise<boolean> {
  return xrWanted(url) && (await xrSupported(xr));
}
