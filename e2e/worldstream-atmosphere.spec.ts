import { expect, test } from '@playwright/test';

import { VIEWER_BUDGETS } from '../src/kit/budgets';
import { IMAGE_THRESHOLDS, measureImage } from '../src/worldstream/image-judge';

/**
 * Oracle úlohy T3 — **atmosféra je v produktu vidět, ne jen zapojená**.
 *
 * Vada, kterou tenhle soubor hlídá, je tichá: `<Atmosphere>` se namontuje,
 * `renderer.info` přizná kreslicí volání navíc, a na obrazovce se nezmění nic.
 * Stačí k tomu mlha v barvě pozadí. Test se proto neptá, jestli komponenta
 * existuje — čte **pixely, které plátno doopravdy nakreslilo**, přes
 * `window.__viewer.pixels()`.
 *
 * ## Podíl oblohy: nejdřív měřil rámování, teď soudí obojí
 *
 * **Do 28. 8. 2026 mířila kamera produktu celým snímkem do země.** Statický
 * pohled seděl na `[7, 7, 9]` a mířil do počátku, tedy 31,5° pod vodorovnou
 * při svislém poloúhlu 22,5°: horní hrana snímku ležela 9° POD obzorem. Herní
 * pohled byl horší, odstup `{0, 6, 7.5}` klopil o 38,7°. Podíl oblohy se tady
 * proto **měřil a vypisoval, ale nesoudil** — vypovídal o kameře, ne o vzduchu.
 *
 * Tři kroky, každý se svým naměřeným číslem:
 *
 * | Svět | Do T8 | Po T8 (rámování) | Po zemi (H2) |
 * |---|---|---|---|
 * | `harbor-pier` | 0,0 % · mrtvá 0,28 | 32,0 % · 0,34 | 32,0 % · 0,34 |
 * | `dunes-terrace` | 94,9 % · **0,88** | 96,2 % · **0,84** | **32,5 % · 0,55** |
 * | `frost-plateau` | 0,0 % · 0,31 | 31,8 % · 0,21 | 31,8 % · 0,19 |
 *
 * **T8 spravila dva světy ze tří a na třetí nestačila**, protože `dunes-terrace`
 * nemá vodu a kit pod svět podlahu nestaví — pod obzorem tam nebylo nic, a to
 * platí pro každý úhel. Doplnila to zem jako samostatné pole popisu vzhledu.
 * Od té doby se podíl oblohy **soudí** pásmem 15–45 %.
 *
 * ## Co tedy tenhle soubor doopravdy hlídá
 *
 * 1. **Svět, který rámování nezkazí, projde soudcem celý** — pásma jasu,
 *    odstíny i mrtvá plocha.
 * 2. **Tři palety dají tři různě zbarvené snímky.** Mlha barví všechnu
 *    geometrii a barvu si bere z popisu vzhledu, takže atmosféra zapnutá
 *    naprázdno by průměry srovnala. Na tohle není obzor potřeba.
 * 3. **Rozpočet snímku drží** i s oblohou, vodou a prachem navíc.
 *
 * ## Co se tady neměří
 *
 * Snímková frekvence. Sada jede na SwiftShaderu (softwarový renderer bez
 * grafické karty), takže časy měří kadenci časovače, ne scénu — viz hlavičku
 * `e2e/target-frame.spec.ts`. Trojúhelníky, kreslicí volání a jas pixelu jsou
 * naopak na ovladači nezávislé a soudí se vždycky.
 */

/** Kolik snímků se nechá proběhnout, než se čte. První nesou kompilaci shaderů. */
const SETTLE_FRAMES = 5;

