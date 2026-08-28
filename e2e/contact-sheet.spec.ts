import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { runEmission } from '../src/app/api/emit/chain';
import { encodePng } from '../src/app/api/og/png';
import { LAYOUTS } from '../src/kit';
import {
  IMAGE_PROPERTIES,
  IMAGE_THRESHOLDS,
  judgeImage,
  type ImageProperty,
} from '../src/worldstream/image-judge';

/**
 * Oracle úlohy T7 — **celý kontaktní list najednou, ne jeden snímek**.
 *
 * Brána K0 se v P13 ptala „je ten ručně napsaný snímek 10/10?". Ruční snímek ale
 * dokazuje **strop** — co ze slovníku vymáčkne člověk. Riziko projektu je
 * **podlaha**: jak vypadá poslední svět od posledního porotce. Tenhle běh proto
 * postaví **každý svět, na který se dá dnes dostat adresou**, každý změří pěti
 * čísly ze `image-judge.ts` a složí je do jednoho obrázku, nad kterým rozhoduje
 * brána H1.
 *
 * ## Proč list nemá dvacet políček, i když tak zní zadání úlohy
 *
 * **Naměřeno 28. 8. 2026, přímo nad `runEmission()`:** z patnácti vět, které
 * staví svět od nuly (`C01`…`C15` ve zmrazeném korpusu), skončí
 * **`CERTIFIED` jen šest** — `C01`, `C02`, `C03`, `C04`, `C06`, `C07`. Sedm je
 * `REJECTED` (pětkrát `NO_WIN`, tedy ověřovač nenašel cestu k výhře) a dvě
 * `NO_FIT`. Propadlá věta scénu nezmění, takže její políčko by ukazovalo
 * výchozí layout — dvacet políček by se vyrobit dalo, ale osm z nich by byl
 * tentýž obrázek pod cizím jménem.
 *
 * Šest vět plus šest ručně skládaných layoutů kitu je **dvanáct** skutečných
 * světů, a to je celý dnešní dosah produktu. Tohle číslo se **nikde nepíše
 * ručně**: seznam vět se filtruje `runEmission()` za běhu, takže jakmile věty
 * začnou procházet častěji — na to míří cloudový model v P13 vlně 2 — list se
 * rozroste sám a mřížka se přepočítá. Kdyby tu stálo připíchnuté `20`, musel by
 * to někdo přijít změnit, a do té doby by list buď padal, nebo lhal.
 *
 * ## Dvě cesty na jednom listu
 *
 * **Věty jdou přes `?emit=`, protože jinou cestou do `/embed` nevedou.** Volný
 * text se dnes zadává jen na `/` přes `POST /api/generate`; embed rozumí
 * jedinému parametru a tím je id zmrazené věty. Je to táž cesta, kterou měří
 * `e2e/scenery.spec.ts` a `e2e/dressing.spec.ts`, tedy skutečná produktová
 * cesta věta → svět, ne obchvat kvůli měření.
 *
 * **Layout bez `?emit=` kulisu nemá** (`Viewer.tsx` sáhne po `WorldScene` až se
 * světem), takže šest políček ukazuje holý layout a šest hotový vygenerovaný
 * svět. Ten rozdíl je v JSONu pojmenovaný polem `source` — kdyby se smazal,
 * četl by se list jako stejnorodý vzorek a podlaha generovaných světů by se
 * schovala za ruční layouty.
 *
 * ## Co se tvrdí a co ne
 *
 * Netvrdí se, že je obraz hezký — to je celý smysl brány H1, kterou dělá člověk.
 * Tvrdí se to jediné, co stroj pozná: že se ta čísla mezi světy **liší**. Dvanáct
 * skoro stejných snímků je vada, ne úspěch, a bez téhle aserce by je list uměl
 * vyrobit a přitom vypadat hotově.
 *
 * **Neporovnává se s uloženým obrázkem.** Sada jede na SwiftShaderu (softwarový
 * rasterizér bez grafické karty), takže pixelový diff hlásí rozdíly, které
 * nikdo neudělal. Měří se veličiny, ne bajty — `TOOLING.md` §1.
 */

/** Šířka náhledu v pixelech. `viewer.pixels()` škáluje na tuhle šířku sám. */
const THUMB_WIDTH = 480;

/** Výřez okna. Pevný, aby měl náhled vždycky 16:9 a list vždycky tytéž rozměry. */
const VIEWPORT = { width: 1280, height: 720 } as const;

/**
 * Sloupců na listu. Řádky se dopočítají z počtu světů, takže list roste dolů,
 * až věty začnou procházet častěji. Dvanáct světů dá 4×3, dvacet 4×5.
 */
