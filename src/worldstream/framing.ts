/**
 * Rámování kamery počítané ze scény.
 *
 * ## Proč to vzniklo
 *
 * Brána K0 nad kontaktním listem (28. 8. 2026, `docs/worldstream-art-direction.md`)
 * našla jednu společnou příčinu obou extrémů: **kamera mířila do podlahy**.
 * Statický pohled seděl na `[7, 7, 9]` a mířil do počátku, tedy 31,5° pod
 * vodorovnou při svislém poloúhlu 22,5°. Horizont tím vyjel nad horní hranu
 * snímku a obraz neměl obzor vůbec. Kde podlaha kitu sahala, zakryla pozadí
 * beze zbytku (obloha 0 %); kde nesahala, zbyla prázdná koule oblohy
 * (`dunes-terrace`, obloha 94,9 %, mrtvá plocha 86,8 %).
 *
 * Tenhle modul nahrazuje obě konstanty výpočtem z **naměřeného obalu scény**.
 *
 * ## Tři čísla, ze kterých se všechno odvíjí
 *
 * 1. **Podíl oblohy.** V perspektivní kameře leží obzor přesně tam, kam míří
 *    vodorovný paprsek. Když kamera klopí o `pitch` a svislý poloúhel je `phi`,
 *    obzor sedí na `tan(pitch) / tan(phi)` nad středem snímku, měřeno v podílu
 *    poloviny výšky. Nad ním je obloha, pod ním země, takže
 *    `podíl oblohy = (1 − tan(pitch)/tan(phi)) / 2`. Ta rovnice se dá obrátit,
 *    a tím vznikne klopení ze zadaného podílu oblohy.
 *
 *    **Ověřeno na ručně vyladěném cílovém snímku**, který bránou K0 prošel:
 *    oko `[10, 8.6, 36]`, cíl `[−1, 3.6, −6]`, zorný úhel 38° dává klopení 6,6°
 *    a předpověď oblohy 33,5 %. To je uprostřed pásma 15–45 %, které tenhle
 *    modul vyrábí — model tedy souhlasí s obrazem, který se člověku líbil, a
 *    není to zpětně dopsané číslo. Hlídá to test `frameScene souhlasí s ručně
 *    vyladěným cílovým snímkem`.
 *
 * 2. **Hlavní objekt na třetině.** Bod, kam kamera míří, se zvedne nad hrdinu
 *    tak, aby hrdina spadl na spodní třetinu snímku. Zvednutí je `distance ·
 *    tan(phi) · (1 − 2·třetina)`, protože obraz je lineární v tangentě úhlu,
 *    ne v úhlu samotném.
 *
 * 3. **Vzdálenost.** Začne se na kouli opsané obalu a pak se **ověří všech osm
 *    rohů obalu proti jehlanu vidění** a vzdálenost se po krocích zvětšuje,
 *    dokud se dovnitř nevejdou. Analytické řešení tu neexistuje: osa pohledu
 *    míří na zvednutý cíl, ne do středu obalu, takže úhel, který koule zabírá,
 *    a odchylka osy se sčítají. Osm rohů je přesná odpověď na otázku „je celý
 *    v záběru", zatímco koule je jen odhad.
 *
 * ## Snímek není okno — `safeArea`
 *
 * Rozhraní stojí **v** obraze, ne vedle něj: dolní pruh s dokem a krajní sloupce
 * s ovládáním a zásuvkou Inspect kryjí plátno, které je celý viewport. Rámovat
 * do celého okna proto znamená rámovat hrdinu pod dok. `safeArea` popisuje
 * zakrytý podíl každé hrany a celý výpočet se pak vede nad **volnou plochou**:
 * svisle `[−1 + 2·bottom, 1]`, vodorovně `[−1 + 2·left, 1 − 2·right]`.
 *
 * Nezmenšuje se zorný úhel — ten patří kameře a scéna má krajní sloupce
 * vyplňovat, ne končit na jejich hraně. Zmenší se **poloúhly, do kterých se
 * obal cpe**, a o rozdíl středů se posune to, kam kamera míří: klopení nese
 * svislý posun (obzor drží zadaný podíl volné plochy, ne okna) a vodorovný
 * posun cíle nese nesouměrnost sloupců.
 *
 * ## Čistá funkce schválně
 *
 * Žádný `three`, žádné plátno. Rámování je jediná věc, kterou z hotového
 * snímku poznat nejde — když je špatné, obraz vypadá jako obraz, jen se dívá
 * jinam. Musí jít ověřit jednotkově, nad vymyšlenými obaly, včetně těch, které
 * scéna nikdy nevyrobí.
 */

