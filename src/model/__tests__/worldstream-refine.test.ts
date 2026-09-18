/**
 * **Druhá věta: kdo je cíl a co z odpovědi modelu projde** (P15 T22).
 *
 * Dvě vlastnosti, které oko nepokryje, a proto se tu soudí:
 *
 * 1. **Grounding se smí splést jen nahlas.** Věta, která ukazuje na dva objekty
 *    stejně dobře, musí vrátit oba — tichý výběr vypadá v preview naprosto
 *    v pořádku a porotce pozná až po commitu, že se změnilo něco jiného.
 * 2. **Faseta nesmí přeřadit operaci.** `behavior` s cestou do `/look` je vadná
 *    odpověď, ne přeřazená operace; kdyby se přijala, model by si štítkem
 *    vybíral, jestli jeho změna půjde přes verifikátor — přesně to, co
 *    `DESIGN-BOOK.md` §7 zakazuje.
 *
 * Blueprint je ruční a projde `blueprintSchema`, ne compilerem: tahle vrstva
 * o certifikaci nic neví a spouštět kvůli ní celý řetěz by z jednotkové sady
 * udělalo integrační. Certifikaci soudí `changes.test.ts` nad skutečným světem.
 */

import { describe, expect, it } from 'vitest';

import { GEOM_VERSION } from '@/geom/program';
import { blueprintSchema, MAX_HERO_SHAPES, type WorldstreamBlueprint } from '@/worldstream/schema';

import type { UpstreamRequest } from '../prompt';
import {
  buildAdditionRequest,
  buildRefineRequest,
  groundTarget,
  planChange,
  readAdditionEmission,
  readRefineEmission,
  type GroundingCandidate,
} from '../worldstream-refine';

/* ------------------------------------------------------------------ *
 * Svět, ve kterém se ukazuje.
 * ------------------------------------------------------------------ */

const BRIDGE_SPAN = {
  shapeId: 'bridgeSpan',
  stableId: 'stoneBridge',
  nodes: [
    { kind: 'prism', sides: 4, radius: 0.24, height: 3.2 },
    { kind: 'taper', child: 0, axis: 'y', amount: 0.35 },
  ],
  root: 1,
  targetBounds: { min: [-0.3, -1.7, -0.3], max: [0.3, 1.7, 0.3] },
  anchors: [{ name: 'tip', at: [0, 1.6, 0], normal: [0, 1, 0] }],
  materialIntent: 'stone',
  priority: 9,
};

function geomNode(seed: number): unknown {
  return { kind: 'terrain', variant: 'plateau', extent: [20, 20], amplitude: 0.2, seed };
}

function object(
  stableId: string,
  label: string,
  synonyms: readonly string[],
  source: unknown,
): unknown {
  return {
    stableId,
    label,
    synonyms,
    role: 'prop',
    source,
    targetBounds: { min: [-1, 0, -1], max: [1, 2, 1] },
    importance: 2,
  };
}

/**
 * Objekty jsou vybrané tak, aby každý soudil jinou větev groundingu: dvě
 * lucerny nesou **totožné** synonymum (nerozhodnutá věta), zábradlí nese jméno
 * **delší** než most, který je v něm obsažený, a mech se dá trefit jen slovy
 * z camelCase id.
 */
