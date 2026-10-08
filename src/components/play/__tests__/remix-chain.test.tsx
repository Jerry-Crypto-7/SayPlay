/**
 * Řetěz remixů v listu „About this game“ (P44B T11): odkaz na každý remix, jeho čipy a nejlepší
 * hráč jeho žebříčku („Top: Ada 2,450“, běh bez bodů časem); bez remixů oddíl chybí.
 */

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { RemixList, type RemixRow, topText } from '../RemixChain';

const remix = (versionId: string, top: RemixRow['top'], chips: string[] = []): RemixRow => ({ versionId, title: `Game ${versionId}`, chips, top });

describe('RemixList (P44B T11)', () => {
  it('odkaz, čipy a top každého remixu u svého řádku', () => {
    const html = renderToStaticMarkup(<RemixList remixes={[remix('aaaa1111', { nickname: 'Ada', score: 2_450, ticks: 900 }, ['+dragons', 'faster']), remix('bbbb2222', null)]} />);
    expect(html).toContain('data-testid="play-remix-chain"');
    expect(html).toContain('>Remixes<');
    const rows = html.split('class="play-remix-chain-row"').slice(1);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain('href="/play/aaaa1111"');
    expect(rows[0]).toContain('>+dragons<');
    expect(rows[0]).toContain('Top: Ada 2,450');
    expect(rows[1]).toContain('href="/play/bbbb2222"');
    expect(rows[1]).not.toContain('Top:');
  });

  it('bez remixů nic', () => {
    expect(renderToStaticMarkup(<RemixList remixes={[]} />)).toBe('');
  });

  it('běh bez bodů ukáže čas', () => {
    expect(topText({ nickname: 'Bo', score: 0, ticks: 1_860 })).toBe('Top: Bo 31.0s');
  });
});
