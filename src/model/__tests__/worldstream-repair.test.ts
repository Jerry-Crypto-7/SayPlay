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
  // `world` se **musí** přenést. Kdyby ho tahle fixtura upustila, sada by
  // soudila obecnou zálohu místo věty, kterou model doopravdy dostane — a
  // právě to je vlastnost, kterou pin níž hlídá.
  return {
    reason: result.reason,
    detail: result.detail,
    issues: result.issues,
    ...(result.world === undefined ? {} : { world: result.world }),
  };
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

/** Svět, jehož vítězné pravidlo míří na socket, který nikdo nedeklaroval. */
const DANGLING_WORLD = (): Record<string, unknown> => {
  const world = structuredClone(OWN_WORLD) as {
    sim: { rules: { win: { event: { zone: string } } } };
  };
  world.sim.rules.win.event.zone = 'noSuchPad';
  return world as unknown as Record<string, unknown>;
};

/** Svět, jehož `sim` nemá mřížku — praskne na schématu, ne na referencích. */
const MALFORMED_WORLD = (): Record<string, unknown> => {
  const world = structuredClone(OWN_WORLD) as { sim: Record<string, unknown> };
  delete world.sim.grid;
  return world as unknown as Record<string, unknown>;
};

/**
 * Svět, jehož vlastní stopa začíná za horizontem — `STEP_UNREACHABLE` na kroku 0.
 *
 * Vítězné pravidlo se maže schválně: dokud svět vyhrát jde, hledač svědka si
 * cestu najde sám a stopu modelu **přepíše** (`repair.ts` → `witnessSolved`),
 * takže by se k odmítnutí nikdy nedošlo. Tohle je tedy jediná cesta, jak přes
 * bránu dostat vadu s **indexem kroku**, a proto na ní stojí adresa v testu níž.
 */
const UNREACHABLE_STEP_WORLD = (): Record<string, unknown> => {
  const world = structuredClone(OWN_WORLD) as {
    sim: { rules: Record<string, unknown>; witness?: unknown };
  };
  delete world.sim.rules.win;
  world.sim.witness = {
    tier: 'short',
    ops: [{ tick: 5000, actor: 'walker', actionId: 'move', target: 'gatePad' }],
  };
  return world as unknown as Record<string, unknown>;
};

/**
 * Svět, který sim nenapsal a řekl to nahlas — `sim: null`, `simOutcome: "NO_FIT"`.
 *
 * Není to vymyšlený tvar: přesně tohle vrátil Codex ve spiku z 5. 9. 2026 na
 * větu `c01`, a to třikrát po sobě, protože ho z toho opravné kolo nedostalo.
 * Vede přes `certifySteps()` na `stage: 'declined'`, tedy jedinou fázi, kde si
 * `blueprintRejectionSentence()` píše větu sama místo aby ji převzala.
 */
const DECLINED_WORLD = (): Record<string, unknown> => {
  const world = structuredClone(OWN_WORLD) as Record<string, unknown>;
  world.sim = null;
  world.simOutcome = 'NO_FIT';
  return world;
};

const FAULTS = {
  schema: () => faultFrom(answerWith({ title: 'a hillside terrace' })),
  geometry: () => faultFrom(answerWith({ geometry: 'cathedral' })),
  budget: () => faultFrom(answerWith({ shapes: [SWARM_SHAPE] })),
  reference: () => faultFrom(answerWith({ shapes: [STOLEN_SHAPE, ORPHAN_SHAPE] })),
} as const;

/**
 * Odmítnutí **světového grafu**, a proto zvlášť od `FAULTS`.
 *
 * U těch čtyř nahoře je `detail` z brány zároveň větou pro model a sada to tak
 * i soudí (`toContain(fault.detail)`). Svět má vlastní slovník vět — compilerův
 * `detail` je u něj jen předponovaná zpráva pro člověka a věta pro model se
 * skládá jinak. Slít je do jednoho `it.each` by znamenalo tu asserci uvolnit,
 * takže mají vlastní sekci s vlastními tvrzeními.
 */
