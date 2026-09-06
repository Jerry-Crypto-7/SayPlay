import { expect, test } from '@playwright/test';

import { openInspect } from './inspect';

/**
 * Oracle úlohy T38 na obrazovce — **dvě budoucnosti vedle sebe, ne o nich věta**.
 *
 * Do téhle úlohy panel času dělal `controller.axis = result.timeline`, tedy
 * odbočení předchozí větev **přepsalo**. Vypadalo to úplně stejně: tik se
 * přepočítal, hash se změnil, hlášení dole se objevilo. Chybějící větev nemá jak
 * být vidět, dokud se nemá kde zobrazit — proto tenhle test počítá uzly stromu a
 * ne řetězce v hlášení.
 *
 * **Věta je doslovný text `C01` ze zmrazeného korpusu**, protože offline větev
 * hledá přesnou shodu, a je to jediný z měřených zmrazených světů, kde po tiku
 * 40 vůbec nějaké pravidlo spustí (naměřeno 21. 8. 2026).
 */

const FROZEN_PROMPT = 'a puzzle room where I have to find three keys to open the exit door';

const BRANCH_TICK = 40;
const HORIZON = 200;

async function buildWorld(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/classic');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });
  // Od P13 vlny 0 T1 osa nestojí na výchozí obrazovce — otevírá se z Inspectu.
  await openInspect(page);
  await page.getByTestId('prompt-input').fill(FROZEN_PROMPT);
  await page.getByTestId('prompt-submit').click();
  await page.waitForFunction(() => window.__worldsmith!.entities().length > 0, undefined, { timeout: 60_000 });
  await expect(page.getByTestId('timeline')).toHaveAttribute('data-tick', String(HORIZON));
}

test('odbočení přidá uzel, nechá ten původní stát a dá se mezi nimi přepínat', async ({ page }) => {
  test.setTimeout(180_000);
  await buildWorld(page);

  const panel = page.getByTestId('timeline');
  const nodes = page.getByTestId('branch-node');

  // Kořen je větev jako každá jiná. Jediný uzel je legitimní stav, ne prázdno.
  await expect(nodes).toHaveCount(1);
  const root = nodes.first();
  await expect(root).toHaveAttribute('data-branch-id', 'origin');
  await expect(root).toHaveAttribute('data-parent-id', '');
  await expect(root).toHaveAttribute('aria-pressed', 'true');
  const originHash = await root.getAttribute('data-hash');
  // Mount doběhne na horizont a **zapečetí**, takže kořen o svém konci mluví
  // dřív, než z něj někdo odbočí.
  expect(originHash).not.toBe('');

  await page.getByTestId('timeline-scrub').fill(String(BRANCH_TICK));
  await expect(panel).toHaveAttribute('data-tick', String(BRANCH_TICK));
  await page.getByTestId('timeline-branch').click();
  await expect(panel).toHaveAttribute('data-tick', String(HORIZON));

  // Strom **roste**. Tohle je celá vada, kterou T38 opravuje.
  await expect(nodes).toHaveCount(2);
  const branched = nodes.nth(1);
  await expect(branched).toHaveAttribute('data-parent-id', 'origin');
  await expect(branched).toHaveAttribute('data-at-tick', String(BRANCH_TICK));
  await expect(branched).toHaveAttribute('aria-pressed', 'true');
  expect(await branched.getAttribute('data-rule')).not.toBe('');

  const branchHash = await branched.getAttribute('data-hash');
  expect(branchHash).not.toBe('');
  // Dvě budoucnosti, ne dvě jména téže.
  expect(branchHash).not.toBe(originHash);

  // A tohle je hluboká kopie na obrazovce: `rebranchAt` runtime kořene přetočil
  // na tik 40, a přesto jeho uzel pořád nese hash horizontu. S mělkou pečetí by
  // se tady obě čísla srovnala a strom by tvrdil, že se nic nezměnilo.
  await expect(root).toHaveAttribute('data-hash', originHash ?? '');
  await expect(root).toHaveAttribute('aria-pressed', 'false');

  // Uzly nejsou jen výpis — jsou to dveře zpátky do té druhé budoucnosti.
  await root.click();
  await expect(root).toHaveAttribute('aria-pressed', 'true');
  await expect(branched).toHaveAttribute('aria-pressed', 'false');
  // Kořen stojí tam, kam ho odbočení přetočilo. Panel to přizná, místo aby
  // ukazoval tik té druhé větve.
  await expect(panel).toHaveAttribute('data-tick', String(BRANCH_TICK));

  await branched.click();
  await expect(branched).toHaveAttribute('aria-pressed', 'true');
  await expect(panel).toHaveAttribute('data-tick', String(HORIZON));
});

test('nový běh strom smaže, místo aby k němu přirostl', async ({ page }) => {
  test.setTimeout(180_000);
  await buildWorld(page);

  const nodes = page.getByTestId('branch-node');
  await page.getByTestId('timeline-scrub').fill(String(BRANCH_TICK));
  await page.getByTestId('timeline-branch').click();
  await expect(nodes).toHaveCount(2);

  // `fresh()` je cesta na začátek, ne další odbočka. Kdyby úložiště jen
  // přirůstalo, porotce by po restartu viděl strom cizího běhu.
  await page.evaluate(() => {
    window.__timeline!.fresh();
    window.__timeline!.runTo(window.__timeline!.horizon);
  });
  await expect(nodes).toHaveCount(1);
  await expect(nodes.first()).toHaveAttribute('data-branch-id', 'origin');
  await expect(nodes.first()).toHaveAttribute('aria-pressed', 'true');
});
