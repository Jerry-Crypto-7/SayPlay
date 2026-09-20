import { expect, test, type Page } from '@playwright/test';

import { EXAMPLE_BLUEPRINT_ANSWER } from '../src/model/worldstream-prompt';
import { EXAMPLE_PLAN } from '../src/model/worldstream-examples';
import { blueprintSchema } from '../src/worldstream/schema';
import { sealSimHash } from '../src/ir/worlddoc';
import surface from '../evals/reality-compiler/museum.sim.json';

/**
 * Oracle úlohy P22 T8 — **klik na tik ukáže vstup → pravidlo → zápis → co to
 * spustilo dál.**
 *
 * Svět je připravená muzejní fixture z `reality-compiler-interaction.spec.ts`:
 * scriptovaný je jen transport (relace a proud), interpret, stráže i stopa
 * běží doopravdy na `/`. První akce `activate sensorA` spustí `start_countdown`,
 * který zapíše `f:started` a `t:countdown` — tedy přesně ten tik, na který má
 * porotce kliknout.
 *
 * ## Pin: panel ukazuje pravidla **toho** tiku, ne jiného
 *
 * Panel s pravidly z vedlejšího tiku vypadá věrohodně — jména pravidel jsou
 * stejná, jen se stalo něco jiného. Proto se každý vypsaný `ruleId` porovnává
 * s `explainTick(tick)` téhož běhu, čteným ze sondy `__worldstreamMetrics`
 * v prohlížeči: množiny se musí rovnat, ne jen protínat.
 *
 * ## Druhý pin: po přetočení panel nelže
 *
 * `observeAt` maže kruh od cílového tiku dál. Panel otevřený nad smazaným tikem
 * musí říct „No rule fired at this tick", ne dál ukazovat zápisy, které se ve
 * vráceném stavu nestaly.
 */

/** Písmena, která v anglické mědi nemají co dělat — týž filtr jako `interface-language.spec.ts`. */
const CZECH_LETTERS = /[ěščřžýáíéúůňťďóĚŠČŘŽÝÁÍÉÚŮŇŤĎÓ]/u;

async function museum(page: Page) {
  const blueprint = blueprintSchema.parse({
    version: 'worldstream-v1', sessionSeed: 4021, title: 'Museum why fixture',
    intent: EXAMPLE_PLAN.intent, geometry: { ...EXAMPLE_BLUEPRINT_ANSWER.geometry, nodes: [...EXAMPLE_BLUEPRINT_ANSWER.geometry.nodes,
      { kind: 'mass', variant: 'block', at: [6, -0.2, 5.5], scale: [5, 0.2, 3] },
      { kind: 'repeat', child: 9, count: 2, step: [5, 0, 0] },
      { kind: 'group', children: [8, 10] }], root: 11 }, shapes: [],
    world: sealSimHash({ irVersion: 'v1', simRevision: 0, lookRevision: 0,
      sim: surface, look: EXAMPLE_BLUEPRINT_ANSWER.world.look }),
    objects: [{ stableId: 'visitor', label: 'the visitor', synonyms: [], role: 'prop', importance: 1,
      source: { kind: 'geom', node: 5 }, targetBounds: { min: [4.1, 0, 5.1], max: [4.9, 0.7, 5.9] } },
      { stableId: 'corridorFloor', label: 'the ten-cell fixture corridor', synonyms: [], role: 'prop', importance: 1,
        source: { kind: 'geom', node: 10 }, targetBounds: { min: [3.5, -0.3, 4], max: [13.5, -0.1, 7] } }],
  });
  const id = '22222222-3333-4444-5555-777777777777';
  await page.route('**/api/worldstream/sessions', route => {
    if (route.request().postDataJSON()?.live === true) return route.fulfill({ status: 503, body: '{}' });
    return route.fulfill({ status: 202, contentType: 'application/json', body: JSON.stringify({ sessionId: id,
      events: `/api/worldstream/sessions/${id}/events`, snapshot: `/api/worldstream/sessions/${id}`,
      authored: { match: 'exact' } }) });
  });
  await page.route(`**/api/worldstream/sessions/${id}/events*`, route => {
    const frame = (sequence: number, type: string, payload: unknown) =>
      `data: ${JSON.stringify({ sessionId: id, sequence, type, at: '1970-01-01T00:00:00.000Z', payload })}\n\n`;
    return route.fulfill({ status: 200, contentType: 'text/event-stream',
      body: frame(1, 'blueprint.ready', { blueprint }) + frame(2, 'session.complete', {}) });
  });
  await page.goto('/');
  await page.getByTestId('generation-mode').selectOption('prepared');
  await page.getByTestId('prompt-input').fill('Museum why fixture');
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('runtime-act')).toBeEnabled({ timeout: 30_000 });
}

