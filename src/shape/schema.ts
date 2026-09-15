/**
 * Brána `ShapeProgram` — jediné místo, kde se rozhoduje, jestli je program od
 * modelu přijatelný.
 *
 * Dělí se to na dvě poloviny ze stejného důvodu jako u `src/geom/program.ts`:
 *
 * 1. **Schéma** (`zod`) uhlídá tvar jednoho řádku — jméno uzlu, jeho pole
 *    a rozsah každého čísla. `.strict()` znamená, že pole navíc je chyba, ne
 *    ticho: model, který si vymyslí `radius2`, se to musí dozvědět.
 * 2. **Strukturální kontrola** uhlídá to, co schéma z jednoho řádku nevidí —
 *    kam ukazují indexy, jak je strom hluboký a kolik kopií z něj vyleze po
 *    rozvinutí polí.
 *
 * **Každé číslo je ohraničené z obou stran, a není to kvůli nekonečnu.**
 * Naměřeno 28. 8. 2026 mutací, která `extent` horní mez sebrala: sada zůstala
 * zelená, protože `z.number()` ve verzi 4 nekonečno **ani `NaN` sám nepustí**
 * (`plainInfinity: false`, `plainNaN: false`). Horní mez tedy nechrání před
 * nekonečnem — chrání před **konečným nesmyslem**: poloměr 10⁶ je platné číslo,
 * projde vyhodnocovačem i meshovačem a vyrobí tvar, který zabere celou mřížku
 * a v obraze z něj není nic. Obě vlastnosti drží vlastní test, aby se tenhle
 * omyl nemohl vrátit.
 *
 * **Odmítá se celý program, nikdy se neořezává.** Oříznutý program je jiný
 * program než ten, který model napsal, a ten rozdíl by se nikde neukázal —
 * porotce by viděl tvar, o kterém by panel tvrdil, že ho napsal model.
 * Sebeoprava (vlna 2 T12) místo toho dostane důvod a napíše program znovu.
 */

import { z } from 'zod';

import {
  ARRAY_KINDS,
  COMBINATION_KINDS,
  DEFORMATION_KINDS,
  MASK_KINDS,
  MAX_BOUNDS_VOLUME_RATIO,
  MAX_REPEATED_HERO_RATIO,
  MESH_DETAIL,
  PRIMITIVE_KINDS,
  SHAPE_LIMITS,
  TRANSFORM_KINDS,
  certainHulls,
  childIndicesOf,
  depths,
  evaluationCounts,
  instanceCounts,
  reachableFrom,
  type ShapeNode,
  type ShapeProgram,
} from './types';

/* ------------------------------------------------------------------ *
 * Ohraničené skaláry. Nic v programu nesmí být neohraničené.
 * ------------------------------------------------------------------ */

/** Souřadnice v souřadnicích tvaru, v metrech. */
const coordinate = z.number().min(-64).max(64);
const vector3 = z.tuple([coordinate, coordinate, coordinate]);

/** Rozměr tělesa. Nula není povolená — z nulového poloměru je díra, ne tvar. */
const extent = z.number().min(0.01).max(64);
const extent3 = z.tuple([extent, extent, extent]);

/** Úhel v radiánech. Volný, ale ne nekonečný — plných pět otáček stačí. */
const angle = z.number().min(-32).max(32);

/**
 * Násobek měřítka. Zdola 0,05, protože nula by ve vyhodnocovači dělila;
 * záporné číslo je zakázané, protože obrací normály a tvar se pak uvnitř
 * rozsvítí. Kdo chce převrátit, napíše `mirror`.
 */
const scaleFactor = z.number().min(0.05).max(20);
const scale3 = z.tuple([scaleFactor, scaleFactor, scaleFactor]);

/**
 * Plynulost kombinace. Ostrá hrana se píše **vynecháním** `k`, ne nulou:
 * polynomiální smooth-min dělí `k`, takže nula je `0/0` = `NaN` přesně na té
 * ploše, kvůli které se uzel píše. Táž kázeň jako `scaleFactor.min(0.05)`.
 */
const smoothness = z.number().gt(0).max(4);

/** Kolik kopií pole udělá. Součin přes celý strom hlídá `maxInstances`. */
const copyCount = z.int().min(2).max(64);

