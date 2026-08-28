import { uniformInt } from 'pure-rand/distribution/uniformInt';
import { xoroshiro128plus } from 'pure-rand/generator/xoroshiro128plus';

import { TERRAIN_VARIANTS, type GeomProgram } from '@/geom/program';
import { PALETTES, type Palette, type PaletteName } from '@/kit';

/**
 * **Popis vzhledu** — jak svět vypadá, odděleně od toho, co v něm stojí.
 *
 * Do 28. 8. 2026 tenhle popis neexistoval a vzhled byl konstanta: obloha, voda,
 * světelné kužely a prach žily výhradně v `TargetFrame.tsx`, tedy v ručně
 * napsaném cílovém snímku. Každý **vygenerovaný** svět proto dostal tutéž
 * plochou mlhu a totéž pozadí, ať ho věta postavila do dun nebo do háje.
 *
 * ## Proč se vzhled nejdřív odvozuje, a teprve pak autoruje
 *
 * Vzhled by mohl rovnou psát model (P13 vlna 2). Kdyby ale byl **jen** od
 * modelu, neexistoval by, dokud model neběží — a offline větev ani `/embed`
 * žádný model nemají. Odvození je proto podlaha: každý svět má vzhled odvozený
 * ze sebe sama, a autorování ho v T9 jen přepíše tam, kde to model zvládne líp.
 *
 * ## Sedm polí a odkud se berou
 *
 * `sky` · `water` · `fog` · `key` · `rim` · `exposure` · `dust`. Osmé pole
 * `palette` mezi ně nepatří — je to **vstup**, ze kterého se těch sedm odvodilo,
 * a nese se dál jen proto, že z něj `<Atmosphere>` bere barvy. Rozmanitost se
 * proto soudí nad sedmi (`LOOK_FIELDS`), ne nad osmi.
 *
 * Rozhodují dva údaje světa a nic jiného:
 *
 * - **Paleta** říká, z čeho je svět postavený, a tím i v jakém vzduchu stojí.
 *   Suché `dunes` vodu nedostanou nikdy, `frost` a `thicket` ano.
 * - **Terén** říká, jestli se v tom vzduchu něco drží. Kotlina (`basin`) drží
 *   mlhu i prach, náhorní plošina (`plateau`) je vyfoukaná a suchá.
 *
 * **Terén nikdy nepřeklopí přítomnost vody.** Mohl by — kotlina v poušti je
 * solné jezero — ale pak by pravidlo „Duny vodu nedostanou" platilo jen někdy,
 * a pravidlo, které platí jen někdy, se nedá testovat jednou asercí. Terén tedy
 * sílí a slábne, paleta rozhoduje.
 *
 * ## Barvy se počítají z palety, ne vymýšlejí vedle ní
 *
 * Obloha, mlha a voda jsou míchané z hexů té palety, kterou je svět postavený.
 * Druhá sada hexů vedle kitu by byla druhý zdroj pravdy o barvě světa a rozešla
 * by se s ním při první změně palety. Vedlejší přínos: paleta žádnou fialovou
 * neobsahuje, takže ji nemůže vyrobit ani odvození — **ale netvrdí se to
 * komentářem**, měří to `look.test.ts` nad vypočítaným odstínem, protože
 * míchání dvou barev v sRGB může odstín poslat mimo oblouk mezi nimi.
 *
 * ## Náhodnost
 *
 * Semínko rozhoduje o směru klíčového světla a o drobném rozptylu hustot —
 * dva světy téže rodiny nemají stín ve stejném úhlu. Jediná PRNG je `pure-rand`
 * s vlastním streamem (`CLAUDE.md`), takže totéž semínko dá pokaždé týž popis.
 *
 * Soubor **neimportuje `three`**: vzhled je dokument, ne scéna, a musí se dát
 * odvodit i tam, kde renderer není — v Node, v ověřovači a v testu.
 */

