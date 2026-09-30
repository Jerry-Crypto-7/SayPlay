import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

import { startGame } from './play-start';

/**
 * Připíchnutý obraz rozdělení plátna (P32-0 T5). `ArcadeStage.tsx` se dělí na
 * shell, `StyleRig` (světlo, obloha, mlha) a světy běžce a plošinovky – vypadat
 * to má stejně. Snímek běžce a plošinovky na počítači i na telefonu (boční
 * kamera plošinovky se na výšku natáčí, `placeAngled`) se od referenčního
 * snímku z kódu před rozdělením smí lišit nejvýš v 1 % pixelů.
 *
 * Snímek je deterministický: záznam robota ověřovače se zahraje tik po tiku
 * (`handPlay`) do prvního bodu a skrytá záložka hru hned pozastaví – stav
 * i podíl tiku pro interpolaci jsou pak v každém běhu tytéž. Druhé zastavení
 * po dotažení modelů postaví kameru i ořez podle mlhy znovu z téhož místa.
 * Na snímku je jen plátno; HUD a vrstvy nad ním se skryjí.
 *
 * Referenční snímky leží v `e2e/__screenshots__/p32-split/` a nahrály se
 * z HEAD před rozdělením (`--update-snapshots`).
 *
 * Vypnuto od P32A T1: rig vzhledu (obloha, stíny, expozice) mění obraz záměrně,
 * takže „vypadá stejně“ už neplatí. Snímky zůstávají jako obraz před rigem –
 * `p32-look.spec.ts` z nich měří, že rig opravdu kreslí.
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

/**
 * Robot do prvního bodu, pak pauza skrytou záložkou (klávesa ani ťuk ji neprobudí, dokud je „skrytá“).
 * Pozastavená relace stisky zahazuje, takže podruhé se nejdřív probudí: záložka zpět viditelná
 * a Shift, který žádná scéna nečte (`focus.ts` probudí hru každou klávesou).
 */
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
      test.skip(`${fixture}: the split stage draws the same frame`, async ({ page, request }) => {
        test.setTimeout(120_000);
        const url = await publish(request, fixture);
        await page.goto(url);
        await expect(page.getByTestId('arcade-stage')).toBeVisible();
        const canvas = page.locator('[data-testid="arcade-stage"] canvas').first();
        await canvas.waitFor();
        await startGame(page);
        await page.waitForFunction(() => window.__playShell !== undefined && window.__playShell.tick() > 5, undefined, { timeout: 60_000 });

        const first = await freezeAtFirstScore(page);
        expect(first.score).toBeGreaterThan(0);
        // Modely a panorama se dotahují; úvodní průlet kamery (1,5 s) mezitím doběhne.
        await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => undefined);
        await page.waitForTimeout(2_000);
        const again = await freezeAtFirstScore(page);
        expect(again).toEqual(first);
        // Sebraná mince dofoukne (200 ms) a snímek se ustálí.
        await page.waitForTimeout(800);

        // `visibility` nemění rozvržení: plátno zůstane stejně velké a nepřekreslí se.
        await page.addStyleTag({ content: ONLY_CANVAS });
        await expect(canvas).toHaveScreenshot(['p32-split', `${fixture}-${viewport.name}.png`], { maxDiffPixelRatio: 0.01 });
      });
    }
  });
}
