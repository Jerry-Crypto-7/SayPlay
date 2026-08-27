/**
 * Dopočet poloh mezi tiky — a hlavně to, čeho se nesmí dotknout.
 *
 * Simulace běží na 20 Hz a poloha entity je odvozená z celočíselné buňky, takže
 * postava bez dopočtu skáče o celé pole. Dopočet je proto nejlevnější vizuální
 * zisk v celé vlně — a zároveň ta změna, která může nepozorovaně vtéct do
 * hashovaného stavu a rozbít shodu replaye mezi prohlížečem a Node. Shoda hashů
 * je jediná dokázaná vlastnost projektu a její ztráta by nebyla vidět na
 * obrazovce, jen v naměřených číslech o pár dní později.
 *
 * Test proto míří na čtyři vlastnosti:
 *
 * 1. **Mezipoloha je opravdu mezi** — a hlavně mimo mřížku. Kdyby dopočet
 *    vracel tu nebo onu krajní polohu, vypadalo by to jako dnešní skákání a
 *    nikdo by to nespojil s tím, že se vůbec dopočítává.
 * 2. **Krajní hodnoty vracejí přesný tik.** `step(n)` z `window.__viewer`
 *    posouvá běh bez nástěnného času a musí ukázat stav po tiku, ne rozmazaný
 *    mezistav; na tom stojí každé měření z prohlížeče.
 * 3. **Nespojité údaje se berou ze staršího tiku.** Obraz je jako celek o jeden
 *    tik pozadu, takže `active` z novějšího by nechalo minci zmizet ve chvíli,
 *    kdy k ní postava teprve doklouzává.
 * 4. **Hash stavu se dopočtem nehne** a vstupní projekce zůstávají nedotčené.
 */

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '@/ir/build';
import { recognize } from '@/model/local/shapes';
import { hashHex } from '@/sim/hash';
import { createRuntime, entityPlacements, step, type WorldDocRuntime } from '@/sim/interpreter';

import { interpolateEntities } from '../viewer/interpolate';
import { projectEntities, type ProjectedEntity } from '../viewer/projection';

function entity(over: Partial<ProjectedEntity> = {}): ProjectedEntity {
  return {
    stableId: 'hero',
    role: 'actor',
    visual: 'avatar',
    cell: [0, 0],
    position: { x: 0, y: 0.45, z: 0 },
    active: true,
    state: 'idle',
    locked: false,
    ...over,
  };
}

/** Táž entita posunutá o celá pole — tak, jak ji posune tik simulace. */
function moved(from: ProjectedEntity, dx: number, dz: number): ProjectedEntity {
  return {
    ...from,
    cell: [from.cell[0] + dx, from.cell[1] + dz],
    position: { x: from.position.x + dx, y: from.position.y, z: from.position.z + dz },
  };
}

describe('mezipoloha mezi dvěma tiky', () => {
  it('v polovině tiku leží přesně mezi oběma polohami', () => {
    const before = entity();
    const after = moved(before, 1, 1);

    const [mid] = interpolateEntities([before], [after], 0.5);

    expect(mid.position.x).toBeCloseTo(0.5, 10);
    expect(mid.position.z).toBeCloseTo(0.5, 10);
    expect(mid.position.y).toBeCloseTo(0.45, 10);
  });

  it('mezipoloha nesedí na mřížce — jinak by to bylo dnešní skákání', () => {
    const before = entity();
    const after = moved(before, 1, 0);

    for (const alpha of [0.25, 0.5, 0.75]) {
      const [mid] = interpolateEntities([before], [after], alpha);

      expect(mid.position.x).not.toBe(before.position.x);
      expect(mid.position.x).not.toBe(after.position.x);
    }
  });

  it('dopočítává všechny tři osy, ne jen rovinu mřížky', () => {
    const before = entity({ position: { x: 0, y: 0, z: 0 } });
    const after = entity({ position: { x: 2, y: 4, z: -6 } });

    const [mid] = interpolateEntities([before], [after], 0.5);

    expect(mid.position).toEqual({ x: 1, y: 2, z: -3 });
  });

  it('roste jednosměrně: čím dál v tiku, tím blíž k novější poloze', () => {
    const before = entity();
    const after = moved(before, 1, 0);

    const xs = [0.1, 0.3, 0.6, 0.9].map(
      (alpha) => interpolateEntities([before], [after], alpha)[0].position.x,
    );

    expect(xs).toEqual([...xs].sort((a, b) => a - b));
  });
});

