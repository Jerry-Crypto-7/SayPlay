#!/usr/bin/env node
/**
 * Pilot skriptů úrovní (P68I T13): 20 dev vět (`dev.json`) projde týmž `scriptedLevel` jako AI verze za
 * `PLAY_SCRIPTS=on` – sandbox, ověření dat úrovně, robot (výhra i prohra do 90 s), jedno opravné kolo.
 *
 *   node --experimental-strip-types evals/play/p68/hybrid/pilot.mjs --record   # písař = `claude -p`, zapíše answers.json
 *   node --experimental-strip-types evals/play/p68/hybrid/pilot.mjs            # přehraje answers.json → pilot.json
 *
 * **Placená část jen přes měřicí knihu** (`scripts/measure/eval-ledger.mjs`): bez ní (`fast-only`) se astra nevolá.
 * Odpovědi pak píše `claude -p` z předplatného jako **zástupce** astry – týmž zadáním (`SCRIPT_SYSTEM_PROMPT`) a týmž
 * opravným kolem; v `pilot.json` je tak označený, nikdy jako výstup astry. Selhání (věta mimo hop, písař bez
 * odpovědi, dvakrát neplatný skript) jsou ve jmenovateli.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..', '..', '..');
await import(`${pathUrl(join(ROOT, 'scripts', 'ts-paths.mjs'))}`);
const { draftGameSpecWithMeta } = await import(pathUrl(join(ROOT, 'src/play/draft/index.ts')));
const { derivedSeeds, seedFrom } = await import(pathUrl(join(ROOT, 'src/app/api/play/_publish.ts')));
const { SCRIPT_SYSTEM_PROMPT, scriptGameOf, scriptUserMessage, scriptedLevel } = await import(pathUrl(join(ROOT, 'src/play/scripts/generate.ts')));
const { evalLedger } = await import(pathUrl(join(ROOT, 'scripts/measure/eval-ledger.mjs')));

function pathUrl(path) {
  return `file:///${path.replace(/\\/g, '/').replace(/^\/+/, '')}`;
}

const DEV = JSON.parse(readFileSync(join(HERE, 'dev.json'), 'utf8'));
const ANSWERS = join(HERE, 'answers.json');
const record = process.argv.includes('--record');
const ledger = evalLedger(process.env);
if (ledger.mode === 'paid') {
  console.error('the eval ledger is set: the paid astra run is not wired into this script yet – run it from the AI version path');
  process.exit(2);
}

/** `{ "code": "…" }` z textu odpovědi (i v bloku kódu). */
function codeOf(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(text.slice(start, end + 1));
    return typeof parsed.code === 'string' ? parsed.code : null;
  } catch {
    return null;
  }
}

/** Písař zástupce: `claude -p` (předplatné) se zadáním písaře astry, v prázdném adresáři (repo ani plán nevidí). */
function claudeWriter(log) {
  const cwd = mkdtempSync(join(tmpdir(), 'p68-script-writer-'));
  return async (request) => {
    const prompt = `${SCRIPT_SYSTEM_PROMPT}\n\n${scriptUserMessage(request)}`;
    const started = Date.now();
    const out = spawnSync('claude', ['-p', '--output-format', 'text'], { cwd, input: prompt, encoding: 'utf8', timeout: 240_000, shell: true, maxBuffer: 4 * 1024 * 1024 });
    const code = out.status === 0 ? codeOf(out.stdout) : null;
    log.push({ sentence: request.sentence, round: request.repair === null ? 0 : 1, code, writerMs: Date.now() - started, exit: out.status });
    return code === null ? null : { code, costUsd: 0 };
  };
}

/** Přehrání zapsaných odpovědí (věta, kolo). */
function recordedWriter(answers) {
  return async (request) => {
    const found = answers.find((answer) => answer.sentence === request.sentence && answer.round === (request.repair === null ? 0 : 1));
    return found === undefined || found.code === null ? null : { code: found.code, costUsd: 0 };
  };
}

const percentile = (values, p) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)];
};

