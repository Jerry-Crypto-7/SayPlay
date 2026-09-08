/**
 * **Sloty a hrubý svět (P13 T13).** Sada je `pin` a pin je jediný: **objekt se
 * nesmí ztratit ani rozpustit.**
 *
 * Celkový obraz může vypadat správně a přitom nemít per-objektovou identitu —
 * šest desek zdi jako šest bezejmenných kusů, hrdina slitý s kulisou, kotva
 * spočítaná z meshe. Na jednom snímku se ani jedna z těch tří vad nepozná;
 * ozve se až o dvě vlny dál, kdy druhá věta nemá na co ukázat a hot-swap nemá
 * co vyměnit. Proto se tady soudí **vazby**, ne vzhled:
 *
 *   1. na každý `SemanticObject` právě jeden slot, v pořadí blueprintu;
 *   2. kotva je v prostoru slotu — dvě různá rozlišení dají tutéž kotvu;
 *   3. odmítnutý i chybějící tvar končí hlínou, která něco zabírá;
 *   4. kusy kompozice patří tomu, kdo si je nárokoval, a zbytek je kulisa;
 *   5. hrubý svět obsazuje jen tři příčky žebříku, ne libovolnou;
 *   6. kotva rozmnoženého vlastníka sedí na kusu, ne v mezeře mezi kopiemi.
 */

import { describe, expect, it } from 'vitest';

import { bakePlacements, compilePlacements } from '@/geom/placements';
import { repairEmission } from '@/model/repair';
import { sealSimHash } from '@/ir/worlddoc';
import { EXAMPLE_PLAN } from '@/model/worldstream-examples';
import { EXAMPLE_BLUEPRINT_ANSWER } from '@/model/worldstream-prompt';
import type { BlueprintOutcome, CompiledBlueprint } from '@/model/worldstream-repair';
import { MeshBudgetError, type MeshOrder, type MeshResult } from '@/shape/mesh-client';
import { paddedBounds } from '@/shape/surface-nets';
import type { Bounds3 } from '@/shape/types';

import {
  COARSER_GRIDS,
  PROXY_RUNGS,
  ROUGH_RESOLUTION,
  ROUGH_RUNGS,
  buildProxyWorld,
  slotResolutions,
  type ProxySlot,
  type ProxyWorld,
} from '../proxy';
import { blueprintSchema, type WorldstreamBlueprint } from '../schema';
import { boundsCenter, toWorld } from '../slots';

/* ------------------------------------------------------------------ *
 * Fixtura.
 * ------------------------------------------------------------------ */

/**
 * Blueprint z ukázkové odpovědi, **protažený opravdovým schématem**.
 *
 * Ukázku smí použít tahle sada, ne compilerova: opisování ukázky hlídá
 * compiler a je to jeho vada, ne proxy. Tady je ukázka naopak ten nejlepší
 * možný vstup — čtyři objekty, tři různé zdroje z kompozice (terén, `repeat`
 * a jeden kus) a jeden hrdinský tvar, tedy všechny čtyři cesty téhle úlohy
 * v jednom dokumentu.
 */
function blueprint(patch: Record<string, unknown> = {}): WorldstreamBlueprint {
  return blueprintSchema.parse({
    version: 'worldstream-v1',
    sessionSeed: 4021,
    title: 'a hillside terrace of beehives behind a low drystone wall',
    intent: EXAMPLE_PLAN.intent,
    world: sealSimHash(
      repairEmission(EXAMPLE_BLUEPRINT_ANSWER.world).document as { sim: unknown },
    ),
    geometry: EXAMPLE_BLUEPRINT_ANSWER.geometry,
    objects: [
      {
        stableId: 'hillsideTerrace',
        label: 'the hillside terrace',
        synonyms: ['the terrace', 'the slope'],
        role: 'terrain',
        source: { kind: 'geom', node: 0 },
        targetBounds: { min: [-13, -1, -9], max: [13, 1, 9] },
        importance: 2,
      },
      {
        stableId: 'drystoneWall',
        label: 'the drystone wall',
        synonyms: ['the wall'],
        role: 'architecture',
        source: { kind: 'geom', node: 2 },
        targetBounds: { min: [-10.5, 0, -5.6], max: [9.5, 1.4, -4.4] },
        importance: 2,
      },
      {
        stableId: 'tallHive',
        label: 'the tallest hive',
        synonyms: ['the hive'],
        role: 'hero',
        source: { kind: 'shape', shapeId: 'tallHiveShape' },
        targetBounds: { min: [-0.9, 0.6, 1.1], max: [0.9, 2.4, 2.9] },
        importance: 3,
      },
      {
        stableId: 'smokerBox',
        label: "the smoker's box",
        synonyms: ['the box'],
        role: 'prop',
        source: { kind: 'geom', node: 5 },
        targetBounds: { min: [4.1, 0, 5.1], max: [4.9, 0.7, 5.9] },
        importance: 1,
      },
    ],
    shapes: EXAMPLE_BLUEPRINT_ANSWER.shapes,
    ...patch,
  });
}

/**
 * Obálka kola kolem hotového blueprintu.
 *
 * `verdict`, `adjustments` a `repairs` jsou přetypované prázdno: proxy je
 * nečte a nikdy je číst nebude — jsou to stopy o tom, jak blueprint vznikl,
 * ne o tom, co je v něm. **`value` se naopak nepodvrhuje** a jde přes
 * `blueprintSchema.parse()`, protože právě to je dokument, který se tu soudí.
 */
function compiled(value: WorldstreamBlueprint): BlueprintOutcome {
  return {
    kind: 'compiled',
    rounds: [{ attempt: 1, fault: null, ms: 12 }],
    result: {
      ok: true,
      stage: 'worldstream-blueprint',
      value,
      verdict: undefined,
      adjustments: [],
      repairs: [],
    } as unknown as CompiledBlueprint,
  };
}

