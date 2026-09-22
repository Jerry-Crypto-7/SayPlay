import { expect, test, type Page } from '@playwright/test';

/**
 * Oracle T23 — **nadiktovaná věta dorazí do pole, a tlačítko se nikde jinde
 * neobjeví.**
 *
 * Skutečné rozpoznávání řeči se v testu spustit nedá: chce mikrofon, síť a
 * člověka, který mluví. Podvrhuje se proto **rozhraní prohlížeče**, ne náš kód —
 * `window.webkitSpeechRecognition` je cizí objekt na okně a nahradit ho je totéž,
 * co udělá jiný prohlížeč. Všechno za ním (přepis, doručení do pole, stav
 * tlačítka) je produkční cesta.
 *
 * Dvě větve AC, dva testy, a každý chrání jinou vadu:
 *  - s rozhraním → tlačítko je vidět a mluvení skončí textem v poli;
 *  - bez rozhraní → tlačítko **není vůbec**, ne jen vypnuté.
 *
 * Že za tím stojí živý React, a ne HTML ze serveru, dokazuje samo tlačítko:
 * dostupnost se čte až po připojení komponenty, takže na serverovém HTML tam
 * tlačítko není nikdy.
 */

/** Co „řekne" podvržený rozpoznávač. Anglicky, protože rozpoznávač tvarů vět umí jen to. */
const SPOKEN = 'with three keys';

/** Co je v poli napsané předtím. Nadiktované se má přidat, ne tohle přepsat. */
const TYPED = 'a puzzle room';

/**
 * Vydá prohlížeč za takový, který rozpoznávání řeči umí.
 *
 * Vystavuje se **jen prefixované jméno** — přesně jako Chrome. Kdyby produkt
 * četl výhradně neprefixované `SpeechRecognition`, tenhle test zčervená, a to je
 * jeho druhá práce.
 */
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
        // Zdržení je tu proto, aby stav „poslouchám" vůbec nastal — okamžitý
        // výsledek by přeskočil celou půlku, kterou má test pozorovat.
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

    Object.defineProperty(window, 'webkitSpeechRecognition', {
      configurable: true,
      value: FakeRecognition,
    });
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
  }, SPOKEN);
}

test('nadiktovaná věta se přidá do pole a formulář se tím neodešle', async ({ page }) => {
  test.setTimeout(120_000);

  await installFakeRecognition(page);

  // Klik na mikrofon nesmí odeslat rozepsanou větu. Tlačítko bez `type` uvnitř
  // formuláře odesílá, takže tahle aserce hlídá skutečnou past, ne teorii.
  const generateCalls: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/generate')) generateCalls.push(request.url());
  });

  await page.goto('/classic');

  const input = page.getByTestId('prompt-input');
  await input.fill(TYPED);

  const dictate = page.getByTestId('prompt-dictate');
  await expect(dictate).toBeVisible();
  await dictate.click();

  await expect(dictate).toHaveText('Listening…');
  await expect(input).toHaveValue(`${TYPED} ${SPOKEN}`);
  // Konec relace musí stav vrátit zpátky, jinak tlačítko visí v poslouchání.
  await expect(dictate).toHaveText('Dictate');

  expect(generateCalls, `klik na diktování odeslal formulář: ${generateCalls.join(', ')}`).toEqual([]);
});

test('bez rozhraní prohlížeče se tlačítko vůbec nevykreslí', async ({ page }) => {
  test.setTimeout(120_000);

  // Headless Chromium `webkitSpeechRecognition` vystavuje, takže Firefox se musí
  // vyrobit — bez tohohle by test měřil prostředí, ne rozhodnutí produktu.
  await page.addInitScript(() => {
    Object.defineProperty(window, 'webkitSpeechRecognition', { configurable: true, value: undefined });
    Object.defineProperty(window, 'SpeechRecognition', { configurable: true, value: undefined });
  });

  // Tlačítko nesmí být ani v HTML, které chodí ze serveru. To HTML je pro
  // všechny prohlížeče stejné — kdyby v něm tlačítko bylo, ve Firefoxu by
  // bliklo a po připojení komponenty zmizelo. Proto se dostupnost čte až tam,
  // a proto se to měří na syrové odpovědi, ne na živé stránce.
  const serverHtml = await (await page.request.get('/studio')).text();
  expect(serverHtml, 'tlačítko na diktování přišlo už ze serveru').not.toContain('prompt-dictate');

  await page.goto('/classic');

  // Nepřítomnost tlačítka je pravdivá i na mrtvém HTML ze serveru. Tvrzení má
  // cenu až nad připojeným Reactem, a ten dokazuje globál stránky.
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });

  await expect(page.getByTestId('prompt-dictate')).toHaveCount(0);
  // A produkt tím nepřestal fungovat: psát se pořád dá.
  await expect(page.getByTestId('prompt-submit')).toBeEnabled();
});