/**
 * Světy, kterým se mrtvá plocha toleruje — **jménem, ne počtem**, a jako horní
 * mez, ne jako rovnost.
 *
 * Historie čísla: do rámování propadal jediný ze tří, `dunes-terrace` s 0,88.
 * Po spočítaném rámování (T8) zůstal na 0,84 — kamera za to nemohla, ten svět
 * neměl **zem**. Po zavedení země (brána H2) spadl na 0,53 a seznam se
 * vyprázdnil.
 *
 * ⚠ **Od 29. 8. 2026 stojí `dunes-terrace` na 0,55, tedy přesně na prahu.**
 * Do té doby mířily opravné kotvy odstínů na tři pevné odstíny (195 / 45 / 165)
 * rozdané podle role, takže **každý** opravený svět skončil v téže trojici
 * košů; přístav a poušť pak měly průměrnou barvu snímku vzdálenou **2,7** proti
 * prahu 8. Kotvy se proto vážou na oblohu toho konkrétního světa (T11-anchors)
 * a vzdálenost stoupla na **17,0** (naměřeno 30. 8. 2026: přístav 56/58/51,
 * poušť 56/75/50). Poušť za to zaplatila 0,53 → 0,55.
 *
 * ⚠ **Do 30. 8. 2026 tu stálo 14.** To číslo se měřilo, když ještě páka jasu
 * ztmavovala desku pod hladinou místo hladiny samotné; po té opravě je
 * skutečná vzdálenost 17,0. Nepohnul se práh, jen se přestalo měřit proti
 * ploše, kterou snímek neukazuje.
 *
 * **Proto je to seznam tolerovaných, ne očekávaných.** Svět přesně na prahu
 * překlopí rozptyl mezi běhy; aserce na rovnost by červenala střídavě podle
 * toho, jak vyšlo zaokrouhlení, a nikdo by ji po třetím falešném poplachu
 * nečetl. Naměřeno v pěti bězích 29. 8. 2026: 0,55 · 0,56 · 0,57 na tomhle
 * výřezu, 0,556 na kontaktním listu. **Číslo se vypisuje každý běh**, takže
 * skutečný pohyb je vidět i bez toho, aby ho hlídala aserce.
 *
 * **Od 30. 8. 2026 se stejně rozhoduje i `e2e/contact-sheet.spec.ts`.** Do té
 * doby pinoval tentýž svět přes `toEqual`, takže se dvě sady o téže poušti
 * rozhodovaly opačně a člověk se dozvěděl dvě různé pravdy podle toho, kterou
 * pustil. Vyhrála tahle volba, protože za ní stojí těch pět běhů.
 *
 * Co aserce hlídá dál v plné síle: že mrtvý nezčerná **jiný** svět. Práh
 * soudce (`IMAGE_THRESHOLDS.maxDead`) se nezvedl ani o setinu.
 *
 * **Rozhodl uživatel 29. 8. 2026: vyhrávají rozpoznatelně různé světy.** Plochý
 * pouštní snímek je vědomá cena za to, že přístav a poušť nejsou tatáž barva.
 * Poušť má z celé sady nejmíň odstínů (5), takže hotová není: adresou je výběr
 * rodiny a kompozice v P13 vlně 2, ne další látání vzhledu.
 */
const DEAD_WORLDS_TOLERATED: readonly string[] = ['dunes-terrace'];

/**
 * Pásmo, ve kterém má obloha zabírat plochu snímku — AC úlohy T8.
 *
 * Nad ním je svět model na nekonečném pozadí, pod ním je pohled do jámy bez
 * obzoru, jak vypadal celý produkt do brány K0.
 */
const SKY_BAND = { min: 0.15, max: 0.45 } as const;

/**
 * Světy, které do pásma nespadnou — **jménem, ne počtem**.
 *
 * Počet by prošel i tehdy, kdyby z pásma vypadl jiný svět a tenhle se spravil,
 * což je přesně ta výměna, kterou nikdo nechce přehlédnout.
 *
 * **Dnes je prázdný a stálo to dva kroky.** `dunes-terrace` tu stálo s 96,2 %
 * oblohy: nemělo vodu a kit pod svět podlahu nestaví, takže pod obzorem svítila
 * koule oblohy. Zem ho srovnala na **32,5 %**. Mimo pásmo zůstává jediný svět
 * celého listu, `C02` — 5,5 %, opačný konec téže osy, kulisa vyplní celý výřez.
 * Ten se tudy neměří, je routovaný jako `T8-c02`.
 */
