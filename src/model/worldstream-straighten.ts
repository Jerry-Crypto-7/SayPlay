/**
 * **Narovnání programů před bránou — strukturální přešlapy, které nestojí za
 * placené kolo.**
 *
 * `straightenMaterialIntent()` v compileru narovnává pravopis jednoho pole.
 * Tenhle modul dělá totéž pro tvar tabulek: naměřeno 12.–13. 9. 2026
 * (`evals/worldstream/latency-report.json`) stálo každé opravné kolo 25–42 s
 * a ~4 k tokenů a důvody se opakovaly: `group` s víc než 16 potomky, `union`
 * s víc než 8, křivka s víc než 8 body, měřítko nad 8, rozpočet kusů 156 > 120,
 * neznámý název varianty, řádek nedosažitelný z kořene. Ani jedna z nich
 * nemění, **co** model nakreslil — jen jak to zapsal — takže se dají narovnat
 * kódem a ukázat v panelu jako `adjustments`, stejně jako materiál.
 *
 * Co se tu **nenarovnává** a je to schválně: neznámý `kind`, chybějící pole,
 * nevyhratelný svět. To jsou vady obsahu; hádat je znamená vydat svět, který
 * model nenapsal.
 *
 * Pracuje se nad **surovým** JSON, ne nad naparsovaným programem: sahá se jen
 * na pole, která mají čekaný tvar (číslo, pole čísel), všechno ostatní se nechá
 * schématu k odmítnutí.
 */

import {
  GEOM_LIMITS,
  MAX_CURVE_POINTS,
  PIECE_VARIANTS,
  geomProgramSchema,
  instanceCounts,
  reachableFrom,
  type GeomProgram,
} from '../geom/program';
import { SHAPE_LIMITS } from '../shape/types';

import type { BlueprintAdjustment } from './worldstream-compiler';

type RawNode = Record<string, unknown>;

interface RawTable {
  readonly nodes: RawNode[];
  readonly root: number;
  readonly rest: Record<string, unknown>;
}

export interface Straightened {
  readonly value: unknown;
  /** Starý index řádku geometrie → nový. Placements ukazují do téže tabulky. */
  readonly remap: (index: number) => number;
}