/** Bod ve světě. Vlastní typ, aby modul nezávisel na `three`. */
export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** Obal scény. `min` po složkách menší nebo rovno `max`. */
export interface Bounds {
  readonly min: Vec3;
  readonly max: Vec3;
}

/**
 * Zakrytý podíl hrany snímku, 0 až `MAX_COVER`. `bottom: 0.3` znamená, že
 * spodních 30 % výšky kryje rozhraní.
 *
 * Horní hrana chybí schválně: nad scénou nic nestojí a obloha se má dotýkat
 * horní hrany okna, jinak se svět čte jako obrázek v rámečku.
 */
export interface SafeArea {
  readonly bottom?: number;
  readonly left?: number;
  readonly right?: number;
}

/**
 * Proč rámování spadlo na náhradní obal.
 *
 * `null` znamená, že se počítalo ze skutečné scény. Ostatní hodnoty se **vrací
 * volajícímu**, ne logují: prázdná scéna je stav, který se dá nakreslit, ale
 * volající o něm musí vědět, aby ho nevydával za změřený svět.
 */
export type FramingFallback = null | 'empty' | 'degenerate';

export interface Framing {
  /** Kde kamera stojí. */
  readonly eye: Vec3;
  /** Kam se dívá. Není to hrdina — je to bod nad ním, viz `HERO_HEIGHT`. */
  readonly target: Vec3;
  /** Svislý zorný úhel ve stupních, jak ho čeká `three`. */
  readonly fov: number;
  /** Klopení osy pohledu pod vodorovnou, v radiánech. */
  readonly pitch: number;
  /** Vzdálenost oka od cíle. */
  readonly distance: number;
  /** Předpověď podílu oblohy, 0–1. Měřený podíl na ni nesedí přesně, viz níž. */
  readonly skyShare: number;
  /** Kde na snímku sedí hrdina; 0 je spodní hrana, 1 horní. */
  readonly heroHeight: number;
  readonly fallback: FramingFallback;
}

/** Svislý zorný úhel produktu ve stupních. */
export const FRAMING_FOV = 45;

/**
 * Kolik snímku má zabírat obloha.
 *
 * Uprostřed pásma 15–45 %, které žádá úloha T8, a shodou okolností přesně tam,
 * kde skončil ručně vyladěný cílový snímek (33,5 %). Z prostředku má stejnou
 * rezervu na obě strany, takže se scéna, která obzor částečně zakryje, ještě
 * vejde.
 *
 * **Předpověď a měření nejsou totéž.** Tady se počítá, kolik snímku leží nad
 * obzorem. Měřidlo v `Viewer.tsx` počítá, kolik pixelů doopravdy maluje koule
 * oblohy — a to je míň, kdykoliv nad obzor vyčnívá geometrie, a víc, kdykoliv
 * podlaha pod obzor nedosáhne. Předpověď je proto cíl výpočtu, ne aserce testu;
 * aserce patří k naměřenému číslu z kontaktního listu.
 */
export const SKY_SHARE = 0.3;

/**
 * Kde na snímku sedí hlavní objekt, 0 spodní hrana, 1 horní.
 *
 * Spodní třetina. Nad hrdinou tím zbude dvakrát tolik místa co pod ním, což je
 * přesně ten poměr, díky kterému se svět čte jako prostor a ne jako předmět.
 */