/** Terén, tak jak ho pojmenovává program geometrie. Druhý slovník by byl druhá pravda. */
export type TerrainKind = (typeof TERRAIN_VARIANTS)[number];

export interface SkyLook {
  /** Barva zenitu. Obzor si `<Atmosphere>` dopočítá spádem k mlze. */
  readonly color: string;
  /**
   * Kde na kouli leží přechod obzoru, 0 = u nohou, 1 = v zenitu. Nižší hodnota
   * znamená víc oblohy a plošší svět, vyšší sevřenější obzor.
   */
  readonly height: number;
}

export interface WaterLook {
  /** Kreslí se hladina? Poušť ji nedostane. */
  readonly present: boolean;
  /** Barva hladiny. Nese se, i když se nekreslí — popis popisuje, kreslení řeší scéna. */
  readonly color: string;
}

export interface FogLook {
  /** 0 = čirý vzduch, 1 = neprůhledná stěna ve dvou třetinách dohledu. */
  readonly density: number;
  readonly color: string;
}

export interface KeyLightLook {
  /** Směr **ke zdroji**, jednotkový. Osa `y` je nahoru. */
  readonly direction: readonly [number, number, number];
  /** Teplota v kelvinech. 2700 je svíčka, 5600 poledne, 8000 zataženo. */
  readonly temperature: number;
}

export interface LookDescriptor {
  /** Vstup odvození, ne osmé odvozené pole. Viz hlavičku. */
  readonly palette: PaletteName;
  readonly sky: SkyLook;
  readonly water: WaterLook;
  readonly fog: FogLook;
  readonly key: KeyLightLook;
  /** Síla protisvětla, 0–1. Ono odděluje siluetu od pozadí. */
  readonly rim: number;
  /** Násobič expozice ACES. Pod 1 scéna ztmavne, nad 1 se rozsvítí. */
  readonly exposure: number;
  /** Hustota prachu ve vzduchu, 0–1. Nula znamená, že se prach nekreslí vůbec. */
  readonly dust: number;
}

/** Sedm polí, nad kterými se soudí rozmanitost. `palette` mezi ně nepatří. */
export const LOOK_FIELDS = ['sky', 'water', 'fog', 'key', 'rim', 'exposure', 'dust'] as const;

export type LookField = (typeof LOOK_FIELDS)[number];

export interface LookInput {
  readonly palette: PaletteName;
  readonly terrain: TerrainKind;
  readonly seed: number;
}

/**
 * Vzduch, ve kterém daný materiál stojí.
 *
 * Není to tabulka nálad — každý řádek odpovídá na otázku „když je svět
 * postavený z tohohle, jaké je kolem něj počasí". Mrazivá `frost` má vodu
 * a hustou studenou mlhu; suché `dunes` nemají ani jedno a mají místo toho
 * nejvyšší expozici, protože v poušti je světla nadbytek.
 */
interface PaletteAir {
  readonly water: boolean;
  readonly fog: number;
  readonly dust: number;
  readonly exposure: number;
  readonly rim: number;
  readonly temperature: number;
  readonly skyHeight: number;
}

