/**
 * Profil vzhledu celého obrazu (P81 T2): světlo, obloha, mlha, podlaha, obrysy, ladění a následné
 * zpracování na jednom místě. Dřív to byly konstanty rozeseté po rigu (`fog-light.ts`, `grade.ts`,
 * `Post.tsx`, `InkOutline.tsx`, podlaha arény a dráhy) – P77 přebarvila jen kulisy a změnilo se 2–5 %
 * obrazu. Vzhled celé hry teď mění jeden profil; rig, podlaha i obrysy čtou `LOOK_STYLE`.
 *
 * `TODAY_STYLE` drží hodnoty před P81 (pin `p81-style.test.ts`) – základ, proti kterému se nový vzhled měří.
 * `MIX_STYLE` je směr, který majitel vybral z ukázky 9. 11. (prototyp `exp/p81-look`, varianta `mix`
 * s méně oranžovou): nízké teplé slunce z boku, lehký opar, sytější povrchy a ladění teplé jen ve světlech.
 * Mimo hash: jádro profil nečte, jen kreslení.
 */
import { Color, SRGBColorSpace } from 'three';

import type { Look, LookId } from './index';

/** Rodiny prostředí pro ladění a zlatou hodinu (P37B T3). */
export const GRADE_FAMILIES = ['green', 'warm', 'cold', 'water', 'indoor', 'dark'] as const;
export type GradeFamily = (typeof GRADE_FAMILIES)[number];

/** Místo → rodina ladění. */
export const LOOK_FAMILY: Readonly<Record<LookId, GradeFamily>> = {
  meadow: 'green',
  forest: 'green',
  jungle: 'green',
  castle: 'green',
  desert: 'warm',
  beach: 'warm',
  volcano: 'warm',
  snow: 'cold',
  ocean: 'water',
  underwater: 'water',
  city: 'indoor',
  mall: 'indoor',
  supermarket: 'indoor',
  living_room: 'indoor',
  factory: 'indoor',
  cave: 'dark',
  graveyard: 'dark',
  space: 'dark',
};

/** Barevné ladění za ACES (`GradeEffect`): zisk·(c + zdvih·(1 − c)), gama, sytost, kontrast, viněta. */
export interface Grade {
  /** Zdvih stínů po kanálech (0 = černá zůstane černou). */
  readonly lift: readonly [number, number, number];
  /** Zisk světel po kanálech (1 = beze změny) – teplota obrazu. */
  readonly gain: readonly [number, number, number];
  /**
   * Split-tone (P81): 0 = zisk platí na všechny tóny, 1 = jen na světla (tmavé a střední tóny bez zisku).
   * Teplo ve světlech bez oranžové podlahy a hnědého tučňáka.
   */
  readonly split: number;
  /** Exponent středních tónů: > 1 ztmaví vybledlé, < 1 rozjasní tmavé. */
  readonly gamma: number;
  readonly saturation: number;
  readonly contrast: number;
  /** Ztmavení rohů (0 = bez viněty). */
  readonly vignette: number;
}

/** Druh obrysu: hrdina, nepřítel, překážka, kulisa a rekvizita (`InkOutline.tsx`). */
export type InkKind = 'hero' | 'foe' | 'obstacle' | 'scenery';

/** Přebarvení palety místa (`restyleLook`); `null` = paleta místa beze změny. */
export interface PaletteStyle {
  /** Kolik sytosti a světlosti (HSL v sRGB) přibude povrchům sady. Odstín se nemění. */
  readonly saturation: number;
  readonly lightness: number;
  /** Síla zlatého oparu a teplého nízkého slunce (0–1). */
  readonly heat: number;
  /** Výška nízkého slunce (sinus elevace) a násobky síly slunce a záře oblohy. */
  readonly sunUp: number;
  readonly sunGain: number;
  readonly glowGain: number;
  /**
   * Kolik teplého nádechu slunce podlaha a dráha vyruší (0–1): barva země se předem ochladí v poměru barvy
   * slunce, takže osvětlená zůstane ve svém odstínu (majitel: hradní dlažba nesmí zhnědnout do oranžova).
   */
  readonly floorNeutral: number;
}

