/**
 * **Sebeoprava blueprintu (P13 T12).**
 *
 * Sada je `pin` a pin je tu na jedné vlastnosti: **smyčka může vypadat, že
 * běží, a přitom posílat modelu zprávu, ze které se nedá nic vyvodit.** Zelené
 * „tři kola proběhla" je slabý důkaz — tři kola proběhnou i nad větou
 * `invalid shape`, jen za ně nikdo nic nekoupí. Soudí se proto **obsah věty**,
 * a soudí se nad **skutečnými odmítnutími z brány**, ne nad ručně složeným
 * `BlueprintFault`: kdyby se fixtura psala rukou, sada by přežila i to, že
 * compiler přestane číslo do hlášky psát.
 *
 * Čtyři brány z AC, každá vlastním vstupem:
 *
 *   - **schéma** – pole navíc v odpovědi (`WRONG_SHAPE`),
 *   - **geometrická brána** – jméno místo programu (`GEOMETRY_NOT_AUTHORED`),
 *   - **rozpočet** – tvar, který se rozbalí nad `maxInstances` (`SHAPE_INVALID`),
 *   - **reference** – tvar patřící jinému objektu, než který z něj čerpá
 *     (`REFERENCE_BROKEN`).
 *
 * Co se tu **nedokazuje:** že model odmítnutí doopravdy opraví. To je vlastnost
 * modelu, ne smyčky, a měří ji živě T14.
 */

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { GEOM_VERSION } from '../../geom/program';
import { type Grammar } from '../prompt';
import {
  MAX_BLUEPRINT_ROUNDS,
  blueprintRejectionSentence,
  buildRepairRequest,
  compileWithRepair,
  type BlueprintFault,
} from '../worldstream-repair';
import { compileBlueprint, type CompilerRejection } from '../worldstream-compiler';
import {
  BLUEPRINT_EXAMPLE_MARKER,
  WORLD_CONTRACT_END,
  buildCompilerRequest,
} from '../worldstream-prompt';
import type { PlannerEmission } from '../worldstream-intent';

/** Slovník **čtený ze zmrazeného souboru**, nikdy opsaný. */
const grammar = ((): Grammar => {
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
})();

/* ------------------------------------------------------------------ *
 * Fixtura: plán a vlastní odpověď na něj.
 * ------------------------------------------------------------------ */

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

const answerWith = (patch: Record<string, unknown>): Record<string, unknown> => ({
  ...OWN_ANSWER,
  ...patch,
});

const SEED = 4021;

/**
 * Odmítnutí **z brány**, ne z ruky. Kdyby se `BlueprintFault` psal rukou, sada
 * by přežila i to, že compiler přestane do hlášky psát adresu a číslo.
 */
function faultFrom(answer: unknown): BlueprintFault {
  const result = compileBlueprint(answer, PLAN, {
    sessionSeed: SEED,
    upstream: buildCompilerRequest(PLAN, grammar),
  });
  if (result.ok) throw new Error('the fixture was supposed to be rejected and compiled instead');
  return { reason: result.reason, detail: result.detail, issues: result.issues };
}

/** Tvar, který se rozbalí na 4 096 kopií — 64 × 64 proti stropu 256. */
const SWARM_SHAPE: Record<string, unknown> = {
  ...OWN_SHAPE,
  nodes: [
    { kind: 'sphere', radius: 0.2 },
    { kind: 'repeat', child: 0, count: 64, step: [0.5, 0, 0] },
    { kind: 'repeat', child: 1, count: 64, step: [0, 0.5, 0] },
  ],
  root: 2,
};

/** Tvar, který patří jinému objektu, než který z něj čerpá. */
const STOLEN_SHAPE: Record<string, unknown> = { ...OWN_SHAPE, stableId: 'smokerBox' };

/** Tvar, ze kterého nečerpá nikdo — vymeshoval by se a nikdy neukázal. */
const ORPHAN_SHAPE: Record<string, unknown> = {
  ...OWN_SHAPE,
  shapeId: 'ghostPost',
  stableId: 'smokerBox',
};

const FAULTS = {
  schema: () => faultFrom(answerWith({ title: 'a hillside terrace' })),
  geometry: () => faultFrom(answerWith({ geometry: 'cathedral' })),
  budget: () => faultFrom(answerWith({ shapes: [SWARM_SHAPE] })),
  reference: () => faultFrom(answerWith({ shapes: [STOLEN_SHAPE, ORPHAN_SHAPE] })),
} as const;

