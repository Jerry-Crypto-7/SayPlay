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
 * **první tři** — dějství III se na ni dostalo `T35-actsthree4` (6. 9. 2026)
 * a měří ho takty IV a V níž, protože plánovač změny má od téže úlohy tutéž
 * záložní cestu přes sklad autorovaných světů, jakou má první věta od
 * `T46-routewire`. Bez klíče (`G2`) tedy druhá věta výrobce má.
 *
 * Nemá ho **dějství IV (přetáčení času)**, a to na kořeni pořád není. Naměřeno
 * 6. 9. 2026 ve zdroji, ne odhadnuto: `WorldstreamApp` bere osu propem `axis`
 * a `src/app/page.tsx` ho nepředává, takže osa žije jen na `/dev/time`.
 *
 * Runbook to říká nahlas a stejnými slovy. **Až se dějství IV na kořen dostane,
 * patří sem takt navíc, ne nová sada** — jinak se „celý průchod" zase rozpadne
 * na kusy, které nikdo nezkouší najednou.
 */

/**
 * Věta, kterou sklad autorovaných světů zná přesně.
 *
 * ⚠ **Vybral ji sklad, ne vkus — a od `T35-actsthree4` (6. 9. 2026) je to
 * `c03`, ne katedrála z kontejnerů.** Průchod má nově dějství III a to se nedá
 * doložit nad libovolným světem: uvařená změna musí mířit na **hrdinský**
 * objekt a nést nový tvar, jinak se přepis tvaru odmítne („drawn by the
 * composition, not by a hero shape") nebo se nemá kde projevit. Naměřeno ve
 * skladu 6. 9. 2026: katedrála má jedinou uvařenou změnu `r12` a ta je jen
 * o vzhledu — svět by se přestavěl, ale `contentHash` ani `triangles` by se
 * nehnuly, takže by aserce o změněném světě byla zelená i nad `apply()`, které
 * nedělá nic. Most z `c03` má změnu `r15` na hrdinovi `hangingHouses`
 * a s ní nový tvar.
 */
const FLAGSHIP = 'A brutalist observatory, one dome on three splayed legs, on a windswept plateau.';

/**
 * Druhá věta — **záměrně ne doslova ta uvařená**.
 *
 * Sklad zná `r15` jako „Make the hanging houses bigger and let them sway.";
 * tahle říká totéž jinými slovy, protože porotce píše vlastní větu, ne opsanou
 * (`RULES.md` §3.3). Měří se tím současně poctivý popisek (`T45-honestlabel`):
 * doslovná věta by dala `exact`, popisek by mlčel, a takt by prošel i tehdy,
 * kdyby žádný popisek neexistoval.
 */
const SECOND = 'Splay the observatory legs wider so the dome drops lower.';

/**
 * Věta, kterou nezná nikdo — porotce má právo zkoušet vlastní (`RULES.md` §3.3).
 *
 * Je to druhý takt s vlastním rozpočtem, ne ozdoba: cesta „nejbližší autorovaný
 * svět" má jiný kód než přesná shoda a rozpadnout se umí samostatně.
 */
const UNSEEN = 'A lighthouse built from stacked fishing boats, still dripping.';

/** Relace, meshování a první snímek na SwiftShaderu. Ne rozpočet produktu. */
const WORLD_BUDGET_MS = 90_000;

/** Plán změny a přestavba světa po ní. Táž třída rozpočtu, ne produktová mez. */
const CHANGE_BUDGET_MS = 90_000;

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

/**
 * Otisk scény: co v ní stojí a jak to vypadá. Před druhou větou a po ní.
 *
 * `builds()` je jediné číslo, které přežije přestavbu, a hlavní stránka svět po
 * potvrzení **staví znovu** — nevyměňuje slot za běhu jako `/dev/refine`, takže
 * `commits()` tady zůstane na nule a čekat na něj by sadu zavěsilo.
 *
 * ⚠ **Otisk musí nést i umístění, ne jen tvar — naměřeno 6. 9. 2026.** První
 * podoba se ptala na `contentHash` a počet trojúhelníků a **byla slepá**: na
 * hlavní cestě je `contentHash` u všech slotů `null` (registr podob plní až
 * hot-swap na `/dev/refine`) a uvařená změna `r02` posouvá kupoli translací
 * uvnitř jejího SDF, což počet trojúhelníků nechává na 11 340 před i po. Svět
 * se přitom prokazatelně změnil — `transform.translation` kupole se hnul
 * z 5,013 na 5,506. Otisk proto bere celý slot.
 */