/** Mesh, jaký by vrátil worker. Obsah je jeden trojúhelník, na ten se nesoudí. */
function fakeMesh(order: MeshOrder): MeshResult {
  return {
    shapeId: order.program.shapeId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    vertexCount: 3,
    triangleCount: 1,
    bounds: order.bounds,
    elapsedMs: 40,
  };
}

/** Zaznamenává objednávky, aby šlo soudit rozlišení i pořadí. */
function recordingMesher() {
  const orders: MeshOrder[] = [];
  return {
    orders,
    mesh: async (order: MeshOrder): Promise<MeshResult> => {
      orders.push(order);
      return fakeMesh(order);
    },
  };
}

async function build(
  outcome: BlueprintOutcome = compiled(blueprint()),
  mesh: (order: MeshOrder) => Promise<MeshResult> = async (order) => fakeMesh(order),
): Promise<ProxyWorld> {
  return buildProxyWorld(outcome, { mesh });
}

function built(world: ProxyWorld): Extract<ProxyWorld, { kind: 'built' }> {
  if (world.kind !== 'built') throw new Error(`expected a built world, got ${world.kind}`);
  return world;
}

function slotOf(world: ProxyWorld, stableId: string): ProxySlot {
  const found = built(world).slots.find((entry) => entry.slot.stableId === stableId);
  if (found === undefined) throw new Error(`no slot for ${stableId}`);
  return found;
}

function spanOf(bounds: Bounds3, axis: 0 | 1 | 2): number {
  return bounds.max[axis] - bounds.min[axis];
}

/* ------------------------------------------------------------------ *
 * 1. Jeden slot na jeden objekt.
 * ------------------------------------------------------------------ */

describe('every semantic object becomes its own slot', () => {
  it('builds one slot per object, in the order of the blueprint', async () => {
    const world = built(await build());
    expect(world.slots.map((entry) => entry.slot.stableId)).toEqual([
      'hillsideTerrace',
      'drystoneWall',
      'tallHive',
      'smokerBox',
    ]);
  });

  it('carries the identity the second sentence needs onto every slot', async () => {
    const hive = slotOf(await build(), 'tallHive').slot;
    expect(hive.label).toBe('the tallest hive');
    expect(hive.role).toBe('hero');
    expect(hive.importance).toBe(3);
    expect(hive.source).toEqual({ kind: 'shape', shapeId: 'tallHiveShape' });
  });

  it('gives every slot a box with room in it, whatever rung it landed on', async () => {
    for (const entry of built(await build()).slots) {
      for (const axis of [0, 1, 2] as const) {
        expect(spanOf(entry.slot.worldBounds, axis)).toBeGreaterThan(0);
        expect(spanOf(entry.slot.localBounds, axis)).toBeGreaterThan(0);
      }
    }
  });
});

/* ------------------------------------------------------------------ *
 * 2. Hrdina, mřížka 32³ a kotvy v prostoru slotu.
 * ------------------------------------------------------------------ */

