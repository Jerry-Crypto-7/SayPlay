import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '@/ir/build';
import { recognize } from '@/model/local/shapes';
import { hashHex } from '@/sim/hash';
import {
  createRuntime,
  entityPlacements,
  step,
  type TraceInput,
  type WorldDocRuntime,
} from '@/sim/interpreter';

import {
  actorOf,
  arrivedAt,
  createControls,
  intentFromKey,
  phaseOf,
  playableTargets,
  type PlacedEntity,
} from '../flow';

/**
 * Věta **není ve zmrazeném korpusu**, a musí být mimo něj: offline generátor hledá
 * doslovnou shodu, takže korpusová věta by šla jinou cestou a rozpoznávač tvarů
 * z T7 by se neměřil. Tvar `keys-to-door` dá tři klíče a zamčené dveře, tedy svět,
 * kde se bez sběru vyhrát nedá.
 */
const SENTENCE = 'a quiet cellar with three keys and a locked exit door';

/** Kolik tiků se dá běhu nejvýš, než se prohlásí za zaseknutý. Svědek chodí po 60. */
const HORIZON = 600;

function room(): WorldDocRuntime {
  const emission = recognize(SENTENCE) as { sim: unknown } | null;
  if (emission === null) throw new Error('rozpoznávač větu nezná');
  const built = buildRuntimeWorld(emission.sim);
  if (!built.ok) throw new Error(`svět se nepostavil: ${built.issues.join('; ')}`);
  return built.world;
}

function placed(runtime: ReturnType<typeof createRuntime>): readonly PlacedEntity[] {
  return entityPlacements(runtime).map((at) => ({ stableId: at.stableId, cell: [at.x, at.y] as const }));
}

describe('kdo je hráč a na co jde ukázat', () => {
  it('hráčem je entita s rolí actor a ovládat jde všechny ostatní', () => {
    const world = room();
    const actor = actorOf(world);

    expect(actor).not.toBeNull();
    expect(world.ir.entities.find((entity) => entity.stableId === actor)?.role).toBe('actor');
    expect(playableTargets(world)).not.toContain(actor);
  });

  it('hráče hledá role, ne pořadí — i když stojí v dokumentu až druhý', () => {
    // Naměřeno mutací: v rozpoznané místnosti je hráč náhodou první entita, takže
    // `najdi roli actor` a `vezmi první` dávají tutéž odpověď a aserce výš by prošla
    // i implementaci, která roli vůbec nečte. Tady je pořadí prohozené, takže se
    // ty dvě odpovědi rozejdou.
    const emission = recognize(SENTENCE) as { sim: { entities: Record<string, unknown> } };
    const entries = Object.entries(emission.sim.entities);
    const player = entries.find(([name]) => name === 'player');
    if (player === undefined) throw new Error('místnost nemá hráče');
    const reordered = {
      ...emission.sim,
      entities: Object.fromEntries([...entries.filter(([name]) => name !== 'player'), player]),
    };

    const built = buildRuntimeWorld(reordered);
    if (!built.ok) throw new Error(`svět se nepostavil: ${built.issues.join('; ')}`);

    expect(built.world.ir.entities[0]?.stableId).not.toBe('player');
    expect(actorOf(built.world)).toBe('player');
  });

  it('a je to týž hráč, jakého zná stavěč pravidel pohybu', () => {
    // Kdyby se `actorOf` rozešlo s `src/ir/build.ts`, ovládání by posílalo akce
    // jménem entity, které žádné `sys.moveTo.*` nepatří — svět by na klávesy tiše
    // nereagoval a nic by o tom neřeklo. Tenhle test je to, co se v tu chvíli
    // rozsvítí: pravidla pohybu musí existovat právě pro ovladatelné cíle.
    const world = room();
    const moveRules = world.ir.rules
      .filter((rule) => rule.ruleId.startsWith('sys.moveTo.'))
      .map((rule) => rule.ruleId.slice('sys.moveTo.'.length))
      .sort();

    // `build.ts` vyrábí pravidlo pohybu i **na hráče samotného** — jít sám k sobě
    // je legální a nedělá nic. Ovládání ho schválně nenabízí, takže rozdíl mezi
    // těmi dvěma seznamy musí být přesně hráč, ne cokoli jiného.
    expect(moveRules).toContain(actorOf(world));
    expect(moveRules.filter((id) => id !== actorOf(world))).toEqual([...playableTargets(world)].sort());
  });

  it('cíle jdou v pořadí dokumentu, ne podle abecedy', () => {
    const world = room();
    const targets = playableTargets(world);
    const order = world.ir.entities.map((entity) => entity.stableId).filter((id) => targets.includes(id));

    expect(targets).toEqual(order);
    // A není to totéž jako abecedně — jinak by aserce výš neměřila nic.
    expect(targets).not.toEqual([...targets].sort());
  });
});

