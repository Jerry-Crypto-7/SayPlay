#!/usr/bin/env node
/**
 * Trychtýř herní smyčky (P27D T4, B4) ze záznamu událostí:
 *   node --experimental-strip-types scripts/play-loop-report.mjs [--dir data/play/events] [--log vercel.log] [--out plans/P27/evidence/loop/report.json]
 *
 * `--dir` čte `*.jsonl` z `next start`, `--log` řádky `[play-loop] {…}` z logu
 * funkcí Vercelu. Každý řádek projde týmž kontraktem jako dveře
 * (`readLoopEvent`), takže nic mimo něj do součtu nepropadne. Poměry nesou
 * skutečné jmenovatele; `sharedOpenPerShare` je otevření sdíleného odkazu na
 * jedno sdílení, ne doručení.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

await import('./ts-paths.mjs');
const { readLoopEvent, summarizeLoop } = await import('../src/play/loop-events.ts');

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PREFIX = '[play-loop] ';

function args() {
  const out = {};
  const list = process.argv.slice(2);
  for (let i = 0; i < list.length; i += 1) if (list[i].startsWith('--')) out[list[i].slice(2)] = list[i + 1];
  return out;
}

const options = args();
const lines = [];
const dir = resolve(ROOT, options.dir ?? join('data', 'play', 'events'));
if (options.log === undefined && existsSync(dir)) {
  for (const file of readdirSync(dir).filter((name) => name.endsWith('.jsonl')).sort()) lines.push(...readFileSync(join(dir, file), 'utf8').split('\n'));
}
if (options.log !== undefined) {
  for (const line of readFileSync(resolve(options.log), 'utf8').split('\n')) {
    const at = line.indexOf(PREFIX);
    if (at >= 0) lines.push(line.slice(at + PREFIX.length));
  }
}

const events = [];
let refused = 0;
for (const line of lines) {
  if (line.trim() === '') continue;
  let parsed = null;
  try {
    const { at: _at, ...body } = JSON.parse(line);
    parsed = readLoopEvent(body);
  } catch {
    parsed = null;
  }
  if (parsed === null) refused += 1;
  else events.push(parsed);
}

// Revize T4: události hlásí prohlížeč a server neověřuje, že hra s `versionId` existuje – čísla jsou nahlášená, ne dokázaná.
const trust = 'client-reported: versionId is not checked against the game store and once-only dedupe is in the browser, so counts can be inflated';
const report = { measuredAt: new Date().toISOString(), source: options.log ?? dir, trust, events: events.length, refusedLines: refused, ...summarizeLoop(events) };
if (options.out !== undefined) {
  mkdirSync(dirname(resolve(options.out)), { recursive: true });
  writeFileSync(resolve(options.out), `${JSON.stringify(report, null, 1)}\n`);
}
console.log(JSON.stringify(report, null, 1));
