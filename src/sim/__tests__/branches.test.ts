import { describe, expect, it } from 'vitest';

import { createBranchStore } from '../branches';
import { hashHex } from '../hash';
import { createRuntime, step, type WorldDocRuntime } from '../interpreter';
import { rebranchAt } from '../rebranch';
import { advance, createTimeline } from '../timeline';

import { oscillator } from '../__fixtures__/oscillator';

const CAPACITY = 64;
const BRANCH = 40;
const HORIZON = 200;

function inputsAt(doc: WorldDocRuntime, tick: number) {
  return doc.trace.filter((entry) => entry.tick === tick);
}

/** Běh odkrokovaný **po ose**, tedy se snímky, ze kterých se dá přetočit zpět. */
function runOnTimeline(doc: WorldDocRuntime, tick: number) {
  const runtime = createRuntime(doc);
  const timeline = createTimeline(runtime, CAPACITY);
  while (runtime.tick < tick && runtime.runState === 'running') {
    advance(timeline, runtime, inputsAt(doc, runtime.tick));
  }
  return { runtime, timeline };
}

function storeAt(doc: WorldDocRuntime, tick: number) {
  const { runtime, timeline } = runOnTimeline(doc, tick);
  return { store: createBranchStore({ doc, runtime, timeline }), runtime, timeline };
}

describe('úložiště větví', () => {
  it('začíná kořenem, který ještě nic nezapečetil', () => {
    const { store } = storeAt(oscillator(), 0);

    expect(store.list()).toHaveLength(1);
    const [root] = store.list();
    expect(root.id).toBe('origin');
    expect(root.parentId).toBeNull();
    expect(root.atTick).toBe(0);
    expect(root.ruleId).toBeNull();
    // Nezapečetěná větev o svém konci **mlčí**. Kdyby nesla hash tiku nula,
    // panel by dvě větve prohlásil za různé dřív, než jedna z nich doběhla.
    expect(root.tick).toBe(-1);
    expect(root.hash).toBe('');
  });

  it('zapečetí aktivní větev tam, kde právě stojí', () => {
    const { store, runtime } = storeAt(oscillator(), HORIZON);
    store.seal();

    expect(store.view('origin')).toEqual({
      id: 'origin',
      parentId: null,
      atTick: 0,
      ruleId: null,
      tick: HORIZON,
      hash: hashHex(runtime.state),
    });
  });

  it('založená větev se stane aktivní a nese, odkud a proč vznikla', () => {
    const base = oscillator();
    const changed = oscillator({ ebCounts: false });
    const { store, runtime, timeline } = storeAt(base, HORIZON);
    store.seal();

    const result = rebranchAt(timeline, runtime, BRANCH, changed);
    expect(result.verdict).toBe('REBRANCHED');
    if (result.verdict !== 'REBRANCHED') return;

    const opened = store.open({
      parentId: 'origin',
      atTick: BRANCH,
      ruleId: 'r.eb.up',
      doc: changed,
      runtime: result.runtime,
      timeline: result.timeline,
    });

    // Odbočka, po které se dál krokuje ta stará větev, je vada, kterou by nikdo
    // neviděl — proto zakládání přepíná.
    expect(store.active().id).toBe(opened.id);
    expect(store.list()).toHaveLength(2);
    expect(store.view(opened.id)).toMatchObject({
      parentId: 'origin',
      atTick: BRANCH,
      ruleId: 'r.eb.up',
      tick: -1,
      hash: '',
    });

    expect(store.switchTo('origin')).toBe(true);
    expect(store.active().id).toBe('origin');
  });

  it('neznámé id nepřepne a přizná to', () => {
    const { store } = storeAt(oscillator(), 0);
    expect(store.switchTo('branch-7')).toBe(false);
    expect(store.active().id).toBe('origin');
  });
});

/**
 * **Jádro úlohy T38.** Pečeť je `runtime.state.slice()`, tedy vlastní pole.
 *
 * Nahradit ten `slice()` odkazem je jednoslovná změna, po které všechno dál
 * funguje: strom se vykreslí, uzly se přepínají, panel nic nenahlásí. Rozejde se
 * jenom to jediné, kvůli čemu úložiště existuje — hash větve začne popisovat
 * tik, na kterém runtime **právě stojí**, ne ten, na kterém větev dopadla.
 *
 * **Ten mutant přežije všechno ostatní — naměřeno 3. 9. 2026.** Obě e2e sady i
 * druhý test níž nad ním zůstanou zelené, protože `restore` v `timeline.ts:82`
 * dělá `runtime.state = snapshot.state.slice()`: přetáčení pole **vymění**,
 * takže zapečetěné pole osiří a náhodou zůstane platné. Jediné, co mělkou pečeť
 * doopravdy chytí, je proto první test — krokování **na místě**, bez přetáčení.
 */
describe('pečeť je hluboká kopie, ne okno do živého runtimu', () => {
  it('krokování runtimu po zapečetění hashem větve nehne', () => {
    const base = oscillator();
    const { store, runtime, timeline } = storeAt(base, BRANCH);
    store.seal();
    const sealed = store.view('origin')!;

    for (let i = 0; i < 20; i += 1) advance(timeline, runtime, inputsAt(base, runtime.tick));

    // Mutace byla skutečná — jinak by aserce níž nechránila nic.
    expect(hashHex(runtime.state)).not.toBe(sealed.hash);
    expect(store.view('origin')).toEqual(sealed);
  });

  /**
   * Produktová podoba téhož slibu: zapečetěná budoucnost origin větve musí
   * přežít okamžik, kdy z ní někdo odbočí — což je jediný okamžik, kdy jsou dvě
   * budoucnosti k porovnání.
   *
   * **Není to druhý oracle mělké pečeti**, viz komentář nad blokem: přetáčení
   * pole vyměňuje, takže odkaz by tady prošel. Tenhle test hlídá jinou vadu —
   * pečeť, která se při odbočení zahodí, přepíše nebo přepočítá ze živého stavu.
   */
  it('odbočení, které rodičovský runtime přetočí do minulosti, jeho pečeť nezmění', () => {
    const base = oscillator();
    const { store, runtime, timeline } = storeAt(base, HORIZON);

    // Referenční běh **bez osy a bez úložiště** — dopředu, jednou, nikdy
    // přetočený. Bez něj by se dole srovnávala pečeť sama se sebou.
    const independent = createRuntime(base);
    while (independent.tick < HORIZON && independent.runState === 'running') {
      step(independent, inputsAt(base, independent.tick));
    }

    store.seal();
    const atHorizon = store.view('origin')!;
    expect(atHorizon.tick).toBe(HORIZON);

    const result = rebranchAt(timeline, runtime, BRANCH, oscillator({ ebCounts: false }));
    expect(result.verdict).toBe('REBRANCHED');
    if (result.verdict !== 'REBRANCHED') return;
    // Přetočení se opravdu stalo, takže živý stav origin větve už je jinde.
    expect(runtime.tick).toBe(BRANCH);
    expect(hashHex(runtime.state)).not.toBe(atHorizon.hash);

    store.open({
      parentId: 'origin',
      atTick: BRANCH,
      ruleId: 'r.eb.up',
      doc: oscillator({ ebCounts: false }),
      runtime: result.runtime,
      timeline: result.timeline,
    });

    expect(store.view('origin')).toEqual(atHorizon);
    // A ta pečeť pořád popisuje běh, který si svět odžil — ne jen sama sebe.
    expect(atHorizon.hash).toBe(hashHex(independent.state));
  });
});
