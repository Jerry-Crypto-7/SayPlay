import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { devices, expect, test, type APIRequestContext, type Locator, type Page } from '@playwright/test';

/**
 * Tlačítka akcí hrdiny (P46A T7) na `/play/[id]`: hra s `abilities` ukáže
 * 1–2 kola s ikonou a popiskem vpravo dole, J stiskne akci A, K akci B.
 * Jádro akce hraje (jednotkové testy `src/play/arcade/abilities`), ale jen
 * sestavená aplikace pozná, jestli tlačítko leží, kde se dá stisknout, a jestli
 * stisk dojde do hry. Rychlá verze akce z věty zatím nevybírá (T8), proto se
 * posílá hotový spec: fixture + `abilities`.
 *
 * Krádež potřebuje věc v dosahu. Robot ověřovače hraje „rukou“ (`byHand`) a ve
 * chvíli, kdy by sám krádež stiskl, ji místo něj stiskne test – klávesou K, na
 * telefonu ťukem na tlačítko Grab.
 */

const ACTION_A = 1 << 9;
const ACTION_B = 1 << 10;

/**
 * Sloveso věty na tlačítku (P47B T10): „dodges“ dá akci dash slovo Dodge. Rychlá verze z věty je běžec
 * s padajícími žaludy (díl `hazard`); první dash, který robot chce, je žalud nad hrdinou (změřeno 15. 10.,
 * semínka 1–5: `thing:part_0` 0,5–1,5 m před hrdinou a padá).
 */
const SQUIRREL = 'A squirrel runs and dodges falling acorns';

const RABBIT = {
  fixture: 'runner.json',
  title: 'A rabbit steals carrots and runs from a fox',
  addons: ['chaser'],
  abilities: ['strike', 'grab'],
} as const;

/**
 * Tři kola ve sloupci: střelba doplňku a dvě akce – na telefonu se nesmí překrýt s ničím.
 * Běžec, protože skákačka s dashem i štítem zatím ověřením slovesa neprojde (R4).
 */
const GUNNER = {
  fixture: 'runner.json',
  title: 'a knight runs, shoots, dashes and blocks',
  addons: ['shoot'],
  abilities: ['dash', 'shield'],
} as const;

/** Stará hra bez akcí: HUD beze změny, J dál střílí. */
const PLAIN = {
  fixture: 'runner.json',
  title: 'a runner shoots the zombies',
  addons: ['shoot'],
  abilities: [],
} as const;

type Game = typeof RABBIT | typeof GUNNER | typeof PLAIN;

interface HandProbe {
  start(): void;
  byHand(on: boolean): void;
  botWants(): { readonly axis: number; readonly buttons: number } | null;
  hold(axis: number): void;
  press(buttons: number): void;
  tickByHand(): { readonly runState: string; readonly items: number; readonly health: number };
  inputs(): readonly { readonly buttons: number }[];
}

let people = 0;

