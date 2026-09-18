/**
 * Průvodce v ovládání světa (P21 T14).
 *
 * Okem se tady pozná skoro všechno: postava ve scéně stojí nebo nestojí, věta
 * se objeví nebo ne, prstenec se rozsvítí nebo ne. **Jedna vlastnost vidět
 * není** a právě kvůli ní tahle sada existuje: odpověď složená ze **starých**
 * pravidel se čte úplně stejně jako odpověď na ta dnešní. Porotce přetočí čas,
 * přepíše pravidlo a zeptá se znovu — a kdyby si průvodce nesl dokument
 * z doby, kdy se svět narodil, poslal by ho cestou, která v tomhle světě už
 * neplatí. Nikdo by to nepoznal, protože ta věta by pořád dávala smysl.
 *
 * Druhé rozhodnutí, které tenhle modul dělá sám, je **které slovo otázky je
 * cíl**. Splete-li se, průvodce odpoví „to tu není" na objekt, který tam je.
 *
 * Svět se sem nepíše, bere se z příkladu v produkčním promptu — stejně jako
 * v `src/worldstream/__tests__/guide.test.ts`.
 */

import { describe, expect, it } from 'vitest';

import { buildRuntimeWorld } from '@/ir/build';
import { EXAMPLE_MARKER, buildEmissionRequest, type Grammar } from '@/model/prompt';
import type { WorldDocRuntime } from '@/sim/interpreter';

import { askGuide, askedName } from '../RuntimeInteraction';

const grammar = (): Grammar => ({
  surfaceEvents: ['onStart', 'onEnterZone', 'onAction', 'onPickup'],
  conditions: ['flagIs', 'hasItem'],
  actions: ['setState', 'setFlag', 'setLocked', 'giveItem', 'despawn', 'win'],
  simFields: ['layout', 'sockets', 'entities', 'state', 'rules', 'witness'],
  lookFields: ['modules', 'palette'],
});

/** Ukázkový svět z hotové systémové zprávy: hráč, karta, páka, brána. */
function exampleSim(): Record<string, unknown> {
  const system = buildEmissionRequest('cokoli', grammar()).system;
  const at = system.indexOf(EXAMPLE_MARKER);
  const document = JSON.parse(system.slice(system.indexOf('{', at))) as { sim: Record<string, unknown> };
  return { ...document.sim, witness: { tier: 'short', H_cert: 600, ops: [] } };
}

function build(sim: Record<string, unknown>): WorldDocRuntime {
  const built = buildRuntimeWorld(sim);
  expect(built.ok ? [] : built.issues, 'svět se nepostavil, test by měřil něco jiného').toEqual([]);
  if (!built.ok) throw new Error('unreachable');
  return { ...built.world, trace: [] };
}

/**
 * Týž svět s **přepsaným jedním pravidlem** — přesně to gesto, které porotce
 * udělá po přetočení času.
 *
 * `win` přestane chtít rozsvícený proud, takže k bráně se dá dojít rovnou:
 * cesta se zkrátí a karta s pákou z ní vypadnou. Odpověď na tutéž otázku proto
 * **musí** vypadat jinak.
 */
function rewrittenSim(): Record<string, unknown> {
  const sim = exampleSim();
  const rules = sim.rules as Record<string, Record<string, unknown>>;
  return { ...sim, rules: { ...rules, win: { ...rules.win, condition: null } } };
}

describe('askedName – které slovo otázky je cíl', () => {
  it('vezme poslední jméno otázky a odřízne interpunkci', () => {
    expect(askedName('How do I get to the gate?')).toBe('gate');
    expect(askedName('where is the lever')).toBe('lever');
    expect(askedName('gate')).toBe('gate');
  });

  it('nesníží velikost písmen – stableId je `tallHive`, ne `tallhive`', () => {
    expect(askedName('How do I reach the tallHive?')).toBe('tallHive');
  });

  it('na prázdnou otázku se nikoho neptá', () => {
    expect(askedName('   ')).toBeNull();
    expect(askedName('')).toBeNull();
    expect(askedName('???')).toBeNull();
  });
});

describe('askGuide – odpověď patří dokumentu, který běží teď', () => {
  it('složí cestu ke skutečnému cíli ze světa', () => {
    const answer = askGuide(build(exampleSim()), 'How do I get to the gate?');

    expect(answer?.text).toMatch(/^To reach gate: /);
    expect(answer?.highlight.length, 'cesta bez zastávky nemá co ve scéně zvýraznit').toBeGreaterThan(0);
  });

  it('po přepisu pravidla odpovídá podle nových pravidel, ne podle starých', () => {
    const question = 'How do I get to the gate?';
    const before = askGuide(build(exampleSim()), question);
    const after = askGuide(build(rewrittenSim()), question);

    expect(before?.text).toContain('lever');
    // Tohle je celý test: tatáž otázka, jiná pravidla, jiná odpověď. Kdyby si
    // průvodce nesl starý dokument, obě věty by byly identické.
    expect(after?.text).not.toBe(before?.text);
    expect(after?.text, 'přepsaný svět už páku na cestě nemá').not.toContain('lever');
  });

  it('cíl mimo svět dostane „to tu není" a žádné jméno ze světa', () => {
    const answer = askGuide(build(exampleSim()), 'How do I get to the dragon?');

    expect(answer?.text).toBe('There is no dragon in this world.');
    for (const name of ['gate', 'lever', 'card', 'player'])
      expect(answer?.text, 'odpověď si přimyslela objekt ze světa').not.toContain(name);
    expect(answer?.highlight).toEqual([]);
  });

  it('na otázku bez jména neodpovídá vůbec', () => {
    expect(askGuide(build(exampleSim()), '   ')).toBeNull();
  });
});
