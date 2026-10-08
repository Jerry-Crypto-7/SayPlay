/**
 * Ověření dokazuje kostky logiky (P45B T7): v robotově běhu se každá deklarovaná proměnná
 * změnila, každý časovač doběhl nebo ho něco zastavilo, do každé fáze hra vstoupila, každá
 * událost se vyslala a každá vlna přidala živá těla. Jinak `LOGIC_UNPROVED:<druh>:<id>` (na
 * kostku nic nesáhlo) nebo `LOGIC_NO_EFFECT:<druh>:<id>` (sáhlo, nic se nezměnilo) a hra
 * neprojde. Úspěch měří osm ručních světů robota logiky (`bot-logic.test.ts`), neúspěch tytéž
 * světy s jednou mrtvou kostkou. Hra bez logiky má report bajt po bajtu jako před T7.
 *
 * Fáze a událost naprázdno (`LOGIC_NO_EFFECT`) nastat nemůže: přechod do fáze, ve které hra už
 * je, i vyslání čekající události předchází změna, kterou jádro ohlásilo – kostka je dokázaná.
 */

import { describe, expect, it } from 'vitest';

import { type GameSpecV1, readGameSpec } from '@/play/spec';

import runnerFixture from '../__fixtures__/runner.json';
import collectGate from '../__fixtures__/rules/collect-gate.json';
import { arcadeWorldOf } from '../compile';
import { ARCADE_LIMITS, ARCADE_RUNTIME_V2, type ArcadeWorld } from '../contract';
import { type ArcadeVerdict, arcadeReport, verifyArcade } from '../verify';

/** Tři rozmístění dvorku na svět, jako u robota logiky. */
const SEEDS = [1, 2, 3];

const { rules: _rules, roles: _roles, ...BASE } = collectGate;

type Rule = { readonly id: string } & Readonly<Record<string, unknown>>;

interface Shape {
  readonly logic?: unknown;
  readonly roles: readonly unknown[];
  readonly rules: readonly Rule[];
  readonly things?: readonly unknown[];
}

function made(shape: Shape, seed: number): ArcadeWorld {
  const spec = readGameSpec({ ...BASE, ...shape, roles: [{ id: 'player', kind: 'player', label: 'scout' }, ...shape.roles] });
  if (!spec.ok) throw new Error(spec.issues.join('; '));
  const result = arcadeWorldOf(spec.value as GameSpecV1, seed);
  if (!result.ok) throw new Error(result.issues.join('; '));
  return result.world;
}

const touch = (id: string, verb: string, role: string, effects: readonly unknown[], conditions?: readonly unknown[]): Rule => ({
  id,
  verb,
  when: { contact: ['player', role] },
  ...(conditions === undefined ? {} : { if: conditions }),
  do: effects,
});

const logicFailures = (verdict: ArcadeVerdict): readonly string[] => verdict.failures.filter((failure) => failure.startsWith('logic_proved:'));
const proofOf = (verdict: ArcadeVerdict, key: string) => verdict.logic.find((proof) => `${proof.kind}:${proof.id}` === key);

/** Robot vyhraje do horizontu, nečinný hráč ne a přehrání sedí – brány před T7 beze změny. */
function verified(shape: Shape, seed: number): ArcadeVerdict {
  const verdict = verifyArcade(made(shape, seed));
  expect({ seed, outcome: verdict.bot.outcome }).toEqual({ seed, outcome: 'won' });
  expect(verdict.bot.tick).toBeLessThanOrEqual(ARCADE_LIMITS.maxTicks);
  expect(verdict.idle.outcome).not.toBe('won');
  expect(verdict.replayEqual).toBe(true);
  expect(verdict.failures.filter((failure) => /^(bot_wins|idle_loses|replay_equal|within_limits):/.test(failure))).toEqual([]);
  return verdict;
}

// ---------------------------------------------------------------------------
// Osm světů robota logiky (`bot-logic.test.ts`)

const EXIT = { id: 'exit', kind: 'exit', label: 'stone stairs' };
const GATE = { id: 'gate', kind: 'door', label: 'oak gate' };
const LEAVE = touch('leave', 'escape', 'exit', [{ win: true }]);