describe('klávesa se překládá na záměr', () => {
  const targets = ['keyA', 'keyB', 'door'];

  it('číslice míří na cíl na své pozici', () => {
    expect(intentFromKey('1', targets, null)).toEqual({ actionId: 'moveTo', target: 'keyA' });
    expect(intentFromKey('3', targets, null)).toEqual({ actionId: 'moveTo', target: 'door' });
  });

  it('číslice mimo seznam nedělá nic', () => {
    expect(intentFromKey('4', targets, null)).toBeNull();
    expect(intentFromKey('0', targets, null)).toBeNull();
  });

  it('seber a použij míří na vybraný cíl', () => {
    expect(intentFromKey(' ', targets, 'keyB')).toEqual({ actionId: 'pickup', target: 'keyB' });
    expect(intentFromKey('e', targets, 'keyB')).toEqual({ actionId: 'use', target: 'keyB' });
    expect(intentFromKey('E', targets, 'keyB')).toEqual({ actionId: 'use', target: 'keyB' });
  });

  it('bez vybraného cíle nemá seber ani použij kam mířit', () => {
    expect(intentFromKey(' ', targets, null)).toBeNull();
    expect(intentFromKey('e', targets, null)).toBeNull();
  });

  it('neznámá klávesa je ticho, ne výjimka', () => {
    expect(intentFromKey('q', targets, 'keyB')).toBeNull();
    expect(intentFromKey('Enter', targets, 'keyB')).toBeNull();
  });
});

describe('fáze hry', () => {
  const base = { hasWorld: true, revealed: 4, total: 4, runState: 'running' } as const;

  it('bez světa se staví', () => {
    expect(phaseOf({ ...base, hasWorld: false })).toBe('building');
  });

  it('nedostavěný svět se staví, i když běh běží', () => {
    expect(phaseOf({ ...base, revealed: 3 })).toBe('building');
  });

  it('dostavěný a běžící svět se hraje', () => {
    expect(phaseOf(base)).toBe('playing');
  });

  it('výhra přebije i nedostavěnou scénu', () => {
    // Bez tohohle pořadí by svět, který vyhraje dřív, než dojede rozvrh stavby,
    // hlásil `building` a výhra by se ztratila.
    expect(phaseOf({ ...base, revealed: 0, runState: 'won' })).toBe('won');
  });

  it('prohra i běhová vada jsou prohra', () => {
    expect(phaseOf({ ...base, runState: 'lost' })).toBe('lost');
    expect(phaseOf({ ...base, runState: 'runtimeFault' })).toBe('lost');
  });
});

describe('dojel jsem na cíl?', () => {
  const at = (stableId: string, cell: readonly [number, number]): PlacedEntity => ({ stableId, cell });

  it('shodná políčka znamenají dojezd', () => {
    expect(arrivedAt([at('player', [3, 4]), at('key', [3, 4])], 'player', 'key')).toBe(true);
  });

  it('rozdíl v jediné ose dojezd není', () => {
    expect(arrivedAt([at('player', [3, 4]), at('key', [3, 5])], 'player', 'key')).toBe(false);
    expect(arrivedAt([at('player', [2, 4]), at('key', [3, 4])], 'player', 'key')).toBe(false);
  });

  it('chybějící entita není dojezd', () => {
    expect(arrivedAt([at('player', [3, 4])], 'player', 'key')).toBe(false);
    expect(arrivedAt([at('key', [3, 4])], 'player', 'key')).toBe(false);
  });
});

describe('fronta stisků a stopa, která z ní vznikne', () => {
  it('razítko dostane tik, který si pro vstup přijde, ne tik stisku', () => {
    // Jádro věci: kdyby si stisk bral tik sám, trefil by tik, který smyčka právě
    // odkrokovala, a `inputsForTick` by ho zahodila. Fronta proto čeká.
    const controls = createControls();
    controls.press('1', ['keyA']);

    // Stisk padl kdykoli; razítko dá až tik, který si pro něj přijde — tady 41.
    expect(controls.take(41, 'player')).toEqual([{ tick: 41, actor: 'player', actionId: 'moveTo', target: 'keyA' }]);
    // A podruhé už nic: co se vzalo, je pryč z fronty.
    expect(controls.take(42, 'player')).toEqual([]);
  });

  it('prázdná fronta nezapíše do stopy nic', () => {
    const controls = createControls();
    expect(controls.take(7, 'player')).toEqual([]);
    expect(controls.log()).toEqual([]);
  });

  it('dva stisky mezi tiky vyjdou oba, v pořadí stisku', () => {
    const controls = createControls();
    controls.press('1', ['keyA', 'door']);
    controls.press(' ', ['keyA', 'door']);

    expect(controls.take(5, 'player').map((input) => input.actionId)).toEqual(['moveTo', 'pickup']);
  });

  it('co se vzalo, to je ve stopě — a jen jednou', () => {
    const controls = createControls();
    controls.press('1', ['keyA']);
    controls.take(3, 'player');
    controls.take(4, 'player');

    expect(controls.log()).toEqual([{ tick: 3, actor: 'player', actionId: 'moveTo', target: 'keyA' }]);
  });

  it('číslice vybere cíl, takže na něj míří i další seber', () => {
    const controls = createControls();
    expect(controls.selected()).toBeNull();
    controls.press('2', ['keyA', 'keyB']);
    expect(controls.selected()).toBe('keyB');
    expect(controls.press(' ', ['keyA', 'keyB'])).toEqual({ actionId: 'pickup', target: 'keyB' });
  });

  it('restart vysype frontu, stopu i výběr', () => {
    const controls = createControls();
    controls.press('1', ['keyA']);
    controls.take(2, 'player');
    controls.press('1', ['keyA']);
    controls.reset();

    expect(controls.log()).toEqual([]);
    expect(controls.selected()).toBeNull();
    expect(controls.take(9, 'player')).toEqual([]);
  });
});

