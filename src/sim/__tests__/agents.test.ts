/**
 * Mysli postav (P11 T18).
 *
 * O mysli se zvenčí nedá říct nic jiného, než **kudy postava chodila** — proto
 * je oraclem `visitedZones` nad skutečným během, ne přečtení pravidel, která
 * z mysli vznikla. Čtení pravidel by dokazovalo jen to, že snížení vyrobilo, co
 * vyrobit chtělo; tady jde o to, že se to opravdu hýbe jinak.
 *
 * Dvě vlastnosti se musí držet **současně** a každá zvlášť se dá splnit
 * podvodem:
 *
 * 1. **Povaha rozhoduje o trase.** Tři povahy nad touž trasou dávají tři různé
 *    množiny navštívených zón, ne tři pořadí téže množiny.
 * 2. **Povaha je STAV, ne tvar dokumentu.** Přepsání jediné počáteční hodnoty
 *    v paměti — bez sáhnutí na jediné pravidlo — dá bitově tutéž trasu jako
 *    svět, který se s tou povahou postavil. Kdyby se následník zapekl při
 *    snížení, první vlastnost by pořád platila a tahle by padla.
 */

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '../../ir/build';
import { AGENT_MOOD_INDEX, type SlotDecl } from '../../ir/types';
import { visitedZones } from '../agents';
import type { WorldDocRuntime } from '../interpreter';

/** Kolik tiků se pozoruje. Táž mez, jakou měří `e2e/agent-minds.spec.ts`. */
const HORIZON = 100;

/**
 * Zastávky, které **netvoří přímku**. Cesta ke krajní zastávce tak neprochází
 * prostřední a povahy se dají rozeznat podle navštívené množiny.
 */
const TRIANGLE: Readonly<Record<string, readonly [number, number]>> = {
  post: [3, 1],
  hall: [6, 6],
  alcove: [9, 1],
};

/** Zastávky **v řadě**. Cesta z první na třetí prochází druhou — tam žije stráž nad cílem. */
const IN_A_ROW: Readonly<Record<string, readonly [number, number]>> = {
  near: [3, 2],
  middle: [6, 2],
  far: [9, 2],
};

/** Sedm jmen na měření stropu trasy. `MAX_AGENT_GOALS` je šest. */
const SEVEN = ['s1', 's2', 's3', 's4', 's5', 's6', 's7'];

function patrol(
  disposition: string,
  stops: Readonly<Record<string, readonly [number, number]>>,
  goals: readonly string[],
): unknown {
  return {
    layout: { width: 12, height: 8 },
    sockets: { spawn: [1, 4], ...stops },
    entities: {
      player: { role: 'actor', socket: 'spawn', state: 'idle' },
      watcher: { role: 'agent', socket: goals[0], state: 'idle' },
    },
    rules: {},
    state: { counters: {}, flags: {}, timers: {}, zones: {}, agents: [{ id: 'watcher', disposition, goals }] },
    // Prázdná stopa schválně: hráč se nehýbe, takže všechno, co se v běhu stane,
    // napsala mysl. Svět s vítěznou stopou se testuje přes rozpoznávač tvarů.
    witness: { tier: 'short', H_cert: 600, ops: [] },
  };
}

function built(sim: unknown): WorldDocRuntime {
  const result = buildRuntimeWorld(sim);
  if (!result.ok) throw new Error(`svět se nepostavil: ${result.issues.join('; ')}`);
  return result.world;
}

function walked(disposition: string, stops = TRIANGLE, goals = ['post', 'hall', 'alcove']): readonly string[] {
  return visitedZones(built(patrol(disposition, stops, goals)), 'watcher', HORIZON);
}

describe('povaha rozhoduje o trase', () => {
  it('bold projde celou trasu', () => {
    expect(walked('bold')).toEqual(['alcove', 'hall', 'post']);
  });

  it('wary se drží prvních dvou zastávek', () => {
    expect(walked('wary')).toEqual(['hall', 'post']);
  });

  it('restless pobíhá mezi krajními body', () => {
    expect(walked('restless')).toEqual(['alcove', 'post']);
  });

  it('a ty tři množiny jsou opravdu tři, ne jedna napsaná třikrát', () => {
    // Bez téhle aserce by celý blok prošel i implementaci, která povahu ignoruje
    // a vždycky projde všechno — každý test výš by pak měřil totéž.
    const routes = ['bold', 'wary', 'restless'].map((mood) => walked(mood).join('|'));
    expect(new Set(routes).size).toBe(3);
  });

  it('postava, která nikam nejde, by prošla jen výchozí zónou — a to tu nikdo nedělá', () => {
    for (const mood of ['bold', 'wary', 'restless']) expect(walked(mood).length).toBeGreaterThan(1);
  });
});

