import { describe, expect, it } from 'vitest';

import { hashHex } from '../hash';
import { createRuntime, run, step, type WorldDocRuntime } from '../interpreter';
import { createStreams, nextInt } from '../rng';
import { advance, createTimeline, seekTo } from '../timeline';

import vaultWorld from '../__fixtures__/vault.world.json';

const vault = vaultWorld as unknown as WorldDocRuntime;

const HORIZON = 200;
const JUMPS = 20;
/** Lichý tik uvnitř živého okna kruhu — obojí je pro `trace` níž podstatné. */
const INPUT_TICK = 151;
const SEED = 0x51ce11a1;

/**
 * Svět, který se nikdy nedohraje a přesto se každý tik mění jinak.
 *
 * Dvě entity překlápějí `s1 ↔ s2`, což drží běh v pohybu donekonečna — a každé
 * překlopení přičte k čítači, takže stav je **monotónní**, ne periodický. To je
 * na téhle fixture to podstatné: nad oscilací s periodou dva by skok na špatný
 * tik trefil shodný hash čirou náhodou a test by neprokázal nic.
 *
 * `r.ea.up` navíc vysílá signál a `r.tock` na něj reaguje **až v příštím tiku**,
 * takže fronta je na hranici tiku střídavě neprázdná. Bez toho by byl stav
 * funkcí jediného pole a snímek, který frontu zapomene, by testem prošel.
 */
function oscillator(): WorldDocRuntime {
  return {
    // Vstup leží na LICHÉM tiku, kde už ve frontě čeká `tock`, a strop fronty
    // je přesně dva. Snímek, který si frontu jen půjčí místo aby ji zkopíroval,
    // do ní ten vstup nechá dopsat — a replay téhož tiku ho dopíše podruhé, což
    // je se stropem dva přetečení fronty a `runtimeFault`, který přímý běh nemá.
    trace: [{ tick: INPUT_TICK, actor: 'ea', actionId: 'poke' }],
    space: { sockets: { s_a: [0, 0], s_b: [1, 0] }, zones: {}, blocked: [], tags: {} },
    ir: {
      irVersion: 'world-ir-v1',
      limits: {
        maxEntities: 2,
        maxZones: 1,
        maxSlots: 4,
        maxRules: 8,
        maxRuleFiringsPerTick: 4,
        maxQueueDepth: 2,
        maxAgents: 0,
        memorySlotsPerAgent: 0,
        gridWidth: 4,
        gridHeight: 4,
      },
      slots: [
        { space: 'counter', id: 'beat', min: 0, max: 999, initial: 0 },
        { space: 'counter', id: 'echo', min: 0, max: 999, initial: 0 },
      ],
      entities: [
        { stableId: 'ea', role: 'prop', socket: 's_a', states: ['s1', 's2'], initialState: 's1', initialLocked: false },
        { stableId: 'eb', role: 'prop', socket: 's_b', states: ['s1', 's2'], initialState: 's1', initialLocked: false },
      ],
      nodes: [
        { kind: 'ref', ref: { space: 'entityState', entity: 'ea' } },
        { kind: 'literal', value: 's1' },
        { kind: 'compare', lhs: 0, op: '=', rhs: 1 },
        { kind: 'literal', value: 's2' },
        { kind: 'compare', lhs: 0, op: '=', rhs: 3 },
        { kind: 'ref', ref: { space: 'entityState', entity: 'eb' } },
        { kind: 'compare', lhs: 5, op: '=', rhs: 1 },
        { kind: 'compare', lhs: 5, op: '=', rhs: 3 },
        { kind: 'ref', ref: { space: 'pulse', fact: 'signalled', args: ['tock'] } },
      ],
      predicates: [
        { predicateId: 'p.ea.s1', source: 'onStateEnter', expr: 2 },
        { predicateId: 'p.ea.s2', source: 'onStateEnter', expr: 4 },
        { predicateId: 'p.eb.s1', source: 'onStateEnter', expr: 6 },
        { predicateId: 'p.eb.s2', source: 'onStateEnter', expr: 7 },
        { predicateId: 'p.tock', source: 'onSignal', expr: 8 },
      ],
      effects: [
        { op: 'assign', ref: { space: 'entityState', entity: 'ea' }, value: 3 },
        { op: 'assign', ref: { space: 'entityState', entity: 'ea' }, value: 1 },
        { op: 'assign', ref: { space: 'entityState', entity: 'eb' }, value: 3 },
        { op: 'assign', ref: { space: 'entityState', entity: 'eb' }, value: 1 },
        { op: 'addCounter', slot: 'beat', delta: 1 },
        { op: 'emit', signal: 'tock' },
        { op: 'addCounter', slot: 'echo', delta: 1 },
      ],
      rules: [
        {
          ruleId: 'r.ea.up',
          phase: 0,
          priority: 0,
          trigger: { kind: 'onEdge', predicate: 'p.ea.s1', became: true },
          guard: null,
          effects: [0, 4, 5],
        },
        {
          ruleId: 'r.ea.down',
          phase: 0,
          priority: 1,
          trigger: { kind: 'onEdge', predicate: 'p.ea.s2', became: true },
          guard: null,
          effects: [1, 4],
        },
        {
          ruleId: 'r.eb.up',
          phase: 0,
          priority: 2,
          trigger: { kind: 'onEdge', predicate: 'p.eb.s1', became: true },
          guard: null,
          effects: [2, 4],
        },
        {
          ruleId: 'r.eb.down',
          phase: 0,
          priority: 3,
          trigger: { kind: 'onEdge', predicate: 'p.eb.s2', became: true },
          guard: null,
          effects: [3, 4],
        },
        {
          ruleId: 'r.tock',
          phase: 0,
          priority: 4,
          trigger: { kind: 'onEdge', predicate: 'p.tock', became: true },
          guard: null,
          effects: [6],
        },
      ],
    },
  } as unknown as WorldDocRuntime;
}