/** Sbírej n → brána; `spare` (index 0) nikdo nezapíše. */
const COLLECT: Shape = {
  logic: { vars: [{ id: 'spare' }, { id: 'gems' }] },
  roles: [{ id: 'gem', kind: 'collectible', label: 'blue gem', count: 3 }, GATE, EXIT],
  rules: [
    touch('pick', 'collect', 'gem', [{ add: { var: 'gems', amount: 1 } }, { despawn: 'other' }]),
    { id: 'open', verb: 'open', when: { var: { name: 'gems', atLeast: 3 } }, do: [{ toggle: 'gate' }] },
    LEAVE,
  ],
};
const COLLECT_ALIVE: Shape = { ...COLLECT, logic: { vars: [{ id: 'gems' }] } };

const SURVIVE: Shape = {
  logic: { vars: [{ id: 'sheltered' }], timers: [{ id: 'storm' }] },
  roles: [
    { id: 'hut', kind: 'zone', label: 'stone hut' },
    { id: 'lava', kind: 'hazard', label: 'lava pool' },
  ],
  rules: [
    { id: 'brew', verb: 'brew', when: { var: { name: 'sheltered', below: 1 } }, do: [{ startTimer: { timer: 'storm', ticks: 600 } }, { wave: { role: 'lava', count: 4, at: 'player' } }] },
    touch('hide', 'hide', 'hut', [{ set: { var: 'sheltered', value: 1 } }]),
    touch('scorch', 'burn', 'lava', [{ lose: true }]),
    { id: 'outlast', verb: 'survive', when: { timer: 'storm' }, if: [{ var: { name: 'sheltered', atLeast: 1 } }], do: [{ win: true }] },
    { id: 'drown', verb: 'drown', when: { timer: 'storm' }, if: [{ var: { name: 'sheltered', below: 1 } }], do: [{ lose: true }] },
  ],
};

const PHASES: Shape = {
  logic: { vars: [{ id: 'banished' }], phases: [{ id: 'calm' }, { id: 'wave' }, { id: 'final' }] },
  roles: [
    { id: 'bell', kind: 'switch', label: 'brass bell' },
    { id: 'ghost', kind: 'patrol', label: 'pale ghost' },
    EXIT,
  ],
  rules: [
    touch('wake', 'ring', 'bell', [{ goPhase: 'wave' }], [{ inPhase: 'calm' }]),
    { id: 'swarm', verb: 'swarm', when: { phase: 'wave' }, do: [{ wave: { role: 'ghost', count: 3, at: 'edge' } }] },
    touch('banish', 'banish', 'ghost', [{ add: { var: 'banished', amount: 1 } }, { despawn: 'other' }]),
    { id: 'settle', verb: 'settle', when: { var: { name: 'banished', atLeast: 3 } }, do: [{ goPhase: 'final' }] },
    touch('leave', 'escape', 'exit', [{ win: true }], [{ inPhase: 'final' }]),
  ],
  things: [{ role: 'ghost', start: 'hidden' }],
};

const EVENT: Shape = {
  logic: { events: ['crack', 'quake'] },
  roles: [{ id: 'lever', kind: 'switch', label: 'rusty lever' }, GATE, EXIT],
  rules: [
    touch('pull', 'pull', 'lever', [{ emit: 'quake' }]),
    { id: 'rumble', verb: 'rumble', when: { event: 'quake' }, do: [{ emit: 'crack' }] },
    { id: 'split', verb: 'split', when: { event: 'crack' }, do: [{ toggle: 'gate' }] },
    LEAVE,
  ],
};

const ENEMIES: Shape = {
  logic: { vars: [{ id: 'slain' }] },
  roles: [
    { id: 'drum', kind: 'switch', label: 'war drum' },
    { id: 'imp', kind: 'chaser', label: 'red imp' },
  ],
  rules: [
    touch('alarm', 'beat', 'drum', [{ wave: { role: 'imp', count: 4, at: 'player' } }, { despawn: 'other' }]),
    { id: 'strike', verb: 'strike', when: { press: 'action' }, if: [{ near: { role: 'imp', within: 1 } }], do: [{ despawn: 'other' }, { add: { var: 'slain', amount: 1 } }] },
    { id: 'victory', verb: 'win', when: { var: { name: 'slain', atLeast: 4 } }, do: [{ win: true }] },
  ],
  things: [{ role: 'imp', start: 'hidden' }],
};

