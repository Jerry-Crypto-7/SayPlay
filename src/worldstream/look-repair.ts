/**
 * Podlaha vzhledu — vrstva, po které nesmí ven plochý ani mrtvý obraz.
 *
 * `deriveLook` (T2) dá každému světu vzhled odvozený z něj samého a
 * `acceptLook` (T9) ubrání ten, který napíše model. Ani jedno negarantuje, že
 * z toho vyjde **obraz, který obstojí**, a naměřeno je, že nevyjde: na
 * kontaktním listu z 28. 8. 2026 propadly dva světy z dvanácti a oba na téže
 * vlastnosti, `hues`. `dunes-terrace` měl v obraze **jediný** odstín, protože
 * obloha, mlha i zem vyšly z téže pískové palety (37°, 37°, 38°);
 * `frost-plateau` dva, protože je celý modrý (200°, 201°, 203°). Po zapojení
 * téhle vrstvy prošlo prahy **12 z 12**.
 *
 * ## Co oprava dělá a čeho se nedotkne
 *
 * Sahá **jen do vzhledu**: protisvětlo, mlha, expozice, barvy pozadí. Nikdy do
 * geometrie — tu napsal model a přepsat mu ji potichu je vada, ne oprava.
 * Nikdy do palety kusů: barvu hmoty světa určuje kit a `repaint()`, a oprava,
 * která by ji přemalovala, by lhala o tom, z čeho je svět postavený.
 *
 * ## Pět prahů soudce, pět pák vzhledu
 *
 * Každá páka má jméno té vlastnosti z `image-judge.ts`, kterou drží. Není to
 * ozdoba: `LookRepair.property` se dá v Inspect ukázat vedle propadlého prahu,
 * takže je vidět **proč** se co změnilo.
 *
 * - `hues` → viditelné plochy pozadí se rozestoupí do tří odstínových košů.
 * - `silhouette` a `focusClarity` → protisvětlo má spodní mez; bez něj splyne
 *   silueta s pozadím a ohnisko není z čeho poznat.
 * - `dead` → mlha má **obě** meze. Hustá zavře pozadí do jedné hodnoty, řídká
 *   nemá co malovat a hloubka zmizí.
 * - `luminanceSpread` → obloha a zem musí stát v odlišných hodnotách,
 *   a expozice v pásmu, kde se z obrazu nestane bílá ani černá plocha.
 *
 * ## Tři viditelné plochy, prstenec kotvený na oblohu toho světa
 *
 * Barvy se **otáčejí v odstínu, jas si nesou svůj**. Právě proto dva opravené
 * světy nevypadají stejně: každý si nese vlastní jas a vlastní sytost, mění se
 * jen rodina odstínu. Kdyby se přepisovalo víc, vyrobila by oprava dvanáct
 * stejných snímků a rozbila by přesně to, co kontaktní list měří.
 *
 * Plochy jsou tři, ne čtyři, a která je třetí rozhoduje voda: **deska země leží
 * pod hladinou**, takže ve světě s vodou nemaluje ani pixel.
 *
 * **Obloha si nechá koš, ve kterém stojí; zbylé dvě plochy jdou o dva koše dál
 * po prstenci povolených.** Trojice se tím svět od světa liší, a přitom si mezi
 * sebou drží rozestup 60°, tedy celý prázdný koš.
 *
 * Naměřeno 29. 8. 2026, proč to nesmí být tři pevné odstíny: kotvy 195 / 45 /
 * 165 se rozdávaly podle role, takže přístav (obloha 196°, s vodou) dostal
 * 195 / 166 / 44 a poušť (obloha 37°, bez vody) 37 / 195 / 165 — **tytéž tři
 * koše, jen jinak rozdané**. Průměrná barva obou snímků pak stála **2,7** od
 * sebe proti prahu 8 v `e2e/worldstream-atmosphere.spec.ts`; po zavedení
 * prstence **14**. Pět ze šesti palet repozitáře přitom končilo v koši 5 i 6:
 * čím víc světů oprava potkala, tím víc se sbíhaly.
 *
 * Otáčí se **nejmenší počet ploch, který stačí**, a jakmile jsou tři koše
 * obsazené, oprava přestane. Svět, který tři koše má, se nedotkne vůbec.
 *
 * ## Rotace odstínu nesmí hnout jasem
 *
 * `dead` — nejtěsnější z pěti prahů — se počítá **výhradně z jasu**: buňka je
 * mrtvá, když má rozpětí jasu pod `deadRange`. Rotace odstínu s ním proto nemá
 * co dělat, a do 29. 8. 2026 přesto měla. `withHue` držel HSV *value*, tedy
 * nejvyšší kanál, zatímco jas podle Rec. 709 váží zelenou 0,715 a červenou
 * 0,213; otočení tyrkysu do červené tak jas srazilo o 27 %. Naměřený následek:
 * `foundry-hall` propadl na kontaktním listu mrtvou plochou **0,528 → 0,597**,
 * přestože se mu měnil jen odstín oparu.
 *
 * `withHue` proto dopočítá měřítko tak, aby jas zůstal. Když je cílový jas
 * v tom odstínu nedosažitelný (sytou zeleň na stejně jasnou červeň přebarvit
 * nelze), **ořízne se dolů** — nikdy se nedorovnává rozsvícením barvy, kterou
 * svět nikdy neměl.
 *
 * ## Pořadí je od nejlevnější plochy k nejdražší
 *
 * Opar, pak plocha pod obzorem, a **obloha až jako poslední**. Naměřeno
 * 29. 8. 2026, proč: dokud se obloha otáčela první, dostal svět `kiln-court`
 * místo teplé pece studenou modř a jeho mrtvá plocha vyskočila z 0,493 na
 * 0,597, tedy nad práh — a přitom mu nic nechybělo. Soudce v jeho obraze tři
 * odstíny viděl, jen popis vzhledu o nich nevěděl, protože barvu hmoty maluje
 * kit, ne vzhled. Popis vzhledu je odhad zdola; oprava se podle něj smí
 * rozhodovat, ale nesmí kvůli němu obětovat největší plochu snímku.
 *
 * ## Šedá, černá a fialová
 *
 * Plocha, které soudce odstín nevidí, nemaluje žádný koš, a otočením odstínu
 * se to nespraví — rotace nese sytost s sebou. Šedá obloha je přitom právě ten
 * bezbarvý prostor, kvůli kterému podlaha existuje, takže dostane **nejmenší
 * nádech, který soudce rozezná**, ne barvu vymyšlenou od stolu.
 *
 * Černá zůstane černá: sytost i odstup jasu se počítají z jasu a z nuly se
 * vytáhnout nedají. Přesně tenhle případ končí `ok: false` a pojmenovanou
 * vlastností v `failed`, ne tichým průchodem — vzhled se přesto vrací
 * opravený, jak to šlo, protože scéna musí něco dostat.
 *
 * Cílové odstíny jsou středy košů **mimo pásmo 250–320°**, takže oprava
 * fialovou vyrobit nemůže. Uklidit ji po někom jiném její věc není: fialový
 * vzhled `deriveLook` nevyrobí a brána z T9 ho nepustí.
 *
 * ## Idempotence
 *
 * Vzhled se přepočítává při každé změně světa, takže oprava, která platí až po
 * pátém průchodu, by barvu posouvala pořád dál a po deseti snímcích by ze světa
 * byla duha. Každý krok se proto ptá, jestli práh **už** platí, a mířit se musí
 * kus za něj — osm bitů na kanál jinak výsledek posadí zpátky pod něj.
 */