describe('povaha je stav, ne tvar dokumentu', () => {
  it('přepsání jediné počáteční hodnoty v paměti změní budoucnost', () => {
    const world = built(patrol('bold', TRIANGLE, ['post', 'hall', 'alcove']));
    const slots = world.ir.slots.map((slot: SlotDecl) =>
      slot.space === 'memory' && slot.index === AGENT_MOOD_INDEX ? { ...slot, initial: 'wary' } : slot,
    );
    const rewritten: WorldDocRuntime = { ...world, ir: { ...world.ir, slots } };

    // Pravidla jsou bajt po bajtu tatáž — mění se jediný symbol ve stavu.
    expect(rewritten.ir.rules).toEqual(world.ir.rules);
    expect(visitedZones(rewritten, 'watcher', HORIZON)).toEqual(walked('wary'));
    expect(visitedZones(rewritten, 'watcher', HORIZON)).not.toEqual(walked('bold'));
  });
});

describe('stráž nad cílem drží trasu, když zastávky leží v řadě', () => {
  it('postava dojde na vzdálenou zastávku, i když jde skrz prostřední', () => {
    // `restless` míří z `near` rovnou na `far` a prochází přitom `middle`. Bez
    // stráže `memory[goal] = jméno` by ji průchod obrátil zpátky a na `far` by
    // nikdy nedošla — proto se měří přítomnost `far`, ne jen počet zón.
    const route = walked('restless', IN_A_ROW, ['near', 'middle', 'far']);
    expect(route).toContain('far');
    expect(route).toEqual(['far', 'middle', 'near']);
  });
});

describe('mysl, které nejde věřit, dokument odmítne', () => {
  const cases: readonly (readonly [string, unknown])[] = [
    ['neznámá entita', { id: 'nikdo', disposition: 'bold', goals: ['post'] }],
    ['neznámá povaha', { id: 'watcher', disposition: 'grumpy', goals: ['post'] }],
    ['cíl, který není soket', { id: 'watcher', disposition: 'bold', goals: ['nikde'] }],
    ['prázdná trasa', { id: 'watcher', disposition: 'bold', goals: [] }],

    ['zopakovaný cíl', { id: 'watcher', disposition: 'bold', goals: ['post', 'post'] }],
    ['mysl na hráči', { id: 'player', disposition: 'bold', goals: ['post', 'hall'] }],
  ];

  for (const [label, mind] of cases) {
    it(`${label} skončí jako UNSUPPORTED_SURFACE`, () => {
      const sim = patrol('bold', TRIANGLE, ['post', 'hall', 'alcove']) as {
        state: { agents: unknown[] };
      };
      sim.state.agents = [mind];
      const result = buildRuntimeWorld(sim);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reason).toBe('UNSUPPORTED_SURFACE');
    });
  }

  it('trasa nad stropem se odmítne stropem, ne shodou okolností', () => {
    // Zastávky jsou tu **deklarované sokety**, všech sedm. Kdyby to byla jména
    // odnikud, odmítla by je kontrola soketu a `MAX_AGENT_GOALS` by se nikdy
    // nespustil — aserce by pak hlídala jinou vlastnost, než o které mluví.
    // Naměřeno mutací: se sedmi nedeklarovanými jmény přežila mutace, která
    // strop úplně odstranila.
    const stops: Record<string, readonly [number, number]> = Object.fromEntries(
      SEVEN.map((name, at): readonly [string, readonly [number, number]] => [
        name,
        at < 5 ? [2 + at * 2, 1] : [2 + (at - 5) * 2, 6],
      ]),
    );
    const sim = patrol('bold', stops, SEVEN) as {
      state: { agents: unknown[] };
    };

    // Šest zastávek z týchž soketů projde, sedm ne. Rozdíl je jedna položka.
    sim.state.agents = [{ id: 'watcher', disposition: 'bold', goals: SEVEN.slice(0, 6) }];
    expect(buildRuntimeWorld(sim).ok).toBe(true);

    sim.state.agents = [{ id: 'watcher', disposition: 'bold', goals: SEVEN }];
    const result = buildRuntimeWorld(sim);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe('UNSUPPORTED_SURFACE');
  });

  it('mysl napsaná jako objekt je nález, ne prázdný seznam', () => {
    // Ostatní nádoby ve `state` jsou objekty klíčované jménem, takže tohle je
    // nejpravděpodobnější vadná emise. `asArray` z ní udělá prázdný seznam,
    // takže bez vlastní kontroly by svět vznikl **bez jediné mysli** a hlásil
    // `ok` — tichý no-op, který se pozná až na demu.
    for (const written of [
      { watcher: { id: 'watcher', disposition: 'bold', goals: ['post', 'hall'] } },
      5,
      null,
      'watcher',
    ]) {
      const sim = patrol('bold', TRIANGLE, ['post', 'hall', 'alcove']) as { state: { agents: unknown } };
      sim.state.agents = written;
      const result = buildRuntimeWorld(sim);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.reason).toBe('UNSUPPORTED_SURFACE');
    }
  });

  it('svět bez jediné mysli je pořád v pořádku', () => {
    // Protiváha k předchozímu: chybějící `agents` není vadná emise, a kdyby ho
    // kontrola seznamu odmítala taky, spadl by na ni každý svět ze zmrazeného
    // korpusu — v žádném z nich `state.agents` není.
    const sim = patrol('bold', TRIANGLE, ['post', 'hall', 'alcove']) as { state: { agents?: unknown } };
    delete sim.state.agents;
    expect(buildRuntimeWorld(sim).ok).toBe(true);
  });

  it('dvě mysli na jedné postavě jsou nález, ne tichá druhá trasa', () => {
    const sim = patrol('bold', TRIANGLE, ['post', 'hall', 'alcove']) as { state: { agents: unknown[] } };
    sim.state.agents = [
      { id: 'watcher', disposition: 'bold', goals: ['post', 'hall'] },
      { id: 'watcher', disposition: 'wary', goals: ['post', 'alcove'] },
    ];
    const result = buildRuntimeWorld(sim);
    expect(result.ok).toBe(false);
  });
});

