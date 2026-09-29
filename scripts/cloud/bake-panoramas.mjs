#!/usr/bin/env node
/**
 * Předpečená panoramata pro demo bez domácího PC (P30A T4).
 *
 *   node scripts/cloud/bake-panoramas.mjs [--direct]
 *
 * Pro každé prostředí z `src/play/env/baked.json`, které ještě nemá
 * `public/play/env/<id>.webp`, zkusí po řadě:
 *
 * 1. službu `ops/env/server.py` (`ENV_SERVICE_URL`, výchozí 127.0.0.1:8793) s klíčem
 *    ze souboru `$ENV_KEY_FILE` – `POST /panorama`, čeká na hotovou úlohu a stáhne oba soubory;
 * 2. panorama, které služba už dřív uložila do své cache (`ENV_CACHE_DIR`,
 *    výchozí `D:/caches/worldsmith-env/<slug>.webp`);
 * 3. s `--direct` zbytek nakreslí `ops/env/batch.py bake` (týž FLUX.2 klein 4B
 *    a táž úprava švu jako služba) pod sdíleným GPU zámkem.
 *
 * Co nevznikne, zapíše do `evals/play/p30/panorama-missing.txt`; horizont
 * hotových doplní do `baked.json`. Testovací sada se tu nečte. Nové soubory
 * v `public/` pak chtějí `node scripts/assets/register-disclosure.mjs`
 * a `npm run disclosure` v témže commitu.
 */

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const MANIFEST = join(ROOT, 'src/play/env/baked.json');
const PUBLIC = join(ROOT, 'public/play/env');
const MISSING = join(ROOT, 'evals/play/p30/panorama-missing.txt');
const SERVICE = (process.env.ENV_SERVICE_URL ?? 'http://127.0.0.1:8793').replace(/\/+$/, '');
const CACHE = process.env.ENV_CACHE_DIR ?? 'D:/caches/worldsmith-env';
const GPU_LOCK = 'D:/claude/_shared/gpu-lock.mjs';
const STAGE = join(tmpdir(), 'worldsmith-bake');
/** Jedna úloha služby trvá naměřeně 23 s kreslení + až 156 s s načtením vah (`ops/env/README.md`). */
const JOB_WAIT_MS = 10 * 60_000;

/** Totéž jméno, pod kterým služba ukládá do cache (`slugify` v `ops/env/panorama.py`). */
const slug = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'env';

const baked = (id) => existsSync(join(PUBLIC, `${id}.webp`)) && existsSync(join(PUBLIC, `${id}-low.webp`));

function serviceKey() {
  const file = process.env.ENV_KEY_FILE;
  if (!file || !existsSync(file)) return null;
  const key = readFileSync(file, 'utf8').trim();
  return key === '' ? null : key;
}

async function fromService(key, entry) {
  const headers = { 'x-env-key': key, 'content-type': 'application/json' };
  const ask = (path, init = {}) => fetch(`${SERVICE}${path}`, { ...init, headers, signal: AbortSignal.timeout(15_000) });
  const posted = await ask('/panorama', { method: 'POST', body: JSON.stringify({ setting: entry.prompt }) });
  if (!posted.ok) return null;
  const { jobId } = await posted.json();
  const until = Date.now() + JOB_WAIT_MS;
  while (Date.now() < until) {
    const view = await (await ask(`/jobs/${jobId}`)).json();
    if (view.status === 'failed') return null;
    if (view.status === 'done') {
      for (const [name, target] of [
        [view.file, `${entry.id}.webp`],
        [view.low, `${entry.id}-low.webp`],
      ]) {
        const file = await ask(`/files/${name}`);
        if (!file.ok) return null;
        writeFileSync(join(PUBLIC, target), Buffer.from(await file.arrayBuffer()));
      }
      return view.horizon ?? null;
    }
    await new Promise((resolve) => setTimeout(resolve, 5_000));
  }
  return null;
}

/** Soubory a horizont z adresáře ve tvaru cache služby (`<jméno>.webp`, `-low.webp`, `.json`). */
function fromDir(dir, name, id) {
  const meta = join(dir, `${name}.json`);
  if (![`${name}.webp`, `${name}-low.webp`].every((file) => existsSync(join(dir, file))) || !existsSync(meta)) return null;
  copyFileSync(join(dir, `${name}.webp`), join(PUBLIC, `${id}.webp`));
  copyFileSync(join(dir, `${name}-low.webp`), join(PUBLIC, `${id}-low.webp`));
  return JSON.parse(readFileSync(meta, 'utf8')).horizon ?? null;
}

function direct(entries) {
  mkdirSync(STAGE, { recursive: true });
  const jobs = join(STAGE, 'jobs.json');
  writeFileSync(jobs, JSON.stringify(entries.map(({ id, prompt }) => ({ id, prompt }))));
  const run = spawnSync('node', [GPU_LOCK, '--', 'uv', 'run', '--project', 'ops/env', 'python', 'ops/env/batch.py', 'bake', jobs, STAGE], { cwd: ROOT, stdio: 'inherit' });
  if (run.status !== 0) console.warn(`batch.py bake ended with ${String(run.status)}; keeping what it drew`);
}

const manifest = JSON.parse(readFileSync(MANIFEST, 'utf8'));
mkdirSync(PUBLIC, { recursive: true });
const key = serviceKey();
let todo = manifest.entries.filter((entry) => !baked(entry.id) || entry.horizon === undefined);
const horizons = new Map();

for (const entry of todo) {
  const horizon = (key === null ? null : await fromService(key, entry).catch(() => null)) ?? fromDir(CACHE, slug(entry.prompt), entry.id);
  if (horizon !== null) horizons.set(entry.id, horizon);
}
todo = todo.filter((entry) => !horizons.has(entry.id));
if (process.argv.includes('--direct') && todo.length > 0) {
  direct(todo);
  for (const entry of todo) {
    const horizon = fromDir(STAGE, entry.id, entry.id);
    if (horizon !== null) horizons.set(entry.id, horizon);
  }
}

manifest.entries = manifest.entries.map((entry) => (horizons.has(entry.id) ? { ...entry, horizon: horizons.get(entry.id) } : entry));
writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 1)}\n`);
const missing = manifest.entries.filter((entry) => entry.horizon === undefined || !baked(entry.id));
mkdirSync(join(ROOT, 'evals/play/p30'), { recursive: true });
writeFileSync(
  MISSING,
  `# P30A T4: settings from src/play/env/baked.json without a baked panorama (scripts/cloud/bake-panoramas.mjs).\n` +
    (missing.length === 0 ? '# none\n' : missing.map((entry) => `${entry.id}\t${entry.prompt}\n`).join('')),
);
console.log(`baked ${String(manifest.entries.length - missing.length)}/${String(manifest.entries.length)}; service ${key === null ? 'without a key' : SERVICE}; missing -> ${MISSING}`);