const COLUMNS = 4;

/** Mezera mezi políčky v pixelech, aby šla políčka na listu spočítat okem. */
const GUTTER = 2;

const SETTLE_FRAMES = 3;

interface FrozenPrompt {
  readonly id: string;
  readonly kind: string;
  readonly prompt: string;
}

/** Věty, které staví svět od nuly. `edit` prompty mění hotový svět, nevyrábějí ho. */
function createPrompts(): readonly FrozenPrompt[] {
  const path = resolve(process.cwd(), 'evals/frozen/prompts.v1.jsonl');
  return readFileSync(path, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as FrozenPrompt)
    .filter((record) => record.kind === 'create');
}

/**
 * Postaví ta věta svět?
 *
 * Ptá se **téhož řetězu, který pohání `/api/emit/stream`**, ne seznamu id
 * opsaného do konstanty. Propadlá věta nechá prohlížeč stát na výchozím
 * layoutu, takže bez tohohle filtru by list nesl políčka, která tvrdí větu
 * a ukazují něco jiného.
 */
function certifies(promptId: string): boolean {
  const outcome = runEmission(promptId);
  return outcome.kind === 'verdict' && outcome.body.outcome === 'CERTIFIED';
}

interface WorldRequest {
  readonly id: string;
  readonly source: 'sentence' | 'layout';
  /** Věta, ze které svět vznikl. U ručního layoutu jeho titulek. */
  readonly origin: string;
  readonly url: string;
}

function worldsToShoot(): readonly WorldRequest[] {
  const sentences = createPrompts()
    .filter((record) => certifies(record.id))
    .map(
      (record): WorldRequest => ({
        id: record.id,
        source: 'sentence',
        origin: record.prompt,
        // Layout pod větou je jen výchozí scéna, než emise dorazí; věta ho
        // přebije. Bere se první, aby se mezi políčky nelišilo nic než věta.
        url: `/embed/${LAYOUTS[0].id}?emit=${record.id}`,
      }),
    );

  const layouts = LAYOUTS.map(
    (layout): WorldRequest => ({
      id: layout.id,
      source: 'layout',
      origin: layout.title,
      url: `/embed/${layout.id}`,
    }),
  );

  return [...sentences, ...layouts];
}

interface Shot {
  readonly data: number[];
  readonly width: number;
  readonly height: number;
  readonly sky: number;
  readonly water: number;
}

async function settle(page: Page, frames = SETTLE_FRAMES): Promise<void> {
  const start = await page.evaluate(() => window.__viewer!.frames());
  await page.waitForFunction((target) => window.__viewer!.frames() > target, start + frames, {
    timeout: 30_000,
  });
}

/**
 * Otevře svět a počká, až doopravdy stojí.
 *
 * U věty se čeká na hotovou sestavu, ne jen na plátno: emise dorazí kanálem až
 * po načtení stránky, takže odečet hned po `goto` by vyfotil výchozí layout
 * a tvrdil o něm, že to je svět z věty.
 */
async function openWorld(page: Page, world: WorldRequest): Promise<void> {
  await page.goto(world.url);
  await page.waitForFunction(() => window.__viewer !== undefined, undefined, { timeout: 60_000 });

  if (world.source === 'sentence') {
    await page.waitForFunction(() => window.__viewer!.dressing().length > 0, undefined, {
      timeout: 60_000,
    });
    await page.waitForFunction(() => window.__viewer!.assembly().done, undefined, {
      timeout: 60_000,
    });
  }

  await settle(page);
}

/** RGBA po řádcích → RGB po řádcích, protože `encodePng` alfu nezná. */
function toRgb(shot: Shot): Uint8Array {
  const rgb = new Uint8Array(shot.width * shot.height * 3);
  for (let pixel = 0; pixel < shot.width * shot.height; pixel += 1) {
    rgb[pixel * 3] = shot.data[pixel * 4];
    rgb[pixel * 3 + 1] = shot.data[pixel * 4 + 1];
    rgb[pixel * 3 + 2] = shot.data[pixel * 4 + 2];
  }
  return rgb;
}

/**
 * Náhledy do jedné mřížky. Mezery i nedopsaná políčka jsou tmavě šedé, ne černé
 * — u tmavého světa by černá hrana splynula a políčka by nešla spočítat.
 */