describe('krajní hodnoty vracejí přesný tik', () => {
  it('na začátku tiku je to starší projekce beze změny', () => {
    const before = [entity()];
    const after = [moved(before[0], 1, 1)];

    expect(interpolateEntities(before, after, 0)).toBe(before);
  });

  it('na konci tiku je to novější projekce beze změny', () => {
    const before = [entity()];
    const after = [moved(before[0], 1, 1)];

    expect(interpolateEntities(before, after, 1)).toBe(after);
  });

  it('záporný zlomek i NaN znamenají, že ještě nic neuběhlo', () => {
    const before = [entity()];
    const after = [moved(before[0], 3, 3)];

    expect(interpolateEntities(before, after, -0.5)).toBe(before);
    expect(interpolateEntities(before, after, Number.NaN)).toBe(before);
  });

  it('tik, ve kterém se nikdo nehnul, vrací starší projekci beze změny', () => {
    // Vykreslení na tom pozná, že matice přepisovat nemusí. Ve zmrazených
    // světech je takových tiků většina — postavou hýbe jen `moveTo`.
    const before = [entity({ stableId: 'gate', visual: 'gate', state: 'shut', locked: true })];
    const after = [{ ...before[0], state: 'open', locked: false }];

    expect(interpolateEntities(before, after, 0.5)).toBe(before);
  });

  it('ale jakmile se někdo hne, dopočítává se dál', () => {
    const before = [entity(), entity({ stableId: 'coin', visual: 'collectible' })];
    const after = [before[0], moved(before[1], 1, 0)];

    const out = interpolateEntities(before, after, 0.5);

    expect(out).not.toBe(before);
    expect(out[1].position.x).toBeCloseTo(0.5, 10);
  });

  it('dohraný svět má obě projekce tytéž a dopočet je nulový', () => {
    // Po výhře se svět nemění, ale snímky běží dál a zlomek tiku se dál houpe.
    // Kdyby se z něj něco počítalo, postava by mezi posledními dvěma poli kmitala.
    const frozen = [entity()];

    expect(interpolateEntities(frozen, frozen, 0.5)).toBe(frozen);
    expect(interpolateEntities(frozen, frozen, 0.9)).toBe(frozen);
  });

  it('zlomek nad jedničkou nepřestřelí za novější polohu', () => {
    const before = [entity()];
    const after = [moved(before[0], 1, 0)];

    expect(interpolateEntities(before, after, 2)).toBe(after);
  });
});

/**
 * Postava se v obou případech **musí hýbat**: tik, ve kterém nikdo neušel ani
 * krok, se dopočítávat nemá a vrací starší projekci celou. Bez pohybu vedle by
 * obě zkoušky měřily tu zkratku, ne pravidlo o nespojitých údajích — naměřeno
 * mutací 27. 8. 2026, která tudy prošla zeleně.
 */
describe('nespojité údaje se berou ze staršího tiku', () => {
  it('sebraná mince zmizí až na konci tiku, ne zatímco k ní postava klouže', () => {
    const hero = entity();
    const coin = entity({ stableId: 'coin', visual: 'collectible', active: true });
    const before = [hero, coin];
    const after = [moved(hero, 1, 0), { ...coin, active: false }];

    expect(interpolateEntities(before, after, 0.5)[1].active).toBe(true);
    expect(interpolateEntities(before, after, 1)[1].active).toBe(false);
  });

  it('stav a zámek jdou taky ze staršího tiku, aby zpoždění bylo jednotné', () => {
    const hero = entity();
    const gate = entity({ stableId: 'gate', visual: 'gate', state: 'shut', locked: true });
    const before = [hero, gate];
    const after = [moved(hero, 1, 0), { ...gate, state: 'open', locked: false }];

    const mid = interpolateEntities(before, after, 0.5)[1];

    expect(mid.state).toBe('shut');
    expect(mid.locked).toBe(true);
  });
});