import {
  HUE_BUCKETS,
  IMAGE_THRESHOLDS,
  type ImageProperty,
  judgedHueBucket,
} from './image-judge';
import { type LookDescriptor } from './look';
import { PURPLE_BAND } from './look-schema';

/* ------------------------------------------------------------------ *
 * Prahy podlahy.
 * ------------------------------------------------------------------ */

/** Šířka odstínového koše ve stupních. Čte se ze soudce, neopisuje se. */
export const HUE_BUCKET_WIDTH = 360 / HUE_BUCKETS;

export const LOOK_FLOOR = {
  /**
   * Kolik odlišných odstínových košů musí nést viditelné pozadí.
   *
   * Tři, protože tolik jich žádá `IMAGE_THRESHOLDS.minHues` po celém obraze.
   * Je to **odhad zdola, ne rovnost**: hmota světa maluje barvy taky a soudce
   * je vidí, jenže vzhled o nich neví. Podlaha proto žádá tři jen po pozadí,
   * které ovládá — a proto se nesmí kvůli tomuhle číslu obětovat obloha
   * (viz pořadí pák níž).
   */
  minHueBuckets: 3,
  /** Nejmenší odstup jasu dvou sousedních vrstev pozadí, 0–1. */
  minValueStep: 0.06,
  /** Pod tímhle protisvětlem splyne silueta s pozadím. */
  minRim: 0.35,
  /** Mlha mimo tohle pásmo buď zavře pozadí do jedné hodnoty, nebo nemá co malovat. */
  fog: { min: 0.2, max: 0.85 },
  /**
   * Expozice mimo tohle pásmo dá vypálený nebo nečitelný obraz.
   *
   * Je to **užší** pásmo než rozpočet z `LOOK_BUDGETS.exposure` (0,8–1,8),
   * a tak to má být: rozpočet říká, co se ještě smí napsat, podlaha říká, co
   * ještě obstojí v obraze. Test drží, že podlaha leží uvnitř rozpočtu —
   * kdyby z něj vyčnívala, opravovala by na hodnotu, kterou brána vzhledu
   * hned oseká zpátky.
   */
  exposure: { min: 0.9, max: 1.6 },
} as const;

