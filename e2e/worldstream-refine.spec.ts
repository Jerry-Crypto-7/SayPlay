import { expect, test, type Page } from '@playwright/test';

import type { StageProbe, StageSlotProbe } from '../src/components/viewer/WorldstreamStage';

/**
 * **Druhá věta trefí objekt, na který porotce ukázal** (P15 T23, design book §4
 * dějství III a §21).
 *
 * Sada běží nad `/dev/refine`, tedy nad celou skořápkou `WorldstreamApp`
 * s polem na větu a panelem rozsahu. Hlavička té stránky říká, co je na ní
 * doopravdy a co je harness: **scriptovaný je jediný kus, plán změny**;
 * grounding, výběr paprskem, popisek, panel i materializace jsou produkt.
 *
 * ## Co se tu soudí
 *
 * 1. **Paprsek vrací `stableId` ze slotu, ne jméno meshe.** Podoba se vymění a
 *    její jméno s ní; slot je právě to, co výměnu přežívá.
 * 2. **Popisek objekt sleduje.** Ne „popisek existuje" — po pohybu kamery musí
 *    stát tam, kde objekt doopravdy je, a to se ptá projekce, ne oka.
 * 3. **Nejasná věta nabídne kandidáty a do volby nezmění nic.** Grounding běží
 *    před plánem a je zadarmo, takže tohle je jediný způsob, jakým se druhá
 *    věta smí splést (§24).
 * 4. **Commit vymění jeden slot.** Ostatní objekty drží podobu i trojúhelníky —
 *    to je celý slib „bez resetu".
 * 5. **Zahozený náhled nezmění vůbec nic.**
 *
 * ## Proč se kliká na souřadnici ze sondy
 *
 * Sonda `screen()` vrací střed objektu v pixelech plátna toutéž projekcí, jakou
 * si stage posouvá popisek. Kdyby si souřadnici počítala sada sama z kamery a
 * kvádru, opsala by projekci podruhé a porovnávala by pak výpočet sám se sebou.
 */

/** Kolik snímků se nechá proběhnout, než se čte. Světové matice platí až po prvním. */
const SETTLE_FRAMES = 3;

/** Objekt s hrdinským tvarem — jediný, kterému se dá tvar přepsat. */
const HERO = 'tallHive';

/** Věta, která trefí právě hrdinu: `the tallest hive` je nejdelší shoda. */
const CLEAR_SENTENCE = 'Turn the tallest hive into a narrow spire.';

/**
 * Věta, ve které stojí `the wall` i `the hive` — obě dlouhé osm znaků.
 *
 * **Shoda stejné délky je přesně ten případ, kdy si systém vybírat nemá.**
 * Kdyby jedno z těch jmen bylo delší, grounding by rozhodl sám a tenhle test by
 * měřil něco jiného, než na co se ptá.
 */
const AMBIGUOUS_SENTENCE = 'Raise the wall and the hive.';

declare global {
  interface Window {
    __worldstreamStage?: StageProbe;
  }
}

async function openRefine(page: Page): Promise<void> {
  await page.goto('/dev/refine');
  await expect(page.getByTestId('refine-status')).toContainText('slots', { timeout: 60_000 });
  await page.waitForFunction(
    (frames) => (window.__worldstreamStage?.frames() ?? 0) > frames,
    SETTLE_FRAMES,
  );
}

async function slots(page: Page): Promise<readonly StageSlotProbe[]> {
  return page.evaluate(() => window.__worldstreamStage!.slots());
}

async function slotOf(page: Page, stableId: string): Promise<StageSlotProbe> {
  const all = await slots(page);
  return all.find((slot) => slot.stableId === stableId)!;
}

/** Klikne doprostřed objektu. Souřadnici dává sonda, ne test. */
async function clickObject(page: Page, stableId: string): Promise<void> {
  const at = await page.evaluate((id) => window.__worldstreamStage!.screen(id), stableId);
  expect(at, `${stableId} musí být vidět, jinak se na něj nedá kliknout`).not.toBeNull();
  await page.mouse.click(at!.x, at!.y);
}

/** Napíše větu a odešle ji. */
async function say(page: Page, sentence: string): Promise<void> {
  await page.getByTestId('refine-input').fill(sentence);
  await page.getByTestId('refine-submit').click();
}

