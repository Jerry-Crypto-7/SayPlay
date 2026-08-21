import { z } from 'zod';

/**
 * Druhá větev mezijazyka: **program geometrie**.
 *
 * První větev (`src/ir`) říká, co svět dělá. Tahle říká, jak vypadá. Model
 * nepíše kód ani volání `three` — emituje tenhle dokument a ručně psaný
 * kompilátor (`src/geom/compile.ts`) z něj postaví `BufferGeometry`.
 *
 * **Tvar je opsaný z `world-ir-v1` schválně.** Plochá tabulka uzlů, potomek je
 * index, ne vnořený objekt. Tím pádem tu není jediné rekurzivní odkázání,
 * `cycles: "throw"` nemá na co narazit a kompilátor je průchod odspodu nahoru
 * bez rekurze. Model, který se naučil psát jednu větev, píše druhou stejně.
 *
 * **Slovník tvarů je slovník kitu, ne druhý systém.** `mass`, `column`, `arch`,
 * `panel` a `organic` jsou kategorie z `src/kit/pieces/**` a jejich `variant`
 * je přesně ta část `Piece.id` za tečkou. `program.test.ts` to drží připnuté
 * ke `KIT`, takže přidaný kus se buď objeví tady, nebo spadne test. Jediná
 * kategorie navíc je `terrain` — zem, pro kterou kit kus nemá.
 *
 * **Kategorie `fixture` a `actor` v programu záměrně nejsou.** Rekvizity a
 * postavy do světa vkládá simulace přes `src/ir`, ne výtvarný program; kdyby
 * je uměly obě větve, přestalo by být jednoznačné, kdo je vlastní.
 *
 * Tenhle soubor **neimportuje `three`** — stejná kázeň jako `src/kit/layouts`.
 * Schéma se musí dát ověřit i tam, kde renderer není: v Node, ve fallbacku a
 * v ověřovači.
 */

export const GEOM_VERSION = 'geom-program-v1';

/**
 * Stropy programu.
 *
 * - `maxNodes` **64** — kolik řádků tabulky model napíše. Dost na budovu
 *   složenou z opakovaných částí, málo na to, aby se emise rozutekla.
 * - `maxInstances` **120** — kolik umístěných kusů z programu **vyleze po
 *   rozvinutí** operací. Není to nový rozpočet: je to `maxDrawCallsPerWorld`
 *   z `src/kit/budgets.ts`, kde jeden umístěný kus = jeden draw call. Test tu
 *   rovnost hlídá, aby se obě čísla nerozešla. `maxNodes` sám o sobě nic
 *   nechrání — `repeat` 16 nad `scatter` 24 je 384 kusů ze dvou řádků.
 */
export const GEOM_LIMITS = {
  maxNodes: 64,
  maxInstances: 120,
} as const;

/** Kategorie kitu, které program umí postavit. Pořadí = pořadí v `KIT`. */
export const MASS_VARIANTS = ['block', 'wedge', 'step', 'plinth', 'stack', 'bevel'] as const;
export const COLUMN_VARIANTS = ['pillar', 'capital', 'fluted', 'post', 'twisted', 'broken'] as const;
export const ARCH_VARIANTS = ['round', 'flat', 'doorway', 'portal', 'buttress'] as const;
export const PANEL_VARIANTS = ['wall', 'half', 'floor', 'ramp', 'railing', 'window', 'roof'] as const;
export const ORGANIC_VARIANTS = ['pebble', 'boulder', 'cluster', 'shrub', 'tree', 'reed'] as const;

/** Zem. Jediný tvar, který nemá kus v kitu — generuje se výškovým polem. */
export const TERRAIN_VARIANTS = ['flat', 'ridge', 'basin', 'plateau'] as const;

/**
 * Kategorie → varianty, **jen pro ty, které mají kus v kitu**. `terrain` tu
 * schválně chybí; test podle téhle mapy porovnává slovník s `KIT`.
 */
export const PIECE_VARIANTS = {
  mass: MASS_VARIANTS,
  column: COLUMN_VARIANTS,
  arch: ARCH_VARIANTS,
  panel: PANEL_VARIANTS,
  organic: ORGANIC_VARIANTS,
} as const;

export type PieceKind = keyof typeof PIECE_VARIANTS;

export const SHAPE_KINDS = ['mass', 'column', 'arch', 'panel', 'organic', 'terrain'] as const;

