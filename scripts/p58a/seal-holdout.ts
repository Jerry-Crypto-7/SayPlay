/**
 * Zapečetěná sada viditelnosti P58A (T1). `write` pošle `evals/play/p58a/holdout-brief.md` Codexu v prázdném
 * `mkdtemp` (read-only, bez webu – autor nevidí katalog, kód ani jiné sady) a uloží jeho 120 kandidátů mimo repo.
 * `select` z kandidátů v pořadí autora vezme 40 vět, jejichž slovo soudce nemá v katalogu přesný model, a 40 vět,
 * kde ho mají všechna, vyřadí věty známých sad a duplicitní, zapíše `holdout.json` a na výstup dá jen počty
 * a otisk – sadu v relaci nikdo nečte.
 *
 *   node --experimental-strip-types --import ./scripts/ts-paths.mjs scripts/p58a/seal-holdout.ts write --raw D:/tmp/p58a/holdout-raw-1.json
 *   node --experimental-strip-types --import ./scripts/ts-paths.mjs scripts/p58a/seal-holdout.ts select --raw <soubor>[,<soubor>…]
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { normalizeSentence } from '../play-fidelity.mjs';
import { KNOWN_SETS, outsideCatalog, sha256Lf } from '../../evals/play/p58a/seal';

const ROOT = resolve(import.meta.dirname, '..', '..');
const PLAY = join(ROOT, 'evals', 'play');
const BRIEF = join(PLAY, 'p58a', 'holdout-brief.md');
const OUT = join(PLAY, 'p58a', 'holdout.json');
const PER_GROUP = 40;

interface Candidate { readonly text: string; readonly hero: string | null; readonly foe: string | null; readonly item: string | null; readonly group: string }

const nullable = { type: ['string', 'null'] };
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['sentences'],
  properties: {
    sentences: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['text', 'hero', 'foe', 'item', 'group'],
        properties: { text: { type: 'string' }, hero: nullable, foe: nullable, item: nullable, group: { type: 'string', enum: ['common', 'unusual'] } },
      },
    },
  },
};

function arg(name: string): string {
  const index = process.argv.indexOf(`--${name}`);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined) throw new Error(`--${name} is required`);
  return value;
}

/** Jedno volání Codexu: brief a schéma v prázdném adresáři, odpověď souborem (vzor `scripts/p37d/judge-sheet.mjs`). */
async function write(raw: string): Promise<void> {
  const blind = mkdtempSync(join(os.tmpdir(), 'author-'));
  copyFileSync(BRIEF, join(blind, 'brief.md'));
  writeFileSync(join(blind, 'schema.json'), JSON.stringify(SCHEMA));
  const codex = join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
  const args = [codex, 'exec', '--skip-git-repo-check', '--ephemeral', '-s', 'read-only', '-c', 'tools.web_search=false', '-c', 'model_reasoning_effort="high"',
    '--output-schema', 'schema.json', '-o', 'answer.json', 'Read the file brief.md in the current directory and do exactly what it says.'];
  const started = Date.now();
  const code = await new Promise<number | null>((done) => {
    const child = spawn(process.execPath, args, { cwd: blind, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk: Buffer) => { stderr = `${stderr}${String(chunk)}`.slice(-2000); });
    child.on('exit', (exit) => {
      if (exit !== 0) console.error(stderr.slice(-600));
      done(exit);
    });
  });
  const answer = join(blind, 'answer.json');
  if (!existsSync(answer)) throw new Error(`codex exit ${code}: no answer`);
  mkdirSync(dirname(raw), { recursive: true });
  copyFileSync(answer, raw);
  rmSync(blind, { recursive: true, force: true, maxRetries: 3, retryDelay: 300 });
  const count = (JSON.parse(readFileSync(raw, 'utf8')) as { sentences: unknown[] }).sentences.length;
  console.log(`codex exit ${code}, ${count} candidates in ${Math.round((Date.now() - started) / 1000)} s -> ${raw}`);
}

const textsOf = (path: string): string[] => {
  const json = JSON.parse(readFileSync(join(PLAY, path), 'utf8')) as { sentences: { text: string }[] } | { text: string }[];
  return (Array.isArray(json) ? json : json.sentences).map((s) => s.text);
};

const label = (value: unknown): string | null => (typeof value === 'string' && value.trim() !== '' ? value.trim().toLowerCase() : null);

function select(raws: readonly string[]): void {
  const known = new Set(KNOWN_SETS.flatMap(textsOf).map(normalizeSentence));
  const seen = new Set<string>();
  const dropped = { shape: 0, known: 0, duplicate: 0 };
  const pool: { readonly text: string; readonly hero: string; readonly foe: string | null; readonly item: string | null; readonly outside: boolean }[] = [];
  for (const raw of raws) {
    for (const candidate of (JSON.parse(readFileSync(raw, 'utf8')) as { sentences: Candidate[] }).sentences) {
      const hero = label(candidate.hero);
      const foe = label(candidate.foe);
      const item = label(candidate.item);
      const text = typeof candidate.text === 'string' ? candidate.text.trim() : '';
      if (hero === null || (foe ?? item) === null || text === '') { dropped.shape += 1; continue; }
      const key = normalizeSentence(text);
      if (known.has(key)) { dropped.known += 1; continue; }
      if (seen.has(key)) { dropped.duplicate += 1; continue; }
      seen.add(key);
      pool.push({ text, hero, foe, item, outside: outsideCatalog({ hero, foe, item }) });
    }
  }
  const outside = pool.filter((s) => s.outside);
  const inside = pool.filter((s) => !s.outside);
  console.log(`pool ${pool.length} (outside ${outside.length}, inside ${inside.length}); dropped shape ${dropped.shape}, known ${dropped.known}, duplicate ${dropped.duplicate}`);
  if (outside.length < PER_GROUP || inside.length < PER_GROUP) throw new Error(`need ${PER_GROUP} of each – write another round and pass both raw files`);
  // Pořadí autora, obě skupiny promíchané podle něj; id až po výběru.
  const chosen = new Set([...outside.slice(0, PER_GROUP), ...inside.slice(0, PER_GROUP)]);
  const sentences = pool.filter((s) => chosen.has(s)).map((s, index) => ({ id: `v${String(index + 1).padStart(2, '0')}`, ...s }));
  const about = 'P58A T1 sealed visibility holdout: 80 sentences by Codex from holdout-brief.md in an empty directory (no code, catalog or sets). 40 with a judged noun the catalog had no exact model for on the sealing day (outside), 40 without. Opened once in T9.';
  const body = `{\n "about": ${JSON.stringify(about)},\n "sentences": [\n${sentences.map((s) => `  ${JSON.stringify(s)}`).join(',\n')}\n ]\n}\n`;
  writeFileSync(OUT, body);
  console.log(`holdout.json ${sentences.length} sentences, outside ${sentences.filter((s) => s.outside).length}, sha256 ${sha256Lf(body)}`);
}

const command = process.argv[2];
if (command === 'write') await write(arg('raw'));
else if (command === 'select') select(arg('raw').split(','));
else throw new Error('usage: seal-holdout.ts write|select …');