/* ================================================================== *
 * 1. Věta, kterou model pochopí.
 * ================================================================== */

describe('every gate that rejects turns into a sentence', () => {
  it('names the gate it came from', () => {
    expect(FAULTS.schema().reason).toBe('WRONG_SHAPE');
    expect(FAULTS.geometry().reason).toBe('GEOMETRY_NOT_AUTHORED');
    expect(FAULTS.budget().reason).toBe('SHAPE_INVALID');
    expect(FAULTS.reference().reason).toBe('REFERENCE_BROKEN');
  });

  it.each(Object.entries(FAULTS))('opens %s with the code and closes with an instruction', (_name, of) => {
    const fault = of();
    const sentence = blueprintRejectionSentence(fault);

    expect(sentence.startsWith(`${fault.reason} · `)).toBe(true);
    // Kód a co s tím. Bez druhé půlky je to stížnost, ne oprava.
    expect(sentence).toContain(fault.detail);
    expect(sentence.trimEnd().endsWith('.')).toBe(true);
    // `invalid shape` je celá zpráva o osmi znacích; tenhle práh ji vyloučí a
    // přitom nezakáže žádnou poctivou hlášku brány.
    expect(sentence.length).toBeGreaterThan(120);
  });

  it('carries the number the budget gate measured, not the word "invalid"', () => {
    const sentence = blueprintRejectionSentence(FAULTS.budget());

    expect(sentence).toContain('4096 copies');
    expect(sentence).toContain('maxInstances 256');
    expect(sentence).not.toBe('invalid shape');
  });

  it('gives the reference fault the address on both sides', () => {
    const sentence = blueprintRejectionSentence(FAULTS.reference());

    expect(sentence).toContain('smokerBox');
    expect(sentence).toContain('tallHive');
    expect(sentence).toContain('stableId');
  });

  it('lists the other findings too, so one round can fix more than one thing', () => {
    const fault = FAULTS.reference();
    // Předpoklad testu, ne vedlejší tvrzení: kdyby brána vracela jediný nález,
    // tenhle test by nic neměřil a mlčel by o tom.
    expect(fault.issues.length).toBeGreaterThan(1);

    const sentence = blueprintRejectionSentence(fault);
    // Adresa se mezi `detail` a `issues` přeformátovává, takže se hledá obsah
    // nálezu, ne jeho doslovné znění.
    for (const issue of fault.issues) {
      const body = issue.slice(issue.indexOf(': ') + 2);
      expect(sentence).toContain(body);
    }
  });

  it('does not repeat the first finding as if it were a second one', () => {
    // Compiler skládá `detail` z `issues[0]` přeformátovaně (`shapes/0:` →
    // `shapes[0]:`), takže doslovné porovnání ten nález nepozná a věta ho
    // vypíše dvakrát — podruhé pod návěštím „a každý zvlášť". Naměřeno
    // nezávislou revizí 31. 8. 2026.
    const fault = FAULTS.budget();
    const sentence = blueprintRejectionSentence(fault);
    const twice = sentence.split('program expands to 4096 copies').length - 1;

    expect(twice).toBe(1);
    // A druhý, doopravdy jiný nález se přitom ztratit nesmí.
    expect(sentence).toContain('maxEvaluations 512');
  });

  it('says how many findings it left out when there are more than six', () => {
    const fault: BlueprintFault = {
      reason: 'GEOM_INVALID',
      detail: 'node 0 is broken',
      issues: Array.from({ length: 9 }, (_unused, at) => `node ${String(at)} is broken`),
    };

    const sentence = blueprintRejectionSentence(fault);
    expect(sentence).toContain('and 2 more of the same kind');
  });

  it('still names the code and the instruction when the gate gave no detail', () => {
    const sentence = blueprintRejectionSentence({
      reason: 'NOT_AN_OBJECT',
      detail: '',
      issues: [],
    });

    expect(sentence.startsWith('NOT_AN_OBJECT · ')).toBe(true);
    expect(sentence).toContain('geometry, shapes, placements and world');
  });

  it('has an instruction for every reason the compiler can return', () => {
    // Úplnost drží `tsc` nad `Record<CompilerRejection, string>`; tenhle test
    // hlídá to druhé — že žádná z instrukcí není prázdná ani duplikát kódu.
    const reasons: readonly CompilerRejection[] = [
      'NOT_AN_OBJECT',
      'WRONG_SHAPE',
      'EXAMPLE_COPIED',
      'GEOMETRY_NOT_AUTHORED',
      'GEOM_INVALID',
      'SHAPE_INVALID',
      'PLACEMENT_MISMATCH',
      'REFERENCE_BROKEN',
      'BLUEPRINT_INVALID',
      'WORLD_REJECTED',
    ];

    for (const reason of reasons) {
      const sentence = blueprintRejectionSentence({ reason, detail: 'x', issues: [] });
      const instruction = sentence.slice(`${reason} · x. `.length);
      expect(instruction.length).toBeGreaterThan(40);
      expect(instruction).not.toContain(reason);
    }
  });
});

