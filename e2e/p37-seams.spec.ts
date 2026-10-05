import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { startGame } from './play-start';

/**
 * Švy P37-0 (T2 `heroAction` do scén, T3 prázdný `GhostSlot`) nesmí pohnout
 * obrazem: snímek běžce a plošinovky na počítači i na telefonu se od
 * referenčního snímku z kódu před švy (render jako `features/p27d`, 87a8bf34)
 * smí lišit nejvýš v 1 % pixelů.
 *
 * Postup je `p32-split.spec.ts`: záznam robota ověřovače se zahraje tik po
 * tiku (`handPlay`) do prvního bodu a skrytá záložka hru hned pozastaví – stav
 * i podíl tiku pro interpolaci jsou v každém běhu tytéž. Na snímku je jen
 * plátno; HUD a vrstvy nad ním se skryjí. Šum mezi dvěma běhy téhož buildu je
 * pod prahem (ověřeno při nahrání referencí).
 *
 * Reference v `e2e/__screenshots__/p37-seams/` (`--update-snapshots` na HEAD
 * před T2). Stopa, která obraz mění záměrně, je nahraje znovu.
 */

const FIXTURES = ['runner', 'platform'] as const;

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
] as const;

/** Nad plátnem nic: HUD, „+1“ a počasí se mění jinak než scéna a pin by měřil je. */
const ONLY_CANVAS = 'body * { visibility: hidden !important; } [data-testid="arcade-stage"] canvas { visibility: visible !important; }';

async function publish(request: APIRequestContext, fixture: string): Promise<string> {
  const spec = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', `${fixture}.json`), 'utf8')) as unknown;
  const response = await request.post('/api/play/games', { data: { spec } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

/** Robot do prvního bodu, pak pauza skrytou záložkou – jako `p32-split.spec.ts`. */
function freezeAtFirstScore(page: Page): Promise<{ readonly score: number; readonly tick: number }> {
  return page.evaluate(() => {
    type Hand = { handPlay: (until: 'score' | 'end') => { score: number } };
    const showTab = (state: 'visible' | 'hidden'): void => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
      document.dispatchEvent(new Event('visibilitychange'));
    };
    showTab('visible');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift' }));
    const run = (window.__playShell as unknown as Hand).handPlay('score');
    showTab('hidden');
    return { score: run.score, tick: window.__playShell!.tick() };
  });
}

for (const viewport of VIEWPORTS) {
  test.describe(`${viewport.name} ${viewport.width}×${viewport.height}`, () => {
    test.use({ viewport: { width: viewport.width, height: viewport.height } });

    for (const fixture of FIXTURES) {
      test(`${fixture}: the P37-0 seams draw the same frame`, async ({ page, request }) => {
        test.setTimeout(120_000);
        const url = await publish(request, fixture);
        await page.goto(url);
        await expect(page.getByTestId('arcade-stage')).toBeVisible();
        const canvas = page.locator('[data-testid="arcade-stage"] canvas').first();
        await canvas.waitFor();
        await startGame(page);
        await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 5, undefined, { timeout: 60_000 });
        // Nejdřív se dotáhnou modely a doběhne úvodní průlet kamery (1,5 s), pak jediné zastavení, ne dvě jako p32-split:
        // po prvním zastavení drží pauzu karta pauzy (P34, `holdsPause` v `ArcadePlay.tsx`) a Shift ji neprobudí, takže
        // druhý `handPlay` hraje v pauze – stisky se zahodí, `stepOnce` tiká dál a běžec prohraje (skóre 0 na tiku 161).
        // Restart sám stav vrací celý: `session-pause.test.ts` (P37-0 R2).
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
        await page.waitForTimeout(2_000);
        const frozen = await freezeAtFirstScore(page);
        expect(frozen.score).toBeGreaterThan(0);
        // Sebraná mince dofoukne (200 ms) a snímek se ustálí.
        await page.waitForTimeout(800);

        await page.addStyleTag({ content: ONLY_CANVAS });
        await expect(canvas).toHaveScreenshot(['p37-seams', `${fixture}-${viewport.name}.png`], { maxDiffPixelRatio: 0.01 });
      });
    }
  });
}