/**
 * Střed koše ve stupních.
 *
 * Střed schválně: barva na hraně koše by se při zaokrouhlení do osmi bitů mohla
 * přelít k sousedovi a oprava by přestala platit, aniž by to bylo z čeho poznat.
 */
export function bucketCentre(bucket: number): number {
  return bucket * HUE_BUCKET_WIDTH + HUE_BUCKET_WIDTH / 2;
}

/**
 * Prstenec košů, do kterých oprava smí mířit — dvanáct minus ty, jejichž střed
 * padne do fialového pásma.
 *
 * **Počítá se, neopisuje se.** Kdyby tu stál ručně napsaný seznam devíti čísel,
 * rozšíření `PURPLE_BAND` by ho nechalo být a oprava by fialovou vyrobila na
 * cestě, kterou nikdo ručně nepíše a nikdo se na ni nedívá.
 */
export const ALLOWED_HUE_BUCKETS: readonly number[] = Array.from(
  { length: HUE_BUCKETS },
  (_unused, bucket) => bucket,
).filter((bucket) => {
  const centre = bucketCentre(bucket);
  return centre < PURPLE_BAND.min || centre > PURPLE_BAND.max;
});

/**
 * O kolik košů po prstenci dál leží další plocha pozadí.
 *
 * **Dva, protože to je nejmenší krok, který mezi sousedy nechá celý prázdný
 * koš** — 60° při šířce koše 30°, tedy rezerva, kterou zaokrouhlení do osmi
 * bitů nesebere. Menší krok tu rezervu nemá, větší platí rozlišitelností.
 *
 * Naměřeno 29. 8. 2026 nad devítiprvkovým prstencem, kolik různých trojic
 * který krok vůbec umí vyrobit:
 *
 * | Krok | Různých trojic | Nejmenší rozestup |
 * |---|---|---|
 * | 1 | 9 | 30° (bez mezery) |
 * | **2** | **9** | **60°** |
 * | 3 | 3 | 90° |
 * | 4 | 9 | 30° |
 *
 * Třetina prstence vypadá jako správná volba a není: trojice pak závisí jen na
 * `skyIndex mod 3`, takže z devíti možných sad zbydou tři a pět ze šesti palet
 * repozitáře skončí v téže. To je přesně ta sbíhavost, kvůli které se absolutní
 * kotvy rušily.
 *
 * **Která ze dvou zbylých ploch bere jeden krok a která dva, na rozestupu nic
 * nemění**; co mění, je pořadí pák, a to je naměřené (viz níž).
 */
export const HUE_STEP_BUCKETS = 2;

/**
 * Odstín, ze kterého se prstenec odpíchne, když obloha žádný vlastní nemá.
 *
 * Šedá plocha nemaluje žádný koš, takže se od ní měřit nedá a nějaký začátek
 * zvolit musíme. Chladná obloha je ten, na kterém stála absolutní kotva do
 * 29. 8. 2026, takže se šedý svět touhle změnou nehne.
 */
export const COLOURLESS_SKY_HUE = 195;

