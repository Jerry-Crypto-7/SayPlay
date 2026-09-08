import { expect, type Page } from '@playwright/test';

/**
 * Otevře Inspect zásuvku a počká, až v ní panely opravdu stojí.
 *
 * Od P13 vlny 0 T1 nejsou `Program`, `Timeline`, `WitnessPreview`,
 * `RepairRounds` ani `ModelProgress` ve výchozím DOM — plátno má celý viewport
 * a vnitřnosti potrubí se otevírají z jednoho diskrétního bodu (design book
 * §15.3, §15.5). Sady, které ty panely měří, si je tedy musí nejdřív vyžádat.
 *
 * **Není to `display: none`, takže to nejde obejít.** Zavřená zásuvka panely
 * doopravdy odpojí; bez tohohle kroku je `getByTestId` nenajde a čekání vyprší.
 *
 * **Odpojí i `window.__pipeline`** — ten publikuje `WitnessPreview`, tedy jeden
 * z těch panelů. Sada, která na to API sahá, musí zásuvku otevřít **dřív**, než
 * napíše první větu, ne až se dívá na výsledek.
 *
 * Volá se **jednou za stránku**. Přepínač přepíná, takže druhé zavolání by
 * zásuvku zase zavřelo — proto se `open` nejdřív čte a klikne se jen tehdy,
 * když je zavřená.
 */
export async function openInspect(page: Page): Promise<void> {
  const drawer = page.getByTestId('inspect');
  if ((await drawer.getAttribute('data-open')) !== 'true') {
    await page.getByTestId('inspect-toggle').click();
  }
  await expect(drawer).toHaveAttribute('data-open', 'true');
  // `toHaveCount`, ne `toBeVisible`: čtyři z pěti panelů mají nad prázdným
  // světem prázdný stav a nevykreslí nic, takže je otevřená zásuvka **nulově
  // vysoká** a Playwright ji hlásí jako skrytou. Otázka tady zní „je zásuvka
  // otevřená", ne „stojí v ní zrovna teď panel" — na to se ptají volající.
  await expect(page.getByTestId('inspect-panels')).toHaveCount(1);
}
