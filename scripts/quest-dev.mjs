/**
 * Quest 2 přes USB: otevře PLAY v prohlížeči brýlí a volitelně změří FPS (P65 T7).
 *
 *   node scripts/quest-dev.mjs            # najde adb a brýle, přesměruje port, otevře hru
 *   node scripts/quest-dev.mjs --fps 60   # totéž a pak 60 s čte FPS z logcatu
 *
 * `adb reverse tcp:3165 tcp:3165` udělá z počítačového serveru v brýlích
 * `localhost:3165`. Na tom záleží: WebXR pustí jen bezpečný původ (HTTPS nebo
 * localhost), adresa počítače v síti by „Enter VR“ nenabídla.
 *
 * Výsledek měření jde do `evals/vr/quest2-fps.json`. Bez jediného vzorku se nic
 * nezapíše – nula v souboru by vypadala jako změřená hra, která nejede.
 */

import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

export const PORT = 3165;
export const GAME_URL = `http://localhost:${String(PORT)}/play?vr=1&vrhud=1`;
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FPS_FILE = join(ROOT, 'evals', 'vr', 'quest2-fps.json');

const DEV_MODE_HINT =
  'Vývojářský režim se zapíná v aplikaci Meta Horizon v telefonu: Zařízení → Nastavení brýlí → Vývojářský režim.';

/**
 * Cesta k `adb`: nejdřív PATH, pak obvyklá místa Android SDK a odkaz, který
 * zakládá winget (ten se do PATH dostane až v novém terminálu).
 *
 * @param {Record<string, string | undefined>} env
 * @param {(path: string) => boolean} exists
 * @returns {{ adb: string } | { error: string }}
 */
export function findAdb(env, exists) {
  const fromPath = (env.PATH ?? env.Path ?? '')
    .split(delimiter)
    .filter(Boolean)
    .map((dir) => dir.replace(/^"|"$/g, ''))
    .flatMap((dir) => [join(dir, 'adb.exe'), join(dir, 'adb')]);
  const local = env.LOCALAPPDATA
    ? [
        join(env.LOCALAPPDATA, 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
        join(env.LOCALAPPDATA, 'Android', 'platform-tools', 'adb.exe'),
        join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'adb.exe'),
      ]
    : [];
  const adb = [...fromPath, ...local].find((candidate) => exists(candidate));
  if (adb) return { adb };
  return {
    error: [
      'Nenašel jsem adb (Android Debug Bridge, nástroj pro spojení s brýlemi přes USB).',
      'Nainstaluj ho příkazem:',
      '',
      '  winget install Google.PlatformTools',
      '',
      'Pak otevři nový terminál a spusť skript znovu.',
    ].join('\n'),
  };
}

/**
 * Výstup `adb devices` → sériové číslo prvních brýlí, které ladění povolily.
 *
 * @param {string} stdout
 * @returns {{ serial: string } | { error: string }}
 */
export function parseDevices(stdout) {
  const devices = stdout
    .split(/\r?\n/)
    .map((line) => /^(\S+)\t+(.+?)\s*$/.exec(line))
    .filter((match) => match !== null)
    .map(([, serial, state]) => ({ serial, state }));
  const ready = devices.find((device) => device.state === 'device');
  if (ready) return { serial: ready.serial };
  if (devices.some((device) => device.state === 'unauthorized')) {
    return {
      error: [
        'Brýle jsou připojené, ale nepovolily ladění přes USB.',
        'Nasaď si je a potvrď dialog „Allow USB debugging“ (zaškrtni „Always allow from this computer“).',
        'Dialog nevidíš? Odpoj kabel a připoj ho znovu.',
        DEV_MODE_HINT,
      ].join('\n'),
    };
  }
  if (devices.length > 0) {
    const { serial, state } = devices[0];
    return { error: `Zařízení ${serial} je ve stavu „${state}“. Odpoj kabel a připoj ho znovu.` };
  }
  return {
    error: [
      'Nevidím žádné brýle.',
      `1. ${DEV_MODE_HINT}`,
      '2. Připoj Quest 2 k počítači kabelem USB-C.',
      '3. V brýlích potvrď „Allow USB debugging“.',
    ].join('\n'),
  };
}

/**
 * `adb shell` slepí argumenty do jednoho řádku pro shell v brýlích. Bez uvozovek
 * by ten shell vzal `&` v adrese jako „pusť na pozadí“ a otevřel hru bez `vrhud=1`.
 *
 * @param {string} serial
 * @returns {string[]}
 */