const WORLD_FAULTS = {
  dangling: () => faultFrom(answerWith({ world: DANGLING_WORLD() })),
  malformed: () => faultFrom(answerWith({ world: MALFORMED_WORLD() })),
  unreachableStep: () => faultFrom(answerWith({ world: UNREACHABLE_STEP_WORLD() })),
  declined: () => faultFrom(answerWith({ world: DECLINED_WORLD() })),
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
 * 1b. Odmítnutý svět dostane radu své fáze, ne jednu pro všechny.
 * ================================================================== */

/**
 * **Pin, a je to ten druh vady, kterou oko nechytí.** Rada k jiné vadě se čte
 * úplně stejně dobře jako ta správná: věta je anglicky, celá, končí tečkou a
 * jde modelu poslat. Nepozná se, dokud někdo neporovná dvě různé vady — a pak
 * je vidět, že dostaly týž text. Certifikace jich rozlišuje **sedm**.
 */
describe('a rejected world gets the advice of its own stage', () => {
  /** Obecná záloha z `WHAT_TO_DO`. Ve větě se stagí ji nikdo vidět nesmí. */
  const GENERIC = 'Repair the world field only.';

  it('reaches the certification stage as a field, not as a text prefix', () => {
    expect(WORLD_FAULTS.dangling().world?.rejection.stage).toBe('references');
    expect(WORLD_FAULTS.malformed().world?.rejection.stage).toBe('schema');
    expect(WORLD_FAULTS.unreachableStep().world?.rejection.stage).toBe('witness');
  });

  it('gives three different world faults three different instructions', () => {
    const sentences = [
      blueprintRejectionSentence(WORLD_FAULTS.dangling()),
      blueprintRejectionSentence(WORLD_FAULTS.malformed()),
      blueprintRejectionSentence(WORLD_FAULTS.unreachableStep()),
    ];

    // Tři fáze, tři rady. Jedna společná by prošla úplně stejně zeleně jako
    // tři různé, dokud je někdo nepoloží vedle sebe.
    expect(new Set(sentences).size).toBe(3);
    for (const sentence of sentences) expect(sentence).not.toContain(GENERIC);

    expect(sentences[0]).toContain('Declare that name in the world first');
    expect(sentences[2]).toContain('Remove or reorder that move');
    expect(sentences[1]).not.toContain('Declare that name in the world first');
  });

  it('carries the step the model actually wrote, not just its number', () => {
    // Adresa kroku je jediné, co k odmítnutí přidává sama emise — `Rejection`
    // nese index, nikoli tah. Bez kontextu z opraveného dokumentu by věta
    // řekla „at step 0" a model by musel hádat, který tah to byl.
    const sentence = blueprintRejectionSentence(WORLD_FAULTS.unreachableStep());

    expect(sentence).toContain('at step 0 (walker: move → gatePad)');
  });

  it('still opens with the code, so the model sees the same fault twice', () => {
    const sentence = blueprintRejectionSentence(WORLD_FAULTS.dangling());

    expect(sentence.startsWith('WORLD_REJECTED · ')).toBe(true);
    // Adresa, kterou certifikace naměřila, ne jen „the world was rejected".
    expect(sentence).toContain('noSuchPad');
  });

  it('falls back to the generic advice only when there is no rejection to read', () => {
    // Certifikace umí skončit neúspěchem bez `Rejection`; tam je obecná rada
    // jediná, kterou lze poctivě napsat, a musí zůstat použitelná.
    const sentence = blueprintRejectionSentence({
      reason: 'WORLD_REJECTED',
      detail: 'the world graph did not certify',
      issues: [],
    });

    expect(sentence).toContain(GENERIC);
  });

  it('stops offering the model that it may keep declining, because it took that offer', () => {
    // ⚠ **Naměřeno 5. 9. 2026, spike `d749ce7`.** Sdílená věta z
    // `local/rejection-prompt.ts` končí slovy „or keep declining only if the
    // request truly cannot be built" a Codex ji přijal ve všech třech kolech:
    // odpověď se mezi koly nehnula a smyčka dojela do stropu. Tenhle test tedy
    // pinuje **nepřítomnost nabídky**, ne přítomnost formulace — kdyby se sem
    // ta věta vrátila jinými slovy, měřidlo by ji muselo chytit taky.
    const fault = WORLD_FAULTS.declined();
    expect(fault.world?.rejection.stage).toBe('declined');

    const sentence = blueprintRejectionSentence(fault);

    expect(sentence).not.toContain('keep declining');
    expect(sentence).not.toContain('truly cannot be built');
  });

  it('tells the model to keep the half the compiler already accepted', () => {
    // Geometrie, tvary a placementy prošly — bránu minul jen svět. Kdyby to
    // věta neřekla, model by v dalším kole přepsal i to, co bylo v pořádku,
    // a smyčka by opravovala jinou vadu, než na které se zastavila.
    const sentence = blueprintRejectionSentence(WORLD_FAULTS.declined());

    expect(sentence.startsWith('WORLD_REJECTED · ')).toBe(true);
    for (const kept of ['geometry', 'shapes', 'placements']) expect(sentence).toContain(kept);
  });

  it('recommends the tier that would fit instead of a general instruction', () => {
    // ⚠ **Ručně složené odmítnutí, a je to naměřený důvod, ne pohodlí.**
    // `NO_FIT` se přes `compileBlueprint` vyrobit nedá: `witnessEnvelope()`
    // v `repair.ts:222` přepíše `H_cert` stropem tieru dřív, než se
    // certifikuje, takže `resolvePolicy()` politiku vždycky najde. Rada, která
    // tier počítá, se proto testuje na vstupu do věty, ne přes bránu.
    const sentence = blueprintRejectionSentence({
      reason: 'WORLD_REJECTED',
      detail: 'witness: horizon 1200 does not fit tier short',
      issues: [],
      world: {
        rejection: {
          stage: 'witness',
          reason: 'NO_FIT',
          detail: 'horizon 1200 does not fit tier short',
          issues: [],
          atStep: null,
        },
        context: { horizonTicks: 1200 },
      },
    });

    expect(sentence).toContain('"standard"');
    expect(sentence).not.toContain(GENERIC);
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

const run = (answers: readonly unknown[], maxRounds?: number) => {
  const script = scripted(answers);
  return {
    script,
    outcome: compileWithRepair({
      plan: PLAN,
      grammar,
      sessionSeed: SEED,
      emit: script.emit,
      ...(maxRounds === undefined ? {} : { maxRounds }),
    }),
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

  it('turns as many times as the caller allows, because a round is not always paid', async () => {
    // Naměřeno 5. 9. 2026: sedm z jedenácti neúspěchů autorského běhu skončilo
    // přesně na stropu a ani jeden na nepohnutém odmítnutí — model opravoval
    // dál a jen mu došla kola. Strop je odůvodněný cenou placeného volání,
    // a tu nehlídaný běh na předplatném neplatí.
    const { script, outcome } = run(
      [
        answerWith({ geometry: 'cathedral' }),
        answerWith({ shapes: [SWARM_SHAPE] }),
        answerWith({ shapes: [STOLEN_SHAPE] }),
        OWN_ANSWER,
      ],
      6,
    );
    const done = await outcome;

    // Čtvrté kolo je to, které by se při stropu tři nikdy neodehrálo.
    expect(done.kind).toBe('compiled');
    expect(script.seen).toHaveLength(4);
  });

  it('still stops at three when nobody asks for more, so the paid path is unchanged', async () => {
    const { script, outcome } = run([
      answerWith({ geometry: 'cathedral' }),
      answerWith({ shapes: [SWARM_SHAPE] }),
      answerWith({ shapes: [STOLEN_SHAPE] }),
      OWN_ANSWER,
    ]);
    const done = await outcome;

    expect(done.kind).toBe('rejected');
    expect(script.seen).toHaveLength(MAX_BLUEPRINT_ROUNDS);
  });

  it('gives up on a fault that already happened, not only on the one just before', async () => {
    // Kmit A→B→A. Do 5. 9. 2026 se porovnávalo jen minulé kolo, takže tohle
    // prošlo celé — a při vyšším stropu by se protáčelo dokola. Zastavit se má
    // na kole 3, kde se `GEOMETRY_NOT_AUTHORED` vrací podruhé.
    const { script, outcome } = run(
      [
        answerWith({ geometry: 'cathedral' }),
        answerWith({ shapes: [SWARM_SHAPE] }),
        answerWith({ geometry: 'cathedral' }),
        OWN_ANSWER,
      ],
      6,
    );
    const done = await outcome;

    expect(done.kind).toBe('rejected');
    expect(script.seen).toHaveLength(3);
    expect(done.rounds.map((round) => round.fault?.reason)).toEqual([
      'GEOMETRY_NOT_AUTHORED',
      'SHAPE_INVALID',
      'GEOMETRY_NOT_AUTHORED',
    ]);
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

/* ================================================================== *
 * 4. Za vadu na naší straně se modelu neplatí.
 * ================================================================== */

/**
 * **Pin, a soudí se na něm počet volání, ne text.** Vadné `sessionSeed` projde
 * celou smyčkou zeleně: tři kola proběhnou, report ukáže `BLUEPRINT_INVALID`
 * a vypadá to jako neschopnost modelu. Jediné, co tu vadu prozradí, je
 * **kolikrát se zaplatilo** — a to je číslo, na které se nikdo nedívá, dokud
 * ho někdo neasertuje.
 */
describe('a fault in a field the system writes never reaches the model', () => {
  /** Emitor, jehož zavolání je samo o sobě selhání testu. */
  const neverCalled = (): { emit: () => Promise<unknown>; calls: () => number } => {
    let calls = 0;
    return {
      emit: () => {
        calls += 1;
        return Promise.resolve(OWN_ANSWER);
      },
      calls: () => calls,
    };
  };

  it('spends nothing on a session seed the model does not write', async () => {
    const model = neverCalled();
    const done = await compileWithRepair({
      plan: PLAN,
      grammar,
      sessionSeed: -1,
      emit: model.emit,
    });

    expect(model.calls()).toBe(0);
    expect(done.rounds).toHaveLength(0);
    expect(done.kind).toBe('invalidInput');
    if (done.kind !== 'invalidInput') throw new Error(done.kind);
    expect(done.detail).toContain('sessionSeed');
  });

  it('spends nothing on an intent that would leave the blueprint untitled', async () => {
    const model = neverCalled();
    const done = await compileWithRepair({
      plan: { ...PLAN, intent: { ...PLAN.intent, setting: '' } },
      grammar,
      sessionSeed: SEED,
      emit: model.emit,
    });

    expect(model.calls()).toBe(0);
    expect(done.kind).toBe('invalidInput');
    if (done.kind !== 'invalidInput') throw new Error(done.kind);
    expect(done.detail).toContain('title');
  });

  it('is not a verdict about the model, so it is not a rejection', async () => {
    // `rejected` říká „model odpověděl a odpověď neprošla". Kdyby sem spadla
    // vada vstupu, report by ji spočítal do neúspěchů modelu.
    const model = neverCalled();
    const done = await compileWithRepair({
      plan: PLAN,
      grammar,
      sessionSeed: 2 ** 31,
      emit: model.emit,
    });

    expect(done.kind).not.toBe('rejected');
    expect(done.kind).not.toBe('unavailable');
  });

  it('lets a seed the schema accepts through to the model', async () => {
    // Protipůlka: kontrola nesmí zavřít cestu, která je v pořádku. `0` je
    // krajní hodnota rozsahu a přesně ta, kterou by „> 0" chybně odmítla.
    const model = neverCalled();
    await compileWithRepair({ plan: PLAN, grammar, sessionSeed: 0, emit: model.emit });

    expect(model.calls()).toBe(1);
  });
});
