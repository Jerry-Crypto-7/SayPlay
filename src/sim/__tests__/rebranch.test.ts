import { readFileSync, readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createRuntime, run, step, type Runtime, type WorldDocRuntime } from '../interpreter';
import { hashHex } from '../hash';
import { rebranchAt } from '../rebranch';
import { advance, createTimeline, seekTo } from '../timeline';

import { oscillator } from '../__fixtures__/oscillator';
import stateCycleWorld from '../__fixtures__/state-cycle.world.json';
import vaultWorld from '../__fixtures__/vault.world.json';

const stateCycle = stateCycleWorld as unknown as WorldDocRuntime;
const vault = vaultWorld as unknown as WorldDocRuntime;

/** Týž svět bez jednoho pravidla — legální změna, kterou tvar světa nepocítí. */
function withoutFirstRule(doc: WorldDocRuntime): WorldDocRuntime {
  return { ...doc, ir: { ...doc.ir, rules: doc.ir.rules.slice(1) } };
}

const BRANCH = 40;
const HORIZON = 200;
const CAPACITY = 64;

function inputsAt(doc: WorldDocRuntime, tick: number) {
  return doc.trace.filter((entry) => entry.tick === tick);
}

/** Postaví běh a odkrokuje ho po ose až na `tick`. */
function runOnTimeline(doc: WorldDocRuntime, tick: number) {
  const runtime = createRuntime(doc);
  const timeline = createTimeline(runtime, CAPACITY);
  for (let i = 0; i < tick; i += 1) advance(timeline, runtime, inputsAt(doc, runtime.tick));
  return { runtime, timeline };
}

function runTo(runtime: Runtime, doc: WorldDocRuntime, tick: number): void {
  while (runtime.tick < tick && runtime.runState === 'running') {
    step(runtime, inputsAt(doc, runtime.tick));
  }
}