/**
 * Semínko šumu. Jediná PRNG projektu je `pure-rand` a bere celé číslo; rozsah
 * je kladný 32bitový, aby se nedalo emitovat semínko, které se v Node a
 * v prohlížeči zaokrouhlí jinak.
 */
const seedValue = z.int().min(0).max(2_147_483_647);

const nodeIndex = z.int().min(0).max(SHAPE_LIMITS.maxNodes - 1);

const axis = z.enum(['x', 'y', 'z']);

/**
 * Identifikátor. Uzavřená abeceda schválně: `shapeId` končí jako klíč v cache
 * i v registru reprezentací a `stableId` se objevuje ve vyrenderovaném HTML.
 * Model, který sem napíše celou větu, se to má dozvědět tady, ne až v DOM.
 */
export const SHAPE_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

const identifier = z
  .string()
  .min(1)
  .max(64)
  .regex(SHAPE_IDENTIFIER_PATTERN, 'identifier must start alphanumerically');

/* ------------------------------------------------------------------ *
 * Primitiva.
 * ------------------------------------------------------------------ */

const sphereNode = z.object({ kind: z.literal('sphere'), radius: extent }).strict();
const boxNode = z.object({ kind: z.literal('box'), size: extent3 }).strict();
const roundBoxNode = z
  .object({ kind: z.literal('roundBox'), size: extent3, radius: extent })
  .strict();
const capsuleNode = z
  .object({ kind: z.literal('capsule'), height: extent, radius: extent })
  .strict();
const cylinderNode = z
  .object({ kind: z.literal('cylinder'), height: extent, radius: extent })
  .strict();
const coneNode = z.object({ kind: z.literal('cone'), height: extent, radius: extent }).strict();
const torusNode = z
  .object({ kind: z.literal('torus'), majorRadius: extent, minorRadius: extent })
  .strict();
const planeNode = z
  .object({ kind: z.literal('plane'), normal: vector3, offset: coordinate })
  .strict();
const prismNode = z
  .object({
    kind: z.literal('prism'),
    sides: z.int().min(3).max(12),
    radius: extent,
    height: extent,
  })
  .strict();
const ellipsoidNode = z.object({ kind: z.literal('ellipsoid'), radii: extent3 }).strict();

/* ------------------------------------------------------------------ *
 * Kombinace.
 * ------------------------------------------------------------------ */

const combinationChildren = z.array(nodeIndex).min(2).max(8);

const unionNode = z
  .object({ kind: z.literal('union'), children: combinationChildren, k: smoothness.optional() })
  .strict();
const subtractNode = z
  .object({ kind: z.literal('subtract'), children: combinationChildren, k: smoothness.optional() })
  .strict();
const intersectNode = z
  .object({ kind: z.literal('intersect'), children: combinationChildren, k: smoothness.optional() })
  .strict();

/* ------------------------------------------------------------------ *
 * Transformace.
 * ------------------------------------------------------------------ */

const translateNode = z
  .object({ kind: z.literal('translate'), child: nodeIndex, offset: vector3 })
  .strict();
const rotateNode = z
  .object({
    kind: z.literal('rotate'),
    child: nodeIndex,
    yaw: angle,
    pitch: angle,
    roll: angle,
  })
  .strict();
const scaleNode = z
  .object({ kind: z.literal('scale'), child: nodeIndex, factor: scale3 })
  .strict();
const mirrorNode = z
  .object({
    kind: z.literal('mirror'),
    child: nodeIndex,
    axis,
    about: coordinate.optional(),
  })
  .strict();

/* ------------------------------------------------------------------ *
 * Deformace.
 * ------------------------------------------------------------------ */

const twistNode = z
  .object({
    kind: z.literal('twist'),
    child: nodeIndex,
    axis,
    radiansPerUnit: z.number().min(-8).max(8),
  })
  .strict();
const bendNode = z
  .object({
    kind: z.literal('bend'),
    child: nodeIndex,
    axis,
    curvature: z.number().min(-8).max(8),
  })
  .strict();
const taperNode = z
  .object({
    kind: z.literal('taper'),
    child: nodeIndex,
    axis,
    amount: z.number().min(-4).max(4),
  })
  .strict();
const displaceNode = z
  .object({
    kind: z.literal('displace'),
    child: nodeIndex,
    amplitude: z.number().min(0).max(8),
    frequency: z.number().min(0.01).max(16),
    seed: seedValue,
  })
  .strict();