test.describe('worldstream refine', () => {
  test('paprsek vybere slot, ne jméno meshe', async ({ page }) => {
    await openRefine(page);
    await clickObject(page, HERO);

    const label = page.getByTestId('object-label');
    await expect(label).toBeVisible();
    // Jméno pro člověka, adresa pro stroj. Ani jedno není jméno podoby.
    await expect(label).toHaveText('the tallest hive');
    await expect(label).toHaveAttribute('data-stable-id', HERO);
  });

  test('popisek objekt sleduje, když se kamera pohne', async ({ page }) => {
    await openRefine(page);
    await clickObject(page, HERO);

    const label = page.getByTestId('object-label');
    await expect(label).toBeVisible();
    await expect(label).toHaveAttribute('data-stable-id', HERO);
    const before = await label.boundingBox();
    // Kamera se čte **před** kliknutím: argumenty `waitForFunction` se
    // vyhodnocují dřív, než se na ni začne čekat, takže odečet za kliknutím by
    // porovnával novou polohu se sebou samou a čekal by donekonečna.
    const from = (await page.evaluate(() => window.__worldstreamStage!.camera()))[0];

    await page.getByTestId('orbit-camera').click();

    /**
     * **Nečeká se na změnu `transform`, ale na kameru a pak na snímky.**
     * Popisek posouvá `useFrame`, takže mezi pohybem kamery a novou polohou leží
     * jeden snímek; čekat na „transform je jiný" znamená číst přesně v tom
     * okně, kdy je nový jen jeden z těch dvou. Naměřeno 3. 9. 2026 jako
     * rozdíl 327 px v jednom běhu ze dvou.
     */
    await page.waitForFunction(
      (previous) => window.__worldstreamStage!.camera()[0] !== previous,
      from,
    );
    const settled = await page.evaluate(() => window.__worldstreamStage!.frames());
    await page.waitForFunction((from) => window.__worldstreamStage!.frames() > from + 1, settled);

    const box = (await label.boundingBox())!;
    expect(box.x, 'popisek se s kamerou hnul').not.toBe(before!.x);

    // **Ne „transform se změnil", ale „popisek stojí nad objektem".** Náhodně
    // posunutý popisek by prošel testem na změnu; tady musí sedět na projekci.
    const at = (await page.evaluate((id) => window.__worldstreamStage!.screen(id), HERO))!;
    expect(Math.abs(box.x + box.width / 2 - at.x)).toBeLessThan(12);
    // Sonda vrací střed kvádru, popisek stojí nad jeho vrchem, takže musí ležet
    // výš než střed — a přitom na obrazovce, ne za jejím okrajem.
    expect(box.y).toBeLessThan(at.y);
    await expect(label).toBeVisible();
  });

  test('kliknutí mimo objekt výběr zruší', async ({ page }) => {
    await openRefine(page);
    await clickObject(page, HERO);
    await expect(page.getByTestId('object-label')).toBeVisible();

    // Levý horní roh: nad kompozicí je nebe, a doku ani ovládání se to nedotkne.
    await page.mouse.click(24, 24);
    await expect(page.getByTestId('object-label')).toHaveCount(0);
  });

  test('druhá věta ukáže konkrétní rozsah a to, co zůstane', async ({ page }) => {
    await openRefine(page);
    await say(page, CLEAR_SENTENCE);

    const panel = page.getByTestId('change-preview');
    await expect(panel).toHaveAttribute('data-kind', 'preview');
    // Cíl se hlásí lidským jménem, ne modulem ani `stableId`.
    await expect(page.getByTestId('change-target')).toHaveText('the tallest hive');
    await expect(page.getByTestId('change-summary')).not.toBeEmpty();
    await expect(page.getByTestId('change-scope')).toHaveText('This changes a new shape.');
    // Druhá polovina slibu „bez resetu": jmenovitě to, čeho se změna nedotkne.
    const preserved = page.getByTestId('change-preserved');
    await expect(preserved).toContainText('the hillside terrace');
    await expect(preserved).toContainText('the drystone wall');
    await expect(preserved).toContainText("the smoker's box");
    await expect(preserved).not.toContainText('the tallest hive');
  });

  test('nejasná věta nabídne kandidáty a do volby nezmění nic', async ({ page }) => {
    await openRefine(page);
    const before = await slotOf(page, HERO);

    await say(page, AMBIGUOUS_SENTENCE);

    const panel = page.getByTestId('change-preview');
    await expect(panel).toHaveAttribute('data-kind', 'candidates');
    const candidates = page.getByTestId('change-candidate');
    await expect(candidates).toHaveCount(2);
    await expect(candidates.filter({ hasText: 'the drystone wall' })).toHaveCount(1);
    await expect(candidates.filter({ hasText: 'the tallest hive' })).toHaveCount(1);

    // **Nic se nesmělo hnout.** Ani revize, ani podoba, ani jediný commit.
    const during = await slotOf(page, HERO);
    expect(during.contentHash).toBe(before.contentHash);
    expect(during.triangles).toBe(before.triangles);
    expect(await page.evaluate(() => window.__worldstreamStage!.commits())).toBe(0);

    // Teprve volba rozhodne, a rozhodne ji člověk.
    await candidates.filter({ hasText: 'the tallest hive' }).click();
    await expect(panel).toHaveAttribute('data-kind', 'preview');
    await expect(page.getByTestId('change-target')).toHaveText('the tallest hive');
  });

  test('objekt kreslený kompozicí tvar přepsat nejde, a řekne se to', async ({ page }) => {
    await openRefine(page);
    await say(page, 'Turn the drystone wall into a hedge.');

    await expect(page.getByTestId('change-preview')).toHaveAttribute('data-kind', 'refused');
    await expect(page.getByTestId('change-refusal')).toContainText('not by a hero shape');
    expect(await page.evaluate(() => window.__worldstreamStage!.commits())).toBe(0);
  });

  test('potvrzení vymění jediný slot a ostatní nechá být', async ({ page }) => {
    await openRefine(page);
    const before = await slots(page);

    await say(page, CLEAR_SENTENCE);
    await expect(page.getByTestId('change-preview')).toHaveAttribute('data-kind', 'preview');
    await page.getByTestId('change-apply').click();

    // **Kliknutí do rozhraní není kliknutí do světa.** R3F hlásí `onPointerMissed`
    // za každý klik, který dorazí na zdroj událostí plátna — a tím je rodič
    // celé skořápky. Bez podmínky ve `WorldstreamStage` by `Apply` zrušilo
    // výběr, takže by popisek zmizel přesně ve chvíli, kdy se objekt mění.
    await expect(page.getByTestId('object-label')).toHaveAttribute('data-stable-id', HERO);

    await page.waitForFunction(() => window.__worldstreamStage!.commits() > 0, undefined, {
      timeout: 30_000,
    });
    // Panel po commitu zmizí: rozhodnuto je, není o čem rozhodovat.
    await expect(page.getByTestId('change-preview')).toHaveCount(0);

    const after = await slots(page);
    expect(after).toHaveLength(before.length);

    for (const previous of before) {
      const now = after.find((slot) => slot.stableId === previous.stableId)!;
      // Identita a obal drží u všech, i u toho vyměněného (§13.2).
      expect(now.groups).toBe(1);
      expect(now.failure).toBeNull();

      if (previous.stableId === HERO) {
        // Jiná podoba, tedy jiný otisk — jinak by se nedalo poznat, že se
        // vyměnilo cokoli.
        expect(now.contentHash).not.toBe(previous.contentHash);
        expect(now.attached).toBe(true);
      } else {
        expect(now.contentHash).toBe(previous.contentHash);
        expect(now.triangles).toBe(previous.triangles);
        expect(now.attached).toBe(previous.attached);
      }
    }

    expect(await page.evaluate(() => window.__worldstreamStage!.commits())).toBe(1);
  });

  test('zahozený náhled nezmění revizi ani podobu', async ({ page }) => {
    await openRefine(page);
    const before = await slots(page);

    await say(page, CLEAR_SENTENCE);
    await expect(page.getByTestId('change-preview')).toHaveAttribute('data-kind', 'preview');
    await page.getByTestId('change-discard').click();
    await expect(page.getByTestId('change-preview')).toHaveCount(0);

    const after = await slots(page);
    for (const previous of before) {
      const now = after.find((slot) => slot.stableId === previous.stableId)!;
      expect(now.contentHash).toBe(previous.contentHash);
      expect(now.triangles).toBe(previous.triangles);
      expect(now.staged).toBe(false);
    }
    expect(await page.evaluate(() => window.__worldstreamStage!.commits())).toBe(0);
  });
});
