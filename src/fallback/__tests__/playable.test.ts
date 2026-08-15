import { describe, expect, it } from 'vitest';

import { A1, a1Game } from '../archetypes/a1-collect-unlock';
import { A2, RULE_VALUES, a2Create, a2Game, type MatchRule } from '../archetypes/a2-sort-match';
import { A3, a3Game } from '../archetypes/a3-guide-avoid';
import { runTrace, type Archetype, type Intent } from '../loop';
import { CAPABILITY_TOKENS, type CapabilityToken } from '../manifests';

const ARCHETYPES: readonly Archetype[] = [A1, A2, A3];

/** Modalita → druh záměru. Jediná vazba mezi slovníkem a vstupní vrstvou. */
const MODALITY: Partial<Record<CapabilityToken, Intent['kind']>> = {
  IN_MOVE: 'move',
  IN_CLICK: 'point',
  IN_DRAG: 'drag',
};

const SAMPLE: Record<Intent['kind'], Intent> = {
  move: { kind: 'move', dx: 1, dy: 0 },
  point: { kind: 'point', target: '1,0' },
  drag: { kind: 'drag', from: 'item0', to: 'socket0' },
};

/** Každé číslo kdekoli ve stavu. Rekurzivně, ať se nedá schovat do pole. */
function numbersIn(value: unknown, found: number[] = []): number[] {
  if (typeof value === 'number') found.push(value);
  else if (Array.isArray(value)) for (const item of value) numbersIn(item, found);
  else if (value !== null && typeof value === 'object') {
    for (const item of Object.values(value)) numbersIn(item, found);
  }
  return found;
}

describe.each(ARCHETYPES.map((archetype) => [archetype.id, archetype] as const))(
  '%s',
  (_id, archetype) => {
    const params = archetype.tuples()[0];
    const game = archetype.game(params);

    it('je dohratelný do výhry scriptovanou stopou', () => {
      // „Ne ručně" znamená, že stopu vyrobí řešitel archetypu. Ručně psaná stopa
      // pro jednu n-tici nedokazuje nic o zbylých 191.
      const trace = archetype.solve(params, 1);
      expect(trace).not.toBeNull();
      const result = runTrace(game, 1, trace!);
      expect([archetype.id, result.view.phase]).toEqual([archetype.id, 'won']);
      expect(result.ticks).toBeGreaterThan(0);
    });

    it('prázdná stopa nevyhraje — žádný insta-win', () => {
      expect(runTrace(game, 1, []).view.phase).not.toBe('won');
    });

    it('dva běhy se stejným seedem dají identický průběh', () => {
      const trace = archetype.solve(params, 5)!;
      expect(runTrace(game, 5, trace)).toEqual(runTrace(game, 5, trace));
    });

    it('používá jen tokeny, které manifest podporuje', () => {
      const supported = new Set(archetype.manifest.supported);
      expect(archetype.uses.filter((token) => !supported.has(token))).toEqual([]);
    });

    it('nepoužije ani jeden token ze své Forbidden množiny', () => {
      const forbidden = new Set(archetype.manifest.forbidden);
      expect(archetype.uses.filter((token) => forbidden.has(token))).toEqual([]);
    });

    it('nereaguje na modalitu, kterou nedeklaruje', () => {
      // Deklarace `uses` by jinak byla jen slib. Tohle ji konfrontuje s kódem:
      // druh záměru, který archetyp neuvádí, nesmí se stavem hnout.
      const declared = new Set(
        archetype.uses.map((token) => MODALITY[token]).filter((kind) => kind !== undefined),
      );
      const state = game.create(3);

      for (const [kind, intent] of Object.entries(SAMPLE) as [Intent['kind'], Intent][]) {
        if (declared.has(kind)) continue;
        expect([archetype.id, kind, game.advance(state, [intent])]).toEqual([
          archetype.id,
          kind,
          game.advance(state, []),
        ]);
      }
    });

    it('nedrží ve stavu jediné neceločíselné číslo', () => {
      // `STATE_CONTINUOUS` je zakázaný ve všech třech manifestech. Deklarace to
      // netvrdí věrohodně; celočíselnost celého stavu v každém tiku ano.
      const trace = archetype.solve(params, 9)!;
      let state = game.create(9);
      for (const intents of [[], ...trace]) {
        state = game.advance(state, intents);
        const fractional = numbersIn(state).filter((value) => !Number.isInteger(value));
        expect([archetype.id, fractional]).toEqual([archetype.id, []]);
      }
    });

    it('nepamatuje si nic mezi epizodami', () => {
      // `STATE_PERSISTENT_MEMORY` je zakázaná všude. Odehraje se celá partie a
      // pak se svět postaví znovu — musí vyjít bit po bitu stejný.
      const before = game.create(11);
      runTrace(game, 11, archetype.solve(params, 11)!);
      expect(game.create(11)).toEqual(before);
    });

    it('deklaruje jen tokeny ze slovníku', () => {
      const vocabulary = new Set<string>(CAPABILITY_TOKENS);
      expect(archetype.uses.filter((token) => !vocabulary.has(token))).toEqual([]);
    });
  },
);

