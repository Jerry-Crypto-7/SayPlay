/**
 * **Průvodce stojí ve světě a odpovídá z jeho pravidel** (P21 T14).
 *
 * Sada běží na hlavní stránce nad doorovskou fixturou, tedy bez jediného
 * volání modelu: scriptovaný je **přenos** (relace, plán změny, commit),
 * všechno ostatní — hledání cesty, verifikátor, věta, scéna, přetáčení času —
 * je produkt.
 *
 * ## Co se tu soudí a proč zrovna to
 *
 * 1. **Postava ve světě stojí dřív, než padne otázka.** Průvodce, kterého není
 *    vidět, se nedá oslovit; scéna to hlásí sondou, protože z obrázku plátna se
 *    „stojí tam někdo" přečíst nedá.
 * 2. **Odpověď přijde do tří sekund.** Hledání běží v prohlížeči a jeho cena
 *    roste s velikostí světa, takže je to měřený čas, ne předpoklad.
 * 3. **Cesta se ve scéně zvýrazní** — a zvýrazní se **ta**, kterou věta
 *    jmenuje. Prstenec jde nakreslit jen kolem slotu, který má hmotu, takže
 *    věta a scéna se můžou rozejít, aniž by si toho kdokoli všiml.
 * 4. **Vymyšlený cíl dostane pojmenované „to tu není"** a ani jedno jméno ze
 *    světa. Plynulá nepravda se čte líp než poctivé nevím.
 * 5. **Po přepisu pravidla odpovídá podle nových pravidel.** Tohle je jediná
 *    vlastnost, kterou okem nepoznáš: stará věta pořád dává smysl.
 */

import { expect, test, type Page } from '@playwright/test';
import sharp from 'sharp';

import { commitPart } from '../src/ir/revision';
import { doorWorld } from './fixtures/door-world';
import type { GuideProbe } from '../src/components/worldstream/WorldstreamCanvas';

declare global {
  interface Window { __worldstreamGuide?: GuideProbe }
}

// Softwarové WebGL staví fixturu dřív, než začnou tvrzení o interakci.
test.setTimeout(90_000);

const QUESTION = 'How do I get to the gate?';

/** Cesta v původních pravidlech: odemknout, dojít, projít. */
const ORIGINAL_ANSWER = 'To reach gate: activate gate, then moveTo gate, then pass gate.';

/** Táž otázka nad světem, kde `pass` nic nepodmiňuje. Odemykání z cesty vypadne. */
const REWRITTEN_ANSWER = 'To reach gate: moveTo gate, then pass gate.';

const ID = 'guide-door-fixture';

async function doorSession(page: Page) {
  let blueprint = doorWorld();
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));

  await page.route('**/api/worldstream/sessions', route => route.fulfill({ status: 202, json: {
    sessionId: ID, events: `/api/worldstream/sessions/${ID}/events`,
    snapshot: `/api/worldstream/sessions/${ID}`, authored: { match: 'exact' } } }));
  await page.route(`**/api/worldstream/sessions/${ID}/events*`, route => {
    const frame = (sequence: number, type: string, payload: unknown) =>
      `data: ${JSON.stringify({ sessionId: ID, sequence, type, at: '1970-01-01T00:00:00.000Z', payload })}\n\n`;
    return route.fulfill({ contentType: 'text/event-stream',
      body: frame(1, 'blueprint.ready', { blueprint }) + frame(2, 'session.complete', {}) });
  });
  await page.route(`**/api/worldstream/sessions/${ID}/changes`, route => route.fulfill({ json: {
    changeId: 'door-change', summary: 'Anyone may pass the door.',
    target: { stableId: 'gate', label: 'panel door' },
    scope: { shape: false, behavior: 1, appearance: 0 }, preserved: ['visitor', 'gate'],
    authored: { match: 'exact' } } }));
  await page.route(`**/api/worldstream/sessions/${ID}/changes/door-change/commit`, route => {
    // Patch jde **produkční branou revizí**, ne ruční úpravou dokumentu:
    // odpověď průvodce se má opřít o svět, který systém doopravdy přijal.
    const result = commitPart(blueprint.world, { part: 'sim', baseRevision: 0,
      operations: [{ op: 'replace', path: '/rules/pass/condition', value: null }] });
    expect(result.verdict).toBe('COMMITTED');
    if (result.verdict !== 'COMMITTED') throw new Error('fixture patch rejected');
    blueprint = { ...blueprint, world: result.doc };
    return route.fulfill({ json: { outcome: 'COMMITTED', stableId: 'gate', summary: 'Anyone may pass the door.',
      revisions: { sim: { before: 0, after: blueprint.world.simRevision },
        look: { before: 0, after: blueprint.world.lookRevision } } } });
  });
  await page.route(`**/api/worldstream/sessions/${ID}`, route =>
    route.fulfill({ json: { blueprint: structuredClone(blueprint) } }));

  await page.goto('/');
  await page.getByTestId('prompt-input').fill('Guide door fixture');
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-controls')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId('runtime-act')).toBeEnabled({ timeout: 30_000 });
  return { errors };
}