async function stageShape(page: Page): Promise<{
  readonly builds: number;
  readonly ids: readonly string[];
  readonly signatures: readonly string[];
}> {
  return page.evaluate(() => {
    const stage = window.__worldstreamStage!;
    const slots = stage.slots();
    return {
      builds: stage.builds(),
      ids: slots.map((slot) => slot.stableId),
      signatures: slots.map((slot) =>
        JSON.stringify({
          rung: slot.rung,
          triangles: slot.triangles,
          contentHash: slot.contentHash,
          transform: slot.transform,
          sockets: slot.sockets,
        }),
      ),
    };
  });
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

  // ── Takt IV: druhá věta chirurgicky změní jeden objekt ───────────────────
  //
  // Dějství III design booku §4. Do `T35-actsthree4` (6. 9. 2026) na porotcově
  // cestě nebylo vůbec — panel změny žil na `/dev/refine` a plánovač se stavěl
  // výhradně z cloudového modelu. Bez zaplaceného klíče (`G2`) ho dnes obslouží
  // sklad uvařených změn, toutéž záložní cestou jako první větu.
  const beforeChange = await stageShape(page);
  const planned = Date.now();
  await page.getByTestId('refine-input').fill(SECOND);
  await page.getByTestId('refine-submit').click();

  const panel = page.getByTestId('change-preview');
  // `data-kind` rozhoduje: `candidates` i `refused` jsou taky panel, jen to
  // nejsou plány. Bez atributu by `toBeVisible()` prošlo i nad odmítnutím.
  await expect(panel).toHaveAttribute('data-kind', 'preview', { timeout: CHANGE_BUDGET_MS });
  act('takt IV – druhá věta → plán změny', Date.now() - planned);

  // Plán míří na **jeden** objekt a řekne na který. Prázdný popisek by prošel
  // pouhým `toBeVisible()`, takže se sada ptá na text.
  await expect(page.getByTestId('change-target')).not.toBeEmpty();
  await expect(page.getByTestId('change-summary')).not.toBeEmpty();

  // **A tady se produkt zase ozve** (`T45-honestlabel`). Plán té změny nenapsal
  // model teď, je to nejbližší uvařená změna, a porotce to má vědět. Je to jiná
  // věta než ta o původu světa a jiná komponenta: přiznává se původ **plánu**,
  // ne původ světa, který v tuhle chvíli sedí na přesné shodě a mlčí.
  await expect(page.getByTestId('change-authored')).toHaveCount(1);

  // ── Takt V: potvrzení přestaví svět a identita to přežije ────────────────
  const applied = Date.now();
  await page.getByTestId('change-apply').click();
  // Panel po potvrzení zmizí: rozhodnuto je, není o čem rozhodovat.
  await expect(panel).toHaveCount(0, { timeout: CHANGE_BUDGET_MS });
  await page.waitForFunction(
    (was) => (window.__worldstreamStage?.builds() ?? 0) > was,
    beforeChange.builds,
    { timeout: CHANGE_BUDGET_MS },
  );
  act('takt V – potvrzení → změněný svět', Date.now() - applied);

  const afterChange = await stageShape(page);
  await expect(page.getByTestId('world-status')).toHaveAttribute('data-state', 'live');
  await expect(page.getByTestId('world-broken')).toHaveCount(0);

  // **Identita změnu přežije** — to je celý slib dějství III. Mění se jeden
  // objekt, ne svět: žádný `stableId` nesmí přibýt ani zmizet, jinak porotce
  // dostal nový svět a tvrzení o chirurgické změně je nepravda.
  expect(afterChange.ids, 'druhá věta vyměnila svět, ne objekt').toEqual(beforeChange.ids);

  // **A právě jeden objekt musí vypadat jinak.** To je celý rozdíl mezi
  // „chirurgickou změnou" a „novým světem", a drží obě strany naráz: nula
  // znamená, že `apply()` svět jen přestavělo z týchž dat (`builds()` by
  // vyrostlo i tak), víc než jedna znamená, že se porotci pod rukama změnilo
  // i to, o co nežádal. Naměřeno: hne se jedině kupole, cíl věty.
  const moved = afterChange.signatures.filter(
    (signature, index) => signature !== beforeChange.signatures[index],
  );
  expect(
    moved.length,
    `druhá věta měla změnit právě jeden objekt (${beforeChange.signatures.join(' | ')} → ${afterChange.signatures.join(' | ')})`,
  ).toBe(1);

  // ── Takt VI: porotce zkusí vlastní větu ──────────────────────────────────
  //
  // `RULES.md` §3.3 mu na to dává právo, takže tohle je ta věta, o kterou se
  // demo doopravdy rozbije. Nesmí skončit prázdnem ani chybou — nejbližší
  // autorovaný svět je odpověď, ne výmluva.
  const ownSentence = await sentenceToCanvas(page, UNSEEN);
  act('takt VI – vlastní věta porotce → svět', ownSentence);

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
