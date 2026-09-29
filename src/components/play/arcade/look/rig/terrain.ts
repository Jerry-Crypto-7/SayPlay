/**
 * Výška hrací plochy (P32-0 T5) – ta, se kterou počítá jádro. Vizuální terén
 * (P32A) smí měnit tvar jen mimo hrací plochu; uvnitř musí sedět přesně na ni,
 * jinak hráč pluje nebo se boří.
 *
 * Jádro má zem rovnou v y = 0 v každém ovládání a v každém bodě: těleso
 * s gravitací se zastaví na `y <= 0` (`integrate` v `kernel.ts`). Plošinovka
 * na zem nikdy nedopadne – pod `PLATFORM.fallBelowY` hráč propadl (`fall_out`).
 *
 * `x`, `z` jsou metry v osách jádra (scéna x zrcadlí), výsledek metry.
 */
export function playableGround(_control: string, _x: number, _z: number): number {
  return 0;
}
