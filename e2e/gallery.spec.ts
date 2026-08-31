import { expect, test } from '@playwright/test';

import { GALLERY_IDS } from '../evals/shape/gallery';

/**
 * `/gallery` je stránka brány K1 (P13 `HALT H1`) — člověk se na ni dívá a soudí
 * dvanáct tvarů okem. Stroj o nich umí říct jen jednu věc, a je to ta, na které
 * celý ten soud stojí: **stojí kus pod svým vlastním popiskem?**
 *
 * Popisky jsou pevná dvanáctibuňková HTML mřížka, kusy se sázejí do plátna, jak
 * dojdou z meshovací fronty. Dokud se buňka počítala z délky hotového pole,
 * posunulo každé selhání celý zbytek doleva pod cizí jméno.
 *
 * **Test rozliší opravu od vady jen tehdy, když se aspoň jeden tvar nezmešuje**
 * — dokud projde všech dvanáct, je pořadí příchodu totožné s pořadím v galerii
 * a obě verze kódu dají totéž. V referenčním prostředí (headless SwiftShader)
 * tři tvary spolehlivě přetahují rozpočet meshingu, takže rozliší; na stroji
 * s GPU nemusí. Proto se počet vypisuje.
 *
 * Snímky se zároveň ukládají, aby brána měla na co se dívat bez ručního
 * spouštění serveru. Čtyři po 90°, protože měřidlo rozmanitosti soudí siluety
 * ze čtyř kamer a člověk má mít stejnou příležitost; otáčení jede 0,06 otáčky
 * za vteřinu, takže čtvrtina trvá 4,17 s.
 */

const QUARTER_TURN_MS = 4_170;

test('every meshed shape sits in the cell its own label sits in', async ({ page }) => {
  test.setTimeout(240_000);

  await page.goto('/gallery');

  const root = page.getByTestId('gallery-root');
  await expect(root).toHaveAttribute('data-ready', 'yes', { timeout: 180_000 });

  const cells = (await root.getAttribute('data-cells')) ?? '';
  const placed = cells.length === 0 ? [] : cells.split(',');

  const failures = page.getByTestId('gallery-failures');
  const failureText = (await failures.count()) > 0 ? await failures.innerText() : '';
  console.log(`[gallery] meshed ${placed.length} of ${GALLERY_IDS.length}`);
  if (failureText !== '') console.log(`[gallery] failures: ${failureText}`);

  expect(placed.length).toBeGreaterThan(0);

  for (const item of placed) {
    const [id, cell] = item.split(':');
    expect(GALLERY_IDS[Number(cell)]).toBe(id);
  }

  for (let quarter = 0; quarter < 4; quarter += 1) {
    await page.screenshot({ path: `docs/gallery-${quarter * 90}.png` });
    if (quarter < 3) await page.waitForTimeout(QUARTER_TURN_MS);
  }
});
