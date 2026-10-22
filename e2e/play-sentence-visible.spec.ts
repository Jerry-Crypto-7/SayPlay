import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type APIRequestContext } from '@playwright/test';

import { startGame } from './play-start';

/**
 * P56A T12: dvanáct vět auditu živého `/play` (21. 10.) dojde do hry na `next start` se skutečnou čtečkou.
 * Každá věta se publikuje, čtečka ji přečte (`origin.readBy`), spec nese hrdinu (podmět) a protivníka věty a hra se
 * na desktopu i telefonu rozběhne bez `pageerror`. Že jsou vidět na plátně – a bez protivníka i věc, se kterou hrdina
 * pracuje – soudí slepý soudce (`evals/play/p56a/visible.mjs`), ne tenhle test.
 *
 * Server musí běžet se čtečkou, jinak test padne na `readBy`:
 *   PLAY_READER=on PLAY_READER_ENDPOINT=llamacpp:http://127.0.0.1:8792 PLAY_READER_BUDGET_MS=60000
 */

interface Labeled { readonly id: string; readonly text: string; readonly hero: string | null; readonly foe: string | null; readonly item: string | null }

const AUDIT = (JSON.parse(readFileSync(join(process.cwd(), 'evals', 'play', 'p56a', 'audit-12.json'), 'utf8')) as { sentences: Labeled[] }).sentences;

interface Game { readonly origin?: { readonly readBy?: string }; readonly spec: { readonly roles: readonly { readonly kind: string; readonly label: string }[] } }

/** Popisek role nese slovo věty: hlavní (poslední) slovo štítku auditu (jednotné číslo) nebo jeho množné číslo mezi slovy popisku. */
function names(label: string, noun: string): boolean {
  const head = noun.toLowerCase().split(/\s+/).at(-1)!;
  const forms = [head, `${head}s`, `${head}es`, ...(head.endsWith('y') ? [`${head.slice(0, -1)}ies`] : [])];
  return label.toLowerCase().split(/[^a-z]+/).some((word) => forms.includes(word));
}

async function publish(request: APIRequestContext, sentence: string): Promise<{ url: string; versionId: string }> {
  const response = await request.post('/api/play/games', { data: { sentence }, timeout: 180_000 });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return (await response.json()) as { url: string; versionId: string };
}

for (const screen of [{ name: 'desktop', width: 1280, height: 800, touch: false }, { name: 'phone', width: 390, height: 844, touch: true }]) {
  test.describe(screen.name, () => {
    test.use({ viewport: { width: screen.width, height: screen.height }, hasTouch: screen.touch, isMobile: screen.touch });

    for (const sentence of AUDIT) {
      test(`${sentence.id}: ${sentence.text}`, async ({ page, request }) => {
        // První čtení věty jde přes model (lokálně desítky sekund); druhá obrazovka bere uložené čtení.
        test.setTimeout(300_000);
        const errors: string[] = [];
        page.on('pageerror', (error) => errors.push(error.message));
        const { url, versionId } = await publish(request, sentence.text);
        const game = (await (await request.get(`/api/play/games/${versionId}`)).json()) as Game;
        expect(game.origin?.readBy, 'the reader read the sentence').toBe('model');
        const hero = game.spec.roles.find((role) => role.kind === 'player')?.label ?? '';
        const others = game.spec.roles.filter((role) => role.kind !== 'player').map((role) => role.label);
        if (sentence.hero !== null) expect(names(hero, sentence.hero), `hero "${hero}" names "${sentence.hero}"`).toBe(true);
        // Věc věty (bez protivníka) spec nést nemusí – „penalty kicks“ je ve specu kop, ne míč; jestli je vidět, soudí `visible.mjs`.
        const foe = sentence.foe;
        if (foe !== null) expect(others.some((label) => names(label, foe)), `roles ${others.join(', ')} name "${foe}"`).toBe(true);

        await page.goto(url);
        await startGame(page);
        // Rytmickou hru `start()` sondy nepustí (naměřeno 22. 10.: tick 0 po šesti voláních), skutečná klávesa ano –
        // jako v `play-honest`. Mezerník, dokud hodiny neběží: stisk před dokreslením scény hra zahodí.
        await expect.poll(async () => (await page.keyboard.press('Space'), page.evaluate(() => window.__playShell?.tick() ?? 0)), { timeout: 60_000, intervals: [500] }).toBeGreaterThan(30);
        expect(errors).toEqual([]);
      });
    }
  });
}