/** Doutnák spustí robot sám; `spare` spustí jen druhé tlačítko, které robot nemačká. */
const FUSE: Shape = {
  logic: { timers: [{ id: 'spare' }, { id: 'fuse' }] },
  roles: [{ id: 'plunger', kind: 'switch', label: 'blast plunger' }, { id: 'rubble', kind: 'door', label: 'rubble pile' }, EXIT],
  rules: [
    touch('light', 'light', 'plunger', [{ startTimer: { timer: 'fuse', ticks: 90 } }]),
    { id: 'blast', verb: 'blast', when: { timer: 'fuse' }, do: [{ toggle: 'rubble' }] },
    { id: 'tick', verb: 'tick', when: { press: 'alt' }, do: [{ startTimer: { timer: 'spare', ticks: 30 } }] },
    LEAVE,
  ],
};
const FUSE_ALIVE: Shape = { ...FUSE, logic: { timers: [{ id: 'fuse' }] }, rules: FUSE.rules.filter((rule) => rule.id !== 'tick') };

/** Životy ubírá jen láva, kterou vítězný robot obchází: změnu dokáže běh na prohru. */
const LIVES: Shape = {
  logic: { vars: [{ id: 'lives', start: 2 }, { id: 'crystals' }] },
  roles: [
    { id: 'crystal', kind: 'collectible', label: 'green crystal', count: 2 },
    { id: 'lava', kind: 'hazard', label: 'lava pool', count: 6 },
    EXIT,
  ],
  rules: [
    touch('pick', 'collect', 'crystal', [{ add: { var: 'crystals', amount: 1 } }, { despawn: 'other' }]),
    touch('burn', 'burn', 'lava', [{ add: { var: 'lives', amount: -1 } }]),
    { id: 'die', verb: 'die', when: { var: { name: 'lives', below: 1 } }, do: [{ lose: true }] },
    touch('leave', 'escape', 'exit', [{ win: true }], [{ var: { name: 'crystals', atLeast: 2 } }]),
  ],
};

const EXIT_PHASE: Shape = {
  logic: { phases: [{ id: 'night' }, { id: 'day' }] },
  roles: [{ id: 'torch', kind: 'switch', label: 'iron torch' }, GATE, EXIT],
  rules: [
    touch('kindle', 'kindle', 'torch', [{ goPhase: 'day' }]),
    { id: 'dawn', verb: 'dawn', when: { phaseExit: 'night' }, do: [{ toggle: 'gate' }] },
    LEAVE,
  ],
};

const tick = String.raw`at tick \d+`;
const at = (text: string): RegExp => new RegExp(`^${text} ${tick}$`);

describe('every logic construct of the eight planner worlds is proved with a visible change', () => {
  const worlds: readonly (readonly [name: string, shape: Shape, proofs: Readonly<Record<string, RegExp>>])[] = [
    ['collect n → gate', COLLECT_ALIVE, { 'var:gems': at('var gems 0→1') }],
    ['survive the timer', SURVIVE, { 'var:sheltered': at('var sheltered 0→1'), 'timer:storm': /^timer storm ran out at tick 600$/, 'wave:brew': /^live lava bodies 1→5 at tick 0$/ }],
    [
      'phases calm → wave → final',
      PHASES,
      {
        'var:banished': at('var banished 0→1'),
        'phase:calm': /^phase calm entered at the start \(tick 0\)$/,
        'phase:wave': at('phase calm→wave'),
        'phase:final': at('phase wave→final'),
        'wave:swarm': at('live ghost bodies 0→3'),
      },
    ],
    ['an event starts the second part', EVENT, { 'event:crack': at('event crack sent'), 'event:quake': at('event quake sent') }],
    ['a wave of enemies', ENEMIES, { 'var:slain': at('var slain 0→1'), 'wave:alarm': at('live imp bodies 0→4') }],
    ['a timer the robot starts itself', FUSE_ALIVE, { 'timer:fuse': at('timer fuse ran out') }],
    // Vítězný robot lávu obchází; „lives 2→1“ naměří běh na prohru, který dokazuje sloveso `burn`.
    ['a var falling by loss', LIVES, { 'var:lives': at('var lives 2→1'), 'var:crystals': at('var crystals 0→1') }],
    ['a phase with an exit', EXIT_PHASE, { 'phase:night': /^phase night entered at the start \(tick 0\)$/, 'phase:day': at('phase night→day') }],
  ];

  it.each(worlds)('%s', (_name, shape, proofs) => {
    for (const seed of SEEDS) {
      const verdict = verified(shape, seed);
      expect(verdict.logic.map((proof) => `${proof.kind}:${proof.id}`)).toEqual(Object.keys(proofs));
      for (const proof of verdict.logic) {
        expect({ seed, ...proof }).toEqual({ seed, kind: proof.kind, id: proof.id, fired: true, changed: true, evidence: expect.stringMatching(proofs[`${proof.kind}:${proof.id}`] as RegExp) });
      }
      expect(logicFailures(verdict)).toEqual([]);
      // Druhý konec téhož časovače (`drown`) dokáže jen běh na prohru, a ten umře v lávě dřív –
      // mezera ověření sloves (jeden běh na prohru, P36A T8), ne logiky.
      expect(verdict.failures).toEqual(shape === SURVIVE ? [expect.stringContaining('VERB_UNPROVED:drown')] : []);
    }
  });

  it('a timer runs out exactly when its listener fires: the fuse blasts 90 ticks after the last light', () => {
    for (const seed of SEEDS) {
      const verdict = verified(FUSE_ALIVE, seed);
      const blast = verdict.verbs.find((proof) => proof.verb === 'blast')?.firstTick;
      expect(proofOf(verdict, 'timer:fuse')?.evidence).toBe(`timer fuse ran out at tick ${String(blast)}`);
    }
  });

  it('a verb carried only by a logic effect is proved by that effect’s witness', () => {
    const evidence = (shape: Shape, verb: string) => verified(shape, 1).verbs.find((proof) => proof.verb === verb)?.evidence;
    expect(evidence(SURVIVE, 'hide')).toMatch(at('var sheltered 0→1'));
    expect(evidence(PHASES, 'ring')).toMatch(at('phase calm→wave'));
    expect(evidence(PHASES, 'settle')).toMatch(at('phase wave→final'));
    expect(evidence(FUSE_ALIVE, 'light')).toMatch(at(String.raw`timer fuse started \(90 ticks\)`));
    expect(evidence(EVENT, 'pull')).toMatch(at('event quake sent'));
    expect(evidence(EVENT, 'rumble')).toMatch(at('event crack sent'));
  });
});

