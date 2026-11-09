#!/usr/bin/env node
/**
 * Slepý soudce README (P79 T4): Codex jako porotce hackathonu dostane dvě verze README
 * pod jmény `a.md` a `b.md` v prázdném dočasném adresáři (paměť `codex-judge-reads-filenames`)
 * a nic jiného. Která strana je nová, losuje semínko; klíč je jen ve výsledku.
 *
 * ```
 * node scripts/readme-judge.mjs --seed 7901 --round 1 [--old origin/main] [--out evals/play/p79]
 * ```
 *
 * Starý README se bere z gitu (`<old>:README.md`), nový z pracovního stromu. Výsledek se
 * připíše do `<out>/judge.json` (pole kol) a `<out>/judge.md` se přegeneruje ze všech kol.
 */

import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? fallback : process.argv[at + 1];
}

const SEED = Number(arg('seed', '7901'));
const ROUND = Number(arg('round', '1'));
const OLD_REF = arg('old', 'origin/main');
const OUT = join(ROOT, arg('out', 'evals/play/p79'));

/** Kategorie a mandáty soutěže tak, jak je porota zná (pravidla §3 a §8b). */
const TASK = `You are a judge at an AI hackathon for browser-native AI applications. Do not search the web, do not run any skill, review or debate tool, and do not open any file except a.md and b.md in this directory.

The hackathon brief, which every entry must meet:
1. It runs fully in the browser, with no install and no plugin; a backend may exist but must be live.
2. Natural language becomes a 3D scene AND working logic: not just a model generator, not just a chatbot; a working system must come out.
3. Judges test entries with their own prompts, including prompts outside the entry's chosen focus area.
4. Judging is discretionary, with no published weights; a judge forms an impression in about 10 minutes.
Focus categories: AI-generated 3D scenes; Intelligent NPCs and agents; Procedural worlds; Browser-native creative tools; Multimodal workflows; Real-time AI interactions; Experimental interfaces for the future web.

a.md and b.md are two versions of the README of the same entry. You cannot open the links in them; judge only what the text says and how it supports it. Score EACH file on its own, as if it were the only README you had, on integers from 1 (poor) to 10 (excellent):
- clarity: after reading it, do you know what the entry is, how to try it and what makes it different?
- persuasiveness: does it make you want to score the entry high?
- technicalDepth: does it show real engineering and explain why the design was chosen?
- credibility: are the claims specific and backed by numbers, dates and evidence you could check?
For each file also list:
- wouldScoreLower: up to 6 concrete things in that README that would make you give the entry fewer points;
- claimsWithoutEvidence: every claim in that README stated as fact with no number, date, link or measurement behind it (quote at most 15 words of each); an empty list if there are none.
Then pick the winner: the README that would make you score the entry higher, and give the reason in at most 3 sentences.
Reply only with the JSON the schema asks for.`;

const SIDE = {
  type: 'object',
  additionalProperties: false,
  required: ['clarity', 'persuasiveness', 'technicalDepth', 'credibility', 'wouldScoreLower', 'claimsWithoutEvidence'],
  properties: {
    clarity: { type: 'integer' },
    persuasiveness: { type: 'integer' },
    technicalDepth: { type: 'integer' },
    credibility: { type: 'integer' },
    wouldScoreLower: { type: 'array', items: { type: 'string' } },
    claimsWithoutEvidence: { type: 'array', items: { type: 'string' } },
  },
};
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['a', 'b', 'winner', 'reason'],
  properties: { a: SIDE, b: SIDE, winner: { type: 'string', enum: ['a', 'b'] }, reason: { type: 'string' } },
};

