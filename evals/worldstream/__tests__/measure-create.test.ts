/**
 * **Měřidlo živé create cesty (P13 T14).**
 *
 * Tohle je test *měřidla*, ne modelu. Model se sem nedostane ani jednou —
 * jeho místo zaujme atrapa, která odpovídá ze scénáře. Důvod je peněžní:
 * živý běh stojí třicet placených vět, takže jediná chvíle, kdy se dá měřidlo
 * prověřit zadarmo, je **před** ním.
 *
 * Sada je `full` a soudí čtyři vlastnosti, které by se všechny daly předstírat
 * zeleným reportem:
 *
 *   1. **Autorství se nedá koupit fallbackem.** Blueprint smí projít vším
 *      a přesto skončit jako hromada beden; `geometryAuthored` v tu chvíli
 *      musí být `false`. Bez toho by měřidlo hlásilo devadesát procent nad
 *      světem, ve kterém model nenapsal ani jeden tvar.
 *   2. **Rozmanitost je práh, ne odrážka.** Třicet vět smí dát třicet různých
 *      světů; když dají třicetkrát týž, brána padá. Přineseno z brány H1,
 *      kde pět z šesti vět dalo tutéž kompozici a soudce jednotlivých snímků
 *      to nechytil, protože pojem „jiný než ostatní" nezná.
 *   3. **Příčina selhání se pojmenuje tou fází, která ji způsobila.** Osm
 *      různých vad se nesmí slít do jedné hromádky — každá se opravuje jinde.
 *   4. **Placený běh nesmí jít spustit omylem.** `npm test` na měřidlo nesahá
 *      a je to vidět z konfigurace, ne z dobré vůle.
 *
 * Co se tu **nedokazuje:** že model doopravdy staví prostory. To je otázka
 * živého běhu a brány H2, a žádná atrapa na ni odpovědět nemůže.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { GEOM_VERSION } from '@/geom/program';
import type { Grammar, UpstreamRequest } from '@/model/prompt';
import type { PlannerEmission } from '@/model/worldstream-intent';
import { EXAMPLE_BLUEPRINT_ANSWER } from '@/model/worldstream-prompt';
import type { MeshOrder, MeshResult } from '@/shape/mesh-client';

import {
  FAILURE_STAGES,
  GEOMETRY_AUTHORED_FLOOR,
  REDACTED,
  ROUGH_WORLD_P95_MS,
  WORLD_DISTANCE_FLOOR,
  archiveEmitter,
  buildCreateReport,
  clayDetail,
  compareReplay,
  driveCreateCase,
  liveEmitter,
  percentile95,
  runBudget,
  rungsAreAuthored,
  scrubDeep,
  scrubHeaders,
  scrubText,
  worldDistance,
  worldProfile,
  type ArchiveEntry,
  type CaseOutcome,
  type CreateReport,
  type FailureStage,
  type WorldProfile,
} from '../measure-create';
import { readCorpus, verifyAgainstManifest, type CreateCase } from '../lock.mjs';
import { resetProcessLedger } from '@/server/spend-store';

/**
 * **Účetní kniha se mezi testy vynuluje — od P15 T29 nutně.**
 *
 * `liveEmitter()` si staví strop přes `spendCapFromEnv()` a ten mimo serverless
 * bere **knihu procesu**, ne vlastní součet. Je to schválně: dva stropy v jednom
 * procesu jsou dohromady dvojnásobek nastaveného stropu, což byla naměřená vada.
 * Měřicí běh je jeden proces, takže se to tam potká právě jednou; v testech je
 * ale emitorů tolik, kolik je testů, a bez tohohle by druhý začínal se zůstatkem
 * prvního.
 */
afterEach(() => {
  resetProcessLedger();
});

/* ================================================================== *
 * Fixtura: plán, odpověď a atrapa modelu.
 * ================================================================== */

/** Slovník **čtený ze zmrazeného souboru**, nikdy opsaný. */
const grammar = ((): Grammar => {
  const protocol = JSON.parse(
    readFileSync(new URL('../../frozen/protocol.v1.json', import.meta.url), 'utf8'),
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
})();

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
      synonyms: ['the terrace', 'the slope'],
      role: 'terrain',
      importance: 2,
    },
    {
      stableId: 'drystoneWall',
      label: 'the drystone wall',
      synonyms: ['the wall'],
      role: 'architecture',
      importance: 2,
    },
    {
      stableId: 'tallHive',
      label: 'the tallest hive',
      synonyms: ['the hive', 'the skep'],
      role: 'hero',
      importance: 3,
    },
    {
      stableId: 'smokerBox',
      label: 'the box of the smoker',
      synonyms: ['the box'],
      role: 'prop',
      importance: 1,
    },
    {
      stableId: 'beeHaze',
      label: 'the haze of bees',
      synonyms: ['the bees'],
      role: 'effect',
      importance: 0,
    },
  ],
};

/**
 * Osm základních těles, jedno na variantu.
 *
 * Varianta není kosmetika: mění **druh** uzlu, takže se dvě odpovědi liší
 * v otisku kompozice, ne jen v číslech. Kdyby varianty měnily jen souřadnice,
 * test rozmanitosti by měřil zaokrouhlování.
 */
const PRIMITIVES: readonly Record<string, unknown>[] = [
  { kind: 'prism', sides: 6, radius: 0.5, height: 1.4 },
  { kind: 'sphere', radius: 0.6 },
  { kind: 'cylinder', height: 1.3, radius: 0.55 },
  { kind: 'cone', height: 1.2, radius: 0.6 },
  { kind: 'capsule', height: 1.1, radius: 0.4 },
  { kind: 'torus', majorRadius: 0.6, minorRadius: 0.2 },
  { kind: 'ellipsoid', radii: [0.5, 0.8, 0.5] },
  { kind: 'box', size: [0.7, 1.2, 0.7] },
];

/** Odpověď compileru pro variantu `n`. Varianta 0 je ta z `worldstream-repair`. */
function answerFor(variant: number): Record<string, unknown> {
  const step = variant % PRIMITIVES.length;
  return {
    geometry: {
      version: GEOM_VERSION,
      nodes: [
        { kind: 'terrain', variant: 'plateau', extent: [20, 20], amplitude: 0.4, seed: 3 + variant },
        { kind: 'column', variant: 'post', at: [-3, 0.5, 0] },
        { kind: 'repeat', child: 1, count: 4, step: [2, 0, 0] },
        { kind: 'fixture', variant: 'crate', at: [2, 0.3, 3] },
        { kind: 'group', children: [0, 2, 3] },
      ],
      root: 4,
    },
    shapes: [
      {
        shapeId: 'hivePost',
        stableId: 'tallHive',
        nodes: [PRIMITIVES[step], { kind: 'taper', child: 0, axis: 'y', amount: 0.6 }],
        root: 1,
        targetBounds: { min: [-0.9, -1.1, -0.9], max: [0.9, 1.1, 0.9] },
        anchors: [{ name: 'cap', at: [0, 0.8, 0], normal: [0, 1, 0] }],
        materialIntent: 'timber',
        priority: 8,
      },
    ],
    placements: [
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
        targetBounds: {
          min: [1.6 + variant, 0, 2.6],
          max: [2.4 + variant, 0.7, 3.4],
        },
      },
    ],
    world: {
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
    },
  };
}

const SEED = 4021;