/**
 * O kolik se míří výš, než kam sahá práh. Platí pro sytost i pro odstup jasu.
 *
 * **Není to opatrnost, je to podmínka toho, aby oprava platila.** Barva se
 * ukládá do osmi bitů na kanál, takže hodnota spočítaná přesně na práh z něj
 * po zaokrouhlení vypadne. Naměřeno 29. 8. 2026: šedá `#808080` obarvená
 * přesně na `minSaturation` skončila na 0,148 — o dvě tisíciny pod prahem,
 * který měla splnit, a soudce ji dál počítal za barvu bez odstínu.
 *
 * U jasu je to navíc podmínka **idempotence**: ztmavení přesně na práh by při
 * druhém průchodu ztmavilo znovu a po deseti snímcích by byla zem černá.
 */
const MARGIN = 1.5;

/* ------------------------------------------------------------------ *
 * Barvy.
 * ------------------------------------------------------------------ */

function channels(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255];
}

function toHex(rgb: readonly [number, number, number]): string {
  const parts = rgb.map((channel) =>
    Math.min(255, Math.max(0, Math.round(channel * 255)))
      .toString(16)
      .padStart(2, '0'),
  );
  return `#${parts.join('')}`;
}

/** Váhy Rec. 709. Napsané jednou, protože `withHue` musí počítat týmž jasem. */
const LUMA_709 = { r: 0.2126, g: 0.7152, b: 0.0722 } as const;

/** Jas podle Rec. 709 — táž váha, jakou počítá soudce pásma jasu. */
export function luminanceOf(hex: string): number {
  const [r, g, b] = channels(hex);
  return LUMA_709.r * r + LUMA_709.g * g + LUMA_709.b * b;
}

/** Sytost jako `(max − min) / max`, stejně jako ji počítá soudce. */
export function saturationOf(hex: string): number {
  const [r, g, b] = channels(hex);
  const max = Math.max(r, g, b);
  return max === 0 ? 0 : (max - Math.min(r, g, b)) / max;
}

/**
 * Táž barva v jiném odstínu. Jas si nese svůj, sytost taky — **až na jednu
 * výjimku**: barva pod prahem soudce ji dostane zvednutou přesně na práh.
 *
 * Přes HSV, ne HSL: soudce počítá sytost jako `(max − min) / max`, tedy HSV,
 * a oprava, která by hýbala HSL sytostí, by míjela práh, který má splnit.
 *
 * **Proč se šedá barví.** Plocha, které soudce odstín nevidí, nemaluje žádný
 * koš — a otočením odstínu nad šedou se to nezmění, protože rotace nese sytost
 * s sebou. Šedá obloha je přitom právě ten bezbarvý prostor, kvůli kterému
 * podlaha existuje. Dostane proto **nejmenší nádech, který soudce rozezná**
 * (`minSaturation`, ani o kousek víc), ne barvu vymyšlenou od stolu.
 *
 * Černá zůstane černá: sytost se počítá z jasu, a nula krát cokoliv je nula.
 * To je záměr — z černé se odstup jasu vytáhnout nedá a přesně tenhle případ
 * má skončit pojmenovaným selháním.
 */
function withHue(hex: string, hue: number): string {
  const [r, g, b] = channels(hex);
  const value = Math.max(r, g, b);
  const saturation = Math.max(
    value === 0 ? 0 : (value - Math.min(r, g, b)) / value,
    IMAGE_THRESHOLDS.minSaturation * MARGIN,
  );

  const shape = hueShape(hue, saturation);
  // Jas jednotkové barvy toho odstínu. Zelená ho má 0,715, červená 0,213 —
  // proto se nedá otočit odstín a nechat `value` být.
  const unit = LUMA_709.r * shape[0] + LUMA_709.g * shape[1] + LUMA_709.b * shape[2];
  const wanted = luminanceOf(hex);
  // Nedosažitelný jas se ořízne, ne dorovná: barva s `value` nad 1 neexistuje
  // a tiché rozsvícení sytosti by z opravy udělalo přemalování.
  const scale = unit === 0 ? 0 : Math.min(1, wanted / unit);

  return toHex([shape[0] * scale, shape[1] * scale, shape[2] * scale]);
}