// ---------------------------------------------------------------------------
// Mrtvé kostky

/** Jediný nález logiky ve všech semínkách – a hra kvůli němu neprojde. */
function blocked(shape: Shape, code: string, why: string): ArcadeVerdict {
  let last: ArcadeVerdict | undefined;
  for (const seed of SEEDS) {
    const verdict = verified(shape, seed);
    expect({ seed, logic: logicFailures(verdict) }).toEqual({ seed, logic: [`logic_proved: ${code} – ${why} while the bot played`] });
    expect(verdict.publishEligible).toBe(false);
    last = verdict;
  }
  return last as ArcadeVerdict;
}

describe('a logic construct the bot never proves blocks publication', () => {
  it('a declared var no rule writes: LOGIC_UNPROVED:var:spare by its spec id, gems at index 1 still proved by name', () => {
    const verdict = blocked(COLLECT, 'LOGIC_UNPROVED:var:spare', 'no rule wrote this var');
    expect(proofOf(verdict, 'var:spare')).toEqual({ kind: 'var', id: 'spare', fired: false, changed: false, evidence: null });
    expect(proofOf(verdict, 'var:gems')?.evidence).toMatch(at('var gems 0→1'));
  });

  it('set to the same value = LOGIC_NO_EFFECT: the rule writes mood every pick, mood stays 2', () => {
    const sameValue: Shape = {
      ...COLLECT,
      logic: { vars: [{ id: 'gems' }, { id: 'mood', start: 2 }] },
      rules: [touch('pick', 'collect', 'gem', [{ add: { var: 'gems', amount: 1 } }, { set: { var: 'mood', value: 2 } }, { despawn: 'other' }]), ...COLLECT.rules.slice(1)],
    };
    const verdict = blocked(sameValue, 'LOGIC_NO_EFFECT:var:mood', 'rules wrote this var, but its value never changed');
    expect(proofOf(verdict, 'var:mood')).toEqual({ kind: 'var', id: 'mood', fired: true, changed: false, evidence: null });
  });

  it('a timer nobody starts: LOGIC_UNPROVED:timer:spare', () => {
    const verdict = blocked(FUSE, 'LOGIC_UNPROVED:timer:spare', 'no rule started this timer');
    expect(proofOf(verdict, 'timer:spare')).toEqual({ kind: 'timer', id: 'spare', fired: false, changed: false, evidence: null });
  });

  /** Sběr natáhne `dusk` na 5000 tiků – robot vyhraje dřív, než doběhne. */
  const dusk = (open: readonly unknown[]): Shape => ({
    ...COLLECT_ALIVE,
    logic: { vars: [{ id: 'gems' }], timers: [{ id: 'dusk' }] },
    rules: [
      touch('pick', 'collect', 'gem', [{ add: { var: 'gems', amount: 1 } }, { startTimer: { timer: 'dusk', ticks: 5000 } }, { despawn: 'other' }]),
      { id: 'open', verb: 'open', when: { var: { name: 'gems', atLeast: 3 } }, do: open },
      LEAVE,
    ],
  });

  it('a timer that starts but never runs out and nothing stops: LOGIC_NO_EFFECT:timer:dusk', () => {
    const verdict = blocked(dusk([{ toggle: 'gate' }]), 'LOGIC_NO_EFFECT:timer:dusk', 'this timer started, but it never ran out and nothing stopped it');
    expect(proofOf(verdict, 'timer:dusk')).toEqual({ kind: 'timer', id: 'dusk', fired: true, changed: false, evidence: null });
  });

  it('a watchdog the main pass feeds every tick stands at 1 every other tick, yet never runs out: LOGIC_NO_EFFECT:timer:watch', () => {
    // Start na 2 v tiku, kdy zbývá 2, je naprázdno a průchod odečte na 1; další tik start z 1 na 2 průchod předejde.
    const watchdog: Shape = {
      ...COLLECT_ALIVE,
      logic: { vars: [{ id: 'gems' }], timers: [{ id: 'watch' }] },
      rules: [...COLLECT.rules, { id: 'feed', verb: 'feed', when: { every: 1 }, do: [{ startTimer: { timer: 'watch', ticks: 2 } }] }],
    };
    const verdict = blocked(watchdog, 'LOGIC_NO_EFFECT:timer:watch', 'this timer started, but it never ran out and nothing stopped it');
    expect(verdict.verbs.find((proof) => proof.verb === 'feed')?.evidence).toBe('timer watch started (2 ticks) at tick 0');
  });

  it('the same timer stopped when the gate opens is proved by the stop', () => {
    for (const seed of SEEDS) {
      const verdict = verified(dusk([{ toggle: 'gate' }, { stopTimer: 'dusk' }]), seed);
      const open = verdict.verbs.find((proof) => proof.verb === 'open')?.firstTick;
      expect(proofOf(verdict, 'timer:dusk')?.evidence).toBe(`timer dusk stopped at tick ${String(open)}`);
      expect(verdict.failures).toEqual([]);
    }
  });

  it('a timer its own expiry restarts still ran out: the pulse ends in tick 30 and stands at 30 again', () => {
    const pulse: Shape = {
      ...COLLECT_ALIVE,
      logic: { vars: [{ id: 'gems' }], timers: [{ id: 'pulse' }] },
      rules: [
        ...COLLECT.rules,
        { id: 'kick', verb: 'kick', when: { var: { name: 'gems', below: 1 } }, do: [{ startTimer: { timer: 'pulse', ticks: 30 } }] },
        { id: 'beat', verb: 'beat', when: { timer: 'pulse' }, do: [{ startTimer: { timer: 'pulse', ticks: 30 } }] },
      ],
    };
    for (const seed of SEEDS) {
      const verdict = verified(pulse, seed);
      expect(proofOf(verdict, 'timer:pulse')?.evidence).toBe('timer pulse ran out at tick 30');
      expect(verdict.failures).toEqual([]);
    }
  });

  it('a phase nobody enters: LOGIC_UNPROVED:phase:storm', () => {
    const storm: Shape = {
      ...EXIT_PHASE,
      logic: { phases: [{ id: 'night' }, { id: 'day' }, { id: 'storm' }] },
      rules: [...EXIT_PHASE.rules, { id: 'brood', verb: 'brood', when: { press: 'alt' }, do: [{ goPhase: 'storm' }] }],
    };
    const verdict = blocked(storm, 'LOGIC_UNPROVED:phase:storm', 'the game never entered this phase');
    expect(proofOf(verdict, 'phase:storm')).toEqual({ kind: 'phase', id: 'storm', fired: false, changed: false, evidence: null });
    expect(proofOf(verdict, 'phase:day')?.changed).toBe(true);
  });

  it('an event nobody emits: LOGIC_UNPROVED:event:echo', () => {
    const echo: Shape = {
      ...EVENT,
      logic: { events: ['crack', 'quake', 'echo'] },
      rules: [...EVENT.rules, { id: 'shout', verb: 'shout', when: { press: 'alt' }, do: [{ emit: 'echo' }] }, { id: 'hear', verb: 'hear', when: { event: 'echo' }, do: [{ score: 1 }] }],
    };
    const verdict = blocked(echo, 'LOGIC_UNPROVED:event:echo', 'no rule emitted this event');
    expect(proofOf(verdict, 'event:echo')).toEqual({ kind: 'event', id: 'echo', fired: false, changed: false, evidence: null });
  });

  it('a wave whose rule never fires: LOGIC_UNPROVED:wave:horde', () => {
    // Netopýry robot k výhře nepotřebuje, a tak druhé tlačítko nezmáčkne.
    const horde: Shape = {
      ...ENEMIES,
      roles: [...ENEMIES.roles, { id: 'bat', kind: 'patrol', label: 'grey bat' }],
      rules: [...ENEMIES.rules, { id: 'horde', verb: 'summon', when: { press: 'alt' }, do: [{ wave: { role: 'bat', count: 2, at: 'player' } }] }],
      things: [{ role: 'imp', start: 'hidden' }, { role: 'bat', start: 'hidden' }],
    };
    const verdict = blocked(horde, 'LOGIC_UNPROVED:wave:horde', 'the rule with this wave never fired');
    expect(proofOf(verdict, 'wave:horde')).toEqual({ kind: 'wave', id: 'horde', fired: false, changed: false, evidence: null });
    expect(proofOf(verdict, 'wave:alarm')?.changed).toBe(true);
  });

  /**
   * Strašidla každý tik zaplní rezervu spawnu (8 + 8 + 1 slot), takže vlna výherního pravidla
   * už nemá kam: pravidlo vystřelí (výhra), vlna nepřidá nikoho. Svět bez bloku `logic` (arcade-v2)
   * – vlnu ověření dokazuje i tak.
   */
  const CROWD: Shape = {
    roles: [{ id: 'ghost', kind: 'patrol', label: 'pale ghost' }, EXIT],
    rules: [
      { id: 'haunt', verb: 'haunt', when: { every: 1 }, do: [{ wave: { role: 'ghost', count: 8, at: 'edge' } }] },
      touch('leave', 'escape', 'exit', [{ win: true }, { wave: { role: 'ghost', count: 1, at: 'edge' } }]),
    ],
    things: [{ role: 'ghost', start: 'hidden' }],
  };

  it('a wave that fires into a full spawn reserve adds nobody: LOGIC_NO_EFFECT:wave:leave', () => {
    const verdict = blocked(CROWD, 'LOGIC_NO_EFFECT:wave:leave', 'the rule fired, but its wave added no live body');
    expect(verdict.logic).toEqual([
      { kind: 'wave', id: 'haunt', fired: true, changed: true, evidence: 'live ghost bodies 0→8 at tick 0' },
      { kind: 'wave', id: 'leave', fired: true, changed: false, evidence: null },
    ]);
  });

  it('a wave that only replaces the body its rule removes leaves the live count as it was: LOGIC_NO_EFFECT:wave:shoo', () => {
    // Vlna se počítá čistým přírůstkem živých těl role za tik: jeden duch zmizí, jeden se objeví.
    const relocate: Shape = {
      roles: [{ id: 'ghost', kind: 'patrol', label: 'pale ghost' }, EXIT],
      rules: [
        touch('shoo', 'shoo', 'ghost', [{ wave: { role: 'ghost', count: 1, at: 'edge' } }, { despawn: 'other' }, { count: { counter: 'items', amount: 1 } }]),
        touch('leave', 'escape', 'exit', [{ win: true }], [{ counter: { name: 'items', atLeast: 1 } }]),
      ],
    };
    const verdict = blocked(relocate, 'LOGIC_NO_EFFECT:wave:shoo', 'the rule fired, but its wave added no live body');
    expect(proofOf(verdict, 'wave:shoo')).toEqual({ kind: 'wave', id: 'shoo', fired: true, changed: false, evidence: null });
  });

  it('the report of a logic game carries logic_proved: passed when proved, failed with the code otherwise', () => {
    const ids = { specHash: 'spec', worldHash: 'world' };
    const passing = made(EXIT_PHASE, 1);
    const ok = arcadeReport(verifyArcade(passing), passing, ids);
    expect(ok.keypoints.map((point) => [point.assertionId, point.passed])).toEqual([
      ['bot_wins', true],
      ['idle_loses', true],
      ['replay_equal', true],
      ['within_limits', true],
      ['verbs_proved', true],
      ['logic_proved', true],
    ]);
    expect(ok.publishEligible).toBe(true);
    // Vlna bez bloku `logic`: svět arcade-v2, kontrolu dostane taky.
    const crowd = made(CROWD, 1);
    expect(crowd.runtimeVersion).toBe(ARCADE_RUNTIME_V2);
    const failed = arcadeReport(verifyArcade(crowd), crowd, ids).keypoints.find((point) => point.assertionId === 'logic_proved');
    expect(failed?.passed).toBe(false);
    expect(failed?.failures).toEqual([expect.stringContaining('LOGIC_NO_EFFECT:wave:leave')]);
  });
});