const CASE: CreateCase = {
  id: 'f01',
  category: 'architecture',
  prompt: 'A hillside terrace of beehives behind a low drystone wall.',
  spatialThesis: 'One shelf cut into the hill, held by a straight wall.',
  heroObjects: ['the tallest hive'],
  visibleBeat: 'The lid of the tallest hive comes free.',
  forbiddenSubstitutions: ['a flat field with boxes on it'],
  mustName: [],
};

/**
 * Atrapa modelu. **První volání je planner, každé další compiler** — přesně
 * v tom pořadí, ve kterém je `driveCreateCase` posílá.
 */
function model(answers: {
  readonly plan?: unknown;
  readonly blueprint: unknown;
}): { emit: (request: UpstreamRequest) => Promise<unknown>; seen: UpstreamRequest[] } {
  const seen: UpstreamRequest[] = [];
  return {
    seen,
    emit: (request) => {
      seen.push(request);
      if (seen.length === 1) return Promise.resolve(answers.plan ?? PLAN);
      return Promise.resolve(answers.blueprint);
    },
  };
}

/** Meshovač, který vždycky uspěje. Jeden trojúhelník stačí — tvar se tu nesoudí. */
const meshOk = (order: MeshOrder): Promise<MeshResult> =>
  Promise.resolve({
    shapeId: order.program.shapeId,
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    vertexCount: 3,
    triangleCount: 1,
    bounds: order.bounds,
    elapsedMs: 1,
  });

/** Meshovač, který odmítne. Slot z něj spadne na hlínu. */
const meshFails = (): Promise<MeshResult> =>
  Promise.reject(new Error('the grid produced no triangles'));

function drive(
  overrides: {
    readonly blueprint?: unknown;
    readonly plan?: unknown;
    readonly mesh?: (order: MeshOrder) => Promise<MeshResult>;
    readonly entry?: CreateCase;
    readonly sessionSeed?: number;
  } = {},
) {
  const script = model({
    ...(overrides.plan === undefined ? {} : { plan: overrides.plan }),
    blueprint: overrides.blueprint ?? answerFor(0),
  });
  return {
    script,
    outcome: driveCreateCase(overrides.entry ?? CASE, {
      emit: script.emit,
      mesh: overrides.mesh ?? meshOk,
      grammar,
      sessionSeed: overrides.sessionSeed ?? SEED,
      now: () => 0,
    }),
  };
}

/* ================================================================== *
 * 1. Autorství.
 * ================================================================== */

describe('the model has to get its own geometry onto the screen', () => {
  it('counts a world whose every slot came from the model', async () => {
    const done = await drive().outcome;

    expect(done.intentValid).toBe(true);
    expect(done.blueprintValid).toBe(true);
    expect(done.worldValid).toBe(true);
    expect(done.certified).toBe(true);
    expect(done.geometryAuthored).toBe(true);
    expect(done.failure).toBeNull();
    // Čtyři objekty ze zadání dostaly slot; efekt se schválně neumisťuje.
    expect(done.rungs).toHaveLength(4);
    expect(done.rungs).toContain('g3-reduced');
    expect(done.rungs).toContain('g2-rich');
  });

  it('refuses authorship the moment one object falls back to clay', async () => {
    const done = await drive({ mesh: meshFails }).outcome;

    // Blueprint prošel vším. Právě proto je tenhle případ nebezpečný: bez
    // pravidla o příčkách by se počítal jako úspěch.
    expect(done.blueprintValid).toBe(true);
    expect(done.worldValid).toBe(true);
    expect(done.geometryAuthored).toBe(false);
    expect(done.rungs).toContain('semantic-clay');
    expect(done.failure?.stage).toBe('clay');
    expect(done.failure?.detail).toContain('1 of 4');
  });

  it('reads authorship off the rungs, not off the blueprint', () => {
    const slot = (rung: string): unknown => ({ slot: {}, form: { rung } });
    const built = (rungs: readonly string[]): Parameters<typeof rungsAreAuthored>[0] =>
      ({ kind: 'built', slots: rungs.map(slot) }) as never;

    expect(rungsAreAuthored(built(['g3-reduced', 'g2-rich']))).toBe(true);
    expect(rungsAreAuthored(built(['g3-reduced', 'semantic-clay']))).toBe(false);
    // Svět bez jediného slotu není autorský, je prázdný.
    expect(rungsAreAuthored(built([]))).toBe(false);
    expect(rungsAreAuthored({ kind: 'declined', rung: 'declined', reason: 'x' })).toBe(false);
  });
});

/* ================================================================== *
 * 2. Příčina selhání se pojmenuje tou fází, která ji způsobila.
 * ================================================================== */

describe('every kind of failure lands in its own bucket', () => {
  const shapeOfAnswer = (answerFor(0).shapes as Record<string, unknown>[])[0];

  const stageOf = async (patch: Record<string, unknown>): Promise<FailureStage | undefined> => {
    const done = await drive({ blueprint: { ...answerFor(0), ...patch } }).outcome;
    return done.failure?.stage;
  };

  it('files a name where a program was owed under geom, not under schema', async () => {
    // Tohle je ta jediná vada, kvůli které celé měřidlo existuje: model místo
    // programu vrátil jméno. Kdyby padala do `schema`, report by o hlavní
    // otázce vlny 2 mlčel a tvrdil, že jde o špatný tvar odpovědi.
    expect(await stageOf({ geometry: 'cathedral' })).toBe('geom');
  });

  it('separates a copied example from a malformed answer', async () => {
    expect(await stageOf({ geometry: EXAMPLE_BLUEPRINT_ANSWER.geometry })).toBe('copied');
    expect(await stageOf({ title: 'a hillside terrace' })).toBe('schema');
  });

  it('files a broken reference under reference', async () => {
    expect(await stageOf({ shapes: [{ ...shapeOfAnswer, stableId: 'smokerBox' }] })).toBe(
      'reference',
    );
  });

  it('scores nothing when the request was built wrong on our side', async () => {
    // Vadné semínko píše měřidlo, ne model. Musí skončit **nula koly** — a
    // v reportu se nesmí tvářit jako výpadek poskytovatele, jinak se to hledá
    // v síti místo v tom, co se do běhu poslalo.
    const { script, outcome } = drive({ sessionSeed: -1 });
    const done = await outcome;

    expect(script.seen).toHaveLength(0);
    expect(done.rounds).toBe(0);
    expect(done.failure?.stage).toBe('unavailable');
    expect(done.failure?.detail).toContain('before the model saw it');
  });

  it('reads the certification stage off the field, not off the wording', async () => {
    // Svět, jehož vítězné pravidlo míří na nedeklarovaný socket, patří pod
    // `reference`. Do 31. 8. 2026 se ta fáze parsovala z předpony `detail`u,
    // takže by ji přeformulovaná hláška tiše přesunula pod `schema` — celá
    // kategorie vad by v reportu zmizela a nikdo by si toho nevšiml.
    const world = structuredClone(answerFor(0).world) as {
      sim: { rules: { win: { event: { zone: string } } } };
    };
    world.sim.rules.win.event.zone = 'noSuchPad';

    expect(await stageOf({ world })).toBe('reference');
  });

  it('files an unaffordable shape under shape', async () => {
    const swarm = {
      ...shapeOfAnswer,
      nodes: [
        { kind: 'sphere', radius: 0.2 },
        { kind: 'repeat', child: 0, count: 64, step: [0.5, 0, 0] },
        { kind: 'repeat', child: 1, count: 64, step: [0, 0.5, 0] },
      ],
      root: 2,
    };
    expect(await stageOf({ shapes: [swarm] })).toBe('shape');
  });

  it('files a planner that answered with the wrong thing under planner', async () => {
    const done = await drive({ plan: { intent: 'a market', objects: [] } }).outcome;

    expect(done.intentValid).toBe(false);
    expect(done.blueprintValid).toBe(false);
    expect(done.failure?.stage).toBe('planner');
    // A nezaplatí se za compiler, o kterém se nic nezměřilo.
    expect(done.rounds).toBe(1);
  });

  it('files an upstream that never answered under unavailable', async () => {
    const done = await driveCreateCase(CASE, {
      emit: () => Promise.reject(new Error('upstream answered 503')),
      mesh: meshOk,
      grammar,
      sessionSeed: SEED,
      now: () => 0,
    });

    expect(done.failure?.stage).toBe('unavailable');
    expect(done.failure?.detail).toContain('503');
    expect(done.profile).toBeNull();
  });

  it('has a bucket for every stage the report can print', () => {
    const report = buildCreateReport([], { sessionSeed: SEED, measuredAt: 'now', paidCalls: 0, pricing: 'charged' });
    expect(Object.keys(report.failuresByStage).sort()).toEqual([...FAILURE_STAGES].sort());
  });
});