/** Barva daného odstínu a sytosti s `value` = 1. Jas si dopočítá volající. */
function hueShape(hue: number, saturation: number): readonly [number, number, number] {
  const sector = (((hue % 360) + 360) % 360) / 60;
  const fraction = sector - Math.floor(sector);
  const p = 1 - saturation;
  const q = 1 - saturation * fraction;
  const t = 1 - saturation * (1 - fraction);

  switch (Math.floor(sector) % 6) {
    case 0:
      return [1, t, p];
    case 1:
      return [q, 1, p];
    case 2:
      return [p, 1, t];
    case 3:
      return [p, q, 1];
    case 4:
      return [t, p, 1];
    default:
      return [1, p, q];
  }
}

/** Ztmavení k černé. `amount` 0 nechá barvu být, 1 z ní udělá černou. */
function darken(hex: string, amount: number): string {
  const [r, g, b] = channels(hex);
  return toHex([r * (1 - amount), g * (1 - amount), b * (1 - amount)]);
}

/**
 * Do kterého koše barva patří, nebo `null`, když do žádného.
 *
 * Čte se ze soudce (`judgedHueBucket`), neopisuje se. **Naměřeno 29. 8. 2026,
 * že vlastní kopie tohohle pravidla lže:** dřív se tu sčítaly dvě podmínky —
 * poměrná sytost soudce a `hueOf` z `look-schema.ts`, které odmítá barvu podle
 * absolutního rozpětí kanálů. Tmavé kovové barvy propadly druhou z nich, takže
 * si oprava myslela, že svět `foundry` má jeden odstín, zatímco soudce v něm
 * viděl tři — a oprava ho „opravovala" mimo práh, který má splnit.
 *
 * Barva pod `minSaturation` odstín **nenese**. Přesně tahle podmínka dělá
 * z šedého vzhledu případ, který se opravit nedá: otáčení odstínu nad šedou nic
 * nezmění a domalovat sytost by znamenalo vymyslet barvu, kterou svět nemá.
 */
const bucketOf = judgedHueBucket;

/* ------------------------------------------------------------------ *
 * Oprava.
 * ------------------------------------------------------------------ */

/** Jedna změna vzhledu. Nese, co drží, co se pohnulo a proč. */
export interface LookRepair {
  /** Vlastnost obrazu, kterou tahle změna drží. Slovník je `image-judge.ts`. */
  readonly property: ImageProperty;
  /** Cesta k poli, `/`-oddělená — týž tvar jako v `look-schema.ts`. */
  readonly path: string;
  readonly from: string | number;
  readonly to: string | number;
  readonly reason: string;
}

export interface LookFloor {
  /** Drží vzhled po opravě všechny prahy podlahy? */
  readonly ok: boolean;
  /** Opravený vzhled. Vrací se i při `ok: false` — scéna musí něco dostat. */
  readonly look: LookDescriptor;
  readonly repairs: readonly LookRepair[];
  /** Co se opravit nedalo. Prázdné, když se povedlo všechno. */
  readonly failed: readonly ImageProperty[];
}

/**
 * Barvy pozadí, které jsou na snímku **vidět**.
 *
 * Tři plochy, ne čtyři, a která je ta třetí rozhoduje voda. Deska země leží
 * 0,15 pod hladinou (T8-ground), takže ve světě s vodou nemaluje ani pixel —
 * naměřeno 29. 8. 2026 na `frost-plateau`: hladina zabírá 50,6 % snímku,
 * obloha 31,8 %, zbytek je geometrie, a země není nikde.
 *
 * **Počítat ji tam by byla lež, ne opatrnost.** Přesně na ní stála oprava,
 * která `frost-plateau` „spravila" otočením země pod vodou: popis vzhledu měl
 * tři koše, obraz dva, a soudce ho poslal do červené.
 */
function visibleBackground(look: LookDescriptor): readonly string[] {
  return look.water.present
    ? [look.sky.color, look.water.color, look.fog.color]
    : [look.sky.color, look.ground.color, look.fog.color];
}

/**
 * Kam po prstenci míří tři plochy pozadí toho konkrétního světa.
 *
 * **Obloha si nechá svůj koš**, zbylé dvě jdou o pevný počet košů dál. Tím se
 * trojice svět od světa liší, a přitom si mezi sebou drží týž rozestup.
 *
 * Naměřeno 29. 8. 2026, proč to nesmí být tři absolutní odstíny: přístav
 * (obloha 196°, s vodou) dostával 195 / 166 / 44 a poušť (obloha 37°, bez vody)
 * 37 / 195 / 165 — **tytéž tři koše, jen jinak rozdané**. Průměrná barva obou
 * snímků pak stála 2,7 od sebe proti prahu 8. Pět ze šesti palet skončilo
 * v koši 5 i v koši 6; čím víc světů oprava potkala, tím víc se sbíhaly.
 */
