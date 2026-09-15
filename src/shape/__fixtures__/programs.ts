/**
 * Programy tvaru pro testy — psané ručně, nikdy generované modelem.
 *
 * `coveringProgram()` je doklad, že se **celý** slovník dá poskládat do jednoho
 * platného programu. Zamítavé testy z něj dělají porouchané kopie, takže když
 * některý z nich zezelená ze špatného důvodu, spadne i tenhle a je vidět, že se
 * rozbil základ, ne jen jeden okrajový případ.
 *
 * Zbylé tři generátory míří každý na jeden strop jazyka. Jsou parametrické
 * schválně: test tím ukáže **obě strany** hranice — že program přesně na stropu
 * projde a o jeden krok dál ne. Jednostranný test nerozliší správnou mez od
 * meze posunuté o jedna.
 */

import type { ShapeNode, ShapeProgram } from '../types';

/** Obálka programu. Stejná pro všechny fixtures, aby se lišila jen tabulka. */
const envelope = {
  shapeId: 'fixture',
  stableId: 'fixture-object',
  targetBounds: { min: [-3, -1, -3], max: [3, 4, 3] },
  anchors: [{ name: 'mouth', at: [0, 1, 0], normal: [0, 1, 0] }],
  materialIntent: 'bone',
  priority: 3,
} as const;

/**
 * Program, ve kterém je **každý** druh uzlu aspoň jednou.
 *
 * Tabulka je záměrně mělká: prvních deset řádků jsou primitiva, zbytek jsou
 * operace nad nimi a poslední řádek je sjednotí. Hloubka je 4, rozvinuté kopie
 * 19 — obojí hluboko pod stropem, takže testy stropů si ho můžou porouchat
 * jedním polem, aniž by narazily na druhý limit a měřily něco jiného.
 */
export function coveringProgram(): ShapeProgram {
  const nodes: ShapeNode[] = [
    { kind: 'sphere', radius: 0.6 },
    { kind: 'box', size: [1, 1, 1] },
    { kind: 'roundBox', size: [1, 0.4, 1], radius: 0.1 },
    { kind: 'capsule', height: 1.2, radius: 0.25 },
    { kind: 'cylinder', height: 1, radius: 0.3 },
    { kind: 'cone', height: 1, radius: 0.5 },
    { kind: 'torus', majorRadius: 0.8, minorRadius: 0.15 },
    { kind: 'plane', normal: [0, 1, 0], offset: 0 },
    { kind: 'prism', sides: 6, radius: 0.5, height: 1 },
    { kind: 'ellipsoid', radii: [0.8, 0.4, 0.5] },

    { kind: 'translate', child: 0, offset: [1, 0, 0] },
    { kind: 'rotate', child: 1, yaw: 0.3, pitch: 0.2, roll: 0.1 },
    { kind: 'scale', child: 2, factor: [1, 2, 1] },
    { kind: 'mirror', child: 3, axis: 'x' },
    { kind: 'twist', child: 4, axis: 'y', radiansPerUnit: 0.5 },
    { kind: 'bend', child: 5, axis: 'z', curvature: 0.2 },
    { kind: 'taper', child: 8, axis: 'y', amount: 0.3 },
    { kind: 'displace', child: 9, amplitude: 0.05, frequency: 3, seed: 7 },
    { kind: 'repeat', child: 6, count: 3, step: [0, 0.5, 0] },

    { kind: 'radialArray', child: 10, count: 4, axis: 'y', radius: 2 },
    {
      kind: 'arrayAlongCurve',
      child: 11,
      count: 5,
      points: [
        [0, 0, 0],
        [1, 1, 0],
        [2, 0, 0],
      ],
    },
    { kind: 'clip', child: 12, region: { kind: 'box', center: [0, 0, 0], size: [4, 4, 4] } },
    { kind: 'union', children: [13, 14, 15], k: 0.2 },
    { kind: 'subtract', children: [16, 17], k: 0.1 },
    { kind: 'intersect', children: [7, 18] },

    // Oblouk se připíná **na konec tabulky**, ne mezi operace: zamítavé testy
    // jmenují uzly indexem, takže vložení doprostřed by je posunulo pod cizí
    // řádek. Přidáno 31. 8. 2026 s uzlem `revolve`.
    { kind: 'revolve', child: 2, axis: 'y', radius: 1.2, sweep: Math.PI },

    { kind: 'union', children: [19, 20, 21, 22, 23, 24, 25] },
  ];

  return { ...envelope, nodes, root: nodes.length - 1 };
}

