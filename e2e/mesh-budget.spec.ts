/**
 * Kolik stojí jeden tvar v prohlížeči (P13 vlna 1 T5).
 *
 * `WORLDSTREAM-DESIGN-BOOK.md` §11.2 nese tabulku naměřenou v **Node** a sám
 * u ní píše: „⚠ Číslo je z Node, ne z prohlížeče. Plán vlna 1 ho přeměří
 * v cílovém prohlížeči na referenčním stroji a **report je zdroj pravdy**."
 * Tohle je ten report.
 *
 * ## Čtyři věci, které tenhle soubor dělá jinak, než je zvykem
 *
 * 1. **Měří se `workerMs`, ne čas na hlavním vlákně.** Worker si čas bere
 *    kolem `meshShapeProgram()`, tedy bez ceny za předání bufferu a bez fronty
 *    prohlížeče. Rozpočet mluví o ceně meshingu; obojí se zapisuje, soudí se
 *    to první, a rozdíl mezi nimi je v reportu vidět.
 * 2. **Nejlepší ze tří běhů po zahřátí**, stejná metodika jako §11.2. Medián by
 *    tu byl horší volba: měří se strop schopnosti stroje, ne typický běh pod
 *    cizí zátěží, a jediný běh by na sdíleném notebooku skákal o desítky procent.
 * 3. **Soudí se jen 64³.** Ostatní tři mřížky se měří a zapisují, protože bez
 *    nich by nešlo poznat, jestli se pohnul stroj, nebo tvar — ale AC úlohy T5
 *    dává strop jedné z nich a druhý strop by byl číslo, které nikdo neodvodil.
 * 4. **Odchylka od Node se hlásí, nepadá na ní.** Důvod ke změně čísla umí
 *    napsat jen člověk; aserce by ho jen zamlčela nebo přepsala.
 *
 * ## Proč SwiftShader v `playwright.config.ts` ničemu nevadí
 *
 * Meshing je čistě procesorová práce nad `Float32Array` v `Float32Array` —
 * žádný shader, žádná textura, žádné `readPixels`. Zapisuje se ale i jméno
 * adaptéru, protože čtenář reportu bez něj nemá jak poznat, jestli je to pravda.
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

import {
  COST_CLASSES,
  GRID_64_BUDGET,
  NODE_BASELINE,
  NODE_DRIFT_TOLERANCE,
  REFERENCE_BOUNDS,
  REFERENCE_GRIDS,
  REFERENCE_SEED,
  REFERENCE_SHAPE_FACTS,
} from '../evals/shape/reference-program';

const REPORT_PATH = join('evals', 'shape', 'mesh-budget.json');

/** Kolikrát se mřížka změří. Nejlepší z toho jde do reportu. */
const RUNS = 3;

/**
 * Zahřívací běh. Bez něj měří první mřížka překlad V8, ne meshing — a protože
 * první je vždycky 32³, byla by právě ta nejlevnější položka nejdražší.
 */
const WARMUP_RESOLUTION = 32;

interface Sample {
  readonly resolution: number;
  readonly workerMs: number;
  readonly roundTripMs: number;
  readonly vertices: number;
  readonly triangles: number;
}

/** Jméno GPU adaptéru, jak ho hlásí ovladač. Pro čtenáře reportu, ne pro měření. */
async function readAdapter(page: Page): Promise<string> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    if (gl === null) return 'no webgl2';
    const info = gl.getExtension('WEBGL_debug_renderer_info');
    return info === null
      ? gl.getParameter(gl.RENDERER as number)
      : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL as number));
  });
}

/**
 * Identita bundlu, který se právě měřil. Čte se ze souborů, ne ze stránky: app
 * router `__NEXT_DATA__` nevystavuje.
 *
 * **`.next/BUILD_ID` sám nestačí — Next 16.3 do něj po `next build` píše
 * doslova `unbuilt`** (naměřeno 29. 8. 2026). Kdyby report bral jen ten soubor,
 * nesl by ve všech bězích tutéž konstantu a čtenář by neměl jak poznat, jestli
 * se dvě čísla naměřila nad stejným kódem. Náhradou je krátký otisk
 * `build-manifest.json`, který nese jména chunků i s jejich hashi — mění se
 * přesně tehdy, když se změní bundle.
 */
function readBuildId(): string {
  let declared = 'missing';
  try {
    declared = readFileSync(join('.next', 'BUILD_ID'), 'utf8').trim();
  } catch {
    /* build ještě neproběhl; otisk manifestu to pozná taky */
  }

  if (declared !== 'unbuilt' && declared !== 'missing' && declared.length > 0) return declared;

  try {
    const manifest = readFileSync(join('.next', 'build-manifest.json'));
    return `manifest:${createHash('sha256').update(manifest).digest('hex').slice(0, 12)}`;
  } catch {
    return 'unknown';
  }
}

