import { expect, test, type Page } from '@playwright/test';

/**
 * Diktování na `/play` (P29D T6): mikrofon v poli nové hry i v poli remixu
 * vloží přepis do pole – přidá ho k napsanému a nic neodešle. Prohlížeč bez
 * Web Speech tlačítko nevidí vůbec.
 *
 * Podvrhuje se rozhraní prohlížeče (`webkitSpeechRecognition`, jako Chrome),
 * ne náš kód – vzor `e2e/speech.spec.ts`.
 */

const SPOKEN = 'with rain and three dragons';

async function installFakeRecognition(page: Page): Promise<void> {
  await page.addInitScript((spoken: string) => {
    class FakeRecognition {
      lang = '';
      continuous = true;
      interimResults = true;
      onresult: ((event: unknown) => void) | null = null;
      onerror: ((event: unknown) => void) | null = null;
      onend: (() => void) | null = null;
      start(): void {
        setTimeout(() => {
          const result = Object.assign([{ transcript: spoken }], { isFinal: true });
          this.onresult?.({ results: [result] });
          this.onend?.();
        }, 50);
      }
      stop(): void {
        this.onend?.();
      }
    }
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: FakeRecognition });
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
  }, SPOKEN);
}

async function hideRecognition(page: Page): Promise<void> {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
  });
}

test.describe('/play – dictate the sentence', () => {
  test('the microphone on the new-game field adds the transcript and sends nothing', async ({ page }) => {
    await installFakeRecognition(page);
    const posts: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().includes('/api/play/games')) posts.push(request.url());
    });
    await page.goto('/play');
    const field = page.getByTestId('play-sentence');
    await field.fill('a jumping fox');
    await page.getByTestId('play-mic').click();
    await expect(field).toHaveValue(`a jumping fox ${SPOKEN}`);
    await expect(page.getByTestId('play-mic')).toHaveText('Mic');
    expect(posts).toEqual([]);
  });

  test('the microphone on the remix field fills it after the run', async ({ page, request }) => {
    await installFakeRecognition(page);
    const response = await request.post('/api/play/games', { data: { sentence: 'jumping arcade game with a lot of obstacles' } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    await page.goto(((await response.json()) as { url: string }).url);
    await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
    expect((await page.evaluate(() => window.__playShell!.playWitness())).runState).toBe('won');
    // Od P33 T4 je pole remixu v listu za „Change it“.
    await page.getByRole('button', { name: 'Change it' }).click();
    await page.getByTestId('remix-mic').click();
    await expect(page.getByTestId('remix-input')).toHaveValue(SPOKEN);
  });

  test('without Web Speech there is no microphone button at all', async ({ page }) => {
    await hideRecognition(page);
    await page.goto('/play');
    await expect(page.getByTestId('play-sentence')).toBeVisible();
    await page.waitForTimeout(500);
    await expect(page.getByTestId('play-mic')).toHaveCount(0);
  });
});
