/**
 * Nezávislá orákula pro testy pole vzdáleností.
 *
 * **Nic odsud nesmí volat `field.ts`.** Smysl těch vzorců je, že vzniknou jinou
 * cestou než ta, kterou soudí: `field.ts` používá kompaktní sloučené vzorce
 * (jeden výraz pro vnitřek i vnějšek), tady se počítá promítnutím bodu na
 * povrch a vnitřek se řeší zvlášť. Když se dvě takhle odlišné cesty shodnou na
 * 1e-5, není to shoda dvou opsaných řádků.
 *
 * Elipsoid tu schválně **není**: přesná vzdálenost k elipsoidu nemá uzavřený
 * tvar, což je zároveň důvod, proč je i v produktu odhad. Soudí se jinými
 * vlastnostmi, ne vzorcem.
 */

import type { Vec3 } from '../types';

export function length3(x: number, y: number, z: number): number {
  return Math.sqrt(x * x + y * y + z * z);
}

/** Kvádr: vně vzdálenost k oříznutému bodu, uvnitř nejbližší stěna. */
export function referenceBox(p: Vec3, size: Vec3): number {
  const hx = size[0] / 2;
  const hy = size[1] / 2;
  const hz = size[2] / 2;
  const ox = Math.abs(p[0]) - hx;
  const oy = Math.abs(p[1]) - hy;
  const oz = Math.abs(p[2]) - hz;
  if (ox <= 0 && oy <= 0 && oz <= 0) return Math.max(ox, oy, oz);
  return length3(Math.max(ox, 0), Math.max(oy, 0), Math.max(oz, 0));
}

/** Válec: úloha se rozpadne na rovinu `(poloměr, výška)`. */
export function referenceCylinder(p: Vec3, height: number, radius: number): number {
  const r = Math.hypot(p[0], p[2]);
  const dr = r - radius;
  const dy = Math.abs(p[1]) - height / 2;
  if (dr <= 0 && dy <= 0) return Math.max(dr, dy);
  return Math.hypot(Math.max(dr, 0), Math.max(dy, 0));
}

/** Kapsle: vzdálenost k úsečce mínus poloměr. */
export function referenceCapsule(p: Vec3, height: number, radius: number): number {
  const half = height / 2;
  const y = Math.min(Math.max(p[1], -half), half);
  return length3(p[0], p[1] - y, p[2]) - radius;
}

/** Prstenec: promítnutí na kružnici, pak na trubku. */
export function referenceTorus(p: Vec3, major: number, minor: number): number {
  const r = Math.hypot(p[0], p[2]);
  return Math.hypot(r - major, p[1]) - minor;
}

/** Vzdálenost bodu k úsečce v rovině. */
function distanceToSegment(
  q: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const denominator = dx * dx + dy * dy;
  const t = Math.min(Math.max(((q[0] - a[0]) * dx + (q[1] - a[1]) * dy) / denominator, 0), 1);
  return Math.hypot(q[0] - (a[0] + dx * t), q[1] - (a[1] + dy * t));
}

/**
 * Kužel v rovině `(poloměr, výška)` jako trojúhelník: podstava dole, špička
 * nahoře. Vzdálenost je minimum přes jeho tři strany, znaménko podle toho,
 * jestli bod leží uvnitř.
 */
export function referenceCone(p: Vec3, height: number, radius: number): number {
  const half = height / 2;
  const q: readonly [number, number] = [Math.hypot(p[0], p[2]), p[1]];

  const base: readonly [number, number] = [0, -half];
  const rim: readonly [number, number] = [radius, -half];
  const apex: readonly [number, number] = [0, half];

  // Jen dvě strany, ne tři. Osa `r = 0` **není povrch** — je to vnitřek tělesa,
  // které kolem té osy obíhá. Třetí úsečka tu původně byla a dělala z kužele
  // trojúhelník: bod blízko osy pak měl vzdálenost k ose místo k podstavě.
  const best = Math.min(distanceToSegment(q, base, rim), distanceToSegment(q, rim, apex));

  // Uvnitř: mezi podstavou a špičkou, a pod přímkou pláště `r/radius + (y+half)/height ≤ 1`.
  const underSide = q[0] / radius + (q[1] + half) / height <= 1;
  const inside = q[1] >= -half && q[1] <= half && underSide;
  return inside ? -best : best;
}

/**
 * Pravidelný hranol: vzdálenost k mnohoúhelníku v rovině `xz`, pak výška.
 *
 * Mnohoúhelník se skládá z vrcholů a měří se ke **každé** straně zvlášť, tedy
 * bez přeložení do jednoho výseku, které používá produkt. To je celý smysl —
 * chyba v přeložení se tímhle vzorcem nedá zopakovat.
 */
export function referencePrism(p: Vec3, sides: number, radius: number, height: number): number {
  const vertices: (readonly [number, number])[] = [];
  for (let i = 0; i < sides; i += 1) {
    const angle = (2 * Math.PI * i) / sides;
    vertices.push([radius * Math.cos(angle), radius * Math.sin(angle)]);
  }

  const q: readonly [number, number] = [p[0], p[2]];
  let bestEdge = Infinity;
  let inside = true;
  for (let i = 0; i < sides; i += 1) {
    const a = vertices[i];
    const b = vertices[(i + 1) % sides];
    bestEdge = Math.min(bestEdge, distanceToSegment(q, a, b));
    const cross = (b[0] - a[0]) * (q[1] - a[1]) - (b[1] - a[1]) * (q[0] - a[0]);
    if (cross < 0) inside = false;
  }

  const dPlane = inside ? -bestEdge : bestEdge;
  const dy = Math.abs(p[1]) - height / 2;
  if (dPlane <= 0 && dy <= 0) return Math.max(dPlane, dy);
  return Math.hypot(Math.max(dPlane, 0), Math.max(dy, 0));
}

/**
 * Mřížka bodů kolem počátku, vědomě mimo celá čísla.
 *
 * Kdyby body ležely přesně na osách a stěnách, minula by je celá třída chyb —
 * povrch primitiv tam má hrany a zlomy a chybný vzorec se na hraně často
 * shoduje se správným.
 */
export function probePoints(extent = 2.5, steps = 7): Vec3[] {
  const points: Vec3[] = [];
  for (let i = 0; i < steps; i += 1) {
    for (let j = 0; j < steps; j += 1) {
      for (let k = 0; k < steps; k += 1) {
        points.push([
          -extent + (2 * extent * (i + 0.37)) / steps,
          -extent + (2 * extent * (j + 0.53)) / steps,
          -extent + (2 * extent * (k + 0.19)) / steps,
        ]);
      }
    }
  }
  return points;
}

/** Rovnoměrně rozložené směry na kouli — Fibonacciho spirála. */
export function sphereDirections(count: number): Vec3[] {
  const golden = Math.PI * (3 - Math.sqrt(5));
  const directions: Vec3[] = [];
  for (let i = 0; i < count; i += 1) {
    const y = 1 - (2 * i) / (count - 1);
    const r = Math.sqrt(Math.max(1 - y * y, 0));
    const theta = golden * i;
    directions.push([Math.cos(theta) * r, y, Math.sin(theta) * r]);
  }
  return directions;
}
