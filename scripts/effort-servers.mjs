#!/usr/bin/env node
/**
 * P16 T1 – jeden lokální `next start` na variantu: tentýž build, liší se jen
 * model a úsilí. Z toho pak Playwright (`e2e/effort-compare.spec.ts`) fotí
 * svět, který postavil každý z nich.
 *
 *   --probe  jedno krátké volání astry přes `codex exec` na každou úroveň úsilí;
 *            přijaté úrovně a luna/sol přes proxy → `variants.json`
 *   --start  build jen když je starší než HEAD, pak server na variantu; PID do
 *            `pids.json`, výstup do `os.tmpdir()/worldstream-effort/<id>.log`;
 *            běží dál, dokud žijí servery – pouštět na pozadí
 *   --check  počká, až každý server odpoví `ready` na `/api/health`; exit 0 jen
 *            když všechny
 *   --stop   ukončí servery podle PID z `pids.json`
 *
 * Proč `VERCEL_ENV=production`: bez něj lokální `next start` placené volání
 * odmítne (`LEDGER_UNCONFIGURED`), protože kniha stropu v paměti je doložená
 * jen známým prostředím. Proč cena, když jde o předplatné: bez ceny výstupu
 * `upstreamConfigFromEnv()` živou větev vypne.
 */
import { execFileSync, execSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV_ALLOWLIST, codexArgs, killTree } from './codex-shim.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'evals', 'worldstream', 'effort');
const VARIANTS = join(DIR, 'variants.json');
const PIDS = join(DIR, 'pids.json');
const LOGS = join(tmpdir(), 'worldstream-effort');

const PROXY = 'http://localhost:18766/v1/messages';
const ASTRA = 'gpt-6-astra';
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const FIRST_PORT = 3201;
const PROBE_TIMEOUT_MS = 180_000;
const READY_TIMEOUT_MS = 120_000;

/** Luna a sol jdou přes proxy stejně jako dnešní demo; úsilí nechávají na výchozím `low` serveru. */
const PROXY_VARIANTS = [
  { id: 'luna', model: 'gpt-5.6-luna', endpoint: PROXY },
  { id: 'sol', model: 'gpt-5.6-sol', endpoint: PROXY },
];

/** Totéž spuštění codexu jako `codexCommand()` v `src/server/upstream.ts` – na Windows `codex.cmd` bez shellu nejde. */
function codexCommand() {
  const script = process.env.WORLDSMITH_CODEX_JS ?? (process.platform === 'win32'
    ? join(process.env.APPDATA ?? '', 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js')
    : '');
  return script === '' ? { file: 'codex', prefix: [] } : { file: process.execPath, prefix: [script] };
}

/**
 * Jedno volání na úroveň, týmž spuštěním jako most (`scripts/codex-shim.mjs`):
 * prázdný dočasný adresář, prostředí z allowlistu, `--ignore-rules` a vypnuté
 * nástroje, a po stropu zabitý celý strom – timeout `execFile` zabil jen obal
 * (revize 15. 9. 2026). Výsledek je přijato/odmítnuto s důvodem.
 */
function probeEffort(effort) {
  const command = codexCommand();
  const cwd = mkdtempSync(join(tmpdir(), 'effort-probe-'));
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command.file, [...command.prefix, ...codexArgs(ASTRA, effort, cwd)], {
      cwd,
      env: Object.fromEntries(ENV_ALLOWLIST.filter((name) => process.env[name] !== undefined).map((name) => [name, process.env[name]])),
      windowsHide: true,
      detached: process.platform !== 'win32',
    });
    const chunks = [];
    let stderr = '';
    let timedOut = false;
    let done = false;
    const finish = (failure) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        rmSync(cwd, { recursive: true, force: true, maxRetries: 5 });
      } catch {
        /* prázdný adresář v tmp nikomu neublíží */
      }
      const ms = Date.now() - started;
      let events = [];
      try {
        events = Buffer.concat(chunks).toString('utf8').split(/\r?\n/).filter((line) => line.trim().startsWith('{')).map((line) => JSON.parse(line));
      } catch {
        /* vadný proud je nepřijatá úroveň */
      }
      const failed = events.find((event) => event.type === 'turn.failed' || event.type === 'error');
      const completed = events.find((event) => event.type === 'turn.completed');
      if (!timedOut && completed !== undefined && failed === undefined) resolve({ effort, accepted: true, ms, usage: completed.usage ?? null });
      else resolve({
        effort, accepted: false, ms,
        reason: failed !== undefined ? JSON.stringify(failed).slice(0, 300)
          : timedOut ? 'codex exec ran past the probe timeout'
          : `${failure ?? 'no turn.completed'} ${stderr.slice(0, 300)}`.trim(),
      });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      child.stdout.destroy();
      child.stderr.destroy();
      setTimeout(() => finish(null), 2_000);
    }, PROBE_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => chunks.push(chunk));
    child.stderr.on('data', (chunk) => {
      if (stderr.length < 300) stderr += chunk;
    });
    child.stdin.on('error', () => {});
    child.stdin.end('Reply with the single word OK.');
    child.on('error', (error) => finish(error.message.split('\n')[0]));
    child.on('close', (code) => finish(code === 0 ? null : `codex exec exited with code ${code}`));
  });
}

