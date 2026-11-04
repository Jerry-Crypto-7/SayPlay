import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

/**
 * Snímky obrazovek `/play` vedle referencí kitu Sayplay (P34). Nástroj pro oko,
 * ne test chování: snímky jdou do `evals/play/p34/<úloha>/` a úloha je
 * prohlédne vedle `docs/brand/reference-screens/*@2x.png`. Úloha je
 * `P34_SHOTS_TASK` (`T3`, `T4` … `final`), výběr stavů `P34_SHOTS_STATES`
 * (čárkami; prázdné = všechny). Každý další stav přidá úloha, která ho staví.
 *
 * Asertuje jen, že snímek vznikl, na stránce je jediná h1 a telefon se
 * neposouvá do strany.
 */

const TASK = process.env.P34_SHOTS_TASK || 'scratch';
const DIR = join(process.cwd(), 'evals', 'play', 'p34', TASK);
const ONLY = (process.env.P34_SHOTS_STATES ?? '').split(',').filter(Boolean);

const SIZES = [
  { name: '390', width: 390, height: 844 },
  { name: '1440', width: 1440, height: 900 },
] as const;

const SENTENCE = 'A hamster escapes a supermarket while a giant Roomba hunts it.';

async function home(page: Page): Promise<void> {
  await page.goto('/play');
  await expect(page.getByTestId('play-sentence')).toBeVisible();
  await page.evaluate(() => document.fonts.ready);
}

/** Pošle větu z domova; dveře (`POST /api/play/games`) už musí mít podvrženou odpověď. */
async function send(page: Page): Promise<void> {
  await home(page);
  await page.getByTestId('play-sentence').fill(SENTENCE);
  await page.getByTestId('play-create').click();
}

/** Hra z věty se stavem AI verze, který řekne podvržený `GET …/upgrade` (T4). */
async function game(page: Page, answer: Record<string, unknown>, kind: string, sentence = SENTENCE): Promise<void> {
  const created = await page.request.post('/api/play/games', { data: { sentence } });
  expect(created.status(), await created.text()).toBeLessThan(300);
  const draft = (await created.json()) as { url: string; upgrade: string };
  await page.route(`**${draft.upgrade}`, (route) => route.fulfill({ json: answer, headers: { 'cache-control': 'no-store' } }));
  await page.goto(draft.url);
  await page.locator('canvas').first().waitFor({ timeout: 60_000 });
  await expect(page.getByTestId('play-loading')).toHaveCount(0, { timeout: 60_000 });
  await expect(page.getByTestId('upgrade-state')).toHaveAttribute('data-kind', kind, { timeout: 15_000 });
  await page.evaluate(() => document.fonts.ready);
  await page.waitForTimeout(600);
}

/** Odpověď `GET …/upgrade`: AI verze se ještě dopočítává. */
const PENDING = (): Record<string, unknown> => ({ status: 'pending', deadlineAt: new Date(Date.now() + 285_000).toISOString() });
/** Scéna reference `02-in-game@2x.png` (T5): vejce, pes, brána – mřížková hra. */
const EGGS = "A fox steals eggs from a farm while the farmer's dog chases it";
/** Mřížková hra bez nepřítele (T5, jako `e2e/play-shell.spec.ts`): 5 s bez vstupu ji neukončí. */
const MUSHROOMS = 'Collect five glowing mushrooms then open a portal.';
/** Arkáda s časovým limitem (T5): aréna, časovač odpočítává. */
const ARENA = 'Survive in an arena full of slimes.';
/** Poletování (T6, jako `e2e/play-platform.spec.ts`): bez mávání pták spadne – skutečná prohra za pár sekund. */
const FLAP = 'like flappy bird but underwater';

/** Hra z věty bez podvrženého stavu AI verze; čeká, až plátno stojí. */
async function publishAndOpen(page: Page, sentence: string): Promise<void> {
  const created = await page.request.post('/api/play/games', { data: { sentence } });
  expect(created.status(), await created.text()).toBeLessThan(300);
  await page.goto(((await created.json()) as { url: string }).url);
  await page.locator('canvas').first().waitFor({ timeout: 60_000 });
  await expect(page.getByTestId('play-loading')).toHaveCount(0, { timeout: 60_000 });
  await page.evaluate(() => document.fonts.ready);
}

