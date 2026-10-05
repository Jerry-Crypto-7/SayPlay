import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test } from '@playwright/test';

/**
 * Snímky prostředí (P30B T6): jedna věta na každé prostředí, které porota
 * v živém běhu nepoznala (`evals/play/p30b/losses.md`). Zmrazené AI specy
 * z `live.json`, snímek plátna po úvodním průletu kamery do
 * `evals/play/p30b/settings/<id>-<prostředí>.png` – podklad pro srovnání
 * pohledem, ne brána. Barvu podkladu pinuje `src/play/__tests__/setting-ground.test.ts`.
 *
 * Bez služby panoramat (`PLAY_ENV_ENDPOINT`): scéna tak ukazuje, co kreslí
 * sama – podklad, kulisy a oblohu sady prostředí.
 */

const SETTINGS = [
  { id: 'h04', name: 'mars' },
  { id: 'h08', name: 'moon' },
  { id: 'h09', name: 'hospital' },
  { id: 's069', name: 'cave' },
  { id: 's022', name: 'tower' },
  { id: 's058', name: 'river' },
  { id: 's050', name: 'snow-fort' },
] as const;

/** Úvodní průlet kamery (`look/intro.ts`, od P37B T6 0,9 s) a dotažení modelů. */
const SETTLE_MS = 3000;
const OUT = join(process.cwd(), 'evals/play/p30b/settings');

interface Sentence {
  readonly id: string;
  readonly spec: { readonly control?: string } & Record<string, unknown>;
}

const LIVE = JSON.parse(readFileSync(join(process.cwd(), 'evals/play/p30b/live.json'), 'utf8')) as { sentences: Sentence[] };

test.use({ viewport: { width: 1280, height: 800 } });

for (const { id, name } of SETTINGS) {
  test(`${id} ${name}: setting snapshot`, async ({ page, request }) => {
    const sentence = LIVE.sentences.find((entry) => entry.id === id);
    expect(sentence, `${id} missing from live.json`).toBeDefined();
    const response = await request.post('/api/play/games', { data: { spec: sentence!.spec } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    await page.goto(((await response.json()) as { url: string }).url);
    const stage = page.getByTestId(sentence!.spec.control === undefined ? 'play-grid-stage' : 'arcade-stage');
    await expect(stage.locator('canvas').first()).toBeVisible({ timeout: 30_000 });
    await page.waitForTimeout(SETTLE_MS);
    mkdirSync(OUT, { recursive: true });
    await stage.screenshot({ path: join(OUT, `${id}-${name}.png`) });
  });
}