const SKY_OUT_OF_BAND: readonly string[] = [];

/** Svět, na kterém se produkt otevírá. Ten musí obstát celý, ne částečně. */
const DEFAULT_WORLD = 'harbor-pier';

/**
 * Jak moc se musí lišit průměrná barva dvou světů.
 *
 * Tohle je aserce, která odhalí atmosféru zapnutou naprázdno. Mlha barví
 * **všechnu** geometrii ve scéně a její barvu bere z popisu vzhledu, takže dvě
 * různé palety musí dát dva různě zbarvené snímky i bez kousku oblohy. Kdyby
 * se `<Atmosphere>` odpojila nebo si barvu vzala z konstanty, průměry by se
 * srovnaly. Osm stupňů na kanál je nad šumem antialiasingu a hluboko pod
 * rozdílem, který dělají palety.
 */
const MIN_WORLD_COLOUR_DISTANCE = 8;

/** Světy, nad kterými se měří. Různé palety, tedy různá atmosféra. */
const LAYOUTS = [DEFAULT_WORLD, 'dunes-terrace', 'frost-plateau'] as const;

interface Shot {
  readonly data: number[];
  readonly width: number;
  readonly height: number;
}

/** Průměrná barva snímku. Tři čísla, ve kterých je vidět, jaký měl svět vzduch. */
function meanColour(image: Shot): [number, number, number] {
  let red = 0;
  let green = 0;
  let blue = 0;
  const pixels = image.width * image.height;
  for (let at = 0; at < pixels; at += 1) {
    red += image.data[at * 4];
    green += image.data[at * 4 + 1];
    blue += image.data[at * 4 + 2];
  }
  return [red / pixels, green / pixels, blue / pixels];
}

/** Vzdálenost dvou barev po kanálech. Největší rozdíl rozhoduje, ne průměr rozdílů. */
function colourDistance(a: readonly number[], b: readonly number[]): number {
  return Math.max(Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1]), Math.abs(a[2] - b[2]));
}