test('a marker appears after the first action, and the panel shows that tick\'s rules and writes', async ({ page }) => {
  test.setTimeout(90_000);
  await museum(page);

  const markers = page.locator('[data-testid^="why-marker-"]');
  // Muzeum spouští pravidla jen na akci a na konec časovače, takže před první
  // akcí nemá být žádná značka — jinak by ta níž mohla být z jiného tiku.
  await expect(markers).toHaveCount(0);
  await expect(page.getByTestId('why-panel')).toHaveCount(0);

  await page.getByTestId('runtime-action').selectOption({ label: 'activate sensorA (visitor)' });
  await page.getByTestId('runtime-act').click();
  await expect(page.getByTestId('runtime-input-result')).toContainText('start_countdown');

  await expect(markers).toHaveCount(1);
  const marker = markers.first();
  const tick = Number((await marker.getAttribute('data-testid'))!.slice('why-marker-'.length));
  expect(Number.isInteger(tick)).toBe(true);
  const observedBefore = await page.getByTestId('world-time').inputValue();

  await marker.click();

  // Klik otevřel zásuvku a v ní panel toho tiku; čas se nepřetočil.
  await expect(page.getByTestId('inspect')).toHaveAttribute('data-open', 'true');
  const panel = page.getByTestId('why-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-tick', String(tick));
  expect(Number(await page.getByTestId('world-time').inputValue())).toBeGreaterThanOrEqual(Number(observedBefore));

  // Vstup → pravidlo → zápis.
  await expect(panel.getByTestId('why-input')).toContainText('activate sensorA');
  const rules = panel.getByTestId('why-rule');
  await expect(rules).toHaveCount(1);
  await expect(rules.first()).toHaveAttribute('data-rule-id', 'start_countdown');
  await expect(rules.first()).toContainText('When the player uses activate on sensorA');
  const writes = panel.getByTestId('why-write');
  expect(await writes.count()).toBeGreaterThanOrEqual(1);
  await expect(writes.filter({ hasText: 'f:started: 0 → 1' })).toHaveCount(1);
  await expect(panel.getByTestId('why-downstream')).toContainText('What this triggered next');

  // Pin: vypsaná pravidla jsou přesně `explainTick(tick)` téhož běhu.
  const shown = await rules.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-rule-id')));
  const recorded = await page.evaluate(at => window.__worldstreamMetrics!.explainTick(at).map(firing => firing.ruleId), tick);
  expect(recorded.length).toBeGreaterThanOrEqual(1);
  expect([...shown].sort()).toEqual([...recorded].sort());

  // Anglická měď, včetně `data-testid`.
  const html = await panel.evaluate(node => node.outerHTML);
  expect(html.match(CZECH_LETTERS)).toBeNull();

  // Přetočení před akci smaže kruh od toho tiku dál; panel to musí říct.
  await page.getByTestId('rewind-before-action').click();
  await expect(panel).toContainText('No rule fired at this tick');
  await expect(rules).toHaveCount(0);
  await expect(markers).toHaveCount(0);

  await panel.getByTestId('why-close').click();
  await expect(page.getByTestId('why-panel')).toHaveCount(0);
});
