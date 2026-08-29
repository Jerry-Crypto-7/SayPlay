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
 * ## Tři viditelné plochy, tři kotvy
 *
 * Barvy se **otáčejí v odstínu, jas si nesou svůj**. Právě proto dva opravené
 * světy nevypadají stejně: každý si nese vlastní jas a vlastní sytost, mění se
 * jen rodina odstínu. Kdyby se přepisovalo víc, vyrobila by oprava dvanáct
 * stejných snímků a rozbila by přesně to, co kontaktní list měří.
 *
 * Plochy jsou tři, ne čtyři, a která je třetí rozhoduje voda: **deska země leží
 * pod hladinou**, takže ve světě s vodou nemaluje ani pixel. Kotvy se rozdají
 * tak, aby ležely ve třech různých koších:
 *
 * - **bez vody** — obloha si nechá stranu, na které stojí, zem bere protilehlou
 *   a opar zbytek. Chladná obloha, teplá zem, mlha mezi nimi.
 * - **s vodou** — dole je hladina a ta bere **chladnější** ze dvou zbylých
 *   kotev; teplé moře je barva, kterou nikdo nechce. Teplá kotva zbude na opar,
 *   a to je nízké slunce na obzoru.
 *
 * Otáčí se **nejmenší počet ploch, který stačí**, a jakmile jsou tři koše
 * obsazené, oprava přestane. Svět, který tři koše má, se nedotkne vůbec.
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
  judgedHue,
  judgedHueBucket,
} from './image-judge';
import { type LookDescriptor } from './look';

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
 * Tři cílové odstíny, každý ve **středu** svého koše.
 *
 * Střed schválně: barva na hraně koše by se při zaokrouhlení do osmi bitů mohla
 * přelít k sousedovi a oprava by přestala platit, aniž by to bylo z čeho poznat.
 *
 * Všechny tři leží **mimo fialové pásmo** — hlídá to test, ne tenhle komentář.
 * Kdyby se některý posunul do 250–320°, vyrobila by oprava fialovou na cestě,
 * kterou nikdo ručně nepíše a nikdo se na ni nedívá.
 */
export const HUE_ANCHORS = {
  /** Chladná obloha. */
  cool: 195,
  /** Teplá zem. */
  warm: 45,
  /** Opar o koš chladnější než obloha — tam, kam ho posouvá rozptyl. */
  haze: 165,
} as const;

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

/** Jas podle Rec. 709 — táž váha, jakou počítá soudce pásma jasu. */
export function luminanceOf(hex: string): number {
  const [r, g, b] = channels(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
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

  const sector = (((hue % 360) + 360) % 360) / 60;
  const fraction = sector - Math.floor(sector);
  const p = value * (1 - saturation);
  const q = value * (1 - saturation * fraction);
  const t = value * (1 - saturation * (1 - fraction));

  switch (Math.floor(sector) % 6) {
    case 0:
      return toHex([value, t, p]);
    case 1:
      return toHex([q, value, p]);
    case 2:
      return toHex([p, value, t]);
    case 3:
      return toHex([p, q, value]);
    case 4:
      return toHex([t, p, value]);
    default:
      return toHex([value, p, q]);
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
    // Obloha si nechá stranu, na které stojí. Otočit ji na tu druhou by z pouště
    // udělalo led a z pece večer u moře — je to největší plocha snímku a nese
    // charakter světa, ne jeho vadu.
    const skyHue = judgedHue(look.sky.color);
    const skyIsCool =
      skyHue === null ||
      Math.abs(skyHue - HUE_ANCHORS.cool) <= Math.abs(skyHue - HUE_ANCHORS.warm);

    /*
     * Zbylé dvě kotvy dostanou zbylé dvě viditelné plochy, a která kterou,
     * rozhoduje voda:
     *
     * - **bez vody** je dole zem, ta bere protilehlou stranu oblohy a opar
     *   zbývající opar. Chladná obloha, teplá zem, mlha mezi nimi.
     * - **s vodou** je dole hladina. Ta bere **chladnější** ze dvou zbylých
     *   kotev, protože teplé moře je barva, kterou nikdo nechce; teplá kotva
     *   pak zbývá na opar, a to je nízké slunce na obzoru.
     *
     * Tři různé kotvy ve třech různých koších — ať už se rozhodne jakkoliv.
     */
    const anchors = look.water.present
      ? {
          floor: skyIsCool ? HUE_ANCHORS.haze : HUE_ANCHORS.cool,
          fog: skyIsCool ? HUE_ANCHORS.warm : HUE_ANCHORS.haze,
        }
      : {
          floor: skyIsCool ? HUE_ANCHORS.warm : HUE_ANCHORS.cool,
          fog: HUE_ANCHORS.haze,
        };

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
        reason: 'the haze takes the anchor the sky and the surface below it left over',
      },
      look.water.present
        ? {
            path: 'water/color',
            hue: anchors.floor,
            get: (l: LookDescriptor) => l.water.color,
            set: (l: LookDescriptor, color: string) => ({ ...l, water: { ...l.water, color } }),
            reason: 'the water takes the cooler of the two anchors the sky did not take',
          }
        : {
            path: 'ground/color',
            hue: anchors.floor,
            get: (l: LookDescriptor) => l.ground.color,
            set: (l: LookDescriptor, color: string) => ({ ...l, ground: { ...l.ground, color } }),
            reason: 'the ground takes the side opposite the sky, so earth and sky stop being one colour',
          },
      {
        path: 'sky/color',
        hue: skyIsCool ? HUE_ANCHORS.cool : HUE_ANCHORS.warm,
        get: (l: LookDescriptor) => l.sky.color,
        set: (l: LookDescriptor, color: string) => ({ ...l, sky: { ...l.sky, color } }),
        reason: 'the sky keeps its own side, pulled onto the anchor at the centre of the bucket',
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