/**
 * Operace nad tvary.
 *
 * **`group` v zadání P11 T8 není a je tu dopsaný vědomě.** Zbylé čtyři operace
 * berou právě jednoho potomka, takže bez sjednocení má program jedinou větev
 * a nedá se z něj postavit svět, kde vedle sebe stojí zem, budova a stromy —
 * což je přesně to, co po kompilátoru chce T9 i výtvarné rodiny v T10. Je to
 * sjednocení scény, ne nový slovník tvarů.
 */
export const OPERATION_KINDS = ['group', 'repeat', 'mirror', 'carve', 'scatter'] as const;

/** Z uzlu kitu na `Piece.id`. Kompilátor si tím sahá do `pieceById`. */
export function pieceIdOf(kind: PieceKind, variant: string): string {
  return `${kind}.${variant}`;
}

// Souřadnice světa v jednotkách mřížky kitu (1 = jedno pole). Ohraničené na
// obě strany, aby žádný parametr nemohl přijít jako nekonečno ani jako číslo,
// které kompilátor ještě přijme a kamera už neuvidí.
const coordinate = z.number().min(-64).max(64);
const vector3 = z.tuple([coordinate, coordinate, coordinate]);

const scaleFactor = z.number().min(0.1).max(8);
const scale3 = z.tuple([scaleFactor, scaleFactor, scaleFactor]);

const span = z.number().min(0.1).max(64);

/** Otočení kolem osy Y ve čtvrtinách otáčky — táž jednotka jako `Placement.yaw`. */
const yawTurns = z.int().min(0).max(3);

const nodeIndex = z.int().min(0).max(GEOM_LIMITS.maxNodes - 1);

// Jediná PRNG projektu je `pure-rand` a bere celočíselné semínko. Rozsah je
// kladný 32bitový, aby se nedalo emitovat semínko, které se v Node a
// v prohlížeči zaokrouhlí jinak.
const seedValue = z.int().min(0).max(2_147_483_647);

/** Umístění, které nese každý tvarový uzel. Vše volitelné = model nemusí psát nuly. */
const placement = {
  at: vector3.optional(),
  yaw: yawTurns.optional(),
  scale: scale3.optional(),
};

const massNode = z
  .object({ kind: z.literal('mass'), variant: z.enum(MASS_VARIANTS), ...placement })
  .strict();
const columnNode = z
  .object({ kind: z.literal('column'), variant: z.enum(COLUMN_VARIANTS), ...placement })
  .strict();
const archNode = z
  .object({ kind: z.literal('arch'), variant: z.enum(ARCH_VARIANTS), ...placement })
  .strict();
const panelNode = z
  .object({ kind: z.literal('panel'), variant: z.enum(PANEL_VARIANTS), ...placement })
  .strict();
const organicNode = z
  .object({ kind: z.literal('organic'), variant: z.enum(ORGANIC_VARIANTS), ...placement })
  .strict();

/**
 * Zem. `extent` je její rozměr v polích, takže `scale` nemá — dvě cesty ke
 * stejné velikosti jsou dvě místa, kde se dá udělat chyba.
 */
const terrainNode = z
  .object({
    kind: z.literal('terrain'),
    variant: z.enum(TERRAIN_VARIANTS),
    extent: z.tuple([span, span]),
    amplitude: z.number().min(0).max(8),
    seed: seedValue,
    at: vector3.optional(),
    yaw: yawTurns.optional(),
  })
  .strict();

/** Sjednocení. Jediný uzel, který nese víc potomků — proto se z něj skládá scéna. */
const groupNode = z
  .object({
    kind: z.literal('group'),
    children: z.array(nodeIndex).min(1).max(16),
  })
  .strict();

/** Řada kopií po pravidelném kroku. `count` počítá **včetně** originálu. */
const repeatNode = z
  .object({
    kind: z.literal('repeat'),
    child: nodeIndex,
    count: z.int().min(2).max(16),
    step: vector3,
  })
  .strict();

/**
 * Zrcadlo kolem roviny kolmé na osu. Osa `y` chybí schválně: svět stojí na
 * zemi a zrcadlení výšky by kusy poslalo pod ni.
 */
const mirrorNode = z
  .object({
    kind: z.literal('mirror'),
    child: nodeIndex,
    axis: z.enum(['x', 'z']),
    about: coordinate.optional(),
  })
  .strict();

/**
 * Řez kvádrem — díra, ne booleovský rozdíl.
 *
 * Kompilátor zahodí trojúhelníky, jejichž těžiště padne dovnitř kvádru. Je to
 * levné, deterministické a stačí to na průchod prosekaný do zdi. Ostrý ořez
 * s dopočítanou stěnou by znamenal CSG, pro které v `TOOLING.md` závislost není.
 */