/* ================================================================== *
 * 3. Rozmanitost.
 * ================================================================== */

/** Profil ze samotných kvádrů — pro vlastnosti, které se kompozice netýkají. */
const layoutOnly = (boxes: readonly (readonly number[])[], look: unknown = {}): WorldProfile =>
  worldProfile({
    geometry: { nodes: [] },
    shapes: [],
    look,
    objects: boxes.map((box) => ({
      targetBounds: { min: [box[0], box[1], box[2]], max: [box[3], box[4], box[5]] },
    })),
  } as never);

describe('two sentences must not build the same space', () => {
  const profileOf = async (variant: number): Promise<WorldProfile> => {
    const done = await drive({ blueprint: answerFor(variant) }).outcome;
    if (done.profile === null) throw new Error('the fixture was supposed to compile');
    return done.profile;
  };

  it('calls two identical worlds identical', async () => {
    const first = await profileOf(0);
    const second = await profileOf(0);
    expect(worldDistance(first, second)).toBe(0);
  });

  it('separates worlds built from different pieces', async () => {
    const prism = await profileOf(0);
    const sphere = await profileOf(1);
    expect(worldDistance(prism, sphere)).toBeGreaterThan(WORLD_DISTANCE_FLOOR);
  });

  it('does not let atmosphere pass for a different space', () => {
    // Přesně ta vada z brány H1: pět z šesti světů se lišilo jen náladou.
    const box = [0, 0, 0, 1, 1, 1];
    expect(
      worldDistance(
        layoutOnly([box], { palette: 'moss', atmosphere: 'clear' }),
        layoutOnly([box], { palette: 'ash', atmosphere: 'fog' }),
      ),
    ).toBe(0);
  });

  it('does not care in what order the planner listed the objects', () => {
    const boxes = [
      [5, 0, 0, 6, 1, 1],
      [0, 0, 0, 1, 1, 1],
    ];
    expect(worldDistance(layoutOnly(boxes), layoutOnly([...boxes].reverse()))).toBe(0);
  });

  it('does not call a one-object world close to a four-object one', () => {
    const box = [0, 0, 0, 1, 1, 1];
    expect(
      worldDistance(layoutOnly([box]), layoutOnly([box, box, box, box])),
    ).toBeGreaterThan(WORLD_DISTANCE_FLOOR);
  });
});

/* ================================================================== *
 * 4. Report a brány.
 * ================================================================== */

/**
 * Svět postavený z jiných kusů než jeho sousedé.
 *
 * Odsazovat světy jen souřadnicí nestačí a je to naměřené: dva jednoobjektové
 * světy dvacet jednotek od sebe mají vzdálenost **0,0208**, tedy pod prahem —
 * kvádry se normují celým rozsahem světa (±64). Rozdíl mezi dvěma poctivými
 * světy stojí na tom, **z čeho** jsou postavené, ne o kolik jsou posunuté.
 */
const distinct = (index: number): WorldProfile =>
  worldProfile({
    geometry: { nodes: [{ kind: `piece${String(index)}` }] },
    shapes: [],
    objects: [{ targetBounds: { min: [index, 0, 0], max: [index + 1, 1, 1] } }],
  } as never);

/** Zdravý případ. Profil je unikátní, ať se testu rozmanitosti nepletou drátky. */
const outcome = (patch: Partial<CaseOutcome> = {}): CaseOutcome => ({
  id: 'x',
  category: 'architecture',
  intentValid: true,
  blueprintValid: true,
  geometryAuthored: true,
  worldValid: true,
  certified: true,
  latencyMs: 100,
  rounds: 1,
  failure: null,
  rungs: ['g3-reduced'],
  profile: layoutOnly([[0, 0, 0, 1, 1, 1]]),
  blueprint: null,
  ...patch,
});

/** `count` případů, každý jinde v prostoru, takže si nejsou blízké. */
const spread = (count: number, patch: (index: number) => Partial<CaseOutcome> = () => ({})) =>
  Array.from({ length: count }, (_unused, index) =>
    outcome({
      id: `c${String(index)}`,
      profile: distinct(index),
      ...patch(index),
    }),
  );

const report = (cases: readonly CaseOutcome[]) =>
  buildCreateReport(cases, {
    sessionSeed: SEED,
    measuredAt: '2026-08-31T00:00:00.000Z',
    paidCalls: 0,
    pricing: 'charged',
  });

