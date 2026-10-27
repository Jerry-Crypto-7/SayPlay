/**
 * Kamera střelnice (P25G T6, vyčleněno v P62 T4): kde stojí vůči hráči. Čte ji `ShooterRig`,
 * který ji staví, i výzdoba hrací plochy (`look/field-dressing-worker.ts`): kus nesmí být vyšší
 * než paprsek z kamery k nepříteli či terči, který jde nad ním. Bez R3F, ať ji worker unese.
 *
 * P62 T5: nepřítel na střelnici měl ~5 % výšky obrazu (soudce: „small zombie figures“), čitelný je od 10 %
 * (`LEGIBLE_SHARE.target`) a vizuální zvětšení `foeScale` končí na 2×. Zbytek dá kamera:
 * - na šířku užší zorný úhel (`fov`): nepřítel ve 12–36 m ~1,3× větší, hrdina dole zůstává, kde byl;
 * - na výšku kamera níž a blíž: z 20 m nad hráčem byl nepřítel jen temeno. Víc kamera na výšku nedá – nepřítel
 *   stojí 12–26 m od hrdiny a hrdina musí zůstat v obraze; užší zorný úhel by ho vystrčil pod spodní hranu.
 * Celý kužel míření se na výšku nevejde ani dřív – kameru za nejbližším nepřítelem natáčí `ShooterRig`.
 */

/** Na šířku: tolik metrů nad zemí a za hráčem, kouká tolik před něj do výšky `aim`, svislý zorný úhel `fov` (°). */
export const WIDE = { up: 3.6, back: 5.5, ahead: 12, aim: 0.5, fov: 48 } as const;
/** Na výšku: tolik metrů nad hráčem a za ním, kouká tolik před něj. */
export const TALL = { up: 10, back: 6, ahead: 9 } as const;
