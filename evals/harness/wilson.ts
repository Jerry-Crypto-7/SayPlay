/**
 * Wilsonův skórový interval — jediná binomiální mez v projektu (T20).
 *
 * Proč zrovna Wilson a ne „p ± z·√(p(1−p)/n)": normální aproximace u malých
 * jmenovatelů a u měr blízko jedničky vyrábí meze mimo interval <0, 1> a její
 * pokrytí se hroutí přesně tam, kde nás to zajímá — u 93 ze 100. Wilson řeší
 * skórovou rovnici, takže meze z <0, 1> nevypadnou nikdy a při x = 0 nebo x = n
 * dá pořád netriviální odpověď.
 *
 * **Meze jsou kořeny skórové rovnice** |p̂ − p| = z·√(p(1−p)/n). Uzavřený tvar
 * níž je jen její vyřešení; test si tuhle rovnost ověřuje zvlášť, takže by
 * překlep v algebře neprošel jen proto, že se test dívá na tentýž vzorec.
 *
 * `evals/frozen/protocol.v1.json` (`aggregateGates.wilsonCaveat`) na téhle mezi
 * staví svoje varování: *„Při 93/100 je Wilsonova dolní mez jen 86,2 %"*. Tohle
 * je implementace toho čísla — a test proti němu asertuje.
 */

/** Kritická hodnota normálního rozdělení pro oboustranných 95 %. */
export const Z_95 = 1.959963984540054;

export interface Interval {
  readonly successes: number;
  readonly trials: number;
  /** Bodový odhad, tedy syrový podíl. Není to střed intervalu — ten je posunutý. */
  readonly point: number;
  readonly lower: number;
  readonly upper: number;
  readonly z: number;
}

const clamp = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * Wilsonova mez pro `successes` z `trials`.
 *
 * **Prázdný jmenovatel je výjimka, ne interval <0, 1>.** Protokol
 * (`evalSet.incompleteRunRule`) zakazuje počítat míru úspěšnosti z neúplného
 * jmenovatele; kdyby se tady vrátilo „no jistota žádná", propadl by neúplný běh
 * do reportu jako širokánský, ale formálně platný výsledek.
 */
export function wilsonInterval(successes: number, trials: number, z: number = Z_95): Interval {
  if (!Number.isInteger(trials) || trials <= 0)
    throw new RangeError(`Wilsonova mez z prázdného jmenovatele: trials=${trials}`);
  if (!Number.isInteger(successes) || successes < 0 || successes > trials)
    throw new RangeError(`successes=${successes} není celé číslo v <0, ${trials}>`);
  if (!Number.isFinite(z) || z <= 0) throw new RangeError(`z musí být kladné konečné číslo, je ${z}`);

  const point = successes / trials;
  const zz = z * z;
  const denominator = 1 + zz / trials;
  const centre = (point + zz / (2 * trials)) / denominator;
  const spread = (z / denominator) * Math.sqrt((point * (1 - point)) / trials + zz / (4 * trials * trials));

  // Krajní meze se **dosazují**, nedopočítávají. Při x = 0 je dolní mez
  // analyticky přesně nula (střed i rozptyl vyjdou na týž výraz), jenže
  // odmocnina se do něj netrefí na poslední bit a zbyde 2,8e-17 — a při x = n
  // symetricky 1 − 1,1e-16. Uvnitř tolerance to je, ale třída se třemi záznamy
  // je v korpusu běžná, takže by report na 3/3 tiskl `0.9999999999999999`.
  return {
    successes,
    trials,
    point,
    lower: successes === 0 ? 0 : clamp(centre - spread),
    upper: successes === trials ? 1 : clamp(centre + spread),
    z,
  };
}