/**
 * Oracle úlohy T19 v Node, bez prohlížeče.
 *
 * Prohlížečová sada `e2e/playable-loop.spec.ts` měří totéž nad skutečným plátnem;
 * tenhle test měří **logiku** — že se svět dá klávesami dohrát a že zápis, který
 * z toho vznikl, dá po přehrání týž běh. Kdyby to platilo jen v prohlížeči, byl by
 * determinismus tvrzením o jednom stroji, ne o systému.
 */
describe('rukou se dá dohrát, a co ruka zahrála, jde přehrát', () => {
  function play(world: WorldDocRuntime) {
    const controls = createControls();
    const runtime = createRuntime(world);
    const actor = actorOf(world);
    const targets = playableTargets(world);
    if (actor === null) throw new Error('svět nemá hráče');

    let heading = 0;
    controls.press('1', targets);

    for (let tick = 0; tick < HORIZON && runtime.runState === 'running'; tick += 1) {
      step(runtime, [...controls.take(tick, actor)]);
      const target = targets[heading];
      if (target !== undefined && arrivedAt(placed(runtime), actor, target)) {
        // Seber se mačká na každé zastávce. Na dveřích je to akce, na kterou žádné
        // pravidlo neposlouchá — tedy tichý no-op, ne chyba, a ruka nemusí vědět,
        // co je sběratelné.
        controls.press(' ', targets);
        heading += 1;
        if (heading < targets.length) controls.press(String(heading + 1), targets);
      }
    }
    return { runtime, controls };
  }

  function replay(world: WorldDocRuntime, log: readonly TraceInput[]) {
    const runtime = createRuntime(world);
    for (let tick = 0; tick < HORIZON && runtime.runState === 'running'; tick += 1) {
      step(runtime, log.filter((input) => input.tick === tick));
    }
    return runtime;
  }

  it('nečinný hráč nevyhraje — jinak by hraní níž nedokazovalo nic', () => {
    const runtime = replay(room(), []);
    expect(runtime.runState).toBe('running');
  });

  it('klávesy dovedou hráče do výhry', () => {
    const { runtime, controls } = play(room());

    expect(runtime.runState).toBe('won');
    // A vyhrálo se tím, co hráč zmáčkl, ne tím, že svět vyhrává sám.
    expect(controls.log().length).toBeGreaterThan(3);
  });

  it('zápis té hry dá po přehrání bitově týž stav', () => {
    const world = room();
    const { runtime, controls } = play(world);
    const again = replay(world, controls.log());

    expect(again.runState).toBe('won');
    expect(hashHex(again.state)).toBe(hashHex(runtime.state));
  });

  it('bez jednoho sebraného klíče se nevyhraje, a hash to pozná', () => {
    // Tohle je ta aserce, která dělá ze shody hashů výš tvrzení. Ubrat poslední
    // vstup nestačí — je to seber na dveřích, na který žádné pravidlo neposlouchá,
    // takže se ubráním nezmění nic a dva shodné hashe by nedokazovaly vůbec nic
    // (naměřeno: shodly se). Ubírá se proto **první sběr**: dveře pak zůstanou
    // zamčené, hráč do nich dojde a nevyhraje.
    const world = room();
    const { runtime, controls } = play(world);
    const dropped = controls.log().findIndex((input) => input.actionId === 'pickup');
    const short = controls.log().filter((_, at) => at !== dropped);

    expect(dropped).toBeGreaterThanOrEqual(0);
    const partial = replay(world, short);
    expect(partial.runState).not.toBe('won');
    expect(hashHex(partial.state)).not.toBe(hashHex(runtime.state));
  });
});
