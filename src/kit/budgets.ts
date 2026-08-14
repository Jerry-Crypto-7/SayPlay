import { Mesh, type BufferGeometry, type Object3D } from 'three';

/**
 * Rozpočty kitu.
 *
 * **Odkud čísla jsou.** `DESIGN-BOOK.md` §13 vyžaduje strop trojúhelníků na
 * svět a strop draw callů, ale žádnou hodnotu neuvádí — §18 #7 ji má jako
 * nenaměřenou položku pro P5. Do té doby je strop odvozený, ne opsaný:
 *
 * - `maxDrawCallsPerWorld` **120** — kit má jediný materiál a nic se
 *   neinstancuje, takže draw call = jeden umístěný kus. 120 kusů je hustota,
 *   při které ručně skládaný layout z T201 vypadá zaplněně.
 * - `maxTrianglesPerWorld` **120 000** — strop pro WebGL2 na slabším notebooku
 *   s rezervou na 60 fps.
 * - `maxTrianglesPerPiece` **1 200** — 120 000 / 120 dá průměr 1 000 na kus;
 *   1 200 nechává rezervu hrdinskému kusu, aniž by průměr utekl.
 *
 * **Až P5 naměří skutečné číslo na cílovém hardwaru, přepíše tenhle soubor.**
 *
 * Naměřeno 14. 8. 2026: 42 kusů, scéna se všemi najednou má 42 draw callů a
 * **1 940 trojúhelníků**, nejtěžší kus 120. Kit tedy sedí hluboko pod stropem
 * a je to tak správně — strop je rozpočet **světa** se 120 umístěnými kusy,
 * ne popis kitu. Kdyby se strop stáhl na naměřenou hodnotu, přestal by to být
 * rozpočet a stal by se z něj detektor změn.
 */
export const KIT_BUDGETS = {
  minPieces: 36,
  maxPieces: 44,
  maxDrawCallsPerWorld: 120,
  maxTrianglesPerWorld: 120_000,
  maxTrianglesPerPiece: 1_200,
} as const;

export type SceneMeasurement = {
  readonly drawCalls: number;
  readonly triangles: number;
};

export function trianglesOf(geometry: BufferGeometry): number {
  const vertices = geometry.index?.count ?? geometry.getAttribute('position').count;
  return vertices / 3;
}

/**
 * Projde scénu a spočítá, co by z ní udělal renderer.
 *
 * Draw call na jeden `Mesh`, a na pole materiálů jeden na každou skupinu —
 * to je skutečné chování `WebGLRenderer`, ne odhad. Nic se tu neinstancuje,
 * takže počet kusů a počet draw callů je totéž.
 */
export function measureScene(root: Object3D): SceneMeasurement {
  let drawCalls = 0;
  let triangles = 0;

  root.traverse((node) => {
    if (!(node instanceof Mesh)) return;
    triangles += trianglesOf(node.geometry as BufferGeometry);
    drawCalls += Array.isArray(node.material) ? node.material.length : 1;
  });

  return { drawCalls, triangles };
}