export const HERO_HEIGHT = 1 / 3;

/** O kolik se vzdálenost zvětší, když se obal do jehlanu nevejde. */
const FIT_STEP = 1.08;

/** Kolik pokusů o zvětšení. Osm kroků po 8 % je faktor 1,85 — dost na každý obal. */
const FIT_ATTEMPTS = 8;

/** Rezerva kolem obalu, aby se scéna nedotýkala hrany snímku. */
const FIT_MARGIN = 1.12;

/**
 * Nejmenší poloměr, se kterým se počítá.
 *
 * Scéna o jediném kusu i obal s nulovou hloubkou jsou platné vstupy a musí dát
 * kameru, ne dělení nulou. Půl jednotky je zhruba nejmenší kus kitu.
 */
const MIN_RADIUS = 0.5;

/** Nejmenší vzdálenost oka od cíle. Pod ní se kamera dostane dovnitř kusu. */
const MIN_DISTANCE = 3;

/** Poměr stran, když ho volající nezná. */
const DEFAULT_ASPECT = 16 / 9;

/**
 * Nejvíc, co smí jedna hrana ukousnout.
 *
 * `safeArea` se měří z DOM, takže na úzkém okně může zásuvka Inspect vyjít
 * širší než polovina plátna a volná plocha by zmizela do nuly. Strop 45 %
 * nechá i v tom případě desetinu šířky a desetinu výšky, do které se dá
 * rámovat. Je to validace vstupu zvenčí, ne pojistka na vlastní kód.
 */
const MAX_COVER = 0.45;

/** Zakrytý podíl hrany. Chybějící i nesmyslná hodnota znamená „nic nekryje". */
function cover(share: number | undefined): number {
  return share !== undefined && Number.isFinite(share) ? Math.min(Math.max(share, 0), MAX_COVER) : 0;
}

/**
 * Obdélník na obrazovce. Vlastní typ, aby modul nezávisel na DOM — `DOMRect`
 * má stejná čtyři pole, takže se sem dá předat rovnou.
 */