// ---------------------------------------------------------------------------
// Hra bez logiky

/**
 * Report před T7 (`37d667ec`), zmrazený: běžec bez pravidel a dvorek se slovesy. Kontrola logiky
 * přidaná i hře bez ní by přidala keypoint a report by se lišil.
 */
const OLD_REPORTS = {
  runner:
    '{"specHash":"spec","worldHash":"world","keypoints":[{"assertionId":"bot_wins","mechanicId":"runner","passed":true,"hashBefore":"7304f0f2","hashAfter":"ee9517e7","ticks":1522,"failures":[]},{"assertionId":"idle_loses","mechanicId":"runner","passed":true,"hashBefore":"7304f0f2","hashAfter":"424c63d1","ticks":165,"failures":[]},{"assertionId":"replay_equal","mechanicId":"runner","passed":true,"hashBefore":"7304f0f2","hashAfter":"ee9517e7","ticks":1522,"failures":[]},{"assertionId":"within_limits","mechanicId":"runner","passed":true,"hashBefore":"7304f0f2","hashAfter":"ee9517e7","ticks":1522,"failures":[]}],"witness":{"certified":true,"winsAtTick":1522},"replayEqual":true,"budgets":{"entities":111,"rules":3,"triangles":null},"publishEligible":true}',
  collectGate:
    '{"specHash":"spec","worldHash":"world","keypoints":[{"assertionId":"bot_wins","mechanicId":"move_free","passed":true,"hashBefore":"f01712a2","hashAfter":"504fcb93","ticks":143,"failures":[]},{"assertionId":"idle_loses","mechanicId":"move_free","passed":true,"hashBefore":"f01712a2","hashAfter":"8329b235","ticks":5400,"failures":[]},{"assertionId":"replay_equal","mechanicId":"move_free","passed":true,"hashBefore":"f01712a2","hashAfter":"504fcb93","ticks":143,"failures":[]},{"assertionId":"within_limits","mechanicId":"move_free","passed":true,"hashBefore":"f01712a2","hashAfter":"504fcb93","ticks":143,"failures":[]},{"assertionId":"verbs_proved","mechanicId":"move_free","passed":true,"hashBefore":"f01712a2","hashAfter":"504fcb93","ticks":143,"failures":[]}],"witness":{"certified":true,"winsAtTick":143},"replayEqual":true,"budgets":{"entities":8,"rules":3,"triangles":null},"publishEligible":true,"verbs":[{"verb":"collect","fired":true,"firstTick":22,"changed":true,"evidence":"items +1 (now 1) at tick 22"},{"verb":"open","fired":true,"firstTick":81,"changed":true,"evidence":"role 33 switched at tick 81"},{"verb":"escape","fired":true,"firstTick":142,"changed":true,"evidence":"won at tick 142"}]}',
} as const;

describe('a game without logic', () => {
  it.each([
    ['runner', runnerFixture],
    ['collectGate', collectGate],
  ] as const)('%s: no logic proofs and a report byte for byte as before T7', (name, input) => {
    const spec = readGameSpec(input);
    if (!spec.ok) throw new Error(spec.issues.join('; '));
    const result = arcadeWorldOf(spec.value as GameSpecV1, 1);
    if (!result.ok) throw new Error(result.issues.join('; '));
    const verdict = verifyArcade(result.world);
    expect(verdict.logic).toEqual([]);
    expect(JSON.stringify(arcadeReport(verdict, result.world, { specHash: 'spec', worldHash: 'world' }))).toBe(OLD_REPORTS[name]);
  });
});