const BLUEPRINT: WorldstreamBlueprint = blueprintSchema.parse({
  version: 'worldstream-v1',
  sessionSeed: 4021,
  title: 'a stone bridge over deep water',
  intent: {
    setting: 'a stone bridge over deep water, two lanterns on its rail',
    mood: 'still, cold, lit from below',
    spatialThesis:
      'The bridge is the only way across, so every path in the scene converges on the same twelve metres of stone.',
    actors: ['the walker'],
    heroObjects: ['the stone bridge'],
    interactions: ['the walker crosses and the lanterns light behind them'],
    unsupported: ['the water is a surface, not a fluid you can displace'],
  },
  world: {
    irVersion: 'v1',
    simRevision: 0,
    lookRevision: 0,
    simHash: 'deadbeef',
    sim: {
      layout: { width: 12, height: 8 },
      grid: { cell: 1 },
      sockets: { startPad: [1, 4], farPad: [10, 4] },
      collisionAabb: { walker: [1, 4, 1, 1] },
      entities: { walker: { role: 'actor', socket: 'startPad', state: 'idle' } },
      state: { counters: {}, flags: {}, timers: {}, zones: {}, slots: 0 },
      rules: {},
      witness: { tier: 'short', H_cert: 600, ops: [] },
    },
    look: {
      modules: {},
      palette: 'moss',
      lightRig: 'rim',
      atmosphere: 'clear',
      materialRoles: {},
      camera: { kind: 'orbit' },
      audio: {},
    },
  },
  geometry: {
    version: GEOM_VERSION,
    nodes: [geomNode(1), geomNode(2), geomNode(3), geomNode(4), { kind: 'group', children: [0, 1, 2, 3] }],
    root: 4,
  },
  objects: [
    object('stoneBridge', 'the stone bridge', ['the bridge', 'the crossing'], {
      kind: 'shape',
      shapeId: 'bridgeSpan',
    }),
    object('bridgeRailing', 'the bridge railing', ['the railing'], { kind: 'geom', node: 0 }),
    object('deepWater', 'the water', ['the river'], { kind: 'geom', node: 1 }),
    object('leftLantern', 'the left lantern', ['the lantern'], { kind: 'geom', node: 2 }),
    object('rightLantern', 'the right lantern', ['the lantern'], { kind: 'geom', node: 3 }),
    object('mossPatch', 'the green carpet', ['the green stuff'], { kind: 'geom', node: 0 }),
  ],
  shapes: [BRIDGE_SPAN],
});

function objectNamed(stableId: string) {
  const found = BLUEPRINT.objects.find((entry) => entry.stableId === stableId);
  if (found === undefined) throw new Error(`the fixture has no object ${stableId}`);
  return found;
}

const BRIDGE = objectNamed('stoneBridge');
const WATER = objectNamed('deepWater');

function ground(sentence: string, stableId?: string) {
  return groundTarget(sentence, BLUEPRINT.objects, stableId);
}

function idsOf(candidates: readonly GroundingCandidate[]): string[] {
  return candidates.map((candidate) => candidate.stableId);
}

/* ------------------------------------------------------------------ *
 * Grounding.
 * ------------------------------------------------------------------ */

describe('grounding druhé věty', () => {
  it('trefí objekt podle popisku', () => {
    const grounding = ground('make the water darker');
    expect(grounding.ok && grounding.target.stableId).toBe('deepWater');
  });

  it('trefí objekt podle synonyma', () => {
    const grounding = ground('raise the crossing by two metres');
    expect(grounding.ok && grounding.target.stableId).toBe('stoneBridge');
  });

  it('trefí objekt podle slov ze stableId, i když je popisek jiný', () => {
    // `mossPatch` se jmenuje „the green carpet"; jediná cesta k němu vede přes
    // camelCase id rozepsané na slova.
    const grounding = ground('clear the moss patch off the stones');
    expect(grounding.ok && grounding.target.stableId).toBe('mossPatch');
  });

  it('delší jméno vyhraje nad kratším, které je v něm obsažené', () => {
    const grounding = ground('raise the bridge railing');
    expect(grounding.ok && grounding.target.stableId).toBe('bridgeRailing');
  });

  it('jméno se hledá po celých slovech, ne podřetězcem', () => {
    const grounding = ground('the watercourse floods every spring');
    expect(grounding.ok).toBe(false);
    if (!grounding.ok) expect(grounding.reason).toBe('NO_MATCH');
  });

  it('dvě jména stejné délky se nerozhodují a nabídnou se obě', () => {
    const grounding = ground('turn the lantern green');
    expect(grounding.ok).toBe(false);
    if (grounding.ok) return;
    expect(grounding.reason).toBe('AMBIGUOUS');
    // **Jen ty nerozhodnuté**, ne celý svět: nabídka, ve které stojí i voda,
    // je pro člověka horší než žádná.
    expect(idsOf(grounding.candidates).sort()).toEqual(['leftLantern', 'rightLantern']);
  });

  it('věta bez jména nabídne všechny objekty', () => {
    const grounding = ground('make it more beautiful please');
    expect(grounding.ok).toBe(false);
    if (grounding.ok) return;
    expect(grounding.reason).toBe('NO_MATCH');
    expect(grounding.candidates).toHaveLength(BLUEPRINT.objects.length);
  });

  it('explicitní stableId přebije text věty', () => {
    const grounding = ground('make the water darker', 'stoneBridge');
    expect(grounding.ok && grounding.target.stableId).toBe('stoneBridge');
  });

  it('neznámé stableId se NEdohledá textem', () => {
    // Klient tvrdí něco o světě, který nemá. Tiché přepnutí na objekt z věty by
    // změnilo něco jiného, než na co porotce klikl.
    const grounding = ground('make the water darker', 'ghostBridge');
    expect(grounding.ok).toBe(false);
    if (!grounding.ok) expect(grounding.reason).toBe('UNKNOWN_ID');
  });
});