describe('the hero object is meshed from its own shape program', () => {
  it('orders the rough grid, not the detailed one', async () => {
    const mesher = recordingMesher();
    const world = built(await buildProxyWorld(compiled(blueprint()), { mesh: mesher.mesh }));

    expect(ROUGH_RESOLUTION).toBe(32);
    expect(mesher.orders).toHaveLength(1);
    expect(mesher.orders[0].resolution).toBe(32);
    expect(mesher.orders[0].program.shapeId).toBe('tallHiveShape');
    expect(mesher.orders[0].sessionSeed).toBe(4021);
    expect(world.resolution).toBe(32);
    const hive = slotOf(world, 'tallHive').form;
    expect(hive.rung).toBe('g3-reduced');
    // Mřížka, ve které mesh doopravdy vznikl. Bez sestupu je to ta hrubá.
    expect(hive.kind === 'mesh' && hive.resolution).toBe(32);
  });

  /**
   * Vlastnost: **objednávka nese kvádr syrový a rezervu přidá jenom worker.**
   *
   * Od `T13-meshpadding` (2. 9. 2026) mele `handleMeshJob()`
   * v `paddedBounds(bounds, resolution)`. Do téhle aserce to držel jen
   * komentář v `proxy.ts` — nezávislá revize změřila, že kdo objednávku
   * „opraví" přidáním rezervy i tady, nechá celou sadu zelenou a každý hrdina
   * se pak vymeshuje v kvádru o dvě buňky širším, tedy hrubší, než jaký
   * rozpočet povolil. `recordingMesher()` už objednávku zachytává; chyběl
   * jediný řádek, který se podívá na `bounds`.
   */
  it('orders the raw target box, leaving the one-cell reserve to the worker', async () => {
    const mesher = recordingMesher();
    await buildProxyWorld(compiled(blueprint()), { mesh: mesher.mesh });

    const program = mesher.orders[0].program;
    expect(mesher.orders[0].bounds).toEqual(program.targetBounds);
    // A ne jen „rovná se něčemu" — kvádr s rezervou je jiný objekt a tohle
    // říká, o kolik: jedna buňka na stranu, tedy `span / resolution`.
    expect(mesher.orders[0].bounds).not.toEqual(paddedBounds(program.targetBounds, 32));
  });

  /**
   * Fronta meshovače je sériová schválně, takže pořadí odeslání **je** pořadí,
   * ve kterém se objekty objeví před porotcem. `priority` je pole programu
   * a znamená přesně tohle — bez něj by hrdina věty čekal na kdeco.
   */
  it('meshes the shapes in the order their programs ask for', async () => {
    const second = {
      ...EXAMPLE_BLUEPRINT_ANSWER.shapes[0],
      shapeId: 'smokerShape',
      stableId: 'smokerBox',
      priority: 99,
    };
    const objects = blueprint().objects.map((object) =>
      object.stableId === 'smokerBox'
        ? { ...object, source: { kind: 'shape' as const, shapeId: 'smokerShape' } }
        : object,
    );

    const mesher = recordingMesher();
    await buildProxyWorld(
      compiled(blueprint({ objects, shapes: [...EXAMPLE_BLUEPRINT_ANSWER.shapes, second] })),
      { mesh: mesher.mesh },
    );

    expect(mesher.orders.map((order) => order.program.shapeId)).toEqual([
      'smokerShape',
      'tallHiveShape',
    ]);
  });

  it('seats the shape box exactly on the box the placement asked for', async () => {
    const hive = slotOf(await build(), 'tallHive').slot;

    // Tvar je napsaný v [-0.8,-0.8,-0.8]..[0.8,1.2,0.8], placement ho chce
    // v [-0.9,0.6,1.1]..[0.9,2.4,2.9]. Transformace je přesně ten poměr.
    expect(hive.transform.scale[0]).toBeCloseTo(1.125, 10);
    expect(hive.transform.scale[1]).toBeCloseTo(0.9, 10);
    expect(hive.transform.scale[2]).toBeCloseTo(1.125, 10);
    expect(hive.transform.translation[0]).toBeCloseTo(0, 10);
    expect(hive.transform.translation[1]).toBeCloseTo(1.32, 10);
    expect(hive.transform.translation[2]).toBeCloseTo(2, 10);

    for (const axis of [0, 1, 2] as const) {
      expect(toWorld(hive.transform, hive.localBounds.min)[axis]).toBeCloseTo(
        hive.worldBounds.min[axis],
        10,
      );
      expect(toWorld(hive.transform, hive.localBounds.max)[axis]).toBeCloseTo(
        hive.worldBounds.max[axis],
        10,
      );
    }
  });

  /**
   * **Tenhle test je celý důvod, proč slot existuje.**
   *
   * Kdyby se kotva odvozovala z meshe, změnila by se s každým rozlišením —
   * a hot-swap z 32³ na 48³ by socketu posunul místo, přestože design book
   * §13.2 ho jmenuje jako invariant. Dva běhy proto vrátí **jinak velké
   * meshe** a kotva se nesmí hnout ani v prostoru slotu, ani ve světě.
   *
   * **Co tenhle test NEpouští:** dvě různá rozlišení. `buildProxyWorld()` má
   * hrubou mřížku napevno, takže se sem druhé rozlišení nedá vpravit — pinuje
   * se tedy „slot mesh nečte", což je ta příčina. Že se s rozlišením
   * nepohnou ani trojúhelníky, měří vlna 3 na skutečném hot-swapu (T20).
   */
  it('reads no part of the slot off the mesh, whatever the mesh turns out to be', async () => {
    const rough = slotOf(await build(), 'tallHive').slot;
    const dense = slotOf(
      await build(compiled(blueprint()), async (order) => ({
        ...fakeMesh(order),
        vertexCount: 4_096,
        triangleCount: 8_190,
        bounds: { min: [-9, -9, -9], max: [9, 9, 9] },
      })),
      'tallHive',
    ).slot;

    expect(rough.anchors).toEqual([{ name: 'lid', at: [0, 1.1, 0], normal: [0, 1, 0] }]);
    expect(dense.anchors).toEqual(rough.anchors);
    expect(dense.transform).toEqual(rough.transform);
    expect(dense.localBounds).toEqual(rough.localBounds);

    // Ve světě sedí víko těsně pod horní hranou objektu, ne uprostřed meshe.
    const lid = toWorld(rough.transform, rough.anchors[0].at);
    expect(lid[0]).toBeCloseTo(0, 10);
    expect(lid[1]).toBeCloseTo(2.31, 10);
    expect(lid[2]).toBeCloseTo(2, 10);
    expect(lid[1]).toBeLessThan(rough.worldBounds.max[1]);
  });
});

/* ------------------------------------------------------------------ *
 * 2b. Žebřík hrubších mřížek (`T14r-meshbudget`).
 * ------------------------------------------------------------------ */

/**
 * **Vlastnost: tvar přes rozpočet spadne o příčku níž, ne rovnou na krabici.**
 *
 * Naměřeno 7. 9. 2026 přehráním prvního živého běhu: osm z třiceti vět
 * skončilo hlínou, a ani jednou proto, že by model tvar nenapsal — pokaždé ho
 * zahodil rozpočet hrubé příčky. Sedm z těch osmi se hrubší mřížkou vrátilo
 * na `g3-reduced`, `clay` klesl z **8 na 1**.
 *
 * Sada proto soudí **žebřík**, ne jednu objednávku: kolikrát se objednalo,
 * v jakých mřížkách, a co z toho slot dostal.
 */
