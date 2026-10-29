import { join } from 'node:path';

import { type APIRequestContext, expect, type Page, test } from '@playwright/test';

import type { XrReport } from '../src/components/play/xr/XrRig';

/**
 * Vstup do VR (P65 T1) v emulátoru IWER od Mety: Quest 2 bez brýlí. Emulátor se vstřikuje před skripty stránky,
 * takže `navigator.xr` hlásí `immersive-vr` jako na Questu. Produkt sám emulátor nenačte (`emulate: false`).
 * Od P67 T1 rozhoduje o „Enter VR“ jen schopnost prohlížeče; `?vr=1` v adrese už nic nepřidá, `?vr=0` VR vypne.
 *
 * Výměna za AI verzi je v produktu navigace na jinou `/play/<id>` (`UpgradeBanner`, `router.replace`). Server
 * v e2e model nemá, proto se příchod hry podvrhne na `GET …/upgrade` jako v `play-upgrade.spec.ts` a míří na
 * druhou publikovanou hru z věty – bez placeného volání.
 */

const IWER_BUNDLE = join(process.cwd(), 'node_modules/iwer/build/iwer.min.js');

declare global {
  interface Window {
    IWER?: { XRDevice: new (config: unknown) => { installRuntime(options?: { forceInstall?: boolean }): void }; metaQuest2: unknown };
    /** Poslední relace, kterou stránka dostala – e2e ji ukončí jako systémové tlačítko brýlí. */
    __iwerSession?: XRSession;
  }
}

async function withQuest2(page: Page): Promise<void> {
  await page.addInitScript({ path: IWER_BUNDLE });
  await page.addInitScript(() => {
    const device = new window.IWER!.XRDevice(window.IWER!.metaQuest2);
    device.installRuntime({ forceInstall: true });
    const xr = navigator.xr!;
    const request = xr.requestSession.bind(xr);
    xr.requestSession = async (...args) => {
      const session = await request(...args);
      window.__iwerSession = session;
      return session;
    };
  });
}

interface Created {
  readonly url: string;
  readonly versionId: string;
  readonly upgrade: string;
}

async function gameFrom(request: APIRequestContext, sentence: string): Promise<Created> {
  const created = await request.post('/api/play/games', { data: { sentence } });
  expect(created.status(), await created.text()).toBeLessThan(300);
  return (await created.json()) as Created;
}

async function running(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  await page.evaluate(() => window.__playShell!.start());
}

const xr = (page: Page): Promise<XrReport | null> => page.evaluate(() => window.__playXr?.() ?? null);

/** Několik snímků v relaci: draw cally se čtou až z nakresleného snímku. */
async function drawnInVr(page: Page): Promise<void> {
  await expect.poll(async () => (await xr(page))?.calls ?? 0, { timeout: 15_000 }).toBeGreaterThan(0);
}

/**
 * Těla skriptů, které stránka stáhla. Kód XR je samostatný chunk z dynamického importu `XrRoot`; pozná se podle
 * popisku 3D panelu `EXIT_VR`, který žije jen v XR vrstvě (`XrHud.tsx`).
 */
function scriptsOf(page: Page): () => Promise<string[]> {
  const bodies: Promise<string>[] = [];
  page.on('response', (response) => {
    if (response.request().resourceType() === 'script') bodies.push(response.text().catch(() => ''));
  });
  return () => Promise.all(bodies);
}

const XR_CODE = 'Exit VR';

test.beforeEach(() => {
  // Dvě hry z věty, sestavení scény a relace se do výchozích 30 s nevejdou.
  test.setTimeout(120_000);
});

test('a browser without immersive-vr gets no Enter VR and downloads no XR code', async ({ page, request }) => {
  const scripts = scriptsOf(page);
  const game = await gameFrom(request, 'A hamster escapes a supermarket while a giant Roomba hunts it.');
  await page.goto(game.url);
  await running(page);
  await page.waitForLoadState('networkidle').catch(() => undefined);
  await expect(page.getByTestId('play-hud-restart')).toBeVisible();
  await expect(page.getByTestId('enter-vr')).toHaveCount(0);
  expect(await xr(page)).toBeNull();
  const bodies = await scripts();
  expect(bodies.length).toBeGreaterThan(0);
  expect(bodies.filter((body) => body.includes(XR_CODE))).toHaveLength(0);
});

test('a headset browser gets Enter VR without ?vr=1, and ?vr=0 switches it off', async ({ page, request }) => {
  await withQuest2(page);
  const scripts = scriptsOf(page);
  const game = await gameFrom(request, 'A hamster escapes a supermarket while a giant Roomba hunts it.');
  await page.goto(game.url);
  await running(page);
  await expect(page.getByTestId('enter-vr')).toBeVisible({ timeout: 15_000 });
  // Značka kódu XR platí: tady, kde se XR načetlo, ji aspoň jeden stažený skript nese.
  expect((await scripts()).some((body) => body.includes(XR_CODE))).toBe(true);

  await page.goto(`${game.url}?vr=0`);
  await running(page);
  await expect(page.getByTestId('play-hud-restart')).toBeVisible();
  await expect(page.getByTestId('enter-vr')).toHaveCount(0);
  expect(await xr(page)).toBeNull();
});

test('Enter VR starts a session that draws both eyes, survives the AI version, and leaving VR returns the 2D game', async ({ page, request }) => {
  await withQuest2(page);
  const quick = await gameFrom(request, 'A hamster escapes a supermarket while a giant Roomba hunts it.');
  const arrived = await gameFrom(request, 'A penguin slides down an icy hill collecting fish.');
  let ready = false;
  await page.route(`**${quick.upgrade}`, async (route) => {
    const pending = { status: 'pending', deadlineAt: new Date(Date.now() + 285_000).toISOString() };
    await route.fulfill({ json: ready ? { ...pending, reading: { versionId: arrived.versionId } } : pending, headers: { 'cache-control': 'no-store' } });
  });

  await page.goto(quick.url);
  await running(page);
  const enter = page.getByTestId('enter-vr');
  await expect(enter).toBeVisible({ timeout: 15_000 });
  await expect(enter).toHaveText('Enter VR');
  await enter.click();

  await expect.poll(async () => (await xr(page))?.presenting, { timeout: 15_000 }).toBe(true);
  expect((await xr(page))?.eyes).toBe(2);
  await drawnInVr(page);

  // AI verze dorazí: stránka přejde na jinou hru, relace trvá a kreslí novou scénu.
  ready = true;
  await page.waitForURL(`**/play/${arrived.versionId}`, { timeout: 20_000 });
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  expect((await xr(page))?.presenting).toBe(true);
  await drawnInVr(page);

  // Ven z VR systémovým tlačítkem brýlí: relace skončí zvenku. DOM tlačítko v relaci nejde (plátno brýlí ho kryje).
  await page.evaluate(() => window.__iwerSession!.end());
  await expect.poll(async () => (await xr(page))?.presenting, { timeout: 15_000 }).toBe(false);
  // 2D hra po výstupu běží a stránka reaguje; „Enter VR“ je zpět v HUD (AI verze z věty je řetěz mikroher) a vede znovu do VR.
  await expect(page.getByTestId('enter-vr')).toBeVisible();
  await running(page);
  const tick = await page.evaluate(() => window.__playShell!.tick());
  await expect.poll(() => page.evaluate(() => window.__playShell!.tick()), { timeout: 15_000 }).toBeGreaterThan(tick);
  await page.getByTestId('enter-vr').click();
  await expect.poll(async () => (await xr(page))?.presenting, { timeout: 15_000 }).toBe(true);
});