function inputsAt(doc: WorldDocRuntime, tick: number) {
  return doc.trace.filter((entry) => entry.tick === tick);
}

/** Hash zabaleného stavu na hranici každého tiku běhu bez jediného skoku. */
function straightRun(doc: WorldDocRuntime, ticks: number): string[] {
  const runtime = createRuntime(doc);
  const hashes = [hashHex(runtime.state)];
  for (let i = 0; i < ticks; i += 1) {
    step(runtime, inputsAt(doc, runtime.tick));
    hashes.push(hashHex(runtime.state));
  }
  return hashes;
}

describe('fixture, na které se osa měří', () => {
  it('běží celý horizont a nikdy nezopakuje stav', () => {
    const runtime = createRuntime(oscillator());
    expect(run(runtime, HORIZON)).toBe('running');
    expect(runtime.tick).toBe(HORIZON);

    const hashes = straightRun(oscillator(), HORIZON);
    expect(new Set(hashes).size).toBe(hashes.length);
  });

  /**
   * Bez tohohle měření je pokrytí fronty jen záměr. Snímek, který frontu
   * zapomene, projde každým světem, kde je na hranici tiku prázdná — a to je
   * většina z nich.
   */
  it('má na hranici tiku střídavě neprázdnou frontu', () => {
    const runtime = createRuntime(oscillator());
    const depths: number[] = [];
    for (let i = 0; i < 8; i += 1) {
      step(runtime, []);
      depths.push(runtime.drainQueue.length);
    }
    expect(depths.filter((depth) => depth > 0).length).toBeGreaterThan(0);
    expect(depths.filter((depth) => depth === 0).length).toBeGreaterThan(0);
  });

  /**
   * Předpoklad, na kterém stojí vynechání `writeQueue` ze snímku. Není v
   * `timeline.ts` napsaný jako komentář a doufáno v něj — měří se, takže den, kdy
   * `step` přestane zapisovanou frontu na konci tiku vyprazdňovat, shodí test
   * osy, ne až demo.
   */
  it('má na hranici tiku vždy prázdnou zapisovanou frontu', () => {
    const doc = oscillator();
    const runtime = createRuntime(doc);
    expect(runtime.writeQueue).toHaveLength(0);
    for (let i = 0; i < HORIZON; i += 1) {
      step(runtime, inputsAt(doc, runtime.tick));
      expect(runtime.writeQueue).toHaveLength(0);
    }
  });
});