const carveNode = z
  .object({
    kind: z.literal('carve'),
    child: nodeIndex,
    at: vector3,
    size: z.tuple([span, span, span]),
  })
  .strict();

/** Rozsetí kopií do kruhu. Deterministické — `seed` jde do `pure-rand`. */
const scatterNode = z
  .object({
    kind: z.literal('scatter'),
    child: nodeIndex,
    count: z.int().min(2).max(24),
    radius: z.number().min(0.5).max(32),
    seed: seedValue,
  })
  .strict();

const geomNodeSchema = z.discriminatedUnion('kind', [
  massNode,
  columnNode,
  archNode,
  panelNode,
  organicNode,
  terrainNode,
  groupNode,
  repeatNode,
  mirrorNode,
  carveNode,
  scatterNode,
]);

export const geomProgramSchema = z
  .object({
    version: z.literal(GEOM_VERSION),
    nodes: z.array(geomNodeSchema).min(1).max(GEOM_LIMITS.maxNodes),
    root: nodeIndex,
  })
  .strict();

export type GeomNode = z.infer<typeof geomNodeSchema>;
export type GeomProgram = z.infer<typeof geomProgramSchema>;

export interface GeomValidation {
  readonly ok: boolean;
  readonly issues: readonly string[];
}

/** Potomci uzlu. Tvarové uzly nemají žádné, `group` několik, ostatní operace jednoho. */
export function childIndicesOf(node: GeomNode): readonly number[] {
  if (node.kind === 'group') return node.children;
  return 'child' in node ? [node.child] : [];
}

/**
 * Kolik umístěných kusů vyleze z každého uzlu po rozvinutí operací.
 *
 * Průchod odspodu nahoru — potomek má vždy nižší index než rodič, což vynucuje
 * `structuralIssues`, takže v poli je hotová hodnota dřív, než ji někdo čte.
 * `carve` násobí jedničkou: díra kusy neubírá ani nepřidává.
 */
export function instanceCounts(nodes: readonly GeomNode[]): readonly number[] {
  const counts: number[] = [];
  nodes.forEach((node, index) => {
    switch (node.kind) {
      case 'group':
        counts[index] = node.children.reduce((sum, child) => sum + counts[child], 0);
        break;
      case 'repeat':
      case 'scatter':
        counts[index] = node.count * counts[node.child];
        break;
      case 'mirror':
        counts[index] = 2 * counts[node.child];
        break;
      case 'carve':
        counts[index] = counts[node.child];
        break;
      default:
        counts[index] = 1;
    }
  });
  return counts;
}

/**
 * To, co schéma neumí: rozsah a monotonii indexů a rozpočet po rozvinutí.
 * Vrací **všechny** nálezy, ne první — program se odmítá s důvodem.
 */
function structuralIssues(program: GeomProgram): string[] {
  const issues: string[] = [];
  const fail = (message: string) => issues.push(message);

  if (program.root >= program.nodes.length)
    fail(`root references node ${program.root} outside the table of ${program.nodes.length}`);

  program.nodes.forEach((node, index) => {
    for (const child of childIndicesOf(node)) {
      if (child >= index) fail(`node ${index} references node ${child} at or above itself`);
    }
  });

  // Rozpočet se počítá až nad neporušenou tabulkou; nad cyklem nebo nad
  // odkazem mimo tabulku by `instanceCounts` četlo `undefined`.
  if (issues.length > 0) return issues;

  const expanded = instanceCounts(program.nodes)[program.root];
  if (expanded > GEOM_LIMITS.maxInstances)
    fail(
      `program expands to ${expanded} placed pieces, above maxInstances ${GEOM_LIMITS.maxInstances}`,
    );

  return issues;
}

export function validateGeomProgram(input: unknown): GeomValidation {
  const parsed = geomProgramSchema.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      issues: parsed.error.issues.map((issue) => `schema:/${issue.path.join('/')}: ${issue.message}`),
    };
  }

  const issues = structuralIssues(parsed.data);
  return { ok: issues.length === 0, issues };
}

/** Přijme, nebo vyhodí s pojmenovaným důvodem. Kompilátor bere jen tenhle vstup. */
export function parseGeomProgram(input: unknown): GeomProgram {
  const validation = validateGeomProgram(input);
  if (!validation.ok) throw new Error(`invalid geom program: ${validation.issues.join('; ')}`);
  return geomProgramSchema.parse(input);
}
