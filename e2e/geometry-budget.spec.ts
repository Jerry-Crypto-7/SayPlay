import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

import type { TransitionTiming } from '../src/app/dev/worldstream/page';
import { MESH_DETAIL } from '../src/shape/types';
import {
  median,
  renderReport,
  type Machine,
  type TransitionSplit,
} from '../evals/gates/bench/transition';

/**
 * Živé měření rozpočtů (P15 T39).
 *
 * `T26` má osekávat kvalitu proti rozpočtům §23. Ta čísla jsou z **návrhu** —
 * nikdo je nenaměřil. Tenhle soubor je změří na dnešním produktu a
 * `evals/gates/geometry-budget.md` z nich udělá report; rozsudek a text píše
 * `evals/gates/bench/transition.ts`.
 *
 * ## Dvě věci, které se měří na dvou různých adresách, a proč
 *
 * Věta se k worldstreamovému plátnu dnes **nedostane**: `/` staví starý
 * renderer (`WorldScene`) a `/dev/worldstream` staví ten nový nad ručně
 * napsaným blueprintem, ale bez pole na větu. Propojení je úloha `T21b`.
 * Latence od věty se proto měří tam, kde věta doopravdy svět staví, a report
 * u toho čísla nese, že se po `T21b` musí přeměřit. Alternativa — počkat
 * s měřením na `T21b` — by nechala `T26` osekávat podle konstanty, což je
 * přesně to, kvůli čemu tahle úloha vznikla.
 *
 * ## Proč se nesoudí latence proti §23
 *
 * Sada jede na SwiftShaderu. Naměřený čas je horní odhad na softwarovém
 * rendereru, ne výkon cílového stroje, a aserce nad ním by červenala podle
 * zátěže notebooku. Soudí se proto **to, co je na tom čísle rozbitelné tiše**:
 * že se opravdu měřil nakreslený snímek, a že report nese stroj i renderer.
 * Rozpočet se v reportu porovnává a rozdíl se zapisuje.
 *
 * ## Rozpad přechodu, od `T26`
 *
 * Součet od kliknutí po commit zůstal po `T39` nevysvětlený, takže stránka si
 * ho od `T26` měří sama a vydává přes `window.__worldstreamTransition`. Sada
 * ho jen sbírá — hranici mezi workerem a commitem zvenku vidět není a hodiny
 * v Playwrightu by ji vyrobit nedokázaly.
 *
 * `@measure` drží spec mimo `npm run test:e2e` — přepisuje commitnutý artefakt
 * a spouští se jmenovitě.
 */

const REPORT_PATH = join('evals', 'gates', 'geometry-budget.md');

/** Kolikrát se každá veličina změří. Medián z toho jde do reportu. */
const RUNS = 3;

/** Doslovný text `C01` ze zmrazeného korpusu — offline větev hledá přesnou shodu. */
const FROZEN_PROMPT = 'a puzzle room where I have to find three keys to open the exit door';

/** Předepsaná délka odhalení. Není to práce, je to návrh — v reportu se odečítá. */
const REVEAL_MS = 700;

/** Jméno adaptéru, jak ho hlásí ovladač. Pro čtenáře reportu, ne pro měření. */
async function readMachine(page: Page): Promise<Machine> {
  return page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2');
    const info = gl === null ? null : gl.getExtension('WEBGL_debug_renderer_info');
    const renderer =
      gl === null
        ? 'no webgl2'
        : info === null
          ? String(gl.getParameter(gl.RENDERER as number))
          : String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL as number));
    return {
      platform: navigator.platform,
      cores: navigator.hardwareConcurrency,
      browser: navigator.userAgent,
      renderer,
    };
  });
}

/**
 * Od odeslání věty po **první nakreslený snímek se světem**.
 *
 * Stránka se načítá znovu pro každý běh: měří se studený start, a `worldFrames`
 * se schválně nenuluje mezi světy.
 */
async function measureToCoarseWorld(page: Page): Promise<number> {
  await page.goto('/classic');
  await page.waitForFunction(() => window.__worldsmith !== undefined, undefined, { timeout: 60_000 });
  await page.getByTestId('prompt-input').fill(FROZEN_PROMPT);

  const started = Date.now();
  await page.getByTestId('prompt-submit').click();
  await page.waitForFunction(() => (window.__worldsmith?.worldFrames() ?? 0) > 0, undefined, {
    timeout: 60_000,
  });
  return Date.now() - started;
}

/** Jeden přechod: celkový čas zvenku a rozpad naměřený uvnitř stránky. */
interface TransitionRun {
  readonly totalMs: number;
  readonly split: TransitionTiming;
}

/**
 * Od povelu k materializaci po commit odhalení.
 *
 * `warm` nejdřív pošle mesh, který **brána odmítne** (`materialize-overrun`).
 * Nic se tím necommitne, ale worker se zavede a zkompiluje. Bylo to postavené
 * jako pokus o oddělení studeného startu od přechodu — a **měření ho vyvrátilo**
 * (3. 9. 2026): obě sady se překrývají a rozptyl je větší než rozdíl mezi nimi.
 * Zůstává tu proto, že ta vyvrácená hypotéza je sama o sobě výsledek; kdyby se
 * měření zahodilo, příští kolo by ji zkusilo znovu.
 */
