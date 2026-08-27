import { expect, test, type Page } from '@playwright/test';

import { FOLLOW_OFFSET } from '../src/components/viewer/FollowCamera';

/**
 * Oracle úlohy T5 vlny 3 — **porotce si smí svět otočit, ale nemusí**.
 *
 * Dvě věci naráz, a každou shodí jiná vada:
 *
 * 1. **Výchozí stav zůstává sledovací.** Tiše zapnutý volný režim by shodil
 *    `e2e/camera.spec.ts` až v nějaké pozdější úloze a vypadalo by to jako cizí
 *    regrese. Tady se to pojmenuje na místě.
 * 2. **Ve volném režimu hýbe kamerou tažení, a jedině tažení.** Kdyby jí sahal
 *    i dojezd, přetahoval by ji zpátky a působilo by to jako lepkavá myš — což
 *    vypadá jako pomalý stroj, ne jako vada kódu.
 *
 * Věta je záměrně mimo zmrazený korpus: doslovná shoda by šla přes zaznamenanou
 * odpověď, kdežto takhle ji obslouží deterministický rozpoznávač tvarů — tedy
 * ta cesta, po které pojede porotce s vlastní větou. **Nemačká se přitom žádná
 * klávesa, takže postava celou dobu stojí** a odstup kamery se dá měřit přesně;
 * kdyby chodila, ustálené zpoždění dojezdu by bylo skoro dvě pole.
 */
const SENTENCE = 'a quiet cellar with three keys and a locked exit door';

/** Jak přesně musí kamera sedět na stojící postavě. Dojezd doběhne prvním snímkem. */
const SEATED_TOLERANCE = 0.05;

/** O kolik nejmíň musí tažení kamerou pohnout, aby to nebyl šum. */
const MIN_TRAVEL = 1;

interface Seat {
  readonly camera: { x: number; y: number; z: number };
  readonly avatar: { x: number; y: number; z: number };
}

async function build(page: Page): Promise<void> {
  await page.goto('/');
  await page.waitForFunction(() => window.__game !== undefined, undefined, { timeout: 60_000 });

  await page.getByTestId('prompt-input').fill(SENTENCE);
  await page.getByTestId('prompt-submit').click();
  await page.waitForFunction(() => window.__game!.targets().length > 0, undefined, {
    timeout: 60_000,
  });
  await page.waitForFunction(() => window.__game!.state() === 'playing', undefined, {
    timeout: 60_000,
  });
}

async function seat(page: Page): Promise<Seat> {
  return page.evaluate(() => {
    const bridge = window.__worldsmith!;
    const hero = bridge.entities().find((entity) => entity.visual === 'avatar');
    return {
      camera: bridge.camera(),
      avatar:
        hero === undefined
          ? { x: Number.NaN, y: Number.NaN, z: Number.NaN }
          : { x: hero.position.x, y: hero.position.y, z: hero.position.z },
    };
  });
}

function offsetError({ camera, avatar }: Seat): number {
  return Math.hypot(
    camera.x - avatar.x - FOLLOW_OFFSET.x,
    camera.y - avatar.y - FOLLOW_OFFSET.y,
    camera.z - avatar.z - FOLLOW_OFFSET.z,
  );
}

function distance({ camera, avatar }: Seat): number {
  return Math.hypot(camera.x - avatar.x, camera.y - avatar.y, camera.z - avatar.z);
}

/** Táhne přes střed plátna. Rohy patří panelům, střed je vždycky svět. */
async function drag(page: Page, dx: number, dy: number): Promise<void> {
  const box = await page.getByTestId('stage-canvas').boundingBox();
  if (box === null) throw new Error('plátno nemá rozměr');

  const from = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  // Po krocích, ne jedním skokem: obsluha počítá rozdíl proti minulé události,
  // takže jediný `move` sice dá týž výsledek, ale o průběžném tažení neřekne nic.
  for (let step = 1; step <= 4; step += 1) {
    await page.mouse.move(from.x + (dx * step) / 4, from.y + (dy * step) / 4);
  }
  await page.mouse.up();
}