/** Zeptá se a vrátí, jak dlouho odpověď trvala. */
async function ask(page: Page, question: string): Promise<number> {
  await page.getByTestId('guide-question').fill(question);
  const started = Date.now();
  await page.getByTestId('guide-ask').click();
  await expect(page.getByTestId('guide-answer')).not.toHaveText('Looking for a way…', { timeout: 10_000 });
  await expect(page.getByTestId('guide-answer')).not.toHaveText('');
  return Date.now() - started;
}

const guide = (page: Page) => page.evaluate(() => window.__worldstreamGuide!());

test('a guide stands in the world, answers from its rules and shows the route', async ({ page }, info) => {
  const session = await doorSession(page);

  // (1) Postava stojí ve světě dřív, než se kdokoli zeptal.
  const standing = await guide(page);
  expect(standing.figure, 've světě nikdo nestojí, není se koho ptát').not.toBeNull();
  expect(standing.stops, 'scéna zvýrazňuje cestu, na kterou se nikdo neptal').toEqual([]);

  const before = await page.getByTestId('worldstream-canvas').screenshot();

  // (2) a (3) Odpověď do tří sekund, a zvýrazní se cesta, kterou jmenuje.
  const elapsed = await ask(page, QUESTION);
  await expect(page.getByTestId('guide-answer')).toHaveText(ORIGINAL_ANSWER);
  expect(elapsed, 'odpověď průvodce trvala déle než tři sekundy').toBeLessThan(3_000);
  expect((await guide(page)).stops).toEqual(['gate']);

  await page.waitForTimeout(100); // renderer kreslí prstenec v dalším snímku
  const after = await page.getByTestId('worldstream-canvas').screenshot();
  const [a, b] = await Promise.all([before, after].map(buffer => sharp(buffer).removeAlpha().raw().toBuffer()));
  let changed = 0;
  for (let i = 0; i < a.length; i += 3) if (Math.max(...[0, 1, 2].map(c => Math.abs(a[i + c] - b[i + c]))) > 20) changed++;
  expect(changed, 'věta mluví o cestě, ale ve scéně se nic nerozsvítilo').toBeGreaterThan(100);
  await page.screenshot({ path: info.outputPath('guide-route.png') });

  // (4) Vymyšlený cíl: pojmenované „to tu není" a žádné jméno ze světa.
  await ask(page, 'How do I get to the dragon?');
  await expect(page.getByTestId('guide-answer')).toHaveText('There is no dragon in this world.');
  expect((await guide(page)).stops).toEqual([]);

  // Přetočení času samo odpověď nemění — cesta se hledá od začátku světa.
  await page.getByTestId('runtime-action').selectOption({ label: 'activate gate (visitor)' });
  await page.getByTestId('runtime-act').click();
  await expect(page.getByTestId('runtime-input-result')).toContainText('open');
  await page.getByTestId('rewind-before-action').click();
  await ask(page, QUESTION);
  await expect(page.getByTestId('guide-answer')).toHaveText(ORIGINAL_ANSWER);

  expect(session.errors).toEqual([]);
});

test('after the rule is rewritten the guide answers from the new rules', async ({ page }) => {
  const session = await doorSession(page);

  await ask(page, QUESTION);
  await expect(page.getByTestId('guide-answer')).toHaveText(ORIGINAL_ANSWER);

  // Přetoč a přepiš: vstup návštěvníka, návrat před něj, změna pravidla.
  await page.getByTestId('runtime-action').selectOption({ label: 'activate gate (visitor)' });
  await page.getByTestId('runtime-act').click();
  await expect(page.getByTestId('runtime-input-result')).toContainText('open');
  await page.getByTestId('runtime-pause').click();
  const tick = Number(await page.getByTestId('runtime-tick').getAttribute('data-tick'));
  await page.getByTestId('rewind-before-action').click();
  await page.getByTestId('refine-input').fill('Anyone may pass the door.');
  await page.getByTestId('refine-submit').click();
  await expect(page.getByTestId('change-preview')).toHaveAttribute('data-kind', 'preview');
  await page.getByText('Exact simulation times', { exact: true }).click();
  await page.getByTestId('branch-observation-input').fill(String(tick + 40));
  await page.getByTestId('change-apply').click();
  await expect(page.getByTestId('branch-comparison')).toBeVisible({ timeout: 60_000 });

  // Přepsaná větev běží dál pod „Visitor replay"; průvodce v ní odpovídá
  // z pravidel, která platí teď.
  await page.getByText('Visitor replay', { exact: true }).click();
  await expect(page.getByTestId('guide-answer'), 'odpověď z minulých pravidel přežila výměnu světa').toHaveText('');
  await ask(page, QUESTION);
  await expect(page.getByTestId('guide-answer')).toHaveText(REWRITTEN_ANSWER);

  expect(session.errors).toEqual([]);
});
