/**
 * Zkušební sada determinismu skriptů úrovní (P68 T13): tytéž programy a semínka v Node (vitest, e2e) a v prohlížeči
 * (`/play/lab/scripts`, Chromium a WebKit). Výstup je kanonický JSON dat úrovně a místa zastavení – musí sedět bajt
 * po bajtu. Programy míří na to, co se mezi prostředími může rozejít: náhoda hostitele, plovoucí matematika uvnitř
 * QuickJS (`Math.sin`, `Math.pow`…), místo zastavení rozpočtem s voláními API i bez nich.
 */

import { scriptLevelFromRecording } from './level';
import { type QuickJs, runScript } from './sandbox';

export interface LabProgram {
  readonly id: string;
  readonly rows: number;
  readonly code: string;
}

export const LAB_PROGRAMS: readonly LabProgram[] = [
  {
    id: 'rivers-then-highway',
    rows: 30,
    code: `function build(api) {
  const rows = api.param("rows");
  let z = 3;
  for (let band = 0; band < 3; band++) {
    const width = api.rng.int(1, 3);
    for (let k = 0; k < width; k++) api.place("river", api.rng.int(0, 8), z + k);
    z += width + api.rng.int(1, 2);
  }
  for (let k = 0; k < 5 && z + k < rows - 1; k++) api.place("road", k % 2 === 0 ? 1 : 7, z + k);
}`,
  },
  {
    id: 'float-math',
    rows: 40,
    code: `function build(api) {
  const kinds = ["road", "river", "rail"];
  let z = 3;
  for (let i = 1; z < api.param("rows") - 2; i++) {
    const wave = Math.sin(i * 1.7) * Math.cos(i / 3.1) + Math.pow(1.13, i) / 7 + Math.sqrt(i) * Math.log(i + 1) + Math.exp(-i / 4) + Math.atan2(i, 2.5);
    const kind = kinds[Math.floor(Math.abs(wave * 1000)) % 3];
    const x = Math.floor(Math.abs(Math.tan(i + 0.5) * 97)) % 9;
    api.place(kind, x, z);
    z += 2;
  }
}`,
  },
  {
    id: 'budget-api-loop',
    rows: 20,
    code: 'function build(api) { let n = 0; for (;;) { n += api.rng.int(0, 9); } }',
  },
  {
    id: 'budget-plain-loop',
    rows: 20,
    code: 'function build(api) { let n = 0; for (;;) { n = (n * 31 + 7) % 1000003; } }',
  },
];

export const LAB_SEEDS: readonly number[] = [1, 7, 123_456_789];

export interface LabCase {
  readonly id: string;
  readonly seed: number;
  readonly error: string | null;
  readonly polls: number;
  readonly draws: number;
  readonly places: readonly (readonly [string, number, number])[];
  readonly levelData: unknown;
  readonly issues: readonly string[];
}

/** Všechny programy na všech semínkách: data úrovně, chyby a místo zastavení. */
export function runLab(quickjs: QuickJs): LabCase[] {
  return LAB_PROGRAMS.flatMap((program) =>
    LAB_SEEDS.map((seed): LabCase => {
      const run = runScript(quickjs, program.code, { game: 'hop', params: { rows: program.rows }, seed });
      const level = run.ok ? scriptLevelFromRecording('hop', run.recording, { rows: program.rows }) : null;
      return {
        id: program.id,
        seed,
        error: run.ok ? null : `${run.error.kind}: ${run.error.message}`,
        polls: run.polls,
        draws: run.recording.draws,
        places: run.recording.places,
        levelData: level?.ok === true ? level.levelData : null,
        issues: level === null || level.ok ? [] : level.issues,
      };
    }),
  );
}

/** Kanonický výstup sady: tentýž řetězec v každém prostředí. */
export const labOutput = (cases: readonly LabCase[]): string => JSON.stringify(cases);