test('produktové plátno má tonální rozsah, vlastní vzduch a vejde se do rozpočtu', async ({
  page,
}) => {
  test.setTimeout(180_000);

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto(`/embed/${DEFAULT_WORLD}`);
  await page.waitForFunction(() => window.__viewer !== undefined, undefined, { timeout: 60_000 });

  // **Nejdřív se změří všechny světy, teprve pak se soudí.** Aserce uvnitř
  // smyčky utnou běh na prvním propadlém světě a o zbývajících se nedozvíme
  // nic — a přitom je to právě rozdíl mezi světy, co tahle úloha dokazuje.
  const measured: {
    layout: string;
    spread: number;
    hues: number;
    dead: number;
    sky: number;
    colour: [number, number, number];
    calls: number;
    triangles: number;
  }[] = [];

  for (const layout of LAYOUTS) {
    const read = await page.evaluate(
      async ([name, frames]) => {
        const viewer = window.__viewer!;
        // Pořadí `LAYOUTS` v testu není pořadím layoutů v prohlížeči — index se
        // proto hledá podle jména. Naslepo předaná pozice měřila 28. 8. 2026
        // `kiln-court` a tvrdila o něm, že je to `dunes-terrace`.
        const index = viewer.layouts.indexOf(name as string);
        viewer.switchTo(index);
        const from = viewer.frames();
        while (viewer.frames() < from + frames) {
          await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        }
        // Odečet je slib: čeká na snímek, protože mimo něj se čte poslední
        // složený obraz místo toho, co se právě vykreslilo.
        const shot = await viewer.pixels();
        return { shot, render: viewer.render(), layout: viewer.layouts[index] };
      },
      [layout, SETTLE_FRAMES] as const,
    );

    expect(read.layout, 'plátno musí přepnout na layout, který se měří').toBe(layout);

    const image = measureImage(read.shot);
    measured.push({
      layout,
      spread: image.luminanceSpread,
      hues: image.hues,
      dead: image.dead,
      sky: read.shot.sky,
      colour: meanColour(read.shot),
      calls: read.render.calls,
      triangles: read.render.triangles,
    });
  }

  for (const world of measured) {
    console.log(
      `[atmosphere] ${world.layout}: pásma ${world.spread.toFixed(2)}, ` +
        `obloha ${(world.sky * 100).toFixed(1)} %, mrtvá plocha ${world.dead.toFixed(2)}, ` +
        `odstíny ${String(world.hues)}, ` +
        `průměr ${world.colour.map((channel) => Math.round(channel)).join('/')}, ` +
        `${String(world.calls)} volání, ${String(world.triangles)} trojúhelníků`,
    );

    // Plátno, které nic nenakreslilo, by prošlo každým stropem se stoprocentní
    // rezervou. Podlaha je proto první.
    expect(world.calls, `${world.layout}: nula kreslicích volání je prázdná scéna`).toBeGreaterThan(
      0,
    );
    expect(world.triangles, `${world.layout}: prázdné plátno o snímku netvrdí nic`).toBeGreaterThan(
      0,
    );

    expect(
      world.calls,
      `${world.layout} překračuje strop kreslicích volání: ${String(world.calls)}`,
    ).toBeLessThanOrEqual(VIEWER_BUDGETS.maxDrawCallsPerFrame);
    expect(
      world.triangles,
      `${world.layout} překračuje strop trojúhelníků: ${String(world.triangles)}`,
    ).toBeLessThanOrEqual(VIEWER_BUDGETS.maxTrianglesPerFrame);
  }

  // 1. Svět, na kterém se produkt otevírá, musí obstát u soudce celý. Kdyby se
  //    atmosféra nezapojila, tenhle svět je první, kde to bude vidět.
  const opening = measured.find((world) => world.layout === DEFAULT_WORLD)!;
  expect(
    opening.spread,
    `${DEFAULT_WORLD} má obsazená jen ${String(Math.round(opening.spread * 5))} pásma jasu z pěti; ` +
      'plochá mlha nad jedním pozadím vypadá přesně takhle',
  ).toBeGreaterThanOrEqual(IMAGE_THRESHOLDS.minLuminanceSpread);
  expect(
    opening.hues,
    `${DEFAULT_WORLD} má míň odstínů než práh soudce — atmosféra scéně barvu nepřidala`,
  ).toBeGreaterThanOrEqual(IMAGE_THRESHOLDS.minHues);
  expect(
    opening.dead,
    `${DEFAULT_WORLD} je z ${String(Math.round(opening.dead * 100))} % mrtvá plocha`,
  ).toBeLessThanOrEqual(IMAGE_THRESHOLDS.maxDead);

  // 2. Tři palety, tři vzduchy. Tohle odliší zapojenou atmosféru od atmosféry
  //    zapnuté naprázdno — a nepotřebuje k tomu ani kousek oblohy.
  for (const [first, second] of [
    [0, 1],
    [1, 2],
    [0, 2],
  ] as const) {
    const distance = colourDistance(measured[first].colour, measured[second].colour);
    expect(
      distance,
      `${measured[first].layout} a ${measured[second].layout} mají skoro tentýž průměr barvy ` +
        `(${distance.toFixed(1)}); mlha si bere barvu z popisu vzhledu, takže dvě palety ` +
        'nesmí dát tentýž snímek',
    ).toBeGreaterThanOrEqual(MIN_WORLD_COLOUR_DISTANCE);
  }

  // 3. Obloha v pásmu, které žádá AC úlohy T8. Soudí se od T8; do ní se podíl
  //    jen vypisoval, protože o něm rozhoduje rámování, a to T8 vlastní.
  for (const world of measured) {
    if (SKY_OUT_OF_BAND.includes(world.layout)) {
      // **Mimo pásmo znamená pod ním NEBO nad ním.** První verze téhle aserce
      // uměla jen „pod" a naměřených 95,2 % prohlásila za opravu — přitom je to
      // ta horší polovina vady. Naměřeno 28. 8. 2026 při běhu T8.
      expect(
        world.sky < SKY_BAND.min || world.sky > SKY_BAND.max,
        `${world.layout} je vedený jako svět mimo pásmo, ale obloha je v pásmu ` +
          `(${(world.sky * 100).toFixed(1)} %). Spravilo se to — vyškrtni ho ze ` +
          'SKY_OUT_OF_BAND a zapiš proč.',
      ).toBe(true);
      continue;
    }

    expect(
      world.sky,
      `${world.layout}: obloha zabírá ${(world.sky * 100).toFixed(1)} % plochy, ` +
        `pásmo je ${String(SKY_BAND.min * 100)}–${String(SKY_BAND.max * 100)} %`,
    ).toBeGreaterThanOrEqual(SKY_BAND.min);
    expect(
      world.sky,
      `${world.layout}: obloha zabírá ${(world.sky * 100).toFixed(1)} % plochy, ` +
        `pásmo je ${String(SKY_BAND.min * 100)}–${String(SKY_BAND.max * 100)} %`,
    ).toBeLessThanOrEqual(SKY_BAND.max);
  }

  // 4. Připíchnutý dluh, jménem. Není to cíl — viz hlavičku u
  //    `DEAD_WORLDS_TOLERATED`.
  const dead = measured.filter((world) => world.dead > IMAGE_THRESHOLDS.maxDead);
  const unexpected = dead.filter((world) => !DEAD_WORLDS_TOLERATED.includes(world.layout));
  expect(
    unexpected.map((world) => world.layout),
    `soudce označil za mrtvé: ${dead.map((w) => `${w.layout} ${w.dead.toFixed(3)}`).join(', ') || 'nic'}. ` +
      'Přibylo-li jméno, přestal obstát svět, který obstát měl.',
  ).toEqual([]);
});

