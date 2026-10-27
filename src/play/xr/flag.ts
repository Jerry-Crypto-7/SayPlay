/**
 * Brána VR (P65 T1): „Enter VR“ se ukáže jen s `?vr=1` v adrese a s prohlížečem,
 * který umí `immersive-vr`. Bez obou se kód XR vůbec nenačte (dynamický import
 * v `XrGate.tsx`), takže první snímek na telefonu nezaplatí ani bajt.
 */

/** Adresa žádá VR (`?vr=1`). */
export function xrWanted(url: string | URL): boolean {
  return new URL(url, 'http://play.invalid/').searchParams.get('vr') === '1';
}

/** Část `navigator.xr`, na kterou se brána ptá. */
export interface XrSystemLike {
  isSessionSupported(mode: 'immersive-vr'): Promise<boolean>;
}

/** Prohlížeč umí immersive VR; chybějící `navigator.xr` i výjimka z dotazu = ne. */
export async function xrSupported(xr: XrSystemLike | undefined = typeof navigator === 'undefined' ? undefined : (navigator as { xr?: XrSystemLike }).xr): Promise<boolean> {
  if (xr === undefined) return false;
  try {
    return (await xr.isSessionSupported('immersive-vr')) === true;
  } catch {
    return false;
  }
}
