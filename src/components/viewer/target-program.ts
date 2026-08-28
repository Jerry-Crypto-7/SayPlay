import { GEOM_VERSION, type GeomNode, type GeomProgram } from '@/geom/program';

/**
 * Cílový snímek **jako program geometrie**, ne jako ruční 3D kód.
 *
 * ## Proč se první verze zahodila
 *
 * Snímek z 27. 8. 2026 byl 1132 řádků ručně psaného `three`: žebra jako trubky
 * natažené po Catmull-Rom křivce, sedm geometrií skládaných v komponentách.
 * Z produktového jazyka nepoužíval **ani jeden kus** — z kitu si bral jedinou
 * věc, paletu barev. Brána K0 se tím ptala na špatnou otázku: ne „dosáhne
 * produkt na tenhle svět?", ale „umí autor namalovat obrázek?".
 *
 * Shozený 28. 8. 2026 okem, a měl proč i technicky:
 * - **kostra bez páteře a lebky** se četla jako trup lodi — přiznává to komentář
 *   v tom souboru, což je samo o sobě verdikt,
 * - **skládání kusů umí věci, jejichž smysl je v uspořádání** (město, most,
 *   chrám), ne věci, jejichž smysl je v tvaru (kostra, tvor, strom). Námět byl
 *   vybraný proti technice, takže z něj vyšel vějíř trubek.
 *
 * ## Co je tenhle soubor
 *
 * Jedna deklarace `GeomProgram` — přesně ten dokument, který od vlny 2 emituje
 * model. Ručně napsaná zůstává (AC úlohy T2 to žádá: žádný model, žádné API),
 * ale je napsaná **ve slovníku, který produkt umí vyslovit**. Když snímek
 * projde bránou, je to důkaz o produktu, ne o autorovi.
 *
 * ## Námět: **maják na mořské skále, most z blízkého útesu**
 *
 * Vybraný podle toho, co kit doopravdy je: 42 dílů architektury — oblouky,
 * sloupy, stěny, střechy, rampy, zábradlí, lampy — a šest organických rekvizit.
 * Most, terasy a věž z toho vzniknou skládáním; kostra ne.
 *
 * Kompozice má jednu siluetu (věž), jednu vodicí čáru (most zprava dopředu),
 * jeden shluk drobné zástavby, který věži dává měřítko, a **prázdné místo** —
 * moře a obloha berou skoro polovinu plochy. Předchozí snímek prázdné místo
 * neměl vůbec a působil proto jako model ve vitríně.
 *
 * ## Měřítko
 *
 * Jednotka = jedno pole mřížky kitu. `panel.wall` je 1,6 vysoký = jedno patro,
 * takže **1 jednotka ≈ 2 m**. Dveře, schody a zábradlí jsou tím pádem lidského
 * rozměru a fungují v obraze jako měřítko — postavu program vložit neumí,
 * `actor` ve slovníku schválně není (rekvizity a postavy vkládá simulace, ne
 * výtvarný program).
 *
 * ## Velké hmoty vznikají opakováním, ne velkým měřítkem
 *
 * `scale` je ve schématu omezené na **8× buňku**. Útes ani skála se proto
 * nedají napsat jako jeden obří kvádr a skládají se z opakovaných bloků. Není
 * to obcházení stropu — je to omezení, ve kterém bude psát i model, a hrubší
 * hmota z několika bloků se v obraze čte líp než jedna hladká krabice.
 *
 * ## Rozpočet
 *
 * Umístěné kusy proti stropu `GEOM_LIMITS.maxInstances` = 120 a uzly proti
 * stropu 96 pinuje `__tests__/target-program.test.ts`. Strop kusů je zároveň
 * `maxDrawCallsPerWorld` z `src/kit/budgets.ts` — překročit ho znamená svět,
 * který se nevejde do kreslicích volání.
 */

/**
 * Semínka jednotlivých rozsetí. **Pevná, ne losovaná** — cílový snímek musí
 * mezi běhy vyjít stejně, jinak by `docs/target-frame.png` šuměl v každém
 * commitu a rozdíl v revizi by přestal něco znamenat.
 */
const SEED = {
  shelf: 90_331,
  rockTop: 12_889,
  farRidge: 20_477,
  farIslet: 88_150,
} as const;