function hueAnchorsFor(skyColor: string): { sky: number; fog: number; floor: number } {
  const skyBucket = judgedHueBucket(skyColor);
  // Šedá obloha koš nemaluje a fialová se za svůj koš schovat nesmí — oprava,
  // která zamíří doprostřed fialového koše, by fialovou vyrobila sama.
  const start =
    skyBucket !== null && ALLOWED_HUE_BUCKETS.includes(skyBucket)
      ? ALLOWED_HUE_BUCKETS.indexOf(skyBucket)
      : nearestAllowedIndex(skyBucket === null ? COLOURLESS_SKY_HUE : bucketCentre(skyBucket));

  const at = (steps: number) =>
    bucketCentre(ALLOWED_HUE_BUCKETS[(start + steps) % ALLOWED_HUE_BUCKETS.length]!);

  return { sky: at(0), fog: at(HUE_STEP_BUCKETS), floor: at(HUE_STEP_BUCKETS * 2) };
}

/** Index nejbližšího povoleného koše, měřeno po kruhu odstínů. */
function nearestAllowedIndex(hue: number): number {
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  ALLOWED_HUE_BUCKETS.forEach((bucket, index) => {
    const raw = Math.abs(bucketCentre(bucket) - hue);
    const distance = Math.min(raw, 360 - raw);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  });
  return best;
}

function distinctBuckets(look: LookDescriptor): number {
  return new Set(visibleBackground(look).map(bucketOf).filter((bucket) => bucket !== null)).size;
}

/**
 * Podlaha vzhledu. Čistá funkce: týž vzhled dá vždy touž opravu.
 *
 * **Idempotentní z konstrukce, ne shodou okolností.** Každý krok se ptá, jestli
 * práh **už** platí, a když platí, nic nezapíše. Druhý průchod nad opraveným
 * vzhledem proto vrátí prázdné `repairs` — a test to drží, protože právě tady
 * by se dala napsat oprava, která při každém průchodu barvu o kousek posune
 * a po deseti snímcích ze světa udělá duhu.
 */