async function probe() {
  const results = await Promise.all(EFFORTS.map(probeEffort));
  const astra = results.filter((result) => result.accepted).map((result) => ({ id: `astra-${result.effort}`, model: ASTRA, endpoint: 'codex-cli', effort: result.effort }));
  const variants = [...PROXY_VARIANTS, ...astra].map((variant, index) => ({ ...variant, port: FIRST_PORT + index }));
  mkdirSync(DIR, { recursive: true });
  writeFileSync(VARIANTS, `${JSON.stringify({
    note: 'P16 T1: one local next start per variant. Astra efforts come from one codex exec call each (probe below); a rejected effort is left out of variants.',
    probedAt: new Date().toISOString(),
    variants,
    probe: results,
  }, null, 2)}\n`);
  for (const result of results) console.log(`${result.accepted ? 'accepted' : 'rejected'}  ${result.effort}  ${result.ms} ms${result.accepted ? '' : `  ${result.reason}`}`);
  console.log(`${variants.length} variants → ${VARIANTS}`);
}

function readVariants() {
  if (!existsSync(VARIANTS)) throw new Error(`${VARIANTS} is missing – run --probe first`);
  return JSON.parse(readFileSync(VARIANTS, 'utf8')).variants;
}

/** Build se opakuje jen když je starší než poslední commit – `next start` jinak servíruje starý kód. */
function ensureBuild() {
  const buildId = join(ROOT, '.next', 'BUILD_ID');
  const head = Number(execFileSync('git', ['log', '-1', '--format=%ct'], { cwd: ROOT, encoding: 'utf8' }).trim()) * 1000;
  if (existsSync(buildId) && statSync(buildId).mtimeMs >= head) return;
  console.log('build older than HEAD – npm run build');
  execSync('npm run build', { cwd: ROOT, stdio: 'inherit' });
}

async function health(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(5_000) });
    const body = await response.json();
    return body.ready === true ? 'ready' : `not ready (${body.reason ?? response.status})`;
  } catch (thrown) {
    return `down (${thrown.cause?.code ?? thrown.message})`;
  }
}

