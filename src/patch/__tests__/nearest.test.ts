import { applyPatch, type Operation } from 'rfc6902';
import { describe, expect, it } from 'vitest';

import { nearestLegal } from '../nearest';
import { routePatch } from '../router';

/**
 * Nejbližší legální varianta patche (P11 T13).
 *
 * Testuje se **obojí, co ta funkce slibuje**: že doletí tam, kde existuje právě
 * jedno legální čtení, a hlavně že **nedoletí nikam jinam**. Druhá polovina je
 * ta důležitá — přijímací brána je jediná dokázaná vlastnost projektu a tohle je
 * první změna, která ji rozvolňuje.
 */

const world = () => ({
  layout: { kind: 'grid', width: 12, height: 12, levels: 1, portals: [] as unknown[] },
  grid: { cell: 1 },
  state: { counters: {} as Record<string, unknown>, flags: {}, timers: {}, slots: 3 },
  rules: {
    open: { id: 'open', phase: 0, priority: 0, actions: [{ kind: 'setState', to: 'open' }] },
  },
});

const ops = (...operations: Operation[]): readonly Operation[] => operations;

describe('nearestLegal — doletí tam, kde je jediné legální čtení', () => {
  it('add na pozici pole, jehož člen ještě není, se přepíše na add toho členu', () => {
    const value = { min: 0, max: 9, init: 0 };
    const nearest = nearestLegal(world(), ops({ op: 'add', path: '/state/counters/streak/-', value }));

    expect(nearest.operations).toEqual([{ op: 'add', path: '/state/counters/streak', value }]);
    expect(nearest.landings).toHaveLength(1);
    expect(nearest.landings[0].kind).toBe('reshaped');
    expect(nearest.landings[0].to).toBe('add /state/counters/streak');
  });

  it('replace členu, který v objektu ještě není, se přepíše na add', () => {
    const nearest = nearestLegal(world(), ops({ op: 'replace', path: '/rules/open/condition', value: null }));

    expect(nearest.operations).toEqual([{ op: 'add', path: '/rules/open/condition', value: null }]);
    expect(nearest.landings[0].kind).toBe('reshaped');
  });

  it('hodnota se při přepsání nemění, ani hluboko ve struktuře', () => {
    const value = { nested: { list: [1, 2, 3], flag: false } };
    const nearest = nearestLegal(world(), ops({ op: 'add', path: '/state/counters/deep/0', value }));

    expect((nearest.operations[0] as { value: unknown }).value).toEqual(value);
  });

  it('legální patch projde beze změny a bez jediného záznamu o doletění', () => {
    const patch = ops(
      { op: 'add', path: '/state/counters/keys', value: { min: 0, max: 3, init: 0 } },
      { op: 'replace', path: '/grid', value: { cell: 2 } },
    );
    const nearest = nearestLegal(world(), patch);

    expect(nearest.operations).toEqual(patch);
    expect(nearest.landings).toEqual([]);
  });

  it('pořadí rozhoduje stav: druhá operace je legální jen díky první', () => {
    // Bez postupně upravovaného draftu by se druhá operace posuzovala nad
    // vstupním světem, kde `keys` není — a zahodila by se, ačkoli legální je.
    const nearest = nearestLegal(
      world(),
      ops(
        { op: 'add', path: '/state/counters/keys', value: { min: 0, max: 3, init: 0 } },
        { op: 'replace', path: '/state/counters/keys/max', value: 5 },
      ),
    );

    expect(nearest.operations).toHaveLength(2);
    expect(nearest.landings).toEqual([]);
  });

  it('i PŘEPSÁNÍ se posuzuje nad draftem: druhá operace doletí jen díky první', () => {
    // Test o řádek výš hlídá jen přímý pokus — druhá operace je tam legální sama
    // o sobě a k přepisování se nikdy nedojde. Tenhle případ jde po té druhé
    // půlce: `/state/pouch` vzniká teprve první operací, takže bez postupně
    // upravovaného draftu nemá přepsání kam sáhnout a operace se zahodí.
    const value = { min: 0, max: 9, init: 0 };
    const nearest = nearestLegal(
      world(),
      ops(
        { op: 'add', path: '/state/pouch', value: {} },
        { op: 'add', path: '/state/pouch/streak/-', value },
      ),
    );

    expect(nearest.operations).toEqual([
      { op: 'add', path: '/state/pouch', value: {} },
      { op: 'add', path: '/state/pouch/streak', value },
    ]);
    expect(nearest.landings).toHaveLength(1);
    expect(nearest.landings[0].kind).toBe('reshaped');
    expect(nearest.landings[0].to).toBe('add /state/pouch/streak');
  });
});

