/**
 * Brána autorovaného vzhledu — jediné místo, kde se rozhoduje, jestli je popis
 * vzhledu od někoho zvenčí přijatelný.
 *
 * Do téhle úlohy byl vzhled výhradně **odvozený** (`deriveLook`, T2): svět si
 * ho spočítal sám ze své palety a terénu, takže nemohl být špatně. P13 vlna 2
 * ale pustí ke stejným polím model — a model napíše expozici 40, mlhu −3, pole
 * `mood` navíc, číslo jako řetězec a dřív nebo později fialovou oblohu. Tenhle
 * soubor stojí mezi ním a scénou.
 *
 * ## Dvě různé odpovědi na dva různé druhy nesmyslu
 *
 * 1. **Číslo mimo rozpočet se oseká, neodmítne.** Design book §7.5 to
 *    deterministickému systému výslovně dovoluje („normalizovat čísla do
 *    rozpočtů"), a je to i jediná rozumná volba pro demo: odmítnout celý vzhled
 *    kvůli jedné expozici znamená ukázat porotci prázdno místo světa. Oseknutí
 *    se ale **přizná** — vrací se v `adjustments` s cestou a důvodem, aby šlo
 *    v Inspect ukázat, co se změnilo a proč.
 * 2. **Tvar a fialová se odmítají.** Chybějící pole, pole navíc, řetězec místo
 *    čísla, `NaN`, nekonečno, nulový vektor směru a jakýkoli odstín v pásmu
 *    250–320° projdou branou jen přes mrtvolu. Fialová je globální zákaz
 *    designu, ne rozsah, takže se nedá „osekat do rozpočtu" — buď tam je, nebo
 *    není.
 *
 * **Při odmítnutí se vrací odvozený vzhled, nikdy prázdno.** Podlaha z T2
 * existuje právě proto, aby bylo co ukázat, když se autorovaná cesta nepovede.
 *
 * ## Proč `zod` a ne `ajv`
 *
 * `ajv` kompiluje validátory přes `new Function`, což pod striktním CSP
 * v prohlížeči padá (`CLAUDE.md`, Pasti). Zbytek repa (`src/ir`, `src/shape`,
 * `src/geom`) mluví `zod`em taky.
 *
 * **Tahle úloha model nezapojuje.** Otevírá kontrakt a nic víc; naplní ho
 * P13 vlna 2, vynutí ho opravná vrstva v T11.
 */

import { z } from 'zod';

import { PALETTES, type PaletteName } from '@/kit';

import {
  LOOK_BUDGETS,
  budgeted,
  deriveLook,
  type LookBudget,
  type LookDescriptor,
  type LookInput,
} from './look';

/* ------------------------------------------------------------------ *
 * Odstín a fialové pásmo.
 * ------------------------------------------------------------------ */

/**
 * Odstín 0–360 ze sRGB hexu. Šedé barvy vrací `null` — u barvy bez sytosti
 * odstín nic neznamená a soudit ho by znamenalo zakázat tmavě šedou jen proto,
 * že jí zaokrouhlení kanálů vyšlo o dva stupně jinam.
 */
export function hueOf(hex: string): number | null {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = ((n >> 16) & 0xff) / 255;
  const g = ((n >> 8) & 0xff) / 255;
  const b = (n & 0xff) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const span = max - min;
  if (span < 0.04) return null;

  let hue: number;
  if (max === r) hue = ((g - b) / span) % 6;
  else if (max === g) hue = (b - r) / span + 2;
  else hue = (r - g) / span + 4;

  return (((hue * 60) % 360) + 360) % 360;
}

/** Zakázané pásmo odstínu. Fialová, indigo, magenta — globální pravidlo designu. */
export const PURPLE_BAND = { min: 250, max: 320 } as const;

export function isPurple(hex: string): boolean {
  const hue = hueOf(hex);
  return hue !== null && hue >= PURPLE_BAND.min && hue <= PURPLE_BAND.max;
}

/* ------------------------------------------------------------------ *
 * Schéma jednoho popisu vzhledu.
 * ------------------------------------------------------------------ */

const PALETTE_NAMES = Object.keys(PALETTES) as [PaletteName, ...PaletteName[]];

/**
 * Barva. Dvě kontroly, dva různé druhy chyby: tvar `#rrggbb` a zákaz fialové.
 *
 * `z.number()` v `zod` v4 nepustí `NaN` ani `Infinity` sám od sebe, takže
 * u čísel níž žádná zvláštní ochrana proti nekonečnu není potřeba; u barvy
 * naopak nese celou tíhu regulární výraz, protože `#zzz` i `rebeccapurple`
 * jsou platné řetězce.
 */
const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'color must be a #rrggbb hex')
  .refine((value) => !isPurple(value), {
    message: `hue ${PURPLE_BAND.min}-${PURPLE_BAND.max} is banned: no purple anywhere`,
  });

