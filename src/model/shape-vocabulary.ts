/**
 * **Slovník `ShapeProgram` pro model — jedna kopie, dva volající.**
 *
 * Do 18. 9. 2026 bydlel v `worldstream-prompt.ts` a četl ho jen compiler.
 * Druhá věta, která **zakládá** nový objekt (P21 T8), potřebuje totéž: model
 * musí napsat tvar pro objekt, který ještě žádný tvar nemá, takže mu ho
 * nejde ukázat jako `currentShape`. `worldstream-prompt.ts` už přitom
 * importuje `worldstream-refine.ts` (kvůli `requestStage()`), a opačný import
 * by uzavřel cyklus. Proto samostatný modul, ne třetí opis.
 */

import { SHAPE_NODE_GROUPS } from '../shape/schema';
import { SHAPE_LIMITS, type ShapeNodeKind } from '../shape/types';

const SHAPE_NODE_ARGUMENTS: Readonly<Record<ShapeNodeKind, string>> = {
  sphere: 'radius',
  box: 'size [w,h,d] — the FULL size, not the half-extent',
  roundBox: 'size [w,h,d], radius',
  capsule: 'height, radius',
  cylinder: 'height, radius',
  cone: 'height, radius',
  torus: 'majorRadius, minorRadius',
  plane: 'normal [x,y,z], offset',
  prism: 'sides (3 to 12), radius, height',
  ellipsoid: 'radii [rx,ry,rz]',
  union: 'children [i, ...] (2 to 8), k — k is the blend radius; LEAVE IT OUT for a sharp edge, never write 0',
  subtract: 'children [i, ...] — the first child minus the rest, k optional',
  intersect: 'children [i, ...], k optional',
  translate: 'child, offset [x,y,z]',
  rotate: 'child, yaw, pitch, roll (radians)',
  scale: 'child, factor [sx,sy,sz] (0.05 to 20, never negative — use mirror to flip)',
  mirror: 'child, axis, about',
  twist: 'child, axis, radiansPerUnit (-8 to 8)',
  bend: 'child, axis, curvature (-8 to 8)',
  taper: 'child, axis, amount (-4 to 4)',
  displace: 'child, amplitude (0 to 8), frequency (0.01 to 16), seed — surface noise, the expensive node',
  revolve: 'child, axis, radius, sweep (0.05 to 2*PI radians, the WHOLE angle: PI is a half arch)',
  repeat: 'child, count (2 to 64), step [x,y,z]',
  radialArray: 'child, count, axis, radius',
  arrayAlongCurve: `child, count, points [[x,y,z], ...] (2 to ${SHAPE_LIMITS.maxCurvePoints})`,
  clip: 'child, region { kind: "halfSpace", normal, offset } or { kind: "box", center, size }',
};

export function shapeVocabulary(): string {
  const shapeLines = Object.entries(SHAPE_NODE_GROUPS).flatMap(([group, kinds]) => [
    `  ${group}:`,
    ...kinds.map((kind) => `    ${kind} — ${SHAPE_NODE_ARGUMENTS[kind]}`),
  ]);

  return [
    'SHAPES — hero objects, written as a distance field the browser meshes itself. Same table rule:',
    'children point strictly lower, root is last, every row reachable.',
    `At most ${SHAPE_LIMITS.maxNodes} rows, depth ${SHAPE_LIMITS.maxDepth}, ${SHAPE_LIMITS.maxInstances} copies after arrays expand,`,
    `and ${SHAPE_LIMITS.maxEvaluations} distance evaluations per grid cell. That last one is the real cost:`,
    'a shared subtree is free in the copy count and is not free here.',
    '',
    'Shape nodes:',
    ...shapeLines,
    '',
    'A shape carries: shapeId, stableId (the object it belongs to), nodes, root, targetBounds',
    '{ min, max } in SHAPE space, anchors [{ name, at, normal }] where sockets sit, materialIntent',
    '(camelCase, no spaces — a name, never a colour and never a phrase: brushedSteel, not "brushed steel"),',
    'priority (higher is meshed first).',
    'You do NOT write grid resolution, quality, cost or meshing order. Those are pipeline decisions.',
    // **Naměřeno 14. 9. 2026 na c07.** „Les, kde stromy jsou hrudní koše" přišel
    // jako jeden tvar: strom o 5,3 m se žebry 15 cm, zopakovaný 3× a 2×, takže
    // targetBounds byl 14,5 m a buňka mřížky 45 cm — žebra se rozpadla. Mřížka
    // je pevná, takže opakování se platí rozlišením a platí se zbytečně. Brána
    // `repeatedHeroIssue` to odmítá; tenhle odstavec je ta věta předem.
    'ONE shape is ONE object. If a hero appears many times — a forest of the same tree, a row of',
    'the same lamp — write it ONCE, with targetBounds around that single copy, and put the copies',
    'in the composition. The mesh grid is fixed, so a targetBounds stretched around repeated copies',
    'spends its resolution on the gaps between them and the detail inside each one is lost.',
  ].join('\n');
}