async function publish(request: APIRequestContext, game: Game): Promise<string> {
  const base = JSON.parse(readFileSync(join(process.cwd(), 'src/play/arcade/__fixtures__', game.fixture), 'utf8')) as Record<string, unknown>;
  const spec = { ...base, title: game.title, addons: [...game.addons], ...(game.abilities.length > 0 ? { abilities: [...game.abilities] } : {}) };
  // Každá hra z vlastní adresy: strop `/api/play/*` počítá požadavky na adresu.
  const response = await request.post('/api/play/games', { data: { spec }, headers: { 'x-forwarded-for': `198.51.100.${String(160 + (people += 1))}` } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

/** Hra z věty rychlou verzí, jako ji pošle domovská obrazovka. */
async function publishSentence(request: APIRequestContext, sentence: string): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence }, headers: { 'x-forwarded-for': `198.51.100.${String(160 + (people += 1))}` } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

/**
 * Robot hraje rukou až do chvíle, kdy chce dash (akce A) – žalud padá na hrdinu; tehdy stiskne `press`
 * (nebo nic) a dalších 40 tiků hraje robot bez dashe. Vrátí zdraví před tou chvílí, nejnižší zdraví potom
 * a zda hra dostala bit akce A.
 */
async function throughAcorn(page: Page, press: (() => Promise<void>) | null): Promise<{ readonly before: number; readonly after: number; readonly pressed: boolean }> {
  const before = await page.evaluate((wanted) => {
    const shell = window.__playShell as unknown as HandProbe;
    shell.start();
    shell.byHand(true);
    let health = -1;
    for (let tick = 0; tick < 5400; tick += 1) {
      const wants = shell.botWants() ?? { axis: 0, buttons: 0 };
      shell.hold(wants.axis);
      shell.press(wants.buttons & ~wanted);
      if ((wants.buttons & wanted) !== 0) return health;
      const now = shell.tickByHand();
      if (now.runState !== 'running') return null;
      health = now.health;
    }
    return null;
  }, ACTION_A);
  expect(before, 'robot nikdy nechtěl dash').not.toBeNull();
  if (press !== null) await press();
  const after = await page.evaluate((wanted) => {
    const shell = window.__playShell as unknown as HandProbe;
    // Tik stisku: pohyb robota už zapsal `throughAcorn`, stisk akce test (nebo nic).
    let health = shell.tickByHand().health;
    for (let tick = 1; tick < 40; tick += 1) {
      const wants = shell.botWants() ?? { axis: 0, buttons: 0 };
      shell.hold(wants.axis);
      shell.press(wants.buttons & ~wanted);
      const now = shell.tickByHand();
      health = Math.min(health, now.health);
      if (now.runState !== 'running') break;
    }
    return { health, pressed: shell.inputs().some((input) => (input.buttons & wanted) !== 0) };
  }, ACTION_A);
  return { before: before!, after: after.health, pressed: after.pressed };
}

/** Bez stisku žalud hrdinu zasáhne (kontrola), se stiskem `press` jím projde bez ztráty života. */
async function expectDodgeThroughAcorn(page: Page, url: string, press: () => Promise<void>): Promise<void> {
  const hit = await throughAcorn(page, null);
  expect(hit.pressed).toBe(false);
  expect(hit.after, 'bez dashe žalud vezme život').toBeLessThan(hit.before);
  await openGame(page, url);
  const dodged = await throughAcorn(page, press);
  expect(dodged.pressed, 'stisk došel do hry jako akce A').toBe(true);
  expect(dodged.after, 'dash projde žaludem bez ztráty života').toBe(dodged.before);
}

function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
  return errors;
}

async function openGame(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByTestId('arcade-stage')).toBeVisible();
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
}

/**
 * Robot hraje rukou, dokud nechce stisknout `bit`; jeho pohyb pro ten tik zapíše a tik nechá
 * na testu. Vrátí počet věcí před tikem, nebo `null`, když hra skončila dřív.
 */
function untilBotWants(page: Page, bit: number): Promise<number | null> {
  return page.evaluate((wanted) => {
    const shell = window.__playShell as unknown as HandProbe;
    let items = 0;
    for (let tick = 0; tick < 5400; tick += 1) {
      const wants = shell.botWants() ?? { axis: 0, buttons: 0 };
      shell.hold(wants.axis);
      shell.press(wants.buttons & ~wanted);
      if ((wants.buttons & wanted) !== 0) return items;
      const now = shell.tickByHand();
      if (now.runState !== 'running') return null;
      items = now.items;
    }
    return null;
  }, bit);
}

/** Stiskne akci B (`press`) ve chvíli, kdy ji chce robot, a vrátí, zda krádež zvedla počet věcí. */
async function grabsWith(page: Page, press: () => Promise<void>): Promise<boolean> {
  await page.evaluate(() => {
    const shell = window.__playShell as unknown as HandProbe;
    shell.start();
    shell.byHand(true);
  });
  // Robot krade na předpověď dosahu; ne každý pokus musí věc zastihnout.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const before = await untilBotWants(page, ACTION_B);
    if (before === null) return false;
    await press();
    const after = await page.evaluate(() => (window.__playShell as unknown as HandProbe).tickByHand().items);
    if (after > before) return true;
  }
  return false;
}

