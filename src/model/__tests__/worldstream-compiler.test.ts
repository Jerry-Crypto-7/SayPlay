/**
 * **Compiler (P13 T11).** Sada je `full`, protože tahle cesta rozhoduje, jestli
 * tvrzení „model generuje 3D" vůbec platí. Když je vadná, produkt lže — a lže
 * způsobem, který na obrazovce vypadá dobře, protože `chooseFamily()` postaví
 * hezkou kulisu ke každé větě.
 *
 * Pět tvrzení, každé s vlastní protipůlkou:
 *
 *   1. **Geometrie je z odpovědi modelu.** Dokazuje se třikrát a pokaždé jinak:
 *      lexikálně (compiler `family-choice` neimportuje), zamítavě (jméno místo
 *      programu je `GEOMETRY_NOT_AUTHORED`) a kanonicky (co vyšlo, je bajt po
 *      bajtu to, co model napsal — nic se cestou nepodstrčilo).
 *   2. **Opsaná ukázka se odmítá**, a to i ta chytrá: tabulka z ukázky
 *      s přejmenovanými placements.
 *   3. **`WorldDoc.sim` projde stávajícím loweringem i hledačem svědka.**
 *      Ne „schéma prošlo" — svět se doopravdy sníží do běhového tvaru a najde
 *      se v něm cesta k výhře.
 *   4. **Osekává se jen číslo, a přiznaně.** Tvar se odmítá.
 *   5. **Spojení s plánem drží identitu.** Model nemůže přepsat `label`, `role`
 *      ani `importance`, protože je vůbec nepíše.
 *
 * ## Proč se šťastná cesta NEzkouší na ukázce z promptu
 *
 * Ukázka je jediná odpověď, kterou compiler přijmout **nesmí** — je to přesně
 * ten dokument, proti kterému měří opisování. Fixtura je proto vlastní odpověď
 * na týž plán a ukázka se ověřuje zvlášť, po částech: její geometrie projde
 * jazykem, její tvar taky a její svět se certifikuje. Kdyby se ukázka jen
 * použila jako fixtura, buď by ochrana proti opisování nemohla existovat, nebo
 * by tahle sada nešla napsat.
 *
 * Co se tu **nedokazuje:** že model odpovídá dobře. Živě se to měří v T14.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { GEOM_VERSION, validateGeomProgram } from '../../geom/program';
import { buildRuntimeWorld } from '../../ir/build';
import { ID_PATTERN } from '../../ir/types';
import { canonical } from '../../ir/worlddoc';
import { SCHEMA_NODE_KINDS, SHAPE_IDENTIFIER_PATTERN, validateShapeProgram } from '../../shape/schema';
import { solveWitness } from '../../verify/solve';
import { verifyWitness } from '../../verify/witness';
import { blueprintSchema } from '../../worldstream/schema';
import { asset } from '@/assets/__fixtures__/catalog';
import { createAssetManifest } from '@/assets/manifest';
import { type Grammar, type UpstreamRequest } from '../prompt';
import {
  BLUEPRINT_EXAMPLE_MARKER,
  EXAMPLE_BLUEPRINT_ANSWER,
  WORLD_CONTRACT_END,
  WORLD_CONTRACT_MARKER,
  buildCompilerRequest,
  capabilityManifest,
} from '../worldstream-prompt';
import { repairEmission } from '../repair';
import { compileBlueprint, type CompilerResult } from '../worldstream-compiler';
import { blueprintRejectionSentence } from '../worldstream-repair';
import { EXAMPLE_PLAN } from '../worldstream-examples';
import type { PlannerEmission } from '../worldstream-intent';

/** Slovník **čtený ze zmrazeného souboru**, nikdy opsaný. */
const grammar = (): Grammar => {
  const protocol = JSON.parse(
    readFileSync(new URL('../../../evals/frozen/protocol.v1.json', import.meta.url), 'utf8'),
  ) as {
    grammar: { surfaceEvents: string[]; conditions: string[]; actions: string[] };
    worldDoc: { sim: { fields: string[] }; look: { fields: string[] } };
  };
  return {
    surfaceEvents: protocol.grammar.surfaceEvents,
    conditions: protocol.grammar.conditions,
    actions: protocol.grammar.actions,
    simFields: protocol.worldDoc.sim.fields,
    lookFields: protocol.worldDoc.look.fields,
  };
};

/**
 * Plán, ke kterému fixtura odpovídá.
 *
 * `beeHaze` je v něm schválně: je to jediná role, která geometrii nemá, a
 * odpověď ji neumisťuje. Bez ní by se cesta „efekt se vypustí a přizná se to"
 * v téhle sadě nikdy nespustila.
 */
const PLAN: PlannerEmission = {
  intent: {
    setting: 'a hillside terrace of beehives behind a low drystone wall',
    mood: 'warm, slow, humming',
    spatialThesis:
      'The wall holds the slope back in one straight line and the hives stand on the flat behind it, so the terrace reads as one shelf cut into the hill.',
    actors: ['the keeper'],
    heroObjects: ['the tallest hive'],
    interactions: ['the keeper smokes the tallest hive and its lid comes free'],
    unsupported: ['the bees are a haze, not individually simulated insects'],
  },
  objects: [
    {
      stableId: 'hillsideTerrace',
      label: 'the hillside terrace',
      synonyms: ['the terrace', 'the slope', 'the hill'],
      role: 'terrain',
      importance: 2,
    },
    {
      stableId: 'drystoneWall',
      label: 'the drystone wall',
      synonyms: ['the wall', 'the stone wall'],
      role: 'architecture',
      importance: 2,
    },
    {
      stableId: 'tallHive',
      label: 'the tallest hive',
      synonyms: ['the hive', 'the tall hive', 'the skep'],
      role: 'hero',
      importance: 3,
    },
    {
      stableId: 'smokerBox',
      label: "the smoker's box",
      synonyms: ['the box', 'the smoker box'],
      role: 'prop',
      importance: 1,
    },
    {
      stableId: 'beeHaze',
      label: 'the haze of bees',
      synonyms: ['the bees', 'the haze'],
      role: 'effect',
      importance: 0,
    },
  ],
};

const UPSTREAM: UpstreamRequest = { model: 'test', system: 'system', user: 'user' };