const CODEX = process.platform === 'win32'
  ? { file: process.execPath, prefix: [join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')] }
  : { file: 'codex', prefix: [] };

function ask(files) {
  const cwd = mkdtempSync(join(os.tmpdir(), 'judge-'));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(cwd, name), text);
  writeFileSync(join(cwd, 'task.md'), TASK);
  writeFileSync(join(cwd, 'schema.json'), JSON.stringify(SCHEMA));
  const args = ['exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-c', 'tools.web_search=false',
    '-c', 'model_reasoning_effort=high', '--output-schema', 'schema.json', '-o', 'answer.json',
    'Read the file task.md in the current directory and do exactly what it says.'];
  return new Promise((done) => {
    const started = Date.now();
    const child = spawn(CODEX.file, [...CODEX.prefix, ...args], { cwd, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('exit', (code) => {
      const answerFile = join(cwd, 'answer.json');
      const answer = existsSync(answerFile) ? JSON.parse(readFileSync(answerFile, 'utf8')) : null;
      try { rmSync(cwd, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 }); } catch { /* zůstane v tempu */ }
      done({ code, answer, seconds: Math.round((Date.now() - started) / 1000), stderr: stderr.slice(-400) });
    });
  });
}

const total = (side) => side.clarity + side.persuasiveness + side.technicalDepth + side.credibility;

function render(rounds) {
  const lines = [
    '# P79 T4 – blind judge of the README',
    '',
    `Judge: Codex (\`codex exec\`, reasoning high, read-only, no web) as a hackathon judge, given only the two READMEs as \`a.md\` and \`b.md\` in an empty temporary directory, plus the brief and the seven focus categories (\`scripts/readme-judge.mjs\`). Which side is the new README is drawn from the seed; the judge never sees the key.`,
    '',
  ];
  for (const round of rounds) {
    const { answer } = round;
    const sideOf = { new: round.newSide, old: round.newSide === 'a' ? 'b' : 'a' };
    lines.push(`## Round ${round.round} – ${round.judgedAt.slice(0, 16).replace('T', ' ')}, seed ${round.seed}`, '');
    lines.push(`Old README: \`${round.oldRef}:README.md\`; new README: working tree at \`${round.head}\`. New = \`${round.newSide}.md\`. **Winner: ${answer.winner === round.newSide ? 'new' : 'old'}.** ${answer.reason}`, '');
    lines.push('| | clarity | persuasiveness | technical depth | credibility | total |', '|---|---|---|---|---|---|');
    for (const which of ['new', 'old']) {
      const side = answer[sideOf[which]];
      lines.push(`| ${which} | ${side.clarity} | ${side.persuasiveness} | ${side.technicalDepth} | ${side.credibility} | ${total(side)}/40 |`);
    }
    for (const which of ['new', 'old']) {
      const side = answer[sideOf[which]];
      lines.push('', `**${which} – would score lower:**`, ...side.wouldScoreLower.map((item) => `- ${item}`));
      lines.push('', `**${which} – claims without evidence:**`, ...(side.claimsWithoutEvidence.length ? side.claimsWithoutEvidence.map((item) => `- ${item}`) : ['- none']));
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}

async function main() {
  const oldText = execFileSync('git', ['show', `${OLD_REF}:README.md`], { cwd: ROOT, encoding: 'utf8' });
  const newText = readFileSync(join(ROOT, 'README.md'), 'utf8');
  // Semínko volí stranu: liché = nový je `a`.
  const newSide = SEED % 2 === 1 ? 'a' : 'b';
  const files = newSide === 'a' ? { 'a.md': newText, 'b.md': oldText } : { 'a.md': oldText, 'b.md': newText };
  const run = await ask(files);
  if (!run.answer) {
    console.error(`judge gave no answer (exit ${run.code}, ${run.seconds} s): ${run.stderr}`);
    process.exit(1);
  }
  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim();
  const jsonFile = join(OUT, 'judge.json');
  const rounds = existsSync(jsonFile) ? JSON.parse(readFileSync(jsonFile, 'utf8')).rounds : [];
  const round = { round: ROUND, seed: SEED, newSide, oldRef: OLD_REF, head, judgedAt: new Date().toISOString(), seconds: run.seconds, answer: run.answer };
  const kept = [...rounds.filter((item) => item.round !== ROUND), round].sort((x, y) => x.round - y.round);
  writeFileSync(jsonFile, `${JSON.stringify({ rounds: kept }, null, 2)}\n`);
  writeFileSync(join(OUT, 'judge.md'), render(kept));
  console.log(JSON.stringify({ round: ROUND, winner: run.answer.winner === newSide ? 'new' : 'old', seconds: run.seconds }));
}

await main();