describe('the report rules on the run instead of describing it', () => {
  it('takes p95 off the index the rest of the repo takes it off', () => {
    // ceil(0,95 · 30) − 1 = 28, tedy 29. hodnota seřazeného pole.
    expect(percentile95(Array.from({ length: 30 }, (_u, at) => at + 1))).toBe(29);
    expect(percentile95([])).toBe(0);
    expect(percentile95([5])).toBe(5);
  });

  it('lets a run through when nothing is below the floor', () => {
    expect(report(spread(30)).gateFailures).toEqual([]);
  });

  it('accepts exactly the floor and refuses one case below it', () => {
    const at = spread(30, (index) => (index < 3 ? { geometryAuthored: false } : {}));
    const below = spread(30, (index) => (index < 4 ? { geometryAuthored: false } : {}));

    expect(report(at).geometryAuthoredRate).toBe(GEOMETRY_AUTHORED_FLOOR);
    expect(report(at).gateFailures).toEqual([]);

    const failures = report(below).gateFailures;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('geometryAuthored');
    expect(failures[0]).toContain(String(GEOMETRY_AUTHORED_FLOOR));
  });

  it('refuses a run that is slow at p95, not one that is slow once', () => {
    const slow = (count: number) =>
      spread(30, (index) => (index < count ? { latencyMs: ROUGH_WORLD_P95_MS + 1_000 } : {}));

    // Jedna pomalá věta z třiceti p95 nehne — a to je smysl p95.
    expect(report(slow(1)).gateFailures).toEqual([]);
    const failures = report(slow(2)).gateFailures;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain(String(ROUGH_WORLD_P95_MS));
  });

  it('refuses a run in which two sentences built the same space', () => {
    const twins = spread(30);
    twins[7] = { ...twins[7], id: 'twinB', profile: twins[3].profile };

    const failures = report(twins).gateFailures;
    expect(failures).toHaveLength(1);
    expect(failures[0]).toContain('twinB');
    expect(failures[0]).toContain(twins[3].id);
    expect(report(twins).closestPair?.distance).toBe(0);
  });

  it('carries the whole matrix, closest first, so the floor can be calibrated', () => {
    const built = report(spread(6));

    expect(built.pairs).toHaveLength((6 * 5) / 2);
    expect(built.closestPair).toEqual(built.pairs[0]);
    const distances = built.pairs.map((pair) => pair.distance);
    expect([...distances].sort((left, right) => left - right)).toEqual(distances);
  });

  it('leaves a world that never got built out of the matrix', () => {
    const built = report([...spread(3), outcome({ id: 'lost', profile: null })]);

    expect(built.pairs).toHaveLength(3);
    expect(built.pairs.flatMap((pair) => [pair.a, pair.b])).not.toContain('lost');
  });

  it('counts every stage separately', () => {
    const stages: FailureStage[] = ['geom', 'geom', 'shape', 'clay', 'planner'];
    const built = report(
      stages.map((stage, index) =>
        outcome({
          id: `f${String(index)}`,
          geometryAuthored: false,
          failure: { stage, detail: 'x' },
          profile: distinct(index),
        }),
      ),
    );

    expect(built.failuresByStage.geom).toBe(2);
    expect(built.failuresByStage.shape).toBe(1);
    expect(built.failuresByStage.clay).toBe(1);
    expect(built.failuresByStage.planner).toBe(1);
    expect(built.failuresByStage.witness).toBe(0);
  });
});

/* ================================================================== *
 * 5. Break-it-on-purpose: tentýž svět na každou větu.
 * ================================================================== */

describe('one answer for every sentence must not pass', () => {
  const corpus = readCorpus();

  const runAll = async (blueprint: unknown): Promise<CaseOutcome[]> => {
    const cases: CaseOutcome[] = [];
    for (const entry of corpus.create) {
      cases.push(await drive({ entry, blueprint }).outcome);
    }
    return cases;
  };

  it('measures the frozen set the live run will measure', () => {
    expect(verifyAgainstManifest()).toEqual([]);
    expect(corpus.parseProblems).toEqual([]);
    expect(corpus.create.length).toBeGreaterThanOrEqual(30);
  });

  it('fails on authorship when every prompt gets a name instead of a program', async () => {
    const built = report(await runAll({ ...answerFor(0), geometry: 'cathedral' }));

    expect(built.geometryAuthoredRate).toBe(0);
    expect(built.failuresByStage.geom).toBe(corpus.create.length);
    expect(built.gateFailures.some((line) => line.includes('geometryAuthored'))).toBe(true);
  });

  it('fails on sameness when every prompt gets the same honest program', async () => {
    const built = report(await runAll(answerFor(0)));

    // Autorství je bez vady — model tu geometrii doopravdy napsal. Chytit to
    // umí jedině vzdálenost mezi světy, a to je celý důvod, proč v reportu je.
    expect(built.geometryAuthoredRate).toBe(1);
    expect(built.gateFailures.some((line) => line.includes('geometryAuthored'))).toBe(false);
    expect(built.closestPair?.distance).toBe(0);
    expect(built.gateFailures.some((line) => line.includes('built the same space'))).toBe(true);
  });
});

/* ================================================================== *
 * 6. Archiv syrových odpovědí.
 * ================================================================== */

/**
 * Vzorky klíčů se skládají za běhu.
 *
 * Napsané celé by v repu ležely řetězce, které vypadají jako pravé klíče —
 * a detektor secretů by je blokoval dřív, než by soubor vůbec vznikl. Test
 * přitom nepotřebuje pravý tvar, jen ten, na který míří `SECRET_PATTERNS`.
 */
const KEY_TAIL = 'A1b2C3d4E5f6G7h8';
const ANTHROPIC_KEY = `sk-ant-${KEY_TAIL}`;
const GITHUB_TOKEN = `ghp_${KEY_TAIL}0123`;

describe('the archive keeps the answer and loses the key', () => {
  it('replaces keys wherever they sit in the text', () => {
    expect(scrubText(`use ${ANTHROPIC_KEY} now`)).toBe(`use ${REDACTED} now`);
    expect(scrubText(`Bearer ${KEY_TAIL}`)).toBe(REDACTED);
    expect(scrubText(GITHUB_TOKEN)).toBe(REDACTED);
    // Hash světa a semínko jsou přesně to, kvůli čemu archiv existuje.
    expect(scrubText('sessionSeed 4021, hash 9f2c1a')).toBe('sessionSeed 4021, hash 9f2c1a');
  });

  it('replaces a named header instead of dropping it', () => {
    const clean = scrubHeaders({
      'X-Api-Key': `secret ${KEY_TAIL}`,
      'user-agent': `worldsmith/1.0 ${ANTHROPIC_KEY}`,
      'content-type': 'application/json',
    });

    // Prázdno by se četlo jako „hlavička tam nebyla" — jiná informace.
    expect(clean['X-Api-Key']).toBe(REDACTED);
    expect(clean['user-agent']).toBe(`worldsmith/1.0 ${REDACTED}`);
    expect(clean['content-type']).toBe('application/json');
    expect(Object.keys(clean)).toHaveLength(3);
  });

  it('walks into arrays and nested documents', () => {
    const clean = scrubDeep({
      messages: [{ text: ANTHROPIC_KEY }, { text: 'fine' }],
      headers: { authorization: 'whatever' },
      rounds: 3,
      ok: true,
      nothing: null,
    });

    // Zakázané jméno se soudí **u toho klíče, kde stojí**, ne u jeho rodiče:
    // zmizí hodnota `authorization`, ne celý obal `headers`. Kdyby padal obal,
    // archiv by ztratil i to, jaké hlavičky vůbec odešly.
    expect(clean).toEqual({
      messages: [{ text: REDACTED }, { text: 'fine' }],
      headers: { authorization: REDACTED },
      rounds: 3,
      ok: true,
      nothing: null,
    });
  });
});

/* ================================================================== *
 * 7. Placený běh nesmí jít spustit omylem.
 * ================================================================== */

describe('the paid run cannot start from npm test', () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const read = (name: string): string => readFileSync(`${root}${name}`, 'utf8');

  const includesOf = (source: string): string[] => {
    const list = /include:\s*\[([^\]]*)\]/.exec(source);
    if (list === null) throw new Error('the config carries no include list');
    return [...list[1].matchAll(/'([^']+)'/g)].map((hit) => hit[1]);
  };

  it('collects nothing but *.test.ts by default', () => {
    // Kdyby sem přibyl glob, který chytá i `.measure.ts`, spustí se placené
    // měření při každém `npm test` — a to je vada, která se ozve až na účtu.
    for (const glob of includesOf(read('vitest.config.mts'))) {
      expect(glob.endsWith('*.test.ts')).toBe(true);
    }
  });

  it('runs the live measurement only through its own config', () => {
    expect(includesOf(read('vitest.measure.mts'))).toContain('evals/**/*.measure.ts');

    const scripts = (JSON.parse(read('package.json')) as { scripts: Record<string, string> })
      .scripts;
    expect(scripts['measure:worldstream-create']).toContain('vitest.measure.mts');
    expect(scripts['measure:worldstream-create']).toContain(
      'evals/worldstream/live-create.measure.ts',
    );
    expect(scripts.test).not.toContain('measure');
  });

  it('keeps the live measurement out of the default suite by its very name', () => {
    const live = 'evals/worldstream/live-create.measure.ts';
    expect(readFileSync(`${root}${live}`, 'utf8').length).toBeGreaterThan(0);
    expect(live.endsWith('.test.ts')).toBe(false);
  });
});

