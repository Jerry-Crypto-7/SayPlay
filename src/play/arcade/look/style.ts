/**
 * Profil vzhledu celého obrazu (P81 T2): světlo, obloha, mlha, podlaha, obrysy, ladění a následné
 * zpracování na jednom místě. Dřív to byly konstanty rozeseté po rigu (`fog-light.ts`, `grade.ts`,
 * `Post.tsx`, `InkOutline.tsx`, podlaha arény a dráhy) – P77 přebarvila jen kulisy a změnilo se 2–5 %
 * obrazu. Vzhled celé hry teď mění jeden profil; rig, podlaha i obrysy čtou `LOOK_STYLE`.
 *
 * `TODAY_STYLE` drží hodnoty před P81 (pin `p81-style.test.ts`) – základ, proti kterému se nový vzhled měří.
 * Mimo hash: jádro profil nečte, jen kreslení.
 */

/** Rodiny prostředí pro ladění a zlatou hodinu (P37B T3); místo → rodina je `LOOK_FAMILY` v `grade.ts`. */
export const GRADE_FAMILIES = ['green', 'warm', 'cold', 'water', 'indoor', 'dark'] as const;
export type GradeFamily = (typeof GRADE_FAMILIES)[number];

/** Barevné ladění za ACES (`GradeEffect`): zisk·(c + zdvih·(1 − c)), gama, sytost, kontrast, viněta. */
export interface Grade {
  /** Zdvih stínů po kanálech (0 = černá zůstane černou). */
  readonly lift: readonly [number, number, number];
  /** Zisk světel po kanálech (1 = beze změny) – teplota obrazu. */
  readonly gain: readonly [number, number, number];
  /** Exponent středních tónů: > 1 ztmaví vybledlé, < 1 rozjasní tmavé. */
  readonly gamma: number;
  readonly saturation: number;
  readonly contrast: number;
  /** Ztmavení rohů (0 = bez viněty). */
  readonly vignette: number;
}

/** Druh obrysu: hrdina, nepřítel, překážka (`InkOutline.tsx`). */
export type InkKind = 'hero' | 'foe' | 'obstacle';

export interface LookStyle {
  /** Slunce zlaté hodiny (směr, barva, síla), výplň polokoule, stín a protisvětlo (`fog-light.ts`). */
  readonly light: {
    /** Nejvyšší výška slunce (sinus elevace). */
    readonly goldenUp: number;
    /** Barva, ke které se slunce rodiny ohřeje, a jak moc (0 = slunce sady beze změny). */
    readonly goldenSun: string;
    readonly goldenWarmth: Readonly<Record<GradeFamily, number>>;
    /** Nejvyšší zesílení slunce, které vrací zemi šikmý dopad. */
    readonly goldenGainMost: number;
    /** Násobek síly polokoule (výplň stínů) a slunce (klíčové světlo). */
    readonly hemiLift: number;
    readonly sunLift: number;
    /** Poloměr PCF a síla stínu slunce. */
    readonly shadowRadius: number;
    readonly shadowIntensity: number;
    /** Protisvětlo (obrys hrdiny): síla k slunci a podíl barvy oblohy u obzoru. */
    readonly backLight: number;
    readonly backSky: number;
  };
  /** Obloha (`StyleRig`): malovaný obraz z konceptu a kolik barvy oblohy se do něj u obzoru přimíchá. */
  readonly sky: { readonly painted: boolean; readonly paintHaze: number };
  /** Mlha: začíná v tomto podílu dohledu; barva = obzor sytější o `saturation` (HSL). */
  readonly fog: { readonly start: number; readonly saturation: number };
  /** Podlaha arény a dráhy: drsnost země, ledu a stěn, násobek kontrastu spár a čára jízdního pruhu. */
  readonly floor: { readonly roughness: number; readonly ice: number; readonly wall: number; readonly seam: number; readonly laneLine: string };
  /** Obrysy: tloušťka v CSS px a podíl tmavého odstínu povrchu místo inkoustu podle druhu. */
  readonly ink: { readonly px: number; readonly surface: Readonly<Record<InkKind, number>> };
  /** Ladění: násobek expozice, kontrast navíc na telefonní úrovni a ladění rodin. */
  readonly grade: { readonly exposure: number; readonly lowContrast: number; readonly families: Readonly<Record<GradeFamily, Grade>> };
  /** Následné zpracování: síla bloomu a násobek rozostření tilt-shiftu. */
  readonly post: { readonly bloom: number; readonly tilt: number };
}

/** Vzhled před P81 (P77 v `main`, 9. 11.). */
export const TODAY_STYLE: LookStyle = {
  light: {
    goldenUp: 0.62,
    goldenSun: '#ffc68c',
    // P75 T5: teplejší než P73D (0,3 / 0,25 / 0,12) – koncept A svítí zlatou hodinou i nad loukou a sněhem.
    goldenWarmth: { green: 0.42, warm: 0.35, cold: 0.2, water: 0, indoor: 0, dark: 0 },
    goldenGainMost: 1.2,
    hemiLift: 1.2,
    sunLift: 1.1,
    // P76 1,5, P77 T3 4: při 4 soudce proti produkci dvakrát „stronger contact shadows“ u produkce (P77 T6).
    shadowRadius: 2,
    shadowIntensity: 0.95,
    backLight: 0.45,
    backSky: 0.5,
  },
  sky: { painted: true, paintHaze: 0.3 },
  fog: { start: 0.6, saturation: 0.18 },
  floor: { roughness: 0.9, ice: 0.45, wall: 0.85, seam: 1, laneLine: '#e2e8f0' },
  // Kit kreslí 2,5 px; modelína konceptu (P75 T2) má hranu jen naznačenou.
  ink: { px: 1.5, surface: { hero: 0.7, foe: 0, obstacle: 0.7 } },
  grade: {
    exposure: 1,
    lowContrast: 0.08,
    families: {
      // Zlatá hodina diorama (P73D T4): denní rodiny teplejší zisk a měkčí sytost – hračka, ne neon.
      green: { lift: [0.01, 0.01, 0.015], gain: [1.05, 1.01, 0.94], gamma: 1.04, saturation: 1.06, contrast: 1.06, vignette: 0.22 },
      warm: { lift: [0.02, 0.01, 0], gain: [1.05, 1, 0.92], gamma: 1.04, saturation: 1.04, contrast: 1.08, vignette: 0.22 },
      // Mlha arény sníh vybělí: gama vrátí střední tóny, bílá zůstane bílou.
      cold: { lift: [0, 0.01, 0.03], gain: [0.99, 1, 1.01], gamma: 1.22, saturation: 1.2, contrast: 1.1, vignette: 0.2 },
      water: { lift: [0, 0.02, 0.03], gain: [0.98, 1.02, 1.03], gamma: 1.04, saturation: 1.12, contrast: 1.06, vignette: 0.26 },
      indoor: { lift: [0.01, 0.01, 0], gain: [1.04, 1, 0.95], gamma: 1.03, saturation: 1.04, contrast: 1.06, vignette: 0.2 },
      // Noc: černá se zvedne do modré, střední tóny se rozjasní – hrdina nezapadne.
      dark: { lift: [0.03, 0.045, 0.07], gain: [1, 1.02, 1.04], gamma: 0.8, saturation: 1.1, contrast: 1, vignette: 0.3 },
    },
  },
  post: { bloom: 0.8, tilt: 1 },
};

/** Profil, který hra kreslí. */
export const LOOK_STYLE: LookStyle = TODAY_STYLE;