function composeSheet(
  shots: readonly Shot[],
  cell: { width: number; height: number },
  rows: number,
): Uint8Array {
  const width = COLUMNS * cell.width + (COLUMNS + 1) * GUTTER;
  const height = rows * cell.height + (rows + 1) * GUTTER;
  const sheet = new Uint8Array(width * height * 3).fill(0x22);

  shots.forEach((shot, index) => {
    const left = GUTTER + (index % COLUMNS) * (cell.width + GUTTER);
    const top = GUTTER + Math.floor(index / COLUMNS) * (cell.height + GUTTER);
    const rgb = toRgb(shot);

    for (let y = 0; y < cell.height; y += 1) {
      const from = y * cell.width * 3;
      sheet.set(rgb.subarray(from, from + cell.width * 3), ((top + y) * width + left) * 3);
    }
  });

  return encodePng(width, height, sheet);
}

interface SheetRecord {
  readonly index: number;
  readonly row: number;
  readonly column: number;
  readonly id: string;
  readonly source: 'sentence' | 'layout';
  readonly origin: string;
  readonly url: string;
  readonly measured: Record<ImageProperty, number>;
  readonly failed: readonly ImageProperty[];
  readonly ok: boolean;
  /** Podíl plochy, který maluje obloha a hladina. Měřeno, ne odhadnuto. */
  readonly sky: number;
  readonly water: number;
}

