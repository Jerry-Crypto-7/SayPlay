/**
 * **Obálka blueprintu (P13 T11).**
 *
 * Vada, kterou tu hledáme, je jediného druhu: **obálka si kontrakt opsala
 * místo aby ho importovala**. Opsané schéma vypadá správně, projde překladačem
 * i vlastními testy a rozejde se s originálem až ve chvíli, kdy někdo změní
 * originál — a nikde se to neohlásí. V tomhle repu se to už jednou stalo
 * a stálo to **0 z 15** zmrazených emisí, aniž si toho kterýkoli test všiml.
 *
 * Testuje se to nepřímo, protože přímo to nejde: každé tvrzení níž si vezme
 * vadu, kterou zná **výhradně cizí schéma**, a čeká ji na výstupu obálky.
 * Kdyby si obálka napsala vlastní, ta vada by prošla.
 */

import { describe, expect, it } from 'vitest';

import { GEOM_VERSION } from '@/geom/program';
import { sealSimHash } from '@/ir/worlddoc';
import { repairEmission } from '@/model/repair';
import { EXAMPLE_PLAN } from '@/model/worldstream-examples';
import { EXAMPLE_BLUEPRINT_ANSWER } from '@/model/worldstream-prompt';
import { readPlannerEmission } from '@/model/worldstream-intent';
import { shapeProgramSchema } from '@/shape/schema';
import { SHAPE_LIMITS, type ShapeNode } from '@/shape/types';

import { findBlueprintReferenceIssues } from '../references';
import {
  BLUEPRINT_VERSION,
  BLUEPRINT_VERSION_V2,
  MAX_HERO_SHAPES,
  MIN_TARGET_EXTENT,
  WORLD_COORDINATE_LIMIT,
  blueprintSchema,
  validateBlueprint,
  type WorldstreamBlueprint,
} from '../schema';

/**
 * Zapečetěný `WorldDoc` z ukázkové odpovědi.
 *
 * Přes `repairEmission` schválně: ukázka **nepíše svědka** (kontrakt to
 * výslovně zakazuje, hledá ho systém), takže bez opravy by jí `simSchema`
 * vytkla chybějící `sim.witness` a fixtura by testovala něco jiného, než
 * čím produkt doopravdy prochází.
 */
function sealedWorld(): unknown {
  return sealSimHash(repairEmission(EXAMPLE_BLUEPRINT_ANSWER.world).document as { sim: unknown });
}