describe('a shape over the budget drops a rung of the grid, not to a box', () => {
  /** Meshovač, který odmítá na rozpočtu, dokud mřížka neklesne pod `passAt`. */
  function budgetMesher(passAt: number) {
    const orders: MeshOrder[] = [];
    return {
      orders,
      mesh: async (order: MeshOrder): Promise<MeshResult> => {
        orders.push(order);
        if (order.resolution > passAt) {
          throw new MeshBudgetError(
            `mesh is 17200 triangles, above maxTriangles 16000 for resolution ${String(order.resolution)}`,
          );
        }
        return fakeMesh(order);
      },
    };
  }

  it('names two rungs below the rough grid, in the order they are tried', () => {
    expect([...COARSER_GRIDS]).toEqual([24, 16]);
    for (const grid of COARSER_GRIDS) expect(grid).toBeLessThan(ROUGH_RESOLUTION);
  });

  it('remeshes on the next grid down and keeps the authored rung', async () => {
    const mesher = budgetMesher(24);
    const world = built(await buildProxyWorld(compiled(blueprint()), { mesh: mesher.mesh }));

    expect(mesher.orders.map((order) => order.resolution)).toEqual([32, 24]);
    const hive = slotOf(world, 'tallHive').form;
    // Autorský tvar, ne fallback — celý smysl žebříku.
    expect(hive.rung).toBe('g3-reduced');
    // A svět neříká 32 o meshi, který se mlel ve 24. Bez tohohle pole by se
    // ta dvě čísla tiše rozešla.
    expect(hive.kind === 'mesh' && hive.resolution).toBe(24);
    expect(world.resolution).toBe(32);
  });

  /**
   * `T14r-worldgrid`. Jedno číslo na světě je od téhle úlohy naměřeně nepravda
   * o sestoupeném tvaru a jeden konzument ho už tiskne
   * (`src/app/dev/worldstream/page.tsx`, věta „N slots at 32³"). Oko ji přečte
   * správně a ona je špatně, takže se pinuje.
   */
  it('reports the grids the slots actually meshed at, not the one it ordered', async () => {
    const mesher = budgetMesher(24);
    const world = built(await buildProxyWorld(compiled(blueprint()), { mesh: mesher.mesh }));

    // Objednávka zůstává jedním číslem a je to schválně.
    expect(world.resolution).toBe(32);
    // Jediný meshovaný slot téhle fixtury je hrdina a ten sestoupil, takže
    // věta „N slots at 32³" mluví o mřížce, ve které nevznikl **žádný** tvar.
    expect(slotResolutions(world)).toEqual([24]);
  });

  /**
   * ⚠ **Tenhle svět je složený ručně a je to nutné, ne pohodlné.** Fixtura
   * `blueprint()` má **jediný** hrdinský tvar, takže přes ni se sesypání ani
   * pořadí změřit nedá: mutant, který `new Set` i `sort` vypustí, nad ní
   * přežije. Naměřeno při psaní téhle úlohy.
   */
  it('counts a grid once and puts the coarsest last', async () => {
    const one = built(await buildProxyWorld(compiled(blueprint()), { mesh: recordingMesher().mesh }));
    const meshed = one.slots.find((entry) => entry.form.rung === 'g3-reduced');
    expect(meshed, 'fixtura nemá jediný meshovaný slot').toBeDefined();

    const at = (resolution: number): ProxySlot => ({
      ...meshed!,
      form: { ...meshed!.form, resolution } as ProxySlot['form'],
    });
    const many: ProxyWorld = { ...one, slots: [at(24), at(32), at(24), at(16)] };

    // Sestupně a bez duplicit — jinak z jednoho sestoupeného tvaru mezi deseti
    // vyroste věta „32³ / 32³ / 32³ / 24³", kterou nikdo nepřečte.
    expect(slotResolutions(many)).toEqual([32, 24, 16]);
  });

  it('goes all the way down to the last rung before it gives up', async () => {
    const mesher = budgetMesher(16);
    const world = built(await buildProxyWorld(compiled(blueprint()), { mesh: mesher.mesh }));

    expect(mesher.orders.map((order) => order.resolution)).toEqual([32, 24, 16]);
    const hive = slotOf(world, 'tallHive').form;
    expect(hive.kind === 'mesh' && hive.resolution).toBe(16);
  });

  it('orders the raw target box on every rung, not only on the first', async () => {
    // Failure path rezervy: kdyby se na hrubší příčce začal posílat kvádr
    // s rezervou, mlel by se tvar v boxu o dvě buňky širším — a `resolution`
    // v reportu by o té změně mlčelo.
    const mesher = budgetMesher(16);
    await buildProxyWorld(compiled(blueprint()), { mesh: mesher.mesh });

    for (const order of mesher.orders) {
      expect(order.bounds).toEqual(order.program.targetBounds);
      expect(order.bounds).not.toEqual(paddedBounds(order.program.targetBounds, order.resolution));
    }
  });

  it('falls to clay when every rung is over budget, and says the ladder was tried', async () => {
    const mesher = budgetMesher(0);
    const world = await buildProxyWorld(compiled(blueprint()), { mesh: mesher.mesh });

    expect(mesher.orders.map((order) => order.resolution)).toEqual([32, 24, 16]);
    const hive = slotOf(world, 'tallHive').form;
    expect(hive.rung).toBe('semantic-clay');
    if (hive.kind !== 'clay') throw new Error(hive.kind);
    // Věta pro porotce jmenuje poslední mřížku, takže musí říct i to, že jich
    // bylo víc — jinak mluví o mřížce 16, o které svět nikde jinde nemluví.
    expect(hive.reason).toContain('32 → 24 → 16');
    expect(hive.reason).toContain('for resolution 16');
    expect(hive.drawn).toBe(true);
  });

  it('does not walk the ladder for a refusal the coarser grid cannot fix', async () => {
    // Prázdný mesh, vadné zadání a brána programu jsou deterministické: tentýž
    // program dá podruhé totéž, jen levněji. Sestup by spálil dvě objednávky
    // navíc a porotci pak napsal o rozpočtu, kterého se tvar nedotkl.
    const orders: MeshOrder[] = [];
    const world = await buildProxyWorld(compiled(blueprint()), {
      mesh: async (order) => {
        orders.push(order);
        throw new Error('empty mesh: no surface inside the requested box');
      },
    });

    expect(orders).toHaveLength(1);
    const hive = slotOf(world, 'tallHive').form;
    expect(hive.rung).toBe('semantic-clay');
    expect(hive.kind === 'clay' && hive.reason).toBe(
      'empty mesh: no surface inside the requested box',
    );
  });
});

/* ------------------------------------------------------------------ *
 * 3. Odmítnutý a chybějící tvar.
 * ------------------------------------------------------------------ */

