/**
 * Kamera střelnice (P25G T6, vyčleněno v P62 T4): kde stojí vůči hráči. Čte ji `ShooterRig`,
 * který ji staví, i výzdoba hrací plochy (`look/field-dressing-worker.ts`): kus nesmí být vyšší
 * než paprsek z kamery k nepříteli či terči, který jde nad ním. Bez R3F, ať ji worker unese.
 */

/** Na šířku: tolik metrů nad zemí a za hráčem, kouká tolik před něj do výšky `aim`. */
export const WIDE = { up: 3.6, back: 5.5, ahead: 14, aim: 1 } as const;
/** Na výšku: tolik metrů nad hráčem a za ním, kouká tolik před něj. */
export const TALL = { up: 20, back: 9, ahead: 13 } as const;
