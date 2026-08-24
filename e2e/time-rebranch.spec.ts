import { expect, test } from '@playwright/test';

/**
 * Oracle úlohy T17 — **přetočení času nic neztratí, změna pravidla se propíše**.
 *
 * Panel času umí tři věci a každá z nich je jinak snadné o ní lhát: doběhnout,
 * přetočit se, a odbočit. Test proto neměří to, co panel napíše do hlavičky, ale
 * hash zabaleného stavu, který počítá `hashHex` — tatáž funkce, jakou hashuje
 * ověřovač.
 *
 * Běhy jsou tři a stojí proti sobě takhle:
 *
 * - **A** — původní běh na tik 200, žádná změna.
 * - **B** — doběhnout na 200, PŘETOČIT na tik 40, vypnout pravidlo, doběhnout znovu.
 * - **C** — dopředu na tik 40, tam vypnout totéž pravidlo, doběhnout. Bez přetáčení.
 *
 * `B ≠ A` říká, že se změna do budoucnosti propsala. `B = C` říká, že přetočení
 * o ni nepřipravilo ani nic nepřidalo — tedy že minulost, do které se skáče, je
 * táž minulost, kterou svět odžil. Kdyby přetáčení jen předstíralo a ve
 * skutečnosti se běh stavěl od nuly, obě aserce by pořád mohly projít; proto se
 * měří i tik, na kterém běh po skoku stojí, a pravidlo, které se vyplo.
 *
 * **Věta je doslovný text `C01` ze zmrazeného korpusu**, protože offline větev
 * hledá přesnou shodu. Je to zároveň jediný z měřených zmrazených světů, kde po
 * tiku 40 vůbec něco spustí — nad `C03` nespustí nic, takže by tam žádná změna
 * pravidla nemohla budoucnost změnit (naměřeno 21. 8. 2026).
 */

const FROZEN_PROMPT = 'a puzzle room where I have to find three keys to open the exit door';

const BRANCH_TICK = 40;
const HORIZON = 200;

test('přetočení na tik 40 a změna pravidla přepočítá tutéž budoucnost jako změna bez přetáčení', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });

  // Bez světa se žádná časová osa nepředstírá.
  await expect(page.getByTestId('timeline')).toHaveCount(0);

  await page.getByTestId('prompt-input').fill(FROZEN_PROMPT);
  await page.getByTestId('prompt-submit').click();
  await page.waitForFunction(() => window.__worldsmith!.entities().length > 0, undefined, { timeout: 60_000 });

  const panel = page.getByTestId('timeline');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveAttribute('data-tick', String(HORIZON));

  const measured = await page.evaluate(
    ({ branchTick, horizon }) => {
      const api = window.__timeline!;

      // A — původní běh.
      api.fresh();
      api.runTo(horizon);
      const original = { tick: api.tick(), hash: api.hash() };

      // B — doběhnout, PŘETOČIT, změnit pravidlo, doběhnout.
      api.fresh();
      api.runTo(horizon);
      const beforeRewind = api.tick();
      const rewoundTo = api.seek(branchTick);
      const hashAtBranch = api.hash();
      const branch = api.branch(branchTick);
      const afterBranch = api.tick();
      api.runTo(horizon);
      const rewound = { tick: api.tick(), hash: api.hash(), rule: api.branchedRule() };

      // C — dopředu na tik větvení, tam změnit totéž pravidlo. Bez přetáčení.
      api.fresh();
      api.runTo(branchTick);
      const forwardAtBranch = { tick: api.tick(), hash: api.hash() };
      api.branch(branchTick);
      api.runTo(horizon);
      const forward = { tick: api.tick(), hash: api.hash(), rule: api.branchedRule() };

      return { horizon: api.horizon, original, beforeRewind, rewoundTo, hashAtBranch, branch, afterBranch, rewound, forwardAtBranch, forward };
    },
    { branchTick: BRANCH_TICK, horizon: HORIZON },
  );

  // Panel měří to okno, o kterém tvrdí, že ho měří.
  expect(measured.horizon).toBe(HORIZON);
  expect(measured.original.tick).toBe(HORIZON);

  // Přetočení doopravdy vrátilo čas — a vrátilo ho na TENTÝŽ stav, jaký měl
  // běh, který na tik 40 došel dopředu. Bez tohohle by obě aserce dole prošly
  // i osové, která se místo skoku postaví od nuly.
  expect(measured.beforeRewind).toBe(HORIZON);
  expect(measured.rewoundTo).toBe(BRANCH_TICK);
  expect(measured.hashAtBranch).toBe(measured.forwardAtBranch.hash);
  expect(measured.forwardAtBranch.tick).toBe(BRANCH_TICK);

  // Vyplo se pravidlo, které do budoucnosti opravdu mluví — jinak by se nedalo
  // rozhodnout, jestli „stejná budoucnost" znamená správnost, nebo nečinnost.
  expect(measured.branch.verdict).toBe('BRANCHED');
  if (measured.branch.verdict === 'BRANCHED') {
    expect(measured.branch.firings).toBeGreaterThan(0);
    expect(measured.rewound.rule).toBe(measured.branch.ruleId);
    expect(measured.forward.rule).toBe(measured.branch.ruleId);
  }
  expect(measured.afterBranch).toBe(BRANCH_TICK);

  expect(measured.rewound.tick).toBe(HORIZON);
  expect(measured.forward.tick).toBe(HORIZON);

  // Jádro AC, obě aserce v jednom testu.
  expect(measured.rewound.hash).not.toBe(measured.original.hash);
  expect(measured.rewound.hash).toBe(measured.forward.hash);
});

test('posuvník i tlačítko panelu hýbou týmž během, který měří hash', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });
  await page.getByTestId('prompt-input').fill(FROZEN_PROMPT);
  await page.getByTestId('prompt-submit').click();
  await page.waitForFunction(() => window.__worldsmith!.entities().length > 0, undefined, { timeout: 60_000 });

  const panel = page.getByTestId('timeline');
  await expect(panel).toHaveAttribute('data-tick', String(HORIZON));
  const atHorizon = await page.evaluate(() => window.__timeline!.hash());

  // Přetočení posuvníkem, ne voláním API — panel je ovládací prvek, ne výpis.
  await page.getByTestId('timeline-scrub').fill(String(BRANCH_TICK));
  await expect(panel).toHaveAttribute('data-tick', String(BRANCH_TICK));
  await expect(page.getByTestId('timeline-tick')).toContainText(`tick ${String(BRANCH_TICK)}`);
  const atBranch = await page.evaluate(() => window.__timeline!.hash());
  expect(atBranch).not.toBe(atHorizon);

  // Tlačítko odbočí a dopočítá budoucnost samo.
  await page.getByTestId('timeline-branch').click();
  await expect(panel).toHaveAttribute('data-tick', String(HORIZON));
  await expect(panel).not.toHaveAttribute('data-branched', '');
  await expect(page.getByTestId('timeline-outcome')).toContainText('was recomputed');

  const branched = await page.evaluate(() => window.__timeline!.hash());
  expect(branched).not.toBe(atHorizon);
});