async function start() {
  const variants = readVariants();
  for (const variant of variants)
    if (!(await health(variant.port)).startsWith('down')) throw new Error(`port ${variant.port} (${variant.id}) already answers – run --stop or free the port`);
  ensureBuild();
  mkdirSync(LOGS, { recursive: true });
  const nextBin = join(ROOT, 'node_modules', 'next', 'dist', 'bin', 'next');
  const pids = {};
  for (const variant of variants) {
    const env = {
      ...process.env,
      VERCEL_ENV: 'production',
      WORLDSMITH_BRANCH: 'live',
      WORLDSMITH_MODEL_PROFILE: 'subscription',
      WORLDSMITH_MODEL_ENDPOINT: variant.endpoint,
      WORLDSMITH_MODEL_KEY: 'local-effort',
      WORLDSMITH_MODEL: variant.model,
      WORLDSMITH_USD_PER_MTOK_IN: '5',
      WORLDSMITH_USD_PER_MTOK_OUT: '25',
      WORLDSMITH_CALL_CAP: '60',
      // Předplatné neplatí dolary, ale strop útraty běží dál s výchozími 5 USD
      // z vymyšlené ceny: astra@xhigh ho 14. 9. 2026 vyčerpala na sedmé větě a
      // osmá se nezavolala vůbec. Mez tady drží počet volání o řádek výš.
      WORLDSMITH_SPEND_CAP_USD: '1000',
      WORLDSMITH_UPSTREAM_TIMEOUT_MS: '600000',
    };
    if (variant.effort !== undefined) env.WORLDSMITH_MODEL_EFFORT = variant.effort;
    const log = openSync(join(LOGS, `${variant.id}.log`), 'a');
    // Servery zůstávají dětmi tohohle procesu a on čeká, dokud žijí. Odpojené
    // (`detached` + `unref`) je prostředí agenta 14. 9. 2026 do pár minut
    // uklidilo všech sedm naráz, s čistým logem; `--start` proto patří do úlohy
    // na pozadí, která drží rodiče.
    // `-H 127.0.0.1`: bez něj `next start` poslouchá na 0.0.0.0 a s živou větví
    // `codex-cli` by větu na cizí předplatné poslal kdokoli z LAN.
    const child = spawn(process.execPath, [nextBin, 'start', '-p', String(variant.port), '-H', '127.0.0.1'], { cwd: ROOT, env, windowsHide: true, stdio: ['ignore', log, log] });
    child.on('exit', (code) => console.log(`exited   ${variant.id}  code ${code}`));
    pids[variant.id] = child.pid;
    console.log(`started  ${variant.id}  :${variant.port}  pid ${child.pid}`);
  }
  writeFileSync(PIDS, `${JSON.stringify(pids, null, 2)}\n`);
  console.log(`logs in ${LOGS}`);
}

async function check() {
  const variants = readVariants();
  const deadline = Date.now() + READY_TIMEOUT_MS;
  const verdicts = new Map();
  for (;;) {
    for (const variant of variants) verdicts.set(variant.id, await health(variant.port));
    if ([...verdicts.values()].every((verdict) => verdict === 'ready') || Date.now() > deadline) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  for (const variant of variants) console.log(`${verdicts.get(variant.id)}  ${variant.id}  :${variant.port}  ${variant.model}${variant.effort ? `@${variant.effort}` : ''}`);
  return [...verdicts.values()].every((verdict) => verdict === 'ready');
}

function stop() {
  if (!existsSync(PIDS)) return console.log('no pids.json – nothing to stop');
  for (const [id, pid] of Object.entries(JSON.parse(readFileSync(PIDS, 'utf8')))) {
    try {
      if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(pid, 'SIGTERM');
      console.log(`stopped  ${id}  pid ${pid}`);
    } catch {
      console.log(`gone     ${id}  pid ${pid}`);
    }
  }
  rmSync(PIDS);
}

const mode = process.argv[2];
if (mode === '--probe') await probe();
else if (mode === '--start') { await start(); process.exitCode = (await check()) ? 0 : 1; }
else if (mode === '--check') process.exitCode = (await check()) ? 0 : 1;
else if (mode === '--stop') stop();
else { console.error('usage: node scripts/effort-servers.mjs --probe | --start | --check | --stop'); process.exitCode = 2; }