export function openGameArgs(serial) {
  return ['-s', serial, 'shell', 'am', 'start', '-a', 'android.intent.action.VIEW', '-d', `'${GAME_URL}'`, 'com.oculus.browser'];
}

/**
 * Řádek `VrApi` → snímky za poslední sekundu (číslo před lomítkem v `FPS=72/72`),
 * jinak `null`.
 *
 * @param {string} line
 * @returns {number | null}
 */
export function parseVrApiFps(line) {
  const match = /\bFPS=(\d+)/.exec(line);
  return match ? Number(match[1]) : null;
}

/**
 * Medián a 5. percentil metodou nejbližšího pořadí (hodnota, pod kterou leží
 * nejvýš 5 % vzorků). Bez vzorků `null`, ne nula.
 *
 * @param {readonly number[]} samples
 * @returns {{ median: number, p5: number, samples: number } | null}
 */
export function summarizeFps(samples) {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  const p5 = sorted[Math.max(0, Math.ceil(sorted.length * 0.05) - 1)];
  return { median, p5, samples: sorted.length };
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function adbRun(adb, args) {
  try {
    return execFileSync(adb, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    return fail(`adb ${args.join(' ')} selhalo:\n${String(error.stderr || error.message).trim()}`);
  }
}

function waitForEnter(prompt) {
  if (!process.stdin.isTTY) return Promise.resolve();
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((done) => {
    rl.question(prompt, () => {
      rl.close();
      done();
    });
  });
}

/** @returns {Promise<number[]>} */
function readFps(adb, serial, seconds) {
  // Logcat nejdřív vysype starou historii; bez vymazání by se do měření
  // dostaly řádky z doby před vstupem do VR.
  adbRun(adb, ['-s', serial, 'logcat', '-c']);
  const child = spawn(adb, ['-s', serial, 'logcat', '-s', 'VrApi'], { stdio: ['ignore', 'pipe', 'inherit'] });
  const samples = [];
  createInterface({ input: child.stdout }).on('line', (line) => {
    const fps = parseVrApiFps(line);
    if (fps !== null) samples.push(fps);
  });
  return new Promise((done) => {
    const timer = setTimeout(() => child.kill(), seconds * 1000);
    child.on('close', () => {
      clearTimeout(timer);
      done(samples);
    });
  });
}

async function main() {
  const { values } = parseArgs({ options: { fps: { type: 'string' } } });
  const seconds = values.fps === undefined ? null : Number(values.fps);
  if (seconds !== null && !(seconds > 0)) {
    console.error('usage: node scripts/quest-dev.mjs [--fps <sekundy>]');
    process.exit(2);
  }

  const found = findAdb(process.env, existsSync);
  if ('error' in found) fail(found.error);
  const { adb } = found;

  const device = parseDevices(adbRun(adb, ['devices']));
  if ('error' in device) fail(device.error);
  const { serial } = device;
  console.log(`Brýle: ${serial}`);

  adbRun(adb, ['-s', serial, 'reverse', `tcp:${String(PORT)}`, `tcp:${String(PORT)}`]);
  console.log(`Port ${String(PORT)} přesměrovaný: brýle vidí server počítače jako localhost:${String(PORT)}.`);

  console.log(adbRun(adb, openGameArgs(serial)).trim());
  console.log(`Otevřeno v prohlížeči brýlí: ${GAME_URL}`);
  if (seconds === null) return;

  await waitForEnter('V brýlích stiskni „Enter VR“ a začni hrát. Pak v terminálu stiskni Enter, měření začne. ');
  console.log(`Měřím FPS ${String(seconds)} s…`);
  const summary = summarizeFps(await readFps(adb, serial, seconds));
  if (summary === null) {
    fail('Za celou dobu nepřišel žádný řádek VrApi s FPS. Nic jsem nezapsal. Jsou brýle nasazené a běží hra ve VR?');
  }
  mkdirSync(dirname(FPS_FILE), { recursive: true });
  const record = { measuredAt: new Date().toISOString(), url: GAME_URL, seconds, ...summary };
  writeFileSync(FPS_FILE, `${JSON.stringify(record, null, 2)}\n`);
  console.log(`Medián ${String(summary.median)} FPS, 5. percentil ${String(summary.p5)} FPS ze ${String(summary.samples)} vzorků (cíl: medián ≥ 72, 5. percentil ≥ 65).`);
  console.log(`Zapsáno: ${FPS_FILE}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