/**
 * `sweep` je **celý** úhel výseku, ne polovina: `2π` uzavřený prstenec,
 * `π` klenba. Dolní mez 0,05 rad je asi 3° — pod tím už výsek není oblouk,
 * ale plátek, který mřížka 48³ stejně nezachytí.
 *
 * `radius` je `extent`, tedy nejméně 0,01: profil **na ose** (`radius = 0`)
 * by se sám protínal a vzdálenostní pole by kolem osy dalo nesmysl.
 */
const revolveNode = z
  .object({
    kind: z.literal('revolve'),
    child: nodeIndex,
    axis,
    radius: extent,
    sweep: z.number().min(0.05).max(Math.PI * 2),
  })
  .strict();

/* ------------------------------------------------------------------ *
 * Pole a maskování.
 * ------------------------------------------------------------------ */

const repeatNode = z
  .object({ kind: z.literal('repeat'), child: nodeIndex, count: copyCount, step: vector3 })
  .strict();
const radialArrayNode = z
  .object({
    kind: z.literal('radialArray'),
    child: nodeIndex,
    count: copyCount,
    axis,
    radius: extent,
  })
  .strict();
const arrayAlongCurveNode = z
  .object({
    kind: z.literal('arrayAlongCurve'),
    child: nodeIndex,
    count: copyCount,
    points: z.array(vector3).min(2).max(SHAPE_LIMITS.maxCurvePoints),
  })
  .strict();

const clipRegion = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('halfSpace'), normal: vector3, offset: coordinate }).strict(),
  z.object({ kind: z.literal('box'), center: vector3, size: extent3 }).strict(),
]);

const clipNode = z
  .object({ kind: z.literal('clip'), child: nodeIndex, region: clipRegion })
  .strict();

export const shapeNodeSchema = z.discriminatedUnion('kind', [
  sphereNode,
  boxNode,
  roundBoxNode,
  capsuleNode,
  cylinderNode,
  coneNode,
  torusNode,
  planeNode,
  prismNode,
  ellipsoidNode,
  unionNode,
  subtractNode,
  intersectNode,
  translateNode,
  rotateNode,
  scaleNode,
  mirrorNode,
  twistNode,
  bendNode,
  taperNode,
  displaceNode,
  revolveNode,
  repeatNode,
  radialArrayNode,
  arrayAlongCurveNode,
  clipNode,
]);

const boundsSchema = z.object({ min: vector3, max: vector3 }).strict();

const anchorSchema = z
  .object({
    name: identifier.max(32),
    at: vector3,
    normal: vector3.optional(),
  })
  .strict();

export const shapeProgramSchema = z
  .object({
    shapeId: identifier,
    stableId: identifier,
    nodes: z.array(shapeNodeSchema).min(1).max(SHAPE_LIMITS.maxNodes),
    root: nodeIndex,
    targetBounds: boundsSchema,
    anchors: z.array(anchorSchema).max(16),
    materialIntent: identifier,
    priority: z.int().min(0).max(100),
  })
  .strict();

