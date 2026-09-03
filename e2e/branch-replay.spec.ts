import { expect, test } from '@playwright/test';

import { hashHex } from '../src/sim/hash';
import { createRuntime, step, type Runtime, type WorldDocRuntime } from '../src/sim/interpreter';

import { openInspect } from './inspect';

/**
 * Jádro AC úlohy T38 — **tři budoucnosti, tři různé hashe, a všechny tři se dají
 * přehrát znovu**.
 *
 * Strom větví se dá nakreslit i nad jedinou osou a vypadá to úplně stejně: uzly
 * přibývají, popisky sedí, přepínání funguje. Rozdíl je vidět jenom na hashích,
 * a jenom tehdy, když je někdo přepočítá **mimo prohlížeč**. Proto se tady každá
 * větev přehrává v Node dopředu — bez osy, bez přetáčení a bez `rebranchAt`,
 * tedy bez jediného kusu kódu, jehož výsledek se ověřuje.
 *
 * ## Proč jsou ty tři větve sourozenci, a ne řetěz
 *
 * Zmrazený svět `C01` spustí po tiku 40 **jediné pravidlo** (`pick`, na ticích
 * 60 a 140) — naměřeno 3. 9. 2026. Řetězená odbočka „vypni nejpilnější pravidlo"
 * proto po první větvi vrátí `NOTHING_FIRES`: v ní už žádné pravidlo nezbylo.
 * Tři různé budoucnosti se z něj dají dostat jedině jako sourozenci z originu:
 *
 * - **origin** — `pick` spustí na 60 i na 140.
 * - **odbočka na tiku 40** — `pick` nespustí vůbec.
 * - **odbočka na tiku 100** — `pick` spustil na 60, na 140 už ne.
 *
 * ## Proč se dokument tahá z prohlížeče
 *
 * `WorldDocRuntime` jsou čistá data (`ir`, `space`, `trace`), takže se
 * `window.__timeline.document()` dá vytáhnout `page.evaluate` a přehrát v Node.
 * Bez těch dvířek by se referenční hash počítal nad světem, o kterém se jen
 * doufá, že je týž, jaký si postavil prohlížeč.
 */

const FROZEN_PROMPT = 'a puzzle room where I have to find three keys to open the exit door';

const FIRST_TICK = 40;
const SECOND_TICK = 100;

function inputsAt(doc: WorldDocRuntime, tick: number) {
  return doc.trace.filter((entry) => entry.tick === tick);
}

function runTo(runtime: Runtime, doc: WorldDocRuntime, tick: number): void {
  while (runtime.tick < tick && runtime.runState === 'running') {
    step(runtime, inputsAt(doc, runtime.tick));
  }
}

/**
 * Přehraje větev **dopředu**: rodič doběhne na tik odbočení, tam se stav ručně
 * přesadí do runtimu nad dokumentem větve a pokračuje se na horizont. Je to
 * definice odbočky napsaná v testu — kdyby se místo toho zavolal `rebranchAt`,
 * ověřovala by se shoda funkce se sebou samou.
 */
function replay(
  branch: { readonly parentId: string | null; readonly atTick: number },
  doc: WorldDocRuntime,
  parentDoc: WorldDocRuntime | null,
  horizon: number,
): string {
  if (branch.parentId === null || parentDoc === null) {
    const runtime = createRuntime(doc);
    runTo(runtime, doc, horizon);
    return hashHex(runtime.state);
  }

  const upstream = createRuntime(parentDoc);
  runTo(upstream, parentDoc, branch.atTick);
  expect(upstream.tick).toBe(branch.atTick);

  const runtime = createRuntime(doc);
  runtime.state.set(upstream.state);
  runtime.tick = upstream.tick;
  runtime.runState = upstream.runState;
  runtime.fault = upstream.fault;
  runtime.drainQueue = upstream.drainQueue.slice();
  runtime.previous = upstream.previous;
  runTo(runtime, doc, horizon);
  return hashHex(runtime.state);
}

test('tři sourozenecké větve nesou tři různé hashe a každý sedí na replay v Node', async ({ page }) => {
  test.setTimeout(240_000);

  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });
  await openInspect(page);
  await page.getByTestId('prompt-input').fill(FROZEN_PROMPT);
  await page.getByTestId('prompt-submit').click();
  await page.waitForFunction(() => window.__worldsmith!.entities().length > 0, undefined, { timeout: 60_000 });
  await expect(page.getByTestId('timeline')).toBeVisible();

  const measured = await page.evaluate(
    ({ first, second }) => {
      const api = window.__timeline!;
      const horizon = api.horizon;

      api.fresh();
      api.runTo(horizon);

      // Sourozenec A — odbočka z originu na tiku 40.
      api.seek(first);
      const one = api.branch(first);
      api.runTo(horizon);

      // Zpátky na origin. Odbočení ho přetočilo do minulosti, takže musí znovu
      // doběhnout, než se z něj odbočí podruhé.
      api.switchTo('origin');
      api.runTo(horizon);

      // Sourozenec B — odbočka z TÉHOŽ originu, ale o šedesát tiků později.
      api.seek(second);
      const two = api.branch(second);
      api.runTo(horizon);

      const docs: Record<string, unknown> = {};
      for (const view of api.branches()) {
        api.switchTo(view.id);
        docs[view.id] = api.document();
      }

      return { horizon, verdicts: [one, two], views: api.branches(), docs };
    },
    { first: FIRST_TICK, second: SECOND_TICK },
  );

  // Obě odbočky se opravdu staly a obě vypnuly pravidlo, které do budoucnosti
  // mluví — jinak by „tři různé hashe" nebylo tvrzení o větvení.
  for (const verdict of measured.verdicts) {
    expect(verdict.verdict).toBe('BRANCHED');
    if (verdict.verdict === 'BRANCHED') expect(verdict.firings).toBeGreaterThan(0);
  }

  expect(measured.views).toHaveLength(3);
  const [origin, first, second] = measured.views;
  expect(origin.id).toBe('origin');
  expect(origin.parentId).toBeNull();
  // Sourozenci, ne řetěz — obojí by dalo tři uzly, jen jedno z toho je pravda.
  expect(first.parentId).toBe('origin');
  expect(second.parentId).toBe('origin');
  expect(first.atTick).toBe(FIRST_TICK);
  expect(second.atTick).toBe(SECOND_TICK);

  // Všechny tři doběhly na horizont, takže se srovnává horizont s horizontem.
  for (const view of measured.views) expect(view.tick).toBe(measured.horizon);

  const hashes = measured.views.map((view) => view.hash);
  expect(hashes.every((hash) => hash !== '')).toBe(true);
  // Tři budoucnosti, ne tři jména téže. **Naměřeno 3. 9. 2026:** tahle aserce
  // padne na úložišti, které větev místo přidání přepíše (původní vada T38) —
  // ne na mělké pečeti; tu chytá jenom `src/sim/__tests__/branches.test.ts` a
  // proč, je napsané tam.
  expect(new Set(hashes).size).toBe(3);

  // A tady se pozná, že ty hashe nejsou nakreslené: každý z nich musí padnout
  // na běh, který si Node postaví sám.
  for (const view of measured.views) {
    const doc = measured.docs[view.id] as WorldDocRuntime;
    const parentDoc = view.parentId === null ? null : (measured.docs[view.parentId] as WorldDocRuntime);
    expect(replay(view, doc, parentDoc, measured.horizon)).toBe(view.hash);
  }
});
