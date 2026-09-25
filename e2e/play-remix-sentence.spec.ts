import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * P27C T5: „Change it“ pod hrou. Hráč dohraje, napíše „add snow“ a otevře
 * novou verzi s vlastním odkazem; rodič zůstane s původním specem.
 *
 * Server v e2e model nemá, proto se `POST/GET …/remix` s větou podvrhne přes
 * `page.route`. `ready` ale vrací id dítěte, které je doopravdy publikované
 * (`POST …/remix { spec }`), takže stránka dítěte a rodokmen jsou skutečné.
 */

const JOB = 'a'.repeat(32);

async function publish(request: APIRequestContext, sentence: string): Promise<string> {
  const response = await request.post('/api/play/games', { data: { sentence } });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return ((await response.json()) as { url: string }).url;
}

async function specOf(request: APIRequestContext, id: string): Promise<{ readonly title: string }> {
  const response = await request.get(`/api/play/games/${id}`);
  expect(response.ok()).toBe(true);
  return ((await response.json()) as { spec: { title: string } }).spec;
}

async function win(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__playShell !== undefined, undefined, { timeout: 60_000 });
  const outcome = await page.evaluate(() => window.__playShell!.playWitness());
  expect(outcome.runState).toBe('won');
  await expect(page.getByTestId('play-postrun')).toBeVisible();
}

test('a sentence of your own opens a new version and leaves the original alone', async ({ page, request }) => {
  const url = await publish(request, 'Collect five glowing mushrooms then open a portal.');
  const parentId = url.split('/').at(-1)!;
  const original = await specOf(request, parentId);

  const made = await request.post(`/api/play/games/${parentId}/remix`, { data: { spec: { ...original, title: `${original.title} in the snow` } } });
  expect(made.status(), await made.text()).toBeLessThan(300);
  const childId = ((await made.json()) as { url: string }).url.split('/').at(-1)!;
  expect(childId).not.toBe(parentId);

  let sent: unknown = null;
  let asked = 0;
  await page.route(`**/api/play/games/${parentId}/remix**`, async (route) => {
    const call = route.request();
    if (call.method() === 'POST') {
      sent = call.postDataJSON();
      return route.fulfill({ status: 202, json: { status: 'pending', job: JOB, deadlineAt: new Date(Date.now() + 60_000).toISOString() } });
    }
    expect(new URL(call.url()).searchParams.get('job')).toBe(JOB);
    asked += 1;
    // První dotaz ještě běží – box musí přežít `pending` a ptát se dál.
    if (asked === 1) return route.fulfill({ json: { status: 'pending', job: JOB, deadlineAt: new Date(Date.now() + 60_000).toISOString() } });
    return route.fulfill({ json: { status: 'ready', versionId: childId, changed: ['It snows'] } });
  });

  await page.goto(url);
  await win(page);
  const box = page.getByTestId('remix-box');
  await expect(box).toBeVisible();
  await box.getByTestId('remix-input').fill('add snow');
  await expect(box.getByTestId('remix-count')).toHaveText('8/140');
  await box.getByTestId('remix-submit').click();

  await expect(box.getByTestId('remix-state')).toHaveAttribute('data-kind', 'working');
  await expect(box.getByTestId('remix-state')).toContainText(/\d+ s/);
  await expect(box.getByText('What changed')).toBeVisible({ timeout: 15_000 });
  await expect(box.getByTestId('remix-changed')).toContainText('It snows');
  expect(sent).toEqual({ sentence: 'add snow' });
  expect(asked).toBeGreaterThanOrEqual(2);

  await box.getByTestId('remix-open').click();
  await expect(page).toHaveURL(new RegExp(`/play/${childId}$`), { timeout: 30_000 });
  const lineage = page.getByTestId('play-lineage');
  await expect(lineage).toContainText('Remixed from');
  await expect(lineage.locator(`a[href="/play/${parentId}"]`)).toBeVisible();

  expect(await specOf(request, parentId)).toEqual(original);
});

test('a remix sent before Replay comes back as a chip, not a jump (P28B T7)', async ({ page, request }) => {
  // Střelnice po Replay stojí na tiku 0, dokud hráč neťukne – běh nedojde sám do konce.
  const url = await publish(request, 'zombie shooter in a mall');
  const parentId = url.split('/').at(-1)!;
  const original = await specOf(request, parentId);
  const made = await request.post(`/api/play/games/${parentId}/remix`, { data: { spec: { ...original, title: `${original.title} but faster` } } });
  expect(made.status(), await made.text()).toBeLessThan(300);
  const childId = ((await made.json()) as { url: string }).url.split('/').at(-1)!;

  let done = false;
  await page.route(`**/api/play/games/${parentId}/remix**`, (route) => {
    if (route.request().method() === 'POST') return route.fulfill({ status: 202, json: { status: 'pending', job: JOB, deadlineAt: new Date(Date.now() + 60_000).toISOString() } });
    return route.fulfill({ json: done ? { status: 'ready', versionId: childId, changed: ['Faster zombies'] } : { status: 'pending', job: JOB, deadlineAt: new Date(Date.now() + 60_000).toISOString() } });
  });

  await page.goto(url);
  await win(page);
  const box = page.getByTestId('remix-box');
  await box.getByTestId('remix-input').fill('make enemies faster');
  await box.getByTestId('remix-submit').click();
  await expect(box.getByTestId('remix-state')).toHaveAttribute('data-kind', 'working');

  await page.getByTestId('play-replay').click();
  await expect(page.getByTestId('play-postrun')).toHaveCount(0);
  done = true;
  const chip = page.getByTestId('remix-ready');
  await expect(chip).toBeVisible({ timeout: 15_000 });
  await expect(chip).toContainText('Your remix is ready');
  await expect(page).toHaveURL(new RegExp(`/play/${parentId}$`));

  await chip.getByTestId('remix-ready-open').click();
  await expect(page).toHaveURL(new RegExp(`/play/${childId}$`), { timeout: 30_000 });
});

test('a refused change says why and points back to the chips', async ({ page, request }) => {
  const url = await publish(request, 'Collect five glowing mushrooms then open a portal.');
  const parentId = url.split('/').at(-1)!;
  await page.route(`**/api/play/games/${parentId}/remix**`, (route) =>
    route.request().method() === 'POST'
      ? route.fulfill({ status: 202, json: { status: 'pending', job: JOB, deadlineAt: new Date(Date.now() + 60_000).toISOString() } })
      : route.fulfill({ json: { status: 'final', reason: 'UNASKED_CHANGE' } }),
  );

  await page.goto(url);
  await win(page);
  const box = page.getByTestId('remix-box');
  await box.getByTestId('remix-input').fill('make the hero a dragon');
  await box.getByTestId('remix-submit').click();
  await expect(box.getByTestId('remix-state')).toHaveAttribute('data-kind', 'final', { timeout: 15_000 });
  await expect(box.getByTestId('remix-state')).toContainText('changed more than you asked for');
  await expect(box.getByTestId('remix-state')).toContainText('Try one of the changes above');
  await expect(box.getByTestId('remix-retry')).toHaveCount(0);
  await expect(page.getByTestId('play-chip-harder')).toBeEnabled();
});