const compile = (answer: unknown): CompilerResult =>
  compileBlueprint(answer, PLAN, { sessionSeed: 4021, upstream: UPSTREAM });

/* ------------------------------------------------------------------ *
 * Fixtura: vlastní odpověď na týž plán.
 * ------------------------------------------------------------------ */

const OWN_GEOMETRY: Record<string, unknown> = {
  version: GEOM_VERSION,
  nodes: [
    { kind: 'terrain', variant: 'plateau', extent: [20, 20], amplitude: 0.4, seed: 3 },
    { kind: 'column', variant: 'post', at: [-3, 0.5, 0] },
    { kind: 'repeat', child: 1, count: 4, step: [2, 0, 0] },
    { kind: 'fixture', variant: 'crate', at: [2, 0.3, 3] },
    { kind: 'group', children: [0, 2, 3] },
  ],
  root: 4,
};

const OWN_SHAPE: Record<string, unknown> = {
  shapeId: 'hivePost',
  stableId: 'tallHive',
  nodes: [
    { kind: 'prism', sides: 6, radius: 0.5, height: 1.4 },
    { kind: 'taper', child: 0, axis: 'y', amount: 0.6 },
  ],
  root: 1,
  targetBounds: { min: [-0.7, -0.9, -0.7], max: [0.7, 0.9, 0.7] },
  anchors: [{ name: 'cap', at: [0, 0.8, 0], normal: [0, 1, 0] }],
  materialIntent: 'timber',
  priority: 8,
};

const OWN_PLACEMENTS: Record<string, unknown>[] = [
  {
    stableId: 'hillsideTerrace',
    source: { kind: 'geom', node: 0 },
    targetBounds: { min: [-10, -1, -10], max: [10, 1, 10] },
  },
  {
    stableId: 'drystoneWall',
    source: { kind: 'geom', node: 2 },
    targetBounds: { min: [-3.5, 0, -0.5], max: [3.5, 1.2, 0.5] },
  },
  {
    stableId: 'tallHive',
    source: { kind: 'shape', shapeId: 'hivePost' },
    targetBounds: { min: [-0.7, 0, 1.3], max: [0.7, 1.8, 2.7] },
  },
  {
    stableId: 'smokerBox',
    source: { kind: 'geom', node: 3 },
    targetBounds: { min: [1.6, 0, 2.6], max: [2.4, 0.7, 3.4] },
  },
];

/**
 * Nejmenší svět, který se dá vyhrát: dojít k bráně. Jeden vstup, takže hledač
 * má co najít a přitom se svět nevyhraje sám — prázdná stopa se necertifikuje.
 */
const OWN_WORLD: Record<string, unknown> = {
  irVersion: 'v1',
  simRevision: 0,
  lookRevision: 0,
  sim: {
    layout: { width: 10, height: 6 },
    grid: { cell: 1 },
    sockets: { startPad: [1, 3], gatePad: [8, 3] },
    collisionAabb: { walker: [1, 3, 1, 1], postGate: [8, 3, 1, 2] },
    entities: {
      walker: { role: 'actor', socket: 'startPad', state: 'idle' },
      postGate: { role: 'goal', socket: 'gatePad', state: 'shut' },
    },
    state: { counters: {}, flags: {}, timers: {}, zones: {}, slots: 0 },
    rules: {
      win: {
        phase: 0,
        priority: 0,
        event: { kind: 'onEnterZone', entity: 'walker', zone: 'gatePad' },
        condition: null,
        actions: [{ kind: 'win' }],
      },
    },
  },
  look: {
    modules: { postGate: { family: 'panel', params: { thickness: 0.2 } } },
    palette: 'moss',
    lightRig: 'rim',
    atmosphere: 'clear',
    materialRoles: {},
    camera: { kind: 'orbit' },
    audio: {},
  },
};

const OWN_ANSWER: Record<string, unknown> = {
  geometry: OWN_GEOMETRY,
  shapes: [OWN_SHAPE],
  placements: OWN_PLACEMENTS,
  world: OWN_WORLD,
};

/** Kopie fixtury s jednou změněnou částí. */
const answerWith = (patch: Record<string, unknown>): unknown => ({ ...OWN_ANSWER, ...patch });

it('compiles approved asset placements as v2 and rejects a catalog miss', () => {
  const model = asset();
  const assets = createAssetManifest({ version: 'worldstream-assets-v1', assets: [model] });
  const answer = answerWith({ shapes: [], placements: OWN_PLACEMENTS.map(placement =>
    placement.stableId !== 'tallHive' ? placement : { ...placement,
      source: { kind: 'asset', assetId: model.assetId, version: model.version, hash: model.hash },
      binding: { entityId: 'postGate', collider: placement.targetBounds, sockets: [], parts: [{ id: 'body', sockets: [] }] },
    }) });
  const result = expectOk(compileBlueprint(answer, PLAN, { sessionSeed: 4021, upstream: UPSTREAM, assets }));
  expect(result.value.version).toBe('worldstream-v2');
  expect(result.value.objects.find(object => object.stableId === 'tallHive')?.binding?.entityId).toBe('postGate');
  const compact = structuredClone(answer) as {placements: {stableId:string;source:unknown}[]};
  compact.placements.find(placement=>placement.stableId==='tallHive')!.source={kind:'asset',key:`${model.assetId}@${model.version}`};
  expect(expectOk(compileBlueprint(compact,PLAN,{sessionSeed:4021,upstream:UPSTREAM,assets})).value).toEqual(result.value);
  expect(compileBlueprint(compact,PLAN,{sessionSeed:4021,upstream:UPSTREAM})).toMatchObject({ok:false,reason:'WRONG_SHAPE'});
  compact.placements.find(placement=>placement.stableId==='tallHive')!.source={kind:'asset',key:`${model.assetId}@${model.version}`,hash:'forged'};
  expect(compileBlueprint(compact,PLAN,{sessionSeed:4021,upstream:UPSTREAM,assets})).toMatchObject({ok:false,reason:'WRONG_SHAPE'});
  expect(compileBlueprint(answer, PLAN, { sessionSeed: 4021, upstream: UPSTREAM })).toMatchObject({ ok: false, reason: 'REFERENCE_BROKEN' });
});