/**
 * Řetěz `depth` uzlů: koule a nad ní `depth - 1` posunů. Hloubka programu je
 * přesně `depth`, takže se s ním dá sáhnout na `maxDepth` z obou stran.
 */
export function chainProgram(depth: number): ShapeProgram {
  const nodes: ShapeNode[] = [{ kind: 'sphere', radius: 0.5 }];
  for (let step = 1; step < depth; step += 1) {
    nodes.push({ kind: 'translate', child: step - 1, offset: [0.1, 0, 0] });
  }
  return { ...envelope, nodes, root: nodes.length - 1 };
}

/**
 * `nodeCount` řádků: koule, nad nimi sjednocení po sedmi a nad těmi kořen.
 *
 * **Každý řádek visí pod kořenem, a to je celý důvod téhle konstrukce.**
 * První verze byla plochý seznam koulí a jedno sjednocení nad prvními osmi,
 * takže 39 ze 48 řádků bylo mrtvých — a test „přijme program přesně na stropu
 * uzlů" tím tvrdil pravý opak toho, co brána od 28. 8. 2026 vynucuje.
 * Hloubka je 3 a vyhodnocení `nodeCount`, takže jediný strop, na který takový
 * program dosáhne, je pořád ten zamýšlený: počet uzlů.
 */
export function wideProgram(nodeCount: number): ShapeProgram {
  const perGroup = 8;
  // Řádků je `listy + skupiny + kořen`. Hledá se největší počet listů, který
  // se do zadaného počtu řádků vejde přesně.
  let leaves = nodeCount - 2;
  while (leaves + Math.ceil(leaves / perGroup) + 1 > nodeCount) leaves -= 1;
  const groups = Math.ceil(leaves / perGroup);

  const nodes: ShapeNode[] = [];
  for (let index = 0; index < leaves; index += 1) {
    nodes.push({ kind: 'sphere', radius: 0.2 + index * 0.01 });
  }

  // Listy se rozdělí co nejrovnoměrněji: skupina o jediném potomkovi by
  // neprošla schématem, které od kombinace žádá aspoň dva.
  const unions: number[] = [];
  let taken = 0;
  for (let group = 0; group < groups; group += 1) {
    const size = Math.floor(leaves / groups) + (group < leaves % groups ? 1 : 0);
    nodes.push({
      kind: 'union',
      children: Array.from({ length: size }, (_unused, offset) => taken + offset),
    });
    taken += size;
    unions.push(nodes.length - 1);
  }

  nodes.push({ kind: 'union', children: unions });
  return { ...envelope, nodes, root: nodes.length - 1 };
}

/**
 * Sedm řádků, které projdou stropem kopií a přitom stojí přes tisíc vyhodnocení.
 *
 * Tvar podle nezávislého review z 28. 8. 2026: tři deformace nad koulí a nad
 * nimi tři sjednocení, která **ukazují pořád na týž uzel**. `instanceCounts`
 * počítá listové kopie, takže sdílený podstrom je v něm zdarma a vyjde přesně
 * 256, tedy na stropu. Vyhodnocení je 1061.
 */
export function sharedSubtreeProgram(): ShapeProgram {
  const nodes: ShapeNode[] = [
    { kind: 'sphere', radius: 0.5 },
    { kind: 'displace', child: 0, amplitude: 0.1, frequency: 4, seed: 1 },
    { kind: 'displace', child: 1, amplitude: 0.1, frequency: 8, seed: 2 },
    { kind: 'displace', child: 2, amplitude: 0.1, frequency: 16, seed: 3 },
    { kind: 'union', children: [3, 3, 3, 3, 3, 3, 3, 3] },
    { kind: 'union', children: [4, 4, 4, 4, 4, 4, 4, 4] },
    { kind: 'union', children: [5, 5, 5, 5] },
  ];
  return { ...envelope, nodes, root: nodes.length - 1 };
}

/**
 * Dvě pole nad sebou, dohromady `outer * inner` kopií ze **tří** řádků. Přesně
 * ten případ, kvůli kterému strop uzlů sám o sobě nechrání nic.
 */
export function arrayProgram(outer: number, inner: number): ShapeProgram {
  const nodes: ShapeNode[] = [
    { kind: 'sphere', radius: 0.3 },
    { kind: 'radialArray', child: 0, count: inner, axis: 'y', radius: 1.5 },
    { kind: 'repeat', child: 1, count: outer, step: [0, 0.6, 0] },
  ];
  return { ...envelope, nodes, root: nodes.length - 1 };
}