const log = [];
const answers = record ? null : JSON.parse(readFileSync(ANSWERS, 'utf8')).answers;
const writer = record ? claudeWriter(log) : recordedWriter(answers);
const results = [];
for (const sentence of DEV.sentences) {
  const spec = draftGameSpecWithMeta(sentence, 1).spec;
  const seed = derivedSeeds(seedFrom(sentence.trim()))[0];
  const target = scriptGameOf(spec);
  const started = performance.now();
  const outcome = target === null ? { spec: null, attempts: [], spentUsd: 0, reason: 'unsupported' } : await scriptedLevel(spec, seed, sentence, writer);
  const validationMs = outcome.attempts.reduce((sum, attempt) => sum + attempt.ms, 0);
  results.push({
    sentence,
    quickGame: spec.genre?.id ?? spec.control ?? null,
    seed,
    outcome: outcome.reason,
    attempts: outcome.attempts.length,
    validData: outcome.attempts.filter((attempt) => attempt.issues.every((issue) => /^(bot-wins|idle-loses):/.test(issue))).length,
    botPassed: outcome.spec !== null,
    issues: outcome.attempts.map((attempt) => attempt.issues),
    polls: outcome.attempts.map((attempt) => attempt.polls),
    validationMs,
    totalMs: Math.round(performance.now() - started),
    lanes: outcome.spec?.scriptLevel?.levelData.lanes.length ?? null,
  });
  console.log(`${outcome.reason.padEnd(11)} ${String(outcome.attempts.length)} ${sentence}`);
}

if (record) writeFileSync(ANSWERS, `${JSON.stringify({ about: 'P68I T13: zástupné odpovědi písaře skriptu – claude -p z předplatného se zadáním SCRIPT_SYSTEM_PROMPT, NE astra. Kolo 0 = první pokus, 1 = opravné kolo s výpisem chyb.', writer: 'claude -p (subscription stand-in)', answers: log }, null, 1)}\n`);

const n = results.length;
const attemptsTotal = results.reduce((sum, row) => sum + row.attempts, 0);
const passed = results.filter((row) => row.botPassed).length;
const writerMs = (record ? log : answers).map((entry) => entry.writerMs);
const pilot = {
  about: 'P68I T13: pilot skriptů úrovní, jen offline část. Měřicí kniha nebyla nastavená (fast-only), takže astra nepsala nic a nic se neutratilo; odpovědi jsou zástupné (claude -p z předplatného), ne astra. Selhání jsou ve jmenovateli.',
  ledger,
  writer: 'claude -p (subscription stand-in, not astra)',
  game: DEV.game,
  sentences: n,
  attempts: attemptsTotal,
  firstTryPassed: results.filter((row) => row.botPassed && row.attempts === 1).length,
  validDataAttempts: results.reduce((sum, row) => sum + row.validData, 0),
  passedBot: passed,
  failed: n - passed,
  passRateOfSentences: Number((passed / n).toFixed(3)),
  passRateOfAttempts: Number((passed / Math.max(1, attemptsTotal)).toFixed(3)),
  failures: Object.fromEntries(['unsupported', 'no-answer', 'invalid'].map((reason) => [reason, results.filter((row) => row.outcome === reason).length])),
  spentUsd: 0,
  extensionMs: {
    note: 'Offline: sandbox + ověření + robot na pokus (bez modelu). Čas písaře zástupce je zvlášť a o astře nic neříká.',
    validationP50: percentile(results.map((row) => row.validationMs), 50),
    validationP95: percentile(results.map((row) => row.validationMs), 95),
    standInWriterP50: percentile(writerMs, 50),
    standInWriterP95: percentile(writerMs, 95),
  },
  judge: { run: false, reason: 'Slepý soudce porovnává AI verzi se skriptem a bez něj; bez měřicí knihy AI verze (astra) nevznikla, takže není co soudit.' },
  results,
};
writeFileSync(join(HERE, 'pilot.json'), `${JSON.stringify(pilot, null, 1)}\n`);
console.log(`passed ${String(passed)}/${String(n)} sentences, ${String(attemptsTotal)} attempts`);