const BY_PALETTE: Readonly<Record<PaletteName, PaletteAir>> = {
  /** Přístav: vlhko od moře, mírné světlo, hodně vody. */
  harbor: {
    water: true,
    fog: 0.55,
    dust: 0.35,
    exposure: 1.15,
    rim: 0.55,
    temperature: 6200,
    skyHeight: 0.5,
  },
  /** Pec: horký suchý vzduch nad rozpálenou hlínou, popel místo mlhy. */
  kiln: {
    water: false,
    fog: 0.3,
    dust: 0.55,
    exposure: 1.3,
    rim: 0.4,
    temperature: 3200,
    skyHeight: 0.32,
  },
  /** Houština: nejhustší prach ze všech — pyl a spory v prosvětleném porostu. */
  thicket: {
    water: true,
    fog: 0.7,
    dust: 0.85,
    exposure: 1.05,
    rim: 0.7,
    temperature: 5200,
    skyHeight: 0.62,
  },
  /** Hutě: kouř drží nízko a obzor je zavřený, protisvětlo skoro žádné. */
  foundry: {
    water: false,
    fog: 0.85,
    dust: 0.6,
    exposure: 1.2,
    rim: 0.35,
    temperature: 4200,
    skyHeight: 0.24,
  },
  /** Duny: čirý vzduch, nejtvrdší slunce, **žádná voda**. */
  dunes: {
    water: false,
    fog: 0.2,
    dust: 0.45,
    exposure: 1.45,
    rim: 0.3,
    temperature: 2900,
    skyHeight: 0.4,
  },
  /** WORLDSTREAM: paleta cílového snímku — voda, měkká mlha, silné protisvětlo. */
  worldstream: {
    water: true,
    fog: 0.6,
    dust: 0.5,
    exposure: 1.25,
    rim: 0.8,
    temperature: 5600,
    skyHeight: 0.55,
  },
  /** Mráz: nejchladnější světlo a nejsilnější protisvětlo, prachu skoro nic. */
  frost: {
    water: true,
    fog: 0.75,
    dust: 0.25,
    exposure: 1.35,
    rim: 0.9,
    temperature: 7800,
    skyHeight: 0.7,
  },
};

/**
 * Co s tím vzduchem udělá tvar země. Násobiče, ne hodnoty — terén sílí
 * a slábne, rozhodla paleta.
 */
interface TerrainAir {
  readonly fog: number;
  readonly dust: number;
  readonly rim: number;
  /** Přičítá se, ne násobí: výška obzoru je poloha, ne množství. */
  readonly skyHeight: number;
}

const BY_TERRAIN: Readonly<Record<TerrainKind, TerrainAir>> = {
  /** Rovina: nic nedrží, nic neodfoukne. */
  flat: { fog: 1, dust: 1, rim: 1, skyHeight: 0 },
  /** Hřeben: vítr přechází přes hranu a bere mlhu s sebou, obrys se vyostří. */
  ridge: { fog: 0.85, dust: 0.9, rim: 1.12, skyHeight: 0.06 },
  /** Kotlina: drží mlhu i prach, obzor je vysoko, protože ho zavírají svahy. */
  basin: { fog: 1.3, dust: 1.2, rim: 0.9, skyHeight: 0.14 },
  /** Náhorní plošina: vyfoukaná a suchá, obzor daleko dole. */
  plateau: { fog: 0.7, dust: 0.78, rim: 1.05, skyHeight: -0.08 },
};

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Kanály sRGB hexu, 0–255. */
function channels(hex: string): readonly [number, number, number] {
  const value = Number.parseInt(hex.slice(1), 16);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
}

function toHex(rgb: readonly [number, number, number]): string {
  const parts = rgb.map((channel) =>
    clamp(Math.round(channel), 0, 255)
      .toString(16)
      .padStart(2, '0'),
  );
  return `#${parts.join('')}`;
}

/** Lineární míchání dvou sRGB hexů. `amount` 0 znamená první, 1 druhý. */
function mix(from: string, to: string, amount: number): string {
  const a = channels(from);
  const b = channels(to);
  return toHex([
    a[0] + (b[0] - a[0]) * amount,
    a[1] + (b[1] - a[1]) * amount,
    a[2] + (b[2] - a[2]) * amount,
  ]);
}

/** Ztmavení nebo zesvětlení k černé, respektive k bílé. Záporná hodnota tmaví. */
function shade(hex: string, amount: number): string {
  return mix(hex, amount < 0 ? '#000000' : '#ffffff', Math.abs(amount));
}

/**
 * Rovnoměrné číslo 0–1 z vlastního streamu. Rozlišení 10 000 kroků stačí —
 * jemnější by na obrazovce vidět nebylo a v testu by dělalo šum.
 */
function unit(stream: ReturnType<typeof xoroshiro128plus>): number {
  return uniformInt(stream, 0, 10_000) / 10_000;
}

