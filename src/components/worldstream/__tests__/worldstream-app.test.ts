/**
 * Prázdná scéna a fronta kusů (P21 T10).
 *
 * Dvě věci, které snímek neukáže a e2e sada dvakrát přehlédla:
 *
 * 1. **Prázdný stav stojí v mřížce, ne mimo ni, a nepředbíhá vstup.** Prvním
 *    interaktivním prvkem stránky musí zůstat pole na větu
 *    (`e2e/render-quality.spec.ts`); příklad věty je tlačítko, takže kdyby
 *    stál v DOM dřív než dok, převzal by to místo a nikdo by si toho nevšiml.
 *    A mimo `.ws-shell` by byl čtvrtý absolutně kotvený box — přesně ta vada,
 *    kvůli které mřížka vznikla.
 * 2. **Fronta kusů se čte jako věta.** `pieces.remaining` ze serveru je pole;
 *    prázdné pole nesmí vyrobit „Still to send: " s ničím za dvojtečkou.
 *
 * Repo nemá testing-library, takže se skořápka soudí `renderToStaticMarkup`
 * — struktura DOM je jediné, o co tu jde, a na tu statický výpis stačí.
 */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { queueLine } from '../ChangePreview';
import WorldstreamApp from '../WorldstreamApp';

function shell(empty: ReturnType<typeof createElement> | null): string {
  return renderToStaticMarkup(
    createElement(WorldstreamApp, {
      stage: createElement('canvas', { 'data-testid': 'stage' }),
      prompt: createElement('input', { 'data-testid': 'prompt-input' }),
      status: createElement('p', null, 'ready'),
      inspect: null,
      inspecting: false,
      onInspect: () => undefined,
      empty,
    }),
  );
}

describe('prázdná scéna ve skořápce', () => {
  const EMPTY = createElement('button', { 'data-testid': 'example-sentence' }, 'try this');

  it('stojí uvnitř mřížky, ne jako čtvrtý kotvený box', () => {
    const html = shell(EMPTY);
    const grid = html.indexOf('class="ws-shell"');
    const gridEnd = html.indexOf('<canvas');
    const empty = html.indexOf('data-testid="example-sentence"');
    expect(grid).toBeGreaterThan(-1);
    expect(empty).toBeGreaterThan(grid);
    expect(empty).toBeLessThan(gridEnd);
    expect(html).toContain('class="ws-empty"');
  });

  it('nepředbíhá vstup pro větu v DOM', () => {
    const html = shell(EMPTY);
    expect(html.indexOf('data-testid="prompt-input"')).toBeLessThan(html.indexOf('data-testid="example-sentence"'));
  });

  it('bez prázdného stavu se buňka nekreslí vůbec', () => {
    expect(shell(null)).not.toContain('ws-empty');
  });
});

describe('queueLine', () => {
  it('pojmenuje, co šlo modelu a co zbývá', () => {
    expect(queueLine({ asked: 'add a lantern', remaining: ['put a bell on the mast'] })).toBe(
      'This sentence asked for 2 things. Sent first: “add a lantern”. Still to send: “put a bell on the mast”.',
    );
  });

  it('víc zbylých kusů odděluje středníkem', () => {
    expect(queueLine({ asked: 'a', remaining: ['b', 'c'] })).toContain('Still to send: “b”; “c”.');
  });

  it('bez zbytku nevypíše nic — jedna věc není fronta', () => {
    expect(queueLine({ asked: 'add a lantern', remaining: [] })).toBeNull();
  });
});