test('poušť vodu nedostane, mráz ano — a je to na ploše snímku vidět', async ({ page }) => {
  /**
   * **Počet kreslicích volání to změřit neumí, i když to tak vypadá.**
   * Do 28. 8. 2026 tady stálo `frost > dunes` nad celkovým počtem volání
   * (51 proti 42). Jenže těch devět volání rozdílu dělá geometrie layoutu,
   * ne hladina — ta je jedno jediné. Aserce by proto zůstala zelená i tehdy,
   * kdyby se voda kreslila úplně všude: 43 je pořád míň než 51. Byla to
   * ozdoba, ne měřidlo.
   *
   * Hladina se proto schová podle jména a čte se **plocha snímku, kterou
   * maluje** — v mrazivém světě musí být nenulová, v pouštním přesně nula.
   */
  test.setTimeout(120_000);

  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/embed/dunes-terrace');
  await page.waitForFunction(() => window.__viewer !== undefined, undefined, { timeout: 60_000 });

  const measured = await page.evaluate(async (frames) => {
    const viewer = window.__viewer!;
    const share = async (name: string): Promise<number> => {
      viewer.switchTo(viewer.layouts.indexOf(name));
      const from = viewer.frames();
      while (viewer.frames() < from + frames) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
      }
      return (await viewer.pixels()).water;
    };

    return { dunes: await share('dunes-terrace'), frost: await share('frost-plateau') };
  }, SETTLE_FRAMES);

  console.log(
    `[atmosphere] hladina: duny ${(measured.dunes * 100).toFixed(2)} %, ` +
      `mráz ${(measured.frost * 100).toFixed(2)} %`,
  );

  expect(
    measured.dunes,
    `poušť namalovala hladinou ${(measured.dunes * 100).toFixed(2)} % snímku; ` +
      'popis vzhledu jí vodu nedává, takže tam nesmí být ani pixel',
  ).toBe(0);

  expect(
    measured.frost,
    'mrazivý svět hladinu má, ale nenamaloval s ní ani pixel — je zapojená a nekreslí',
  ).toBeGreaterThan(0);
});