/* ================================================================== *
 * 2. Opravný požadavek.
 * ================================================================== */

describe('the repair round fits where the first round fitted', () => {
  const first = buildCompilerRequest(PLAN, grammar);
  const previous = answerWith({ geometry: 'cathedral' });
  const repair = buildRepairRequest(first, previous, FAULTS.geometry());

  it('keeps the example, because the brief it re-sends points straight at it', () => {
    // Požadavek prvního kola říká „The example above demonstrates shape only"
    // a opravné kolo ho přikládá znovu. Kdyby se ukázka ze systémové zprávy
    // odřízla, mířila by ta věta na nejbližší JSON nad sebou — na vlastní
    // odpověď modelu, kterou má naopak zachovat. Naměřeno nezávislou revizí
    // 31. 8. 2026.
    expect(first.user).toContain('The example above');
    expect(repair.user).toContain('The example above');
    expect(repair.system).toContain(BLUEPRINT_EXAMPLE_MARKER);
    expect(repair.system).toBe(first.system);
  });

  it('keeps the world contract closed, so the model still knows where it ends', () => {
    expect(repair.system).toContain(WORLD_CONTRACT_END);
  });

  it('adds nothing but the sentence and the answer it rejected', () => {
    // Tohle je ta vlastnost, kterou AC chce po „vejde se do okna": smyčka sama
    // nesmí požadavek nafukovat. Roste jen o odmítnutou odpověď a o větu —
    // obojí je vstup, ne rozhodnutí téhle smyčky.
    const sentence = blueprintRejectionSentence(FAULTS.geometry());
    const grew = repair.system.length + repair.user.length - (first.system.length + first.user.length);
    const carried = JSON.stringify(previous).length + sentence.length;

    expect(grew).toBeGreaterThan(0);
    // Naměřeno 31. 8. 2026: obal opravné zprávy stojí 236 znaků (čtyři věty a
    // prázdné řádky) a nic dalšího nepřibývá. 300 je ta hodnota se stejnou
    // rezervou, jakou má zbytek repa — pin je na tom, že obal je konstanta.
    expect(grew).toBeLessThan(carried + 300);
  });

  it('shows the model its own rejected answer and the original brief', () => {
    expect(repair.user).toContain('cathedral');
    expect(repair.user).toContain(first.user);
    expect(repair.user).toContain('GEOMETRY_NOT_AUTHORED');
  });

  it('keeps the brief last, because that is the order the first round used', () => {
    expect(repair.user.endsWith(first.user)).toBe(true);
  });

  it('does not renegotiate which model answers', () => {
    expect(repair.model).toBe(first.model);
  });
});

/* ================================================================== *
 * 3. Smyčka.
 * ================================================================== */

/** Emitor, který odpovídá ze seznamu. Poslední odpověď se opakuje. */
function scripted(answers: readonly unknown[]): {
  emit: (request: { system: string; user: string }) => Promise<unknown>;
  seen: { system: string; user: string }[];
} {
  const seen: { system: string; user: string }[] = [];
  return {
    seen,
    emit: (request) => {
      seen.push(request);
      return Promise.resolve(answers[Math.min(seen.length - 1, answers.length - 1)]);
    },
  };
}

const run = (answers: readonly unknown[]) => {
  const script = scripted(answers);
  return {
    script,
    outcome: compileWithRepair({ plan: PLAN, grammar, sessionSeed: SEED, emit: script.emit }),
  };
};