export interface LookStyle {
  /** Slunce zlaté hodiny rodiny (směr, barva, síla), výplň polokoule, stín a protisvětlo (`fog-light.ts`). */
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
  /** Paleta místa: sytost a zlatá hodina (`restyleLook` v `sceneLook`). */
  readonly palette: PaletteStyle | null;
  /**
   * Obloha (`StyleRig`): malovaný obraz z konceptu; kolik barvy oblohy se do něj přimíchá u obzoru (`paintHaze`)
   * a jak vysoko ten pás oparu sahá (`hazeBand`, sinus výšky); `gradient` = kolik přechodu obzor → zenit
   * přes obraz nahoru (0 = obraz, jak je).
   */
  readonly sky: { readonly painted: boolean; readonly paintHaze: number; readonly hazeBand: number; readonly gradient: number };
  /**
   * Mlha: začíná v tomto podílu dohledu (`storm` za bouřky – déšť má vlastní hustší mlhu nálady, P76);
   * barva = obzor sytější o `saturation` (HSL).
   */
  readonly fog: { readonly start: number; readonly storm: number; readonly saturation: number };
  /** Podlaha arény a dráhy: drsnost země, ledu a stěn, násobek kontrastu spár a čára jízdního pruhu. */
  readonly floor: { readonly roughness: number; readonly ice: number; readonly wall: number; readonly seam: number; readonly laneLine: string };
  /**
   * Obrysy: tloušťka v CSS px a podíl tmavého odstínu povrchu místo inkoustu podle druhu; `scenery` = obrys
   * i kulis a rekvizit (ne zem a terén, na úrovni `low` vůbec).
   */
  readonly ink: { readonly px: number; readonly scenery: boolean; readonly surface: Readonly<Record<InkKind, number>> };
  /** Ladění: násobek expozice, kontrast navíc na telefonní úrovni a ladění rodin. */
  readonly grade: { readonly exposure: number; readonly lowContrast: number; readonly families: Readonly<Record<GradeFamily, Grade>> };
  /** Následné zpracování: síla bloomu a násobek rozostření tilt-shiftu v úvodním a závěrečném záběru. */
  readonly post: { readonly bloom: number; readonly tilt: number };
}

/** Ladění nočních, vodních a sněhových rodin – P81 je nemění (noc, voda a sníh si tón nechají). */
const COLD: Grade = { lift: [0, 0.01, 0.03], gain: [0.99, 1, 1.01], split: 0, gamma: 1.22, saturation: 1.2, contrast: 1.1, vignette: 0.2 };
const WATER: Grade = { lift: [0, 0.02, 0.03], gain: [0.98, 1.02, 1.03], split: 0, gamma: 1.04, saturation: 1.12, contrast: 1.06, vignette: 0.26 };
const DARK: Grade = { lift: [0.03, 0.045, 0.07], gain: [1, 1.02, 1.04], split: 0, gamma: 0.8, saturation: 1.1, contrast: 1, vignette: 0.3 };

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
  palette: null,
  sky: { painted: true, paintHaze: 0.3, hazeBand: 0.18, gradient: 0 },
  fog: { start: 0.6, storm: 0.6, saturation: 0.18 },
  floor: { roughness: 0.9, ice: 0.45, wall: 0.85, seam: 1, laneLine: '#e2e8f0' },
  // Kit kreslí 2,5 px; modelína konceptu (P75 T2) má hranu jen naznačenou.
  ink: { px: 1.5, scenery: false, surface: { hero: 0.7, foe: 0, obstacle: 0.7, scenery: 0.7 } },
  grade: {
    exposure: 1,
    lowContrast: 0.08,
    families: {
      // Zlatá hodina diorama (P73D T4): denní rodiny teplejší zisk a měkčí sytost – hračka, ne neon.
      green: { lift: [0.01, 0.01, 0.015], gain: [1.05, 1.01, 0.94], split: 0, gamma: 1.04, saturation: 1.06, contrast: 1.06, vignette: 0.22 },
      warm: { lift: [0.02, 0.01, 0], gain: [1.05, 1, 0.92], split: 0, gamma: 1.04, saturation: 1.04, contrast: 1.08, vignette: 0.22 },
      // Mlha arény sníh vybělí: gama vrátí střední tóny, bílá zůstane bílou.
      cold: COLD,
      water: WATER,
      indoor: { lift: [0.01, 0.01, 0], gain: [1.04, 1, 0.95], split: 0, gamma: 1.03, saturation: 1.04, contrast: 1.06, vignette: 0.2 },
      // Noc: černá se zvedne do modré, střední tóny se rozjasní – hrdina nezapadne.
      dark: DARK,
    },
  },
  post: { bloom: 0.8, tilt: 1 },
};