describe('přetáčení času', () => {
  it('skok na libovolný tik a doběh na konec dá bitově shodný hash', () => {
    const reference = straightRun(oscillator(), HORIZON);
    const doc = oscillator();
    const runtime = createRuntime(doc);
    const timeline = createTimeline(runtime, 64);

    for (let i = 0; i < HORIZON; i += 1) {
      advance(timeline, runtime, inputsAt(doc, runtime.tick));
    }
    expect(hashHex(runtime.state)).toBe(reference[HORIZON]);

    // Skoky jsou náhodné, ale seed je v testu — dvě spuštění projdou týmiž tiky.
    const stream = createStreams(SEED).spawn;
    for (let i = 0; i < JUMPS; i += 1) {
      const target = nextInt(stream, 0, HORIZON);

      // Aserce nad CÍLEM je ta podstatná: osa, která by místo skoku vždycky
      // obnovila kotvu, by na konec taky dokonvergovala a konečný hash by nic
      // neprokázal.
      expect(seekTo(timeline, runtime, target)).toBe(target);
      expect(hashHex(runtime.state)).toBe(reference[target]);

      expect(seekTo(timeline, runtime, HORIZON)).toBe(HORIZON);
      expect(hashHex(runtime.state)).toBe(reference[HORIZON]);
    }
  });

  /**
   * Skok přesně na tik, který nese vstup.
   *
   * Náhodné skoky tuhle vadu netrefí: kruh o kapacitě 64 drží u dvousetkového
   * běhu jen posledních 64 tiků, takže starší cíl stejně odpadne na kotvu a
   * poškozený snímek se nepoužije. Vlastnost potřebuje jmenovaný test, ne
   * naději na dvacet losů.
   */
  it('skok na tik se vstupem ten vstup nezdvojí', () => {
    const reference = straightRun(oscillator(), HORIZON);
    const doc = oscillator();
    const runtime = createRuntime(doc);
    const timeline = createTimeline(runtime, 64);
    for (let i = 0; i < HORIZON; i += 1) advance(timeline, runtime, inputsAt(doc, runtime.tick));

    expect(seekTo(timeline, runtime, INPUT_TICK)).toBe(INPUT_TICK);
    expect(hashHex(runtime.state)).toBe(reference[INPUT_TICK]);

    expect(seekTo(timeline, runtime, HORIZON)).toBe(HORIZON);
    expect(runtime.runState).toBe('running');
    expect(runtime.fault).toBeNull();
    expect(hashHex(runtime.state)).toBe(reference[HORIZON]);
  });

  it('dojde i na tik, který kruh dávno přepsal', () => {
    const reference = straightRun(oscillator(), HORIZON);
    const doc = oscillator();
    const runtime = createRuntime(doc);
    const timeline = createTimeline(runtime, 8);

    for (let i = 0; i < HORIZON; i += 1) {
      advance(timeline, runtime, inputsAt(doc, runtime.tick));
    }
    expect(timeline.ring.length).toBe(8);

    expect(seekTo(timeline, runtime, 3)).toBe(3);
    expect(hashHex(runtime.state)).toBe(reference[3]);
  });

  it('druhý skok na týž tik skončí tam, kde první', () => {
    const doc = oscillator();
    const runtime = createRuntime(doc);
    const timeline = createTimeline(runtime, 64);
    for (let i = 0; i < HORIZON; i += 1) advance(timeline, runtime, inputsAt(doc, runtime.tick));

    seekTo(timeline, runtime, 90);
    const first = hashHex(runtime.state);
    seekTo(timeline, runtime, HORIZON);
    seekTo(timeline, runtime, 90);

    expect(hashHex(runtime.state)).toBe(first);
  });

  it('řekne, kam doopravdy dosáhla, když se cíl dosáhnout nedá', () => {
    const doc = oscillator();
    const runtime = createRuntime(doc);
    for (let i = 0; i < 10; i += 1) step(runtime, []);
    const timeline = createTimeline(runtime, 8);

    // Před kotvou žádný snímek není a osa to nezastírá přistáním jinde potichu.
    expect(seekTo(timeline, runtime, 3)).toBe(10);
  });

  it('u dohraného světa se zastaví na tiku výhry, nedopočítává dál', () => {
    const runtime = createRuntime(vault);
    const timeline = createTimeline(runtime, 32);
    for (let i = 0; i < 40; i += 1) {
      advance(timeline, runtime, inputsAt(vault, runtime.tick));
    }

    expect(runtime.runState).toBe('won');
    expect(runtime.tick).toBe(vault.winsAtTick);
    // Tiky po výhře runtimem nepohnou, takže do kruhu nesmí vstoupit — jinak by
    // z něj vytlačily celou minulost, kterou má osa nabízet.
    expect(timeline.written).toBe(vault.winsAtTick);
    expect(seekTo(timeline, runtime, 40)).toBe(vault.winsAtTick);
  });

  /**
   * Přetočení dohraného světa zpět před výhru. Konec běhu je stav runtimu, ne
   * jen jeho pole — osa, která obnoví sloty a `runState` nechá na `won`, by
   * scrub zpátky zamkla: svět by stál na tiku 2 a odmítal se hnout.
   */
  it('vrátí dohraný svět zpět do běhu a nechá ho vyhrát znovu', () => {
    const runtime = createRuntime(vault);
    const timeline = createTimeline(runtime, 32);
    for (let i = 0; i < 40; i += 1) {
      advance(timeline, runtime, inputsAt(vault, runtime.tick));
    }
    const won = hashHex(runtime.state);

    expect(seekTo(timeline, runtime, 2)).toBe(2);
    expect(runtime.runState).toBe('running');
    expect(runtime.fault).toBeNull();

    expect(seekTo(timeline, runtime, 40)).toBe(vault.winsAtTick);
    expect(runtime.runState).toBe('won');
    expect(hashHex(runtime.state)).toBe(won);
  });

  it('odmítne kapacitu, se kterou by kruh nebyl kruh', () => {
    const runtime = createRuntime(oscillator());
    expect(() => createTimeline(runtime, 0)).toThrow(/positive integer/);
    expect(() => createTimeline(runtime, 2.5)).toThrow(/positive integer/);
  });
});