/** První dotek (P33 T11): ťuk na prázdné místo scény vlevo nad dolní řadou pustí hodiny. */
async function tapStage(page: Page): Promise<void> {
  const viewport = page.viewportSize()!;
  await page.mouse.click(viewport.width * 0.3, viewport.height * 0.6);
}

const STATES: Record<string, (page: Page) => Promise<void>> = {
  home,
  // Karta nápadu vložila větu: počítadlo a bublina s textem.
  'home-idea': async (page) => {
    await home(page);
    await page.getByTestId('play-starter-rhythm').click();
    await expect(page.getByTestId('play-sentence')).not.toHaveValue('');
    await page.waitForTimeout(400);
  },
  // T4: hra je založená, přechod na ni visí – první krok odškrtnutý, druhý pulzuje.
  building: async (page) => {
    await page.route('**/api/play/games', (route) => (route.request().method() === 'POST' ? route.fulfill({ json: { url: '/play/held' } }) : route.continue()));
    await page.route('**/play/held**', () => new Promise<void>(() => undefined));
    await send(page);
    await expect(page.getByTestId('play-status').locator('li').nth(1)).toHaveAttribute('data-state', 'active');
    await page.waitForTimeout(400);
  },
  // T4: dveře větu odmítly (422) – chybový toast kitu s `Try again`.
  'create-error': async (page) => {
    await page.route('**/api/play/games', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 422, json: { error: { code: 'SPEC_REJECTED', message: 'no_loop: the sentence could not become a game' } } })
        : route.continue(),
    );
    await send(page);
    await expect(page.getByTestId('play-create-error')).toBeVisible();
    await page.waitForTimeout(400);
  },
  // T4: bez sítě – věta zůstane a toast řekne, že odejde sama.
  'create-offline': async (page) => {
    await home(page);
    await page.getByTestId('play-sentence').fill(SENTENCE);
    await page.context().setOffline(true);
    await page.getByTestId('play-create').click();
    await expect(page.getByTestId('play-create-error')).toBeVisible();
    await page.waitForTimeout(400);
  },
  // T4: AI verze se dopočítává – pilulka `.sp-status` vlevo pod pruhem.
  'game-quick': (page) => game(page, { status: 'pending', deadlineAt: new Date(Date.now() + 285_000).toISOString() }, 'working'),
  // T4: AI verze je hotová – toast `.sp-toast` s tlačítkem.
  'game-ready': async (page) => {
    const other = await page.request.post('/api/play/games', { data: { sentence: 'Collect five glowing mushrooms then open a portal.' } });
    const target = ((await other.json()) as { versionId: string }).versionId;
    await game(page, { status: 'ready', versionId: target }, 'ready');
  },
  // T4: AI verze nepřijde (bez modelu) – poznámka na místě pilulky s `Try again`.
  'game-final': (page) => game(page, { status: 'draft-final', reason: 'MODEL_UNAVAILABLE' }, 'final'),
  // T5: HUD kitu na scéně reference (mřížka), hra čeká na první dotek – vejce 0/5, časovač, pauza,
  // řádek cíle, štítky psa a brány, čipy cílů, dolní řada a „Quick version“.
  'game-0s': async (page) => {
    await game(page, PENDING(), 'working', EGGS);
    await expect(page.getByTestId('play-goal')).toHaveAttribute('data-shown', 'true');
  },
  // T5: první ťuk a ~5 s hry – časovač běží. Od P70C T2 cíl po 4 s nezmizí, sbalí se do pilulky na jeden řádek.
  // Věta je dnes arkáda (`move_free`), ne mřížka: `playWitness(4)` by tu dohrál celý běh svědka a hra by skončila
  // výhrou – proto bez něj; nečinná hráčka 5 s vydrží (naměřeno 4. 11.: tik 320, běží).
  'game-5s': async (page) => {
    await publishAndOpen(page, MUSHROOMS);
    await tapStage(page);
    await page.waitForTimeout(5_000);
    await expect(page.getByTestId('play-goal')).toHaveAttribute('data-shown', 'true');
    await expect(page.getByTestId('play-goal')).toHaveAttribute('data-compact', 'true');
    await expect(page.getByTestId('play-outcome')).toHaveCount(0);
  },
  // T5: karta pauzy – scrim 45 %, Resume, Restart, Change one thing a řádek Sound · About · Quit.
  pause: async (page) => {
    await game(page, PENDING(), 'working', EGGS);
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('play-paused')).toBeVisible();
    await page.waitForTimeout(400);
  },
  // T9 (nález revize T5): řádek cíle se po 5 s sbalí (P70C T2, dřív zmizel) a pauza ho rozbalí – helper
  // `objectiveShown` sám nestačí, Hud i ArcadePlay mu musí předat skutečné `paused`. Bez `playWitness` jako `game-5s`.
  'pause-goal': async (page) => {
    await publishAndOpen(page, MUSHROOMS);
    await tapStage(page);
    await page.waitForTimeout(5_000);
    await expect(page.getByTestId('play-goal')).toHaveAttribute('data-compact', 'true');
    await page.getByTestId('play-pause').click();
    await expect(page.getByTestId('play-paused')).toBeVisible();
    await expect(page.getByTestId('play-goal')).toHaveAttribute('data-shown', 'true');
    await expect(page.getByTestId('play-goal')).toHaveAttribute('data-compact', 'false');
  },
  // T5: arkáda – časovač odpočítává limit hry, „Change one thing“ je živá změna.
  'game-arcade': async (page) => {
    await publishAndOpen(page, ARENA);
    await tapStage(page);
    await page.waitForTimeout(1_500);
    await expect(page.getByTestId('play-timer')).toHaveAttribute('data-countdown', 'true');
  },
  // T6: výhra na scéně reference (`03-win@2x.png`) – běh svědka dohraje vejce; odznak, nadpis, statistiky, Dare.
  'result-win': async (page) => {
    await game(page, PENDING(), 'working', EGGS);
    await page.evaluate(() => window.__playShell!.playWitness());
    await expect(page.getByTestId('play-outcome')).toHaveAttribute('data-outcome', 'won', { timeout: 30_000 });
    await page.waitForTimeout(1_200);
  },
  // T6: prohra – pták bez mávání spadne; „So close.“, hlavní je Try again, Dare mezi papírovými.
  'result-lose': async (page) => {
    test.setTimeout(120_000);
    await game(page, PENDING(), 'working', FLAP);
    // Jako `e2e/play-platform.spec.ts`: pták čeká na první ťuk; jedno mávnutí a bez dalšího spadne.
    await expect(page.getByTestId('arcade-stage')).toHaveAttribute('data-player-x', /.+/, { timeout: 60_000 });
    await page.keyboard.press('Space');
    await expect(page.getByTestId('play-outcome')).toHaveAttribute('data-outcome', 'lost', { timeout: 30_000 });
    await page.waitForTimeout(1_200);
  },
  // T7: výhra a „Remix it“ – list „Change one thing“: bublina s popiskem, čipy návrhů, rajčatové Remix it.
  'remix-open': async (page) => {
    await game(page, PENDING(), 'working', EGGS);
    await page.evaluate(() => window.__playShell!.playWitness());
    await expect(page.getByTestId('play-outcome')).toHaveAttribute('data-outcome', 'won', { timeout: 30_000 });
    await page.getByRole('button', { name: 'Remix it' }).click();
    await expect(page.getByRole('dialog', { name: 'Change one thing' })).toBeVisible();
    await page.waitForTimeout(600);
  },
  // T7: arkáda se nahrává, kolo sdílení v HUD otevře list – Dare a friend, Copy link a zašedlé Save video.
  'share-open': async (page) => {
    await publishAndOpen(page, ARENA);
    await tapStage(page);
    await page.waitForTimeout(1_000);
    await page.getByTestId('play-share').click();
    await expect(page.getByRole('dialog', { name: 'Share this game' })).toBeVisible();
    await page.waitForTimeout(600);
  },
};

test.describe.configure({ mode: 'serial' });

for (const [state, reach] of Object.entries(STATES)) {
  if (ONLY.length > 0 && !ONLY.includes(state)) continue;
  for (const size of SIZES) {
    test(`${state} ${size.name}`, async ({ page }) => {
      await page.setViewportSize({ width: size.width, height: size.height });
      await reach(page);
      await expect(page.locator('h1')).toHaveCount(1);
      if (size.width < 600) expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(size.width);
      mkdirSync(DIR, { recursive: true });
      await page.screenshot({ path: join(DIR, `${state}-${size.name}.png`) });
    });
  }
}
