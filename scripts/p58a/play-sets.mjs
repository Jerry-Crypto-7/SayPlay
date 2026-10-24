/**
 * Focení sad pro soud viditelnosti P58A (T2 rozměry, T8 dev, T9 brána): spustí přehrávač čtení, `next start`
 * nad hotovým buildem a `evals/play/p56a/visible.mjs play` pro každou sadu. `next start` po ~55 hrách přestane
 * odpovídat na `POST /api/play/games` (P58A T1, README) – `play` pak skončí chybou, ovladač server podle PID zabije,
 * spustí znovu a `play` pokračuje od první nevyfocené věty. Server i přehrávač jsou děti tohoto procesu.
 *
 *   node scripts/p58a/play-sets.mjs --port 3171 --replay <čtení.json>[,…] --run <adresář>=<sada.json> [--run …] [--spec]
 *
 * Bez `--replay` jede čtečka z prostředí (`PLAY_READER_*`), jak ji nastaví volající.
 */

import { execFileSync, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TS = ['--experimental-strip-types', '--no-warnings', '--import', './scripts/ts-paths.mjs'];
const REPLAY_PORT = 8793;
const ATTEMPTS = 6;

const list = process.argv.slice(2);
const flag = (name) => {
  const at = list.indexOf(`--${name}`);
  return at === -1 ? undefined : list[at + 1];
};
const port = flag('port') ?? '3171';
const runs = list.flatMap((value, index) => (list[index - 1] === '--run' ? [value.split('=')] : []));
const replay = flag('replay');

const kill = (child) => {
  if (child.exitCode !== null) return;
  try {
    execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch { /* už neběží */ }
};

const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function up(url, seconds) {
  for (let i = 0; i < seconds; i += 1) {
    try {
      if ((await fetch(url)).status < 500) return true;
    } catch { /* ještě nestartuje */ }
    await wait(1000);
  }
  return false;
}

const env = replay === undefined ? process.env : { ...process.env, PLAY_READER: 'on', PLAY_READER_ENDPOINT: `llamacpp:http://127.0.0.1:${REPLAY_PORT}`, PLAY_READER_BUDGET_MS: '60000' };

function startServer() {
  const child = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'start', '-p', port, '-H', '127.0.0.1'], { cwd: ROOT, env, stdio: 'ignore' });
  console.log(`next start pid ${child.pid} on :${port}`);
  return child;
}

const children = [];
process.on('exit', () => children.forEach(kill));

if (replay !== undefined) {
  const replayer = spawn(process.execPath, [...TS, 'scripts/p58a/reader-replay.mjs', '--port', String(REPLAY_PORT), ...replay.split(',')], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
  children.push(replayer);
  await wait(3000);
}

let server = startServer();
children.push(server);
if (!(await up(`http://127.0.0.1:${port}/`, 90))) throw new Error('next start did not come up in 90 s');

for (const [dir, set] of runs) {
  for (let attempt = 1; ; attempt += 1) {
    const play = spawn(process.execPath, [...TS, 'evals/play/p56a/visible.mjs', 'play', '--base', `http://127.0.0.1:${port}`, '--set', set, '--out', dir, '--gpu', ...(list.includes('--spec') ? ['--spec'] : [])], { cwd: ROOT, stdio: ['ignore', 'inherit', 'inherit'] });
    const code = await new Promise((done) => play.on('exit', done));
    if (code === 0) break;
    if (attempt === ATTEMPTS) throw new Error(`${set}: play failed ${ATTEMPTS} times`);
    console.log(`${set}: play exit ${code} – restarting the server (attempt ${attempt + 1}/${ATTEMPTS})`);
    kill(server);
    server = startServer();
    children.push(server);
    if (!(await up(`http://127.0.0.1:${port}/`, 90))) throw new Error('next start did not come up in 90 s');
  }
  console.log(`${set}: done -> ${dir}`);
}
children.forEach(kill);
console.log('PLAY-SETS DONE');
