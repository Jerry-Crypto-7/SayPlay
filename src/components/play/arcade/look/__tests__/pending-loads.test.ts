/**
 * Rozjetá načítání modelů (T13a): výměna scény kola řetězu na ně čeká (`DrawWhenCompiled`). Kdyby počet nesouhlasil,
 * kreslilo by se dřív, než model dorazí, a jeho materiály by se přeložily v prvním snímku po příchodu – obraz to nepozná.
 */
import { describe, expect, it } from 'vitest';

import { afterBodies, loadsPending, loadsSettled, trackBody, trackLoad } from '../pending-loads';

function later<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (error: Error) => void } {
  let resolve = (_value: T): void => undefined;
  let reject = (_error: Error): void => undefined;
  const promise = new Promise<T>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

describe('pending model loads', () => {
  it('counts loads in flight and settles once all of them finished, failed ones too', async () => {
    const model = later<string>();
    const rig = later<string>();
    expect(trackLoad(model.promise)).toBe(model.promise);
    trackLoad(rig.promise).catch(() => undefined);
    expect(loadsPending()).toBe(2);
    let settled = false;
    void loadsSettled().then(() => {
      settled = true;
    });
    model.resolve('ogre');
    await model.promise;
    expect(loadsPending()).toBe(1);
    expect(settled).toBe(false);
    rig.reject(new Error('404'));
    await loadsSettled();
    expect(settled).toBe(true);
    expect(loadsPending()).toBe(0);
  });
});

/**
 * Těla před kulisami (P62 T11): kdyby kulisa nečekala, hrad v aréně rozbalí 27 modelů a rytíř přijde poslední –
 * hrdina stojí sekundy jako modrý kvádr a obraz za běhu vypadá jinak jen tím, že je pozdě.
 */
describe('bodies before scenery', () => {
  const tick = (): Promise<void> => new Promise((done) => setTimeout(done, 5));

  it('scenery asked for before the hero in the same task starts only after the hero is in', async () => {
    const order: string[] = [];
    // Scéna žádá podlahu a stěny dřív než těla: kulisa jde první, hrdina až za ní, v pozdějším efektu téže úlohy.
    const scenery = afterBodies().then(() => order.push('scenery'));
    const hero = later<string>();
    queueMicrotask(() => void trackBody(hero.promise).then(() => order.push('hero')));
    await tick();
    expect(loadsPending()).toBe(1);
    expect(order).toEqual([]);
    hero.resolve('knight');
    await scenery;
    expect(order).toEqual(['hero', 'scenery']);
    expect(loadsPending()).toBe(0);
  });

  it('a body that fails to load does not hold the scenery', async () => {
    const hero = later<string>();
    trackBody(hero.promise).catch(() => undefined);
    let started = false;
    const scenery = afterBodies().then(() => {
      started = true;
    });
    await tick();
    expect(started).toBe(false);
    hero.reject(new Error('404'));
    await scenery;
    expect(started).toBe(true);
  });
});
