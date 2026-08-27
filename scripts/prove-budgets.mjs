#!/usr/bin/env node
/**
 * Důkaz rozpočtu programů geometrie (P11 T9).
 *
 * Tvrzení, které se dokazuje: **dvacet programů napříč tím, co kompilátor umí,
 * se vejde do stropů z `src/kit/budgets.ts`** — počtem umístěných kusů
 * i počtem trojúhelníků — a žádný se nepřekládá déle než 120 ms.
 *
 * **Proč to měří test a ne tenhle soubor.** Kompilátor je TypeScript
 * s extensionless importy a s aliasem `@/`; Node 22.17 ho bez sestavení
 * nenačte. Jediný běžec, který v tomhle repozitáři TypeScript spustí, je
 * vitest. Měřicí část proto bydlí v `src/geom/__tests__/compile.test.ts`
 * a tenhle skript je **brána**: spustí ji, vyžádá si artefakt a naměřená čísla
 * si přepočítá sám. Kdyby test artefakt nezapsal — protože ho někdo vyprázdnil,
 * přejmenoval nebo odfiltroval — skript spadne na chybějícím souboru, ne na
 * tichém průchodu.
 *
 * **Co skript sám o sobě nedokáže:** stropy čte z artefaktu, ne ze zdroje.
 * Tvrzení „jsou to opravdu čísla z `src/kit/budgets.ts`" drží ten test, který
 * na ně porovnává; tady se kontroluje, že se dodržela, a že jich přišlo dvacet.
 *
 * Spuštění: `npm run prove:budgets`
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

const ARTIFACT = 'evals/geom-budgets.json';
const MEASURE_FILE = 'src/geom/__tests__/compile.test.ts';
const EXPECTED_PROGRAMS = 20;

const artifactPath = resolve(process.cwd(), ARTIFACT);

function die(message) {
  console.error(`\nprove:budgets SELHALO — ${message}`);
  process.exit(1);
}

// Starý artefakt by prošel i tehdy, kdyby měření vůbec neproběhlo.
rmSync(artifactPath, { force: true });

console.log(`prove-budgets — dvacet programů proti stropům z src/kit/budgets.ts`);
console.log(`měří: ${MEASURE_FILE}\n`);

try {
  execFileSync('npx', ['vitest', 'run', MEASURE_FILE], {
    stdio: 'inherit',
    shell: true,
    env: { ...process.env, GEOM_BUDGET_ARTIFACT: ARTIFACT },
  });
} catch {
  die('měřicí sada skončila nenulově');
}

if (!existsSync(artifactPath)) die(`měření neproběhlo — ${ARTIFACT} nevznikl`);

const report = JSON.parse(readFileSync(artifactPath, 'utf-8'));
const { caps, programs } = report;

if (!Number.isFinite(caps?.maxPieces) || !Number.isFinite(caps?.maxTriangles)) {
  die('artefakt nenese stropy, proti kterým se má soudit');
}
if (!Array.isArray(programs) || programs.length !== EXPECTED_PROGRAMS) {
  die(`čekalo se ${EXPECTED_PROGRAMS} programů, přišlo ${programs?.length ?? 0}`);
}

const width = Math.max(...programs.map((entry) => entry.id.length));
const violations = [];

for (const entry of programs) {
  const overPieces = entry.pieces > caps.maxPieces;
  const overTriangles = entry.triangles > caps.maxTriangles;
  const overTime = entry.milliseconds >= caps.maxCompileMilliseconds;
  const bad = overPieces || overTriangles || overTime;
  if (bad) violations.push(entry.id);

  console.log(
    `${bad ? 'NAD ' : 'OK  '} ${entry.id.padEnd(width)}  ` +
      `kusů ${String(entry.pieces).padStart(3)}/${caps.maxPieces}  ` +
      `trojúhelníků ${String(entry.triangles).padStart(6)}/${caps.maxTriangles}  ` +
      `${entry.milliseconds.toFixed(1)} ms`,
  );
}

if (violations.length > 0) die(`nad stropem: ${violations.join(', ')}`);

const worst = programs.reduce((a, b) => (a.triangles > b.triangles ? a : b));
const slowest = programs.reduce((a, b) => (a.milliseconds > b.milliseconds ? a : b));

console.log(
  `\nVšech ${programs.length} programů je pod stropem. ` +
    `Nejtěžší ${worst.id} (${worst.triangles} trojúhelníků), ` +
    `nejpomalejší ${slowest.id} (${slowest.milliseconds.toFixed(1)} ms).`,
);
