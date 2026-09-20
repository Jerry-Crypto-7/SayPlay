/**
 * **Z neúplného kusu se nevydá nic.**
 *
 * To je celé tvrzení `partial-emission.ts` a je to tvrzení, které se nedá
 * ohlídat okem: rozepsaný objekt se dá doplnit na validní JSON s jinými čísly,
 * postaví se z něj předmět a ten se za vteřinu sám přepíše. Na snímku to
 * vypadá jako rychlejší svět.
 *
 * Test proto rozřeže archivovanou odpověď na **všechny** rostoucí předpony
 * a nad každou se ptá na tři věci: že vydané hodnoty jsou přesně ty, které jsou
 * v celé odpovědi (žádná „skoro" hodnota), že už vydaná hodnota se v delší
 * předponě nezmění, a že poslední předpona dá týž blueprint jako celá odpověď.
 *
 * Odpověď je výřez z `create-raw.json` (běh 6. 9. 2026, seed 4021, case c01).
 * Archiv je gitignorovaný, takže výřez v `__fixtures__` je jediné místo, kde
 * ta data přežijí čistý klon.
 */

import { describe, expect, it } from 'vitest';

import fixture from '../__fixtures__/archived-compiler-answer.json';
import { readPartialEmission, type StreamedItem } from '../partial-emission';
import { compileBlueprint } from '../worldstream-compiler';
import { readPlannerEmission } from '../worldstream-intent';

const ANSWER = fixture.answer as Record<string, unknown>;
const TEXT = JSON.stringify(ANSWER);

/** Klíč prvku, pod kterým se pozná napříč předponami. */
const keyOf = (item: StreamedItem): string => `${item.path}[${String(item.index)}]`;

/** Co v celé odpovědi na tom místě doopravdy stojí. */
function truthFor(item: StreamedItem): unknown {
  if (item.path === 'geometry.nodes')
    return ((ANSWER.geometry as Record<string, unknown>).nodes as unknown[])[item.index];
  return (ANSWER[item.path] as unknown[])[item.index];
}

describe('čtení rozepsané odpovědi kompilátoru', () => {
  it('nad každou předponou vydá jen hodnoty, které stojí i v celé odpovědi', () => {
    for (let cut = 0; cut <= TEXT.length; cut += 1) {
      const partial = readPartialEmission(TEXT.slice(0, cut));

      for (const [key, value] of Object.entries(partial.complete))
        expect(value, `předpona ${String(cut)}: pole ${key} se liší od celé odpovědi`).toEqual(ANSWER[key]);

      for (const item of partial.items)
        expect(item.value, `předpona ${String(cut)}: prvek ${keyOf(item)} se liší od celé odpovědi`).toEqual(
          truthFor(item),
        );
    }
  });

  it('co jednou vydá, to už nezmění ani nevezme zpět', () => {
    const seen = new Map<string, string>();
    let fields = new Map<string, string>();

    for (let cut = 0; cut <= TEXT.length; cut += 1) {
      const partial = readPartialEmission(TEXT.slice(0, cut));

      const now = new Map<string, string>();
      for (const [key, value] of Object.entries(partial.complete)) now.set(key, JSON.stringify(value));
      for (const [key, json] of fields)
        expect(now.get(key), `pole ${key} zmizelo nebo se změnilo na předponě ${String(cut)}`).toBe(json);
      fields = now;

      for (const item of partial.items) {
        const key = keyOf(item);
        const json = JSON.stringify(item.value);
        const before = seen.get(key);
        if (before !== undefined)
          expect(json, `prvek ${key} se na předponě ${String(cut)} přepsal`).toBe(before);
        seen.set(key, json);
      }
    }

    // Kdyby se nevydalo nic, obě smyčky výš by prošly prázdné.
    expect(seen.size, 'z celé odpovědi nevyšel ani jeden prvek').toBeGreaterThan(0);
  });

  it('rozepsaný poslední prvek nevydá, dokud ho model nedopíše', () => {
    const nodes = (ANSWER.geometry as Record<string, unknown>).nodes as unknown[];
    const firstNode = JSON.stringify(nodes[0]);
    const upToFirstNode = TEXT.indexOf(firstNode) + firstNode.length;

    // Uprostřed druhého uzlu: první je hotový, druhý ještě není.
    const middle = readPartialEmission(TEXT.slice(0, upToFirstNode + 10));
    const emitted = middle.items.filter((item) => item.path === 'geometry.nodes');

    expect(emitted.length, 'z rozepsaného uzlu se vydal objekt').toBe(1);
    expect(emitted[0].value).toEqual(nodes[0]);
  });

  it('rostoucí číslo na konci předpony nevydá, dokud ho něco neukončí', () => {
    // `12` useknuté na `1` je pořád validní JSON — a je to jiné číslo. Tohle je
    // jediná třída, kde se rozepsaná hodnota tváří jako hotová, takže bez téhle
    // předpony by test o „jen dopsané hodnoty" byl ozdoba.
    const text = '{"version":12,"geometry":{"nodes":[]}}';
    const cut = text.indexOf('12') + 1;

    expect(readPartialEmission(text.slice(0, cut)).complete).not.toHaveProperty('version');
    expect(readPartialEmission(text.slice(0, cut + 1)).complete).not.toHaveProperty('version');
    // Až čárka za číslem dokazuje, že je dopsané.
    expect(readPartialEmission(text.slice(0, cut + 2)).complete.version).toBe(12);
  });

  it('poslední předpona dá týž blueprint jako celá odpověď', () => {
    const whole = readPartialEmission(TEXT);
    expect(whole.done, 'celá odpověď se nepřečetla jako hotová').toBe(true);
    expect(whole.complete).toEqual(ANSWER);

    const plan = readPlannerEmission(fixture.plan, { requireSceneSpec: false });
    expect(plan.ok, plan.ok ? '' : `archivovaný plán se nepřečetl: ${JSON.stringify(plan)}`).toBe(true);
    if (!plan.ok) return;

    const options = { sessionSeed: 4021, upstream: { model: 'archived', system: 'system', user: 'user' } };
    const fromWhole = compileBlueprint(ANSWER, plan.value, options);
    const fromStream = compileBlueprint(whole.complete, plan.value, options);

    // Bez tohohle by se porovnávala dvě odmítnutí a test by byl ozdoba.
    expect(
      fromWhole.ok,
      fromWhole.ok ? '' : `archivovaná odpověď se nezkompilovala: ${JSON.stringify(fromWhole).slice(0, 300)}`,
    ).toBe(true);

    // Bajtově, ne „stejný verdikt": blueprint je to, co se posílá do světa.
    expect(JSON.stringify(fromStream)).toBe(JSON.stringify(fromWhole));
  });
});