describe('spojení dvou projekcí', () => {
  it('drží pořadí a délku podle novější projekce', () => {
    const hero = entity();
    const coin = entity({ stableId: 'coin', visual: 'collectible' });

    const out = interpolateEntities([coin, hero], [hero, coin], 0.5);

    expect(out.map((each) => each.stableId)).toEqual(['hero', 'coin']);
  });

  it('entitu, kterou starší tik nezná, kreslí rovnou na její místo', () => {
    // Přiletět odněkud, kde nikdy nebyla, je horší vada než objevit se o tik dřív.
    const hero = entity();
    const fresh = entity({ stableId: 'spawned', position: { x: 5, y: 0.45, z: 5 } });

    const out = interpolateEntities([hero], [hero, fresh], 0.5);

    expect(out[1]).toBe(fresh);
  });

  it('nemění vstupní projekce', () => {
    const before = [entity()];
    const after = [moved(before[0], 1, 1)];
    const beforeCopy = structuredClone(before);
    const afterCopy = structuredClone(after);

    interpolateEntities(before, after, 0.5);

    expect(before).toEqual(beforeCopy);
    expect(after).toEqual(afterCopy);
  });
});

/**
 * Věta záměrně **není** ve zmrazeném korpusu — doslovná shoda by šla jinou
 * cestou. Tvar `keys-to-door` dá svět, ve kterém se postava opravdu hýbe, takže
 * mezi dvěma tiky je co dopočítávat.
 */
const SENTENCE = 'a quiet cellar with three keys and a locked exit door';

function room(): WorldDocRuntime {
  const emission = recognize(SENTENCE) as { sim: unknown } | null;
  if (emission === null) throw new Error('rozpoznávač větu nezná');
  const built = buildRuntimeWorld(emission.sim);
  if (!built.ok) throw new Error(`svět se nepostavil: ${built.issues.join('; ')}`);
  return built.world;
}

function inputsAt(world: WorldDocRuntime, tick: number) {
  return world.trace.filter((input) => input.tick === tick);
}

describe('hashovaný stav dopočet nevidí', () => {
  it('hash se nehne, ať se mezi dvěma tiky dopočítá kolikrát chce', () => {
    const world = room();
    const runtime = createRuntime(world);

    let before = projectEntities(world, entityPlacements(runtime));
    for (let tick = 0; tick < 40; tick += 1) {
      step(runtime, inputsAt(world, tick));
      const after = projectEntities(world, entityPlacements(runtime));
      const sealed = hashHex(runtime.state);

      // Tolik dopočtů, kolik jich při 60 snímcích za sekundu na jeden tik vyjde.
      for (const alpha of [0, 0.33, 0.66, 1]) interpolateEntities(before, after, alpha);

      expect(hashHex(runtime.state)).toBe(sealed);
      before = after;
    }
  });

  it('běh s dopočtem doběhne do téhož hashe jako běh bez něj', () => {
    const plainWorld = room();
    const plain = createRuntime(plainWorld);
    const world = room();
    const drawn = createRuntime(world);

    let before = projectEntities(world, entityPlacements(drawn));
    for (let tick = 0; tick < 60; tick += 1) {
      step(plain, inputsAt(plainWorld, tick));
      step(drawn, inputsAt(world, tick));
      const after = projectEntities(world, entityPlacements(drawn));
      interpolateEntities(before, after, 0.5);
      before = after;
    }

    expect(hashHex(drawn.state)).toBe(hashHex(plain.state));
  });

  it('svět se během měření opravdu hýbe — jinak by test netvrdil nic', () => {
    const world = room();
    const runtime = createRuntime(world);
    const start = projectEntities(world, entityPlacements(runtime));

    for (let tick = 0; tick < 40; tick += 1) step(runtime, inputsAt(world, tick));
    const end = projectEntities(world, entityPlacements(runtime));

    const shifted = end.filter((each, index) => {
      const from = start[index].position;
      return each.position.x !== from.x || each.position.z !== from.z;
    });

    expect(shifted.length).toBeGreaterThan(0);
  });
});
