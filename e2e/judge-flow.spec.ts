import { readFileSync } from 'node:fs';

import { expect, test, type Page } from '@playwright/test';

import { openInspect } from './inspect';

/**
 * **Celý porotcův průchod jedním testem** (P15 T35, zachráněno z RUN-02).
 *
 * Každý kus téhle cesty má vlastní sadu. Dohromady ji nezkoušel nikdo, a mezi
 * dvěma zelenými sadami se demo rozpadnout umí — přesně to se 6. 9. 2026 stalo
 * `/api/generate` (`T29-e2egeneratedead`): jednotkové testy zelené, produkt
 * mrtvý. Tahle sada je pojistka proti téže třídě vady a současně důkaz do
 * přihlášky.
 *
 * ## Nic se neodchytává, a je to celá cena téhle sady
 *
 * Ani jeden z obou odchytů Playwrightu — ani ten, co odpověď podstrčí, ani
 * ten, co požadavek utne. Sada, která si síť podstrčí, je
 * zelená i nad rozbitým řetězem — tedy zelená přesně tehdy, kdy má být červená.
 * Hlídá to `grep` v AC úlohy a druhý test dole, který se ptá zdroje sám sebe.
 *
 * ## ⚠ Co tahle sada NEMĚŘÍ, a proč to není opomenutí
 *
 * Design book §4 popisuje **čtyři dějství**. Porotcova cesta na kořeni má dnes
 * první dvě. Naměřeno 6. 9. 2026 ve zdroji, ne odhadnuto:
 *
 * - **Dějství III (druhá věta mění svět)** na kořeni není. `WorldstreamApp`
 *   bere panel změny propem `change`, a `src/app/page.tsx` ho nepředává; panel
 *   žije na `/dev/refine`. Navíc `changes/route.ts:106` staví plánovač výhradně
 *   z `cloudEmitter()` — bez `.env` tedy nemá výrobce vůbec, kdežto první věta
 *   ho od `T46-routewire` má ve skladu autorovaných světů. Bez klíče (`G2`,
 *   rozhodnuto 5. 9. 2026) je druhá věta na poctivé cestě nedosažitelná
 *   a zezelenat by šla jedině odchycením sítě, které tahle sada zakazuje.
 * - **Dějství IV (přetáčení času)** na kořeni taky není: `WorldstreamApp` bere
 *   osu propem `axis` a kořen ho nepředává. Osa žije na `/dev/time`.
 *
 * Runbook to říká nahlas a stejnými slovy. **Až se obě dějství na kořen
 * dostanou, patří sem dva takty navíc, ne nová sada** — jinak se „celý průchod"
 * zase rozpadne na kusy, které nikdo nezkouší najednou.
 */

/** Věta, kterou sklad autorovaných světů zná přesně. */
const FLAGSHIP = 'A cathedral of stacked shipping containers around a light well.';

/**
 * Věta, kterou nezná nikdo — porotce má právo zkoušet vlastní (`RULES.md` §3.3).
 *
 * Je to druhý takt s vlastním rozpočtem, ne ozdoba: cesta „nejbližší autorovaný
 * svět" má jiný kód než přesná shoda a rozpadnout se umí samostatně.
 */
const UNSEEN = 'A lighthouse built from stacked fishing boats, still dripping.';

/** Relace, meshování a první snímek na SwiftShaderu. Ne rozpočet produktu. */
const WORLD_BUDGET_MS = 90_000;

/**
 * Doby taktů se **tisknou**, nezapisují do commitnutého souboru.
 *
 * `evals/` už tři takové soubory má a každý běh sady je přepíše, takže se čísla
 * v dokumentech tiše rozejdou s tím, co si o nich tři jiné dokumenty myslí
 * (CLAUDE.md, Konvence). Runbook proto čísla nese opsaná ručně i s datem běhu —
 * pohnou se jedině tehdy, když je někdo vědomě přepíše.
 */
function act(name: string, ms: number): void {
  console.log(`[judge-flow] ${name}: ${Math.round(ms)} ms`);
}

/** Napíše větu a vrátí, jak dlouho trvalo, než svět došel na plátno. */
async function sentenceToCanvas(page: Page, sentence: string): Promise<number> {
  const started = Date.now();
  await page.getByTestId('prompt-input').fill(sentence);
  await page.getByTestId('prompt-submit').click();

  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live', {
    timeout: WORLD_BUDGET_MS,
  });
  // **Stav v Reactu není snímek na GPU.** Bez `frames()` by sada prošla nad
  // světem, který se nikdy nevykreslil, a porotce kouká na plátno, ne na stav.
  await page.waitForFunction(() => (window.__worldstreamStage?.frames() ?? 0) > 0, undefined, {
    timeout: WORLD_BUDGET_MS,
  });
  return Date.now() - started;
}