/**
 * Směr ke klíčovému světlu. Nemusí být jednotkový — to se dopočítá — ale nesmí
 * být nulový: nulový vektor není „slabé světlo", je to světlo bez směru
 * a normalizace by z něj udělala `NaN` ve třech kanálech naráz.
 */
const direction = z
  .tuple([z.number(), z.number(), z.number()])
  .refine((v) => Math.hypot(v[0], v[1], v[2]) > 1e-6, {
    message: 'direction must not be the zero vector',
  });

export const authoredLookSchema = z
  .object({
    palette: z.enum(PALETTE_NAMES),
    sky: z.object({ color: hexColor, height: z.number() }).strict(),
    water: z.object({ present: z.boolean(), color: hexColor }).strict(),
    ground: z.object({ present: z.boolean(), color: hexColor }).strict(),
    fog: z.object({ density: z.number(), color: hexColor }).strict(),
    key: z.object({ direction, temperature: z.number() }).strict(),
    rim: z.number(),
    exposure: z.number(),
    dust: z.number(),
  })
  .strict();

/* ------------------------------------------------------------------ *
 * Přijetí, oseknutí, odmítnutí.
 * ------------------------------------------------------------------ */

/**
 * Jedno oseknutí do rozpočtu. Nese cestu, obě čísla i důvod, protože Inspect
 * má porotci ukázat **co** se změnilo, ne jen že se něco stalo.
 */
export interface LookAdjustment {
  /** Cesta k poli, `/`-oddělená — stejný tvar jako cesty v `issues`. */
  readonly path: string;
  readonly from: number;
  readonly to: number;
  readonly reason: string;
}

export interface LookAcceptance {
  readonly ok: boolean;
  /** Přijatý a osekaný vzhled, nebo — při odmítnutí — odvozený z T2. Nikdy prázdno. */
  readonly look: LookDescriptor;
  /** Co se osekalo. Prázdné u odmítnutí i u vzhledu, který se vešel beze změny. */
  readonly adjustments: readonly LookAdjustment[];
  /** Proč se odmítlo. Prázdné u přijetí. */
  readonly issues: readonly string[];
}

function clampInto(
  field: LookBudget,
  path: string,
  value: number,
  adjustments: LookAdjustment[],
): number {
  const to = budgeted(field, value);
  if (to !== value) {
    const budget = LOOK_BUDGETS[field];
    adjustments.push({
      path,
      from: value,
      to,
      reason: `clamped into budget ${field} ${budget.min}-${budget.max}`,
    });
  }
  return to;
}

function unit(
  vector: readonly [number, number, number],
  adjustments: LookAdjustment[],
): readonly [number, number, number] {
  const length = Math.hypot(vector[0], vector[1], vector[2]);
  if (Math.abs(length - 1) < 1e-9) return vector;

  adjustments.push({
    path: 'key/direction',
    from: length,
    to: 1,
    reason: 'normalised to unit length',
  });
  return [vector[0] / length, vector[1] / length, vector[2] / length];
}

/**
 * Přijmi autorovaný vzhled, nebo se pojmenovaně vrať k odvozenému.
 *
 * `world` není jen zdroj náhradního vzhledu — je to důvod, proč tahle funkce
 * nemůže selhat: podlaha z něj jde spočítat vždycky, takže scéna dostane popis
 * i tehdy, když model napíše nesmysl.
 */
export function acceptLook(authored: unknown, world: LookInput): LookAcceptance {
  const derived = deriveLook(world);
  const parsed = authoredLookSchema.safeParse(authored);

  if (!parsed.success) {
    return {
      ok: false,
      look: derived,
      adjustments: [],
      issues: parsed.error.issues.map((issue) => `look:/${issue.path.join('/')}: ${issue.message}`),
    };
  }

  const authoredLook = parsed.data;
  const adjustments: LookAdjustment[] = [];

  const look: LookDescriptor = {
    palette: authoredLook.palette,
    sky: {
      color: authoredLook.sky.color,
      height: clampInto('skyHeight', 'sky/height', authoredLook.sky.height, adjustments),
    },
    water: { present: authoredLook.water.present, color: authoredLook.water.color },
    ground: { present: authoredLook.ground.present, color: authoredLook.ground.color },
    fog: {
      density: clampInto('fogDensity', 'fog/density', authoredLook.fog.density, adjustments),
      color: authoredLook.fog.color,
    },
    key: {
      direction: unit(authoredLook.key.direction, adjustments),
      temperature: clampInto(
        'temperature',
        'key/temperature',
        authoredLook.key.temperature,
        adjustments,
      ),
    },
    rim: clampInto('rim', 'rim', authoredLook.rim, adjustments),
    exposure: clampInto('exposure', 'exposure', authoredLook.exposure, adjustments),
    dust: clampInto('dust', 'dust', authoredLook.dust, adjustments),
  };

  return { ok: true, look, adjustments, issues: [] };
}
