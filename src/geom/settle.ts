import { Box3, Matrix4, Vector3 } from 'three';

import { CONTACT_TOLERANCE, isSupported, placedBoxes, type PlacedBox } from './contact';
import type { GeomPlacement } from './placements';

/**
 * **Usazení nad rozvinutou geometrií:** kus, který nic nedrží, spadne svisle
 * na nejbližší plochu pod sebou — desku stolu, když pod ním stůl je, jinak na
 * podlahu (`y = 0`).
 *
 * Co má být nahoře, se pozná z **druhu kusu, ne z výšky**: okno, střecha,
 * zábradlí balkonu, podlahová deska (strop, balkon) a průčelí zůstávají, kde
 * je model postavil. Usadit okno na podlahu je horší vada než visící okno a na
 * snímku vypadá jako záměr.
 *
 * Síť (zem, tažený profil, řez) se nikdy nehýbe. Rovná síť (výška do 2 cm)
 * slouží jako podlaha; nad **nerovnou** zemí se kus nechává být, protože
 * z opsaného kvádru výškového pole se výška pod kusem vyčíst nedá a usazení
 * na nejnižší bod by ho zabořilo.
 *
 * Po usazení (P19 T10) se řada panelů s mezerami natáhne do souvislé stěny a
 * střecha visící nad kabinou dosedne na její horní hranu — obě vady byly na
 * snímcích P18 vidět přímo (chodba z latí, deska nad bednou výtahu).
 */

/** Kusy, které patří nahoru. */
export const STAYS_UP: ReadonlySet<string> = new Set([
  'panel.window',
  'panel.roof',
  'panel.railing',
  'panel.floor',
  'panel.facade',
]);

const FLAT_MESH = 0.02;

function overlapsFootprint(a: Box3, b: Box3): boolean {
  return a.min.x < b.max.x && a.max.x > b.min.x && a.min.z < b.max.z && a.max.z > b.min.z;
}

function holdsCentre(surface: Box3, own: Box3): boolean {
  const x = (own.min.x + own.max.x) / 2;
  const z = (own.min.z + own.max.z) / 2;
  return x >= surface.min.x && x <= surface.max.x && z >= surface.min.z && z <= surface.max.z;
}

/** O kolik kus klesne, nebo `null`, když se nechává být. */
function dropOf(boxes: readonly PlacedBox[], entry: PlacedBox, floorY: number): number | null {
  const own = entry.box;
  let surface = own.min.y > floorY + CONTACT_TOLERANCE ? floorY : null;
  for (const other of boxes) {
    if (other.index === entry.index || !overlapsFootprint(own, other.box)) continue;
    const top = other.box.max.y;
    if (other.kind === 'mesh' && top - other.box.min.y > FLAT_MESH) return null;
    if (top > own.min.y + CONTACT_TOLERANCE || !holdsCentre(other.box, own)) continue;
    if (surface === null || top > surface) surface = top;
  }
  if (surface === null) return null;
  const drop = own.min.y - surface;
  return drop > CONTACT_TOLERANCE ? drop : null;
}

/** Panely, ze kterých se skládá stěna. */
const WALL_PIECES: ReadonlySet<string> = new Set(['panel.wall', 'panel.half']);

/**
 * Mezera do tohoto podílu šířky panelu je nedotažená stěna; větší rozestup je
 * záměr (plot, řada sloupků) a nechává se být.
 */
const MAX_GAP_SHARE = 0.6;

/** Střecha dosedne jen na kabinu, která kryje aspoň tuhle část jejího půdorysu. */
const MIN_CABIN_COVER = 0.5;

const round = (value: number): number => Math.round(value / CONTACT_TOLERANCE);

/** Natáhne kus ve světové ose kolem jeho středu. */
function stretched(placement: GeomPlacement, box: Box3, axis: 'x' | 'z', factor: number): GeomPlacement {
  const centre = box.getCenter(new Vector3());
  const scale = axis === 'x' ? new Vector3(factor, 1, 1) : new Vector3(1, 1, factor);
  const matrix = new Matrix4()
    .makeTranslation(centre.x, centre.y, centre.z)
    .multiply(new Matrix4().makeScale(scale.x, scale.y, scale.z))
    .multiply(new Matrix4().makeTranslation(-centre.x, -centre.y, -centre.z))
    .multiply(placement.matrix);
  return { ...placement, matrix };
}

/**
 * Řada panelů stěny s mezerami → souvislá stěna. Šířka panelu se bere
 * z **naměřeného** kvádru, ne z deklarace, a panely se natáhnou na rozteč řady:
 * délka stěny zůstane, mezery zmizí a trojúhelníků nepřibude. Natahuje se jen
 * řada se společnou roztečí, jejíž mezera je menší než `MAX_GAP_SHARE` šířky.
 */