const GEOM_GROUP_CHILDREN = 16;
const SHAPE_COMBINATION_CHILDREN = 8;
const GEOM_SCALE: readonly [number, number] = [0.1, 8];
const SHAPE_SCALE: readonly [number, number] = [0.05, 20];
const CURVE_FIELDS = ['points', 'path', 'profile'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTable(raw: unknown): RawTable | null {
  if (!isRecord(raw) || !Array.isArray(raw.nodes) || typeof raw.root !== 'number') return null;
  if (!raw.nodes.every(isRecord)) return null;
  const { nodes, root, ...rest } = raw;
  return { nodes: nodes.map((node) => ({ ...node })), root, rest };
}

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/** Odkazy na jiné řádky, jak je nesou obě tabulky: `child`, `target`, `children`. */
function refsOf(node: RawNode): number[] {
  const refs: number[] = [];
  if (isIndex(node.child)) refs.push(node.child);
  if (isIndex(node.target)) refs.push(node.target);
  if (Array.isArray(node.children)) for (const child of node.children) if (isIndex(child)) refs.push(child);
  return refs;
}

function remapNode(node: RawNode, map: (index: number) => number): RawNode {
  const out = { ...node };
  if (isIndex(node.child)) out.child = map(node.child);
  if (isIndex(node.target)) out.target = map(node.target);
  if (Array.isArray(node.children))
    out.children = node.children.map((child) => (isIndex(child) ? map(child) : child));
  return out;
}

function remapTable(table: RawTable, map: (index: number) => number): RawTable {
  return { ...table, nodes: table.nodes.map((node) => remapNode(node, map)), root: map(table.root) };
}

function insertBefore(table: RawTable, at: number, node: RawNode): RawTable {
  const shifted = remapTable(table, (index) => (index >= at ? index + 1 : index));
  const nodes = [...shifted.nodes];
  nodes.splice(at, 0, node);
  return { ...shifted, nodes };
}

function removeRow(table: RawTable, at: number): RawTable {
  const shifted = remapTable(table, (index) => (index > at ? index - 1 : index));
  const nodes = [...shifted.nodes];
  nodes.splice(at, 1);
  return { ...shifted, nodes };
}

/**
 * Potomek musí ležet pod rodičem — jinak nejde nic rozvinout ani dojít.
 * Kořen `-1` nebo `1.5` od modelu by jinak prošel jen horní mezí a
 * `reattachOrDropOrphans` by sáhl na neexistující uzel; výjimka z narovnání
 * shodí celé generování místo odmítnutí branou a opravného kola.
 */
function monotonic(table: RawTable): boolean {
  return (
    Number.isInteger(table.root) &&
    table.root >= 0 &&
    table.root < table.nodes.length &&
    table.nodes.every((node, index) => refsOf(node).every((ref) => ref < index))
  );
}

/* ------------------------------------------------------------------ *
 * Jednotlivá narovnání. Každé vrací novou tabulku a zapíše, co udělalo.
 * ------------------------------------------------------------------ */

function clampTuple(
  table: RawTable,
  field: string,
  [low, high]: readonly [number, number],
  path: string,
  adjustments: BlueprintAdjustment[],
): RawTable {
  const nodes = table.nodes.map((node, index) => {
    const tuple = node[field];
    if (!Array.isArray(tuple) || !tuple.every((v) => typeof v === 'number')) return node;
    const clamped = tuple.map((value: number, axis) => {
      const to = Math.min(high, Math.max(low, value));
      if (to !== value)
        adjustments.push({
          path: `${path}/nodes/${index}/${field}/${axis}`,
          reason: `${field} ${value} is outside ${low}–${high}, so the system clamped it`,
          from: value,
          to,
        });
      return to;
    });
    return clamped.some((v, i) => v !== tuple[i]) ? { ...node, [field]: clamped } : node;
  });
  return { ...table, nodes };
}

/** Osm bodů z víc: první a poslední zůstávají, mezi nimi rovnoměrný výběr. */
function resampleCurves(
  table: RawTable,
  limit: number,
  path: string,
  adjustments: BlueprintAdjustment[],
): RawTable {
  const nodes = table.nodes.map((node, index) => {
    let out = node;
    for (const field of CURVE_FIELDS) {
      const points = node[field];
      if (!Array.isArray(points) || points.length <= limit) continue;
      const picked = Array.from({ length: limit }, (_, k) => points[Math.round((k * (points.length - 1)) / (limit - 1))]);
      adjustments.push({
        path: `${path}/nodes/${index}/${field}`,
        reason: `${field} has ${points.length} points where the protocol takes at most ${limit}, so the system kept every ${(points.length / limit).toFixed(1)}th`,
        from: points.length,
        to: limit,
      });
      out = { ...out, [field]: picked };
    }
    return out;
  });
  return { ...table, nodes };
}

/**
 * Uzel s víc potomky, než smí nést, se rozdělí: prvních `limit − 1` zůstane,
 * zbytek dostane nový řádek téhož druhu vložený **pod** rodiče, protože
 * potomek musí mít nižší index. U `subtract` je držák zbytku `union` —
 * `a − (b ∪ c)` je to, co model napsal, `a − b − c` taky, ale `a − (b − c)` ne.
 */
function splitWideNodes(
  table: RawTable,
  limit: number,
  holderKindFor: (kind: unknown) => string | null,
  path: string,
  adjustments: BlueprintAdjustment[],
): RawTable {
  let out = table;
  let index = 0;
  while (index < out.nodes.length) {
    const node = out.nodes[index];
    const holderKind = holderKindFor(node.kind);
    if (holderKind === null || !Array.isArray(node.children) || node.children.length <= limit) {
      index += 1;
      continue;
    }
    const kept = node.children.slice(0, limit - 1);
    const rest = node.children.slice(limit - 1);
    adjustments.push({
      path: `${path}/nodes/${index}/children`,
      reason: `${String(node.kind)} carries ${node.children.length} children where the protocol takes at most ${limit}, so the system nested the last ${rest.length} in a ${holderKind} of their own`,
      from: node.children.length,
      to: limit,
    });
    const holder: RawNode = { kind: holderKind, children: rest };
    out = insertBefore(out, index, holder);
    out.nodes[index + 1] = { ...out.nodes[index + 1], children: [...kept, index] };
    // Držák na `index` se projde znovu: může být sám širší než strop.
  }
  return out;
}

function pieceVariants(kind: unknown): readonly string[] | null {
  return typeof kind === 'string' && kind in PIECE_VARIANTS
    ? PIECE_VARIANTS[kind as keyof typeof PIECE_VARIANTS]
    : null;
}

/**
 * Neznámý název varianty → nejbližší známý. „Nejbližší" je obsažení názvu
 * (`oilBarrel` → `barrel`, `crates` → `crate`); bez shody první varianta
 * druhu, protože kus **na správném místě v nesprávném provedení** je pro
 * porotce míň špatně než 30 s ticha.
 */
function nearestVariants(table: RawTable, path: string, adjustments: BlueprintAdjustment[]): RawTable {
  const nodes = table.nodes.map((node, index) => {
    const allowed = pieceVariants(node.kind);
    if (allowed === null || typeof node.variant !== 'string' || allowed.includes(node.variant)) return node;
    const written = node.variant.toLowerCase();
    const contained = allowed
      .filter((name) => written.includes(name.toLowerCase()) || name.toLowerCase().includes(written))
      .sort((a, b) => b.length - a.length);
    const to = contained[0] ?? allowed[0];
    adjustments.push({
      path: `${path}/nodes/${index}/variant`,
      reason: `"${node.variant}" is not a ${String(node.kind)} variant the protocol knows, so the system read it as ${to}`,
    });
    return { ...node, variant: to };
  });
  return { ...table, nodes };
}

/**
 * Řádek, na který se z kořene nedojde: u geometrie se připojí ke kořenovému
 * `group`, kde je pro něj místo a leží pod ním (model ho umístil souřadnicí,
 * tak ať je vidět); jinak — a u tvaru vždycky — se vyhodí. Řádek, na který
 * ukazuje placement (`pinned`), se **nevyhazuje**: model z něj chtěl objekt
 * a tiše ho ztratit je horší než kolo — nechá se bráně, ať to řekne modelu.
 */
function reattachOrDropOrphans(
  table: RawTable,
  attach: boolean,
  pinned: ReadonlySet<number>,
  path: string,
  adjustments: BlueprintAdjustment[],
): RawTable {
  if (!monotonic(table)) return table;
  const reached = new Set<number>([table.root]);
  for (let index = table.nodes.length - 1; index >= 0; index -= 1)
    if (reached.has(index)) for (const ref of refsOf(table.nodes[index])) reached.add(ref);
  const orphans = table.nodes.map((_n, i) => i).filter((i) => !reached.has(i));
  if (orphans.length === 0) return table;

  let out = table;
  const root = out.nodes[out.root];
  const attachable =
    attach && root.kind === 'group' && Array.isArray(root.children)
      ? orphans.filter((i) => i < out.root).slice(0, Math.max(0, GEOM_GROUP_CHILDREN - root.children.length))
      : [];
  if (attachable.length > 0) {
    const children = [...(root.children as unknown[]), ...attachable];
    out = { ...out, nodes: out.nodes.map((n, i) => (i === out.root ? { ...n, children } : n)) };
    adjustments.push({
      path: `${path}/nodes/${out.root}/children`,
      reason: `rows ${attachable.join(', ')} were written but never reached from root ${out.root}, so the system added them to the root group`,
    });
  }
  const dropped = orphans.filter(
    (i) => !attachable.includes(i) && !pinned.has(out.nodes[i].__was as number),
  );
  for (const index of [...dropped].sort((a, b) => b - a)) out = removeRow(out, index);
  if (dropped.length > 0)
    adjustments.push({
      path: `${path}/nodes`,
      reason: `rows ${dropped.join(', ')} could not be reached from the root, so the system left them out`,
      from: table.nodes.length,
      to: out.nodes.length,
    });
  return out;
}

/**
 * Rozpočet kusů: dokud program rozvine víc než `maxInstances`, ubírá se po
 * jedné kopii násobiteli s největším `count`. Konverguje, protože každý krok
 * ubere aspoň jeden kus a `count` nejde pod 2.
 */
function shrinkToBudget(table: RawTable, path: string, adjustments: BlueprintAdjustment[]): RawTable {
  const parsed = geomProgramSchema.safeParse({ ...table.rest, nodes: table.nodes, root: table.root });
  if (!parsed.success || !monotonic(table)) return table;
  const program: GeomProgram = parsed.data;
  const reached = reachableFrom(program.nodes, program.root);
  const nodes = program.nodes.map((node) => ({ ...node }));
  const before = new Map<number, number>();

  for (;;) {
    const expanded = instanceCounts(nodes)[program.root];
    if (expanded <= GEOM_LIMITS.maxInstances) break;
    let widest = -1;
    nodes.forEach((node, index) => {
      if (!reached.has(index) || !('count' in node) || node.count <= 2) return;
      if (widest < 0 || node.count > (nodes[widest] as { count: number }).count) widest = index;
    });
    if (widest < 0) break;
    const node = nodes[widest] as { count: number };
    before.set(widest, before.get(widest) ?? node.count);
    node.count -= 1;
  }

  if (before.size === 0) return table;
  for (const [index, from] of before)
    adjustments.push({
      path: `${path}/nodes/${index}/count`,
      reason: `the program expanded past maxInstances ${GEOM_LIMITS.maxInstances}, so the system trimmed this ${nodes[index].kind} from ${from} to ${(nodes[index] as { count: number }).count} copies`,
      from,
      to: (nodes[index] as { count: number }).count,
    });
  return {
    ...table,
    nodes: table.nodes.map((raw, index) =>
      before.has(index) ? { ...raw, count: (nodes[index] as { count: number }).count } : raw,
    ),
  };
}

/* ------------------------------------------------------------------ *
 * Vstupy compileru.
 * ------------------------------------------------------------------ */

const identity = (index: number): number => index;

/**
 * Geometrie. Vrací i přemapování indexů, protože `placements[*].source.node`
 * ukazuje do téže tabulky a vložený nebo vyhozený řádek by je posunul.
 */
export function straightenGeometry(
  raw: unknown,
  adjustments: BlueprintAdjustment[],
  /** Řádky, na které ukazují placements — ty se nikdy nevyhazují. */
  pinned: ReadonlySet<number> = new Set(),
): Straightened {
  const table = readTable(raw);
  if (table === null) return { value: raw, remap: identity };
  const path = 'geometry';

  // Každý původní řádek si nese svůj starý index, aby se přemapování nemuselo
  // skládat z jednotlivých kroků.
  const tagged: RawTable = {
    ...table,
    nodes: table.nodes.map((node, index) => ({ ...node, __was: index })),
  };

  let out = clampTuple(tagged, 'scale', GEOM_SCALE, path, adjustments);
  out = resampleCurves(out, MAX_CURVE_POINTS, path, adjustments);
  out = nearestVariants(out, path, adjustments);
  out = splitWideNodes(out, GEOM_GROUP_CHILDREN, (kind) => (kind === 'group' ? 'group' : null), path, adjustments);
  out = reattachOrDropOrphans(out, true, pinned, path, adjustments);

  const newIndex = new Map<number, number>();
  const nodes = out.nodes.map((node, index) => {
    const { __was, ...clean } = node;
    if (typeof __was === 'number') newIndex.set(__was, index);
    return clean;
  });
  out = shrinkToBudget({ ...out, nodes }, path, adjustments);

  return {
    value: { ...out.rest, nodes: out.nodes, root: out.root },
    remap: (index) => newIndex.get(index) ?? index,
  };
}

/** Tvar. Indexy do něj zvenku nikdo nedrží, takže stačí hodnota. */
export function straightenShape(raw: unknown, index: number, adjustments: BlueprintAdjustment[]): unknown {
  const table = readTable(raw);
  if (table === null) return raw;
  const path = `shapes/${index}`;

  let out = clampTuple(table, 'factor', SHAPE_SCALE, path, adjustments);
  out = resampleCurves(out, SHAPE_LIMITS.maxCurvePoints, path, adjustments);
  out = splitWideNodes(
    out,
    SHAPE_COMBINATION_CHILDREN,
    (kind) => (kind === 'union' || kind === 'intersect' ? kind : kind === 'subtract' ? 'union' : null),
    path,
    adjustments,
  );
  out = reattachOrDropOrphans(out, false, new Set(), path, adjustments);

  return { ...out.rest, nodes: out.nodes, root: out.root };
}