test('výchozí stav je sledovací a přepínač z něj pustí kameru diváku', async ({ page }) => {
  test.setTimeout(240_000);

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await build(page);

  const toggle = page.getByTestId('camera-mode');
  await expect(toggle, 'přepínač kamery na stránce se světem chybí').toBeVisible();
  await expect(toggle, 'volný režim je zapnutý hned po načtení').toHaveAttribute(
    'aria-pressed',
    'false',
  );

  // Postava stojí, takže dojezd je doběhnutý a odstup musí sedět přesně.
  await page.waitForFunction(() => window.__worldsmith!.tick() > 2, undefined, { timeout: 60_000 });
  const followed = await seat(page);
  expect(
    offsetError(followed),
    `kamera nesedí na navrženém odstupu: ${JSON.stringify(followed)}`,
  ).toBeLessThan(SEATED_TOLERANCE);

  await toggle.click();
  await expect(toggle, 'přepnutí se neprojevilo ve stavu tlačítka').toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await drag(page, 240, 0);
  const turned = await seat(page);

  const travel = Math.hypot(
    turned.camera.x - followed.camera.x,
    turned.camera.y - followed.camera.y,
    turned.camera.z - followed.camera.z,
  );
  expect(travel, 'tažením se kamera nehnula — volný režim nic neovládá').toBeGreaterThan(MIN_TRAVEL);

  // Obíhá se kolem postavy, takže vzdálenost od ní zůstává. Bez toho by tažení
  // mohlo kameru odsunout pryč a svět by z ní zmizel.
  expect(distance(turned), 'tažení změnilo vzdálenost od postavy, místo aby ji obešlo').toBeCloseTo(
    distance(followed),
    3,
  );
  expect(turned.camera.y, 'kamera se protočila pod podlahu').toBeGreaterThan(0);

  // A hlavně: dojezd ji nesmí táhnout zpátky. Kdyby na kameru ve volném režimu
  // sahal `useFrame`, po pár snímcích by byla zase za postavou.
  await page.waitForTimeout(500);
  const held = await seat(page);
  expect(
    Math.hypot(
      held.camera.x - turned.camera.x,
      held.camera.y - turned.camera.y,
      held.camera.z - turned.camera.z,
    ),
    'kamera se po tažení sama vrátila — do volného režimu sahá dojezd',
  ).toBeLessThan(SEATED_TOLERANCE);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');

  // Návrat do sledování dojezd zahodí, takže odstup dosedne, ne doplazí se.
  await page.waitForFunction(
    ({ tolerance, offset }) => {
      const bridge = window.__worldsmith!;
      const hero = bridge.entities().find((entity) => entity.visual === 'avatar');
      if (hero === undefined) return false;
      const at = bridge.camera();
      return (
        Math.hypot(
          at.x - hero.position.x - offset.x,
          at.y - hero.position.y - offset.y,
          at.z - hero.position.z - offset.z,
        ) < tolerance
      );
    },
    { tolerance: SEATED_TOLERANCE, offset: FOLLOW_OFFSET },
    { timeout: 30_000 },
  );

  expect(errors, `stránka spadla: ${errors.join(' | ')}`).toEqual([]);
});

test('tažení ve sledovacím režimu kamerou nehne', async ({ page }) => {
  test.setTimeout(240_000);

  await build(page);
  await page.waitForFunction(() => window.__worldsmith!.tick() > 2, undefined, { timeout: 60_000 });

  const before = await seat(page);
  await drag(page, 240, 60);
  const after = await seat(page);

  expect(
    Math.hypot(
      after.camera.x - before.camera.x,
      after.camera.y - before.camera.y,
      after.camera.z - before.camera.z,
    ),
    'kamera se dá otáčet i bez přepnutí — volný režim je zapnutý pořád',
  ).toBeLessThan(SEATED_TOLERANCE);
});