describe('a shape that never arrives still leaves an object behind', () => {
  it('falls to clay when the worker rejects the mesh, and says why', async () => {
    const world = await build(compiled(blueprint()), async () => {
      throw new Error('empty mesh: no surface inside the requested box');
    });
    const hive = slotOf(world, 'tallHive');

    expect(hive.form.rung).toBe('semantic-clay');
    expect(hive.form.kind === 'clay' && hive.form.reason).toContain('empty mesh');
    // Hrdina, kterému se tvar nevymešoval, nikdy žádnou geometrii v obraze
    // neměl. Bedna je celé jeho tělo a **musí** se nakreslit — potlačit ji
    // tady je jediný způsob, jak objekt z obrazu úplně ztratit.
    expect(hive.form.kind === 'clay' && hive.form.drawn).toBe(true);
    expect(hive.slot.worldBounds).toEqual({ min: [-0.9, 0.6, 1.1], max: [0.9, 2.4, 2.9] });
    expect(hive.slot.anchors.map((anchor) => anchor.name)).toEqual(['base', 'top']);
  });

  it('keeps every other object whole when one shape fails', async () => {
    const world = built(
      await build(compiled(blueprint()), async () => {
        throw new Error('mesh budget exceeded');
      }),
    );
    expect(world.slots).toHaveLength(4);
    expect(world.slots.filter((entry) => entry.form.rung === 'g2-rich')).toHaveLength(3);
  });

  it('falls to clay when the blueprint declares no shape at all', async () => {
    const world = await build(compiled(blueprint({ shapes: [] })));
    const hive = slotOf(world, 'tallHive');
    expect(hive.form.rung).toBe('semantic-clay');
    expect(hive.form.kind === 'clay' && hive.form.drawn).toBe(true);
    expect(built(world).slots).toHaveLength(4);
  });

  it('puts the clay anchors on the floor and the lid of the declared box', async () => {
    const box = slotOf(await build(), 'smokerBox').slot;
    const base = box.anchors.find((anchor) => anchor.name === 'base');
    const top = box.anchors.find((anchor) => anchor.name === 'top');

    expect(base?.at[1]).toBeCloseTo(box.localBounds.min[1], 10);
    expect(top?.at[1]).toBeCloseTo(box.localBounds.max[1], 10);
    expect(toWorld(box.transform, top!.at)[1]).toBeCloseTo(box.worldBounds.max[1], 10);
  });
});

/* ------------------------------------------------------------------ *
 * 4. Kompozice se dělí na sloty a kulisu.
 * ------------------------------------------------------------------ */