/* ================================================================== *
 * 8. Placené volání.
 * ================================================================== */

describe('the call that costs money', () => {
  const KEY = `sk-ant-${KEY_TAIL}`;

  const env = (patch: Record<string, string | undefined> = {}) => ({
    WORLDSMITH_MODEL_ENDPOINT: 'https://example.invalid/v1/messages',
    WORLDSMITH_MODEL_KEY: KEY,
    WORLDSMITH_USD_PER_MTOK_OUT: '15',
    WORLDSMITH_USD_PER_MTOK_IN: '3',
    // ⚠ **Od P15 `T29-lambdadetect` je to podmínka placeného volání, ne kulisa.**
    // `spendCapFromEnv()` dostane knihu jedině tam, kde je „jeden proces"
    // doložené známým prostředím; jinak je každá rezervace `STORE_UNCONFIGURED`.
    // Fixtura si prostředí skládá vlastním objektem, takže `env`
    // z `vitest.config.mts` na ni nedosáhne. **Platí to i pro skutečný měřicí
    // běh** (`npm run measure:worldstream-create`) — ten čte `process.env`,
    // takže bez `VERCEL_ENV` nebo sdílené knihy nezaplatí ani první volání.
    VERCEL_ENV: 'production',
    ...patch,
  });

  /** Poskytovatel, který odpoví tělem ve tvaru Anthropic Messages. */
  const answers = (body: unknown, usage = { input_tokens: 100, output_tokens: 200 }) => {
    const calls: string[] = [];
    const fetchImpl = (input: unknown): Promise<Response> => {
      calls.push(String(input));
      return Promise.resolve(
        new Response(
          JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(body) }], usage }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    };
    return { calls, fetchImpl: fetchImpl as unknown as typeof fetch };
  };

  const request: UpstreamRequest = { model: 'claude-opus-5', system: 'be brief', user: 'a wall' };

  it('refuses to exist without an endpoint, a key and a price', () => {
    expect(() => liveEmitter(env({ WORLDSMITH_MODEL_ENDPOINT: undefined }))).toThrow(
      /no upstream is configured/,
    );
    expect(() => liveEmitter(env({ WORLDSMITH_MODEL_KEY: undefined }))).toThrow(
      /no upstream is configured/,
    );
    // Nulová cena je vypnutý strop, ne levný model.
    expect(() => liveEmitter(env({ WORLDSMITH_USD_PER_MTOK_OUT: '0' }))).toThrow(
      /no upstream is configured/,
    );
  });

  it('says the subscription pays in calls, so its dollars are a conversion', () => {
    // **Bez tohohle slova čte report dolary jako stržený obnos.** Běh
    // z 6. 9. 2026 jel na ceníku `1/1` za milion tokenů dosazeném jen proto,
    // aby konfigurace prošla — částka z něj se nesmí citovat jako cena.
    expect(liveEmitter(env()).pricing).toBe('charged');
    const subscription = liveEmitter(
      env({ WORLDSMITH_MODEL_PROFILE: 'subscription', WORLDSMITH_CALL_CAP: '200' }),
    );
    expect(subscription.pricing).toBe('derived');
  });

  it('returns the parsed answer and files it under the case being measured', async () => {
    const provider = answers({ hello: 'world' });
    const upstream = liveEmitter(env(), provider.fetchImpl);
    upstream.caseId = 'c07';

    expect(await upstream.emit(request)).toEqual({ hello: 'world' });
    expect(upstream.paidCalls).toBe(1);
    expect(upstream.archive).toHaveLength(1);
    expect(upstream.archive[0].caseId).toBe('c07');
    expect(upstream.archive[0].call).toBe(1);
    expect(upstream.archive[0].answer).toEqual({ hello: 'world' });
  });

  it('never lets the configured key into the archive, whatever shape it has', async () => {
    // Poskytovatel vrátí klíč zpátky — v hlášce, v hlavičce i uprostřed textu.
    const oddKey = 'internal-token-0f7a2b';
    const provider = answers({
      detail: `rejected for ${oddKey}`,
      headers: { authorization: oddKey },
      note: `and again ${oddKey} here`,
    });
    const upstream = liveEmitter(
      env({ WORLDSMITH_MODEL_KEY: oddKey }),
      provider.fetchImpl,
    );

    await upstream.emit(request);
    const written = JSON.stringify(upstream.archive);

    // Ani jeden ze čtyř vzorů `SECRET_PATTERNS` na tenhle tvar nesedí, takže
    // tohle měří přesně tu druhou vrstvu: doslovný klíč z konfigurace.
    expect(written).not.toContain(oddKey);
    expect(written).toContain(REDACTED);
  });

  it('archives the request the model saw, without the transport', async () => {
    const provider = answers({ ok: true });
    const upstream = liveEmitter(env(), provider.fetchImpl);

    await upstream.emit(request);
    expect(upstream.archive[0].request).toEqual({
      model: 'claude-opus-5',
      system: 'be brief',
      user: 'a wall',
    });
  });

  it('records a refusal instead of losing it, and still throws', async () => {
    const calls: string[] = [];
    const fetchImpl = ((input: unknown) => {
      calls.push(String(input));
      return Promise.resolve(new Response('nope', { status: 400 }));
    }) as unknown as typeof fetch;
    const upstream = liveEmitter(env(), fetchImpl);
    upstream.caseId = 'c11';

    await expect(upstream.emit(request)).rejects.toThrow(/UPSTREAM_REJECTED/);
    // Selhání se archivuje. Prázdný archiv u padlého běhu by byl ten nejhorší
    // možný výsledek: zaplaceno a nevíme za co.
    expect(upstream.archive).toHaveLength(1);
    expect(upstream.archive[0].answer).toMatchObject({ error: 'UPSTREAM_REJECTED' });
    expect(upstream.paidCalls).toBe(1);
  });

  it('stops calling the moment the cap says stop', async () => {
    const provider = answers({ ok: true });
    const upstream = liveEmitter(
      env({ WORLDSMITH_CALL_CAP: '2' }),
      provider.fetchImpl,
    );

    await upstream.emit(request);
    await upstream.emit(request);
    await expect(upstream.emit(request)).rejects.toThrow(/CALL_CAP/);

    // Tohle je ta vlastnost, kvůli které tu strop je: třetí volání se
    // **neuskutečnilo**, ne že by jen selhalo.
    expect(provider.calls).toHaveLength(2);
    expect(upstream.paidCalls).toBe(2);
    expect(upstream.archive).toHaveLength(2);
  });

  it('stops calling when the dollars run out, not when they overrun', async () => {
    // Aritmetika je celá tady, ne ve výchozích hodnotách: strop na výstup je
    // 4 000 tokenů a 15 USD za milion, takže nejhorší případ jednoho volání
    // je ~0,060 USD. Skutečná spotřeba vrátí 0,063 USD. Strop 0,10 USD tedy
    // propustí **první** volání a druhé (0,063 + 0,060) odmítne.
    const provider = answers({ ok: true }, { input_tokens: 1_000, output_tokens: 4_000 });
    const upstream = liveEmitter(
      env({ WORLDSMITH_MAX_OUTPUT_TOKENS: '4000', WORLDSMITH_SPEND_CAP_USD: '0.10' }),
      provider.fetchImpl,
    );

    await upstream.emit(request);
    await expect(upstream.emit(request)).rejects.toThrow(/CAP_EXHAUSTED/);
    expect(provider.calls).toHaveLength(1);
  });
});