export interface Rect {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Protínají se ty dva obdélníky vodorovně, resp. svisle? */
function overlapsX(a: Rect, b: Rect): boolean {
  return a.left < b.right && a.right > b.left;
}

function overlapsY(a: Rect, b: Rect): boolean {
  return a.top < b.bottom && a.bottom > b.top;
}

/**
 * Zakrytý podíl hran z naměřených obdélníků.
 *
 * ## Proč to není počítané v komponentě (P18 T2b)
 *
 * Do 16. 9. 2026 to tam počítané bylo, a byla to **tichá vada složená ze dvou
 * zelených úloh**. T1 měřila překryv rozhraní s plátnem jako rozdíl hran
 * (`frame.bottom − dock.top`), což platilo, dokud plátno bylo celý viewport.
 * T2 pak zmenšila **samo plátno**, takže žádný překryv nezbyl — a tentýž
 * rozdíl začal vycházet **záporně**. `cover()` ho ořízl na nulu, takže se nic
 * nerozbilo nahlas: `safeArea` prostě zmlkla a rámování se vrátilo k chování
 * před T1. Jednotkové testy T1 na to nemohly přijít, protože si `safeArea`
 * předávají přímo a DOM nikdy neviděly.
 *
 * Horší půlka téže vady byla `left`: počítal se jako `controls.right −
 * frame.left`, tedy **kladné** číslo i tehdy, když ovládání stojí docela mimo
 * plátno. Zúžil by jehlan zleva bez důvodu a na snímku by to vypadalo jen jako
 * „svět je nějak daleko".
 *
 * Proto se tu měří **skutečný průnik**, ne rozdíl hran: hrana se počítá jedině
 * tehdy, když ji ten obdélník doopravdy překrývá i na druhé ose. Když plátno
 * pod rozhraním nesahá, vyjde nula — a nula je tady správná odpověď, ne
 * selhání: zmenšené plátno už svou volnou plochou je.
 */
export function safeAreaFromRects(
  frame: Rect,
  covers: {
    readonly bottom?: Rect | null;
    readonly left?: Rect | null;
    readonly right?: Rect | null;
  },
): SafeArea {
  const width = frame.right - frame.left;
  const height = frame.bottom - frame.top;
  // Plátno, které se ještě nerozvrhlo, je nulové. Dělit jím by dalo `Infinity`
  // v každé hraně; „nic nekryje" je jediná odpověď, která z toho dává snímek.
  if (!(width > 0) || !(height > 0)) return {};

  const { bottom, left, right } = covers;
  return {
    bottom:
      bottom != null && overlapsX(frame, bottom) && overlapsY(frame, bottom)
        ? Math.max(0, frame.bottom - bottom.top) / height
        : 0,
    left:
      left != null && overlapsX(frame, left) && overlapsY(frame, left)
        ? Math.max(0, left.right - frame.left) / width
        : 0,
    right:
      right != null && overlapsX(frame, right) && overlapsY(frame, right)
        ? Math.max(0, frame.right - right.left) / width
        : 0,
  };
}

/**
 * Kde kamera stojí kolem scény, v radiánech od osy `−z`.
 *
 * Zachovává pohled, který produkt měl na `[7, 7, 9]`: zboku a zepředu, takže se
 * mřížka otevře do hloubky místo aby stála čelně. Klopení se mění, azimut ne —
 * brána K0 měla výhradu k tomu, kam se kamera dívá svisle.
 */
const DEFAULT_AZIMUTH = Math.atan2(7, 9);

const DEGREES = Math.PI / 180;

function isFinitePoint(point: Vec3 | null | undefined): point is Vec3 {
  return (
    point !== null &&
    point !== undefined &&
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    Number.isFinite(point.z)
  );
}

/**
 * Klopení, které dá zadaný podíl oblohy.
 *
 * Obrácená rovnice obzoru. Podíl 0,5 znamená vodorovný pohled, nad 0,5 by
 * kamera mířila nahoru — to je platná matematika, ale svět by z ní vypadl, tak
 * se klopení nechá na nule. Zorný úhel mimo `(0, 180)` je vada volajícího a
 * padá zpátky na `FRAMING_FOV`.
 */
export function pitchForSky(skyShare: number, fovDegrees: number = FRAMING_FOV): number {
  const fov = Number.isFinite(fovDegrees) && fovDegrees > 0 && fovDegrees < 180 ? fovDegrees : FRAMING_FOV;
  const share = Number.isFinite(skyShare) ? Math.min(Math.max(skyShare, 0), 1) : SKY_SHARE;
  const tanPhi = Math.tan((fov / 2) * DEGREES);
  return Math.atan(Math.max(0, tanPhi * (1 - 2 * share)));
}

/** Podíl oblohy, který dané klopení vyrobí. Protějšek `pitchForSky`. */
export function skyShareForPitch(pitch: number, fovDegrees: number = FRAMING_FOV): number {
  const fov = Number.isFinite(fovDegrees) && fovDegrees > 0 && fovDegrees < 180 ? fovDegrees : FRAMING_FOV;
  const angle = Number.isFinite(pitch) ? pitch : 0;
  const tanPhi = Math.tan((fov / 2) * DEGREES);
  return Math.min(Math.max((1 - Math.tan(angle) / tanPhi) / 2, 0), 1);
}

/**
 * Obal, se kterým se dá počítat.
 *
 * Vrací i důvod, protože prázdná scéna a scéna zploštělá do roviny jsou dva
 * různé stavy a volající je musí umět rozlišit. Prohozené `min`/`max` se
 * srovnají místo odmítnutí — je to vada volajícího, ne důvod nenakreslit nic.
 */
function sanitize(bounds: Bounds | null | undefined): {
  center: Vec3;
  radius: number;
  corners: readonly Vec3[];
  fallback: FramingFallback;
} {
  if (bounds === undefined || bounds === null || !isFinitePoint(bounds.min) || !isFinitePoint(bounds.max)) {
    const center = { x: 0, y: 0, z: 0 };
    return { center, radius: MIN_RADIUS, corners: [center], fallback: 'empty' };
  }

  const low = {
    x: Math.min(bounds.min.x, bounds.max.x),
    y: Math.min(bounds.min.y, bounds.max.y),
    z: Math.min(bounds.min.z, bounds.max.z),
  };
  const high = {
    x: Math.max(bounds.min.x, bounds.max.x),
    y: Math.max(bounds.min.y, bounds.max.y),
    z: Math.max(bounds.min.z, bounds.max.z),
  };

  const center = { x: (low.x + high.x) / 2, y: (low.y + high.y) / 2, z: (low.z + high.z) / 2 };
  const half = { x: (high.x - low.x) / 2, y: (high.y - low.y) / 2, z: (high.z - low.z) / 2 };
  const diagonal = Math.hypot(half.x, half.y, half.z);
  const degenerate = half.x <= 0 || half.y <= 0 || half.z <= 0;

  const corners: Vec3[] = [];
  for (const x of [low.x, high.x]) {
    for (const y of [low.y, high.y]) {
      for (const z of [low.z, high.z]) corners.push({ x, y, z });
    }
  }

  return {
    center,
    radius: Math.max(diagonal, MIN_RADIUS),
    corners,
    fallback: degenerate ? 'degenerate' : null,
  };
}

/** Kamerová báze: kam se dívá, kde má pravou ruku a kde temeno. */
function basis(eye: Vec3, target: Vec3): { forward: Vec3; right: Vec3; up: Vec3 } {
  const dx = target.x - eye.x;
  const dy = target.y - eye.y;
  const dz = target.z - eye.z;
  const length = Math.hypot(dx, dy, dz) || 1;
  const forward = { x: dx / length, y: dy / length, z: dz / length };

  // `forward × (0, 1, 0)`. Klopení je vždycky hluboko pod 90°, takže se osa se
  // svislicí nesrovná a součin nevyjde nulový. Přesto se dělí délkou **nebo
  // jedničkou** — `Framing` si volající může sestavit i sám a svislý pohled by
  // jinak vyrobil `NaN` v každé složce.
  const rx = -forward.z;
  const rz = forward.x;
  const rl = Math.hypot(rx, rz) || 1;
  const right = { x: rx / rl, y: 0, z: rz / rl };

  const up = {
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x,
  };

  return { forward, right, up };
}

/**
 * Kam bod padne na snímku.
 *
 * Vrací souřadnice v podílu poloviny snímku: `0` je střed, `1` horní (resp.
 * pravá) hrana, `−1` spodní (levá). `behind` je `true` pro body za kamerou,
 * kde by podíl mlčky ukázal na opačnou stranu obrazu.
 *
 * Je to táž soustava, ve které se počítá obzor, takže se dá výsledek přímo
 * porovnat s `skyShare` i s `HERO_HEIGHT` — a proto to není pomocník testu, ale
 * vývozní funkce: test, který si projekci napíše sám, měří vlastní matematiku.
 */
export function project(
  point: Vec3,
  eye: Vec3,
  target: Vec3,
  fovDegrees: number = FRAMING_FOV,
  aspect: number = DEFAULT_ASPECT,
): { x: number; y: number; behind: boolean } {
  const { forward, right, up } = basis(eye, target);
  const vx = point.x - eye.x;
  const vy = point.y - eye.y;
  const vz = point.z - eye.z;

  const depth = vx * forward.x + vy * forward.y + vz * forward.z;
  if (!(depth > 0)) return { x: 0, y: 0, behind: true };

  const tanV = Math.tan((fovDegrees / 2) * DEGREES);
  const across = vx * right.x + vy * right.y + vz * right.z;
  const above = vx * up.x + vy * up.y + vz * up.z;

  return { x: across / (tanV * aspect * depth), y: above / (tanV * depth), behind: false };
}

/**
 * Je bod uvnitř jehlanu vidění? Přesná odpověď, ne odhad.
 *
 * Se `safeArea` se soudí proti **zúženému** jehlanu: bod schovaný za dokem je
 * sice v záběru kamery, ale porotce ho nevidí, a to je pro rámování totéž jako
 * kdyby vypadl ze snímku.
 */
export function insideFrustum(
  point: Vec3,
  eye: Vec3,
  target: Vec3,
  fovDegrees: number = FRAMING_FOV,
  aspect: number = DEFAULT_ASPECT,
  safeArea?: SafeArea,
): boolean {
  const at = project(point, eye, target, fovDegrees, aspect);
  return (
    !at.behind &&
    at.x >= -1 + 2 * cover(safeArea?.left) &&
    at.x <= 1 - 2 * cover(safeArea?.right) &&
    at.y >= -1 + 2 * cover(safeArea?.bottom) &&
    at.y <= 1
  );
}

/** Oko pro danou vzdálenost. Cíl leží nad hrdinou, oko za ním a nad ním. */
function seat(target: Vec3, distance: number, pitch: number, azimuth: number): Vec3 {
  const flat = distance * Math.cos(pitch);
  return {
    x: target.x + flat * Math.sin(azimuth),
    y: target.y + distance * Math.sin(pitch),
    z: target.z + flat * Math.cos(azimuth),
  };
}

export interface FrameSceneInput {
  /** Naměřený obal scény. `null` je platný vstup — prázdná scéna. */
  readonly bounds: Bounds | null;
  /**
   * Hlavní objekt. `null` znamená „scéna nemá hrdinu" a rámuje se na střed
   * obalu — to je poctivá odpověď, ne chybějící údaj.
   */
  readonly hero?: Vec3 | null;
  readonly aspect?: number;
  readonly fov?: number;
  readonly azimuth?: number;
  /** Kolik snímku má zabírat obloha. Výchozí `SKY_SHARE`. */
  readonly skyShare?: number;
  /** Optional inspection composition, in radians; defaults preserve outdoor framing. */
  readonly pitch?: number;
  /** Vertical fraction of the free viewport, measured from the bottom. */
  readonly heroHeight?: number;
  /**
   * Zakrytý podíl hran snímku. Bez něj se rámuje do celého okna, což je dodnes
   * platný vstup — `/dev/worldstream` ani sledovací kamera překryv nemají.
   */
  readonly safeArea?: SafeArea;
}

/**
 * Rámování ze scény.
 *
 * Nikdy nevrací `NaN` a nikdy nesází oko dovnitř obalu: nejmenší vzdálenost je
 * `max(MIN_DISTANCE, poloměr · rezerva)`, takže oko leží vždycky vně opsané
 * koule.
 */
export function frameScene(input: FrameSceneInput): Framing {
  const { center, radius, corners, fallback } = sanitize(input.bounds);

  const fovInput = input.fov;
  const fov =
    fovInput !== undefined && Number.isFinite(fovInput) && fovInput > 0 && fovInput < 180
      ? fovInput
      : FRAMING_FOV;
  const aspectInput = input.aspect;
  const aspect =
    aspectInput !== undefined && Number.isFinite(aspectInput) && aspectInput > 0
      ? aspectInput
      : DEFAULT_ASPECT;
  const azimuthInput = input.azimuth;
  const azimuth =
    azimuthInput !== undefined && Number.isFinite(azimuthInput) ? azimuthInput : DEFAULT_AZIMUTH;

  const bottom = cover(input.safeArea?.bottom);
  const left = cover(input.safeArea?.left);
  const right = cover(input.safeArea?.right);

  // Obzor drží zadaný podíl **volné plochy**, ne okna. Volná plocha sahá od
  // `−1 + 2·bottom` k `1`, takže obzor patří na `1 − 2·share·(1 − bottom)` — a
  // to je přesně `pitchForSky` se zmenšeným podílem. Vedlejším účinkem je právě
  // ten svislý posun, který dolní pruh vyžaduje: kamera klopí víc, obraz jde
  // nahoru. Při `bottom = 0` je součin s jedničkou přesný a klopení je dnešní.
  const pitch = input.pitch !== undefined && Number.isFinite(input.pitch)
    ? Math.max(0,Math.min(Math.PI * 0.42,input.pitch))
    : pitchForSky((input.skyShare ?? SKY_SHARE) * (1 - bottom), fov);
  const heroHeight = input.heroHeight !== undefined && Number.isFinite(input.heroHeight)
    ? Math.max(0.2,Math.min(0.8,input.heroHeight)) : HERO_HEIGHT;
  const hero = isFinitePoint(input.hero) ? input.hero : center;

  // Koule opsaná obalu je odhad startovní vzdálenosti, ne odpověď: osa pohledu
  // míří na zvednutý cíl, ne do středu, takže se odchylka osy přičítá.
  //
  // Poloúhly se krátí o zakrytý podíl, zorný úhel ne — kamera vidí dál, jen se
  // obal cpe do menšího obdélníku a startovní vzdálenost tomu musí odpovídat.
  // Osm kroků po 8 % (faktor 1,85) pak dorovná zbytek; samotné krácení by ho
  // u `0,3 / 0,25 / 0,25` nedohnalo.
  const tanV = Math.tan((fov / 2) * DEGREES);
  const halfAngle = Math.min(
    Math.atan(tanV * (1 - bottom)),
    Math.atan(tanV * aspect * (1 - left - right)),
  );
  let distance = Math.max(MIN_DISTANCE, (radius / Math.sin(halfAngle)) * FIT_MARGIN);

  // O kolik se zvedne cíl nad hrdinu, aby hrdina padl na `HERO_HEIGHT`.
  //
  // **Není to `D · tan(phi) · k`, i když to tak vypadá.** Zvednutí míří po
  // světové svislici, ne po svislici snímku, takže se hrdina zvednutím
  // nepatrně **přiblíží** ke kameře — o `lift · sin(pitch)`. Ten přírůstek
  // hloubky obraz zmenší, a hrdina skončí o 3,5 % výš, než měl. Naměřeno
  // 28. 8. 2026: `−0,3216` proti žádané `−1/3`.
  //
  // Rovnice `−lift · cos(pitch) / (tan(phi) · (D + lift · sin(pitch))) = −k` se
  // dá rozřešit přesně, a tohle je její kořen. Jmenovatel je vždycky kladný:
  // `k ≤ 1` a `tan(phi) · sin(pitch) < cos(pitch)` pro každý zorný úhel, který
  // sem projde.
  //
  // Třetina se měří ve volné ploše, ne v okně: žádaná výška hrdiny je
  // `−1 + 2·bottom + 2·HERO_HEIGHT·(1 − bottom)` a `drop` je její záporná
  // hodnota. Při `bottom = 0` se výraz vrací na `1 − 2·HERO_HEIGHT` bez jediného
  // zaokrouhlení (odečítá se nula). Při dolním pruhu 0,3 vyjde **záporný**, tedy
  // cíl klesne pod hrdinu — kamera už klopí tak, že by hrdina jinak vyjel nad
  // třetinu.
  const drop = 1 - 2 * bottom - 2 * heroHeight * (1 - bottom);
  const lift = (span: number): number =>
    (drop * tanV * span) / (Math.cos(pitch) - drop * tanV * Math.sin(pitch));

  // Vodorovně střed volné plochy sedí na `left − right`, takže se cíl posune
  // proti tomu — po ose `right` kamery, která je pro azimut `(cos, 0, −sin)`.
  // Souměrné sloupce dají nulu a cíl zůstane nad hrdinou jako dosud.
  const across = right - left;
  const place = (span: number): { target: Vec3; eye: Vec3 } => {
    const rise = lift(span);
    const side = across * tanV * aspect * (span + rise * Math.sin(pitch));
    const target = {
      x: hero.x + side * Math.cos(azimuth),
      y: hero.y + rise,
      z: hero.z - side * Math.sin(azimuth),
    };
    return { target, eye: seat(target, span, pitch, azimuth) };
  };

  let { target, eye } = place(distance);

  for (let attempt = 0; attempt < FIT_ATTEMPTS; attempt += 1) {
    if (
      corners.every((corner) => insideFrustum(corner, eye, target, fov, aspect, input.safeArea))
    ) {
      break;
    }
    distance *= FIT_STEP;
    ({ target, eye } = place(distance));
  }

  return {
    eye,
    target,
    fov,
    pitch,
    distance,
    skyShare: skyShareForPitch(pitch, fov),
    heroHeight,
    fallback,
  };
}

/**
 * Sedlo sledovací kamery.
 *
 * Sledovací kamera nesmí měnit vzdálenost podle obalu světa — `e2e/camera.spec.ts`
 * ji drží v pásmu 6–14 a měnící se vzdálenost by při každém kroku postavy
 * poskočila. Mění se **klopení**, a to se dá spočítat toutéž rovnicí obzoru:
 * odstup je dán vzdáleností a úhlem paprsku k hrdinovi, který je o odchylku
 * třetiny strmější než osa pohledu.
 *
 * Vrací zvlášť odstup a zvednutí cíle, protože kamera se má dívat nad postavu,
 * ne na ni — jinak by se osa vrátila k původnímu klopení a obzor by zase vyjel
 * z obrazu.
 */
export function followSeat(
  distance: number,
  fovDegrees: number = FRAMING_FOV,
  skyShare: number = SKY_SHARE,
): { offset: Vec3; lift: number; pitch: number } {
  const fov =
    Number.isFinite(fovDegrees) && fovDegrees > 0 && fovDegrees < 180 ? fovDegrees : FRAMING_FOV;
  const span = Number.isFinite(distance) && distance > 0 ? distance : MIN_DISTANCE;
  const pitch = pitchForSky(skyShare, fov);
  const tanV = Math.tan((fov / 2) * DEGREES);

  // Paprsek k hrdinovi klesá o odchylku třetiny pod osu pohledu. Obraz je
  // lineární v tangentě, takže se sčítají úhly, ne podíly.
  const heroDrop = Math.atan(tanV * (1 - 2 * HERO_HEIGHT));
  const rayPitch = pitch + heroDrop;

  const offset = { x: 0, y: span * Math.sin(rayPitch), z: span * Math.cos(rayPitch) };

  // Osa pohledu jde z oka na `hrdina + lift`. Aby klesala právě o `pitch`, musí
  // platit `(offset.y − lift) / offset.z = tan(pitch)`.
  return { offset, lift: offset.y - offset.z * Math.tan(pitch), pitch };
}
/** A seekable 20 s review path; camera-only, outside deterministic simulation state. */
export function referenceCameraAt(points: readonly (readonly [number, number, number])[], seconds: number): [number, number, number] {
  if (points.length < 2 || !Number.isFinite(seconds)) throw new Error('Invalid reference camera path');
  const t = Math.max(0, Math.min(20, seconds)) / 20 * (points.length - 1);
  const index = Math.min(points.length - 2, Math.floor(t));
  const fraction = t - index;
  const ease = fraction * fraction * (3 - 2 * fraction);
  return [0, 1, 2].map(axis => points[index][axis] + (points[index + 1][axis] - points[index][axis]) * ease) as [number, number, number];
}