type Box = { readonly x: number; readonly y: number; readonly width: number; readonly height: number };
const overlaps = (a: Box, b: Box): boolean => a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

/** Kola akcí leží vpravo dole a nepřekrývají žádné jiné viditelné tlačítko hry. */
async function expectClearOfControls(page: Page, abilities: Locator): Promise<void> {
  const viewport = page.viewportSize()!;
  const own = await abilities.evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-testid')));
  const rest: { id: string; box: Box }[] = [];
  for (const button of await page.locator('button:visible').all()) {
    const id = (await button.getAttribute('data-testid')) ?? (await button.getAttribute('aria-label')) ?? (await button.innerText());
    const box = await button.boundingBox();
    if (box !== null && box.width > 0 && !own.includes(id)) rest.push({ id, box });
  }
  for (const ability of await abilities.all()) {
    const box = (await ability.boundingBox())!;
    const id = await ability.getAttribute('data-testid');
    expect(box.x + box.width / 2, `${id} vpravo`).toBeGreaterThan(viewport.width / 2);
    expect(box.y + box.height / 2, `${id} dole`).toBeGreaterThan(viewport.height / 2);
    expect(box.width, `${id} aspoň 50 px`).toBeGreaterThanOrEqual(50);
    for (const other of rest) expect(overlaps(box, other.box), `${id} překrývá ${other.id}`).toBe(false);
    for (const sibling of await abilities.all()) {
      if (sibling === ability || (await sibling.getAttribute('data-testid')) === id) continue;
      expect(overlaps(box, (await sibling.boundingBox())!), `${id} překrývá jinou akci`).toBe(false);
    }
  }
}

test.describe('/play/[id] – hero action buttons on desktop', () => {
  test('the rabbit game shows Strike and Grab, and K grabs a carrot', async ({ page, request }) => {
    test.setTimeout(180_000);
    const url = await publish(request, RABBIT);
    const errors = watchErrors(page);
    await openGame(page, url);
    const grab = page.getByTestId('arcade-ability-grab');
    await expect(grab).toBeVisible();
    await expect(grab).toHaveText('Grab');
    await expect(grab).toHaveAttribute('aria-keyshortcuts', 'K');
    await expect(page.getByTestId('arcade-ability-strike')).toHaveAttribute('aria-keyshortcuts', 'J');
    await expect(page.getByTestId('arcade-fire')).toHaveCount(0);
    expect(await grabsWith(page, () => page.keyboard.press('k'))).toBe(true);
    expect(errors).toEqual([]);
  });

  test('a game with the shoot addon keeps Fire under the two action buttons', async ({ page, request }) => {
    test.setTimeout(120_000);
    const url = await publish(request, GUNNER);
    await openGame(page, url);
    await expect(page.getByTestId('arcade-fire')).toBeVisible();
    await expectClearOfControls(page, page.locator('[data-testid^="arcade-ability-"]'));
    // J patří akci A, ne střelbě: stisk zapíše bit A a žádnou ránu.
    await page.evaluate(() => (window.__playShell as unknown as HandProbe).start());
    await page.keyboard.press('j');
    const pressed = () => page.evaluate(() => (window.__playShell as unknown as HandProbe).inputs().map((input) => input.buttons));
    await expect.poll(async () => (await pressed()).some((buttons) => (buttons & (1 << 9)) !== 0)).toBe(true);
    expect((await pressed()).some((buttons) => (buttons & (1 << 6)) !== 0)).toBe(false);
  });

  test('a drafted fight game puts Strike on J instead of the Attack button', async ({ page, request }) => {
    test.setTimeout(120_000);
    // Rychlá verze (P46A T8): díl souboje s goblinem pod obalem dílů, úder je akce A.
    const response = await request.post('/api/play/games', { data: { sentence: 'A knight runs through a castle and punches goblins' }, headers: { 'x-forwarded-for': `198.51.100.${String(160 + (people += 1))}` } });
    expect(response.status(), await response.text()).toBeLessThan(300);
    const errors = watchErrors(page);
    await openGame(page, ((await response.json()) as { url: string }).url);
    await expect(page.getByTestId('arcade-ability-strike')).toHaveAttribute('aria-keyshortcuts', 'J');
    // Sloveso věty na tlačítku (P47B T10): „punches“ → Punch.
    await expect(page.getByTestId('arcade-ability-strike')).toHaveText('Punch');
    await expect(page.getByTestId('arcade-attack')).toHaveCount(0);
    expect(errors).toEqual([]);
  });

  test('the squirrel game shows Dodge, and J passes through a falling acorn', async ({ page, request }) => {
    test.setTimeout(180_000);
    const url = await publishSentence(request, SQUIRREL);
    const errors = watchErrors(page);
    await openGame(page, url);
    const dodge = page.getByTestId('arcade-ability-dash');
    await expect(dodge).toHaveText('Dodge');
    await expect(dodge).toHaveAttribute('aria-keyshortcuts', 'J');
    await expectDodgeThroughAcorn(page, url, () => page.keyboard.press('j'));
    expect(errors).toEqual([]);
  });

  test('an old game without abilities has no action buttons and J still fires', async ({ page, request }) => {
    test.setTimeout(120_000);
    const url = await publish(request, PLAIN);
    await openGame(page, url);
    await expect(page.getByTestId('arcade-fire')).toBeVisible();
    await expect(page.locator('[data-testid^="arcade-ability-"]')).toHaveCount(0);
    await page.evaluate(() => (window.__playShell as unknown as HandProbe).start());
    await page.keyboard.press('j');
    await expect.poll(() => page.evaluate(() => (window.__playShell as unknown as HandProbe).inputs().some((input) => (input.buttons & (1 << 6)) !== 0))).toBe(true);
  });
});