/* ================================================================== *
 * 9. Co jde na disk. Nález nezávislé revize 31. 8. 2026.
 * ================================================================== */

describe('nothing reaches the disk with a credential still in it', () => {
  const ENDPOINT_SECRET = 'gw.internal.example/v1/messages?key=URLKEY0f7a2b';

  /** Poskytovatel, na který se `fetch` ani nedovolá — a hlásí to celou adresou. */
  const unreachable = (): typeof fetch =>
    ((input: unknown) =>
      Promise.reject(new Error(`Failed to parse URL from ${String(input)}`))) as unknown as typeof fetch;

  const withEndpoint = liveEmitter(
    {
      WORLDSMITH_MODEL_ENDPOINT: ENDPOINT_SECRET,
      WORLDSMITH_MODEL_KEY: `sk-ant-${KEY_TAIL}`,
      WORLDSMITH_USD_PER_MTOK_OUT: '15',
      // Bez známého prostředí by strop odmítl dřív, než se vůbec zavolá ven —
      // a test o vyčištěné adrese by měřil `STORE_UNCONFIGURED`, ve kterém
      // žádná adresa není (P15 `T29-lambdadetect`).
      VERCEL_ENV: 'production',
    },
    unreachable(),
  );

  it('scrubs the endpoint, not just the key', async () => {
    // Klíč v query stringu ani jméno vnitřního stroje nesedí na žádný ze čtyř
    // vzorů — chytí je jedině doslovný seznam, a ten musí adresu obsahovat.
    await expect(
      withEndpoint.emit({ model: 'm', system: 's', user: 'u' }),
    ).rejects.toThrow();

    expect(JSON.stringify(withEndpoint.archive)).not.toContain('URLKEY');
  });

  it('scrubs the report too, not only the archive', async () => {
    // Tohle je ta cesta, která do 31. 8. 2026 nebyla krytá vůbec: hláška
    // `fetch`e → `unavailable` → `failure.detail` → `create-report.json`.
    const done = await driveCreateCase(CASE, {
      emit: (request) => withEndpoint.emit(request),
      mesh: meshOk,
      grammar,
      sessionSeed: SEED,
      now: () => 0,
    });

    expect(done.failure?.stage).toBe('unavailable');
    // Bez scrubbingu report ten klíč nese — proto se ověřuje obojí.
    expect(JSON.stringify(done)).toContain('URLKEY');
    expect(JSON.stringify(withEndpoint.scrub(report([done])))).not.toContain('URLKEY');
  });
});

describe('an accounting stop must not read as a model failure', () => {
  it('names the cap before it names the model', () => {
    const cut = [
      ...spread(10),
      ...Array.from({ length: 20 }, (_unused, index) =>
        outcome({
          id: `cap${String(index)}`,
          geometryAuthored: false,
          profile: null,
          failure: { stage: 'unavailable', detail: 'CAP_EXHAUSTED: the budget is spent' },
        }),
      ),
    ];

    const failures = report(cut).gateFailures;
    expect(failures[0]).toContain('spend cap');
    expect(failures[0]).toContain('10 of 30');
    // Číslo o autorství se přitom nepotlačuje — jen se čte za tou větou.
    expect(failures.some((line) => line.includes('geometryAuthored'))).toBe(true);
  });
});

describe('the raw archive never reaches the public repo', () => {
  it('is ignored by name, and the report deliberately is not', () => {
    const rules = readFileSync(
      fileURLToPath(new URL('../../../.gitignore', import.meta.url)),
      'utf8',
    );
    expect(rules).toContain('evals/worldstream/create-raw.json');
    expect(rules).not.toContain('evals/worldstream/create-report.json');
  });
});

/* ================================================================== *
 * 11. Vypršený čas nesmí sebrat, co už se změřilo.
 * ================================================================== */

describe('a run that runs out of time keeps what it measured', () => {
  /** Atrapa hodin. Čas se posouvá ručně, takže se test nedívá na skutečný. */
  const clockAt = (marks: number[]) => {
    let at = 0;
    return () => marks[Math.min(at++, marks.length - 1)];
  };

  it('always lets the first sentence through, even past an exhausted budget', () => {
    // Bez jediného pozorování se doba té další věty nedá odhadnout a běh,
    // který nezměřil nic, je horší než běh useknutý po jedné. Hodiny se tu
    // schválně posunou **za** rozpočet: zámek se ptá na počet pozorování, ne
    // na zbývající čas, jinak by nulový rozpočet nezměřil vůbec nic.
    const budget = runBudget({ totalMs: 0, now: clockAt([0, 5]) });
    expect(budget.roomForAnother()).toBeNull();
  });

  it('stops before a sentence that would not fit in what is left', () => {
    // Rozpočet 150, první věta trvala 100 → na druhou zbývá 50 a to je míň,
    // než ta nejpomalejší dosud.
    const budget = runBudget({ totalMs: 150, now: clockAt([0, 100]) });
    budget.recordCase(100);

    const stop = budget.roomForAnother();
    expect(stop).not.toBeNull();
    expect(stop).toContain('after 1 sentences');
    expect(stop).toContain('50 ms left of 150 ms');
    expect(stop).toContain('slowest sentence so far took 100 ms');
  });

  it('keeps going while another sentence still fits', () => {
    const budget = runBudget({ totalMs: 1_000, now: clockAt([0, 100, 200]) });
    budget.recordCase(100);
    expect(budget.roomForAnother()).toBeNull();
    budget.recordCase(100);
    expect(budget.roomForAnother()).toBeNull();
  });

  it('estimates the next sentence from the slowest one, not the last one', () => {
    // Kdyby se odhadovalo z poslední (10 ms), pustil by rozpočet další větu,
    // ta by trvala jako ta nejpomalejší (300 ms) a doběhla by až za limitem
    // vitestu — tedy přesně do vady, kvůli které rozpočet vzniká.
    const budget = runBudget({ totalMs: 500, now: clockAt([0, 310]) });
    budget.recordCase(300);
    budget.recordCase(10);
    expect(budget.roomForAnother()).toContain('slowest sentence so far took 300 ms');
  });

  it('accepts a sentence that fits exactly and refuses one millisecond past it', () => {
    const fits = runBudget({ totalMs: 200, now: clockAt([0, 100]) });
    fits.recordCase(100);
    expect(fits.roomForAnother()).toBeNull();

    const past = runBudget({ totalMs: 200, now: clockAt([0, 101]) });
    past.recordCase(100);
    expect(past.roomForAnother()).not.toBeNull();
  });
});

