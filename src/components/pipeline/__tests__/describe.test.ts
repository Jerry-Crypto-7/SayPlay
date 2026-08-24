import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { describeEmission, diffPrograms, type ProgramLine } from '../describe';

/**
 * Panel překladu (P11 T14) — **řádky, ne výpis dokumentu**.
 *
 * Testuje se trojí, a každé kryje jinou vadu:
 *  - **slovník**: událost, podmínka a akce se čtou týmiž aliasy polí, jakými je
 *    čte `src/ir/surface.ts`. Kdyby panel četl jen `ref` a korpus napsal
 *    `counter`, ukazoval by `?` u pravidla, které interpret vidí — tedy by
 *    o běžícím světě lhal;
 *  - **pořadí**: pravidla se vypisují v pořadí VYKONÁNÍ (`phase`, `priority`,
 *    jméno), ne v pořadí klíčů objektu;
 *  - **rozdíl**: druhá věta se s první porovnává přes stabilní `id`, takže
 *    přepsaný práh je jeden změněný řádek, ne zmizelý plus nový.
 *
 * Poslední blok jde proti **skutečnému zmrazenému korpusu**, ne proti fixture
 * napsané tady. Fixture dokazuje jen to, že se panel shodne sám se sebou.
 */

const text = (lines: readonly ProgramLine[]): string => lines.map((line) => line.text).join('\n');

const byId = (lines: readonly ProgramLine[], id: string): string | undefined =>
  lines.find((line) => line.id === id)?.text;

/** Svět o třech pravidlech, tvarem shodný s `C01` ze zmrazeného korpusu. */
const keysWorld = (threshold = 3) => ({
  sim: {
    layout: { kind: 'grid', width: 12, height: 12, levels: 1, portals: [] },
    sockets: { spawn: [1, 6], k1: [2, 2], exit: [11, 6] },
    entities: {
      player: { role: 'actor', socket: 'spawn', state: 'idle' },
      key1: { role: 'collectible', socket: 'k1', state: 'present' },
      key2: { role: 'collectible', socket: 'k1', state: 'present' },
      exit: { role: 'goal', socket: 'exit', state: 'closed', locked: true },
    },
    state: { counters: { keysHeld: { min: 0, max: 3, init: 0 } }, flags: {}, timers: {}, slots: 3 },
    rules: {
      // Zapsané schválně v jiném pořadí, než v jakém se vykonají.
      win: {
        id: 'win',
        phase: 2,
        priority: 0,
        event: { kind: 'onEnterZone', entity: 'player', zone: 'exit' },
        condition: { kind: 'stateIs', target: 'exit', value: 'open' },
        actions: [{ kind: 'win' }],
      },
      pick: {
        id: 'pick',
        phase: 0,
        priority: 0,
        event: { kind: 'onPickup', role: 'collectible' },
        condition: null,
        actions: [{ kind: 'addCounter', ref: 'keysHeld', by: 1 }],
      },
      unlock: {
        id: 'unlock',
        phase: 1,
        priority: 0,
        event: { kind: 'onCounterReaches', ref: 'keysHeld', threshold },
        condition: { kind: 'counterIs', ref: 'keysHeld', op: '>=', value: threshold },
        actions: [
          { kind: 'setLocked', target: 'exit', locked: false },
          { kind: 'setState', target: 'exit', value: 'open' },
        ],
      },
    },
    witness: { tier: 'short', H_cert: 600, L_witness: 268, K_input: 5, ops: [{ tick: 0 }, { tick: 60 }] },
  },
  look: { modules: { player: { family: 'actor' } }, palette: 'slate', lightRig: 'key' },
});

describe('describeEmission — věty, ne dokument', () => {
  it('pravidla jdou v pořadí vykonání, ne v pořadí klíčů', () => {
    const lines = describeEmission(keysWorld()).filter((line) => line.section === 'rules');

    expect(lines.map((line) => line.id)).toEqual(['rules/pick', 'rules/unlock', 'rules/win']);
    expect(lines[0].text.startsWith('1. ')).toBe(true);
  });

  it('událost, podmínka i akce se přeloží do věty', () => {
    const lines = describeEmission(keysWorld());

    expect(byId(lines, 'rules/pick')).toBe('1. When the player picks up a collectible → keysHeld +1');
    expect(byId(lines, 'rules/unlock')).toBe(
      '2. When keysHeld reaches 3, and keysHeld is at least 3 → unlock exit; set exit to “open”',
    );
    expect(byId(lines, 'rules/win')).toBe(
      '3. When player enters zone exit, and exit is “open” → win',
    );
  });

  it('cíl se čte z pravidla, které vyhrává — a nese spouštěč, ne akci', () => {
    const lines = describeEmission(keysWorld());

    expect(byId(lines, 'goal/win')).toBe('You win when player enters zone exit, and exit is “open”.');
    expect(byId(lines, 'goal/witness')).toBe(
      'The system carries a trace for it: 2 moves, win at tick 268 of 600.',
    );
  });

  it('tvar stavby vypíše mřížku, kotvy, role i stav', () => {
    const lines = describeEmission(keysWorld());

    expect(byId(lines, 'build/grid')).toBe('Grid 12 × 12 cells');
    expect(byId(lines, 'build/sockets')).toBe('3 sockets: spawn, k1, exit');
    expect(byId(lines, 'build/role/collectible')).toBe('2× collectible: key1, key2');
    expect(byId(lines, 'build/counter/keysHeld')).toBe('Counter keysHeld 0–3, starts at 0');
    expect(byId(lines, 'build/palette')).toBe('Palette slate, light key');
  });

  it('aliasy polí se čtou stejně jako ve snížení, ne jen ta první varianta', () => {
    // `surface.ts` bere `ref ?? counter`, `target ?? entity`, `value ?? state`.
    // Korpus píše obojí, takže panel, který zná jen jednu variantu, ukáže `?`.
    const aliased = {
      sim: {
        rules: {
          r: {
            phase: 0,
            priority: 0,
            event: { kind: 'onStateEnter', target: 'door', value: 'open' },
            condition: { kind: 'counterIs', counter: 'coins', op: '>', value: 2 },
            actions: [{ kind: 'addCounter', counter: 'coins', delta: -1 }],
          },
        },
      },
    };

    expect(byId(describeEmission(aliased), 'rules/r')).toBe(
      '1. When door enters state “open”, and coins is more than 2 → coins −1',
    );
  });

  it('složená podmínka se spojí slovy, ne závorkami', () => {
    const world = {
      sim: {
        rules: {
          r: {
            phase: 0,
            event: { kind: 'onStart' },
            condition: {
              kind: 'allOf',
              operands: [
                { kind: 'hasItem', slot: 0, item: 'torch' },
                { kind: 'not', operand: { kind: 'timerRunning', ref: 'fuse' } },
              ],
            },
            actions: [{ kind: 'lose' }],
          },
        },
      },
    };

    expect(byId(describeEmission(world), 'rules/r')).toBe(
      '1. At the start, and the player has torch and it is not true that timer fuse is running → lose',
    );
  });
});

