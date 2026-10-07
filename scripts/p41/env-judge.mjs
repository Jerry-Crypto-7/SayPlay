#!/usr/bin/env node
/** P41 T30: subscription-only blind image judging; no API fallback or credential reads. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { ENV_ALLOWLIST, codexArgs, killTree } from '../codex-shim.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const CAPTURE = join(ROOT, 'evals/play/p41/env');
const MODEL = 'gpt-6-astra';
const QUESTION = 'Look only at the attached game image. Identify its physical environment in one short noun phrase. Do not infer from the game genre, objects alone, filenames or external information. If the environment is visually ambiguous, set ambiguous true. Describe the visible cues in visualEvidence. Return only the required JSON.';
const SCHEMA = { type: 'object', additionalProperties: false, required: ['environment', 'ambiguous', 'visualEvidence'], properties: { environment: { type: 'string' }, ambiguous: { type: 'boolean' }, visualEvidence: { type: 'string' } } };
const IDS = ['01', '02', '03', '04', '05', '06'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
const normalize = text => text.toLowerCase().replace(/[^a-z\s]/g, ' ').replace(/\s+/g, ' ').trim();

async function ask(source, output) {
  const tempRoot = realpathSync(tmpdir());
  const cwd = mkdtempSync(join(tempRoot, 'judge-'));
  const answerPath = join(cwd, 'answer.json');
  const started = Date.now();
  // Re-encode: no source filename or textual PNG metadata reaches the judge.
  const sheet = await sharp(source).png().toBuffer();
  writeFileSync(join(cwd, 'sheet.png'), sheet);
  json(join(cwd, 'schema.json'), SCHEMA);
  if (readdirSync(cwd).sort().join(',') !== 'schema.json,sheet.png') throw new Error('Blind directory is not isolated');
  const command = process.platform === 'win32'
    ? { file: process.execPath, prefix: [join(process.env.APPDATA ?? '', 'npm/node_modules/@openai/codex/bin/codex.js')] }
    : { file: 'codex', prefix: [] };
  // Reuse the tested subscription-only, no-tools, no-user-rules launch contract.
  // No service-tier/fast option: standard speed. The attachment is model input,
  // so disabling view_image tools does not prevent image understanding.
  const args = codexArgs(MODEL, 'medium', cwd);
  args.splice(args.length - 1, 0, '--image', 'sheet.png', '--output-schema', 'schema.json', '-o', 'answer.json');
  let result;
  try {
    result = await new Promise(resolveResult => {
      const child = spawn(command.file, [...command.prefix, ...args], {
        cwd, windowsHide: true, detached: process.platform !== 'win32',
        env: Object.fromEntries(ENV_ALLOWLIST.filter(name => process.env[name] !== undefined).map(name => [name, process.env[name]])),
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      let stdout = '', stderr = '', timedOut = false, finished = false;
      const done = (code, error) => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolveResult({ code, error, timedOut, stdout, stderr, ms: Date.now() - started });
      };
      const timer = setTimeout(() => { timedOut = true; killTree(child, () => done(null, 'timeout')); }, 240_000);
      child.stdout.on('data', chunk => { stdout += chunk; if (stdout.length > 2_000_000) killTree(child, () => done(null, 'output_limit')); });
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-8000); });
      child.on('error', error => done(null, String(error)));
      child.on('close', code => done(code, null));
      child.stdin.on('error', () => undefined);
      child.stdin.end(QUESTION);
    });
    writeFileSync(join(output, 'events.jsonl'), result.stdout);
    writeFileSync(join(output, 'stderr.txt'), result.stderr);
    let answer = null;
    if (existsSync(answerPath)) {
      const raw = readFileSync(answerPath, 'utf8');
      writeFileSync(join(output, 'answer.json'), raw);
      try { answer = JSON.parse(raw); } catch { /* malformed output is blocked, not a fabricated judgement */ }
    }
    const valid = answer && typeof answer.environment === 'string' && typeof answer.ambiguous === 'boolean' && typeof answer.visualEvidence === 'string';
    const events = result.stdout.split(/\r?\n/).filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
    const toolUsed = events.some(event => event.item && (!['agent_message', 'reasoning'].includes(event.item.type)));
    const record = { sourceSha256: hash(source), sheetSha256: hash(sheet), code: result.code, error: result.error, timedOut: result.timedOut, toolUsed, ms: result.ms,
      status: result.code === 0 && !result.timedOut && !toolUsed && valid ? 'answered' : 'blocked', answer: valid ? answer : null };
    json(join(output, 'call.json'), record);
    return record;
  } finally {
    // Only the exact mkdtemp child may be removed, never an unchecked path.
    const inside = relative(tempRoot, realpathSync(cwd));
    if (inside.startsWith('judge-') && !inside.includes(sep) && !inside.includes('..')) {
      try { rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* preserve a locked temp folder */ }
    }
  }
}