describe('a half-measured run must not read as a verdict on the model', () => {
  it('says how far it got, before it says anything about geometry', () => {
    // Osmnáct vět z třiceti, všechny poctivé. Bez první věty by brána K2
    // rozhodovala o modelu podle běhu, který se ke dvanácti větám nedostala.
    const short = buildCreateReport(spread(18), {
      sessionSeed: SEED,
      measuredAt: '2026-09-06T00:00:00.000Z',
      planned: 30,
      stopReason: 'the run budget stopped the measurement after 18 sentences',
      paidCalls: 0,
      pricing: 'charged',
    });

    expect(short.planned).toBe(30);
    expect(short.totals.attempted).toBe(18);
    expect(short.gateFailures[0]).toContain('18 of 30 sentences');
    expect(short.gateFailures[0]).toContain('the run budget stopped');
    expect(short.gateFailures[0]).toContain('an interrupted run, not the model');
  });

  it('files the same line when the loop broke without saying why', () => {
    const short = buildCreateReport(spread(2), {
      sessionSeed: SEED,
      measuredAt: '2026-09-06T00:00:00.000Z',
      planned: 30,
      paidCalls: 0,
      pricing: 'charged',
    });
    expect(short.stopReason).toBeNull();
    expect(short.gateFailures[0]).toContain('2 of 30 sentences');
  });

  it('stays quiet about it when every planned sentence got measured', () => {
    const whole = buildCreateReport(spread(30), {
      sessionSeed: SEED,
      measuredAt: '2026-09-06T00:00:00.000Z',
      planned: 30,
      paidCalls: 0,
      pricing: 'charged',
    });
    expect(whole.stopReason).toBeNull();
    expect(whole.gateFailures).toEqual([]);
  });

  it('carries the paid-call count out of the run, instead of counting cases', () => {
    // **Není to `attempted`.** Jedna věta stojí tolik volání, kolik kol oprav
    // si vyžádala; naostro 30 vět stálo 104 volání. Kdyby se číslo odvozovalo
    // z počtu vět, report by o ceně mlčel přesně tam, kde je zajímavá.
    const built = buildCreateReport(spread(3), {
      sessionSeed: SEED,
      measuredAt: '2026-09-06T00:00:00.000Z',
      planned: 3,
      paidCalls: 11,
      pricing: 'charged',
    });
    expect(built.paidCalls).toBe(11);
    expect(built.totals.attempted).toBe(3);
  });

  it('carries the pricing word out of the run instead of assuming it was paid', () => {
    const built = buildCreateReport(spread(2), {
      sessionSeed: SEED,
      measuredAt: '2026-09-06T00:00:00.000Z',
      planned: 2,
      paidCalls: 4,
      pricing: 'derived',
    });
    expect(built.pricing).toBe('derived');
  });

  it('assumes the run was whole when nobody said how many were planned', () => {
    // Zpětná slučitelnost: starší volání beze `planned` nesmí vyrobit falešný
    // poplach o useknutém běhu.
    const legacy = report(spread(30));
    expect(legacy.planned).toBe(30);
    expect(legacy.gateFailures).toEqual([]);
  });
});

describe('the runner asks the budget before it spends, and tells it after', () => {
  const live = readFileSync(
    fileURLToPath(new URL('../live-create.measure.ts', import.meta.url)),
    'utf8',
  );

  it('consults the budget before the sentence and records it afterwards', () => {
    // Pořadí je celá vlastnost: ptát se až po větě znamená rozpočet, který
    // nikdy nikoho nezastavil.
    const asks = live.indexOf('roomForAnother()');
    const spends = live.indexOf('driveCreateCase(');
    const records = live.indexOf('recordCase(');

    expect(asks).toBeGreaterThan(-1);
    expect(asks).toBeLessThan(spends);
    expect(records).toBeGreaterThan(spends);
  });

  it('leaves vitest a bigger limit than the budget it enforces itself', () => {
    // Kdyby byl limit vitestu menší nebo roven rozpočtu, o konci by zase
    // rozhodl vitest — a report by se nezapsal, protože opuštěný `await`
    // `finally` nespustí.
    expect(live).toContain('budgetMs + TIMEOUT_MARGIN_MS');
    expect(/const TIMEOUT_MARGIN_MS = [1-9]/.test(live)).toBe(true);
  });

  it('tells the report how many sentences were planned', () => {
    // Bez toho by report o useknutém běhu tvrdil, že `attempted` je všechno,
    // co kdy mělo přijít.
    expect(live).toContain('planned: corpus.create.length');
    expect(live).toContain('stopReason,');
  });
});

/* ================================================================== *
 * 12. Proč slot spadl na hlínu, a přehrání archivu zadarmo.
 * ================================================================== */

describe('a clay slot says which object it was and why', () => {
  const built = (slots: { id: string; rung: string; reason?: string }[]) =>
    ({
      kind: 'built' as const,
      title: 't',
      sessionSeed: SEED,
      resolution: 32,
      quality: 'balanced',
      scenery: [],
      slots: slots.map((entry) => ({
        slot: { stableId: entry.id, role: 'hero', source: { kind: 'shape', shapeId: 's' } },
        form:
          entry.rung === 'semantic-clay'
            ? { rung: 'semantic-clay', kind: 'clay', reason: entry.reason, drawn: true }
            : { rung: entry.rung, kind: 'placements', placements: [] },
      })),
    }) as never;

  it('names the object, its role and the reason the code recorded', () => {
    // Do 7. 9. 2026 tady stálo jen `1 of 3 objects fell back to clay` a osm vět
    // z běhu T14 se pod tou větou tvářilo jako tři různé vady. Nebyly to tři.
    const detail = clayDetail(
      built([
        { id: 'wall', rung: 'g2-rich' },
        { id: 'tallHive', rung: 'semantic-clay', reason: 'mesh is 17200 triangles, above maxTriangles 16000' },
        { id: 'floor', rung: 'g2-rich' },
      ]),
    );

    expect(detail).toContain('1 of 3 objects fell back to clay');
    expect(detail).toContain('tallHive');
    expect(detail).toContain('source shape');
    expect(detail).toContain('above maxTriangles 16000');
  });

  it('names every clay object, not just the first one', () => {
    const detail = clayDetail(
      built([
        { id: 'a', rung: 'semantic-clay', reason: 'first reason' },
        { id: 'b', rung: 'semantic-clay', reason: 'second reason' },
      ]),
    );
    expect(detail).toContain('2 of 2');
    expect(detail).toContain('first reason');
    expect(detail).toContain('second reason');
  });
});

describe('the archive replays instead of the provider', () => {
  const entry = (caseId: string, call: number, answer: unknown): ArchiveEntry => ({
    caseId,
    call,
    request: {},
    answer,
  });

  const request: UpstreamRequest = { model: 'm', system: 's', user: 'u' };

  it('hands back that case answers in the order they were paid for', async () => {
    const emit = archiveEmitter(
      [entry('c01', 1, { a: 1 }), entry('c02', 2, { wrong: true }), entry('c01', 3, { a: 2 })],
      'c01',
    );
    expect(await emit(request)).toEqual({ a: 1 });
    expect(await emit(request)).toEqual({ a: 2 });
  });

  it('behaves like a dead provider when the archive runs out', async () => {
    // Naostro to tak dopadlo: `c14` i `c28` mají v archivu míň odpovědí než
    // kol, protože poslední volání neodpovědělo. Přehrání to musí zopakovat,
    // ne vyrobit úspěch, který se nikdy nestal.
    const emit = archiveEmitter([entry('c01', 1, { a: 1 })], 'c01');
    await emit(request);
    await expect(emit(request)).rejects.toThrow('UPSTREAM_UNAVAILABLE');
  });

  it('never answers for a case the archive does not hold', async () => {
    const emit = archiveEmitter([entry('c01', 1, { a: 1 })], 'c99');
    await expect(emit(request)).rejects.toThrow('holds 0 answers');
  });
});