describe('describeEmission — vstup zvenčí se nepředpokládá', () => {
  it('emise bez sim řekne, co se stalo, a nespadne', () => {
    expect(text(describeEmission({ look: {} }))).toBe('The model wrote no world for this sentence.');
    expect(text(describeEmission(null))).toBe('The model wrote no world for this sentence.');
  });

  it('rozbité typy nespadnou a chybějící kus se přizná', () => {
    const broken = {
      sim: {
        layout: { width: 'dvanáct', height: null },
        rules: { r: { phase: 'první', event: { kind: 'onSignal' }, actions: 'ne pole' } },
      },
    };
    const lines = describeEmission(broken);

    expect(lines.find((line) => line.id === 'build/grid')).toBeUndefined();
    expect(byId(lines, 'rules/r')).toBe('1. When signal ? arrives → nothing');
    expect(byId(lines, 'goal/win')).toBe('No rule leads to a win.');
  });

  it('svět bez jediného pravidla to řekne místo prázdné sekce', () => {
    expect(byId(describeEmission({ sim: { rules: {} } }), 'rules/none')).toBe('This world has no rules.');
  });
});

describe('diffPrograms — druhá věta ukáže rozdíl', () => {
  it('první emise není samá novinka', () => {
    const lines = describeEmission(keysWorld());

    expect(diffPrograms(null, lines).every((entry) => entry.change === 'same')).toBe(true);
  });

  it('přepsaný práh je JEDEN změněný řádek, ne zmizelý plus nový', () => {
    const before = describeEmission(keysWorld(3));
    const after = describeEmission(keysWorld(5));
    const diff = diffPrograms(before, after);

    const unlock = diff.filter((entry) => entry.line.id === 'rules/unlock');
    expect(unlock).toHaveLength(1);
    expect(unlock[0].change).toBe('changed');
    expect(diff.some((entry) => entry.change === 'removed')).toBe(false);
    expect(diff.some((entry) => entry.change === 'added')).toBe(false);
  });

  it('zmizelé pravidlo se vypíše, nezmizí potichu', () => {
    const before = describeEmission(keysWorld());
    const trimmed = keysWorld();
    delete (trimmed.sim.rules as Record<string, unknown>).unlock;
    const diff = diffPrograms(before, describeEmission(trimmed));

    const gone = diff.filter((entry) => entry.change === 'removed');
    expect(gone.map((entry) => entry.line.id)).toEqual(['rules/unlock']);
  });

  it('nové pravidlo je přidané, a beze změny zůstane beze změny', () => {
    const before = describeEmission(keysWorld());
    const grown = keysWorld();
    (grown.sim.rules as Record<string, unknown>).hint = {
      phase: 3,
      priority: 0,
      event: { kind: 'onStart' },
      actions: [{ kind: 'emit', signal: 'hint' }],
    };
    const diff = diffPrograms(before, describeEmission(grown));

    expect(diff.filter((entry) => entry.change === 'added').map((entry) => entry.line.id)).toEqual([
      'rules/hint',
    ]);
    expect(diff.find((entry) => entry.line.id === 'build/grid')?.change).toBe('same');
  });
});

describe('proti skutečnému zmrazenému korpusu, ne proti vlastní fixture', () => {
  it('C01 se přeloží na věty, které jmenují jeho tři klíče i cíl', () => {
    const first = readFileSync('evals/frozen/responses/index.jsonl', 'utf8').split('\n')[0];
    const lines = describeEmission((JSON.parse(first) as { body: unknown }).body);

    expect(byId(lines, 'build/role/collectible')).toBe('3× collectible: key1, key2, key3');
    expect(byId(lines, 'goal/win')).toBe('You win when player enters zone exit, and exit is “open”.');
    expect(byId(lines, 'rules/pick')).toBe('1. When the player picks up a collectible → keysHeld +1');
    // Panel nesmí být prázdný ani u světa, který nese jen dva vizuální moduly.
    expect(byId(lines, 'build/modules')).toBe('Look: player → actor, exit → arch');
  });
});