/** Blueprint, který projde. Testy si z něj berou kopii a kazí jednu věc. */
function validBlueprint(): Record<string, unknown> {
  return {
    version: BLUEPRINT_VERSION,
    sessionSeed: 4021,
    title: 'a hillside terrace of beehives behind a low drystone wall',
    intent: EXAMPLE_PLAN.intent,
    world: sealedWorld(),
    geometry: EXAMPLE_BLUEPRINT_ANSWER.geometry,
    objects: [
      {
        stableId: 'tallHive',
        label: 'the tallest hive',
        synonyms: ['the hive', 'the tall hive'],
        role: 'hero',
        source: { kind: 'shape', shapeId: 'tallHiveShape' },
        targetBounds: { min: [-0.9, 0.6, 1.1], max: [0.9, 2.4, 2.9] },
        importance: 3,
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
    ],
    shapes: EXAMPLE_BLUEPRINT_ANSWER.shapes,
  };
}

/** Kopie s jednou změněnou cestou. Vrací `unknown`, aby test kazil, ne psal. */
function withField(patch: Record<string, unknown>): unknown {
  return { ...validBlueprint(), ...patch };
}

describe('blueprint envelope', () => {
  it('accepts the example world, geometry and shapes as one document', () => {
    const verdict = validateBlueprint(validBlueprint());
    expect(verdict.issues).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('parses into the shape the rest of the pipeline reads', () => {
    const blueprint: WorldstreamBlueprint = blueprintSchema.parse(validBlueprint());
    expect(blueprint.version).toBe(BLUEPRINT_VERSION);
    expect(blueprint.intent.spatialThesis).toBe(EXAMPLE_PLAN.intent.spatialThesis);
    expect(blueprint.objects.map((object) => object.stableId)).toEqual([
      'tallHive',
      'drystoneWall',
    ]);
  });

  it('rejects a field the envelope does not declare', () => {
    expect(validateBlueprint(withField({ materials: [] })).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Skládá se importem — každé tvrzení používá vadu, kterou zná jen cizí schéma.
 * ------------------------------------------------------------------ */

describe('the envelope composes the frozen contracts', () => {
  it('rejects a world whose seal is missing, which only worldDocSchema knows about', () => {
    const world = sealedWorld() as Record<string, unknown>;
    const { simHash: _dropped, ...unsealed } = world;
    expect(validateBlueprint(withField({ world: unsealed })).ok).toBe(false);
  });

  it('rejects a world with a root field of its own, because that root is closed', () => {
    const world = { ...(sealedWorld() as Record<string, unknown>), shapes: [] };
    expect(validateBlueprint(withField({ world })).ok).toBe(false);
  });

  it('rejects a world missing a sim field, which only simSchema enumerates', () => {
    const world = sealedWorld() as { sim: Record<string, unknown> };
    const { collisionAabb: _dropped, ...sim } = world.sim;
    expect(validateBlueprint(withField({ world: { ...world, sim } })).ok).toBe(false);
  });

  it('rejects geometry under a version string the geom program does not use', () => {
    const geometry = { ...EXAMPLE_BLUEPRINT_ANSWER.geometry, version: 'geom-program-v2' };
    const issues = validateBlueprint(withField({ geometry })).issues;
    expect(issues.join(' ')).toContain('geometry/version');
  });

  it('rejects a kit variant the geom program never declared', () => {
    const nodes = EXAMPLE_BLUEPRINT_ANSWER.geometry.nodes.map((node) =>
      node.kind === 'panel' ? { ...node, variant: 'drystone' } : node,
    );
    const geometry = { ...EXAMPLE_BLUEPRINT_ANSWER.geometry, nodes };
    expect(validateBlueprint(withField({ geometry })).ok).toBe(false);
  });

  it('rejects a shape table over the node ceiling, which only SHAPE_LIMITS knows', () => {
    const filler: ShapeNode = { kind: 'sphere', radius: 0.2 };
    const shape = {
      ...EXAMPLE_BLUEPRINT_ANSWER.shapes[0],
      nodes: Array.from({ length: SHAPE_LIMITS.maxNodes + 1 }, () => filler),
      root: 0,
    };
    expect(validateBlueprint(withField({ shapes: [shape] })).ok).toBe(false);
    // Protipůlka: přesně na stropu to projde vlastním schématem tvaru, takže
    // test výš měří strop, ne nějakou jinou vadu té fixtury.
    expect(
      shapeProgramSchema.safeParse({
        ...shape,
        nodes: Array.from({ length: SHAPE_LIMITS.maxNodes }, () => filler),
      }).success,
    ).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * `intent` je plannerova definice, ne druhá.
 * ------------------------------------------------------------------ */

describe('intent has one definition, the planner one', () => {
  it('rejects an intent the planner gate also rejects', () => {
    const { unsupported: _dropped, ...intent } = EXAMPLE_PLAN.intent;
    // Nejdřív se ověří, že to opravdu je vada podle plannera — jinak by tenhle
    // test mohl zezelenat proto, že obálka odmítá něco úplně jiného.
    const planVerdict = readPlannerEmission({ intent, objects: EXAMPLE_PLAN.objects });
    expect(planVerdict.ok).toBe(false);

    const issues = validateBlueprint(withField({ intent })).issues;
    expect(issues.join(' ')).toContain('unsupported');
  });

  it('rejects a missing intent, which a bare z.unknown() would have let through', () => {
    const { intent: _dropped, ...rest } = validBlueprint();
    expect(validateBlueprint(rest).ok).toBe(false);
  });

  it('rejects an explicitly undefined intent for the same reason', () => {
    expect(validateBlueprint(withField({ intent: undefined })).ok).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Rozpočty obálky.
 * ------------------------------------------------------------------ */

describe('budgets', () => {
  it('agrees with the geom and shape languages about how far the world reaches', () => {
    const far = WORLD_COORDINATE_LIMIT + 1;
    const objects = [
      {
        ...(validBlueprint().objects as Record<string, unknown>[])[1],
        targetBounds: { min: [-1, 0, -1], max: [far, 1, 1] },
      },
    ];
    expect(validateBlueprint(withField({ objects })).ok).toBe(false);

    // Táž mez v obou cizích jazycích. Kdyby se kterákoli pohnula, tenhle
    // řádek zčervená dřív, než se blueprintem dostane objekt mimo kompozici.
    expect(
      shapeProgramSchema.safeParse({
        ...EXAMPLE_BLUEPRINT_ANSWER.shapes[0],
        targetBounds: { min: [-1, -1, -1], max: [far, 1, 1] },
      }).success,
    ).toBe(false);
    const nodes = [
      { kind: 'mass', variant: 'block', at: [far, 0, 0] },
      { kind: 'group', children: [0] },
    ];
    expect(
      validateBlueprint(withField({ geometry: { version: GEOM_VERSION, nodes, root: 1 } })).ok,
    ).toBe(false);
  });

  it('rejects a target box with no thickness, because the mesh is normalised through it', () => {
    const objects = [
      {
        ...(validBlueprint().objects as Record<string, unknown>[])[1],
        targetBounds: { min: [-1, 0, -1], max: [1, 0, 1] },
      },
    ];
    expect(validateBlueprint(withField({ objects })).ok).toBe(false);

    // A o vlásek tlustší kvádr projde, takže výš se měří tloušťka, ne cokoli jiného.
    const opened = [
      {
        ...(validBlueprint().objects as Record<string, unknown>[])[1],
        targetBounds: { min: [-1, 0, -1], max: [1, MIN_TARGET_EXTENT, 1] },
      },
    ];
    expect(validateBlueprint(withField({ objects: opened })).ok).toBe(true);
  });

  it('rejects a fourth hero shape, which the mesh budget could never render', () => {
    const shape = EXAMPLE_BLUEPRINT_ANSWER.shapes[0];
    const many = Array.from({ length: MAX_HERO_SHAPES + 1 }, (_unused, index) => ({
      ...shape,
      shapeId: `${shape.shapeId}${index}`,
    }));
    expect(validateBlueprint(withField({ shapes: many })).ok).toBe(false);
    expect(validateBlueprint(withField({ shapes: many.slice(0, MAX_HERO_SHAPES) })).ok).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * Křížové odkazy.
 * ------------------------------------------------------------------ */

describe('cross references', () => {
  const parse = (patch: Record<string, unknown>): WorldstreamBlueprint =>
    blueprintSchema.parse({ ...validBlueprint(), ...patch });

  it('is silent on a blueprint whose links agree', () => {
    expect(findBlueprintReferenceIssues(parse({}))).toEqual([]);
  });

  it('catches an object sourcing from a shape nobody declared', () => {
    const objects = (validBlueprint().objects as Record<string, unknown>[]).map((object) =>
      object.stableId === 'tallHive'
        ? { ...object, source: { kind: 'shape', shapeId: 'noSuchShape' } }
        : object,
    );
    const found = findBlueprintReferenceIssues(parse({ objects }));
    expect(found.map((issue) => issue.detail).join(' ')).toContain('noSuchShape');
  });

  it('catches a shape whose object never sources from it', () => {
    const objects = (validBlueprint().objects as Record<string, unknown>[]).map((object) =>
      object.stableId === 'tallHive' ? { ...object, source: { kind: 'geom', node: 4 } } : object,
    );
    const found = findBlueprintReferenceIssues(parse({ objects }));
    expect(found.map((issue) => issue.detail).join(' ')).toContain('meshed and never shown');
  });

  it('catches a link that runs only one way', () => {
    // Oba konce existují a oba jsou obsazené: tvar patří zdi, ale sourcuje z něj
    // úl. Ani „tvar nikdo nenárokuje", ani „objekt neexistuje" to nechytí —
    // tohle je jediná kontrola, která na to sahá.
    const shapes = [{ ...EXAMPLE_BLUEPRINT_ANSWER.shapes[0], stableId: 'drystoneWall' }];
    const found = findBlueprintReferenceIssues(parse({ shapes }));
    expect(found.map((issue) => issue.detail).join(' ')).toContain(
      'belongs to drystoneWall, not to tallHive',
    );
  });

  it('catches a shape claiming an object that does not exist', () => {
    const shapes = [{ ...EXAMPLE_BLUEPRINT_ANSWER.shapes[0], stableId: 'ghostHive' }];
    const objects = (validBlueprint().objects as Record<string, unknown>[]).map((object) =>
      object.stableId === 'tallHive' ? { ...object, source: { kind: 'geom', node: 4 } } : object,
    );
    const found = findBlueprintReferenceIssues(parse({ shapes, objects }));
    expect(found.map((issue) => issue.detail).join(' ')).toContain('belong to nobody');
  });

  it('catches an object pointing at a geometry row outside the table', () => {
    const objects = (validBlueprint().objects as Record<string, unknown>[]).map((object) =>
      object.stableId === 'drystoneWall' ? { ...object, source: { kind: 'geom', node: 40 } } : object,
    );
    const found = findBlueprintReferenceIssues(parse({ objects }));
    expect(found.map((issue) => issue.detail).join(' ')).toContain('outside the table');
  });

  it('catches an object pointing at a row nothing ever builds', () => {
    // Řádek 1 je zdrojová zeď pro `repeat` na řádku 2. Sám o sobě se do světa
    // nedostane — z kořene se na něj dojde jen přes ten `repeat`, takže je
    // dosažitelný. Nedosažitelný je až řádek, který v `group` nikde nestojí.
    const nodes = [
      ...EXAMPLE_BLUEPRINT_ANSWER.geometry.nodes,
      { kind: 'mass', variant: 'block', at: [0, 0, 0] },
    ];
    const geometry = { ...EXAMPLE_BLUEPRINT_ANSWER.geometry, nodes };
    const objects = (validBlueprint().objects as Record<string, unknown>[]).map((object) =>
      object.stableId === 'drystoneWall' ? { ...object, source: { kind: 'geom', node: 9 } } : object,
    );
    const found = findBlueprintReferenceIssues(parse({ geometry, objects }));
    expect(found.map((issue) => issue.detail).join(' ')).toContain('never built');
  });

  it('catches two objects claiming one shape', () => {
    const objects = (validBlueprint().objects as Record<string, unknown>[]).map((object) =>
      object.stableId === 'drystoneWall'
        ? { ...object, source: { kind: 'shape', shapeId: 'tallHiveShape' } }
        : object,
    );
    const found = findBlueprintReferenceIssues(parse({ objects }));
    expect(found.map((issue) => issue.detail).join(' ')).toContain('already taken');
  });

  /**
   * **Druhý nárok na řádek kompozice, hlášený tam, kde ho model ještě opraví.**
   *
   * Do 2. 9. 2026 to chytal až `buildProxyWorld()` — jenže ten běží za opravným
   * kolem, takže se model o sporu nikdy nedozvěděl a druhý objekt zůstal na
   * hlíně natrvalo. Rozdělit řádek mezi dva objekty přitom nejde: `repeat` ani
   * `mirror` nedávají kopiím vlastní identitu.
   */
  it('catches two objects claiming one composition row', () => {
    const objects = (validBlueprint().objects as Record<string, unknown>[]).map((object) =>
      object.stableId === 'tallHive' ? { ...object, source: { kind: 'geom', node: 2 } } : object,
    );
    const found = findBlueprintReferenceIssues(parse({ objects }));
    expect(found.map((issue) => issue.detail).join(' ')).toContain(
      'names geometry node 2, already taken by objects/0',
    );
  });

  /**
   * **Cíl kotvy je dosažitelný a přesto se z něj nikdy nic nepostaví.**
   *
   * `anchorTo` si z cíle přečte kvádr a kusy zahodí. Dosažitelnost přes
   * `reachableFrom` ho tedy pustí — a musí, jinak by `structuralIssues`
   * prohlásilo každý cíl kotvy za sirotka. Objekt, který si takový řádek
   * nárokuje, ale nedostane ani jeden trojúhelník, a hláška o něm musí mířit
   * na kotvu, ne na obecnou nedosažitelnost.
   */
  it('catches an object sourcing from a row only an anchorTo target reaches', () => {
    const nodes = [
      ...EXAMPLE_BLUEPRINT_ANSWER.geometry.nodes,
      { kind: 'fixture', variant: 'crate', at: [0, 0.3, 0] },
      { kind: 'fixture', variant: 'crate', at: [6, 0.3, 0] },
      { kind: 'anchorTo', child: 10, target: 9, site: 'top' },
    ];
    const root = nodes.length - 1;
    const geometry = { ...EXAMPLE_BLUEPRINT_ANSWER.geometry, nodes, root };
    const objects = (validBlueprint().objects as Record<string, unknown>[]).map((object) =>
      object.stableId === 'drystoneWall' ? { ...object, source: { kind: 'geom', node: 9 } } : object,
    );
    const found = findBlueprintReferenceIssues(parse({ geometry, objects }));
    const detail = found.map((issue) => issue.detail).join(' ');
    expect(detail).toContain('only as an anchorTo target');
    expect(detail).not.toContain('cannot be reached');
  });

  it('catches two objects sharing one stableId', () => {
    const [hero, wall] = validBlueprint().objects as Record<string, unknown>[];
    const found = findBlueprintReferenceIssues(
      parse({ objects: [hero, { ...wall, stableId: 'tallHive' }] }),
    );
    expect(found.map((issue) => issue.detail).join(' ')).toContain('already used');
  });
});

/* ------------------------------------------------------------------ *
 * Vazby vzhledu (P22 T12) – volitelné pole v2, starý tvar bez něj prochází.
 * ------------------------------------------------------------------ */

describe('look bindings', () => {
  const storm = [{ variable: 'hiveCalm', values: { '0': 'day', '1': 'storm' } }];

  it('keeps validating the old envelope, which never carried lookBindings', () => {
    const verdict = validateBlueprint(validBlueprint());
    expect(verdict.issues).toEqual([]);
    expect(validateBlueprint(withField({ version: BLUEPRINT_VERSION_V2 })).ok).toBe(true);
  });

  it('accepts a v2 envelope binding a flag to presets and parses it through', () => {
    const blueprint = blueprintSchema.parse(withField({ version: BLUEPRINT_VERSION_V2, lookBindings: storm }));
    expect(blueprint.lookBindings).toEqual(storm);
  });

  it('requires worldstream-v2 for lookBindings, like assets and bindings', () => {
    const verdict = validateBlueprint(withField({ lookBindings: storm }));
    expect(verdict.ok).toBe(false);
    expect(verdict.issues.join(' ')).toContain('lookBindings');
  });

  it('rejects a preset outside the five, a non-integer key, an empty table and an extra field', () => {
    const v2 = (lookBindings: unknown) => validateBlueprint(withField({ version: BLUEPRINT_VERSION_V2, lookBindings })).ok;
    expect(v2([{ variable: 'hiveCalm', values: { '1': 'purple' } }])).toBe(false);
    expect(v2([{ variable: 'hiveCalm', values: { on: 'storm' } }])).toBe(false);
    expect(v2([{ variable: 'hiveCalm', values: {} }])).toBe(false);
    expect(v2([{ variable: 'hiveCalm', values: { '1': 'storm' }, tween: 0.5 }])).toBe(false);
    expect(v2([{ variable: 'hive calm', values: { '1': 'storm' } }])).toBe(false);
    expect(v2([{ variable: 'hiveCalm', values: { '0': 'day', '1': 'storm' } }])).toBe(true);
  });

  it('catches a binding on a variable the simulation never declared', () => {
    const parse = (lookBindings: unknown) => blueprintSchema.parse(withField({ version: BLUEPRINT_VERSION_V2, lookBindings }));
    expect(findBlueprintReferenceIssues(parse(storm))).toEqual([]);
    const issues = findBlueprintReferenceIssues(parse([{ variable: 'weather', values: { '1': 'storm' } }]));
    expect(issues).toHaveLength(1);
    expect(issues[0].where).toBe('lookBindings/0/variable');
    expect(issues[0].detail).toContain('weather');
  });
});