/* ------------------------------------------------------------------ *
 * Emise.
 * ------------------------------------------------------------------ */

const ROOTED_ROOTS = { woven: 'woven roots' };

function emission(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: `the bridge becomes ${ROOTED_ROOTS.woven} and only grows while the lanterns are lit`,
    shape: null,
    behavior: [{ op: 'add', path: '/sim/state/flags/lit', value: true }],
    appearance: [{ op: 'replace', path: '/look/palette', value: 'sand' }],
    ...overrides,
  };
}

const LANTERN_RULE = {
  phase: 0,
  priority: 1,
  event: { kind: 'onEnterZone', entity: 'walker', zone: 'deck' },
  condition: null,
  actions: [{ kind: 'win' }],
};

/** Tělo pravidla z operace fasety chování, ať se nemusí odklikávat typy. */
function ruleValue(read: ReturnType<typeof readRefineEmission>, index = 0): Record<string, unknown> {
  if (!read.ok) throw new Error('plán se nepřečetl');
  return (read.value.behavior[index] as { value: Record<string, unknown> }).value;
}

describe('pravidlo dostane `id` z klíče cesty', () => {
  // **Nález nezávislé revize 4. 9. 2026.** Create cestu opravil `949e38f`,
  // editační cesta `id` nedopisovala vůbec — a `add /sim/rules/<klíč>` s tělem
  // bez `id` je pro `introducedRuleKeyFault` **nově zavlečená vada**, takže
  // commit odpoví `REJECTED` a žádné opravné kolo za ním není. Druhá věta tím
  // nemohla založit zákon a porotce zaplatil volání modelu za nic.
  it('add bez `id` ho dostane z posledního tokenu cesty', () => {
    const read = readRefineEmission(
      emission({ behavior: [{ op: 'add', path: '/sim/rules/lightUp', value: LANTERN_RULE }] }),
      BRIDGE,
    );
    expect(read.ok).toBe(true);
    expect(ruleValue(read).id).toBe('lightUp');
  });

  it('replace celého těla je táž vada pod jiným jménem operace', () => {
    const read = readRefineEmission(
      emission({ behavior: [{ op: 'replace', path: '/sim/rules/lightUp', value: LANTERN_RULE }] }),
      BRIDGE,
    );
    expect(read.ok).toBe(true);
    expect(ruleValue(read).id).toBe('lightUp');
  });

  it('`id`, které se rozešlo s klíčem, se přebíjí — stejně jako na create cestě', () => {
    // Klíč JE pointer, kterým se na pravidlo míří, takže pravidlo s cizím `id`
    // leží v dokumentu a žádný patch ho nenajde. `worlddoc` to soudí jako vadu
    // stejně jako `id` chybějící, takže nechat ho být znamená terminální
    // odmítnutí místo funkční změny.
    const read = readRefineEmission(
      emission({
        behavior: [{ op: 'add', path: '/sim/rules/lightUp', value: { ...LANTERN_RULE, id: 'somethingElse' } }],
      }),
      BRIDGE,
    );
    expect(read.ok).toBe(true);
    expect(ruleValue(read).id).toBe('lightUp');
  });

  it('escapovaný token se odescapuje, protože klíč v dokumentu je ten holý', () => {
    const read = readRefineEmission(
      emission({ behavior: [{ op: 'add', path: '/sim/rules/light~1up', value: LANTERN_RULE }] }),
      BRIDGE,
    );
    expect(read.ok).toBe(true);
    expect(ruleValue(read).id).toBe('light/up');
  });

  it('cesta DOVNITŘ pravidla se nechává být — ta na `id` nesahá', () => {
    // ⚠ **Hodnota tu musí být OBJEKT, a je to naměřené mutací.** První podoba
    // tohohle testu psala `…/priority` s hodnotou `3`, a mutant, který mez
    // délky cesty rozvolní z `!== 3` na `< 3`, ji **přežil**: číslo se zastaví
    // až o dvě podmínky dál na kontrole tvaru, takže aserce neměřila mez, kvůli
    // které tam je. Nad objektem mutant dopíše `id: 'lightUp'` dovnitř
    // **události**, tedy do těla, které model napsal celé sám.
    const event = { kind: 'onEnterZone', entity: 'walker', zone: 'deck' };
    const read = readRefineEmission(
      emission({ behavior: [{ op: 'replace', path: '/sim/rules/lightUp/event', value: event }] }),
      BRIDGE,
    );
    expect(read.ok).toBe(true);
    if (read.ok)
      expect(read.value.behavior[0]).toEqual({
        op: 'replace',
        path: '/sim/rules/lightUp/event',
        value: event,
      });

    // A mělká cesta nad tabulkou jako celkem taky ne: `/sim/rules` je dvojice
    // tokenů, takže žádný klíč pravidla nenese.
    const whole = readRefineEmission(
      emission({ behavior: [{ op: 'replace', path: '/sim/rules', value: {} }] }),
      BRIDGE,
    );
    expect(whole.ok).toBe(true);
    if (whole.ok) expect(whole.value.behavior[0]).toEqual({ op: 'replace', path: '/sim/rules', value: {} });
  });

  it('operace mimo tabulku pravidel se nemění', () => {
    const read = readRefineEmission(emission(), BRIDGE);
    expect(read.ok).toBe(true);
    if (read.ok) {
      expect(read.value.behavior[0]).toEqual({ op: 'add', path: '/sim/state/flags/lit', value: true });
      expect(read.value.appearance[0]).toEqual({ op: 'replace', path: '/look/palette', value: 'sand' });
    }
  });

  it('`remove` a hodnota, která pravidlo není, se nechávají být', () => {
    // `remove` žádné `value` nenese a pole ani `null` pravidlo není — dopsat
    // jim `id` znamená vyrobit operaci, kterou model nenapsal.
    const read = readRefineEmission(
      emission({
        behavior: [
          { op: 'remove', path: '/sim/rules/lightUp' },
          { op: 'add', path: '/sim/rules/broken', value: null },
          { op: 'add', path: '/sim/rules/alsoBroken', value: [1, 2] },
        ],
      }),
      BRIDGE,
    );
    expect(read.ok).toBe(true);
    if (read.ok)
      expect(read.value.behavior).toEqual([
        { op: 'remove', path: '/sim/rules/lightUp' },
        { op: 'add', path: '/sim/rules/broken', value: null },
        { op: 'add', path: '/sim/rules/alsoBroken', value: [1, 2] },
      ]);
  });
});

