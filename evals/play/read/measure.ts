/**
 * Čtečka proti klíčovým slovům na 200 větách poptávky (P29B T3).
 *
 * Ruční štítky jsou v `evals/play/demand/corpus.json` (pole `verb`, legenda
 * `labels.json`): třída slovesa, kterou věta chce. Soudí se dvě věci:
 *
 * - **třída slovesa** – čtečka: první sloveso čtení; klíčová slova: ovládání
 *   draftu převedené na třídu (`shooter` → `aim_shoot`, `duel` → `melee`),
 *   protože jiné čtení slovesa regex nemá;
 * - **ovládání** – jen u vět, jejichž třída má v PLAY ovládání (11 z 15 tříd);
 *   `manipulate`, `build_place`, `idle` a `sandbox` ovládání nemají.
 *
 * judge-10 `read` se sem přebírá z běhu `scripts/play-fidelity.mjs --offline
 * --reader` (`evals/play/fidelity/runs/<run>.json`), který ho měří řetězem
 * věrnosti. Server čtečky musí běžet (`ops/llm/start.ps1`), měření jde přes
 * zámek GPU:
 *   node D:/claude/_shared/gpu-lock.mjs -- node --experimental-strip-types --import ./scripts/ts-paths.mjs evals/play/read/measure.ts --reader http://127.0.0.1:8791 [--run p29b-reader]
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { draftGameSpec } from '@/play/draft';
import { readSentence } from '@/play/read/client';
import type { Reading, VerbClass } from '@/play/read/schema';
import type { ControlId } from '@/play/spec';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const HERE = join(ROOT, 'evals', 'play', 'read');

/** Třída slovesa → ovládání PLAY; třídy bez ovládání chybí. */
const CONTROL_OF: Partial<Record<VerbClass, ControlId>> = {
  tap_go: 'tap_go', runner: 'runner', platform: 'platform', flap: 'flap', steer: 'steer', aim_shoot: 'shooter',
  throw: 'throw', timing: 'timing', rhythm: 'rhythm', melee: 'duel', move_free: 'move_free',
};
const CLASS_OF = Object.fromEntries(Object.entries(CONTROL_OF).map(([verb, control]) => [control, verb])) as Record<ControlId, VerbClass>;

interface DemandRow {
  readonly id: string;
  readonly text: string;
  readonly verb: VerbClass;
}

function arg(name: string): string | null {
  const at = process.argv.indexOf(`--${name}`);
  return at < 0 ? null : (process.argv[at + 1] ?? null);
}

const quantile = (values: readonly number[], q: number): number | null => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length === 0 ? null : sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
};
const share = (hit: number, of: number) => (of === 0 ? 0 : Math.round((hit / of) * 1000) / 1000);

async function main(): Promise<void> {
  const endpoint = arg('reader');
  if (endpoint === null) throw new Error('usage: measure.ts --reader http://127.0.0.1:8791 [--run p29b-reader]');
  const runId = arg('run') ?? 'p29b-reader';
  const demand = JSON.parse(readFileSync(join(ROOT, 'evals', 'play', 'demand', 'corpus.json'), 'utf8')) as DemandRow[];

  const rows: {
    id: string;
    text: string;
    label: VerbClass;
    ms: number;
    reading: Reading | null;
    readerClass: VerbClass | null;
    readerControl: ControlId | null;
    regexControl: ControlId;
  }[] = [];
  for (const row of demand) {
    const started = performance.now();
    // Štědrý timeout, aby pomalé čtení bylo vidět v latenci, ne jako `null`.
    const reading = await readSentence(row.text, { endpoint, timeoutMs: 10_000 });
    const ms = Math.round(performance.now() - started);
    rows.push({
      id: row.id,
      text: row.text,
      label: row.verb,
      ms,
      reading,
      readerClass: reading?.verbs[0]?.class ?? null,
      readerControl: reading?.control ?? null,
      regexControl: draftGameSpec(row.text).control ?? 'tap_go',
    });
  }

  const withControl = rows.filter((row) => CONTROL_OF[row.label] !== undefined);
  const agree = (pick: (row: (typeof rows)[number]) => boolean, of: readonly (typeof rows)[number][]) => ({ hit: of.filter(pick).length, of: of.length, share: share(of.filter(pick).length, of.length) });
  const latencies = rows.map((row) => row.ms);

  const runPath = join(ROOT, 'evals', 'play', 'fidelity', 'runs', `${runId}.json`);
  const run = existsSync(runPath) ? (JSON.parse(readFileSync(runPath, 'utf8')) as { header: Record<string, unknown>; judge10: { reader: { summary: { read: number } }; regex: { summary: { read: number } } } }) : null;

  const report = {
    about: 'P29B T3: local reader vs keyword draft on the 200-sentence demand set (hand labels in evals/play/demand). See README.md.',
    measuredAt: new Date().toISOString(),
    commit: execFileSync('git', ['--no-replace-objects', 'rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(),
    endpoint,
    model: process.env.PLAY_READER_MODEL ?? null,
    sentences: rows.length,
    unread: rows.filter((row) => row.reading === null).length,
    latencyMs: { p50: quantile(latencies, 0.5), p95: quantile(latencies, 0.95), max: Math.max(...latencies) },
    verbClass: {
      reader: agree((row) => row.readerClass === row.label, rows),
      regex: agree((row) => CLASS_OF[row.regexControl] === row.label, rows),
    },
    control: {
      reader: agree((row) => row.readerControl === CONTROL_OF[row.label], withControl),
      regex: agree((row) => row.regexControl === CONTROL_OF[row.label], withControl),
    },
    judge10: run === null ? null : { run: runId, reader: run.judge10.reader.summary.read, regex: run.judge10.regex.summary.read, decision: run.header.decision ?? null, latencyMs: run.header.latencyMs ?? null },
    rows,
  };
  writeFileSync(join(HERE, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  const { rows: _rows, ...head } = report;
  console.log(JSON.stringify(head, null, 1));
}

await main();