export interface ShapeValidation {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/**
 * Nejmenší délka vektoru, se kterou se dá dál počítat.
 *
 * Je to **délka, ne rovnost s nulou**, a rozhodlo o tom nezávislé review:
 * `normal: [1e-200, 0, 0]` není nulový vektor, ale `x * x` v druhé mocnině
 * podteče na nulu, odmocnina je nula, dělení jí dá nekonečno a součin
 * `Infinity * 0` je `NaN`. Práh je zároveň nejmenší rozměr, který schéma
 * u těles vůbec pustí (`extent`), takže nezakazuje nic použitelného.
 */
const MIN_VECTOR_LENGTH = 0.01;

function isTooShort(vector: readonly number[]): boolean {
  return Math.hypot(...vector) < MIN_VECTOR_LENGTH;
}

/**
 * To, co schéma z jednoho řádku nevidí: kam míří indexy, jak hluboký je strom,
 * kolik kopií z něj vyleze a jestli je kvádr kvádr.
 *
 * Vrací **všechny** nálezy, ne první — program se odmítá s důvodem, ze kterého
 * jde napsat lepší, a jeden důvod po druhém by znamenal tolik kol sebeopravy,
 * kolik je v programu chyb.
 */
/**
 * **Program smí přetéct kvádr, který si sám deklaruje — a tohle to změří.**
 *
 * Počítá se **uvnitř souřadnic tvaru**. `targetBounds` a kvádr placementu jsou
 * dvě různé věci — první je v souřadnicích tvaru, druhý ve světových a potrubí
 * mezi nimi normalizuje — takže srovnávat je proti sobě by byla vada, ne kontrola.
 *
 * `null` znamená **nic netvrdím**: obal se nedal spočítat (viz `certainHulls`),
 * nebo je přesah pod prahem. Odmítá se jen to, co je jisté.
 *
 * ## Práh je objem, ne přesah po ose — přeměřeno 7. 9. 2026 (`T14r-shapebounds`)
 *
 * Do té úlohy stačil přesah po **kterékoli ose** a brána odmítla celý blueprint.
 * Naměřeno nad prvním živým během (deset tvarů, které padly výhradně na tomhle):
 * **devět z deseti se vymeshuje a padne do své krabice** — naměřené rozpětí je
 * v rozmezí jednotek procent kolem zadaného, největší přesah 4,7 %. Brána tedy
 * odmítala podle **konzervativního statického obalu**, ne podle toho, co
 * doopravdy vyleze, a stála šest vět z třiceti.
 *
 * Desátý (`chessBoardShape`) vrátí **prázdný mesh** — a přesně proti tomu tahle
 * kontrola vznikla. Jenže na to má meshovač vlastní detektor **na výsledku**,
 * který vrátí pojmenovaný důvod; tenhle byl jeho odhadem předem. Je to táž
 * doktrína, kterou si `mesh-worker.ts` i `mesh-gate.ts` píšou samy: chraň
 * **výstup**, ne odhad vstupu.
 *
 * Zůstává proto jediné, co se z obalu tvrdit dá jistě: program, který si
 * krabice **nevšímá vůbec**. Práh je `MAX_BOUNDS_VOLUME_RATIO`, tedy tentýž,
 * kterým měří naměřený mesh `mesh-gate.ts`. Naměřená desítka leží mezi 0,026×
 * a 1,9×, tedy celá pod ním; koule o poloměru 5 v krabici ±0,7 je 364×.
 *
 * Hláška nese poměr **i osy**: poměr proto, aby z ní šla napsat opravná věta
 * („přetéká" bez čísla nedává model, o kolik má ubrat), osy proto, že tvar
 * posunutý ven může mít objem menší než krabice a přesto z ní čouhat.
 */
function boundsIssue(
  nodes: readonly ShapeNode[],
  root: number,
  target: { min: readonly number[]; max: readonly number[] },
): string | null {
  const hull = certainHulls(nodes)[root];
  if (hull === null) return null;

  const AXES = ['x', 'y', 'z'] as const;
  const over = AXES.filter(
    (_name, axis) => hull.min[axis] < target.min[axis] || hull.max[axis] > target.max[axis],
  );
  if (over.length === 0) return null;

  const volume = (min: readonly number[], max: readonly number[]) =>
    (max[0] - min[0]) * (max[1] - min[1]) * (max[2] - min[2]);
  const ratio = volume(hull.min, hull.max) / volume(target.min, target.max);
  // **Jediná brána téhle funkce.** Nad prahem je poměr vždycky větší než jedna,
  // takže se smí zaokrouhlit na desetinu; do `T14r-shapebounds` sem doléhaly
  // i poměry pod jedničkou a `toFixed(1)` z nich dělalo „0.0×", tedy větu
  // „tvar je nulový" o tvaru, který jen ležel jinde.
  if (ratio <= MAX_BOUNDS_VOLUME_RATIO) return null;

  return (
    `shape overflows its own targetBounds on ${over.join(', ')}: ` +
    `generated bounds were ${ratio.toFixed(1)}× the requested volume`
  );
}

/**
 * Kolikrát objednaná krabice přerůstá to, co se v ní opakuje.
 *
 * ## Co se tím chytá — naměřeno 14. 9. 2026 nad případem c07
 *
 * `gpt-6-astra` napsala „les, kde stromy jsou hrudní koše" jako **jeden**
 * hrdinský tvar: uzly 0–17 jsou jeden strom o 5,3 m se žebry `torus`
 * `minorRadius` **0,15 m**, a teprve uzly 19–20 ho zopakují 3× a 2×. Tím
 * `targetBounds` naroste na **14,5 m**. Mřížka je ale pevná (`MESH_DETAIL`,
 * hrubá 32³), takže buňka měří 14,5/32 = **45 cm** — třikrát víc než žebro.
 * Šest stromů se rozpadne na drobky, zatímco týž strom sám v krabici 5,3 m má
 * buňku 17 cm a vymeshuje se celý.
 *
 * **Opakování tedy platí rozlišením, a platí se za něj zbytečně** — kopie
 * hrdiny patří do kompozice `GeomProgram`, kde je každá vlastním umístěním
 * jediného meshe (a `createCachedMeshClient` je proto mešuje jen jednou).
 *
 * ## Proč práh 2,0 a proč to nic jiného nezasáhne
 *
 * Přeměřeno nad 62 tvary tří archivů (`create-raw.json`, `authored-worlds.json`
 * a galerie kvality): **pole u kořene mají tři** a poměr krabice k jednotce
 * vychází **2,90× (`hangingHouses`), 2,52× (`ribcageTrees`, tedy c07) a 1,01×
 * (`sortingChutes`)**. Nad 3,0× není žádný. Mezi 1,01 a 2,52 je tedy prázdno
 * a práh 2,0 leží v něm — není naladěný na jeden vzorek, jen ho nemá kam
 * minout. Zbylých 59 tvarů pole u kořene nemá a tahle kontrola o nich mlčí.
 * `hangingHouses` je uvařený svět „bridge town"; 15. 9. 2026 se přeautoroval
 * na tři domy místo pěti, aby bránou prošel.
 *
 * ⚠ **Nezaměňovat s `boundsIssue`.** Ta soudí tvar, který si krabice nevšímá;
 * tahle soudí krabici, která je správně velká na to, co se do ní napsalo, jen
 * se do ní napsalo něco, co tam nepatří. `hullOf` navíc `repeat` ani
 * `radialArray` neumí, takže u těchhle tvarů vrací `certainHulls` u kořene
 * `null` a `boundsIssue` na nich mlčí — tohle není druhá kontrola téhož.
 *
 * `null` znamená nic netvrdím: u kořene žádné pole není, nebo se obal jednotky
 * nedal spočítat, nebo je poměr pod prahem.
 */
function repeatedHeroIssue(
  nodes: readonly ShapeNode[],
  root: number,
  target: { min: readonly number[]; max: readonly number[] },
): string | null {
  // Sestup od kořene přes pole a přes uzly, které jen posunou celek. Zastav se
  // na prvním uzlu, který doopravdy tvoří tvar.
  //
  // **`scale` cestou dolů se násobí do jednotky** (revize před `/ship`
  // 15. 9. 2026, `ship-shapescale`). Obal jednotky je v souřadnicích pod
  // všemi `scale`, krabice nad nimi — bez násobku z tvaru v `scale 2`
  // s dvojnásobnou krabicí vyšel poměr dvakrát větší a odmítl se, zatímco
  // bez obalu prošel. Činitele se násobí po osách; `rotate` mezi nimi osy
  // prohodí a tady se nesleduje, takže u nerovnoměrného `scale` nad
  // otočením je poměr jen odhad.
  let unit = root;
  let copies = 1;
  const scale = [1, 1, 1];
  for (;;) {
    const node = nodes[unit];
    if (node === undefined) return null;
    const arrayed = (ARRAY_KINDS as readonly string[]).includes(node.kind);
    if (!arrayed && !(TRANSFORM_KINDS as readonly string[]).includes(node.kind)) break;
    if (arrayed && 'count' in node) copies *= node.count;
    if (node.kind === 'scale') node.factor.forEach((factor, axis) => { scale[axis] *= factor; });
    unit = (node as { child: number }).child;
  }
  if (copies < 2) return null;

  const hull = certainHulls(nodes)[unit];
  if (hull === null) return null;

  const longest = (min: readonly number[], max: readonly number[]) =>
    Math.max(max[0] - min[0], max[1] - min[1], max[2] - min[2]);
  const unitSide = Math.max(...[0, 1, 2].map((axis) => (hull.max[axis] - hull.min[axis]) * scale[axis]));
  if (unitSide <= 0) return null;
  const ratio = longest(target.min, target.max) / unitSide;
  if (ratio < MAX_REPEATED_HERO_RATIO) return null;

  // Hláška nese obě čísla i buňku, protože bez nich model neví, co zmenšit:
  // „je to moc velké" se dá splnit i zmenšením žeber, což je přesně ta ztráta,
  // které se vyhýbáme.
  const cell = longest(target.min, target.max) / MESH_DETAIL.rough.resolution;
  return (
    `shape repeats one ${unitSide.toFixed(1)} m unit ${copies} times, so targetBounds is ` +
    `${ratio.toFixed(1)}× that unit and the mesh grid gives it ${(cell * 100).toFixed(0)} cm cells. ` +
    `Write the unit once, sized to its own targetBounds, and place the ${copies} copies in the ` +
    `composition instead`
  );
}

function structuralIssues(program: z.infer<typeof shapeProgramSchema>): string[] {
  const issues: string[] = [];
  const fail = (message: string) => issues.push(message);

  if (program.root >= program.nodes.length) {
    fail(`root references node ${program.root} outside the table of ${program.nodes.length}`);
  }

  program.nodes.forEach((node, index) => {
    for (const child of childIndicesOf(node)) {
      // **Vzájemně výlučné, a v tomhle pořadí.** Index potomka mimo tabulku je
      // vždycky ≥ index vlastního řádku, protože ten je z definice menší než
      // délka tabulky — obrácené pořadí proto nechá hlášku o tabulce u potomka
      // navždy mrtvou a model dostane do sebeopravy „posuň ho pod sebe" i tam,
      // kde je vada „ukazuje na řádek, který neexistuje". To jsou dvě různé
      // opravy. U kořene je kontrola jen jedna, protože kořen vlastní index
      // nemá; tahle výlučnost se ho netýká.
      if (child >= program.nodes.length) {
        fail(`node ${index} references node ${child} outside the table of ${program.nodes.length}`);
      } else if (child >= index) {
        fail(`node ${index} references node ${child} at or above itself`);
      }
    }
    if (node.kind === 'plane' && isTooShort(node.normal)) {
      fail(`node ${index} is a plane with a zero normal`);
    }
    if (node.kind === 'clip' && node.region.kind === 'halfSpace' && isTooShort(node.region.normal)) {
      fail(`node ${index} clips against a half space with a zero normal`);
    }
    // Doménové opakování dělí krokem. Nulový krok je dělení nulou přes celou
    // mřížku, a smyčková varianta zaplatí `count` vyhodnocení za jednu kouli.
    if (node.kind === 'repeat' && isTooShort(node.step)) {
      fail(`node ${index} repeats with a step of no length`);
    }
    // Splývající kontrolní body dají křivku nulové délky a s ní nulovou tečnu,
    // ze které se normalizací stane `NaN` pozice všech kopií.
    if (node.kind === 'arrayAlongCurve') {
      const stuck = node.points.findIndex(
        (point, at) =>
          at > 0 &&
          isTooShort([
            point[0] - node.points[at - 1][0],
            point[1] - node.points[at - 1][1],
            point[2] - node.points[at - 1][2],
          ]),
      );
      if (stuck > 0) fail(`node ${index} has curve points ${stuck - 1} and ${stuck} on top of each other`);
    }
  });

  // Rovnost se odmítá spolu s obrácením, a je to oprava po review: podle
  // `targetBounds` potrubí tvar normalizuje a mřížkuje, takže plochý kvádr
  // (`min[1] === max[1]`, naprosto pravděpodobná emise pro list nebo desku)
  // dá krok buňky `(max - min) / N = 0`, dělení nulou a prázdný mesh.
  const [minX, minY, minZ] = program.targetBounds.min;
  const [maxX, maxY, maxZ] = program.targetBounds.max;
  if (minX >= maxX || minY >= maxY || minZ >= maxZ) {
    fail('targetBounds is flat or inverted on at least one axis');
  }

  const anchorNames = new Set<string>();
  for (const anchor of program.anchors) {
    if (anchorNames.has(anchor.name)) fail(`anchor ${anchor.name} is declared twice`);
    anchorNames.add(anchor.name);
  }

  // Rozpočty se počítají až nad neporušenou tabulkou. Nad cyklem nebo nad
  // odkazem mimo tabulku by `instanceCounts` i `depths` četly `undefined`
  // a vyrobily `NaN`, ze kterého se hlášku napsat nedá.
  if (issues.length > 0) return issues;

  const nodes = program.nodes as readonly ShapeNode[];

  // Mrtvý řádek se odmítá, ne přehlíží. Rozpočty se čtou z `[root]`, takže
  // uzel mimo strom je z nich vynechaný — a než se tahle kontrola přidala,
  // tvrdil komentář u `depths`, že se takový řádek „řeší jinde".
  const reached = reachableFrom(nodes, program.root);
  const orphans = nodes.map((_node, index) => index).filter((index) => !reached.has(index));
  if (orphans.length > 0) {
    fail(`nodes ${orphans.join(', ')} cannot be reached from root ${program.root}`);
  }

  const depth = depths(nodes)[program.root];
  if (depth > SHAPE_LIMITS.maxDepth) {
    fail(`program is ${depth} nodes deep, above maxDepth ${SHAPE_LIMITS.maxDepth}`);
  }

  const expanded = instanceCounts(nodes)[program.root];
  if (expanded > SHAPE_LIMITS.maxInstances) {
    fail(
      `program expands to ${expanded} copies, above maxInstances ${SHAPE_LIMITS.maxInstances}`,
    );
  }

  const evaluations = evaluationCounts(nodes)[program.root];
  if (evaluations > SHAPE_LIMITS.maxEvaluations) {
    fail(
      `program costs ${evaluations} evaluations per cell, above maxEvaluations ${SHAPE_LIMITS.maxEvaluations}`,
    );
  }

  const overflow = boundsIssue(nodes, program.root, program.targetBounds);
  if (overflow !== null) fail(overflow);

  const repeated = repeatedHeroIssue(nodes, program.root, program.targetBounds);
  if (repeated !== null) fail(repeated);

  return issues;
}

export function validateShapeProgram(input: unknown): ShapeValidation {
  const parsed = shapeProgramSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `schema:/${issue.path.join('/')}: ${issue.message}`),
    };
  }

  const issues = structuralIssues(parsed.data);
  return { ok: issues.length === 0, issues };
}

