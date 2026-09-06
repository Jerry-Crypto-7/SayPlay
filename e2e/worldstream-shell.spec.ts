import { expect, test } from '@playwright/test';

/**
 * Oracle úlohy P13 vlna 0 T1 — **svět dostal celou obrazovku**.
 *
 * Do 27. 8. 2026 vypadala úvodní stránka takhle: pole na větu v horním pruhu a
 * pod ním čtyři až pět průsvitných karet ve dvou dolních rozích — program,
 * časová osa, náhled vítězné cesty, kola oprav, stahování modelu. Karty ukazují
 * vnitřnosti potrubí a viděl je i ten, kdo přišel jenom napsat větu. Design book
 * §15.3 a §15.5 to obrací.
 *
 * Test se ptá na čtyři věci a každá kryje jinou vadu:
 *  - **plátno je celý viewport**, ne obdélník mezi panely;
 *  - **žádný z pěti starých panelů není ve výchozím DOM**. Ptá se na `count`, ne
 *    na viditelnost: skrytý uzel by prošel jako neviditelný a přitom by na
 *    obrazovce ve skutečnosti pořád byl. Skrývat panely `display: none` je totiž
 *    přesně ten způsob, jak tuhle bránu obejít, aniž by se cokoli změnilo;
 *  - **stavová věta je jedna**, ne panel logů;
 *  - **prompt je první interaktivní prvek**. Přepínač Inspectu je taky tlačítko,
 *    takže stačí, aby stál v DOM výš, a vstup pro větu o to místo přijde.
 *
 * Pátá aserce je opačná, a je stejně důležitá: **panely se nemažou**. Po otevření
 * zásuvky tam musí být. Kdyby chyběly, prošla by tahle sada i nad produktem,
 * který o svých důkazech přišel.
 */

/** `C01` ze zmrazeného korpusu. Doslovný text — offline větev hledá přesnou shodu. */
const FROZEN_PROMPT = 'a puzzle room where I have to find three keys to open the exit door';

/** Pět panelů, které design book §15.5 posílá z výchozí obrazovky pryč. */
const MOVED_PANELS = [
  'pipeline-panel',
  'timeline',
  'witness-preview',
  'repair-rounds',
  'model-progress',
] as const;

test('výchozí obrazovka je svět, prompt a jedna věta — nic víc', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/classic');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });

  // Plátno drží celý viewport, ne obdélník mezi panely.
  const view = page.viewportSize()!;
  const canvas = (await page.getByTestId('stage-canvas').boundingBox())!;
  expect(canvas.width, 'plátno nezabírá celou šířku okna').toBeGreaterThanOrEqual(view.width - 1);
  expect(canvas.height, 'plátno nezabírá celou výšku okna').toBeGreaterThanOrEqual(view.height - 1);

  // Ani jeden ze starých panelů ve výchozím DOM.
  for (const id of MOVED_PANELS) {
    await expect(page.getByTestId(id), `${id} je pořád na výchozí obrazovce`).toHaveCount(0);
  }

  // Jeden dok, jedna stavová věta, jeden diskrétní bod pro Inspect.
  await expect(page.getByTestId('prompt-dock')).toHaveCount(1);
  await expect(page.locator('.ws-status')).toHaveCount(1);
  await expect(page.getByTestId('world-status')).toBeVisible();
  await expect(page.getByTestId('inspect-toggle')).toHaveCount(1);
  await expect(page.getByTestId('inspect-panels')).toHaveCount(0);

  // Prvním ovládacím prvkem zůstává vstup pro větu — nic ho nesmí předběhnout.
  const first = await page.evaluate(() => {
    const nodes = [
      ...document.querySelectorAll<HTMLElement>(
        'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])',
      ),
    ].filter((element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    });
    return nodes[0]?.dataset.testid ?? null;
  });
  expect(first, 'prvním ovládacím prvkem musí zůstat vstup pro větu').toBe('prompt-input');
});