/**
 * **Doklad, ne commit zpráva.** Přehrání archivu ukazuje, co by opravený kód
 * postavil nad odpověďmi, které už jsou zaplacené — jenže archiv je
 * gitignorovaný, takže v čistém klonu ten běh nikdo nezopakuje. Jediné, co
 * z těch čísel v repu zůstane, je `create-replay.json`, a ten proto musí sedět
 * s reportem, ke kterému se hlásí.
 */
describe('the replay leaves a number the repo can check', () => {
  it('names the sentences that moved and stays quiet about the rest', () => {
    const before = report([
      outcome({ id: 'c01', geometryAuthored: false, failure: { stage: 'clay', detail: 'one of three' } }),
      outcome({ id: 'c02' }),
      outcome({ id: 'c03', geometryAuthored: false, failure: { stage: 'shape', detail: 'bounds' } }),
    ]);
    const after = report([
      outcome({ id: 'c01', rungs: ['g3-reduced', 'g2-rich'] }),
      outcome({ id: 'c02' }),
      outcome({ id: 'c03', geometryAuthored: false, failure: { stage: 'witness', detail: 'horizon 600' } }),
    ]);

    const diff = compareReplay(before, after, '2026-09-08T00:00:00.000Z');

    expect(diff.moved).toEqual([
      { id: 'c01', from: 'clay', to: 'authored', detail: null, rungs: ['g3-reduced', 'g2-rich'] },
      { id: 'c03', from: 'shape', to: 'witness', detail: 'horizon 600', rungs: ['g3-reduced'] },
    ]);
    expect(diff.before.geometryAuthored).toBe(1);
    expect(diff.after.geometryAuthored).toBe(2);
    expect(diff.archivedRun.measuredAt).toBe(before.measuredAt);
  });

  it('says so when a sentence the archived run had is gone from the replay', () => {
    // **Nález `T14r-promptclaims`.** Smyčka chodila po `after.cases`, takže
    // zmizelou větu nepotkala vůbec — `attempted` kleslo, `moved` zůstalo
    // prázdné a doklad mlčel právě o té největší změně. Naostro to není
    // hypotéza: `c14` i `c28` mají v archivu míň odpovědí než kol, takže
    // přehrání, které je přeskočí, je ta cesta, ne výmysl.
    const before = report([
      outcome({ id: 'c01' }),
      outcome({ id: 'c02', geometryAuthored: false, failure: { stage: 'clay', detail: 'one of three' } }),
    ]);
    const after = report([outcome({ id: 'c01' })]);

    const diff = compareReplay(before, after, '2026-09-08T00:00:00.000Z');

    // `absent`, ne `lost`: `lost` je věta, která doběhla a neskončila nikde.
    expect(diff.moved).toEqual([
      { id: 'c02', from: 'clay', to: 'absent', detail: null, rungs: [] },
    ]);
  });

  it('carries the wall-clock caveat into the file itself', () => {
    // Bez téhle věty je artefakt čtený za rok nepravdivý: příčka, na které tvar
    // skončí, se rozhoduje mimo jiné časem, takže pomalejší stroj dá jiné číslo.
    const empty = report([]);
    const diff = compareReplay(empty, empty, '2026-09-08T00:00:00.000Z');
    expect(diff.wallClock.join(' ')).toMatch(/wall clock/i);
    expect(diff.wallClock.join(' ')).toMatch(/maxMs/);
  });

  it('refuses to be read as a measurement of the model', () => {
    // Autorská čísla z přehrání se citovat nesmějí jako výsledek modelu —
    // model v něm nedostane ani jednu novou šanci. Bez téhle věty v souboru
    // to ví jen ten, kdo má po ruce plán.
    const empty = report([]);
    const diff = compareReplay(empty, empty, '2026-09-08T00:00:00.000Z');
    expect(diff.measures.join(' ')).toMatch(/never the model/i);
    expect(diff.measures.join(' ')).toMatch(/K2/);
  });
});

describe('the committed replay artifact holds up on its own', () => {
  const read = <T,>(name: string): T =>
    JSON.parse(readFileSync(new URL(`../${name}`, import.meta.url), 'utf8')) as T;

  const artifact = read<ReturnType<typeof compareReplay>>('create-replay.json');
  const measured = read<CreateReport>('create-report.json');

  it('replays the run the committed report measured, not some other one', () => {
    // Kdyby se rozešly, mluvila by ta dvě čísla o dvou různých bězích a věta
    // „clay 8 -> 0" by neměla k čemu být rozdílem.
    expect(artifact.archivedRun.measuredAt).toBe(measured.measuredAt);
    expect(artifact.archivedRun.sessionSeed).toBe(measured.sessionSeed);
    expect(artifact.before.geometryAuthored).toBe(measured.totals.geometryAuthored);
    expect(artifact.before.failuresByStage).toEqual(measured.failuresByStage);
  });

  it('says what the run cost, not just what it produced', () => {
    // **Cena běhu se jinak zjistí jedině počítáním řádků archivu, a ten je
    // gitignorovaný.** V čistém klonu tedy nebylo z čeho ji vyčíst.
    //
    // Číslo se do reportu z 6. 9. 2026 doplnilo z archivu (`create-raw.json`,
    // 104 položek), ne odhadem — a plán i commit `8761627` nesou totéž.
    expect(measured.paidCalls).toBe(104);
    // **Volání je nejmíň tolik co vět**, protože každá věta stojí aspoň jedno.
    // Rozdíl jsou kola oprav, a právě ten by mlčky zmizel, kdyby se sem někdy
    // dosadilo `attempted`.
    expect(measured.paidCalls).toBeGreaterThanOrEqual(measured.totals.attempted);
    // **A říká, čím se platilo.** Ten běh šel přes předplatné, takže ceník
    // `1/1` za milion tokenů byl dosazený jen proto, aby konfigurace prošla;
    // bez tohohle slova si čtenář jeho dolary přečte jako stržený obnos.
    expect(measured.pricing).toBe('derived');
  });

  it('has as many moved sentences as the two tallies differ by', () => {
    const moves = new Set(artifact.moved.map((move) => move.id));
    expect(moves.size).toBe(artifact.moved.length);
    const gained = artifact.after.geometryAuthored - artifact.before.geometryAuthored;
    const toAuthored = artifact.moved.filter((move) => move.to === 'authored').length;
    const fromAuthored = artifact.moved.filter((move) => move.from === 'authored').length;
    expect(toAuthored - fromAuthored).toBe(gained);
  });

  it('says out loud which of its numbers a slower machine would move', () => {
    expect(artifact.wallClock.length).toBeGreaterThan(0);
    expect(artifact.wallClock.join(' ')).toMatch(/wall clock/i);
    expect(artifact.measures.join(' ')).toMatch(/never the model/i);
  });
});