describe('the loop stops at the first accepted blueprint', () => {
  it('stops the moment one answer compiles', async () => {
    const { script, outcome } = run([answerWith({ geometry: 'cathedral' }), OWN_ANSWER]);
    const done = await outcome;

    expect(done.kind).toBe('compiled');
    expect(done.rounds).toHaveLength(2);
    expect(done.rounds[1].fault).toBeNull();
    // Třetí volání by bylo zaplacené za nic.
    expect(script.seen).toHaveLength(2);
  });

  it('accepts the first round without ever building a repair request', async () => {
    const { script, outcome } = run([OWN_ANSWER]);
    const done = await outcome;

    expect(done.kind).toBe('compiled');
    expect(done.rounds).toHaveLength(1);
    expect(script.seen[0].system).toContain(BLUEPRINT_EXAMPLE_MARKER);
  });

  it('records what THAT round sent, not what the first round sent', async () => {
    const { outcome } = run([answerWith({ geometry: 'cathedral' }), OWN_ANSWER]);
    const done = await outcome;

    if (done.kind !== 'compiled') throw new Error(done.kind);
    // Systémová zpráva je v obou kolech táž, takže je rozlišuje požadavek:
    // ten opravný nese kód vady, první kolo o žádné neví.
    expect(done.result.verdict.body.upstream.user).toContain('GEOMETRY_NOT_AUTHORED');
  });
});

describe('the loop is bounded', () => {
  it('turns at most three times, even while every round is a different fault', async () => {
    const { script, outcome } = run([
      answerWith({ geometry: 'cathedral' }),
      answerWith({ shapes: [SWARM_SHAPE] }),
      answerWith({ shapes: [STOLEN_SHAPE] }),
      OWN_ANSWER,
    ]);
    const done = await outcome;

    expect(done.kind).toBe('rejected');
    expect(done.rounds).toHaveLength(MAX_BLUEPRINT_ROUNDS);
    expect(script.seen).toHaveLength(MAX_BLUEPRINT_ROUNDS);
    expect(done.rounds.map((round) => round.fault?.reason)).toEqual([
      'GEOMETRY_NOT_AUTHORED',
      'SHAPE_INVALID',
      'REFERENCE_BROKEN',
    ]);
  });

  it('gives up early on a fault that did not move', async () => {
    const { script, outcome } = run([answerWith({ geometry: 'cathedral' })]);
    const done = await outcome;

    expect(done.kind).toBe('rejected');
    expect(done.rounds).toHaveLength(2);
    expect(script.seen).toHaveLength(2);
  });

  it('keeps turning while the same reason names a different object', async () => {
    // Dvě `PLACEMENT_MISMATCH` za sebou, pokaždé o jiném objektu. Kdyby se
    // nepohnutost soudila jen podle `reason` (a `issues` je u tohohle důvodu
    // prázdné), byl by tohle konec smyčky uprostřed pokroku.
    const withoutWall = OWN_PLACEMENTS.filter((placement) => placement.stableId !== 'drystoneWall');
    const withoutBox = OWN_PLACEMENTS.filter((placement) => placement.stableId !== 'smokerBox');

    const { outcome } = run([
      answerWith({ placements: withoutWall }),
      answerWith({ placements: withoutBox }),
      OWN_ANSWER,
    ]);
    const done = await outcome;

    expect(done.kind).toBe('compiled');
    expect(done.rounds).toHaveLength(3);
    expect(done.rounds.slice(0, 2).map((round) => round.fault?.reason)).toEqual([
      'PLACEMENT_MISMATCH',
      'PLACEMENT_MISMATCH',
    ]);
  });
});

describe('a broken model is not a verdict about the blueprint', () => {
  it('reports it as unavailable and keeps the rounds that did run', async () => {
    let calls = 0;
    const done = await compileWithRepair({
      plan: PLAN,
      grammar,
      sessionSeed: SEED,
      emit: () => {
        calls += 1;
        if (calls === 1) return Promise.resolve(answerWith({ geometry: 'cathedral' }));
        return Promise.reject(new Error('upstream timed out'));
      },
    });

    expect(done.kind).toBe('unavailable');
    if (done.kind !== 'unavailable') throw new Error(done.kind);
    expect(done.detail).toContain('upstream timed out');
    expect(done.rounds).toHaveLength(1);
  });
});