test('porotce projde celou cestu, jak ji dostane na odevzdání', async ({ page }) => {
  test.setTimeout(300_000);

  // ── Takt 0: porotce dorazí ───────────────────────────────────────────────
  const arrived = Date.now();
  await page.goto('/');
  await expect(page.getByTestId('worldstream-canvas')).toHaveCount(1);
  // Dokud nepřišla věta, produkt **nic nepředstírá**. Prázdný stav je poctivý
  // stav; místnost naslepo by porotci ukázala svět, který nepopsal.
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'empty');
  expect(await page.evaluate(() => window.__worldstreamStage?.slots().length ?? 0)).toBe(0);
  act('takt 0 – stránka připravená', Date.now() - arrived);

  // ── Takt I: věta postaví prostor ─────────────────────────────────────────
  const firstWorld = await sentenceToCanvas(page, FLAGSHIP);
  act('takt I – věta → svět na plátně', firstWorld);

  const built = await page.evaluate(() => {
    const stage = window.__worldstreamStage!;
    return { ready: stage.ready(), slots: stage.slots().length, builds: stage.builds() };
  });
  expect(built.ready, 'scéna se z hrubého světa nepostavila').toBe(true);
  expect(built.slots, 'svět nemá jediný slot').toBeGreaterThan(0);
  expect(built.builds, 'scéna se nepostavila ani jednou').toBeGreaterThan(0);

  // ── Takt II: hmota ztvrdne ───────────────────────────────────────────────
  //
  // **Tohle je takt, který drží meshovač**, a proto se ptá na příčku, ne na
  // počet objektů. `semantic-clay` je hlína — svět z ní samé je „něco se
  // postavilo", ne „hmota ztvrdla". Alespoň jeden slot musí dojít na příčku
  // s doopravdy vymešovaným tvarem, jinak porotce kouká na hrubý náznak
  // a demo o ztvrdnutí lže. Odpojený meshovač musí položit tuhle aserci, ne
  // až něco na konci — to je break-it-on-purpose téhle úlohy.
  const hardened = Date.now();
  await openInspect(page);
  const slots = page.getByTestId('world-facts-slot');
  await expect(slots.first()).toBeVisible();
  const rungs = await slots.evaluateAll((nodes) => nodes.map((node) => node.dataset.rung));
  act('takt II – hmota ztvrdla a je vidět v Inspect', Date.now() - hardened);

  // Uzavřený žebřík hrubého světa (`ROUGH_RUNGS`). Nová příčka se sem **dopíše**,
  // neobjeví se v produktu sama.
  for (const rung of rungs) expect(['g3-reduced', 'g2-rich', 'semantic-clay']).toContain(rung);

  // **Příčka `g3-reduced` je jediná, kterou dodává meshovač** — a musí se
  // jmenovat přesně, ne opsat jako „aspoň něco není hlína".
  //
  // ⚠ **Naměřeno break-it-on-purpose 6. 9. 2026, a první podoba téhle aserce
  // to nechytila.** S odpojeným meshovačem vrátila vlajková věta příčky
  // `g2-rich, semantic-clay, g2-rich`; se zapojeným `g2-rich, g3-reduced,
  // g2-rich`. Slabší tvrzení („aspoň jeden slot není hlína") tedy platilo
  // v obou případech, protože `g2-rich` staví kompozice a ta meshovač
  // nepotřebuje. Odpojený meshovač posune do hlíny **právě hrdinský tvar**,
  // takže právě na něj se sada musí ptát jménem.
  expect(
    rungs.filter((rung) => rung === 'g3-reduced').length,
    `hrdinský tvar se nevymešoval — meshovač nedodal ani jeden (příčky: ${rungs.join(', ')})`,
  ).toBeGreaterThan(0);

  // ── Takt III: produkt mlčí tam, kde nemá co vysvětlovat ──────────────────
  //
  // Vlajkovou větu zná sklad **přesně**, takže se za nic neomlouvá. Poznámka
  // o původu patří k náhradě, ne ke každému světu; kdyby stála i tady, byla by
  // z ní omluva na pozadí, kterou porotce přestane číst.
  await expect(page.getByTestId('world-authored')).toHaveCount(0);
  await expect(page.getByTestId('world-broken')).toHaveCount(0);

  // ── Takt IV: porotce zkusí vlastní větu ──────────────────────────────────
  //
  // `RULES.md` §3.3 mu na to dává právo, takže tohle je ta věta, o kterou se
  // demo doopravdy rozbije. Nesmí skončit prázdnem ani chybou — nejbližší
  // autorovaný svět je odpověď, ne výmluva.
  const ownSentence = await sentenceToCanvas(page, UNSEEN);
  act('takt IV – vlastní věta porotce → svět', ownSentence);

  expect(
    await page.evaluate(() => window.__worldstreamStage!.slots().length),
    'vlastní věta porotce skončila prázdnou scénou',
  ).toBeGreaterThan(0);
  await expect(page.getByTestId('world-broken')).toHaveCount(0);

  // **A TEĎ se produkt ozve.** Svět, který porotce dostal, nenapsal model ani
  // ho nikdo nepsal na tuhle větu — je to nejbližší autorovaný. Že to produkt
  // řekne nahlas, není kosmetika: přihláška se soudí i podle toho, co o sobě
  // tvrdí (`T45-honestlabel`). Obě strany v jednom průchodu schválně — „někdy
  // mlčí, někdy mluví" je tvrzení, které se dá splnit jedině obojím.
  await expect(page.getByTestId('world-authored')).toHaveCount(1);
});

/**
 * **Sada se ptá sama sebe, jestli si nepodstrčila síť.**
 *
 * AC úlohy to hlídá `grep`em zvenčí, jenže grep pustí ten, kdo si vzpomene.
 * Tenhle test se pustí vždycky, a padne i nad odchytem, který sem někdo dopíše
 * příště — třeba v dobré víře, aby sadu zrychlil.
 */
test('tahle sada si nikde nepodstrkuje síť', () => {
  // `test.info().file` je cesta k **běžící** sadě, takže se test nemá o co
  // opřít špatně: přejmenování souboru ani jiný pracovní adresář ho neminou.
  const source = readFileSync(test.info().file, 'utf8');

  // Vlastní jméno v řetězcích níž by test shodilo o sebe sama, proto se skládá.
  const forbidden = ['route.' + 'fulfill', 'route.' + 'abort'];
  for (const call of forbidden) {
    expect(source.split(call).length - 1, `${call} v sadě, která ho má zakázaný`).toBe(0);
  }
});