describe('změna pravidla v minulosti', () => {
  /**
   * Jádro AC úlohy T17, obě aserce v jednom testu.
   *
   * Referenční větev je napsaná **v testu a bez přetáčení**: běh dojde dopředu na
   * tik větvení, tam se stav ručně přesadí do runtimu nad novým dokumentem a
   * pokračuje. Kdyby se reference brala z `rebranchAt`, testovala by se shoda
   * funkce se sebou samou; takhle test říká nezávisle, co přesazení znamená, a
   * rozejde se s ním, jakmile `rebranchAt` přesadí něco jiného.
   */
  it('dá tutéž budoucnost jako změna aplikovaná dopředu, a jinou než původní běh', () => {
    const base = oscillator();
    const changed = oscillator({ ebCounts: false });

    // A — původní běh bez jakékoli změny.
    const straight = createRuntime(base);
    run(straight, HORIZON);
    const original = hashHex(straight.state);
    expect(straight.tick).toBe(HORIZON);

    // B — doběhnout na horizont, PŘETOČIT na tik větvení, změnit pravidlo, doběhnout znovu.
    const far = runOnTimeline(base, HORIZON);
    const rewound = rebranchAt(far.timeline, far.runtime, BRANCH, changed);
    expect(rewound.verdict).toBe('REBRANCHED');
    if (rewound.verdict !== 'REBRANCHED') return;
    runTo(rewound.runtime, changed, HORIZON);

    // C — dopředu na tik větvení, tam přesadit ručně, dál na horizont. Bez přetáčení.
    const near = createRuntime(base);
    runTo(near, base, BRANCH);
    expect(near.tick).toBe(BRANCH);
    const forward = createRuntime(changed);
    forward.state.set(near.state);
    forward.tick = near.tick;
    forward.runState = near.runState;
    forward.fault = near.fault;
    forward.drainQueue = near.drainQueue.slice();
    forward.previous = near.previous;
    runTo(forward, changed, HORIZON);

    expect(rewound.runtime.tick).toBe(HORIZON);
    expect(forward.tick).toBe(HORIZON);

    // Změna se do budoucnosti propsala…
    expect(hashHex(rewound.runtime.state)).not.toBe(original);
    // …a přetočení o ni nepřipravilo ani nic nepřidalo.
    expect(hashHex(rewound.runtime.state)).toBe(hashHex(forward.state));
  });

  /**
   * Přesazení po jednotlivých polích, ne přes shodu budoucností.
   *
   * Zapomenuté pole se ve srovnání dvou větví neprojeví — obě větve ho zapomenou
   * stejně a hashe si budou sedět. Proto se každé pole tvrdí zvlášť.
   */
  it('přesadí celý stav větvicího tiku, ne jen zabalená čísla', () => {
    const base = oscillator();
    const far = runOnTimeline(base, HORIZON);

    const at = createRuntime(base);
    runTo(at, base, BRANCH);

    const result = rebranchAt(far.timeline, far.runtime, BRANCH, oscillator({ ebCounts: false }));
    expect(result.verdict).toBe('REBRANCHED');
    if (result.verdict !== 'REBRANCHED') return;

    expect(result.tick).toBe(BRANCH);
    expect(result.runtime.tick).toBe(BRANCH);
    expect(hashHex(result.runtime.state)).toBe(hashHex(at.state));
    expect(result.runtime.runState).toBe(at.runState);
    expect(result.runtime.fault).toBe(at.fault);
    expect([...result.runtime.drainQueue]).toEqual([...at.drainQueue]);
    expect([...result.runtime.previous.facts]).toEqual([...at.previous.facts]);
    expect([...result.runtime.previous.pulses]).toEqual([...at.previous.pulses]);
    expect(result.runtime.previous.counters).toEqual(at.previous.counters);

    // Nová větev běží podle NOVÉHO dokumentu, ne podle toho, ze kterého přišel stav.
    expect(result.runtime.doc.ir.rules).toEqual(oscillator({ ebCounts: false }).ir.rules);
  });

  /**
   * Fronta je na sudém tiku prázdná, takže aserce nad ní by v tiku 40 nechránila
   * nic — dvě prázdná pole si sednou i tehdy, když se fronta nepřesazuje vůbec.
   * Větvení na lichém tiku je jediné, kde to jde změřit.
   */
  it('přesadí i frontu událostí, ne jen stav a čas', () => {
    const base = oscillator();
    const odd = BRANCH + 1;
    const far = runOnTimeline(base, HORIZON);

    const at = createRuntime(base);
    runTo(at, base, odd);
    expect(at.drainQueue.length).toBeGreaterThan(0);

    const result = rebranchAt(far.timeline, far.runtime, odd, oscillator({ ebCounts: false }));
    expect(result.verdict).toBe('REBRANCHED');
    if (result.verdict !== 'REBRANCHED') return;
    expect([...result.runtime.drainQueue]).toEqual([...at.drainQueue]);
    // A musí to být VLASTNÍ pole. `step` do fronty zapisuje na místě
    // (`runtime.drainQueue.push` v interpretu), takže sdílené pole znamená, že
    // vstup doručený jedné větvi se objeví i ve frontě té druhé.
    expect(result.runtime.drainQueue).not.toBe(far.runtime.drainQueue);
  });

  /**
   * Konec běhu je stav, ne jen hodnota polí. Větev, která ho zapomene, ožije
   * uprostřed dohraného světa — `createRuntime` totiž začíná v `running`.
   */
  it('přesadí i konec běhu, když se odbočuje v dohraném světě', () => {
    const runtime = createRuntime(vault);
    run(runtime, 40);
    expect(runtime.runState).toBe('won');
    const timeline = createTimeline(runtime, CAPACITY);

    const result = rebranchAt(timeline, runtime, runtime.tick, withoutFirstRule(vault));
    expect(result.verdict).toBe('REBRANCHED');
    if (result.verdict !== 'REBRANCHED') return;
    expect(result.runtime.runState).toBe('won');
  });

  /**
   * Totéž pro atomicky přerušený tik. Do snímku se fault nikdy nedostane — tik,
   * který spadl, runtimem nepohnul, takže se nezapisuje — ale **kotva** ho nese,
   * když osa vznikne nad už spadlým během.
   */
  it('přesadí i důvod pádu, když osa vznikla nad spadlým během', () => {
    const runtime = createRuntime(stateCycle);
    step(runtime, []);
    expect(runtime.runState).toBe('runtimeFault');
    expect(runtime.fault).not.toBeNull();
    const timeline = createTimeline(runtime, CAPACITY);

    const result = rebranchAt(timeline, runtime, runtime.tick, withoutFirstRule(stateCycle));
    expect(result.verdict).toBe('REBRANCHED');
    if (result.verdict !== 'REBRANCHED') return;
    expect(result.runtime.runState).toBe('runtimeFault');
    expect(result.runtime.fault).toBe(runtime.fault);
  });

  /** Osa vrací vlastní kotvu, takže nová větev nedědí minulost té staré. */
  it('vrátí osu kotvenou v tiku větvení', () => {
    const base = oscillator();
    const far = runOnTimeline(base, HORIZON);
    const result = rebranchAt(far.timeline, far.runtime, BRANCH, oscillator({ ebCounts: false }));
    expect(result.verdict).toBe('REBRANCHED');
    if (result.verdict !== 'REBRANCHED') return;

    expect(result.timeline.anchor.tick).toBe(BRANCH);
    expect(result.timeline.capacity).toBe(CAPACITY);
    expect(seekTo(result.timeline, result.runtime, 0)).toBe(BRANCH);
  });
});