/**
 * Denní ladění směru mix (prototyp `7907206c`: zisk [1,03, 1, 0,96], sytost 1,18, kontrast 1,08, viněta 0,2)
 * jako split-tone: chladný zdvih ve stínech, teplý zisk jen ve světlech.
 */
const MIX_DAY: Grade = { lift: [0, 0.006, 0.02], gain: [1.04, 1, 0.95], split: 1, gamma: 1, saturation: 1.18, contrast: 1.08, vignette: 0.2 };

/** Směr mix s méně oranžovou (majitel 9. 11.). */
export const MIX_STYLE: LookStyle = {
  ...TODAY_STYLE,
  // Slunce nese už paleta (`restyleLook`): zlatá hodina rodiny by ho ohřála podruhé.
  light: { ...TODAY_STYLE.light, goldenWarmth: { green: 0, warm: 0, cold: 0, water: 0, indoor: 0, dark: 0 } },
  palette: { saturation: 0.14, lightness: 0.03, heat: 0.5, sunUp: 0.33, sunGain: 1.45, glowGain: 1.6, floorNeutral: 0.75 },
  sky: { painted: true, paintHaze: 0.45, hazeBand: 0.3, gradient: 0.3 },
  // Lehký opar od čtvrtiny dohledu, z méně syté barvy obzoru. Bouřka si nechá mlhu P76: od čtvrtiny by déšť
  // ve městě (s9) zmodral a zesvětlil zem pod hrdinou o 46° a skryl panoráma.
  fog: { start: 0.25, storm: 0.6, saturation: 0.06 },
  // Hala a město (rodina `indoor`) si ladění nechají – chladný zdvih zmodral tmavou mokrou zem s9.
  // Obrys všech modelů 2 px s čtvrtinou tónu povrchu (prototyp `02ef2983`); překážka a nepřítel si barvu nechají
  // (rajčatový obrys nepřítele = signál hrozby).
  ink: { px: 2, scenery: true, surface: { hero: 0.25, foe: 0, obstacle: 0.7, scenery: 0.25 } },
  grade: { ...TODAY_STYLE.grade, families: { green: MIX_DAY, warm: MIX_DAY, cold: COLD, water: WATER, indoor: TODAY_STYLE.grade.families.indoor, dark: DARK } },
  // Silnější rozostření jen v úvodním a závěrečném záběru; za hry beze změny (P76 silnější rozmazání při hře vrátila).
  post: { bloom: 1, tilt: 1.6 },
};

/** Profil, který hra kreslí. */
export const LOOK_STYLE: LookStyle = MIX_STYLE;

const hsl = { h: 0, s: 0, l: 0 };
const hex = (color: Color): string => `#${color.getHexString(SRGBColorSpace)}`;
const mixHex = (from: string, to: string, t: number): string => hex(new Color(from).lerp(new Color(to), t));
/** Sytost a světlost v HSL (sRGB, jak barvu vidí oko). Odstín se nemění – nic nesklouzne do fialové. */
const tone = (value: string, saturation: number, lightness: number): string => {
  const { h, s, l } = new Color(value).getHSL(hsl, SRGBColorSpace);
  // Skoro bílá (sníh #f8fafc) by z plné sytosti zmodrala do azurové: u světlosti nad 0,8 sytost ubývá k nule.
  const room = Math.min(1, (1 - l) / 0.2);
  return hex(new Color().setHSL(h, Math.min(1, s + saturation * room), Math.min(0.97, Math.max(0, l + lightness)), SRGBColorSpace));
};

/** Barvy povrchů sady (zem, dráha, bloky, rekvizity, paleta kulis) sytější (prototyp `saturated`). */
function saturated(look: Look, amount: number, lightness: number): Look {
  const t = (value: string) => tone(value, amount, lightness);
  return {
    ...look,
    ground: t(look.ground),
    track: t(look.track),
    water: t(look.water),
    ...(look.land === undefined ? {} : { land: t(look.land) }),
    tint: [t(look.tint[0]), t(look.tint[1])],
    ...(look.block === undefined ? {} : { block: [t(look.block[0]), t(look.block[1])] }),
    ...(look.terrain === undefined ? {} : { terrain: { ...look.terrain, lane: t(look.terrain.lane), shade: t(look.terrain.shade), rock: t(look.terrain.rock) } }),
    palette: look.palette.map(t),
  };
}