describe('nearestLegal — nedoletí tam, kde by musel hádat význam', () => {
  it('add na pozici pole nad skalárem se zahodí, nepřepíše', () => {
    // `levels: 1` je číslo. Čtení jsou dvě — přepiš skalár, nebo z něj udělej
    // pole — takže se nevybírá ani jedno. Tohle je E19 ze zmrazeného korpusu.
    const nearest = nearestLegal(world(), ops({ op: 'add', path: '/layout/levels/1', value: { width: 16 } }));

    expect(nearest.operations).toEqual([]);
    expect(nearest.landings[0].kind).toBe('dropped');
  });

  it('cíl s neexistujícím rodičem se zahodí — jméno se nehledá podobné', () => {
    // E06: pravidlo `openChest` v tomhle světě není. Přejmenovat cíl na `open`,
    // protože je „nejbližší", by byl systém hádající význam.
    const nearest = nearestLegal(world(), ops({ op: 'replace', path: '/rules/openChest/condition', value: null }));

    expect(nearest.operations).toEqual([]);
    expect(nearest.landings[0].kind).toBe('dropped');
  });

  it('zahozená operace nenechá draft rozpracovaný pro tu další', () => {
    const nearest = nearestLegal(
      world(),
      ops(
        { op: 'replace', path: '/rules/missing/condition', value: 1 },
        { op: 'replace', path: '/grid', value: { cell: 4 } },
      ),
    );

    expect(nearest.operations).toEqual([{ op: 'replace', path: '/grid', value: { cell: 4 } }]);
    expect(nearest.landings).toHaveLength(1);
  });

  it('nepřepsatelný token neprojde ani jako přepsání', () => {
    // `rfc6902` tyhle tři klíče přeskakuje a zapsal by o úroveň výš. Kdyby se
    // přepsání ptalo knihovny místo RFC 6901, otevřelo by přesně tu díru.
    for (const path of ['/state/counters/__proto__/-', '/rules/constructor/condition', '/state/prototype']) {
      const nearest = nearestLegal(world(), ops({ op: 'replace', path, value: 1 } as Operation));
      expect(nearest.operations, path).toEqual([]);
    }
  });

  it('remove neexistujícího členu se zahodí, nikdy nepřepíše na add', () => {
    const nearest = nearestLegal(world(), ops({ op: 'remove', path: '/rules/open/condition' }));

    expect(nearest.operations).toEqual([]);
    expect(nearest.landings[0].kind).toBe('dropped');
  });

  it('vstupní svět se doletěním nezmění — pracuje se na kopii', () => {
    const source = world();
    const before = JSON.stringify(source);
    nearestLegal(source, ops({ op: 'add', path: '/state/counters/streak/-', value: { init: 0 } }));

    expect(JSON.stringify(source)).toBe(before);
  });

  it('co zbude, jde provést — a provede to táž knihovna jako commit', () => {
    const patch = ops(
      { op: 'add', path: '/layout/levels/1', value: { width: 16 } },
      { op: 'add', path: '/state/counters/streak/-', value: { min: 0, max: 9, init: 0 } },
      { op: 'replace', path: '/rules/open/condition', value: null },
    );
    const draft = world();
    const errors = applyPatch(draft, [...nearestLegal(world(), patch)!.operations]).filter((e) => e !== null);

    expect(errors).toEqual([]);
    expect(draft.state.counters).toHaveProperty('streak');
  });
});

describe('routePatch — doletění je vázané na dokument, ne na router', () => {
  const doc = () => ({ sim: world(), look: { modules: {} }, simRevision: 0, lookRevision: 0, simHash: 'x' });

  it('bez dokumentu se nedoletí a chování je přesně to původní', () => {
    const routed = routePatch({ operations: ops({ op: 'add', path: '/sim/state/counters/streak/-', value: 1 }) });

    expect(routed.verdict).toBe('ROUTED');
    if (routed.verdict !== 'ROUTED') return;
    expect(routed.landings).toEqual([]);
    expect(routed.patches[0].operations).toEqual([{ op: 'add', path: '/state/counters/streak/-', value: 1 }]);
  });

  it('s dokumentem se doletí a je to vidět v landings', () => {
    const routed = routePatch({ operations: ops({ op: 'add', path: '/sim/state/counters/streak/-', value: 1 }) }, doc() as never);

    expect(routed.verdict).toBe('ROUTED');
    if (routed.verdict !== 'ROUTED') return;
    expect(routed.patches[0].operations).toEqual([{ op: 'add', path: '/state/counters/streak', value: 1 }]);
    expect(routed.landings).toHaveLength(1);
  });

  it('patch, ze kterého nezbude nic, je odmítnutí — ne prázdný úspěch', () => {
    // Prázdný patch by `commitPart` přijal a zvedl revizi za změnu, která se
    // nestala. Hráč by viděl „hotovo" nad světem, se kterým se nic nedělo.
    const routed = routePatch({ operations: ops({ op: 'replace', path: '/sim/rules/missing/x', value: 1 }) }, doc() as never);

    expect(routed.verdict).toBe('REJECTED');
    if (routed.verdict !== 'REJECTED') return;
    expect(routed.reason).toBe('MALFORMED_OPERATION');
    expect(routed.detail).toContain('legal variant');
  });

  it('dráhu rozhodují pořád cesty — štítek ani doletění s tím nehnou', () => {
    const routed = routePatch(
      { label: 'look', operations: ops({ op: 'add', path: '/sim/state/counters/streak/-', value: 1 }) },
      doc() as never,
    );

    expect(routed.verdict).toBe('ROUTED');
    if (routed.verdict !== 'ROUTED') return;
    expect(routed.patches[0].lane).toBe('rules');
    expect(routed.patches[0].part).toBe('sim');
    expect(routed.anomalies).toHaveLength(1);
  });
});