describe('the composition splits into slots and the scenery around them', () => {
  it('hands every repeated copy to the one object that claimed the row', async () => {
    const wall = slotOf(await build(), 'drystoneWall');
    expect(wall.form.rung).toBe('g2-rich');
    // `repeat` s `count: 6` nad jednou deskou. Šest kusů, jedna zeď.
    expect(wall.form.kind === 'placements' && wall.form.placements).toHaveLength(6);
  });

  it('loses no piece and duplicates none between the slots and the scenery', async () => {
    const world = built(await build());
    const owned = world.slots.flatMap((entry) =>
      entry.form.kind === 'placements' ? [...entry.form.placements] : [],
    );

    // Terén (1) + zeď (6) + bedna (1) mají vlastníka; podstavce (3) a keře (9)
    // jsou kulisa. Dvacet je celý plán té ukázky.
    expect(owned).toHaveLength(8);
    expect(world.scenery).toHaveLength(12);
    expect(owned.length + world.scenery.length).toBe(
      compilePlacements(EXAMPLE_BLUEPRINT_ANSWER.geometry).length,
    );
    expect(world.scenery.every((placement) => placement.owner === undefined)).toBe(true);
  });

  /**
   * **Vlastník se nemusí trefit do řádku, který pole rozvinul.**
   *
   * Model klidně napíše `source: { node: 1 }`, tedy tu jednu desku, a `repeat`
   * nad ní nechá být — z jeho pohledu je zeď ta deska. Razítko proto musí
   * přežít každou kopii, kterou nad ním pole a zrcadla vyrobí. Kdyby se
   * ztrácelo, zeď by neměla ani jeden kus, spadla by na hlínu a šest desek by
   * skončilo v kulise, kde na ně druhá věta nemá jak ukázat.
   *
   * Přidáno 31. 8. 2026 po mutační kontrole: přenos razítka v `transformed()`
   * šlo vypnout a sada zůstala zelená, protože každý objekt fixtury si do té
   * doby nárokoval rovnou ten řádek s polem.
   */
  it('keeps the owner through every copy an array makes above it', async () => {
    const objects = blueprint().objects.map((object) =>
      object.stableId === 'drystoneWall'
        ? { ...object, source: { kind: 'geom' as const, node: 1 } }
        : object,
    );
    const world = built(await build(compiled(blueprint({ objects }))));
    const wall = slotOf(world, 'drystoneWall');

    expect(wall.form.rung).toBe('g2-rich');
    expect(wall.form.kind === 'placements' && wall.form.placements).toHaveLength(6);
    expect(world.scenery).toHaveLength(12);
  });

  /**
   * Dva objekty na vnořených řádcích: bližší vyhrává, vzdálenější spadne na
   * hlínu. Je to rozhodnutí, ne náhoda — kdyby brali kusy oba, přestala by být
   * kompozice rozdělená a hot-swap jednoho by přepisoval podobu druhého.
   */
  it('gives a contested piece to the closer claim and puts the other on clay', async () => {
    const objects = blueprint().objects.map((object) =>
      object.stableId === 'smokerBox'
        ? { ...object, source: { kind: 'geom' as const, node: 1 } }
        : object,
    );
    const world = await build(compiled(blueprint({ objects })));

    const wall = slotOf(world, 'drystoneWall');
    expect(slotOf(world, 'smokerBox').form.rung).toBe('g2-rich');
    expect(wall.form.rung).toBe('semantic-clay');
    // Řádek 2 je `repeat` nad řádkem 1. Kusy odešly dolů a nahoře nezbylo nic
    // — ale v obraze stojí všech šest, jen pod cizím jménem. Bedna přes ně by
    // byla dvojobraz.
    expect(wall.form.kind === 'clay' && wall.form.reason).toContain('handed out as row 1');
    expect(wall.form.kind === 'clay' && wall.form.drawn).toBe(false);
    expect(built(world).slots).toHaveLength(4);
  });

  it('measures the box the row really occupies instead of trusting the declared one', async () => {
    const terrace = slotOf(await build(), 'hillsideTerrace').slot;

    // Model deklaroval výšku 2 (`-1..1`). Terén má `amplitude: 0.7`, takže
    // víc než 1,4 zabrat nemůže — a slot má nést to, co je vidět.
    expect(spanOf(terrace.worldBounds, 1)).toBeLessThanOrEqual(1.4 + 1e-6);
    expect(spanOf(terrace.worldBounds, 1)).toBeGreaterThan(0);
    expect(spanOf(terrace.worldBounds, 0)).toBeCloseTo(26, 6);
    expect(spanOf(terrace.worldBounds, 2)).toBeCloseTo(18, 6);
  });

  /**
   * **`transform` znamená na každé příčce totéž: prostor slotu → svět.**
   *
   * Kusy kompozice nesou světové matice, takže by se bez přepočtu vykreslily
   * správně jen tehdy, kdyby se na ně transformace **neuplatnila** — jedna
   * příčka s obráceným významem než ostatní. Tenhle test to zavírá z obou
   * stran: upečená podoba sedí na `localBounds` (je tedy v prostoru slotu)
   * a `transform` ji vrátí přesně na `worldBounds`.
   *
   * Doplněno 31. 8. 2026 po nezávislé revizi; do té doby se tu porovnávala
   * upečená podoba se **světovým** kvádrem, což tu záměnu nechalo projít.
   */
  it('hands the form over in slot space, so one transform fits every rung', async () => {
    const wall = slotOf(await build(), 'drystoneWall');
    if (wall.form.kind !== 'placements') throw new Error('expected the composition rung');

    const baked = bakePlacements(wall.form.placements);
    baked.computeBoundingBox();
    const box = baked.boundingBox!;
    expect(box.min.x).toBeCloseTo(wall.slot.localBounds.min[0], 6);
    expect(box.max.y).toBeCloseTo(wall.slot.localBounds.max[1], 6);
    expect(box.min.z).toBeCloseTo(wall.slot.localBounds.min[2], 6);
    baked.dispose();

    // Ta podoba sama o sobě tedy stojí kolem počátku, ne na svém místě ve světě.
    expect(box.min.z).toBeLessThan(0);
    expect(box.max.z).toBeGreaterThan(0);

    expect(wall.slot.transform.scale).toEqual([1, 1, 1]);
    for (const axis of [0, 1, 2] as const) {
      expect(toWorld(wall.slot.transform, wall.slot.localBounds.min)[axis]).toBeCloseTo(
        wall.slot.worldBounds.min[axis],
        6,
      );
      expect(toWorld(wall.slot.transform, wall.slot.localBounds.max)[axis]).toBeCloseTo(
        wall.slot.worldBounds.max[axis],
        6,
      );
    }
  });

  /**
   * Dva objekty smějí napsat `source: { node: 2 }` oba — `references.ts` hlídá
   * druhý nárok jen u tvarů. Bez záznamu o rozebraných řádcích by pak oba
   * dostaly **tentýž objekt pole**: zeď dvakrát v obraze a hot-swap jednoho
   * slotu odpojující kusy toho druhého.
   *
   * Přidáno 31. 8. 2026 po nezávislé revizi.
   */
  it('lets only the first claim take a row, and never hands the same pieces twice', async () => {
    const objects = blueprint().objects.map((object) =>
      object.stableId === 'smokerBox'
        ? { ...object, source: { kind: 'geom' as const, node: 2 } }
        : object,
    );
    const world = built(await build(compiled(blueprint({ objects }))));

    const wall = slotOf(world, 'drystoneWall');
    const box = slotOf(world, 'smokerBox');
    expect(wall.form.rung).toBe('g2-rich');
    expect(box.form.rung).toBe('semantic-clay');
    expect(box.form.kind === 'clay' && box.form.reason).toContain('already belongs to drystoneWall');
    expect(box.form.kind === 'clay' && box.form.drawn).toBe(false);

    const owned = world.slots.flatMap((entry) =>
      entry.form.kind === 'placements' ? [...entry.form.placements] : [],
    );
    expect(new Set(owned).size).toBe(owned.length);
    expect(world.slots).toHaveLength(4);
  });

  /**
   * Řez, který spolkne celý řádek. Dvě různá selhání, obě z výsledku, ne ze
   * zápisu — schéma je nevidí a vidět nemůže. Přidáno 31. 8. 2026 po nezávislé
   * revizi, která obě cesty našla jako neotestované.
   */
  it('turns a row that was carved to nothing into clay, not into a hole', async () => {
    const geometry = {
      version: EXAMPLE_BLUEPRINT_ANSWER.geometry.version,
      nodes: [
        { kind: 'fixture', variant: 'crate', at: [0, 0.3, 0] },
        { kind: 'carve', child: 0, at: [0, 0, 0], size: [40, 40, 40] },
        { kind: 'fixture', variant: 'crate', at: [12, 0.3, 0] },
        { kind: 'group', children: [1, 2] },
      ],
      root: 3,
    };
    const objects = blueprint().objects.slice(0, 2).map((object, index) => ({
      ...object,
      source: { kind: 'geom' as const, node: index === 0 ? 1 : 2 },
    }));

    const world = built(await build(compiled(blueprint({ geometry, objects, shapes: [] }))));
    expect(world.slots[0].form.rung).toBe('semantic-clay');
    expect(world.slots[0].form.kind === 'clay' && world.slots[0].form.reason).toContain(
      'occupies no space',
    );
    // Řez vymazal všechno, co ten řádek měl — v obraze po něm nezbylo nic,
    // takže bedna je jediné, co tam bude stát, a kreslí se.
    expect(world.slots[0].form.kind === 'clay' && world.slots[0].form.drawn).toBe(true);
    expect(world.slots[1].form.rung).toBe('g2-rich');
  });

  /**
   * **Řez, který řádek přežil — a proto se přes něj bedna nekreslí.**
   *
   * Rozdíl proti testu nad ním je jediné číslo: řez míjí bednu, místo aby ji
   * spolkl. Objekt na řádku 0 nedostane kusy tak jako tak (razítko zaniká
   * v řezu), jenže jeho trojúhelníky **v obraze zůstaly** — kulisa je kreslí
   * jako jednu slepenou síť. Hliněný kvádr na `targetBounds` by tedy prorostl
   * skutečným tvarem, a to je dvojobraz, ne poctivé přiznání.
   *
   * Na jednom snímku se to nepozná od správného renderu, proto je to pin.
   */
  it('does not draw clay over a row a carve fused into the scenery', async () => {
    const geometry = {
      version: EXAMPLE_BLUEPRINT_ANSWER.geometry.version,
      nodes: [
        { kind: 'fixture', variant: 'crate', at: [0, 0.3, 0] },
        // Řez o hraně 1 stojící 6 m stranou: bednu na řádku 0 mine celou.
        { kind: 'carve', child: 0, at: [6, 0, 0], size: [1, 1, 1] },
        { kind: 'fixture', variant: 'crate', at: [12, 0.3, 0] },
        { kind: 'group', children: [1, 2] },
      ],
      root: 3,
    };
    const objects = blueprint().objects.slice(0, 2).map((object, index) => ({
      ...object,
      source: { kind: 'geom' as const, node: index === 0 ? 0 : 2 },
    }));

    const world = built(await build(compiled(blueprint({ geometry, objects, shapes: [] }))));
    const swallowed = world.slots[0];

    expect(swallowed.form.rung).toBe('semantic-clay');
    expect(swallowed.form.kind === 'clay' && swallowed.form.reason).toContain('carve above it');
    expect(swallowed.form.kind === 'clay' && swallowed.form.drawn).toBe(false);
    expect(world.slots[1].form.rung).toBe('g2-rich');

    // A ta geometrie tam doopravdy stojí — kdyby řez bednu smazal, věta výš
    // by mluvila o obraze, ve kterém nic není.
    const baked = bakePlacements(world.scenery);
    expect(baked.getAttribute('position').count).toBeGreaterThan(0);
    baked.dispose();
  });

  /**
   * **Cíl kotvy je dosažitelný a přesto v obraze není — a tam se bedna kreslí.**
   *
   * `anchorTo` si z cíle přečte kvádr a kusy zahodí, takže objekt na řádku 0
   * nedostane nic a ani nic nezůstane stát na jeho místě. To je opačné
   * rozhodnutí než u řezu, a rozhoduje o něm jediná otázka: je tam něco vidět?
   * Kdyby se i tady mlčelo, objekt zmizí úplně — a chybějící objekt se nedá
   * ani najít, natož vyměnit.
   *
   * Věta navíc musí mířit na správnou příčinu: do 2. 9. 2026 dostal tenhle
   * řádek tutéž hlášku jako řádek slepený řezem.
   */
  it('draws clay for a row that only an anchorTo target reaches, and says so', async () => {
    const geometry = {
      version: EXAMPLE_BLUEPRINT_ANSWER.geometry.version,
      nodes: [
        { kind: 'fixture', variant: 'crate', at: [0, 0.3, 0] },
        { kind: 'fixture', variant: 'crate', at: [6, 0.3, 0] },
        { kind: 'anchorTo', child: 1, target: 0, site: 'top' },
      ],
      root: 2,
    };
    const objects = blueprint().objects.slice(0, 2).map((object, index) => ({
      ...object,
      source: { kind: 'geom' as const, node: index === 0 ? 0 : 1 },
    }));

    const world = built(await build(compiled(blueprint({ geometry, objects, shapes: [] }))));
    const target = world.slots[0];

    expect(target.form.rung).toBe('semantic-clay');
    expect(target.form.kind === 'clay' && target.form.reason).toContain('anchorTo target');
    expect(target.form.kind === 'clay' && target.form.drawn).toBe(true);
    expect(world.slots[1].form.rung).toBe('g2-rich');
  });

  it('still hands back a world when the whole composition compiles to nothing', async () => {
    const geometry = {
      version: EXAMPLE_BLUEPRINT_ANSWER.geometry.version,
      nodes: [
        { kind: 'fixture', variant: 'crate', at: [0, 0.3, 0] },
        { kind: 'carve', child: 0, at: [0, 0, 0], size: [40, 40, 40] },
      ],
      root: 1,
    };
    const objects = blueprint().objects.slice(0, 2).map((object, index) => ({
      ...object,
      source: { kind: 'geom' as const, node: index },
    }));

    const world = built(await build(compiled(blueprint({ geometry, objects, shapes: [] }))));
    expect(world.scenery).toEqual([]);
    expect(world.slots).toHaveLength(2);
    for (const entry of world.slots) {
      expect(entry.form.rung).toBe('semantic-clay');
      expect(entry.form.kind === 'clay' && entry.form.reason).toContain('empty geometry');
      expect(entry.form.kind === 'clay' && entry.form.drawn).toBe(true);
      expect(spanOf(entry.slot.worldBounds, 1)).toBeGreaterThan(0);
    }
  });

  it('leaves compilePlacements() alone when nobody asks for owners', () => {
    const plain = compilePlacements(EXAMPLE_BLUEPRINT_ANSWER.geometry);
    expect(plain).toHaveLength(20);
    expect(plain.every((placement) => placement.owner === undefined)).toBe(true);
  });

  /**
   * **Kotva rozmnoženého vlastníka sedí na kusu, ne v mezeře mezi kopiemi.**
   *
   * `mirror` nad kusem na `x = +8` dá kopie na ±8, takže obal celku sahá
   * −8,33..8,33 a jeho střed je `x = 0` — bod, ve kterém není nic. Kotva
   * odvozená ze středu obalu tam tedy visí v prázdnu, a **na obraze to
   * vypadá úplně stejně jako kotva na místě**, protože kotva se nekreslí.
   * Ozve se až o vlnu dál: `base` je „na tomhle stojí" a `top` „tohle si na
   * něj polož", takže druhá věta postaví lucernu doprostřed průchodu.
   *
   * A ozve se **napořád**: design book §13.2 dělá z transformace slotu
   * a z kotev invariant hot-swapu, takže se chybná poloha zamrzne a přenese
   * i na podrobnou podobu, kterou do slotu vymění vlna 3.
   *
   * Pin k opravě `bae3838`, dopsaný 1. 9. 2026 — do té doby byla oprava
   * commitnutá bez testu, který by ji soudil.
   *
   * **Proč `+8`, a ne `|8|`.** Obě kopie jsou od středu stejně daleko, takže
   * o shodě rozhoduje **pořadí**, ne souřadnice: originál je v poli před svým
   * odrazem. Kdyby se remíza lámala náhodou, dalo by jedno semínko dva různé
   * světy — proto se pinuje ta konkrétní strana.
   */
  it('seats a mirrored owner on one of its pieces, not in the gap between them', async () => {
    const geometry = {
      version: EXAMPLE_BLUEPRINT_ANSWER.geometry.version,
      nodes: [
        { kind: 'fixture', variant: 'crate', at: [8, 0.3, 0] },
        { kind: 'mirror', child: 0, axis: 'x' },
        { kind: 'fixture', variant: 'crate', at: [0, 0.3, 6] },
        { kind: 'group', children: [1, 2] },
      ],
      root: 3,
    };
    const objects = blueprint().objects.slice(0, 2).map((object, index) => ({
      ...object,
      source: { kind: 'geom' as const, node: index === 0 ? 1 : 2 },
    }));

    const world = built(await build(compiled(blueprint({ geometry, objects, shapes: [] }))));
    const [mirrored, single] = world.slots.map((entry) => entry.slot);

    // Dvě kopie, jeden vlastník, a střed jeho obalu je doopravdy v prázdnu.
    expect(world.slots[0].form.kind === 'placements' && world.slots[0].form.placements).toHaveLength(2);
    expect(boundsCenter(mirrored.worldBounds)[0]).toBeCloseTo(0, 6);
    expect(mirrored.localBounds.max[0]).toBeCloseTo(8.33, 2);

    const base = mirrored.anchors.find((anchor) => anchor.name === 'base')!;
    const top = mirrored.anchors.find((anchor) => anchor.name === 'top')!;

    // Tady to celé stojí: ne na nule, ale na kusu.
    expect(base.at[0]).toBeCloseTo(8, 5);
    expect(top.at[0]).toBeCloseTo(8, 5);
    // Obě na TÉMŽ kusu — `base` z jednoho a `top` z druhého by byla dvojice,
    // která spolu svisle nesouvisí.
    expect(top.at[0]).toBe(base.at[0]);
    expect(top.at[2]).toBe(base.at[2]);
    // A ve světě padnou dovnitř toho kusu, ne jen mimo počátek.
    expect(toWorld(mirrored.transform, base.at)[0]).toBeCloseTo(8, 5);

    /**
     * Jednokusový vlastník se hnout nesmí: jeho kus **je** celek, takže
     * platí pořád pravidlo ze středu obalu — přesně to, co dělal
     * `derivedAnchors()` před `bae3838`.
     */
    const soleBase = single.anchors.find((anchor) => anchor.name === 'base')!;
    const soleTop = single.anchors.find((anchor) => anchor.name === 'top')!;
    expect(soleBase.at).toEqual([0, single.localBounds.min[1], 0]);
    expect(soleTop.at).toEqual([0, single.localBounds.max[1], 0]);
  });
});