test('kontaktní list všech dosažitelných světů vznikne a jeho světy se od sebe liší', async ({
  page,
}) => {
  test.setTimeout(600_000);

  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));

  await page.setViewportSize({ ...VIEWPORT });

  const requests = worldsToShoot();
  const sentences = requests.filter((world) => world.source === 'sentence');

  // Podlaha měření, ne cíl. Kdyby zmrazený korpus přestal certifikovat cokoli,
  // list by se tiše smrskl na šest ručních layoutů a tvrdil by o produktu něco,
  // co o něm netvrdí nikdo jiný.
  expect(
    sentences.length,
    'ani jedna věta nepostaví svět — list by ukazoval jen ruční layouty',
  ).toBeGreaterThan(0);
  expect(requests.length, 'list bez světů není list').toBeGreaterThan(COLUMNS);

  const shots: Shot[] = [];
  const records: SheetRecord[] = [];

  for (const [index, world] of requests.entries()) {
    await openWorld(page, world);

    // Věta musí skončit vygenerovanou kulisou. Bez tohohle by tiše selhaná
    // emise dala políčko s výchozím layoutem a jménem věty nad ním.
    if (world.source === 'sentence') {
      const scenery = await page.evaluate(() => window.__viewer!.scenery());
      expect(
        scenery.attached,
        `${world.id}: věta neskončila kulisou, políčko by ukazovalo výchozí layout`,
      ).toBe(true);
    }

    const shot = (await page.evaluate(
      (width) => window.__viewer!.pixels({ scale: width }),
      THUMB_WIDTH,
    )) as Shot;

    expect(shot.width * shot.height, `${world.id}: odečet plátna nevrátil ani pixel`).toBeGreaterThan(
      0,
    );

    const judged = judgeImage(shot);
    shots.push(shot);
    records.push({
      index,
      row: Math.floor(index / COLUMNS),
      column: index % COLUMNS,
      id: world.id,
      source: world.source,
      origin: world.origin,
      url: world.url,
      measured: {
        luminanceSpread: judged.measured.luminanceSpread,
        focusClarity: judged.measured.focusClarity,
        silhouette: judged.measured.silhouette,
        hues: judged.measured.hues,
        dead: judged.measured.dead,
      },
      failed: judged.failed,
      ok: judged.ok,
      sky: shot.sky,
      water: shot.water,
    });

    console.log(
      `[contact-sheet] ${String(index + 1).padStart(2, ' ')}/${String(requests.length)} ` +
        `${world.id.padEnd(18)} ` +
        IMAGE_PROPERTIES.map(
          (property) => `${property} ${records[index].measured[property].toFixed(3)}`,
        ).join(' · ') +
        ` · ${judged.ok ? 'ok' : `propadlo ${judged.failed.join(',')}`}`,
    );
  }

  expect(errors, `stránka vyhodila chybu: ${errors.join(' | ')}`).toEqual([]);

  // Všechny náhledy musí mít tentýž rozměr, jinak se mřížka skládat nedá.
  const cell = { width: shots[0].width, height: shots[0].height };
  expect(
    shots.every((shot) => shot.width === cell.width && shot.height === cell.height),
    `náhledy mají různé rozměry: ${[...new Set(shots.map((s) => `${s.width}x${s.height}`))].join(', ')}`,
  ).toBe(true);

  /**
   * **Nejhorší svět podle každé vlastnosti** — riziko projektu je podlaha, ne
   * strop, takže se do JSONu píše ten, o kterého se rozhoduje.
   *
   * U `dead` je „nejhorší" nejvyšší hodnota, u zbylých čtyř nejnižší.
   */
  const worst = Object.fromEntries(
    IMAGE_PROPERTIES.map((property) => {
      const lowerIsWorse = property !== 'dead';
      const found = records.reduce((candidate, record) => {
        const worseThan = lowerIsWorse
          ? record.measured[property] < candidate.measured[property]
          : record.measured[property] > candidate.measured[property];
        return worseThan ? record : candidate;
      });
      return [property, { id: found.id, index: found.index, value: found.measured[property] }];
    }),
  );

  // Pin z AC: skoro stejné světy jsou vada, ne úspěch. Rozptyl každé z pěti
  // vlastností přes celý list musí být nenulový.
  for (const property of IMAGE_PROPERTIES) {
    const values = records.map((record) => record.measured[property]);
    const spread = Math.max(...values) - Math.min(...values);
    expect(
      spread,
      `vlastnost ${property} je přes všech ${String(records.length)} světů konstantní ` +
        `(${String(values[0])}) — list ukazuje pořád tentýž obraz, nebo měřidlo neměří`,
    ).toBeGreaterThan(0);
  }

  /**
   * **Druhý pin, a ten důležitější: žádné dva vygenerované světy nesmí měřit
   * totéž.**
   *
   * Aserce výš projde i tehdy, když je všech šest světů z vět na chlup stejných
   * — rozptyl jí totiž dodá šest ručních layoutů, které se od nich liší tak
   * jako tak. Přesně tahle díra propustila starou tezi: rozpoznávač trefil 13 %
   * vět a zbytek dostal `seedEmission()`, tedy **konstantu**, takže porotci
   * viděli jeden dokola tutéž místnost. Kdyby se to stalo znovu, list výš by
   * zůstal zelený.
   *
   * Soudí se otisk z pěti čísel, ne jedna vlastnost: `luminanceSpread` je
   * kvantovaný na pětiny (obsazená pásma jasu), takže je napříč vygenerovanými
   * světy konstantní z konstrukce a sám by tvrdil vadu tam, kde žádná není.
   */
  const fingerprints = records
    .filter((record) => record.source === 'sentence')
    .map((record) => ({
      id: record.id,
      print: IMAGE_PROPERTIES.map((property) => record.measured[property].toFixed(4)).join('|'),
    }));
  const distinct = new Set(fingerprints.map((entry) => entry.print));
  expect(
    distinct.size,
    `dvě věty daly změřitelně tentýž svět — emise spadla na konstantu: ` +
      fingerprints.map((entry) => `${entry.id} ${entry.print}`).join(' · '),
  ).toBe(fingerprints.length);

  const rows = Math.ceil(records.length / COLUMNS);
  const png = resolve(process.cwd(), 'docs/contact-sheet.png');
  const json = resolve(process.cwd(), 'docs/contact-sheet.json');
  mkdirSync(dirname(png), { recursive: true });
  writeFileSync(png, composeSheet(shots, cell, rows));
  writeFileSync(
    json,
    `${JSON.stringify(
      {
        note:
          'Kontaktní list všech světů, na které se dnes dá dostat adresou (P14 T7). ' +
          'Pořadí záznamů je pořadí políček na docs/contact-sheet.png, po řádcích ' +
          'zleva doprava. Prahy jsou z src/worldstream/image-judge.ts. Rozhoduje ' +
          'se nad tím v bráně H1.',
        reach:
          'Věty se filtrují runEmission() za běhu — na listu je jen ta, která ' +
          'skončí CERTIFIED a doopravdy postaví svět. Zbylé create prompty ' +
          'zmrazeného korpusu scénu nezmění, takže by jejich políčko ukazovalo ' +
          'výchozí layout pod cizím jménem.',
        grid: { columns: COLUMNS, rows },
        thumbnail: cell,
        thresholds: IMAGE_THRESHOLDS,
        worlds: records.length,
        fromSentence: records.filter((record) => record.source === 'sentence').length,
        passing: records.filter((record) => record.ok).length,
        worst,
        records,
      },
      null,
      2,
    )}\n`,
  );

  console.log(
    `[contact-sheet] ${String(records.filter((record) => record.ok).length)}/` +
      `${String(records.length)} světů prošlo všemi pěti prahy ` +
      `(${String(sentences.length)} z vět, ${String(LAYOUTS.length)} z layoutů); ` +
      IMAGE_PROPERTIES.map((property) => `nejhorší ${property}: ${String(worst[property].id)}`).join(
        ' · ',
      ),
  );
});