describe('A1 — brána', () => {
  it('drží cíl zavřený, dokud není posbíráno', () => {
    // Práh je celý smysl archetypu. Bez téhle kontroly by šlo z A1 udělat
    // „dojdi do rohu" a všechny ostatní testy by zůstaly zelené.
    const params = {
      n_collect: 3,
      arena: 'small',
      timer: null,
      hazard_count: 0,
      hazard_behavior: 'static',
    } as const;
    const game = a1Game(params);
    const east: Intent[] = [{ kind: 'move', dx: 1, dy: 0 }];
    const north: Intent[] = [{ kind: 'move', dx: 0, dy: 1 }];
    const straightToGoal = [...Array(6).fill(east), ...Array(6).fill(north)];

    const result = runTrace(game, 1, straightToGoal);
    expect(result.view.phase).toBe('running');
    expect(result.state.avatar).toEqual([6, 5]);
    expect(result.state.gateOpen).toBe(false);
  });
});

describe('A2 — pořadí a chyby', () => {
  const base = {
    n_items: 3,
    match_rule: 'color',
    order: 'strict',
    mistakes_allowed: null,
    timer: null,
  } as const;

  function correctSocket(state: ReturnType<typeof a2Create>, item: number): number {
    return state.socketValues.indexOf(state.itemValues[item]);
  }

  it('match_rule mění párování, ne jen popisek', () => {
    // Kdyby pravidlo měnilo jen jméno atributu, násobilo by doménu n-tic čtyřmi
    // beze změny světa — a „288 n-tic vyčerpáno" by tvrdilo pokrytí, které nemá.
    const rules: MatchRule[] = ['color', 'shape', 'size', 'category'];
    const pairing = (rule: MatchRule, n: number): string => {
      const state = a2Create({ ...base, match_rule: rule, n_items: n }, 4);
      return state.itemValues
        .map((value) => state.socketValues.indexOf(value))
        .join(',');
    };

    expect(new Set(rules.map((rule) => pairing(rule, 6))).size).toBe(4);
    for (const n of [3, 4, 5, 6]) {
      expect([n, new Set(rules.map((rule) => pairing(rule, n))).size]).not.toEqual([n, 1]);
    }
    // A druhá půlka: domény atributů se navzájem neopakují.
    const domains = rules.map((rule) => RULE_VALUES[rule].join(','));
    expect(new Set(domains).size).toBe(4);
  });

  it('ve strict pořadí je přeskočení předmětu chyba, ne ignorovaný tah', () => {
    const state = a2Create(base, 2);
    const after = a2Game(base).advance(state, [
      { kind: 'drag', from: 'item1', to: `socket${correctSocket(state, 1)}` },
    ]);
    expect([after.placed, after.mistakes]).toEqual([0, 1]);
  });

  it('v any pořadí projde tentýž tah bez chyby', () => {
    const params = { ...base, order: 'any' } as const;
    const state = a2Create(params, 2);
    const after = a2Game(params).advance(state, [
      { kind: 'drag', from: 'item1', to: `socket${correctSocket(state, 1)}` },
    ]);
    expect([after.placed, after.mistakes]).toEqual([1, 0]);
  });

  it('limit chyb hru ukončí, ∞ ji nechá běžet', () => {
    const strictOne = { ...base, order: 'any', mistakes_allowed: 1 } as const;
    const state = a2Create(strictOne, 2);
    const wrong = (state_: typeof state) => {
      const good = correctSocket(state_, 0);
      return [
        { kind: 'drag', from: 'item0', to: `socket${(good + 1) % strictOne.n_items}` },
      ] as Intent[];
    };

    const once = a2Game(strictOne).advance(state, wrong(state));
    expect([once.mistakes, once.alive]).toEqual([1, true]);
    const twice = a2Game(strictOne).advance(once, wrong(state));
    expect([twice.mistakes, twice.alive]).toEqual([2, false]);

    const unlimited = { ...strictOne, mistakes_allowed: null } as const;
    const free = a2Create(unlimited, 2);
    const afterThree = [0, 1, 2].reduce(
      (acc) => a2Game(unlimited).advance(acc, wrong(free)),
      free,
    );
    expect([afterThree.mistakes, afterThree.alive]).toEqual([3, true]);
  });
});

describe('A3 — rozpočet nástrojů', () => {
  it('nástroj položený mimo překážku je utracený', () => {
    // Kdyby se počítaly jen trefy, `tool_budget` by přestal být rozhodnutím.
    const params = {
      grid: 7,
      hazard_count: 2,
      tool_budget: 1,
      hazard_behavior: 'static',
      walker_speed: 1,
    } as const;
    const wasted = [[{ kind: 'point', target: '0,0' }] as Intent[]];

    const result = runTrace(a3Game(params), 1, wasted);
    expect(result.view.phase).toBe('lost');
    expect(result.state.toolsLeft).toBe(0);
  });
});

describe('tři archetypy dohromady', () => {
  it('jsou mechanicky odlišné — každý má jinou modalitu i jiný cíl', () => {
    const modalities = ARCHETYPES.map((archetype) =>
      archetype.uses.filter((token) => token.startsWith('IN_')).join(','),
    );
    expect(new Set(modalities).size).toBe(3);

    const goals = ARCHETYPES.map((archetype) =>
      archetype.uses.filter((token) => token.startsWith('GOAL_')).join(','),
    );
    expect(new Set(goals).size).toBe(3);
  });

  it('každý ukazuje na svůj vlastní layout kitu', () => {
    const layouts = ARCHETYPES.map((archetype) => archetype.manifest.sceneLayout);
    expect(new Set(layouts).size).toBe(3);
  });
});
