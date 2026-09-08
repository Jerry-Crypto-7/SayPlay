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

/**
 * Nejnižší jas, od kterého se pixel počítá za hlínu. Pozadí je `pelagic`
 * (#07141f, jas 18), nejtmavší odvrácená stěna tvaru je pořád nad 50.
 */
const INK_LUMINANCE = 70;

/**
 * Kolik pixelů smí být mezi těžištěm hlíny a středem popisku. Buňka je při
 * 1280×720 široká 199 px, takže čtvrtina buňky je hranice, za kterou už tvar
 * čte pod cizím jménem. Tvary nejsou souměrné a otáčejí se, takže pár desítek
 * pixelů je vlastní pohyb tvaru, ne posun mřížky.
 */
const INK_TOLERANCE = 45;

/** Pod tolika pixely hlíny se buňka nesoudí — znamená to, že tam tvar není. */
const INK_MINIMUM = 400;

/**
 * Kde leží hlína proti popiskům — odečtené z plátna, ne dopočítané z rozvržení.
 *
 * Každý dost světlý pixel se přidělí **nejbližšímu popisku** a spočítá se
 * těžiště po sloupcích. Je to Voronoi nad dvanácti body, takže test nezná ani
 * rozteč buněk, ani kameru: ptá se přesně na to, co se ptá člověk v bráně K1 —
 * *je ten tvar, co vidím, pod svým vlastním jménem?* Kus posunutý k sousedovi
 * spadne do sousedovy buňky a těžiště se hne o desítky pixelů.
 */
async function measureInk(page: import('@playwright/test').Page) {
  return page.evaluate((threshold) => {
    const canvas = document.querySelector('canvas');
    if (canvas === null) throw new Error('gallery has no canvas');
    const frame = canvas.getBoundingClientRect();

    const labels = [...document.querySelectorAll('[data-testid^="gallery-label-"]')].map((node) => {
      const box = node.getBoundingClientRect();
      return {
        id: (node.getAttribute('data-testid') ?? '').replace('gallery-label-', ''),
        x: box.left + box.width / 2 - frame.left,
        y: box.top + box.height / 2 - frame.top,
      };
    });

    const copy = document.createElement('canvas');
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext('2d');
    if (context === null) throw new Error('no 2d context');
    context.drawImage(canvas, 0, 0);
    const image = context.getImageData(0, 0, copy.width, copy.height);

    // Plátno má vlastní rozlišení (dpr), popisky leží v CSS pixelech.
    const scaleX = frame.width / copy.width;
    const scaleY = frame.height / copy.height;

    const sums = labels.map(() => ({ x: 0, count: 0 }));
    for (let y = 0; y < copy.height; y += 1) {
      for (let x = 0; x < copy.width; x += 1) {
        const at = (y * copy.width + x) * 4;
        const luminance =
          0.2126 * image.data[at] + 0.7152 * image.data[at + 1] + 0.0722 * image.data[at + 2];
        if (luminance < threshold) continue;
        const cssX = x * scaleX;
        const cssY = y * scaleY;
        let best = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (let index = 0; index < labels.length; index += 1) {
          const dx = labels[index].x - cssX;
          const dy = labels[index].y - cssY;
          const distance = dx * dx + dy * dy;
          if (distance < bestDistance) {
            bestDistance = distance;
            best = index;
          }
        }
        sums[best].x += cssX;
        sums[best].count += 1;
      }
    }

    return labels.map((label, index) => ({
      id: label.id,
      labelX: label.x,
      inkX: sums[index].count === 0 ? -1 : sums[index].x / sums[index].count,
      pixels: sums[index].count,
    }));
  }, INK_LUMINANCE);
}



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

  // Odečet hlíny jede **uvnitř téhle smyčky**, ne ve vlastním testu: jedno
  // načtení galerie stojí meshování dvanácti tvarů, a čtvrtiny otáčky jsou
  // přesně to, co je u posunutého popisku potřeba proměřit. Tvar se otáčí, takže
  // se soudí **nejhorší** ze čtyř odečtů, ne první.
  const worst = new Map<string, { labelX: number; inkX: number; pixels: number }>();

  for (let quarter = 0; quarter < 4; quarter += 1) {
    await page.screenshot({ path: `docs/gallery-${quarter * 90}.png` });

    for (const cell of await measureInk(page)) {
      const drift = Math.abs(cell.inkX - cell.labelX);
      const held = worst.get(cell.id);
      if (held === undefined || drift > Math.abs(held.inkX - held.labelX)) {
        worst.set(cell.id, { labelX: cell.labelX, inkX: cell.inkX, pixels: cell.pixels });
      }
    }

    if (quarter < 3) await page.waitForTimeout(QUARTER_TURN_MS);
  }

  for (const [id, cell] of worst) {
    console.log(
      `[gallery] ${id}: label x=${cell.labelX.toFixed(1)} ink x=${cell.inkX.toFixed(1)} ` +
        `drift=${Math.abs(cell.inkX - cell.labelX).toFixed(1)} px=${cell.pixels}`,
    );
  }

  // Vynechané tvary nemají co měřit — jejich buňka je prázdná schválně.
  for (const id of placed.map((item) => item.split(':')[0])) {
    const cell = worst.get(id);
    expect(cell, `${id} nemá popisek`).toBeDefined();
    expect(cell!.pixels, `${id}: v buňce popisku není hlína`).toBeGreaterThan(INK_MINIMUM);
    expect(
      Math.abs(cell!.inkX - cell!.labelX),
      `${id}: tvar nesedí nad svým popiskem`,
    ).toBeLessThan(INK_TOLERANCE);
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