describe('co se z prostředka větvit nedá', () => {
  /**
   * Dopředu osa dojde vždycky, takže nedosažitelný je jen tik **před kotvou** —
   * minulost, kterou nikdo nezaznamenal. Odbočit v ní by znamenalo vymyslet si
   * stav, který svět nikdy neměl.
   */
  it('odmítne tik před kotvou osy', () => {
    const base = oscillator();
    const runtime = createRuntime(base);
    runTo(runtime, base, 10);
    const timeline = createTimeline(runtime, CAPACITY);

    const result = rebranchAt(timeline, runtime, 3, oscillator({ ebCounts: false }));
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.reason).toBe('TICK_UNREACHABLE');
    expect(result.detail).toContain('reaches 10');
  });

  /**
   * Změna počáteční hodnoty je změna tiku nula. Z tiku 40 se na ni odbočit nedá
   * a tiše ji ignorovat by znamenalo tvrdit, že se přijala.
   */
  it('odmítne změnu počáteční hodnoty slotu', () => {
    const base = oscillator();
    const far = runOnTimeline(base, HORIZON);
    const moved = structuredClone(oscillator()) as {
      ir: { slots: { initial: number }[] };
    } & WorldDocRuntime;
    moved.ir.slots[0].initial = 5;

    const result = rebranchAt(far.timeline, far.runtime, BRANCH, moved);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.reason).toBe('SHAPE_CHANGED');
    expect(result.detail).toContain('initial value');
  });

  /**
   * Táž vada o patro níž — u slotu, ne u entity. Hodnota `empty` zůstává na
   * indexu nula, takže se meze ani počáteční hodnota nehnou a kontrola
   * rozvržení projde; chytit to musí kontrola tabulek symbolů.
   */
  it('odmítne přejmenovanou hodnotu inventáře, kterou rozvržení nevidí', () => {
    const base = oscillator({ carriesItem: true });
    const far = runOnTimeline(base, HORIZON);

    const result = rebranchAt(
      far.timeline,
      far.runtime,
      BRANCH,
      oscillator({ carriesItem: true, itemName: 'gem' }),
    );
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.reason).toBe('SHAPE_CHANGED');
    expect(result.detail).toContain('slot symbols');
  });

  it('odmítne přejmenované stavy entity, i když se meze slotu nezměnily', () => {
    const base = oscillator();
    const far = runOnTimeline(base, HORIZON);
    const swapped = structuredClone(oscillator()) as {
      ir: { entities: { states: string[]; initialState: string }[] };
    } & WorldDocRuntime;
    swapped.ir.entities[0].states = ['s2', 's1'];
    swapped.ir.entities[0].initialState = 's2';

    const result = rebranchAt(far.timeline, far.runtime, BRANCH, swapped);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.reason).toBe('SHAPE_CHANGED');
    expect(result.detail).toContain('reordered');
  });

  /**
   * Zóna je jediná část prostoru, kterou rozvržení stavu **nevidí** — souřadnice
   * entit se do slotů sázejí ze socketů, kdežto zóna je jen obdélník, proti
   * kterému se každý tik počítá `inZone`. Posunutá zóna proto projde kontrolou
   * slotů a zastaví ji až kontrola prostoru; kdyby ta chyběla, pozorování
   * z minulého tiku by popisovalo jinou místnost a nikdo by se to nedozvěděl.
   */
  it('odmítne posunutou zónu, kterou kontrola slotů nevidí', () => {
    const base = oscillator();
    const far = runOnTimeline(base, HORIZON);
    const rezoned = structuredClone(oscillator()) as {
      space: { zones: Record<string, readonly [number, number, number, number]> };
    } & WorldDocRuntime;
    rezoned.space.zones.hall = [0, 0, 2, 2];

    const result = rebranchAt(far.timeline, far.runtime, BRANCH, rezoned);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.reason).toBe('SHAPE_CHANGED');
    expect(result.detail).toContain('zones');
  });

  /** Přesunutý socket se ohlásí dřív: souřadnice entity je slot a její počáteční hodnota se hnula. */
  it('odmítne přesunutý socket už na rozvržení stavu', () => {
    const base = oscillator();
    const far = runOnTimeline(base, HORIZON);
    const moved = structuredClone(oscillator()) as {
      space: { sockets: Record<string, readonly [number, number]> };
    } & WorldDocRuntime;
    moved.space.sockets.s_a = [3, 3];

    const result = rebranchAt(far.timeline, far.runtime, BRANCH, moved);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.reason).toBe('SHAPE_CHANGED');
    expect(result.detail).toContain('e:ea:x');
  });

  /**
   * Socket, na kterém nesedí žádná entita, rozvržení stavu **nevidí** — a přesto
   * ho každý `spawn` a každý `moveTo` čte, když spustí. Posunout ho tedy znamená,
   * že se tatáž cílová souřadnice zapsaná do slotu `moveTo` odkazuje jinam, aniž
   * se v zabaleném stavu cokoli hne. Předchozí test to nedokáže: tam se hýbe
   * socket obsazený entitou, kde počáteční hodnota slotu `e:ea:x` bije první.
   */
  it('odmítne posunutý socket, na kterém nesedí entita', () => {
    const base = oscillator({ spareSocket: true });
    const far = runOnTimeline(base, HORIZON);
    const moved = structuredClone(oscillator({ spareSocket: true })) as {
      space: { sockets: Record<string, readonly [number, number]> };
    } & WorldDocRuntime;
    moved.space.sockets.s_spare = [3, 3];

    const result = rebranchAt(far.timeline, far.runtime, BRANCH, moved);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.reason).toBe('SHAPE_CHANGED');
    expect(result.detail).toContain('sockets');
  });

  /**
   * Neprůchozí buňky se do stavu nezapisují vůbec — čte je `isBlocked` ve fázi
   * sense, tedy každý tik znovu z dokumentu. Zazděná buňka proto projde jak
   * kontrolou slotů, tak kontrolou symbolů, a přeruší výhled, o kterém minulost
   * ještě předpokládá, že je volný.
   */
  it('odmítne zazděnou buňku, kterou stav vůbec nenese', () => {
    const base = oscillator();
    const far = runOnTimeline(base, HORIZON);
    const walled = structuredClone(oscillator()) as {
      space: { blocked: [number, number][] };
    } & WorldDocRuntime;
    walled.space.blocked.push([2, 2]);

    const result = rebranchAt(far.timeline, far.runtime, BRANCH, walled);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.reason).toBe('SHAPE_CHANGED');
    expect(result.detail).toContain('blocked');
  });

  /**
   * Značka entity je její jméno v poolu: `spawn` podle ní vybírá, koho oživit,
   * a sčítání v zóně podle ní klíčuje. Přeznačená entita tedy mění, kdo se
   * z poolu vynoří a do kterého součtu se počítá — a v zabaleném stavu po tom
   * není ani stopa.
   */
  it('odmítne přeznačenou entitu, kterou pool a součty v zóně čtou z dokumentu', () => {
    const base = oscillator();
    const far = runOnTimeline(base, HORIZON);
    const retagged = structuredClone(oscillator()) as {
      space: { tags: Record<string, string> };
    } & WorldDocRuntime;
    retagged.space.tags.ea = 'guard';

    const result = rebranchAt(far.timeline, far.runtime, BRANCH, retagged);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.reason).toBe('SHAPE_CHANGED');
    expect(result.detail).toContain('tags');
  });

  it('odmítne přidaný slot — zabalený stav by se rozjel o pole', () => {
    const base = oscillator();
    const far = runOnTimeline(base, HORIZON);
    const wider = structuredClone(oscillator()) as {
      ir: { slots: unknown[] };
    } & WorldDocRuntime;
    wider.ir.slots.push({ space: 'flag', id: 'extra', initial: false });

    const result = rebranchAt(far.timeline, far.runtime, BRANCH, wider);
    expect(result.verdict).toBe('REJECTED');
    if (result.verdict !== 'REJECTED') return;
    expect(result.reason).toBe('SHAPE_CHANGED');
    expect(result.detail).toContain('slot count');
  });

  /**
   * **Zamítnutá větev nesmí hnout světem** (P15 T24).
   *
   * Od chvíle, kdy osu drží produkt a ne technický panel, je zamítnutí běžný
   * výsledek porotcovy druhé věty. Do T24 se runtime přetáčel **první** a
   * kontrola tvaru běžela až po něm, takže odmítnutá změna nechala svět stát
   * o sto šedesát tiků v minulosti — pohyb, o který nikdo nepožádal a který
   * žádné hlášení nedoprovodilo.
   *
   * Měří se tik **i** hash: samotný tik by prošel i tehdy, kdyby se stav cestou
   * přepsal a jen číslo tiku se vrátilo.
   */
  it('nechá svět tam, kde stál, když změnu odmítne', () => {
    const base = oscillator();
    const far = runOnTimeline(base, HORIZON);
    const before = { tick: far.runtime.tick, hash: hashHex(far.runtime.state) };

    const moved = structuredClone(oscillator()) as {
      ir: { slots: { initial: number }[] };
    } & WorldDocRuntime;
    moved.ir.slots[0].initial = 5;

    expect(rebranchAt(far.timeline, far.runtime, BRANCH, moved).verdict).toBe('REJECTED');
    expect(far.runtime.tick).toBe(before.tick);
    expect(hashHex(far.runtime.state)).toBe(before.hash);

    // Protipól: legální změna se přetočit **musí**, jinak by tenhle test šel
    // splnit tím, že rebranch přestane přetáčet úplně.
    const accepted = rebranchAt(far.timeline, far.runtime, BRANCH, withoutFirstRule(base));
    expect(accepted.verdict).toBe('REBRANCHED');
    expect(far.runtime.tick).toBe(BRANCH);
  });
});