function expectOk(result: CompilerResult): Extract<CompilerResult, { ok: true }> {
  if (!result.ok) throw new Error(`${result.reason}: ${result.detail}`);
  return result;
}

describe('P20 architecture is lowered through the production compiler', () => {
  const architecture = [{stableId:'readingRoom',kind:'room',at:[0,0,0],width:8,depth:4,height:3,thickness:0.2,openings:[{wall:'south',offset:3,width:2,height:2.2}]}];
  const plan: PlannerEmission = {...PLAN,objects:[{stableId:'readingRoom',label:'Reading room',synonyms:['room'],role:'architecture',importance:3}]};
  const answer = {architecture,geometry:{version:GEOM_VERSION,nodes:[],root:0},shapes:[],placements:[{stableId:'readingRoom',source:{kind:'architecture'},targetBounds:{min:[-4,0,-2],max:[4,3,2]}}],world:OWN_WORLD};
  it('compiles authored dimensions and openings without a reference-scene fallback', () => {
    const result = expectOk(compileBlueprint(answer,plan,{sessionSeed:4021,upstream:UPSTREAM}));
    expect(result.value.objects[0].source.kind).toBe('geom');
    expect(result.value.geometry.nodes.filter((node) => node.kind === 'sweep')).toHaveLength(7);
    expect(result.value.world.sim.entities).toHaveProperty('walker');
    expect(expectOk(compileBlueprint(answer,plan,{sessionSeed:4021,upstream:UPSTREAM})).value).toEqual(result.value);
  });
  it('refuses a table that physically blocks the authored opening', () => {
    const obstructed = {...answer,geometry:{version:GEOM_VERSION,nodes:[{kind:'fixture',variant:'crate',at:[0,0.3,2]}],root:0},placements:[...answer.placements,{stableId:'table',source:{kind:'geom',node:0},targetBounds:{min:[-0.5,0,1.5],max:[0.5,1,2.5]}}]};
    const withTable: PlannerEmission = {...plan,objects:[...plan.objects,{stableId:'table',label:'table',synonyms:[],role:'prop',importance:1}]};
    expect(compileBlueprint(obstructed,withTable,{sessionSeed:4021,upstream:UPSTREAM})).toMatchObject({ok:false,reason:'LAYOUT_INVALID',detail:expect.stringContaining('blocks opening')});
  });
  it('does not accept missing architecture identity', () => {
    expect(compileBlueprint({...answer,architecture:[{...architecture[0],stableId:'otherRoom'}]},plan,{sessionSeed:4021,upstream:UPSTREAM})).toMatchObject({ok:false,reason:'LAYOUT_INVALID'});
  });
});

/* ================================================================== *
 * 1. Šťastná cesta.
 * ================================================================== */

describe('an answer to the brief compiles', () => {
  const compiled = expectOk(compile(OWN_ANSWER));

  it('produces a blueprint the envelope itself accepts', () => {
    expect(blueprintSchema.safeParse(compiled.value).success).toBe(true);
  });

  it('certifies the world graph, so the place is provably finishable', () => {
    expect(compiled.verdict.body.outcome).toBe('CERTIFIED');
  });

  it('carries the seed and the title the SYSTEM wrote, not the model', () => {
    expect(compiled.value.sessionSeed).toBe(4021);
    expect(compiled.value.title).toBe(PLAN.intent.setting);
    expect(Object.keys(OWN_ANSWER)).not.toContain('title');
    expect(Object.keys(OWN_ANSWER)).not.toContain('sessionSeed');
  });

  it('names the object without geometry instead of dropping it silently', () => {
    const note = compiled.adjustments.find((entry) => entry.path === 'objects/beeHaze');
    expect(note?.reason).toContain('look layer');
    expect(compiled.value.objects.map((object) => object.stableId)).not.toContain('beeHaze');
  });

  it('says out loud that the system found the winning path', () => {
    expect(compiled.repairs.map((note) => note.kind)).toContain('witnessSolved');
  });
});

/* ================================================================== *
 * 2. Geometrie je od modelu, ne od chooseFamily().
 * ================================================================== */

