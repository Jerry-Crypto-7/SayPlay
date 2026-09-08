/**
 * Testy vyhodnocovače pole.
 *
 * ## Čtyři orákula, každé chytá jinou třídu chyby
 *
 * 1. **Nezávislý vzorec** pro devět primitiv (`reference-sdf.ts`). Vzdálenost
 *    se tam počítá promítnutím bodu na povrch, tedy jinou cestou než v
 *    produktu — shoda na 1e-5 tedy není shoda dvou opsaných řádků.
 * 2. **Definice vzdálenosti bez jakéhokoli vzorce**: v kouli o poloměru `|d|`
 *    kolem bodu nesmí ležet povrch. Platí to pro **každý** druh uzlu včetně
 *    deformací a je to přesně ta vlastnost, jejíž porušení dělá do meshe díry.
 *    Kdyby v téhle sadě měl zůstat jediný test, je to ten.
 * 3. **Eikonální vlastnost** `|∇d| = 1` — odliší skutečnou vzdálenost od pouhé
 *    funkce se správným znaménkem. Bez ní by prošla i `sign(uvnitř)`.
 * 4. **Množinová shoda** pro kombinace: sjednocení má být opravdu sjednocení.
 */

import { describe, expect, it } from 'vitest';

import { CURVE_INTERNALS, FAR_DISTANCE, NOISE_INTERNALS, createField, type Field } from '../field';
import type { DisplaceNode, ShapeNode, ShapeProgram, Vec3 } from '../types';
import {
  length3,
  probePoints,
  referenceBox,
  referenceCapsule,
  referenceCone,
  referenceCylinder,
  referencePrism,
  referenceTorus,
  sphereDirections,
} from './reference-sdf';

const SEED = 20260829;

function programOf(
  nodes: readonly ShapeNode[],
  root = nodes.length - 1,
): Pick<ShapeProgram, 'nodes' | 'root'> {
  return { nodes, root };
}

function fieldOf(nodes: readonly ShapeNode[], root = nodes.length - 1): Field {
  return createField(programOf(nodes, root), SEED);
}

/**
 * Orákulum bez vzorce: **v kouli o poloměru `|d|` kolem bodu nesmí být povrch.**
 *
 * Vrací počet naměřených porušení, tedy 0, když je pole poctivé. Zkouší se
 * poloměr o dvě procenta menší, protože přesně na naměřené vzdálenosti povrch
 * ležet **smí** — to je definice, ne chyba.
 */
function overestimations(
  field: Field,
  points: readonly Vec3[],
  directions: readonly Vec3[],
): number {
  let violations = 0;
  for (const [x, y, z] of points) {
    const d = field.at(x, y, z);
    if (!Number.isFinite(d) || Math.abs(d) < 1e-6 || Math.abs(d) > 100) continue;
    const inside = d < 0;
    const radius = Math.abs(d) * 0.98;
    for (const [dx, dy, dz] of directions) {
      const probe = field.at(x + dx * radius, y + dy * radius, z + dz * radius);
      if (probe < 0 !== inside) violations += 1;
    }
  }
  return violations;
}

/* ------------------------------------------------------------------ *
 * 1. Primitiva proti nezávislému vzorci.
 * ------------------------------------------------------------------ */