const { defaultBrowserType: _browser, ...PIXEL_7 } = devices['Pixel 7'];

test.describe('/play/[id] – hero action buttons on a phone', () => {
  test.use({ ...PIXEL_7, hasTouch: true });

  test('the rabbit game puts Grab bottom right and a tap grabs a carrot', async ({ page, request }, info) => {
    test.setTimeout(180_000);
    const url = await publish(request, RABBIT);
    const errors = watchErrors(page);
    await openGame(page, url);
    const abilities = page.locator('[data-testid^="arcade-ability-"]');
    await expect(abilities).toHaveCount(2);
    await expectClearOfControls(page, abilities);
    await info.attach('rabbit-phone', { body: await page.screenshot(), contentType: 'image/png' });
    expect(await grabsWith(page, () => page.getByTestId('arcade-ability-grab').tap())).toBe(true);
    expect(errors).toEqual([]);
  });

  test('three round buttons (Fire, Dash, Shield) stack without overlapping', async ({ page, request }, info) => {
    test.setTimeout(120_000);
    const url = await publish(request, GUNNER);
    await openGame(page, url);
    await expect(page.getByTestId('arcade-fire')).toBeVisible();
    const abilities = page.locator('[data-testid^="arcade-ability-"]');
    await expect(abilities).toHaveCount(2);
    const fire = (await page.getByTestId('arcade-fire').boundingBox())!;
    for (const ability of await abilities.all()) expect(overlaps((await ability.boundingBox())!, fire)).toBe(false);
    await expectClearOfControls(page, abilities);
    await info.attach('gunner-phone', { body: await page.screenshot(), contentType: 'image/png' });
  });

  test('the squirrel game shows Dodge, and a tap on it passes through a falling acorn', async ({ page, request }, info) => {
    test.setTimeout(180_000);
    const url = await publishSentence(request, SQUIRREL);
    const errors = watchErrors(page);
    await openGame(page, url);
    const dodge = page.getByTestId('arcade-ability-dash');
    await expect(dodge).toHaveText('Dodge');
    await expectClearOfControls(page, page.locator('[data-testid^="arcade-ability-"]'));
    await info.attach('squirrel-phone', { body: await page.screenshot(), contentType: 'image/png' });
    await expectDodgeThroughAcorn(page, url, () => page.getByTestId('arcade-ability-dash').tap());
    expect(errors).toEqual([]);
  });
});