/* ------------------------------------------------------------------ *
 * 5. Žebřík.
 * ------------------------------------------------------------------ */

describe('the fallback ladder is a closed list, not a guess', () => {
  it('names the six rungs of the design book in its order', () => {
    expect(PROXY_RUNGS).toEqual([
      'g3-ready',
      'g3-reduced',
      'g2-rich',
      'g2-reduced',
      'semantic-clay',
      'declined',
    ]);
  });

  /**
   * Hrubý svět obsazuje tři příčky. `g3-ready` patří hot-swapu (vlna 3 T20)
   * a `g2-reduced` adaptivní kvalitě (vlna 5 T26) — až je některá z nich
   * začne vyrábět, spadne tenhle test a příčka se **dopíše**, místo aby se
   * v hrubém světě objevila sama.
   */
  it('lets the rough world occupy only the three rungs it can honestly reach', async () => {
    expect([...ROUGH_RUNGS]).toEqual(['g3-reduced', 'g2-rich', 'semantic-clay']);

    const worlds = [
      await build(),
      await build(compiled(blueprint()), async () => {
        throw new Error('rejected');
      }),
      await build(compiled(blueprint({ shapes: [] }))),
    ];
    for (const world of worlds) {
      for (const entry of built(world).slots) {
        expect(ROUGH_RUNGS).toContain(entry.form.rung);
      }
    }
  });

  it('declines the whole world only when there is no blueprint to stand on', async () => {
    const unavailable = await build({
      kind: 'unavailable',
      detail: 'upstream timed out',
      cause: new Error('upstream timed out'),
      rounds: [],
    });
    expect(unavailable.kind).toBe('declined');
    expect(unavailable.kind === 'declined' && unavailable.reason).toContain('upstream timed out');

    const rejected = await build({
      kind: 'rejected',
      fault: { reason: 'SHAPE_INVALID', detail: 'shapes[0]: node 2 is empty', issues: [] },
      rounds: [],
    });
    expect(rejected.kind).toBe('declined');
    expect(rejected.kind === 'declined' && rejected.reason.length).toBeGreaterThan(0);
  });

  it('does not blame the model for a request that never reached it', async () => {
    // Tuhle větu čte porotce. „The model did not answer" by o běhu, ve kterém
    // se model nevolal, tvrdilo nepravdu — a hledalo by se to v síti.
    const ours = await build({
      kind: 'invalidInput',
      detail: 'sessionSeed: Too small: expected int to be >=0',
      rounds: [],
    });

    expect(ours.kind).toBe('declined');
    if (ours.kind !== 'declined') throw new Error(ours.kind);
    expect(ours.reason).not.toContain('the model did not answer');
    expect(ours.reason).toContain('sessionSeed');
  });
});