/** Rozptyl kolem hodnoty, `spread` je relativní podíl. */
function jitter(value: number, spread: number, roll: number): number {
  return value * (1 + (roll * 2 - 1) * spread);
}

/**
 * Vzhled světa, odvozený z něj samého.
 *
 * Čistá funkce: týž vstup dá vždy týž popis, včetně směru světla. Nic se
 * neptá na hodiny ani na `Math.random()`.
 */
export function deriveLook(input: LookInput): LookDescriptor {
  const palette: Palette = PALETTES[input.palette];
  const air = BY_PALETTE[input.palette];
  const ground = BY_TERRAIN[input.terrain];

  // Vlastní stream vzhledu. Semínko se posouvá o konstantu, aby se vzhled
  // nelosoval ze stejné posloupnosti jako rozmístění kusů — jinak by přidání
  // jednoho losu v kompozici pohnulo i oblohou.
  const stream = xoroshiro128plus(input.seed ^ 0x0010_00d5);

  const azimuth = unit(stream) * Math.PI * 2;
  const elevation = 0.45 + unit(stream) * 0.35;
  const fogRoll = unit(stream);
  const dustRoll = unit(stream);
  const exposureRoll = unit(stream);

  // Obloha nese barvu materiálu světa, jen posunutou do dálky: `deep` je jeho
  // stín, `shell` jeho hmota. Čistý `deep` by dal černé pozadí, čistý `shell`
  // mléčné — mezi nimi leží dálka.
  const sky = shade(mix(palette.deep, palette.shell, 0.22), -0.12);

  // Mlha musí být příbuzná obloze, jinak v místě obzoru vznikne viditelná
  // hrana mezi dvěma nesouvisejícími barvami.
  const fogColor = mix(sky, palette.deep, 0.35);

  return {
    palette: input.palette,
    sky: { color: sky, height: clamp(air.skyHeight + ground.skyHeight, 0.1, 0.9) },
    water: { present: air.water, color: mix(palette.deep, palette.accent, 0.28) },
    fog: {
      density: clamp(jitter(air.fog * ground.fog, 0.08, fogRoll), 0.05, 1),
      color: fogColor,
    },
    key: {
      direction: [
        Math.cos(azimuth) * Math.cos(elevation),
        Math.sin(elevation),
        Math.sin(azimuth) * Math.cos(elevation),
      ],
      temperature: air.temperature,
    },
    rim: clamp(air.rim * ground.rim, 0.1, 1),
    exposure: clamp(jitter(air.exposure, 0.05, exposureRoll), 0.8, 1.8),
    dust: clamp(jitter(air.dust * ground.dust, 0.1, dustRoll), 0, 1),
  };
}

/**
 * Jaký terén svět má, přečtený z programu, kterým je postavený.
 *
 * Most mezi geometrií a vzhledem: bez něj by se druh terénu musel psát do
 * vzhledu ručně a hned by šlo napsat jiný, než na jakém svět doopravdy stojí.
 * Bere se **první** terénní uzel — program jich smí mít víc, ale zem, na které
 * se svět zakládá, je jen jedna. Svět bez terénu je rovina.
 */
export function terrainOfProgram(program: GeomProgram): TerrainKind {
  const ground = program.nodes.find((node) => node.kind === 'terrain');
  return ground === undefined ? 'flat' : ground.variant;
}

/**
 * V kolika ze sedmi polí se dva popisy liší.
 *
 * Porovnává se strukturálně, protože pole nejsou jen čísla — `sky` je dvojice
 * a `key` je vektor s teplotou. Test rozmanitosti tuhle míru používá jako
 * jedinou definici slova „různý", takže dvě definice vedle sebe nevzniknou.
 */
export function lookDifference(a: LookDescriptor, b: LookDescriptor): number {
  return LOOK_FIELDS.filter((field) => JSON.stringify(a[field]) !== JSON.stringify(b[field])).length;
}