describe('the geometry comes from the model', () => {
  it('never imports the family chooser — proved over the source, not over a run', () => {
    const sources = [
      '../worldstream-compiler.ts',
      '../worldstream-prompt.ts',
      '../../worldstream/schema.ts',
      '../../worldstream/references.ts',
    ];
    for (const source of sources) {
      const text = readFileSync(new URL(source, import.meta.url), 'utf8');
      const imports = text.match(/^import[\s\S]*?from '[^']+';$/gm) ?? [];
      expect(imports.join('\n')).not.toContain('family-choice');
    }
  });

  it('comes out byte for byte as the model wrote it', () => {
    const compiled = expectOk(compile(OWN_ANSWER));
    expect(canonical(compiled.value.geometry)).toBe(canonical(OWN_GEOMETRY));
  });

  it.each(['terraces', 'spires', 'grove', 'works'])(
    'rejects the family id %s where a program belongs',
    (family) => {
      const result = compile(answerWith({ geometry: family }));
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('GEOMETRY_NOT_AUTHORED');
      expect(result.detail).toContain(family);
    },
  );

  it('rejects a missing geometry as unauthored, not as a shape fault', () => {
    const { geometry: _dropped, ...rest } = OWN_ANSWER;
    const result = compile(rest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('GEOMETRY_NOT_AUTHORED');
  });

  it('rejects an empty node table as unauthored', () => {
    const result = compile(answerWith({ geometry: { version: GEOM_VERSION, nodes: [], root: 0 } }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('GEOMETRY_NOT_AUTHORED');
  });

  it('rejects a program that breaks the geom language, with the language reason', () => {
    // Odkaz nahoru: `repeat` na řádku 2 sáhne na řádek 3, tedy nad sebe.
    const nodes = [...(OWN_GEOMETRY.nodes as Record<string, unknown>[])];
    nodes[2] = { kind: 'repeat', child: 3, count: 4, step: [2, 0, 0] };
    const result = compile(answerWith({ geometry: { ...OWN_GEOMETRY, nodes } }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('GEOM_INVALID');
    expect(result.issues.join(' ')).toContain('at or above itself');
  });
});

/* ================================================================== *
 * 3. Opsaná ukázka.
 * ================================================================== */

describe('a copied example is not an answer', () => {
  it('rejects the example geometry table even when everything around it is renamed', () => {
    // Tohle je ta cesta, kterou by kanonické porovnání celé odpovědi propáslo:
    // placements sedí na plán, tvar i svět jsou vlastní, jen kompozice je opsaná.
    const result = compile(answerWith({ geometry: EXAMPLE_BLUEPRINT_ANSWER.geometry }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('EXAMPLE_COPIED');
  });

  it('rejects the example shape table under a new shapeId', () => {
    const shapes = [{ ...EXAMPLE_BLUEPRINT_ANSWER.shapes[0], shapeId: 'hivePost' }];
    const result = compile(answerWith({ shapes }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('EXAMPLE_COPIED');
  });

  it('rejects the example world, which would be the same puzzle for every request', () => {
    const result = compile(answerWith({ world: EXAMPLE_BLUEPRINT_ANSWER.world }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('EXAMPLE_COPIED');
  });

  it('rejects the world example embedded in the world contract too', () => {
    const contract = buildCompilerRequest(PLAN, grammar()).system;
    const start = contract.indexOf('{\n  "irVersion"');
    expect(start).toBeGreaterThan(-1);
    const end = contract.indexOf(WORLD_CONTRACT_END);
    expect(end).toBeGreaterThan(start);
    const block = contract.slice(start, end);
    const world = JSON.parse(block.slice(0, block.lastIndexOf('}') + 1)) as unknown;
    const result = compile(answerWith({ world }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('EXAMPLE_COPIED');
  });
});

/* ================================================================== *
 * 4. Ukázka v promptu je platná odpověď — po částech, protože celá projít nesmí.
 * ================================================================== */

describe('the example in the prompt is a valid answer', () => {
  it('has geometry the geom language accepts', () => {
    const verdict = validateGeomProgram(EXAMPLE_BLUEPRINT_ANSWER.geometry);
    expect(verdict.issues).toEqual([]);
  });

  it('has a shape the shape language accepts', () => {
    for (const shape of EXAMPLE_BLUEPRINT_ANSWER.shapes) {
      expect(validateShapeProgram(shape).issues).toEqual([]);
    }
  });

  it('has a world that lowers and can be won, so the example teaches a real shape', () => {
    // Compilerem projít nemůže — je to jeden ze dvou ukázkových světů a ten se
    // odmítá. Zkouší se proto týmiž dvěma kroky, které compiler volá uvnitř.
    const repaired = repairEmission(EXAMPLE_BLUEPRINT_ANSWER.world).document as { sim: unknown };
    const built = buildRuntimeWorld(repaired.sim);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    expect(verifyWitness(built.world, built.world.trace).verdict).toBe('CERTIFIED');
  });

  it('places every object of its own brief and sources the hero from a shape', () => {
    const placed = EXAMPLE_BLUEPRINT_ANSWER.placements;
    expect(placed.map((entry) => entry.stableId)).toEqual([
      'hillsideTerrace',
      'drystoneWall',
      'tallHive',
      'smokerBox',
    ]);
    const hero = placed.find((entry) => entry.stableId === 'tallHive');
    expect(hero?.source.kind).toBe('shape');
  });
});

/* ================================================================== *
 * 5. Svět se sníží a dá se vyhrát.
 * ================================================================== */

describe('the world graph is the one the existing pipeline already reads', () => {
  const compiled = expectOk(compile(OWN_ANSWER));

  it('lowers into a runtime world', () => {
    expect(buildRuntimeWorld(compiled.value.world.sim).ok).toBe(true);
  });

  it('has a winning path the solver can find on its own', () => {
    const built = buildRuntimeWorld(compiled.value.world.sim);
    expect(built.ok).toBe(true);
    if (!built.ok) return;
    const found = solveWitness(built.world, { maxNodes: 20_000, maxTicks: 100_000, maxDepth: 6, settleTicks: 40 });
    expect(found).not.toBeNull();
    expect(found?.ops.length).toBeGreaterThan(0);
  });

  it('rejects a world that cannot be won', () => {
    const world = structuredClone(OWN_WORLD) as { sim: { rules: Record<string, unknown> } };
    delete world.sim.rules.win;
    const result = compile(answerWith({ world }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('WORLD_REJECTED');
      expect(result.world?.rejection.reason).toBe('NO_WIN');
      expect(result.world?.context.witnessSearch?.status).toBe('search-exhausted');
      expect(result.detail).toContain('not proof that the world is unwinnable');
      expect(result.world?.context.witnessSearch?.ticks).toBeLessThanOrEqual(40_000);
      const feedback=blueprintRejectionSentence(result);
      expect(feedback).toContain('Bounded witness search search-exhausted');
      expect(feedback).not.toContain('winning route you attached');
      expect(feedback).not.toContain('Rewrite sim.witness.ops');
    }
  });

  it('rejects a world with a dangling name before it ever runs', () => {
    const world = structuredClone(OWN_WORLD) as {
      sim: { rules: { win: { event: { zone: string } } } };
    };
    world.sim.rules.win.event.zone = 'noSuchPad';
    const result = compile(answerWith({ world }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('WORLD_REJECTED');
    expect(result.detail).toContain('noSuchPad');
  });
});

/* ================================================================== *
 * 6. Oseknout číslo, odmítnout tvar.
 * ================================================================== */

describe('a number out of budget is clamped, a wrong shape is refused', () => {
  const placementsWith = (bounds: unknown): unknown[] =>
    OWN_PLACEMENTS.map((placement) =>
      placement.stableId === 'drystoneWall' ? { ...placement, targetBounds: bounds } : placement,
    );

  const wallOf = (result: CompilerResult) => {
    const compiled = expectOk(result);
    const wall = compiled.value.objects.find((object) => object.stableId === 'drystoneWall');
    if (wall === undefined) throw new Error('the wall vanished');
    return { compiled, wall };
  };

  it('clamps a box that reaches outside the world and reports where', () => {
    const { compiled, wall } = wallOf(
      compile(answerWith({ placements: placementsWith({ min: [-400, 0, -0.5], max: [3.5, 1.2, 0.5] }) })),
    );
    const clamp = compiled.adjustments.find((entry) => entry.path.endsWith('targetBounds/min/0'));
    expect(clamp?.from).toBe(-400);
    expect(clamp?.to).toBe(-64);
    expect(wall.targetBounds.min[0]).toBe(-64);
  });

  it('opens a flat box instead of letting the mesh normalise through zero', () => {
    const { compiled, wall } = wallOf(
      compile(answerWith({ placements: placementsWith({ min: [-3, 1, -0.5], max: [3, 1, 0.5] }) })),
    );
    expect(wall.targetBounds.max[1]).toBeGreaterThan(wall.targetBounds.min[1]);
    expect(compiled.adjustments.map((entry) => entry.reason).join(' ')).toContain('no thickness');
  });

  it('opens a flat box at the very edge of the world inward, not past it', () => {
    const { wall } = wallOf(
      compile(answerWith({ placements: placementsWith({ min: [-3, 64, -0.5], max: [3, 64, 0.5] }) })),
    );
    expect(wall.targetBounds.max[1]).toBeLessThanOrEqual(64);
    expect(wall.targetBounds.max[1] - wall.targetBounds.min[1]).toBeGreaterThan(0);
  });

  it('swaps an inverted box rather than rejecting the whole world for it', () => {
    const { compiled, wall } = wallOf(
      compile(answerWith({ placements: placementsWith({ min: [3.5, 1.2, 0.5], max: [-3.5, 0, -0.5] }) })),
    );
    expect(wall.targetBounds.min[0]).toBeLessThan(wall.targetBounds.max[0]);
    expect(compiled.adjustments.map((entry) => entry.reason).join(' ')).toContain('swapped');
  });

  it('leaves a box that fits completely alone', () => {
    const compiled = expectOk(compile(OWN_ANSWER));
    expect(compiled.adjustments.filter((entry) => entry.from !== undefined)).toEqual([]);
  });

  it.each([
    ['a string instead of a box', 'wide'],
    ['a box with two numbers', { min: [0, 0], max: [1, 1] }],
    ['a box with a string coordinate', { min: [0, 0, '0'], max: [1, 1, 1] }],
    ['a box with no max', { min: [0, 0, 0] }],
    ['a box with an infinite coordinate', { min: [0, 0, 0], max: [Number.POSITIVE_INFINITY, 1, 1] }],
  ])('refuses %s, because that is not a number out of budget', (_name, bounds) => {
    const result = compile(answerWith({ placements: placementsWith(bounds) }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('WRONG_SHAPE');
  });
});

/* ================================================================== *
 * 7. Spojení s plánem.
 * ================================================================== */

describe('joining with the plan is what keeps identity', () => {
  it('takes label, role and importance from the plan, never from the answer', () => {
    const compiled = expectOk(compile(OWN_ANSWER));
    const hive = compiled.value.objects.find((object) => object.stableId === 'tallHive');
    expect(hive?.label).toBe('the tallest hive');
    expect(hive?.role).toBe('hero');
    expect(hive?.importance).toBe(3);
    expect(hive?.synonyms).toEqual(['the hive', 'the tall hive', 'the skep']);
  });

  it('keeps the objects in the order the plan named them', () => {
    const compiled = expectOk(compile(answerWith({ placements: [...OWN_PLACEMENTS].reverse() })));
    expect(compiled.value.objects.map((object) => object.stableId)).toEqual([
      'hillsideTerrace',
      'drystoneWall',
      'tallHive',
      'smokerBox',
    ]);
  });

  it('rejects a placement for something the brief never named', () => {
    const placements = [
      ...OWN_PLACEMENTS,
      {
        stableId: 'inventedGazebo',
        source: { kind: 'geom', node: 3 },
        targetBounds: { min: [0, 0, 0], max: [1, 1, 1] },
      },
    ];
    const result = compile(answerWith({ placements }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('PLACEMENT_MISMATCH');
    expect(result.detail).toContain('inventedGazebo');
  });

  it('rejects a solid object the answer forgot to place', () => {
    const placements = OWN_PLACEMENTS.filter((placement) => placement.stableId !== 'smokerBox');
    const result = compile(answerWith({ placements }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('PLACEMENT_MISMATCH');
    expect(result.detail).toContain('smokerBox');
  });

  it('rejects the same object placed twice', () => {
    const result = compile(answerWith({ placements: [...OWN_PLACEMENTS, OWN_PLACEMENTS[0]] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('PLACEMENT_MISMATCH');
  });

  it('rejects a shape whose object sources from somewhere else', () => {
    // Řádek 1, ne 3: řádek 3 už vlastní `smokerBox` a od 2. 9. 2026 je druhý
    // nárok na týž řádek vlastní nález (`findBlueprintReferenceIssues`).
    // Přebil by ten, na který se tu soudí, a test by procházel z jiného důvodu.
    const placements = OWN_PLACEMENTS.map((placement) =>
      placement.stableId === 'tallHive'
        ? { ...placement, source: { kind: 'geom', node: 1 } }
        : placement,
    );
    const result = compile(answerWith({ placements }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('REFERENCE_BROKEN');
    expect(result.detail).toContain('never shown');
  });

  it('rejects an object sourcing from a geometry row nothing builds', () => {
    // Řádek 1 je zdroj pro `repeat`, takže dosažitelný je. Přidaný řádek 5
    // nestojí v žádném `group`, takže se z kořene nedá dojít.
    const nodes = [
      ...(OWN_GEOMETRY.nodes as Record<string, unknown>[]),
      { kind: 'mass', variant: 'block', at: [0, 0, 0] },
    ];
    const placements = OWN_PLACEMENTS.map((placement) =>
      placement.stableId === 'smokerBox'
        ? { ...placement, source: { kind: 'geom', node: 5 } }
        : placement,
    );
    const result = compile(answerWith({ geometry: { ...OWN_GEOMETRY, nodes }, placements }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('GEOM_INVALID');
    expect(result.issues.join(' ')).toContain('cannot be reached');
  });
});

/* ================================================================== *
 * 8. Tvar odpovědi.
 * ================================================================== */

describe('the answer shape', () => {
  it.each([
    ['a bare array', []],
    ['a string', 'a hillside terrace'],
    ['null', null],
  ])('refuses %s', (_name, answer) => {
    const result = compile(answer);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('NOT_AN_OBJECT');
  });

  it('refuses a field this stage does not write, and names it', () => {
    const result = compile(answerWith({ title: 'The Apiary' }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('WRONG_SHAPE');
    expect(result.detail).toContain('title');
  });

  it('refuses shapes that is not an array', () => {
    const result = compile(answerWith({ shapes: {} }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('WRONG_SHAPE');
  });

  it('refuses a shape program that breaks the shape language', () => {
    const result = compile(answerWith({ shapes: [{ ...OWN_SHAPE, root: 40 }] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('SHAPE_INVALID');
  });

  /**
   * **Poměr objemů z brány musí dojít až do věty pro model, slovo za slovem.**
   *
   * Brána `T12-boundsratio` počítá číslo, ze kterého jde napsat opravná věta —
   * a to je k ničemu, když ho compiler cestou zkrátí nebo přepíše. Tady se
   * pinuje celý řetěz: `validateShapeProgram` → `SHAPE_INVALID` →
   * `blueprintRejectionSentence`, který `detail` propouští doslova.
   */
  it('passes the bounds overflow ratio through to the fault, word for word', () => {
    const result = compile(
      answerWith({
        shapes: [{ ...OWN_SHAPE, nodes: [{ kind: 'sphere', radius: 5 }], root: 0, anchors: [] }],
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('SHAPE_INVALID');
    // Kvádr tvaru je 1,4 × 1,8 × 1,4 = 3,528; koule o poloměru 5 zabere 1000.
    expect(result.detail).toBe(
      'shapes[0]: shape overflows its own targetBounds on x, y, z: ' +
        'generated bounds were 283.4× the requested volume',
    );
  });

  it('accepts an answer with no hero shape at all', () => {
    // Viz výš: řádek 3 patří `smokerBox`, tak si tenhle objekt vezme řádek 1.
    const placements = OWN_PLACEMENTS.map((placement) =>
      placement.stableId === 'tallHive'
        ? { ...placement, source: { kind: 'geom', node: 1 } }
        : placement,
    );
    const compiled = expectOk(compile(answerWith({ shapes: [], placements })));
    expect(compiled.value.shapes).toEqual([]);
  });
});

/* ================================================================== *
 * 9. Požadavek, který jde nahoru.
 * ================================================================== */

describe('the compiler request', () => {
  const request = buildCompilerRequest(PLAN, grammar());

  it('carries the canonical intent, not the sentence somebody typed', () => {
    expect(request.user).toContain(canonical(PLAN));
  });

  it('embeds the world contract verbatim instead of restating it', () => {
    expect(request.system).toContain(WORLD_CONTRACT_MARKER);
    // Věta, kterou zná výhradně `buildEmissionRequest`. Druhá formulace téhož
    // kontraktu by tenhle řádek neprošla.
    expect(request.system).toContain('sim.witness  omitted — the system writes it');
  });

  /**
   * ⚠ **Tenhle pin nic nového nezavádí — drží větu, která v promptu už stojí.**
   *
   * P18 T7 plánovala pravidlo o dosažitelné výhře do promptu *dopsat*. Naměřeno
   * 16. 9. 2026: je tam dvakrát. Jednou ve vloženém kontraktu („THE WORLD MUST BE
   * WINNABLE", hlídá `prompt.test.ts:151`) a podruhé vlastními slovy compileru
   * hned za zavřením `NO_FIT`. Třetí formulace by byla jen delší prompt.
   *
   * Hlídat se to ale musí, protože je to přesně ta třída vady, kterou oko
   * nechytí: kdyby ta věta z promptu zmizela při jeho zkracování (T8 chce
   * zkracovat, co model píše), model by o dosažitelnosti výhry nedostal ani
   * slovo a **všechno by dál vypadalo zeleně**. Pořadí je součástí tvrzení:
   * věta patří za zrušení `NO_FIT`, ne před ně, jinak si ji model přečte jako
   * přebitou tím, co stojí pod ní.
   */
  it('requires a reachable interaction with a visible requested object, after the embedded contract', () => {
    const close = request.system.indexOf('On this path you do not have it');
    const reaching = request.system.indexOf('Propose a reachable action using a visible object already present');
    const never = request.system.indexOf('Do not invent an invisible universal win trigger');

    expect(close).toBeGreaterThan(-1);
    expect(reaching).toBeGreaterThan(close);
    expect(never).toBeGreaterThan(reaching);
  });

  it('closes the NO_FIT door the embedded contract opens, and closes it after it', () => {
    // ⚠ **Pořadí je celé tvrzení, ne detail zápisu.** Vložený světový kontrakt
    // `NO_FIT` nabízí právem — sdílí ho cesta, kde za větou nemusí nic stát.
    // Tady za ní stojí hotové místo, takže se nabídka ruší, a zrušení, které by
    // stálo nad ní, by si model přečetl jako přebité tím, co je pod ním.
    const offer = request.system.indexOf('simOutcome: "NO_FIT"');
    const close = request.system.indexOf('On this path you do not have it');

    expect(offer).toBeGreaterThan(-1);
    expect(close).toBeGreaterThan(offer);
  });

  it('names every node of both languages in the manifest', () => {
    const manifest = capabilityManifest();
    for (const kind of SCHEMA_NODE_KINDS) expect(manifest).toContain(`    ${kind} —`);
    for (const kind of ['terrain', 'sweep', 'anchorTo', 'arrayAlongCurve', 'carve'])
      expect(manifest).toContain(`  ${kind} —`);
    // Varianty kusů se čtou ze slovníku, ne z ruky.
    expect(manifest).toContain('quadruped');
    expect(manifest).toContain('buttress');
  });

  it('shows an example answer whose parts this stage would accept', () => {
    expect(request.system).toContain(BLUEPRINT_EXAMPLE_MARKER);
    expect(request.system).toContain('"tallHiveShape"');
  });

  it('lists exactly the objects that need a placement, effects excluded', () => {
    const line = request.user
      .split('\n')
      .find((entry) => entry.startsWith('Every one of these objects needs a placement:'));
    expect(line).toContain('hillsideTerrace, drystoneWall, tallHive, smokerBox');
    // Efekt se neumisťuje. V kanonickém záměru níž samozřejmě stojí — je to
    // objekt plánu — takže se soudí ten jeden řádek, ne celá zpráva.
    expect(line).not.toContain('beeHaze');
  });

  it('does not ask the planner stage to be redone', () => {
    // Ukázka plannera nemá v compileru co dělat: kdyby se sem dostala, model by
    // dostal dvě různé ukázky dvou různých fází a mísil by je.
    expect(request.system).not.toContain(EXAMPLE_PLAN.objects[0].stableId);
  });
});

/* ================================================================== *
 * 10. materialIntent napsaný jako popis.
 * ================================================================== */

/**
 * Naměřeno nad archivem běhu `T14` (6. 9. 2026): **60 ze 112** hodnot
 * `materialIntent` je fráze, a protože smyčka nad tvary odmítá na prvním vadném,
 * opravil model jedno pole na kolo — `✗2 → ✗1 → ✓` je dvě placená volání za
 * pravopis. Řetězce níž jsou z toho archivu, ne vymyšlené.
 */
describe('a material written as a description is read, not refused', () => {
  const shapeWith = (intent: unknown): unknown[] => [{ ...OWN_SHAPE, materialIntent: intent }];

  it('reads a phrase as a material name and says so', () => {
    const compiled = expectOk(
      compile(answerWith({ shapes: shapeWith('weathered corrugated steel') })),
    );
    const note = compiled.adjustments.find((entry) => entry.path === 'shapes/0/materialIntent');

    expect(note?.reason).toContain('weathered corrugated steel');
    expect(note?.reason).toContain('weatheredCorrugatedSteel');
    expect(compiled.value.shapes[0].materialIntent).toBe('weatheredCorrugatedSteel');
  });

  it('leaves a name the protocol already takes exactly as written', () => {
    // `weathered_stone` je naměřená platná hodnota. Rozpad na slova by z ní
    // udělal `weatheredStone`, tedy jiný materiál, a nikdo by se to nedozvěděl.
    const compiled = expectOk(compile(answerWith({ shapes: shapeWith('weathered_stone') })));

    expect(compiled.value.shapes[0].materialIntent).toBe('weathered_stone');
    expect(compiled.adjustments.map((entry) => entry.path)).not.toContain('shapes/0/materialIntent');
  });

  it('still refuses a material no identifier can be read out of', () => {
    // Selhání je půlka kontraktu: dopsat sem předponu by byl vymyšlený materiál
    // ve světě, o kterém by panel tvrdil, že ho napsal model.
    const result = compile(answerWith({ shapes: shapeWith('· — ·') }));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('SHAPE_INVALID');
      expect(result.detail).toContain('materialIntent');
    }
  });

  it('refuses a material that is not a string at all', () => {
    const result = compile(answerWith({ shapes: shapeWith(42) }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('SHAPE_INVALID');
  });
});

/* ================================================================== *
 * 11. Vadné tvary se sbírají všechny (`T14r-shapefirstfault`).
 * ================================================================== */

/**
 * Naměřeno nad archivem `T14`: `return` uvnitř smyčky nad tvary dal modelu
 * jeden tvar na kolo, takže posloupnost byla `✗2 → ✗1 → ✓` a věty se třemi
 * vadnými tvary (`c30`, a dál `c03`, `c05`, `c13`, `c21`, `c26`) na tři
 * povolená kola nedosáhly. Tady se pinuje, že jedno kolo unese všechny.
 *
 * **Soudí se celý řetěz až po větu pro model**, ne jen pole `issues`.
 * Compiler může nálezy posbírat bezvadně a `blueprintRejectionSentence()` je
 * přesto zahodit — pak by úloha byla zelená a model by dál platil za kolo na
 * tvar.
 */
describe('an answer with several faulty shapes', () => {
  // Dvě **různé** vady, schválně: stejná vada dvakrát projde i kódem, který umí
  // jen zopakovat první nález.
  const overflowing = { ...OWN_SHAPE, nodes: [{ kind: 'sphere', radius: 5 }], root: 0, anchors: [] };
  const unnamed = { ...OWN_SHAPE, shapeId: 'hiveCap', materialIntent: 42 };

  const rejection = () => {
    const result = compile(answerWith({ shapes: [overflowing, unnamed] }));
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('the answer compiled');
    return result;
  };

  it('reports every faulty shape in one round, not just the first', () => {
    const result = rejection();

    expect(result.reason).toBe('SHAPE_INVALID');
    expect(result.issues.some((issue) => issue.startsWith('shapes/0: '))).toBe(true);
    expect(result.issues.some((issue) => issue.startsWith('shapes/1: '))).toBe(true);
  });

  it('names the first faulty shape in the sentence a person reads', () => {
    // `detail` je věta pro člověka v Inspect zásuvce a `extraIssues()` ji
    // z výpisu odečítá, aby první nález nezazněl dvakrát. Ta dělba je proto
    // součást tvrzení, ne jen zápisu.
    expect(rejection().detail).toContain('shapes[0]');
  });

  it('carries both faults into the sentence the model gets back', () => {
    const sentence = blueprintRejectionSentence(rejection());

    expect(sentence).toContain('shapes[0]');
    expect(sentence).toContain('shapes/1');
    expect(sentence).toContain('materialIntent');
  });

  it('keeps a sound shape out of the findings even when a neighbour is faulty', () => {
    // Selhací cesta, kterou by sbírání nálezů mohlo rozbít: „posbírej všechno"
    // se dá napsat tak, že do seznamu spadne i tvar, na kterém nic není.
    const result = compile(answerWith({ shapes: [overflowing, OWN_SHAPE] }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.every((issue) => issue.startsWith('shapes/0: '))).toBe(true);
  });

  it('still calls a copied example table copied, whatever stands after it', () => {
    // Konzervativní čtení úlohy: `EXAMPLE_COPIED` je verdikt o celé odpovědi,
    // ne vada jednoho tvaru, a `reject()` nese jediný důvod. Sesypat ho do
    // seznamu se `SHAPE_INVALID` znamená jeden z těch dvou důvodů vydat
    // nepravdivě, takže se odmítá dál hned.
    const copied = EXAMPLE_BLUEPRINT_ANSWER.shapes[0];
    const result = compile(answerWith({ shapes: [copied, unnamed] }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('EXAMPLE_COPIED');
  });

  it('calls it copied even when the faulty shape comes FIRST', () => {
    // **Nález nezávislé revize 9. 9. 2026.** Dokud se opsaná ukázka soudila
    // uvnitř téže smyčky jako platnost tvarů, rozhodovalo o verdiktu pořadí:
    // tenhle vstup vydal `SHAPE_INVALID` do `T14r-shapefirstfault` a
    // `EXAMPLE_COPIED` po něm. Verdikt o celé odpovědi nesmí viset na tom,
    // kolikátý tvar ji prozradí.
    const copied = EXAMPLE_BLUEPRINT_ANSWER.shapes[0];
    const result = compile(answerWith({ shapes: [unnamed, copied] }));

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('EXAMPLE_COPIED');
  });
});

/* ================================================================== *
 * 12. Abeceda u polí, která ji potřebují (`T14r-promptalphabet`).
 * ================================================================== */

/**
 * Naměřený přirozený experiment uvnitř jednoho běhu `T14`: každé pole, u
 * kterého prompt tvar jmenuje, přišlo bez vady (`stableId` 0 z 515, `shapeId`
 * 0 z 224, `anchors[].name` 0 z 211); obě pole, u kterých mlčel, vadu měla
 * (`materialIntent` 60 ze 112, `role` 3 ze 479). Rozdíl byl jedna závorka.
 *
 * **Aserce je proto na okno kolem toho pole, ne na celou zprávu.** `stableId`
 * říká „camelCase, unique, no spaces" odjakživa, takže `toContain('camelCase')`
 * nad celým textem zůstane zelené i po smazání obou dopsaných vět — to je
 * dekorativní test, ne pin. Okno je řádek s tím polem plus jeden následující,
 * protože oba popisy se přes zalomení řádku přelévají.
 */
const windowAround = (text: string, needle: string): string => {
  const lines = text.split('\n');
  const at = lines.findIndex((line) => line.includes(needle));
  expect(at).toBeGreaterThan(-1);
  return lines.slice(at, at + 2).join('\n');
};

describe('the two fields the prompt used to leave without an alphabet', () => {
  const system = buildCompilerRequest(PLAN, grammar()).system;

  it('says how materialIntent is spelled, right where it introduces it', () => {
    const near = windowAround(system, 'materialIntent');

    expect(near).toContain('camelCase');
    expect(near).toContain('no spaces');
  });

  it('says how an entity role is spelled, right where it calls it a free label', () => {
    const near = windowAround(system, 'role is a FREE label');

    expect(near).toContain('camelCase');
    expect(near).toContain('no spaces');
  });

  it('asks for less than both validators allow, and the space is the whole overlap', () => {
    // ⚠ **Titulek tohohle testu do 9. 9. 2026 zněl „demands exactly what the
    // two validators demand" a byl to nález nezávislé revize** — tvrdil rovnost
    // tam, kde je nerovnost, a dvě hodnoty, které zkoušel, ji nemohly odhalit.
    //
    // Prompt žádá **camelCase**, obě regulárky pouštějí víc, a **každá něco
    // jiného**: `SHAPE_IDENTIFIER_PATTERN` bere pomlčku i podtržítko,
    // `ID_PATTERN` podtržítko ano a pomlčku ne. Rovnost tedy neplatí ani mezi
    // těmi dvěma navzájem.
    expect(SHAPE_IDENTIFIER_PATTERN.test('brushed-steel')).toBe(true);
    expect(SHAPE_IDENTIFIER_PATTERN.test('brushed_steel')).toBe(true);
    expect(ID_PATTERN.test('loose_pickup')).toBe(true);
    expect(ID_PATTERN.test('loose-pickup')).toBe(false);

    // **Co platí a proč na tom stojí ta dvě dopsaná slova v promptu:** mezeru
    // odmítnou obě, a mezera je to jediné, co model naměřeně psal
    // (`materialIntent` 60 ze 112, `role` 3 ze 479). Přísnější prompt je tedy
    // v pořádku — nedá modelu platit za pravopis, který kód odmítne, jen mu
    // nechá užší cestu, než by musel.
    expect(SHAPE_IDENTIFIER_PATTERN.test('brushed steel')).toBe(false);
    expect(ID_PATTERN.test('loose pickup')).toBe(false);
    expect(SHAPE_IDENTIFIER_PATTERN.test('brushedSteel')).toBe(true);
    expect(ID_PATTERN.test('loosePickup')).toBe(true);
  });
});

/**
 * **Nevyhratelný velký svět se zamítne za sekundy, ne za minuty** (P19 R6).
 * Odpověď Astry na větu s pokladnou vyčerpala 20 000 replayů hledače za
 * 127–167 s; strop v tikách ji zamítne s týmž důvodem. Mez času je volná
 * schválně – pod zátěží celé sady se časové testy hýbou, tady jde o řád.
 */
describe('rozpočet hledání svědka', () => {
  it('zamítne nevyhratelnou pokladnu týmž důvodem a v řádu sekund', () => {
    const fixture = JSON.parse(readFileSync(new URL('./fixtures/unwinnable-checkout.json', import.meta.url), 'utf8')) as {
      plan: PlannerEmission;
      answer: unknown;
    };
    const started = performance.now();
    const result = compileBlueprint(fixture.answer, fixture.plan, { sessionSeed: 1, upstream: UPSTREAM });

    expect(result.ok).toBe(false);
    if(result.ok)throw new Error('Expected bounded search rejection');
    expect(result.world?.rejection.reason).toBe('NO_WIN');
    expect(result.world?.context.witnessSearch?.status).toBe('budget-exhausted');
    expect(result.world?.context.witnessSearch?.ticks).toBe(40_000);
    expect(result.detail).toContain('Final replay: horizon 600 exhausted');
    const feedback=blueprintRejectionSentence(result);
    expect(feedback).toContain('not proof that the world is unwinnable');
    expect(feedback).not.toContain('Rewrite sim.witness.ops');
    expect(performance.now() - started).toBeLessThan(40_000);
  }, 120_000);
});
