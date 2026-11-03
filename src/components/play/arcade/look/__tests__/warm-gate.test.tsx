/**
 * Kulisa s nepřeloženým programem se neukáže (P68-M T2, `warm-gate.ts`): jde vidět jen jako čas, ne jako obraz – test
 * pinuje, že studený díl zůstane mimo scénu, teplý se ukáže hned a bez plátna (kontextu) se díl ukáže jako dřív.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { Group } from 'three';
import { describe, expect, it } from 'vitest';

import { type Warmer, WarmerContext, useWarmed } from '../warm-gate';

function Shown({ part }: { readonly part: Group | null }) {
  return <i>{useWarmed(part)?.name ?? 'none'}</i>;
}

const warmer = (cold: boolean): Warmer => ({ cold: () => cold, warm: () => new Promise(() => undefined) });
const render = (part: Group | null, context: Warmer | null) =>
  renderToStaticMarkup(
    <WarmerContext.Provider value={context}>
      <Shown part={part} />
    </WarmerContext.Provider>,
  );

describe('useWarmed', () => {
  const part = Object.assign(new Group(), { name: 'bench' });

  it('holds a part back while its programs are cold', () => {
    expect(render(part, warmer(true))).toBe('<i>none</i>');
  });

  it('shows a warm part at once', () => {
    expect(render(part, warmer(false))).toBe('<i>bench</i>');
  });

  it('shows the part at once outside a game canvas', () => {
    expect(render(part, null)).toBe('<i>bench</i>');
  });

  it('keeps nothing as nothing', () => {
    expect(render(null, warmer(true))).toBe('<i>none</i>');
  });
});