function joinWallRuns(boxes: readonly PlacedBox[], settled: GeomPlacement[]): void {
  const taken = new Set<number>();
  for (const axis of ['x', 'z'] as const) {
    const other = axis === 'x' ? 'z' : 'x';
    const rows = new Map<string, PlacedBox[]>();
    for (const entry of boxes) {
      if (taken.has(entry.index) || entry.pieceId === null || !WALL_PIECES.has(entry.pieceId)) continue;
      const size = entry.box.getSize(new Vector3());
      const centre = entry.box.getCenter(new Vector3());
      const key = [entry.pieceId, round(centre.y), round(centre[other]), round(size.x), round(size.y), round(size.z)].join('|');
      const row = rows.get(key);
      if (row === undefined) rows.set(key, [entry]);
      else row.push(entry);
    }
    for (const row of rows.values()) {
      if (row.length < 2) continue;
      row.sort((a, b) => a.box.min[axis] - b.box.min[axis]);
      const width = row[0].box.max[axis] - row[0].box.min[axis];
      const step = row[1].box.min[axis] - row[0].box.min[axis];
      const regular = row.every(
        (entry, i) => i === 0 || Math.abs(entry.box.min[axis] - row[i - 1].box.min[axis] - step) <= CONTACT_TOLERANCE,
      );
      if (!regular || width <= 0 || step <= width + CONTACT_TOLERANCE || step > width * (1 + MAX_GAP_SHARE)) continue;
      for (const entry of row) {
        settled[entry.index] = stretched(settled[entry.index], entry.box, axis, step / width);
        taken.add(entry.index);
      }
    }
  }
}

function footprintArea(box: Box3): number {
  return Math.max(0, box.max.x - box.min.x) * Math.max(0, box.max.z - box.min.z);
}

function sharedArea(a: Box3, b: Box3): number {
  const x = Math.min(a.max.x, b.max.x) - Math.max(a.min.x, b.min.x);
  const z = Math.min(a.max.z, b.max.z) - Math.max(a.min.z, b.min.z);
  return x > 0 && z > 0 ? x * z : 0;
}

/**
 * Střecha visící nad kabinou dosedne na její horní hranu. Kabina je kus, který
 * kryje aspoň `MIN_CABIN_COVER` půdorysu střechy — stůl uprostřed místnosti
 * pod střechou kabinou není a střecha na něj nespadne.
 */
function seatRoofs(boxes: readonly PlacedBox[], settled: GeomPlacement[]): void {
  for (const roof of boxes) {
    if (roof.pieceId !== 'panel.roof') continue;
    let cabinTop: number | null = null;
    for (const other of boxes) {
      if (other.kind !== 'piece' || other.index === roof.index || other.pieceId === 'panel.roof') continue;
      if (other.box.max.y > roof.box.min.y + CONTACT_TOLERANCE) continue;
      if (sharedArea(roof.box, other.box) < footprintArea(roof.box) * MIN_CABIN_COVER) continue;
      if (cabinTop === null || other.box.max.y > cabinTop) cabinTop = other.box.max.y;
    }
    if (cabinTop === null) continue;
    const drop = roof.box.min.y - cabinTop;
    if (drop <= CONTACT_TOLERANCE) continue;
    roof.box.translate(new Vector3(0, -drop, 0));
    const placement = settled[roof.index];
    settled[roof.index] = {
      ...placement,
      matrix: new Matrix4().makeTranslation(0, -drop, 0).multiply(placement.matrix),
    };
  }
}

export function settlePlacements(
  placements: readonly GeomPlacement[],
  floorY = 0,
): readonly GeomPlacement[] {
  const boxes = placedBoxes(placements);
  const settled = [...placements];

  // Odspodu nahoru: věc na stole se usazuje až nad usazeným stolem.
  const order = [...boxes].sort((a, b) => a.box.min.y - b.box.min.y);
  for (const entry of order) {
    if (entry.kind !== 'piece' || entry.pieceId === null || STAYS_UP.has(entry.pieceId)) continue;
    if (isSupported(boxes, entry.index, floorY)) continue;
    const drop = dropOf(boxes, entry, floorY);
    if (drop === null) continue;
    entry.box.translate(new Vector3(0, -drop, 0));
    const placement = settled[entry.index];
    settled[entry.index] = {
      ...placement,
      matrix: new Matrix4().makeTranslation(0, -drop, 0).multiply(placement.matrix),
    };
  }
  // P19 T10: nad usazenými kusy – stěna bez mezer a střecha na kabině.
  seatRoofs(boxes, settled);
  joinWallRuns(boxes, settled);
  return settled;
}
