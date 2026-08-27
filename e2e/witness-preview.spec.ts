import { expect, test } from '@playwright/test';

import { openInspect } from './inspect';

/**
 * Oracle úlohy T15 — **náhled přehrává tutéž stopu, jakou ověřovač certifikoval**.
 *
 * Zrychlený náhled vítězné cesty je na demu ta část, která z „svět je
 * dohratelný" dělá něco viditelného. Sám o sobě ale nic nedokazuje: pruh, který
 * pouští libovolnou stopu a píše u ní „takhle to systém vyhrál", vypadá úplně
 * stejně jako pruh, který mluví pravdu.
 *
 * Rozdíl mezi tím dvojím je hash. `window.__pipeline.witness()` vydá stopu,
 * kterou náhled přehrává; `certificate().witnessHash` je hash stopy, kterou
 * `verifyWitness` **doopravdy odkrokoval** ve své smyčce. Test porovná ty dva.
 * Kdyby náhled vrátil jinou stopu, hashe se rozejdou a tahle aserce spadne — to
 * je celý smysl AC a je to změřené mutací, ne jen napsané.
 *
 * **Věta je doslovný text `C01` ze zmrazeného korpusu**, protože offline větev
 * hledá přesnou shodu a vymyšlená věta by měřila chybovou cestu.
 */

const FROZEN_PROMPT = 'a puzzle room where I have to find three keys to open the exit door';
const SHORTER_TRACE_PROMPT = 'an escape room in a submarine that floods slowly, I have 60 seconds';

test('náhled přehraje vítěznou cestu a nese TÝŽ hash jako certifikát', async ({ page }) => {
  test.setTimeout(180_000);

  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });

  // Od P13 vlny 0 T1 pruh nestojí na výchozí obrazovce — otevírá se z Inspectu.
  await openInspect(page);

  // Bez světa se žádná vítězná cesta nepředstírá ani otevřená.
  await expect(page.getByTestId('witness-preview')).toHaveCount(0);

  await page.getByTestId('prompt-input').fill(FROZEN_PROMPT);
  await page.getByTestId('prompt-submit').click();
  await page.waitForFunction(() => window.__worldsmith!.entities().length > 0, undefined, { timeout: 60_000 });

  // 1. Pruh stojí a svět je certifikovaný.
  const strip = page.getByTestId('witness-preview');
  await expect(strip).toBeVisible();
  await expect(strip).toHaveAttribute('data-certified', 'true');

  // 2. Náhled se doopravdy přehrává — dojede na konec sám, bez zásahu.
  await expect(strip).toHaveAttribute('data-done', 'true', { timeout: 30_000 });
  await expect(page.getByTestId('witness-replay')).toBeVisible();

  // 3. Jádro AC: stopa, kterou náhled hraje, má TÝŽ hash jako stopa, kterou
  //    ověřovač odkrokoval. Hash certifikátu vzniká uvnitř replay smyčky, takže
  //    tohle porovnává dva nezávisle získané fakty, ne hodnotu se sebou samou.
  const measured = await page.evaluate(() => {
    const api = window.__pipeline!;
    const trace = api.witness();
    const certificate = api.certificate();
    return {
      steps: trace.length,
      previewHash: api.hashWitness(trace),
      certificateHash: certificate === null ? null : certificate.witnessHash,
      inputCount: certificate === null ? null : certificate.inputCount,
      snapshotHash: certificate === null ? null : certificate.snapshotHash,
    };
  });

  expect(measured.steps).toBeGreaterThan(0);
  expect(measured.certificateHash).not.toBeNull();
  expect(measured.previewHash).toBe(measured.certificateHash);
  // Certifikát počítá vstupy nezávisle na tom, kolik jich náhled dostal.
  expect(measured.inputCount).toBe(measured.steps);
  // Hash stopy a hash stavu jsou dvě různé věci; kdyby se rovnaly, jedna z nich
  // se počítá z něčeho jiného, než tvrdí.
  expect(measured.previewHash).not.toBe(measured.snapshotHash);

  // 4. Přehrát znovu opravdu začne od začátku.
  await page.getByTestId('witness-replay').click();
  await expect(strip).toHaveAttribute('data-done', 'false');
  await expect(strip).toHaveAttribute('data-done', 'true', { timeout: 30_000 });
});

test('dokončený náhled přežije nahrazení světem s kratší stopou', async ({ page }) => {
  test.setTimeout(180_000);
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });
  await openInspect(page);

  await page.getByTestId('prompt-input').fill(FROZEN_PROMPT);
  await page.getByTestId('prompt-submit').click();
  await expect(page.getByTestId('witness-preview')).toHaveAttribute('data-done', 'true', { timeout: 30_000 });

  const before = await page.evaluate(() => {
    const api = window.__pipeline!;
    return { hash: api.certificate()!.snapshotHash, steps: api.witness().length };
  });
  expect(before.steps).toBe(5);

  await page.getByTestId('prompt-input').fill(SHORTER_TRACE_PROMPT);
  await page.getByTestId('prompt-submit').click();
  await page.waitForTimeout(1_000);

  expect(pageErrors).toEqual([]);
  await page.waitForFunction(
    (was) => {
      const api = window.__pipeline;
      return api !== undefined && api.certificate()?.snapshotHash !== was && api.witness().length === 3;
    },
    before.hash,
    { timeout: 60_000 },
  );
  await expect(page.getByTestId('witness-step')).toBeVisible();
});