test('Inspect se otevře a zavřít znamená odpojit, ne skrýt', async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto('/classic');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });

  await page.getByTestId('inspect-toggle').click();
  await expect(page.getByTestId('inspect')).toHaveAttribute('data-open', 'true');
  await expect(page.getByTestId('inspect-panels')).toHaveCount(1);

  // **Čtyři z pěti panelů mají nad prázdným světem prázdný stav a nevykreslují
  // se ani otevřené** — `Program`, `Timeline`, `WitnessPreview` i `RepairRounds`
  // stojí teprve nad postaveným světem, což měří jejich vlastní sady. Tenhle
  // test se jich proto neptá; stavěl by svět a měřil generování, ne zásuvku.
  //
  // `ModelProgress` je jiný a proto je tady: je současně panel a **motor
  // stahování modelu**. Kdyby ho zavřená zásuvka odpojovala, probe WebGPU by se
  // nikdy nespustil a offline větev produktu by tiše zmizela. Po otevření tedy
  // musí být hned, bez čekání na cokoli.
  await expect(page.getByTestId('model-progress')).toHaveCount(1);

  await page.getByTestId('inspect-toggle').click();
  await expect(page.getByTestId('inspect')).toHaveAttribute('data-open', 'false');
  await expect(page.getByTestId('inspect-panels')).toHaveCount(0);
  await expect(page.getByTestId('model-progress')).toHaveCount(0);
});

/**
 * Oracle vady z 27. 8. 2026 — **otevřená zásuvka nesmí sebrat dok**.
 *
 * Poprvé rostl sloupec zásuvky vzhůru od pravého dolního rohu a nejnižší panel
 * si lehl přes střed spodní hrany, tedy přesně tam, kde stojí vstup pro větu.
 * `Build the world` bylo vidět, ale nešlo kliknout: Playwright hlásil
 * `witness-preview … intercepts pointer events` a tři sady stály červené.
 * V tomhle repozitáři je to **počtvrté tatáž vada** — překryv v rohu, který okem
 * nevidíš, protože panel je průsvitný a člověk se zrovna dívá jinam.
 *
 * Proto zásahová zkouška, ne screenshot, a proto nad **postaveným světem**:
 * dokud svět nestojí, jsou čtyři z pěti panelů prázdné a sloupec nulově vysoký,
 * takže by se nemělo co překrýt a test by prošel nad ničím.
 */
test('otevřená zásuvka nesahá na dok ani na herní ovládání', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/classic');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });
  await page.getByTestId('inspect-toggle').click();
  await expect(page.getByTestId('inspect')).toHaveAttribute('data-open', 'true');

  // Věta ze zmrazeného korpusu — panely mají mít co ukazovat, jinak se neměří nic.
  await page.getByTestId('prompt-input').fill(FROZEN_PROMPT);
  await page.getByTestId('prompt-submit').click();
  await page.waitForFunction(() => window.__worldsmith!.entities().length > 0, undefined, {
    timeout: 60_000,
  });
  await expect(page.getByTestId('witness-preview')).toBeVisible({ timeout: 30_000 });

  const hits = await page.evaluate(
    (ids) =>
      ids.map((id) => {
        const node = document.querySelector(`[data-testid="${id}"]`);
        if (node === null) return { id, reached: false, blockedBy: 'chybí' };
        const box = node.getBoundingClientRect();
        const top = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
        return {
          id,
          reached: top !== null && (top === node || node.contains(top)),
          // Kdo zásah sebral. Bez toho hlásí pád jen `false` a příčina se hledá ručně.
          blockedBy:
            top === null
              ? 'nic'
              : (top.closest('[data-testid]')?.getAttribute('data-testid') ?? top.tagName),
        };
      }),
    ['prompt-input', 'prompt-submit', 'game-restart', 'inspect-toggle'],
  );

  expect(
    hits.filter((hit) => !hit.reached),
    `otevřená zásuvka bere kliknutí: ${JSON.stringify(hits)}`,
  ).toEqual([]);
});