export function repairLook(input: LookDescriptor): LookFloor {
  const repairs: LookRepair[] = [];
  let look = input;

  const note = (
    property: ImageProperty,
    path: string,
    from: string | number,
    to: string | number,
    reason: string,
  ) => repairs.push({ property, path, from, to, reason });

  /* --- protisvětlo: bez něj nemá silueta hranu ------------------------- */

  if (look.rim < LOOK_FLOOR.minRim) {
    note(
      'silhouette',
      'rim',
      look.rim,
      LOOK_FLOOR.minRim,
      `rim below ${LOOK_FLOOR.minRim} leaves the silhouette merged into the background`,
    );
    look = { ...look, rim: LOOK_FLOOR.minRim };
  }

  /* --- mlha: obě meze, každá proti jiné vadě --------------------------- */

  const fog = Math.min(LOOK_FLOOR.fog.max, Math.max(LOOK_FLOOR.fog.min, look.fog.density));
  if (fog !== look.fog.density) {
    note(
      'dead',
      'fog/density',
      look.fog.density,
      fog,
      `fog outside ${LOOK_FLOOR.fog.min}-${LOOK_FLOOR.fog.max} either walls the background off or paints nothing`,
    );
    look = { ...look, fog: { ...look.fog, density: fog } };
  }

  /* --- expozice ------------------------------------------------------- */

  const exposure = Math.min(
    LOOK_FLOOR.exposure.max,
    Math.max(LOOK_FLOOR.exposure.min, look.exposure),
  );
  if (exposure !== look.exposure) {
    note(
      'luminanceSpread',
      'exposure',
      look.exposure,
      exposure,
      `exposure outside ${LOOK_FLOOR.exposure.min}-${LOOK_FLOOR.exposure.max} burns the image out or drowns it`,
    );
    look = { ...look, exposure };
  }

  /* --- odstíny: tři plochy, tři kotvy ---------------------------------- */

  if (distinctBuckets(look) < LOOK_FLOOR.minHueBuckets) {
    // Obloha si nechá koš, ve kterém stojí. Otočit ji jinam by z pouště udělalo
    // led a z pece večer u moře — je to největší plocha snímku a nese charakter
    // světa, ne jeho vadu.
    const anchors = hueAnchorsFor(look.sky.color);

    /*
     * **Pořadí je od nejlevnější plochy k nejdražší, ne shora dolů.** Opar je
     * závoj, dole je plocha pod obzorem, obloha je třetina snímku a sahá se na
     * ni jako na poslední.
     *
     * Naměřeno 29. 8. 2026, proč na tom záleží: dokud oprava otáčela oblohu
     * jako první, dostal svět `kiln-court` místo teplé pece studenou modř
     * a jeho mrtvá plocha vyskočila z 0,493 na 0,597, tedy nad práh. Přitom mu
     * nic nechybělo — soudce v jeho obraze tři odstíny viděl, jen popis vzhledu
     * o nich nevěděl, protože barvu hmoty maluje kit, ne vzhled.
     */
    const levers = [
      {
        path: 'fog/color',
        hue: anchors.fog,
        get: (l: LookDescriptor) => l.fog.color,
        set: (l: LookDescriptor, color: string) => ({ ...l, fog: { ...l.fog, color } }),
        reason: 'the haze steps one bucket on from the sky, into the gap the other two leave',
      },
      look.water.present
        ? {
            path: 'water/color',
            hue: anchors.floor,
            get: (l: LookDescriptor) => l.water.color,
            set: (l: LookDescriptor, color: string) => ({ ...l, water: { ...l.water, color } }),
            reason: 'the water steps two buckets on from the sky, so the two big areas stand furthest apart',
          }
        : {
            path: 'ground/color',
            hue: anchors.floor,
            get: (l: LookDescriptor) => l.ground.color,
            set: (l: LookDescriptor, color: string) => ({ ...l, ground: { ...l.ground, color } }),
            reason: 'the ground steps two buckets on from the sky, so earth and sky stop being one colour',
          },
      {
        path: 'sky/color',
        hue: anchors.sky,
        get: (l: LookDescriptor) => l.sky.color,
        set: (l: LookDescriptor, color: string) => ({ ...l, sky: { ...l.sky, color } }),
        reason: 'the sky keeps its own bucket, pulled onto the centre of it',
      },
    ] as const;

    for (const lever of levers) {
      // Otáčí se nejmenší počet ploch, který stačí.
      if (distinctBuckets(look) >= LOOK_FLOOR.minHueBuckets) break;

      const from = lever.get(look);
      const to = withHue(from, lever.hue);
      if (to === from) continue;

      note('hues', lever.path, from, to, lever.reason);
      look = lever.set(look, to);
    }
  }

  /* --- hodnoty: obloha, opar a zem nesmí stát v téže hodnotě ----------- */

  const skyValue = luminanceOf(look.sky.color);
  const groundValue = luminanceOf(look.ground.color);
  if (skyValue - groundValue < LOOK_FLOOR.minValueStep) {
    // Ztmavuje se **zem**, ne obloha: obloha je světlo, které do světa svítí,
    // a ztmavit ji znamená ztmavit celý obraz. Zem je hmota ve stínu.
    const wanted = Math.max(0, skyValue - LOOK_FLOOR.minValueStep * MARGIN);
    const ground = darken(look.ground.color, groundValue === 0 ? 0 : 1 - wanted / groundValue);
    if (ground !== look.ground.color) {
      note(
        'luminanceSpread',
        'ground/color',
        look.ground.color,
        ground,
        `sky and ground stood within ${LOOK_FLOOR.minValueStep} of each other, so the horizon had no step`,
      );
      look = { ...look, ground: { ...look.ground, color: ground } };
    }
  }

  /* --- co se nepovedlo ------------------------------------------------- */

  const failed: ImageProperty[] = [];
  if (distinctBuckets(look) < LOOK_FLOOR.minHueBuckets) failed.push('hues');
  if (luminanceOf(look.sky.color) - luminanceOf(look.ground.color) < LOOK_FLOOR.minValueStep) {
    failed.push('luminanceSpread');
  }

  return { ok: failed.length === 0, look, repairs, failed };
}