describe('primitiva se shodují s nezávisle spočítanou vzdáleností', () => {
  const points = probePoints();

  const cases: readonly { name: string; node: ShapeNode; reference: (p: Vec3) => number }[] = [
    {
      name: 'sphere',
      node: { kind: 'sphere', radius: 1.3 },
      reference: (p) => length3(p[0], p[1], p[2]) - 1.3,
    },
    {
      name: 'box',
      node: { kind: 'box', size: [1.4, 2.2, 0.8] },
      reference: (p) => referenceBox(p, [1.4, 2.2, 0.8]),
    },
    {
      name: 'roundBox',
      node: { kind: 'roundBox', size: [1.4, 2.2, 0.8], radius: 0.25 },
      reference: (p) => referenceBox(p, [1.4, 2.2, 0.8]) - 0.25,
    },
    {
      name: 'capsule',
      node: { kind: 'capsule', height: 1.6, radius: 0.5 },
      reference: (p) => referenceCapsule(p, 1.6, 0.5),
    },
    {
      name: 'cylinder',
      node: { kind: 'cylinder', height: 2.4, radius: 0.9 },
      reference: (p) => referenceCylinder(p, 2.4, 0.9),
    },
    {
      name: 'cone',
      node: { kind: 'cone', height: 2.0, radius: 0.8 },
      reference: (p) => referenceCone(p, 2.0, 0.8),
    },
    {
      name: 'torus',
      node: { kind: 'torus', majorRadius: 1.2, minorRadius: 0.35 },
      reference: (p) => referenceTorus(p, 1.2, 0.35),
    },
    {
      name: 'plane',
      node: { kind: 'plane', normal: [0, 2, 0], offset: 0.4 },
      reference: (p) => p[1] - 0.4,
    },
    {
      name: 'prism',
      node: { kind: 'prism', sides: 6, radius: 1.1, height: 1.8 },
      reference: (p) => referencePrism(p, 6, 1.1, 1.8),
    },
  ];

  for (const { name, node, reference } of cases) {
    it(`${name} sedí na 1e-5`, () => {
      const field = fieldOf([node]);
      let worst = 0;
      let worstAt: Vec3 = [0, 0, 0];
      for (const p of points) {
        const delta = Math.abs(field.at(p[0], p[1], p[2]) - reference(p));
        if (delta > worst) {
          worst = delta;
          worstAt = p;
        }
      }
      expect(worst, `nejhorší bod ${worstAt.join(', ')}`).toBeLessThan(1e-5);
    });
  }

  it('ellipsoid je odhad, takže se soudí znaménkem a bezpečnou stranou', () => {
    // Přesná vzdálenost k elipsoidu nemá uzavřený tvar — proto je i v produktu
    // odhad. Soudí se tedy to, co na odhadu záleží: správné znaménko a to, že
    // vzdálenost nikdy nenadstřelí.
    const radii: Vec3 = [1.5, 0.7, 1.0];
    const field = fieldOf([{ kind: 'ellipsoid', radii }]);
    for (const p of probePoints(2.0, 9)) {
      const value = field.at(p[0], p[1], p[2]);
      const normalized = (p[0] / radii[0]) ** 2 + (p[1] / radii[1]) ** 2 + (p[2] / radii[2]) ** 2;
      expect(value < 0).toBe(normalized < 1);
    }
    expect(overestimations(field, probePoints(2.0, 5), sphereDirections(60))).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * 2. Vzdálenost se nikdy nenadstřelí — pro každý druh uzlu.
 * ------------------------------------------------------------------ */

describe('žádný uzel nenadstřelí vzdálenost', () => {
  const directions = sphereDirections(80);
  const points = probePoints(2.2, 5);

  const samples: readonly { name: string; nodes: readonly ShapeNode[] }[] = [
    {
      name: 'union s ostrou hranou',
      nodes: [
        { kind: 'sphere', radius: 0.9 },
        { kind: 'box', size: [1.6, 0.6, 0.6] },
        { kind: 'union', children: [0, 1] },
      ],
    },
    {
      name: 'union s plynulým přechodem',
      nodes: [
        { kind: 'sphere', radius: 0.9 },
        { kind: 'box', size: [1.6, 0.6, 0.6] },
        { kind: 'union', children: [0, 1], k: 0.4 },
      ],
    },
    {
      name: 'subtract',
      nodes: [
        { kind: 'box', size: [1.6, 1.6, 1.6] },
        { kind: 'sphere', radius: 1.0 },
        { kind: 'subtract', children: [0, 1] },
      ],
    },
    {
      name: 'subtract plynulý',
      nodes: [
        { kind: 'box', size: [1.6, 1.6, 1.6] },
        { kind: 'sphere', radius: 1.0 },
        { kind: 'subtract', children: [0, 1], k: 0.3 },
      ],
    },
    {
      name: 'intersect',
      nodes: [
        { kind: 'box', size: [1.6, 1.6, 1.6] },
        { kind: 'sphere', radius: 1.0 },
        { kind: 'intersect', children: [0, 1] },
      ],
    },
    {
      name: 'intersect plynulý',
      nodes: [
        { kind: 'box', size: [1.6, 1.6, 1.6] },
        { kind: 'sphere', radius: 1.0 },
        { kind: 'intersect', children: [0, 1], k: 0.25 },
      ],
    },
    {
      name: 'translate',
      nodes: [
        { kind: 'sphere', radius: 0.8 },
        { kind: 'translate', child: 0, offset: [0.7, -0.4, 0.3] },
      ],
    },
    {
      name: 'rotate',
      nodes: [
        { kind: 'box', size: [1.8, 0.5, 0.5] },
        { kind: 'rotate', child: 0, yaw: 0.7, pitch: 0.35, roll: -0.9 },
      ],
    },
    {
      name: 'scale nerovnoměrné',
      nodes: [
        { kind: 'sphere', radius: 0.8 },
        { kind: 'scale', child: 0, factor: [1.8, 0.4, 1.1] },
      ],
    },
    {
      name: 'mirror',
      nodes: [
        { kind: 'sphere', radius: 0.5 },
        { kind: 'translate', child: 0, offset: [0.9, 0, 0] },
        { kind: 'mirror', child: 1, axis: 'x' },
      ],
    },
    {
      name: 'twist',
      nodes: [
        { kind: 'box', size: [1.4, 2.0, 0.6] },
        { kind: 'twist', child: 0, axis: 'y', radiansPerUnit: 0.9 },
      ],
    },
    {
      name: 'bend',
      nodes: [
        { kind: 'box', size: [2.4, 0.5, 0.5] },
        { kind: 'bend', child: 0, axis: 'z', curvature: 0.5 },
      ],
    },
    {
      name: 'taper',
      nodes: [
        { kind: 'cylinder', height: 2.0, radius: 0.7 },
        { kind: 'taper', child: 0, axis: 'y', amount: -0.35 },
      ],
    },
    {
      name: 'displace',
      nodes: [
        { kind: 'sphere', radius: 1.1 },
        { kind: 'displace', child: 0, amplitude: 0.2, frequency: 2.5, seed: 7 },
      ],
    },
    {
      name: 'repeat',
      nodes: [
        { kind: 'sphere', radius: 0.35 },
        { kind: 'repeat', child: 0, count: 4, step: [0.9, 0, 0] },
      ],
    },
    {
      name: 'radialArray',
      nodes: [
        { kind: 'capsule', height: 0.6, radius: 0.2 },
        { kind: 'radialArray', child: 0, count: 6, axis: 'y', radius: 1.0 },
      ],
    },
    {
      name: 'arrayAlongCurve',
      nodes: [
        { kind: 'sphere', radius: 0.3 },
        {
          kind: 'arrayAlongCurve',
          child: 0,
          count: 5,
          points: [
            [-1.5, -0.5, 0],
            [0, 0.8, 0.4],
            [1.5, -0.3, -0.4],
          ],
        },
      ],
    },
    {
      name: 'revolve celý prstenec',
      nodes: [
        { kind: 'box', size: [0.4, 0.4, 0.4] },
        { kind: 'revolve', child: 0, axis: 'y', radius: 1.1, sweep: Math.PI * 2 },
      ],
    },
    {
      name: 'revolve výsek',
      nodes: [
        { kind: 'box', size: [0.4, 0.4, 0.4] },
        { kind: 'revolve', child: 0, axis: 'y', radius: 1.1, sweep: Math.PI },
      ],
    },
    {
      name: 'clip poloprostorem',
      nodes: [
        { kind: 'sphere', radius: 1.2 },
        { kind: 'clip', child: 0, region: { kind: 'halfSpace', normal: [0, 1, 0], offset: 0.2 } },
      ],
    },
    {
      name: 'clip kvádrem',
      nodes: [
        { kind: 'sphere', radius: 1.2 },
        {
          kind: 'clip',
          child: 0,
          region: { kind: 'box', center: [0.2, 0, 0], size: [1.6, 1.6, 1.6] },
        },
      ],
    },
  ];

  for (const { name, nodes } of samples) {
    it(name, () => {
      expect(overestimations(fieldOf(nodes), points, directions)).toBe(0);
    });
  }
});

/* ------------------------------------------------------------------ *
 * 2b. Oblouk — jediný uzel, kterým jazyk umí říct klenbu.
 * ------------------------------------------------------------------ */

describe('revolve otočí profil kolem osy a umí ho utnout', () => {
  /**
   * Profil je kvádr 0,3 × 0,3 × 0,3 na `x = 1,2`, otočený kolem `y`.
   * Výsledkem je prstenec o poloměru 1,2 a tloušťce 0,3.
   */
  const ring = (sweep: number): readonly ShapeNode[] => [
    { kind: 'box', size: [0.3, 0.3, 0.3] },
    { kind: 'revolve', child: 0, axis: 'y', radius: 1.2, sweep },
  ];

  /** Bod na kružnici o poloměru 1,2 pod úhlem `angle` od osy `+x`. */
  const on = (angle: number): Vec3 => [1.2 * Math.cos(angle), 0, 1.2 * Math.sin(angle)];

  it('celý prstenec je uvnitř na všech osmi směrech', () => {
    const field = fieldOf(ring(Math.PI * 2));
    for (let step = 0; step < 8; step += 1) {
      const [x, y, z] = on((step * Math.PI) / 4);
      expect(field.at(x, y, z), `úhel ${String(step * 45)}°`).toBeLessThan(0);
    }
  });

  it('osa zůstává prázdná, jinak by z prstence byl válec', () => {
    const field = fieldOf(ring(Math.PI * 2));
    expect(field.at(0, 0, 0)).toBeGreaterThan(0);
  });

  it('klenba končí tam, kde jí končí výsek', () => {
    // sweep = π je půlkruh: od -90° do +90° kolem profilu na +x.
    const field = fieldOf(ring(Math.PI));

    for (const angle of [0, Math.PI / 4, -Math.PI / 4, Math.PI / 2 - 0.05]) {
      const [x, y, z] = on(angle);
      expect(field.at(x, y, z), `uvnitř výseku, ${angle.toFixed(2)} rad`).toBeLessThan(0);
    }
    for (const angle of [Math.PI / 2 + 0.3, Math.PI, -Math.PI * 0.75]) {
      const [x, y, z] = on(angle);
      expect(field.at(x, y, z), `za koncem výseku, ${angle.toFixed(2)} rad`).toBeGreaterThan(0);
    }
  });

  it('vzdálenost za čelem oblouku roste po kružnici, ne po tětivě', () => {
    const field = fieldOf(ring(Math.PI));
    // Čtvrt radiánu za čelem na poloměru 1,2 je po oblouku 0,3 m; profil je
    // 0,15 široký, takže od povrchu zbývá 0,15. Tětiva by dala 0,296, tedy
    // znatelně míň — a to je ten rozdíl, který dělá odečet poloroviny špatně.
    const [x, y, z] = on(Math.PI / 2 + 0.25);
    expect(field.at(x, y, z)).toBeGreaterThan(0.1);
    expect(field.at(x, y, z)).toBeLessThan(0.2);
  });

  it('osa otáčení rozhoduje o rovině, ve které klenba stojí', () => {
    // Kolem 'y' leží prstenec naplocho v rovině x–z, kolem 'z' stojí v x–y.
    const flat = fieldOf(ring(Math.PI * 2));
    const upright = fieldOf([
      { kind: 'box', size: [0.3, 0.3, 0.3] },
      { kind: 'revolve', child: 0, axis: 'z', radius: 1.2, sweep: Math.PI * 2 },
    ]);

    expect(flat.at(0, 0, 1.2), 'naplocho: bod v z je uvnitř').toBeLessThan(0);
    expect(flat.at(0, 1.2, 0), 'naplocho: bod v y je venku').toBeGreaterThan(0);
    expect(upright.at(0, 1.2, 0), 'nastojato: bod v y je uvnitř').toBeLessThan(0);
    expect(upright.at(0, 0, 1.2), 'nastojato: bod v z je venku').toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * 3. Eikonální vlastnost — je to opravdu vzdálenost, ne jen znaménko.
 * ------------------------------------------------------------------ */

describe('primitiva mají jednotkový gradient', () => {
  const nodes: readonly ShapeNode[] = [
    { kind: 'sphere', radius: 1.1 },
    { kind: 'box', size: [1.4, 1.0, 1.8] },
    { kind: 'capsule', height: 1.2, radius: 0.5 },
    { kind: 'cylinder', height: 1.6, radius: 0.8 },
    { kind: 'torus', majorRadius: 1.0, minorRadius: 0.3 },
    { kind: 'prism', sides: 5, radius: 1.0, height: 1.4 },
  ];

  for (const node of nodes) {
    it(`${node.kind} splňuje |∇d| = 1`, () => {
      const field = fieldOf([node]);
      const gradient = new Float64Array(3);
      let checked = 0;
      for (const p of probePoints(2.0, 5)) {
        const value = field.at(p[0], p[1], p[2]);
        // Blízko povrchu se centrální diference přehoupne přes zlom vzdálenosti
        // a měřila by nesmysl. Zlomy jsou míra nula, tak se jim test vyhne.
        if (Math.abs(value) < 0.15) continue;
        field.gradientInto(p[0], p[1], p[2], gradient);
        const magnitude =
          Math.sqrt(
            gradient[0] * gradient[0] + gradient[1] * gradient[1] + gradient[2] * gradient[2],
          ) /
          (2 * 1e-3);
        // Uvnitř konvexních těles se gradient láme na kostře, kde je stejně
        // daleko víc stěn. Tam smí být kratší, nikdy ne delší.
        expect(magnitude).toBeLessThan(1 + 1e-3);
        if (value > 0) expect(magnitude).toBeGreaterThan(1 - 1e-3);
        checked += 1;
      }
      expect(checked).toBeGreaterThan(30);
    });
  }
});

/* ------------------------------------------------------------------ *
 * 4. Kombinace opravdu kombinují množiny.
 * ------------------------------------------------------------------ */

describe('kombinace se chovají jako množinové operace', () => {
  const sphere: ShapeNode = { kind: 'sphere', radius: 1.0 };
  const box: ShapeNode = { kind: 'box', size: [1.4, 1.4, 1.4] };
  const points = probePoints(2.0, 9);

  const inSphere = (p: Vec3) => length3(p[0], p[1], p[2]) < 1.0;
  const inBox = (p: Vec3) => referenceBox(p, [1.4, 1.4, 1.4]) < 0;

  it('union je sjednocení', () => {
    const field = fieldOf([sphere, box, { kind: 'union', children: [0, 1] }]);
    for (const p of points) {
      expect(field.at(p[0], p[1], p[2]) < 0).toBe(inSphere(p) || inBox(p));
    }
  });

  it('intersect je průnik', () => {
    const field = fieldOf([sphere, box, { kind: 'intersect', children: [0, 1] }]);
    for (const p of points) {
      expect(field.at(p[0], p[1], p[2]) < 0).toBe(inSphere(p) && inBox(p));
    }
  });

  it('subtract odečítá od prvního potomka, ne naopak', () => {
    // Pořadí je tady jediná věc, která nese význam, a je to nejsnazší chyba
    // celého souboru: prohozené potomky dají také platné těleso, jen jiné.
    const field = fieldOf([box, sphere, { kind: 'subtract', children: [0, 1] }]);
    for (const p of points) {
      expect(field.at(p[0], p[1], p[2]) < 0).toBe(inBox(p) && !inSphere(p));
    }
  });

  it('plynulé sjednocení jen přidává hmotu, nikdy neubírá', () => {
    const sharp = fieldOf([sphere, box, { kind: 'union', children: [0, 1] }]);
    const smooth = fieldOf([sphere, box, { kind: 'union', children: [0, 1], k: 0.5 }]);
    let differs = 0;
    for (const p of points) {
      const a = sharp.at(p[0], p[1], p[2]);
      const b = smooth.at(p[0], p[1], p[2]);
      expect(b).toBeLessThanOrEqual(a + 1e-9);
      if (Math.abs(a - b) > 1e-3) differs += 1;
    }
    expect(differs).toBeGreaterThan(0);
  });
});

/* ------------------------------------------------------------------ *
 * 5. Transformace dělají to, co slibují.
 * ------------------------------------------------------------------ */

describe('transformace posouvají tvar tam, kam mají', () => {
  it('translate posune střed koule', () => {
    const field = fieldOf([
      { kind: 'sphere', radius: 0.5 },
      { kind: 'translate', child: 0, offset: [1, 2, -3] },
    ]);
    expect(field.at(1, 2, -3)).toBeCloseTo(-0.5, 9);
    expect(field.at(0, 0, 0)).toBeCloseTo(Math.sqrt(1 + 4 + 9) - 0.5, 9);
  });

  it('rotate otočí tyč z osy x do osy z', () => {
    const field = fieldOf([
      { kind: 'box', size: [2, 0.2, 0.2] },
      { kind: 'rotate', child: 0, yaw: Math.PI / 2, pitch: 0, roll: 0 },
    ]);
    expect(field.at(0, 0, 0.9)).toBeLessThan(0);
    expect(field.at(0.9, 0, 0)).toBeGreaterThan(0);
  });

  it('mirror zdvojí tvar', () => {
    const field = fieldOf([
      { kind: 'sphere', radius: 0.4 },
      { kind: 'translate', child: 0, offset: [1.2, 0, 0] },
      { kind: 'mirror', child: 1, axis: 'x' },
    ]);
    expect(field.at(1.2, 0, 0)).toBeCloseTo(-0.4, 9);
    expect(field.at(-1.2, 0, 0)).toBeCloseTo(-0.4, 9);
    expect(field.at(0, 0, 0)).toBeGreaterThan(0);
  });

  it('scale násobí nejmenší složkou, takže vzdálenost nenadstřelí', () => {
    // Zdůvodnění je v `types.ts`: dělení největší složkou by pro drobná měřítka
    // vrátilo mnohonásobek skutečné vzdálenosti a krok by tvar přeskočil.
    const field = fieldOf([
      { kind: 'sphere', radius: 1 },
      { kind: 'scale', child: 0, factor: [0.05, 0.05, 0.05] },
    ]);
    // Zmenšená koule má poloměr 0,05; bod ve vzdálenosti 1 je tedy 0,95 daleko.
    expect(field.at(1, 0, 0)).toBeCloseTo(0.95, 9);
  });
});

/* ------------------------------------------------------------------ *
 * 6. Pole rozvinou správný počet kopií na správná místa.
 * ------------------------------------------------------------------ */

describe('pole rozvinou kopie tam, kam patří', () => {
  it('repeat počítá včetně originálu', () => {
    const field = fieldOf([
      { kind: 'sphere', radius: 0.2 },
      { kind: 'repeat', child: 0, count: 3, step: [1, 0, 0] },
    ]);
    expect(field.at(0, 0, 0)).toBeCloseTo(-0.2, 9);
    expect(field.at(1, 0, 0)).toBeCloseTo(-0.2, 9);
    expect(field.at(2, 0, 0)).toBeCloseTo(-0.2, 9);
    expect(field.at(3, 0, 0)).toBeGreaterThan(0);
  });

  it('radialArray rozdá kopie po kružnici a střed nechá prázdný', () => {
    const count = 4;
    const radius = 1.5;
    const field = fieldOf([
      { kind: 'sphere', radius: 0.25 },
      { kind: 'radialArray', child: 0, count, axis: 'y', radius },
    ]);
    // Osa `y` znamená rovinu `zx`; kopie 0 sedí na následující ose, tedy `z`.
    for (let i = 0; i < count; i += 1) {
      const angle = (2 * Math.PI * i) / count;
      expect(field.at(radius * Math.sin(angle), 0, radius * Math.cos(angle))).toBeCloseTo(-0.25, 6);
    }
    expect(field.at(0, 0, 0)).toBeGreaterThan(0);
  });

  it('arrayAlongCurve položí první a poslední kopii na krajní body', () => {
    const points: Vec3[] = [
      [-2, 0, 0],
      [0, 1.5, 0],
      [2, 0, 0],
    ];
    const field = fieldOf([
      { kind: 'sphere', radius: 0.3 },
      { kind: 'arrayAlongCurve', child: 0, count: 3, points },
    ]);
    expect(field.at(-2, 0, 0)).toBeCloseTo(-0.3, 6);
    expect(field.at(2, 0, 0)).toBeCloseTo(-0.3, 6);
  });

  it('Catmull-Rom prochází všemi kontrolními body', () => {
    const points: Vec3[] = [
      [-2, 0, 1],
      [0, 1.5, -1],
      [1, -0.5, 2],
      [3, 0.25, 0],
    ];
    const { catmullRomComponent } = CURVE_INTERNALS;
    for (let i = 0; i < points.length; i += 1) {
      const t = i / (points.length - 1);
      for (const component of [0, 1, 2] as const) {
        expect(catmullRomComponent(points, t, component)).toBeCloseTo(points[i][component], 9);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 7. Náhoda je deterministická a šum se chová, jak se o něm tvrdí.
 * ------------------------------------------------------------------ */

describe('displace losuje deterministicky', () => {
  const displace: DisplaceNode = {
    kind: 'displace',
    child: 0,
    amplitude: 0.3,
    frequency: 3,
    seed: 11,
  };
  const nodes: readonly ShapeNode[] = [{ kind: 'sphere', radius: 1 }, displace];
  const probes = probePoints(1.6, 5);

  it('dvakrát tentýž program dá bitově tytéž hodnoty', () => {
    const a = createField(programOf(nodes), 4242);
    const b = createField(programOf(nodes), 4242);
    for (const p of probes) {
      expect(a.at(p[0], p[1], p[2])).toBe(b.at(p[0], p[1], p[2]));
    }
  });

  it('jiné semínko relace dá jiný tvar', () => {
    const a = createField(programOf(nodes), 4242);
    const b = createField(programOf(nodes), 4243);
    const differs = probes.some(
      (p) => Math.abs(a.at(p[0], p[1], p[2]) - b.at(p[0], p[1], p[2])) > 1e-6,
    );
    expect(differs).toBe(true);
  });

  it('jiný seed uzlu dá jiný tvar i ve stejné relaci', () => {
    const a = createField(programOf(nodes), 4242);
    const b = createField(programOf([nodes[0], { ...displace, seed: 12 }]), 4242);
    const differs = probes.some(
      (p) => Math.abs(a.at(p[0], p[1], p[2]) - b.at(p[0], p[1], p[2])) > 1e-6,
    );
    expect(differs).toBe(true);
  });

  it('naměřený rozsah šumu se vejde do ⟨−1, 1⟩ a není konstantní', () => {
    const { createPermutation, perlin } = NOISE_INTERNALS;
    const perm = createPermutation(99);
    let low = Infinity;
    let high = -Infinity;
    for (let i = 0; i < 40; i += 1) {
      for (let j = 0; j < 40; j += 1) {
        for (let k = 0; k < 40; k += 1) {
          const value = perlin(perm, i * 0.31, j * 0.29, k * 0.37);
          low = Math.min(low, value);
          high = Math.max(high, value);
        }
      }
    }
    expect(low).toBeGreaterThan(-1);
    expect(high).toBeLessThan(1);
    expect(high - low).toBeGreaterThan(0.5);
  });

  it('odhad strmosti šumu je změřený, ne vymyšlený', () => {
    // Na tomhle čísle stojí bezpečnost `displace`: podstřelené by pustilo krok
    // přes povrch, nadstřelené by jen zpomalilo. Proto se měří.
    const { createPermutation, perlin, NOISE_GRADIENT_BOUND } = NOISE_INTERNALS;
    const perm = createPermutation(5);
    const epsilon = 1e-4;
    let steepest = 0;
    for (let i = 0; i < 25; i += 1) {
      for (let j = 0; j < 25; j += 1) {
        for (let k = 0; k < 25; k += 1) {
          const x = i * 0.17;
          const y = j * 0.23;
          const z = k * 0.13;
          const gx =
            (perlin(perm, x + epsilon, y, z) - perlin(perm, x - epsilon, y, z)) / (2 * epsilon);
          const gy =
            (perlin(perm, x, y + epsilon, z) - perlin(perm, x, y - epsilon, z)) / (2 * epsilon);
          const gz =
            (perlin(perm, x, y, z + epsilon) - perlin(perm, x, y, z - epsilon)) / (2 * epsilon);
          steepest = Math.max(steepest, Math.hypot(gx, gy, gz));
        }
      }
    }
    expect(steepest).toBeLessThan(NOISE_GRADIENT_BOUND);
    // A zároveň ne zbytečně vysoký — jinak by se tvar hledal mnohem pomaleji.
    expect(steepest).toBeGreaterThan(NOISE_GRADIENT_BOUND / 3);
  });
});

/* ------------------------------------------------------------------ *
 * 8. Rozbít to schválně: pole nesmí vrátit NaN ani nekonečno.
 * ------------------------------------------------------------------ */

describe('pole nikdy nevrátí NaN ani nekonečno', () => {
  it('daleko za mřížkou, v počátku i na ose souměrnosti', () => {
    const field = fieldOf([
      { kind: 'ellipsoid', radii: [0.4, 1.2, 0.8] },
      { kind: 'twist', child: 0, axis: 'y', radiansPerUnit: 3 },
      { kind: 'displace', child: 1, amplitude: 0.4, frequency: 8, seed: 3 },
    ]);
    const probes: Vec3[] = [
      [0, 0, 0],
      [1e6, 1e6, 1e6],
      [-1e6, 0, 0],
      [0, 1e-12, 0],
      [64, -64, 64],
    ];
    for (const p of probes) {
      const value = field.at(p[0], p[1], p[2]);
      expect(Number.isNaN(value), `bod ${p.join(', ')}`).toBe(false);
      expect(Number.isFinite(value), `bod ${p.join(', ')}`).toBe(true);
    }
  });

  it('rovina s nulovou normálou nevyrobí NaN, vrátí daleko', () => {
    // Schéma takovou rovinu nepustí. Vyhodnocovač je druhá obrana a nesmí
    // spoléhat na to, že první drží — jediné NaN otráví přes `min` celý tvar.
    expect(fieldOf([{ kind: 'plane', normal: [0, 0, 0], offset: 1 }]).at(1, 2, 3)).toBe(
      FAR_DISTANCE,
    );
  });

  it('elipsoid přesně v počátku vrátí nejmenší poloosu se záporným znaménkem', () => {
    expect(fieldOf([{ kind: 'ellipsoid', radii: [1.5, 0.7, 1.0] }]).at(0, 0, 0)).toBeCloseTo(
      -0.7,
      9,
    );
  });

  it('plynulé sjednocení v nekonečnu vyrobí NaN, a hranice ho zachytí', () => {
    // Tohle je jediné místo, kam **nedosáhne** pojistka uvnitř primitiva, a
    // proto tu ta na hranici je. Naměřeno: v souřadnici 1e200 přeteče
    // `x·x` na nekonečno, obě větve sjednocení jsou pak `Infinity` a plynulé
    // minimum počítá `(∞ − ∞)/k`, tedy `NaN`. Bez pojistky v `at()` by se
    // `NaN` přes `Math.min` rozlilo do celé mřížky a hrdina by zmizel — beze
    // slova, protože nikde nepadne výjimka.
    //
    // Schéma souřadnice omezuje na ±64, takže se sem produkt nedostane.
    // Vyhodnocovač je ale druhá obrana a nesmí spoléhat na to, že první drží;
    // právě proto neimportuje `zod` a kontroluje si výsledek sám.
    const nodes: readonly ShapeNode[] = [
      { kind: 'sphere', radius: 1 },
      { kind: 'box', size: [1, 1, 1] },
      { kind: 'union', children: [0, 1], k: 0.5 },
    ];
    expect(fieldOf(nodes).at(1e200, 1e200, 1e200)).toBe(FAR_DISTANCE);
  });

  it('samo nekonečno se taky nedostane ven', () => {
    // Bez `NaN`, jen přetečení: koule ve vzdálenosti 1e200 vrátí `Infinity`,
    // což je pro meshovač stejně nepoužitelné jako `NaN`.
    expect(fieldOf([{ kind: 'sphere', radius: 1 }]).at(1e200, 0, 0)).toBe(FAR_DISTANCE);
  });
});
