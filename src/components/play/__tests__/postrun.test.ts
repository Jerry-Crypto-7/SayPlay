import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { PostRun } from '../PostRun';
import type { RemixJob } from '../RemixBox';

/**
 * Karta po hře (P33 T4) má právě jednu hlavní akci. Dvě stejně výrazná
 * tlačítka vypadají na snímku v pořádku a hráč stejně neví, co zmáčknout –
 * proto se hlavní akce počítají, ne prohlížejí.
 */

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => undefined }) }));

const job: RemixJob = { view: { kind: 'idle' }, sent: '', submit: () => undefined };

const card = (clip: Blob | null = null) => renderToStaticMarkup(createElement(PostRun, { versionId: 'v1', remix: job, clip, onReplay: () => undefined }));

describe('PostRun', () => {
  it('has exactly one primary action, and it is Play again', () => {
    for (const markup of [card(), card(new Blob(['clip'], { type: 'video/webm' }))]) {
      const primaries = markup.match(/<[^>]*data-variant="primary"[^>]*>/g) ?? [];
      expect(primaries).toHaveLength(1);
      expect(primaries[0]).toContain('data-testid="play-replay"');
    }
    expect(card()).toMatch(/data-testid="play-replay"[^>]*>Play again</);
  });

  it('keeps the change field behind Change it until the player asks for it', () => {
    const markup = card();
    expect(markup).toContain('>Change it<');
    expect(markup).not.toContain('data-testid="remix-box"');
  });
});