/**
 * Kam přijde hrdinský objekt, až bude hotový sochař tvarů (vlna 1, úloha T4).
 *
 * Je to střed horní plochy podstavce v souřadnicích programu. Do té doby na tom
 * místě stojí prázdný podstavec — **prázdný schválně**: kompozice s vyhrazeným
 * místem je poctivější než kompozice, do které se hrdina potom vecpe násilím.
 */
export const HERO_SLOT = [-2.2, 2.7, -4.2] as const;

/** Střed podstavce. Slot leží nad ním, hrdina na něm stojí. */
const PLINTH_AT = [-2.2, 2.16, -4.2] as const;

/**
 * Tabulka uzlů se skládá **pojmenovanými indexy**, ne ručně psanými čísly.
 *
 * Potomek se v programu odkazuje indexem a scéna má přes šedesát uzlů; ručně
 * číslovaná tabulka se po každé úpravě kompozice musela celá přečíslovat a
 * jediná přehlédnutá změna by tiše připojila jiný podstrom. Výsledek je pořád
 * týž dokument — plochá tabulka, potomek vždycky s nižším indexem než rodič.
 */
function composeTarget(): GeomProgram {
  const nodes: GeomNode[] = [];
  const add = (node: GeomNode): number => nodes.push(node) - 1;

  // --- zem: mys pod kamerou a skála, na které maják stojí -------------------
  //
  // **Obojí je `terrain plateau`, ne kvádry — a je to oprava naměřené vady.**
  // První verze skládala pevninu z `mass.block` a `mass.bevel`. Ty se barví
  // swatchem `shell`, tedy touž hlínou jako zdi, a naměřený výsledek byl obraz
  // v jediné béžové hodnotě: skála, most i věž splynuly do jedné hmoty.
  // `plateau` se barví `deep`, tedy čedičem — pevnina je tmavá, stavba na ní
  // světlá a obraz konečně má hodnotovou stavbu.
  //
  // Vedlejší zisk: kupole místo kvádrů stojí **dva kusy místo devíti**.
  //
  // Že je výškové pole jednostranná plocha bez boků, tady nevadí: okraj klesá
  // k základně a základna leží **pod hladinou**, takže se pod ni nedá
  // podívat.
  const headland = add({
    kind: 'terrain',
    variant: 'plateau',
    extent: [30, 20],
    amplitude: 3.4,
    seed: SEED.shelf,
    at: [0, -3.6, 22],
  });
  // Vršek je rovný v okruhu poloviny poloměru, tedy `|x| < 5,5` a `z` od −10,5
  // do −1,5. Celá zástavba se drží uvnitř toho obdélníku, jinak by kusy
  // stály na svahu a plavaly.
  const rock = add({
    kind: 'terrain',
    variant: 'plateau',
    extent: [22, 18],
    amplitude: 6,
    seed: SEED.rockTop,
    at: [-2, -4.4, -6],
  });
  const ground = add({ kind: 'group', children: [headland, rock] });

  // --- most: mostovka, pilíře, zábradlí ------------------------------------
  //
  // Začíná na `z = 16`, kde má mys ještě 3 jednotky výšky, a končí na `z = 0`,
  // kde skála vystoupá přesně k úrovni mostovky. Obě čísla jsou spočítaná
  // z výškové funkce `plateau`, ne odhadnutá — most, který začíná ve vzduchu,
  // je nejnápadnější vada, jakou tahle scéna může mít.
  const deckSlab = add({ kind: 'panel', variant: 'floor', at: [0, 0.06, 16], scale: [2.8, 1.8, 1.1] });
  const deck = add({ kind: 'repeat', child: deckSlab, count: 16, step: [0, 0, -1.07] });
  // Oblouk stojí kolmo k mostu (`yaw: 1`), takže se z boku čte jako viadukt.
  // Výška je dopočítaná: vrchol sedí těsně pod mostovkou a pata mizí v hladině.
  const pierArch = add({
    kind: 'arch',
    variant: 'round',
    at: [0, -1.85, 14],
    yaw: 1,
    scale: [2.6, 2, 2.4],
  });
  const piers = add({ kind: 'repeat', child: pierArch, count: 4, step: [0, 0, -3.5] });
  const railSpan = add({
    kind: 'panel',
    variant: 'railing',
    at: [1.3, 0.62, 15.5],
    yaw: 1,
    scale: [2, 1, 1],
  });
  const railSide = add({ kind: 'repeat', child: railSpan, count: 8, step: [0, 0, -2] });
  const rails = add({ kind: 'mirror', child: railSide, axis: 'x', about: 0 });
  const bridge = add({ kind: 'group', children: [deck, piers, rails] });

  // --- schodiště z mostovky na plošinu -------------------------------------
  const stepBlock = add({
    kind: 'mass',
    variant: 'step',
    at: [0, 0.45, -0.6],
    scale: [2.4, 1.2, 1.2],
  });
  const stairs = add({ kind: 'repeat', child: stepBlock, count: 5, step: [0, 0.34, -0.7] });

  // --- brána na plošině ----------------------------------------------------
  const gateArch = add({
    kind: 'arch',
    variant: 'doorway',
    at: [0, 3.6, -4],
    scale: [2.2, 2.2, 2.2],
  });
  const gateTower = add({
    kind: 'mass',
    variant: 'block',
    at: [2.9, 3.4, -4],
    scale: [1.8, 3.6, 2.2],
  });
  const gateTowers = add({ kind: 'mirror', child: gateTower, axis: 'x', about: 0 });
  const gate = add({ kind: 'group', children: [gateArch, gateTowers] });

  // --- terasová zástavba vlevo od věže -------------------------------------
  const houseWall = add({
    kind: 'panel',
    variant: 'wall',
    at: [-6.4, 2.64, -7],
    scale: [1.3, 1.3, 1.2],
  });
  const houseWalls = add({ kind: 'repeat', child: houseWall, count: 5, step: [1.35, 0, 0] });
  const houseWindow = add({
    kind: 'panel',
    variant: 'window',
    at: [-6.4, 2.64, -6.4],
    scale: [1.25, 1.25, 1],
  });
  const houseWindows = add({ kind: 'repeat', child: houseWindow, count: 3, step: [2.7, 0, 0] });
  const houseRoof = add({
    kind: 'panel',
    variant: 'roof',
    at: [-6.4, 4.15, -7],
    scale: [1.4, 1.3, 1.5],
  });
  const houseRoofs = add({ kind: 'repeat', child: houseRoof, count: 5, step: [1.35, 0, 0] });
  const frontRow = add({ kind: 'group', children: [houseWalls, houseWindows, houseRoofs] });
  const wingBlock = add({ kind: 'mass', variant: 'block', at: [-4.5, 3.1, -9.6], scale: [7, 3, 4] });
  const wingRoof = add({
    kind: 'panel',
    variant: 'roof',
    at: [-6.5, 5.1, -9.6],
    scale: [1.6, 1.5, 2.4],
  });
  const wingRoofs = add({ kind: 'repeat', child: wingRoof, count: 5, step: [1.5, 0, 0] });
  const houses = add({ kind: 'group', children: [frontRow, wingBlock, wingRoofs] });

  // --- podloubí před zástavbou ---------------------------------------------
  const pillar = add({
    kind: 'column',
    variant: 'pillar',
    at: [-6.2, 2.8, -5.3],
    scale: [1, 1.2, 1],
  });
  const colonnade = add({ kind: 'repeat', child: pillar, count: 5, step: [1.4, 0, 0] });

  // --- věž majáku: jediná dominantní silueta -------------------------------
  const towerStorey = add({
    kind: 'mass',
    variant: 'block',
    at: [2.6, 2.9, -8.4],
    scale: [3, 2.6, 3],
  });
  const towerShaft = add({ kind: 'repeat', child: towerStorey, count: 3, step: [0, 2.5, 0] });
  const towerGallery = add({
    kind: 'mass',
    variant: 'block',
    at: [2.6, 10, -8.4],
    scale: [2.2, 1.6, 2.2],
  });
  const towerWindow = add({
    kind: 'panel',
    variant: 'window',
    at: [2.6, 3.7, -6.85],
    scale: [1.2, 1.2, 1],
  });
  const towerWindows = add({ kind: 'repeat', child: towerWindow, count: 3, step: [0, 2.5, 0] });
  const towerRoof = add({
    kind: 'panel',
    variant: 'roof',
    at: [2.6, 11.65, -8.4],
    scale: [2.6, 2.2, 2.6],
  });
  // Lampa. `arch.portal` je jediný kus, který nese `accent` jako celý prstenec,
  // takže je to nejjasnější bod obrazu — a stojí na vrcholu siluety, ne vedle.
  const lamp = add({
    kind: 'arch',
    variant: 'portal',
    at: [2.6, 12.9, -8.4],
    scale: [1.5, 1.5, 1.5],
  });
  const tower = add({
    kind: 'group',
    children: [towerShaft, towerGallery, towerWindows, towerRoof, lamp],
  });

  // --- podstavec pro hrdinský objekt (viz `HERO_SLOT`) ----------------------
  const plinth = add({
    kind: 'mass',
    variant: 'plinth',
    at: [...PLINTH_AT],
    scale: [2.2, 1.2, 2.2],
  });

  // --- porost a kameny: každý kus vlastním uzlem ---------------------------
  //
  // **`scatter` se tu použít nedá a stálo to jedno kolo měření.** Uzel otáčí
  // kopii o náhodnou čtvrtotáčku **kolem počátku světa**, ne kolem sebe, takže
  // se potomkovo vlastní `at` otočí spolu s ní: strom zapsaný na `x = −7`
  // skončil naměřeno na `x = +20`, keře z plošiny spadly do vody. Uzel počítá
  // s potomkem na ose (tak ho používají všechny čtyři výtvarné rodiny) a
  // shluk mimo počátek jím napsat nejde.
  //
  // Výšky nejsou odhadnuté: mys má rovný vršek na `y = −0,2`, plošina skály na
  // `y = 1,6` a hladina je na `−3,2`. Ke každé se přičítá polovina výšky kusu,
  // jinak by porost buď plaval, nebo se propadl.
  const plantAt: readonly (readonly [number, number, number])[] = [
    [-6.5, 1.5, 20.5],
    [-9.5, 1.5, 22.5],
    [-4.5, 1.5, 24],
    [6.5, 1.5, 21],
    [4.5, 1.5, 24.5],
  ];
  const trees = add({
    kind: 'group',
    children: plantAt.map((at) =>
      add({ kind: 'organic', variant: 'tree', at: [...at], scale: [1.6, 1.8, 1.6] }),
    ),
  });
  const shrubAt: readonly (readonly [number, number, number])[] = [
    [-6.8, 2.3, -3],
    [-5.5, 2.3, -9.5],
    [1, 2.3, -3.2],
    [2.6, 2.3, -10],
  ];
  const shrubs = add({
    kind: 'group',
    children: shrubAt.map((at) =>
      add({ kind: 'organic', variant: 'shrub', at: [...at], scale: [1.4, 1.4, 1.4] }),
    ),
  });
  const reedAt: readonly (readonly [number, number, number])[] = [
    [-9.5, -2.6, 6],
    [-8, -2.6, 3],
    [8.5, -2.6, 2],
  ];
  const reeds = add({
    kind: 'group',
    children: reedAt.map((at) =>
      add({ kind: 'organic', variant: 'reed', at: [...at], scale: [1.6, 2, 1.6] }),
    ),
  });
  const planting = add({ kind: 'group', children: [trees, shrubs, reeds] });

  // --- popředí: kameny v mělčině a zbytek staré brány na mysu --------------
  const boulderAt: readonly (readonly [number, number, number])[] = [
    [11.5, -3.4, 6.5],
    [14, -3.4, 2],
    [-9.5, -3.4, 1.5],
  ];
  const boulders = add({
    kind: 'group',
    children: boulderAt.map((at) =>
      add({ kind: 'organic', variant: 'boulder', at: [...at], scale: [2.6, 2.2, 2.6] }),
    ),
  });
  const ruin = add({ kind: 'column', variant: 'broken', at: [-8.5, 2.04, 17.5], scale: [2, 2, 2] });
  const foreground = add({ kind: 'group', children: [boulders, ruin] });

  // --- dálka: dvě skály na obzoru ------------------------------------------
  const farRidge = add({
    kind: 'terrain',
    variant: 'plateau',
    extent: [40, 20],
    amplitude: 7,
    seed: SEED.farRidge,
    at: [-30, -4, -40],
  });
  const farIslet = add({
    kind: 'terrain',
    variant: 'plateau',
    extent: [24, 14],
    amplitude: 4,
    seed: SEED.farIslet,
    at: [30, -4, -48],
  });
  const distance = add({ kind: 'group', children: [farRidge, farIslet] });

  const root = add({
    kind: 'group',
    children: [
      ground,
      bridge,
      stairs,
      gate,
      houses,
      colonnade,
      tower,
      plinth,
      planting,
      foreground,
      distance,
    ],
  });

  return { version: GEOM_VERSION, nodes, root };
}

/** Cílový snímek. Jedna instance — program je data, ne stav. */
export const TARGET_PROGRAM: GeomProgram = composeTarget();