describe('startovní pravidlo vede postavu na první zastávku', () => {
  it('postava, která nestojí na své první zastávce, k ní dojde a pokračuje', () => {
    // Když postava startuje NA první zastávce, `inZone` nad ní vyjde hned v tiku
    // nula a trasu rozjede pravidlo příchodu — startovní pravidlo je pak
    // nepozorovatelné. Naměřeno mutací: nahrazení jeho `moveTo` za `freeze`
    // přežilo celou sadu. Tady postava startuje jinde, takže se bez startovního
    // pravidla nehne z místa.
    const sim = patrol('bold', { gate: [1, 1], ...TRIANGLE }, ['post', 'hall', 'alcove']) as {
      entities: Record<string, { socket: string }>;
    };
    sim.entities.watcher.socket = 'gate';

    expect(visitedZones(built(sim), 'watcher', HORIZON)).toEqual(['alcove', 'gate', 'hall', 'post']);
  });
});

describe('mysl nepatří roli, ale entitě', () => {
  it('postava s jinou rolí než `agent` dostane mysl a chodí', () => {
    const sim = patrol('bold', TRIANGLE, ['post', 'hall', 'alcove']) as {
      entities: Record<string, { role: string }>;
    };
    // `maxAgents` se dopočítává i z počtu myslí, ne jen z rolí. Kdyby ne,
    // `validateIrDoc` by tenhle dokument shodil na `distinct memory agents
    // above limits.maxAgents` — a model by o povaze rozhodoval jen u entit,
    // kterým sám napsal správnou roli.
    sim.entities.watcher.role = 'prop';
    expect(visitedZones(built(sim), 'watcher', HORIZON)).toEqual(['alcove', 'hall', 'post']);
  });
});

describe('svět bez myslí se nezměnil', () => {
  it('nedeklarovaná mysl nepřidá slot ani pravidlo', () => {
    const sim = patrol('bold', TRIANGLE, ['post', 'hall', 'alcove']) as { state: Record<string, unknown> };
    delete sim.state.agents;
    const world = built(sim);

    expect(world.ir.limits.memorySlotsPerAgent).toBe(0);
    expect(world.ir.slots.filter((slot: SlotDecl) => slot.space === 'memory')).toEqual([]);
    expect(world.ir.rules.filter((rule) => rule.ruleId.startsWith('mind.'))).toEqual([]);
  });
});