async function measureToHighDetail(page: Page, warm: boolean): Promise<TransitionRun> {
  await page.goto('/dev/worldstream');
  await expect(page.getByTestId('stage-status')).toContainText('slots at', { timeout: 60_000 });
  await page.waitForFunction(() => (window.__worldstreamStage?.frames() ?? 0) > 3);

  if (warm) {
    await page.getByTestId('materialize-overrun').click();
    await page.waitForFunction(
      () => window.__worldstreamStage!.slots().some((slot) => slot.failure !== null),
      undefined,
      { timeout: 120_000 },
    );
  }

  const started = Date.now();
  await page.getByTestId('materialize').click();
  await page.waitForFunction(() => window.__worldstreamStage!.commits() > 0, undefined, {
    timeout: 60_000,
  });
  const totalMs = Date.now() - started;

  // Rozpad se čte **po** commitu: stránka ho zapisuje až v okamžiku, kdy má obě
  // půlky, takže dřív by tu byl buď `null`, nebo číslo z minulého běhu.
  const split = await page.evaluate(() => window.__worldstreamTransition!());
  if (split === null) throw new Error('přechod doběhl, ale stránka rozpad nenaměřila');
  return { totalMs, split };
}

/** Tři běhy jedné sady na tvar, ve kterém je report umí vytisknout. */
function splitOf(runs: readonly TransitionRun[]): TransitionSplit {
  return {
    worker: runs.map((run) => run.split.workerMs),
    commit: runs.map((run) => run.split.commitMs),
    reveal: runs.map((run) => run.split.revealMs),
  };
}

test('@measure naměří cestu k hrubému světu i cenu přechodu na vysoký detail', async ({ page }) => {
  test.setTimeout(600_000);

  const machine = await readMachine(page);

  const toCoarseWorld: number[] = [];
  for (let run = 0; run < RUNS; run += 1) toCoarseWorld.push(await measureToCoarseWorld(page));

  const coldRuns: TransitionRun[] = [];
  for (let run = 0; run < RUNS; run += 1) coldRuns.push(await measureToHighDetail(page, false));
  const toHighDetailCold = coldRuns.map((run) => run.totalMs);

  const warmRuns: TransitionRun[] = [];
  for (let run = 0; run < RUNS; run += 1) warmRuns.push(await measureToHighDetail(page, true));
  const toHighDetail = warmRuns.map((run) => run.totalMs);

  const report = {
    measuredAt: new Date().toISOString().slice(0, 10),
    machine,
    toCoarseWorld: { label: 'věta → první snímek hrubého světa (`/`, renderer `WorldScene`)', runs: toCoarseWorld },
    toHighDetail: { label: 'materializace po odmítnutém pokusu (worker už běžel)', runs: toHighDetail },
    toHighDetailCold: { label: 'první materializace po načtení stránky', runs: toHighDetailCold },
    splitWarm: splitOf(warmRuns),
    splitCold: splitOf(coldRuns),
    revealDurationMs: REVEAL_MS,
    ladder: { rough: MESH_DETAIL.rough.resolution, high: MESH_DETAIL.high.resolution },
    ladderTriangles: { rough: MESH_DETAIL.rough.maxTriangles, high: MESH_DETAIL.high.maxTriangles },
  };

  const markdown = renderReport(report);
  mkdirSync(dirname(REPORT_PATH), { recursive: true });
  writeFileSync(REPORT_PATH, markdown, 'utf-8');

  // Měřilo se něco, ne nic. Nula by prošla každou aserci o rozpočtu.
  expect(toCoarseWorld).toHaveLength(RUNS);
  expect(toHighDetail).toHaveLength(RUNS);
  expect(toHighDetailCold).toHaveLength(RUNS);
  expect(Math.min(...toCoarseWorld)).toBeGreaterThan(0);
  expect(Math.min(...toHighDetail)).toBeGreaterThan(0);
  // Přechod nemůže být kratší než animace, kterou obsahuje. Kdyby byl, měřil by
  // se jiný okamžik než commit — a celý řádek „z toho práce" by byl smyšlený.
  expect(median(toHighDetail)).toBeGreaterThanOrEqual(REVEAL_MS);

  // **Pin `T26`:** rozpad musí sedět na součet, který se měřil zvenku. Obě
  // půlky kladné a dohromady uvnitř celku — kdyby jedna z nich byla nula nebo
  // kdyby se součet rozešel s naměřeným přechodem, měřila by se jiná hranice
  // než ta mezi workerem a commitem, a report by o ní tvrdil nepravdu.
  for (const run of [...warmRuns, ...coldRuns]) {
    expect(run.split.workerMs).toBeGreaterThan(0);
    expect(run.split.commitMs).toBeGreaterThan(0);
    expect(run.split.workerMs + run.split.commitMs).toBeLessThanOrEqual(run.totalMs);
  }
  // Commit v sobě nese předepsanou animaci, takže kratší než ona být nemůže.
  expect(median(splitOf(warmRuns).commit)).toBeGreaterThanOrEqual(REVEAL_MS);

  // **Pin úlohy:** rozpočet bez jmenovaného stroje vypadá na papíře přesně jako
  // ten správný. Report proto musí nést stroj i renderer, ne jen čísla.
  expect(machine.renderer).not.toBe('');
  expect(machine.renderer).not.toBe('no webgl2');
  expect(markdown).toContain(machine.renderer);
  expect(markdown).toContain(machine.platform);
  expect(markdown).toContain(String(machine.cores));
});
