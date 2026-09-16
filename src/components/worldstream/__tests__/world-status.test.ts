import { expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import WorldStatus from '../WorldStatus';

it('keeps asynchronous phase messages polite and atomic, with a separate urgent fault', () => {
  const phases = [
    { state: 'empty' as const, text: 'Describe a place' },
    { state: 'building' as const, text: 'Writing the world.' },
    { state: 'building' as const, detailPending: true, text: 'The validated scene is ready to use.' },
    { state: 'live' as const, text: 'The world is live.' },
  ];
  for (const phase of phases) {
    const element = WorldStatus({ ...phase, detail: 'Ignored outside a fault' });
    expect(element.key).toBe('progress');
    const html = renderToStaticMarkup(element);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-atomic="true"');
    expect(html).toContain(phase.text);
    expect(html).not.toContain('Ignored outside a fault');
    expect(html).not.toContain('role="alert"');
  }
  const fault = WorldStatus({ state: 'broken', detail: 'Please revise the sentence.' });
  expect(fault.key).toBe('fault');
  const html = renderToStaticMarkup(fault);
  expect(html).toContain('role="alert"');
  expect(html).toContain('Please revise the sentence.');
  expect(html).not.toContain('role="status"');
});

/**
 * **Co model z věty přečetl, dokud píše geometrii** (P18 T5).
 *
 * Planner odpoví desítky vteřin před compilerem (naměřeno 13.–16. 9. 2026:
 * plánovač 16,7 s proti překladači 103,2 s) a jeho odpověď nese čtyři pole.
 * Do T5 se z nich na obrazovku dostala **jedna věta**; hrdinové a seznam
 * abstrakcí se zahazovaly v klientském reduceru.
 *
 * Testuje se to, co oko nepozná: stránka s prázdným plátnem a jednou větou
 * vypadá úplně stejně jako stránka, které rámec nikdy nedorazil. Tohle je
 * přesně ta „tichá vada dějství II", která v tomhle repu už dvakrát ležela.
 */
const READ: {
  readonly setting: string;
  readonly spatialThesis: string;
  readonly heroObjects: readonly string[];
  readonly unsupported: readonly string[];
} = {
  setting: 'a cathedral of stacked shipping containers',
  spatialThesis: 'Stacked container walls enclose a central light well.',
  heroObjects: ['the stacked shipping containers', 'the light well'],
  unsupported: ['the rust is colour, not corrosion that spreads'],
};

it('says what the model read from the sentence while it writes the geometry', () => {
  const html = renderToStaticMarkup(WorldStatus({ state: 'building', intent: READ }));

  expect(html).toContain('a cathedral of stacked shipping containers');
  expect(html).toContain('Stacked container walls enclose a central light well.');
  // Hrdiny porotce ve větě pozná zpátky — jsou to jeho vlastní slova.
  expect(html).toContain('the stacked shipping containers');
  expect(html).toContain('the light well');
  // A co systém neumí, se **řekne**, ne zamlčí.
  expect(html).toContain('the rust is colour, not corrosion that spreads');
  expect(html).toContain('role="status"');
});

it('drops the lists it has nothing to say about instead of printing empty labels', () => {
  // Planner smí vrátit prázdné seznamy vědomě (`unsupported: []` znamená
  // „nic jsem neabstrahoval"). Popisek bez obsahu je horší než žádný.
  const html = renderToStaticMarkup(
    WorldStatus({ state: 'building', intent: { ...READ, heroObjects: [], unsupported: [] } }),
  );

  expect(html).toContain('Stacked container walls enclose a central light well.');
  expect(html).not.toContain('Building:');
  expect(html).not.toContain('Not simulated:');
});

it('keeps the model reading out of every state but building', () => {
  // Hotový svět mluví sám za sebe; teze u něj by tvrdila, že se pořád píše.
  for (const state of ['empty', 'live', 'broken'] as const) {
    const html = renderToStaticMarkup(WorldStatus({ state, intent: READ }));
    expect(html).not.toContain('the stacked shipping containers');
  }

  // A detail podoby má přednost: v tu chvíli scéna na plátně už stojí.
  const detail = renderToStaticMarkup(
    WorldStatus({ state: 'building', detailPending: true, intent: READ }),
  );
  expect(detail).toContain('The validated scene is ready to use.');
  expect(detail).not.toContain('the stacked shipping containers');
});