/**
 * **Nástěnný čas na replay cestě** (`CLAUDE.md`, Determinismus).
 *
 * `Date.now()`, `performance.now()` a skutečný `requestAnimationFrame` dělají
 * z běhu něco, co se podruhé odehraje jinak — a vada se neprojeví výjimkou,
 * projeví se tím, že se hash v prohlížeči rozejde s hashem v Node. Tohle je
 * proto lexikální zeď, ne behaviorální test: chytá **zápis**, ne jeho následek,
 * protože následek je vidět až na stroji s jinou rychlostí.
 *
 * Rozsah je celý `src/sim`. Osa, která ho ovládala (`TimeAxis.tsx`), odešla
 * se starým studiem (P44D T5), stejně jako hodiny, větve a vstup (P44D T7) –
 * proto spodní mez osm modulů.
 */
describe('replay cesta nesmí sáhnout na nástěnný čas', () => {
  const GUARDED = readdirSync(resolve(import.meta.dirname, '..'))
    .filter((name) => name.endsWith('.ts'))
    .map((name) => resolve(import.meta.dirname, '..', name));

  /** Zdroj bez komentářů — jinak by zeď spadla na větě, která ji vysvětluje. */
  function code(path: string): string {
    return readFileSync(path, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/\/\/.*$/gm, '');
  }

  it('nemá kde vzít wall-clock', () => {
    expect(GUARDED.length).toBeGreaterThanOrEqual(8);
    const guilty = GUARDED.filter((path) =>
      /\bDate\.now\b|\bperformance\.now\b|\brequestAnimationFrame\b/.test(code(path)),
    ).map((path) => basename(path));
    expect(guilty).toEqual([]);
  });
});
