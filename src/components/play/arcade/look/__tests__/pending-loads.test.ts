/**
 * Rozjetá načítání modelů (T13a): výměna scény kola řetězu na ně čeká (`DrawWhenCompiled`). Kdyby počet nesouhlasil,
 * kreslilo by se dřív, než model dorazí, a jeho materiály by se přeložily v prvním snímku po příchodu – obraz to nepozná.
 */
import { describe, expect, it } from 'vitest';

import { loadsPending, loadsSettled, trackLoad } from '../pending-loads';

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