/**
 * Přijme neznámý vstup, nebo vyhodí s pojmenovaným důvodem. Tudy vede **emisní
 * cesta** — tvar přišel zvenčí a ještě není `ShapeProgram`.
 *
 * **Meshovač tuhle funkci nevolá.** Do 30. 8. 2026 tu stálo, že „meshovač bere
 * jen tenhle vstup", a nebyla to pravda: `mesh-worker.ts` ji nevolal a program
 * s odkazem mimo tabulku prošel až do pole. Worker dnes volá
 * `validateShapeProgram()` sám, protože potřebuje **seznam vad**, ne výjimku —
 * ten seznam je vstup sebeopravy. Brána je táž, liší se jen odpověď.
 *
 * Návratový typ je ručně psaný `ShapeProgram` z `types.ts`, ne `z.infer`.
 * Je to jediná pojistka proti tomu, aby se schéma a kontrakt, který čte worker,
 * rozešly: kdyby schéma začalo propouštět uzel, o kterém `ShapeProgram` neví,
 * neprojde tenhle soubor přes `tsc`.
 */
export function parseShapeProgram(input: unknown): ShapeProgram {
  const validation = validateShapeProgram(input);
  if (!validation.ok) throw new Error(`invalid shape program: ${validation.issues.join('; ')}`);
  return shapeProgramSchema.parse(input);
}

/**
 * Slovník, který schéma doopravdy zná. Čte se z discriminated union, ne
 * z ručního seznamu — test tím drží připnuté, že `SHAPE_NODE_KINDS` v
 * `types.ts` a tenhle soubor mluví o týchž uzlech.
 */
export const SCHEMA_NODE_KINDS: readonly string[] = shapeNodeSchema.options.map(
  (option) => option.shape.kind.value as string,
);

/** Skupiny slovníku, jak je definuje design book §7.2. Pro test i pro UI. */
export const SHAPE_NODE_GROUPS = {
  primitive: PRIMITIVE_KINDS,
  combination: COMBINATION_KINDS,
  transform: TRANSFORM_KINDS,
  deformation: DEFORMATION_KINDS,
  array: ARRAY_KINDS,
  mask: MASK_KINDS,
} as const;
