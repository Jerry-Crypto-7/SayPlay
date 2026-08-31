import { mkdirSync } from 'node:fs';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { expect, test } from '@playwright/test';

import { GALLERY_IDS } from '../evals/shape/gallery';

/**
 * Cena každého tvaru **na stránce, která zároveň kreslí** — druhá podmínka,
 * kterou `/dev/mesh-budget` schválně nemá. Report čte
 * `gallery-page-cost.test.ts` a soudí podle něj strop `MESH_DETAIL.high`.
 */
const PAGE_COST_PATH = join('evals', 'shape', 'gallery-page-cost.json');

/**
 * `/gallery` je stránka brány K1 (P13 `HALT H1`) — člověk se na ni dívá a soudí
 * dvanáct tvarů okem. Stroj o nich umí říct jen jednu věc, a je to ta, na které
 * celý ten soud stojí: **stojí kus pod svým vlastním popiskem?**
 *
 * Popisky jsou pevná dvanáctibuňková HTML mřížka, kusy se sázejí do plátna, jak
 * dojdou z meshovací fronty. Dokud se buňka počítala z délky hotového pole,
 * posunulo každé selhání celý zbytek doleva pod cizí jméno.
 *
 * **Rozdíl mezi opravou a vadou je vidět jedině v díře.** Dokud projde všech
 * dvanáct, pořadí příchodu je totožné s pořadím v galerii a obě verze kódu dají
 * totéž. Druhý test proto vyrobí díru **schválně** přes `?skip=`. První verze
 * tohohle souboru se spoléhala na to, že tři tvary spolehlivě přetahují rozpočet
 * meshingu — po zvednutí stropu 31. 8. 2026 (`T7-meshbudget`) by nepoznala nic.
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

  const times = (await root.getAttribute('data-times')) ?? '';
  console.log(`[gallery] times=${times}`);

  // Report nese i **odmítnuté** tvary, a to je celý jeho smysl. Kdyby v něm byly
  // jen ty, které prošly, příliš nízký strop by se schoval: odmítnuté by mlčely
  // a report by tvrdil, že se všechno vejde. Čas odmítnutého tvaru nese hláška —
  // worker soudí čas až po doběhnutí, takže je to skutečná naměřená hodnota.
  const rows = [
    ...(times.length === 0 ? [] : times.split(',')).map((item) => {
      const [id, ms] = item.split(':');
      return { id, ms: Number(ms), ok: true };
    }),
    ...[...failureText.matchAll(/(w+): Error: mesh took (d+) ms/g)].map((match) => ({
      id: match[1],
      ms: Number(match[2]),
      ok: false,
    })),
  ].sort((a, b) => b.ms - a.ms);

  mkdirSync(dirname(PAGE_COST_PATH), { recursive: true });
  writeFileSync(
    PAGE_COST_PATH,
    `${JSON.stringify(
      {
        measuredAt: new Date().toISOString().slice(0, 10),
        task: 'P13 T7-meshbudget',
        condition: 'gallery page, live render loop, mesh worker',
        resolution: 48,
        rows,
      },
      null,
      2,
    )}
`,
    'utf8',
  );

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

/** Tři jména rozseté po mřížce, ne tři vedle sebe — posun se pozná i uprostřed. */
const SKIPPED = ['root', 'shell', 'column'] as const;

test('keeps the survivors in place when shapes are missing', async ({ page }) => {
  test.setTimeout(240_000);

  await page.goto(`/gallery?skip=${SKIPPED.join(',')}`);

  const root = page.getByTestId('gallery-root');
  await expect(root).toHaveAttribute('data-ready', 'yes', { timeout: 180_000 });

  const cells = (await root.getAttribute('data-cells')) ?? '';
  const placed = cells.length === 0 ? [] : cells.split(',');

  // Vynechané se meshovat nesměly vůbec, jinak by díra nebyla dírou.
  const ids = placed.map((item) => item.split(':')[0]);
  for (const skipped of SKIPPED) expect(ids).not.toContain(skipped);

  // A tohle je ta vlastnost: kdo zbyl, sedí pod svým jménem. Kotel je devátý
  // v galerii, ale šestý mezi tím, co došlo — pod šestou buňkou stojí `Column`.
  expect(ids.indexOf('cauldron')).toBe(5);
  expect(GALLERY_IDS[5]).toBe('column');

  for (const item of placed) {
    const [id, cell] = item.split(':');
    expect(GALLERY_IDS[Number(cell)]).toBe(id);
  }
});