describe('čtení plánu změny', () => {
  it('rozdělí odpověď na tvar, chování a vzhled', () => {
    const read = readRefineEmission(emission({ shape: BRIDGE_SPAN }), BRIDGE);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.value.stableId).toBe('stoneBridge');
    expect(read.value.shape?.shapeId).toBe('bridgeSpan');
    expect(read.value.behavior).toHaveLength(1);
    expect(read.value.appearance).toHaveLength(1);
  });

  it('chybějící faseta je prázdná faseta, ne vada', () => {
    const read = readRefineEmission(
      { summary: 'the bridge becomes woven roots', shape: BRIDGE_SPAN },
      BRIDGE,
    );
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.value.behavior).toEqual([]);
  });

  it('odmítne operaci chování, která píše do vzhledu', () => {
    const read = readRefineEmission(
      emission({ behavior: [{ op: 'replace', path: '/look/palette', value: 'sand' }] }),
      BRIDGE,
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('WRONG_PART');
  });

  it('odmítne operaci vzhledu, která píše do pravidel', () => {
    const read = readRefineEmission(
      emission({ appearance: [{ op: 'add', path: '/sim/state/flags/lit', value: true }] }),
      BRIDGE,
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('WRONG_PART');
  });

  it('nepustí /simRevision dovnitř sim jen proto, že tak začíná řetězec', () => {
    // `"/simRevision".startsWith("/sim")` je `true`, ačkoli `simRevision` je
    // kořenové pole dokumentu. Rozhoduje rozebraný token, ne prefix.
    const read = readRefineEmission(
      emission({ behavior: [{ op: 'replace', path: '/simRevision', value: 99 }] }),
      BRIDGE,
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('WRONG_PART');
  });

  it('odmítne tvar patřící jinému objektu', () => {
    const read = readRefineEmission(
      emission({ shape: { ...BRIDGE_SPAN, stableId: 'leftLantern' } }),
      BRIDGE,
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('WRONG_TARGET');
  });

  it('odmítne tvar pod cizím shapeId', () => {
    const read = readRefineEmission(
      emission({ shape: { ...BRIDGE_SPAN, shapeId: 'otherSpan' } }),
      BRIDGE,
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('WRONG_TARGET');
  });

  it('odmítne nový tvar pro objekt kreslený kompozicí', () => {
    const read = readRefineEmission(
      emission({ shape: { ...BRIDGE_SPAN, stableId: 'deepWater' } }),
      WATER,
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('NO_SHAPE_SOURCE');
  });

  it('odmítne vadný ShapeProgram', () => {
    const read = readRefineEmission(
      emission({ shape: { ...BRIDGE_SPAN, root: 99 } }),
      BRIDGE,
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('SHAPE_INVALID');
  });

  it('odmítne celý WorldDoc místo změny', () => {
    const read = readRefineEmission(
      { ...emission(), sim: BLUEPRINT.world.sim, irVersion: 'v1' },
      BRIDGE,
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('WORLD_DOC_RETURNED');
  });

  it('odmítne odpověď bez věty pro člověka', () => {
    const read = readRefineEmission(emission({ summary: '   ' }), BRIDGE);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('WRONG_SHAPE');
  });

  it('odmítne změnu, která nic nemění', () => {
    const read = readRefineEmission(
      { summary: 'nothing at all', shape: null, behavior: [], appearance: [] },
      BRIDGE,
    );
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('EMPTY_CHANGE');
  });

  it('odmítne odpověď, která není objekt', () => {
    const read = readRefineEmission([1, 2, 3], BRIDGE);
    expect(read.ok).toBe(false);
    if (!read.ok) expect(read.reason).toBe('NOT_AN_OBJECT');
  });
});

/* ------------------------------------------------------------------ *
 * Zadání pro model.
 * ------------------------------------------------------------------ */

describe('zadání pro model', () => {
  const request = buildRefineRequest('turn the bridge into woven roots', BLUEPRINT, BRIDGE);

  it('nese cíl, jeho současný tvar a obě části dokumentu', () => {
    expect(request.user).toContain('stoneBridge');
    expect(request.user).toContain('bridgeSpan');
    expect(request.user).toContain('"palette": "moss"');
  });

  it('nenese program kompozice, který se změnou jednoho objektu nesouvisí', () => {
    expect(request.user).not.toContain(GEOM_VERSION);
  });

  it('jmenuje obě fasety a zakazuje jejich prohození', () => {
    expect(request.system).toContain('/sim');
    expect(request.system).toContain('/look');
    expect(request.system).toContain('rejected');
  });

  /**
   * `T14r-refineintent`. Druhá věta jde touž branou identifikátoru jako první,
   * ale nemá čím narovnání přiznat — `RefinePlan` nenese `adjustments`. Zvolená
   * cesta je proto „chová se jako dnes a **řekne se to nahlas**": příčina se
   * zavírá v promptu, ne tichým přepisem v preview.
   *
   * Aserce je na **okno kolem toho pole**, ne na celou zprávu. Bez okna zůstane
   * zelená i po smazání obou vět, protože „camelCase" se ve zprávě objeví
   * kdekoli jinde — táž dekorativní past jako u první věty.
   */
  const windowAround = (text: string, needle: string): string => {
    const lines = text.split('\n');
    const at = lines.findIndex((line) => line.includes(needle));
    expect(at).toBeGreaterThan(-1);
    return lines.slice(at, at + 2).join('\n');
  };

  it('říká, jak se píše materialIntent, a že to tady nikdo nepřepíše', () => {
    const near = windowAround(request.system, 'materialIntent');

    expect(near).toContain('camelCase');
    expect(near).toContain('no spaces');
    expect(request.system).toContain('Nothing here rewrites it for you');
  });

  it('describes the production A4 boundary without permitting entity rewrites', () => {
    expect(request.system).toContain('exactly ONE existing rule');
    expect(request.system).toContain('either its condition OR ONE existing action');
    expect(request.system).toContain('Preserve all triggers, event targets, metadata and action count/order');
    expect(request.system).toContain('Do not change entities, sockets, initial state');
    expect(request.system).toContain('A shape-only edit remains supported');
    expect(request.system).not.toContain('role you write there');
  });
});

describe('narovnání identifikátoru na editační cestě', () => {
  /**
   * ⚠ **Tenhle test pinuje CHYBĚJÍCÍ narovnání, ne opomenutí.** Kdyby ho někdo
   * doplnil, `RefinePlan` musí zároveň dostat kanál na přiznané zásahy a
   * preview ho musí ukázat — jinak se změna do světa dostane potichu.
   */
  it('odmítne frázi v materialIntent místo aby ji potichu přepsala', () => {
    const read = readRefineEmission(
      emission({ shape: { ...BRIDGE_SPAN, materialIntent: 'woven roots' } }),
      BRIDGE,
    );

    expect(read.ok).toBe(false);
    if (!read.ok) {
      expect(read.reason).toBe('SHAPE_INVALID');
      expect(read.detail).toContain('materialIntent');
    }
  });
});

/* ------------------------------------------------------------------ *
 * Jedno kolo.
 * ------------------------------------------------------------------ */

describe('planChange', () => {
  function counting(answer: unknown): { emit: (request: UpstreamRequest) => Promise<unknown>; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      emit: async () => {
        calls += 1;
        return answer;
      },
    };
  }

  it('zavolá model jednou a vrátí plán vázaný na cíl', async () => {
    const emitter = counting(emission({ shape: BRIDGE_SPAN }));
    const outcome = await planChange({
      prompt: 'turn the bridge into woven roots',
      blueprint: BLUEPRINT,
      target: BRIDGE,
      emit: emitter.emit,
    });
    expect(outcome.kind).toBe('planned');
    if (outcome.kind === 'planned') expect(outcome.plan.stableId).toBe('stoneBridge');
    expect(emitter.calls()).toBe(1);
  });

  it('výjimka poskytovatele je unavailable, ne pád', async () => {
    const outcome = await planChange({
      prompt: 'turn the bridge into woven roots',
      blueprint: BLUEPRINT,
      target: BRIDGE,
      emit: async () => {
        throw new Error('connect ECONNREFUSED https://provider.example/v1/messages?key=secret');
      },
    });
    expect(outcome.kind).toBe('unavailable');
  });

  it('vadnou odpověď vrátí jako rejected, ne jako plán', async () => {
    const outcome = await planChange({
      prompt: 'turn the bridge into woven roots',
      blueprint: BLUEPRINT,
      target: BRIDGE,
      emit: async () => ({ summary: 'nothing', behavior: [], appearance: [] }),
    });
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') expect(outcome.reason).toBe('EMPTY_CHANGE');
  });
});

/* ------------------------------------------------------------------ *
 * Založení nového objektu (P21 T8)
 * ------------------------------------------------------------------ */

const SIGNPOST = {
  shapeId: 'signPole',
  stableId: 'signpost',
  nodes: [{ kind: 'prism', sides: 6, radius: 0.1, height: 2 }],
  root: 0,
  targetBounds: { min: [-0.2, -1.05, -0.2], max: [0.2, 1.05, 0.2] },
  anchors: [],
  materialIntent: 'wood',
  priority: 4,
};

function addition(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    summary: 'a signpost stands at the far end of the bridge',
    object: {
      stableId: 'signpost',
      label: 'the signpost',
      synonyms: ['the sign'],
      role: 'prop',
      targetBounds: { min: [9.6, 0, 3.6], max: [10.4, 2.1, 4.4] },
      importance: 1,
    },
    shape: SIGNPOST,
    behavior: [{ op: 'add', path: '/sim/entities/signpost', value: { role: 'prop', socket: 'farPad', state: 'idle' } }],
    ...overrides,
  };
}

function reasonOf(read: ReturnType<typeof readAdditionEmission>): string {
  return read.ok ? 'ok' : `${read.reason}: ${read.detail}`;
}

describe('čtení nového objektu', () => {
  it('šťastná cesta: plán nese objekt se zdrojem dosazeným z tvaru a `shape` je null', () => {
    const read = readAdditionEmission(addition(), BLUEPRINT);
    expect(reasonOf(read)).toBe('ok');
    if (!read.ok) return;
    expect(read.value).toMatchObject({
      stableId: 'signpost',
      shape: null,
      appearance: [],
      addition: { object: { stableId: 'signpost', source: { kind: 'shape', shapeId: 'signPole' } }, shape: { shapeId: 'signPole' } },
    });
    expect(read.value.behavior).toHaveLength(1);
  });

  it.each([
    ['objekt', { stableId: 'stoneBridge' }, 'stoneBridge'],
    ['entita v sim', { stableId: 'walker' }, 'walker'],
    ['socket v sim', { stableId: 'farPad' }, 'farPad'],
  ])('jméno, které už nese %s, je IDENTITY_TAKEN', (_what, patch, name) => {
    const body = addition();
    body.object = { ...(body.object as object), ...patch };
    body.shape = { ...SIGNPOST, stableId: name };
    expect(reasonOf(readAdditionEmission(body, BLUEPRINT))).toContain(`IDENTITY_TAKEN: ${name}`);
  });

  it('tvar pojmenovaný jako existující tvar je IDENTITY_TAKEN, a tvar pojmenovaný jako objekt taky', () => {
    expect(reasonOf(readAdditionEmission(addition({ shape: { ...SIGNPOST, shapeId: 'bridgeSpan' } }), BLUEPRINT))).toContain('IDENTITY_TAKEN: bridgeSpan');
    expect(reasonOf(readAdditionEmission(addition({ shape: { ...SIGNPOST, shapeId: 'signpost' } }), BLUEPRINT))).toContain('IDENTITY_TAKEN: signpost names both');
  });

  it('svět s plným rozpočtem tvarů odmítne SHAPE_BUDGET, ne až meshing', () => {
    const full = { ...BLUEPRINT, shapes: Array.from({ length: MAX_HERO_SHAPES }, (_, i) => ({ ...BRIDGE_SPAN, shapeId: `span${i}`, stableId: `bridge${i}` })) } as WorldstreamBlueprint;
    expect(reasonOf(readAdditionEmission(addition(), full))).toContain('SHAPE_BUDGET');
  });

  it('tvar, který patří jinému objektu než tomu novému, je WRONG_TARGET', () => {
    expect(reasonOf(readAdditionEmission(addition({ shape: { ...SIGNPOST, stableId: 'stoneBridge' } }), BLUEPRINT))).toContain('WRONG_TARGET');
  });

  it('objekt s dosazeným `source` nebo bez kvádru je OBJECT_INVALID', () => {
    const withSource = addition();
    withSource.object = { ...(withSource.object as object), source: { kind: 'shape', shapeId: 'signPole' } };
    expect(reasonOf(readAdditionEmission(withSource, BLUEPRINT))).toContain('OBJECT_INVALID');
    const noBounds = addition();
    const { targetBounds: _bounds, ...rest } = noBounds.object as Record<string, unknown>;
    noBounds.object = rest;
    expect(reasonOf(readAdditionEmission(noBounds, BLUEPRINT))).toContain('OBJECT_INVALID: object/targetBounds');
  });

  it('operace do `/look` pod `behavior` je WRONG_PART, ne přeřazená operace', () => {
    const read = readAdditionEmission(addition({ behavior: [{ op: 'replace', path: '/look/palette', value: 'sand' }] }), BLUEPRINT);
    expect(reasonOf(read)).toContain('WRONG_PART');
  });

  it('odpověď bez tvaru je WRONG_SHAPE — nový objekt bez podoby nemá co ukázat', () => {
    expect(reasonOf(readAdditionEmission(addition({ shape: null }), BLUEPRINT))).toContain('WRONG_SHAPE');
  });

  /**
   * P21 T9: jedna věta = jeden kus. Model na „add a lantern and a bell" umí
   * vrátit oba jako dvě entity, nebo k jednomu objektu přibalit dvě pravidla —
   * obojí projde schématem i dosahem a vypadá jako úspěch. Strop je tady, ne
   * v zadání: zadání je prosba, tohle je brána.
   */
  describe('strop na jeden kus', () => {
    const entity = (name: string) => ({ op: 'add', path: `/sim/entities/${name}`, value: { role: 'prop', socket: 'farPad', state: 'idle' } });
    const rule = (name: string) => ({ op: 'add', path: `/sim/rules/${name}`, value: { when: 'tick', then: [] } });

    it('jeden objekt a jedno pravidlo projdou', () => {
      expect(reasonOf(readAdditionEmission(addition({ behavior: [entity('signpost'), rule('signpostGlows')] }), BLUEPRINT))).toBe('ok');
    });

    it('dvě entity jsou TOO_MANY_PIECES', () => {
      expect(reasonOf(readAdditionEmission(addition({ behavior: [entity('signpost'), entity('bell')] }), BLUEPRINT))).toContain('TOO_MANY_PIECES: 2 entities and 0 rules');
    });

    it('dvě pravidla jsou TOO_MANY_PIECES', () => {
      expect(reasonOf(readAdditionEmission(addition({ behavior: [entity('signpost'), rule('a'), rule('b')] }), BLUEPRINT))).toContain('TOO_MANY_PIECES: 1 entities and 2 rules');
    });

    // Naměřeno 18. 9. 2026: zápis celé tabulky nesl dvě pravidla v jedné operaci
    // a strop je nepočítal — brána dosahu vidí jen čerstvé listy, a ty jí nevadí.
    it('dvě pravidla zapsaná jako celá tabulka jsou taky TOO_MANY_PIECES', () => {
      const sim = BLUEPRINT.world.sim as { readonly rules?: Record<string, unknown> };
      const table = { op: 'add', path: '/sim/rules', value: { ...(sim.rules ?? {}), a: { when: 'tick', then: [] }, b: { when: 'tick', then: [] } } };
      expect(reasonOf(readAdditionEmission(addition({ behavior: [entity('signpost'), table] }), BLUEPRINT))).toContain('TOO_MANY_PIECES: 1 entities and 2 rules');
    });

    it('celá tabulka s jedním novým pravidlem projde', () => {
      const sim = BLUEPRINT.world.sim as { readonly rules?: Record<string, unknown> };
      const table = { op: 'add', path: '/sim/rules', value: { ...(sim.rules ?? {}), a: { when: 'tick', then: [] } } };
      expect(reasonOf(readAdditionEmission(addition({ behavior: [entity('signpost'), table] }), BLUEPRINT))).toBe('ok');
    });

    it('zadání pro model říká jeden objekt a nejvýš jedno pravidlo', () => {
      expect(buildAdditionRequest('add a signpost', BLUEPRINT).system).toContain('ONE object and at most ONE rule');
    });
  });

  it('planChange bez cíle jde na přidání a plán nese `addition`', async () => {
    const asked: UpstreamRequest[] = [];
    const outcome = await planChange({
      prompt: 'add a signpost at the far end',
      blueprint: BLUEPRINT,
      target: null,
      emit: async (request) => { asked.push(request); return addition(); },
    });
    expect(asked).toHaveLength(1);
    expect(outcome.kind).toBe('planned');
    if (outcome.kind === 'planned') expect(outcome.plan.addition?.object.stableId).toBe('signpost');
  });
});