/**
 * Barva země předem ochlazená v poměru barvy slunce (lineárně, kanál / průměr), takže pod teplým sluncem
 * zůstane ve svém odstínu; `amount` 0 = beze změny, 1 = slunce ji vůbec nezteplí.
 */
function neutralUnder(value: string, sun: Color, amount: number): string {
  const mean = (sun.r + sun.g + sun.b) / 3;
  const color = new Color(value);
  color.setRGB(color.r * (mean / sun.r) ** amount, color.g * (mean / sun.g) ** amount, color.b * (mean / sun.b) ** amount);
  return hex(new Color(Math.min(1, color.r), Math.min(1, color.g), Math.min(1, color.b)));
}

/**
 * Teplé nízké slunce a opar (prototyp `golden`, varianta mix s `heat` 0,5): obloha, světlo, slunce. Polokoule
 * odspodu bere barvu země místa (ne hnědou), podlaha a dráha jsou vyjmuté z teplého nádechu (`floorNeutral`).
 */
function golden(look: Look, style: PaletteStyle): Look {
  const { heat } = style;
  const [left, , forward] = look.sunDir;
  const flat = Math.hypot(left, forward) || 1;
  // Nízko nad obzorem, z boku za kamerou: dlouhé stíny přes celou plochu.
  const side = Math.sqrt(1 - style.sunUp ** 2);
  // Sníh zůstane sněhem: slabší zlatý opar a světlejší slunce, jinak z něj je písek.
  const snow = look.cover === 'snow';
  const warm = (snow ? 0.3 : 0.5) * heat;
  const sunColor = mixHex('#fff4e6', snow ? '#ffd0a0' : '#ffad5c', heat);
  const sun = new Color(sunColor);
  const floor = (value: string) => neutralUnder(value, sun, style.floorNeutral);
  return {
    ...look,
    skyTop: mixHex(look.skyTop, '#86b7d6', 0.35),
    horizon: mixHex(look.horizon, '#ffbf7a', warm),
    sky: mixHex(look.sky, '#ffbf7a', warm),
    sunColor,
    sunDir: [(left / flat) * side, style.sunUp, (forward / flat) * side],
    sun: look.sun * style.sunGain,
    glow: Math.max(look.glow, 0.5) * style.glowGain,
    light: [mixHex(look.light[0], '#ffd2a0', 0.45 * heat), mixHex(look.light[1], look.land ?? look.ground, 0.35 * heat), look.light[2] * 0.8],
    ground: floor(look.ground),
    track: floor(look.track),
    ...(look.land === undefined ? {} : { land: floor(look.land) }),
    ...(look.block === undefined ? {} : { block: [look.block[0], floor(look.block[1])] }),
    ...(look.terrain === undefined ? {} : { terrain: { ...look.terrain, lane: floor(look.terrain.lane), shade: floor(look.terrain.shade) } }),
  };
}

/** Jaké světlo nad místem je: noc a zatažená obloha (bouřka, šero, mlha, strašidelno, soumrak) zlatou hodinu nedostanou. */
export interface SkyKind {
  readonly night: boolean;
  readonly overcast: boolean;
}

/**
 * Paleta místa podle profilu (prototyp `variantLook`, směr mix: `golden(saturated(look, 0,14, 0,03), 0,5)`).
 * Noc, hala, místa bez slunce (pod vodou, jeskyně), noční rodina a bouřka (studená mokrá zem P76 – sytost
 * a světlost navíc by ji zesvětlily nad suchou zem za slunce) si tón nechají; pod jinou zataženou oblohou
 * jen sytost, bez teplého slunce.
 */
export function restyleLook(look: Look, id: LookId, sky: SkyKind, style: LookStyle = LOOK_STYLE): Look {
  const palette = style.palette;
  if (palette === null || sky.night || look.storm === true || look.ceiling !== undefined || look.glow === 0 || LOOK_FAMILY[id] === 'dark') return look;
  const rich = saturated(look, palette.saturation, palette.lightness);
  if (sky.overcast) return rich;
  const lit = golden(rich, palette);
  // Poletující listí v zelených místech za slunce (předloha s4); `leaves` v `AMBIENT_KINDS`, jedno kreslení.
  return LOOK_FAMILY[id] === 'green' && !look.ambient.includes('leaves') ? { ...lit, ambient: [...look.ambient, 'leaves'] } : lit;
}