let activeReport = null;
let activeBase = null;
async function main() {
  const args = process.argv.slice(2);
  if (args.length && !(args.length === 2 && args[0] === '--run' && /^[a-zA-Z0-9_-]+$/.test(args[1]))) throw new Error('Usage: node scripts/p41/env-judge.mjs [--run unique-id]');
  const run = args[1] ?? new Date().toISOString().replace(/[:.]/g, '-');
  const output = join(CAPTURE, 'judgements', run);
  if (existsSync(output)) throw new Error('Do not overwrite or cherry-pick an existing judge run');
  mkdirSync(output, { recursive: true });
  const reportFile = join(output, 'report.json');
  const base = { schema: 'p41.env-judge.v1', run, startedAt: new Date().toISOString(), judge: { model: MODEL, effort: 'medium', speed: 'standard', transport: 'codex-cli subscription', question: QUESTION }, requiredCorrect: 5, total: 6 };
  activeReport = reportFile; activeBase = base;
  json(reportFile, { ...base, status: 'running', score: null });
  if (!existsSync(join(CAPTURE, 'manifest.json'))) throw new Error('No completed capture manifest');
  const answers = [];
  for (const id of IDS) {
    const file = join(CAPTURE, `${id}.png`);
    if (!existsSync(file)) {
      json(reportFile, { ...base, status: 'blocked', blocker: 'missing_capture', capture: id, answers, score: null });
      process.exitCode = 2; return;
    }
    const callDir = join(output, id); mkdirSync(callDir);
    const answer = await ask(readFileSync(file), callDir);
    answers.push({ id, ...answer });
    // No ground truth read and no denominator games for an incomplete oracle.
    if (answer.status !== 'answered') {
      json(reportFile, { ...base, status: 'blocked', blocker: 'live_codex_unavailable_or_invalid', answers, score: null });
      process.exitCode = 2; return;
    }
  }
  // First access to sentences, mapping and accepted labels: six answers are fixed.
  const manifest = JSON.parse(readFileSync(join(CAPTURE, 'manifest.json'), 'utf8'));
  if (manifest.frames?.length !== 6) throw new Error('Need exactly six ground-truth frames');
  const results = answers.map(item => {
    const truth = manifest.frames.find(frame => frame.id === item.id);
    if (!truth || truth.sha256 !== item.sourceSha256) throw new Error(`Capture changed after judging: ${item.id}`);
    const correct = !item.answer.ambiguous && truth.aliases.map(normalize).includes(normalize(item.answer.environment));
    return { ...item, groundTruth: truth, correct };
  });
  const correct = results.filter(item => item.correct).length;
  json(reportFile, { ...base, status: correct >= 5 ? 'passed' : 'failed', judgedAt: new Date().toISOString(), score: { correct, total: 6 }, results });
  console.log(`${correct}/6 environments recognized; ${reportFile}`);
  process.exitCode = correct >= 5 ? 0 : 1;
}
await main().catch(error => {
  if (activeReport) json(activeReport, { ...activeBase, status: 'blocked', blocker: String(error), score: null });
  console.error(String(error)); process.exitCode = 2;
});