test.describe('rozpočet meshingu v prohlížeči', () => {
  // `@measure` ho drží mimo `npm run test:e2e`. Je to živé měření, které
  // přepisuje commitnutý `mesh-budget.json` — přesně ten druh běhu, kvůli
  // kterému CLAUDE.md předepisuje `git status` po každé e2e sadě. Příkaz z AC
  // (`npx playwright test e2e/mesh-budget.spec.ts`) ho pouští dál, značka
  // filtruje jen sadu.
  test('@measure změří referenční tvar ve čtyřech mřížkách a připne 64³', async ({
    page,
    browserName,
  }) => {
    test.setTimeout(300_000);

    await page.goto('/dev/mesh-budget');
    await page.waitForFunction(() => window.__meshBudget !== undefined, undefined, {
      timeout: 60_000,
    });

    // Kontrola, že se měří ten program, o kterém report mluví. Kdyby se
    // reference přepsala a tenhle řádek nepřepsal, čísla by mlčky změnila význam.
    expect(await page.evaluate(() => window.__meshBudget!.nodeCount())).toBe(
      REFERENCE_SHAPE_FACTS.nodeCount,
    );

    await page.evaluate((resolution) => window.__meshBudget!.measure(resolution), WARMUP_RESOLUTION);

    const best = new Map<number, Sample>();
    for (const resolution of REFERENCE_GRIDS) {
      for (let run = 0; run < RUNS; run += 1) {
        const sample = (await page.evaluate(
          (value) => window.__meshBudget!.measure(value),
          resolution,
        )) as Sample;

        const previous = best.get(resolution);
        if (previous === undefined || sample.workerMs < previous.workerMs) {
          best.set(resolution, sample);
        }
      }
    }

    const grids = REFERENCE_GRIDS.map((resolution) => {
      const sample = best.get(resolution)!;
      const baseline = NODE_BASELINE[resolution];
      const drift = (sample.workerMs - baseline.ms) / baseline.ms;

      return {
        resolution,
        browser: {
          workerMs: Number(sample.workerMs.toFixed(1)),
          roundTripMs: Number(sample.roundTripMs.toFixed(1)),
          vertices: sample.vertices,
          triangles: sample.triangles,
        },
        node: baseline,
        driftFromNode: Number(drift.toFixed(3)),
        driftExplained: Math.abs(drift) <= NODE_DRIFT_TOLERANCE,
      };
    });

    const grid64 = grids.find((row) => row.resolution === 64)!;
    const report = {
      measuredAt: new Date().toISOString().slice(0, 10),
      task: 'P13 vlna 1 T5',
      browser: browserName,
      userAgent: await page.evaluate(() => navigator.userAgent),
      adapter: await readAdapter(page),
      buildId: readBuildId(),
      hardwareConcurrency: await page.evaluate(() => navigator.hardwareConcurrency),
      // Meshing běží na procesoru, takže adaptér do výsledku nevstupuje. Je
      // v reportu proto, aby to čtenář nemusel brát na slovo.
      adapterAffectsResult: false,
      program: {
        seed: REFERENCE_SEED,
        bounds: REFERENCE_BOUNDS,
        ...REFERENCE_SHAPE_FACTS,
      },
      method: {
        runs: RUNS,
        pick: 'best',
        warmupResolution: WARMUP_RESOLUTION,
        timedIn: 'worker',
      },
      budget: GRID_64_BUDGET,
      verdict: {
        withinMs: grid64.browser.workerMs <= GRID_64_BUDGET.maxMs,
        withinTriangles: grid64.browser.triangles <= GRID_64_BUDGET.maxTriangles,
      },
      grids,
      nodeCostClasses: COST_CLASSES,
    };

    mkdirSync(dirname(REPORT_PATH), { recursive: true });
    writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    // Odchylka od Node se hlásí do konzole běhu, ať aserce dopadne jakkoli —
    // kdyby se tisklo až po ní, červené 64³ by tuhle informaci spolklo.
    for (const row of grids) {
      const percent = (row.driftFromNode * 100).toFixed(1);
      console.log(
        `${row.resolution}³: ${row.browser.workerMs} ms / ${row.browser.triangles} tri ` +
          `· Node ${row.node.ms} ms / ${row.node.triangles} tri · odchylka ${percent} %` +
          (row.driftExplained ? '' : '  ← nad tolerancí, důvod patří do plánu'),
      );
    }

    expect(grid64.browser.triangles).toBeLessThanOrEqual(GRID_64_BUDGET.maxTriangles);
    expect(grid64.browser.workerMs).toBeLessThanOrEqual(GRID_64_BUDGET.maxMs);
  });
});
